/**
 * L1 摄入：把**已经跑完的工作区**里的事实读进记忆库。**零 token。**
 *
 * ## 为什么先做「摄入历史」而不是先做「运行中记录」
 *
 * 两件事都需要，但顺序有讲究：
 *
 * 1. **历史是现成的验证集。** `workspace/llm-1` … `llm-12` 里有 111 份锚点结论、
 *    52 份带 findings 的记录，全部是真实模型 + 真实编译/测试跑出来的。
 *    拿它们验证分类器，成本是 0，结论是确定的 —— 比再跑一轮真实 LLM 便宜 6 个数量级
 *    （这条方法论见 docs/HANDOFF.md §9.4）。
 * 2. **摄入器必须是幂等的**，因为它同时是「运行中记录」的底层能力：
 *    同一个工作区无论被摄入几次，库里的行数都一样。
 *
 * ## ⚠️ 历史是被破坏过的：中间轮次的 findings 已经没了
 *
 * 实测（本文件写完前的勘察）：`llm-1`..`llm-12` 每个工作区的 `anchors/` 目录里
 * **只有 1 个轮次**，而当时跑过 **3–9 个 Gate**。
 * 原因是 `docs/07 §L14` 记的那个覆盖 bug：锚点文件名是 `${runId}-001.json`，
 * 每个 Gate 都从 `-001` 重新编号，于是**后写的覆盖先写的**，只剩最后一个 Gate 的结论。
 *
 * 所以：
 * - **Gate 的裁决历史（谁、哪个阶段、ADVANCE 还是 RETRY_ROLE）是完整的** ——
 *   它在 `decisions.jsonl` 里，不在 `anchors/` 里。
 * - **失败原因是**只留下最后一轮。中间轮次「因为什么被打回」在磁盘上已无从得知。
 *
 * 这直接决定了一件事：**「这条记忆有没有用」无法靠回填历史来回答**
 * （回答它需要知道「注入之后同类失败是否再现」，而那需要每一轮的原因）。
 * 所以有效性追踪必须**在运行中记录**，历史只能用来验证分类器与检索。
 * 这个结论是量出来的，不是设计出来的偏好。
 *
 * ## 链接不上就不链接
 *
 * `findings.gate_id` 允许为 NULL。当「锚点轮次数 ≠ Gate 数」时（老 run 必然如此），
 * 本模块**不猜**哪一轮对应哪个 Gate，而是留空并把它计进 `unlinkedFindings`。
 * 编一个错链接会给审计提供假线索 —— 那比缺失更糟。
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  readJsonOrNull,
  readTextOrNull,
  sha256,
  type AnchorFinding,
  type AnchorId,
  type AnchorLink,
} from '../../core/src/index.ts';
import { collectEnvPartsFromDisk, fingerprintFromParts } from './env.ts';
import { classifyFinding } from './rootcause.ts';
import type { MemoryDb } from './db.ts';

/** 摄入统计。全部是**实测**数字，报告里原样输出。 */
export type IngestStats = {
  workspace: string;
  workspaceKey: string;
  envHash: string;
  runs: number;
  gates: number;
  anchorRounds: number;
  findings: number;
  /** 能确定属于哪个 Gate 的发现数。 */
  linkedFindings: number;
  /** 链接不上（老 run 的覆盖 bug）的发现数 —— 留空而不是编。 */
  unlinkedFindings: number;
  repairs: number;
  /** 按根因类统计的发现数（含不合格的类，便于看清全貌）。 */
  byClass: Record<string, number>;
  /** 其中**可进记忆**的发现数。 */
  eligibleFindings: number;
  /** 依据是文本模式（比结构化字段脆弱）的发现数。 */
  textBasedFindings: number;
  warnings: string[];
};

type DecisionEntry = { seq: number; at: string; kind: string; payload: unknown };
type RunRecord = {
  runId: string;
  seq: number;
  at: string;
  role: string;
  purpose: string;
  attempt: number;
  promptHash?: string;
  response?: { text?: string; usage?: unknown };
};

/**
 * 摄入一个工作区。
 *
 * 幂等：用 `INSERT OR REPLACE` + 确定性主键，重复摄入不会产生重复行。
 */
export async function ingestWorkspace(
  mem: MemoryDb,
  opts: { workspace: string; maxStrategyChars?: number; now?: string },
): Promise<IngestStats> {
  const workspace = resolve(opts.workspace);
  const maxStrategy = opts.maxStrategyChars ?? 4000;
  const now = opts.now ?? new Date().toISOString();
  const warnings: string[] = [];

  const envParts = await collectEnvPartsFromDisk(workspace);
  const { envHash } = fingerprintFromParts(envParts);

  const stats: IngestStats = {
    workspace,
    workspaceKey: mem.workspaceKey,
    envHash,
    runs: 0,
    gates: 0,
    anchorRounds: 0,
    findings: 0,
    linkedFindings: 0,
    unlinkedFindings: 0,
    repairs: 0,
    byClass: {},
    eligibleFindings: 0,
    textBasedFindings: 0,
    warnings,
  };

  // ── 工作区自身 ──────────────────────────────────────────────────
  mem.db
    .prepare(
      `INSERT INTO workspaces (workspace_key, path, env_hash, env_parts, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_key) DO UPDATE SET
         env_hash = excluded.env_hash,
         env_parts = excluded.env_parts,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(mem.workspaceKey, workspace, envHash, JSON.stringify(envParts), now, now);

  // ── 1. 读回放记录，拿到真正的 run id 与修复策略 ──────────────────
  const runsDir = join(workspace, 'runs');
  const runFiles = (await safeReaddir(runsDir)).filter((f) => f.endsWith('.jsonl'));
  const runRecords = new Map<string, RunRecord[]>();
  for (const f of runFiles) {
    const text = await readTextOrNull(join(runsDir, f));
    if (!text) continue;
    const recs: RunRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        recs.push(JSON.parse(line) as RunRecord);
      } catch {
        // 半行（run 被中断时会留下不完整的最后一行）—— 跳过，不要让整个摄入失败。
      }
    }
    if (recs.length === 0) continue;
    const id = recs[0]!.runId;
    runRecords.set(id, recs);
  }
  if (runFiles.length === 0) {
    warnings.push(`${workspace} 下没有 runs/*.jsonl —— 没有可归属的 run；锚点结论仍会被摄入但缺少 run 归属`);
  }

  // ── 2. 读决策日志（Gate 裁决历史在这里，是完整的）────────────────
  const decisions = await readDecisions(join(workspace, 'decisions.jsonl'));

  /**
   * 把决策按 run 切块：每个 `run.started` 开启一块，直到下一个 `run.started`。
   * 这正是它们被写下的顺序，所以切块不需要猜。
   */
  const blocks = splitIntoRunBlocks(decisions);

  const runIds = [...runRecords.keys()];
  const blockToRun = new Map<number, string>();
  if (blocks.length === runIds.length && blocks.length > 0) {
    // 只有一个 run 的工作区（llm-1..13 全是这种）在这里是平凡正确的。
    blocks.forEach((_, i) => blockToRun.set(i, runIds[i]!));
  } else if (blocks.length > 0) {
    warnings.push(
      `决策块数（${blocks.length}）与 run 数（${runIds.length}）不一致 —— 无法可靠归属，` +
        'Gate/run 的写入被跳过（宁缺勿编）。',
    );
  }

  for (const [runId, recs] of runRecords) {
    const blockIdx = [...blockToRun.entries()].find(([, r]) => r === runId)?.[0];
    const block = blockIdx === undefined ? [] : blocks[blockIdx]!.entries;
    const started = block.find((e) => e.kind === 'run.started');
    const finished = block.find((e) => e.kind === 'run.finished');
    const startedPayload = (started?.payload ?? {}) as { brief?: string };
    const finishedPayload = (finished?.payload ?? {}) as {
      finalStage?: string;
      delivery?: string;
      cycles?: number;
    };
    const times = recs.map((r) => r.at).sort();

    mem.db
      .prepare(
        `INSERT OR REPLACE INTO runs
         (run_id, workspace_key, brief, started_at, finished_at, delivery, final_stage, cycles, env_hash, source_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        mem.workspaceKey,
        startedPayload.brief ?? null,
        started?.at ?? times[0] ?? null,
        finished?.at ?? times[times.length - 1] ?? null,
        finishedPayload.delivery ?? null,
        finishedPayload.finalStage ?? null,
        finishedPayload.cycles ?? null,
        envHash,
        runsDir,
      );
    stats.runs++;
  }

  // ── 3. Gate ────────────────────────────────────────────────────
  for (const [blockIdx, runId] of blockToRun) {
    for (const entry of blocks[blockIdx]!.entries) {
      if (entry.kind !== 'gate.evaluated') continue;
      const p = (entry.payload ?? {}) as {
        stage?: string;
        sequence?: number;
        blocked?: boolean;
        hostInvoked?: boolean;
        nextAction?: { kind?: string };
        anchors?: { id?: string; verdict?: string }[];
      };
      mem.db
        .prepare(
          `INSERT OR REPLACE INTO gates
           (gate_id, run_id, stage, sequence, action, blocked, host_invoked, at, anchors_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${runId}#${entry.seq}`,
          runId,
          p.stage ?? 'UNKNOWN',
          p.sequence ?? null,
          p.nextAction?.kind ?? null,
          p.blocked ? 1 : 0,
          p.hostInvoked ? 1 : 0,
          entry.at,
          JSON.stringify(p.anchors ?? []),
        );
      stats.gates++;
    }
  }

  // ── 4. 锚点结论 → findings（打回原因的最小可核查单元）─────────────
  const anchorsDir = join(workspace, 'anchors');
  const anchorFiles = (await safeReaddir(anchorsDir)).filter((f) => f.endsWith('.json')).sort();
  const rounds = new Map<string, AnchorLink[]>();
  for (const f of anchorFiles) {
    const link = await readJsonOrNull<AnchorLink>(join(anchorsDir, f));
    if (!link || !link.anchorId) continue;
    const round = f.replace(/-\d+\.json$/, '');
    const list = rounds.get(round) ?? [];
    list.push(link);
    rounds.set(round, list);
  }
  stats.anchorRounds = rounds.size;

  const roundIds = [...rounds.keys()];

  /**
   * 链接 Gate ↔ 锚点轮次：**靠「锚点 id + 结论」的集合相等**，而不是靠序号。
   *
   * 一开始我用的是「轮次数 == Gate 数就按顺序配」——量了一下发现根本不成立：
   * `-c<N>` 那个前缀是**锚点上下文创建计数器**，不是 Gate 序号
   * （`makeCtx()` 有三个调用点，见 `orchestrator.ts` 346/362/1199），
   * 于是 llm-13 跑到第 3 个 Gate 时已经出现 `-c3`/`-c4` 而 `-c1`/`-c2` 从没出现过。
   * 按序号配会**系统性地配错**，而且错得很像对的。
   *
   * 集合相等则是数据本身说了算：`gate.evaluated` 的 `anchors_json` 记着这次 Gate
   * 跑了哪些锚点、各自什么结论；锚点文件里记着同一批东西。两者相等才链接。
   *
   * 相等的有多个（同一 run 里两个 Gate 结论完全一样）→ **留空**，不猜。
   */
  const gateInfos: { gateId: string; key: string; runId: string }[] = [];
  for (const [blockIdx, runId] of blockToRun) {
    for (const entry of blocks[blockIdx]!.entries) {
      if (entry.kind !== 'gate.evaluated') continue;
      const p = (entry.payload ?? {}) as { anchors?: { id?: string; verdict?: string }[] };
      gateInfos.push({
        gateId: `${runId}#${entry.seq}`,
        runId,
        key: anchorKey(p.anchors ?? []),
      });
    }
  }

  const roundKey = new Map<string, string>();
  for (const round of roundIds) {
    roundKey.set(
      round,
      anchorKey(rounds.get(round)!.map((l) => ({ id: l.anchorId, verdict: l.verdict }))),
    );
  }

  const roundGate = new Map<string, string | null>();
  const roundRun = new Map<string, string | null>();
  let ambiguous = 0;
  let unmatched = 0;
  for (const round of roundIds) {
    const key = roundKey.get(round)!;
    const cands = gateInfos.filter((g) => g.key === key && key !== '');
    if (cands.length === 1) {
      roundGate.set(round, cands[0]!.gateId);
      roundRun.set(round, cands[0]!.runId);
    } else {
      roundGate.set(round, null);
      // 链接不上 Gate 时，只有在「本工作区只有一个 run」这种无歧义的情况下
      // 才敢把 run 归属填上 —— 否则留 NULL。
      roundRun.set(round, runIds.length === 1 ? runIds[0]! : null);
      if (cands.length > 1) ambiguous++;
      else unmatched++;
    }
  }
  if (ambiguous > 0) {
    warnings.push(
      `有 ${ambiguous} 个锚点轮次的「锚点 id + 结论」集合与多个 Gate 完全相同 —— ` +
        '无法唯一确定归属，一律留空（不猜）。',
    );
  }
  if (unmatched > 0) {
    warnings.push(`有 ${unmatched} 个锚点轮次找不到结论完全一致的 Gate —— 留空。`);
  }

  if (roundIds.length > 0 && roundIds.length < stats.gates) {
    warnings.push(
      `锚点轮次（${roundIds.length}）少于 Gate 数（${stats.gates}）—— 这是 docs/07 §L14 的覆盖 bug：` +
        '历史运行里中间轮次的失败原因已经被覆盖掉了，只剩最后一轮。' +
        '同时也说明：**「某条记忆有没有用」无法靠回填历史回答，必须在运行中记录**（`Recorder`）。',
    );
  }

  let roundIdx = 0;
  for (const round of roundIds) {
    const links = rounds.get(round)!;
    const gateId = roundGate.get(round) ?? null;
    const owningRun = roundRun.get(round) ?? null;
    roundIdx++;

    for (const link of links) {
      const anchorId = link.anchorId as AnchorId;
      const hashesJson = JSON.stringify(link.contentHashes ?? {});
      for (let i = 0; i < (link.findings ?? []).length; i++) {
        const finding = link.findings[i] as AnchorFinding;
        const cls = classifyFinding(anchorId, finding);
        const findingId = findingIdOf(round, anchorId, i);
        const signature = `${anchorId}|${finding.code}|${cls.cls}`;

        mem.db
          .prepare(
            `INSERT OR REPLACE INTO findings
             (finding_id, run_id, gate_id, anchor_round, anchor, code, severity, message, file, line,
              target_role, data_json, class, rule_id, because, eligible, text_based, self_report, signature,
              artifact_refs_json, artifact_hashes_json, method, authority, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            findingId,
            owningRun,
            gateId,
            round,
            anchorId,
            finding.code ?? 'unknown',
            finding.severity ?? 'fail',
            finding.message ?? '',
            finding.file ?? null,
            finding.line ?? null,
            finding.targetRole ?? null,
            finding.data === undefined ? null : JSON.stringify(finding.data),
            cls.cls,
            cls.ruleId,
            cls.because,
            cls.eligible ? 1 : 0,
            cls.textBased ? 1 : 0,
            cls.selfReport ? 1 : 0,
            signature,
            hashesJson,
            hashesJson,
            link.method ?? null,
            link.authority ?? null,
            link.at ?? now,
          );

        stats.findings++;
        stats.byClass[cls.cls] = (stats.byClass[cls.cls] ?? 0) + 1;
        if (cls.eligible) stats.eligibleFindings++;
        if (cls.textBased) stats.textBasedFindings++;
        if (gateId) stats.linkedFindings++;
        else stats.unlinkedFindings++;
      }
    }
  }

  // ── 5. 修复策略 ────────────────────────────────────────────────
  for (const [runId, recs] of runRecords) {
    for (const r of recs) {
      if (!r.purpose?.startsWith('repair:')) continue;
      const text = r.response?.text ?? '';
      const repairId = `${runId}-seq${r.seq}`;
      mem.db
        .prepare(
          `INSERT OR REPLACE INTO repairs
           (repair_id, run_id, role, attempt, purpose, strategy, prompt_hash, response_hash, usage_json, at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          repairId,
          runId,
          r.role,
          r.attempt ?? 0,
          r.purpose,
          text.slice(0, maxStrategy),
          r.promptHash ?? null,
          text ? sha256(text) : null,
          r.response?.usage === undefined ? null : JSON.stringify(r.response.usage),
          r.at,
          'runs/*.jsonl',
        );
      stats.repairs++;
    }
  }

  // findings.run_id 现在写的是**编排 run**（能 JOIN 到 runs），所以下面这个自检必然成立；
  // 留着它是因为「run_id 只有两种可能：NULL 或一个真实存在的 run」是一条值得被守住的不变量 ——
  // 一旦哪天有人把锚点轮次 id 又写回 run_id，这里会立刻报出来。
  const orphan = mem.db
    .prepare(
      `SELECT COUNT(*) AS n FROM findings f
       WHERE f.run_id IS NOT NULL AND f.run_id NOT IN (SELECT run_id FROM runs)`,
    )
    .get() as { n: number };
  if (orphan.n > 0) {
    warnings.push(
      `有 ${orphan.n} 条 finding 的 run_id 不属于任何已录入的 run —— ` +
        '说明写入方把「锚点轮次 id」当成「编排 run id」了。两者不同名，混用会让 excludeRunId 静默失效。',
    );
  }

  return stats;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * 一条发现的稳定主键。
 *
 * **摄入器与实时记录器共用这个函数** —— 否则同一次运行先被实时记录、事后又被
 * `ingestWorkspace()` 扫一遍，会产生两份不同的 finding_id，记忆里就出现重复事实。
 * 把 id 生成抽成一处比「两边都记得写对」可靠。
 */
export function findingIdOf(anchorRound: string, anchorId: string, index: number): string {
  return `${anchorRound}-${anchorId}-${String(index + 1).padStart(2, '0')}`;
}

/**
 * 一组 (锚点 id, 结论) 的规范化键，用于「这次 Gate 检查了什么」的集合相等比较。
 * 排序后拼接 —— 与顺序无关，因为锚点执行顺序不表达任何语义。
 */
function anchorKey(list: { id?: string; verdict?: string }[]): string {
  return list
    .filter((a) => a.id)
    .map((a) => `${a.id}:${a.verdict ?? '?'}`)
    .sort()
    .join(',');
}

async function readDecisions(path: string): Promise<DecisionEntry[]> {
  const text = await readTextOrNull(path);
  if (!text) return [];
  const out: DecisionEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as DecisionEntry;
      if (typeof e.seq === 'number' && typeof e.kind === 'string') out.push(e);
    } catch {
      // 不完整的最后一行（run 被中断）—— 跳过
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * 按 `run.started` 把决策切成 run 块。
 * 第一次 `run.started` 之前的决策（理论上不该有）归入「无主块」，不参与归属。
 */
function splitIntoRunBlocks(decisions: DecisionEntry[]): { entries: DecisionEntry[] }[] {
  const blocks: { entries: DecisionEntry[] }[] = [];
  let cur: { entries: DecisionEntry[] } | null = null;
  for (const e of decisions) {
    if (e.kind === 'run.started') {
      cur = { entries: [e] };
      blocks.push(cur);
      continue;
    }
    if (cur) cur.entries.push(e);
  }
  return blocks;
}
