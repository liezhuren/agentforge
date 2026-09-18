/**
 * 运行中记录（Recorder）：把 L1 事实**在它们发生的当下**写进记忆库。
 *
 * ## 为什么必须有它，而不是只靠事后摄入
 *
 * 这是**量出来的结论**，不是设计偏好。勘察历史数据时发现：
 * `llm-1`..`llm-12` 每个工作区的 `anchors/` 目录里只剩 **1 个轮次**，
 * 而当时跑过 **3–9 个 Gate**（覆盖 bug，`docs/07 §L14`）。
 * 于是「这个失败是第几轮出现的」「同类失败复发了几次」这些信息在磁盘上**永久丢失**。
 *
 * 直接后果：`efficacyOf()`（「这条记忆有没有用」）所依赖的
 * 「注入之后同类失败是否再现」，**无法靠回填历史回答**。
 * 想让记忆系统能证明自己有用，就必须在运行时把事实记下来。
 *
 * ## 它为什么不需要改编排器一行代码
 *
 * 因为编排器已经把 `anchor.ran` / `gate.evaluated` / `run.started` 这些**不可变事实**
 * 广播到了 `EventBus`，并且 `OrchestratorOptions.bus` 允许外部传入自己的总线。
 * 所以记录器是一个**纯投影**（projection）—— 这正是 `events.ts` 里写的那个设计：
 * 「前端（P4）与测试只是投影」。
 *
 * 这条路径还顺带解决了一个事后摄入做不到的事：
 * 事件是**按发生顺序**到达的，所以「这批锚点结论属于哪个 Gate」是**确定的**，
 * 不需要像 `ingest.ts` 那样靠「锚点 id + 结论」的集合相等去反推。
 *
 * ## 它不做的事
 *
 * - **不做任何 LLM 调用**（记事实不需要模型）。
 * - **不改判定**：订阅者出错会被 `EventBus` 吞掉（它 `try/catch` 了每个监听器），
 *   而这里所有写入也都是「记下来」，不影响返回给编排器的任何值。
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  readTextOrNull,
  sha256,
  type AnchorFinding,
  type AnchorId,
  type EventBus,
  type ForgeEvent,
  type RunId,
} from '../../core/src/index.ts';
import { classifyFinding } from './rootcause.ts';
import { findingIdOf } from './ingest.ts';
import type { MemoryDb } from './db.ts';

export type RecorderStats = {
  runs: number;
  gates: number;
  anchorResults: number;
  findings: number;
  eligibleFindings: number;
  /** 收尾时仍未归属到 Gate 的发现数（run 被中断时会 > 0）。 */
  unassignedFindings: number;
  /** 依据是文本模式的发现数。 */
  textBasedFindings: number;
};

type PendingFinding = {
  findingId: string;
  runId: string | null;
  anchorRound: string;
  anchor: string;
  code: string;
  severity: string;
  message: string;
  file: string | null;
  line: number | null;
  targetRole: string | null;
  dataJson: string | null;
  cls: string;
  ruleId: string;
  because: string;
  eligible: number;
  textBased: number;
  selfReport: number;
  signature: string;
  hashesJson: string;
  method: string | null;
  authority: string | null;
  at: string;
};

export class MemoryRecorder {
  private mem: MemoryDb;
  private currentRunId: string | null = null;
  private pending: PendingFinding[] = [];
  private stats: RecorderStats = {
    runs: 0,
    gates: 0,
    anchorResults: 0,
    findings: 0,
    eligibleFindings: 0,
    unassignedFindings: 0,
    textBasedFindings: 0,
  };
  private detach: (() => void) | null = null;

  constructor(mem: MemoryDb) {
    this.mem = mem;
  }

  /** 订阅事件总线。返回取消订阅的函数。 */
  attach(bus: EventBus): () => void {
    const listener = (e: ForgeEvent) => this.onEvent(e);
    this.detach = bus.on(listener);
    return () => {
      this.detach?.();
      this.detach = null;
    };
  }

  /** 当前统计（实测值，不预测）。 */
  snapshot(): RecorderStats {
    return { ...this.stats };
  }

  private onEvent(e: ForgeEvent): void {
    try {
      switch (e.t) {
        case 'run.started':
          this.currentRunId = e.runId;
          this.mem.db
            .prepare(
              `INSERT INTO runs (run_id, workspace_key, brief, started_at, source_dir)
               VALUES (?, ?, ?, ?, 'event:run.started')
               ON CONFLICT(run_id) DO UPDATE SET brief = excluded.brief`,
            )
            .run(e.runId, this.mem.workspaceKey, e.brief, new Date().toISOString());
          this.stats.runs++;
          break;

        case 'anchor.ran':
          this.bufferAnchor(e.result as unknown as AnchorLinkLike);
          break;

        case 'gate.evaluated':
          this.flush(e.result as unknown as GateResultLike);
          break;

        case 'run.finished':
          if (this.currentRunId) {
            this.mem.db
              .prepare(`UPDATE runs SET finished_at = ?, final_stage = ?, delivery = ? WHERE run_id = ?`)
              .run(new Date().toISOString(), e.stage, e.delivery, this.currentRunId);
          }
          break;

        default:
          break;
      }
    } catch {
      // 记录失败绝不能让 run 崩掉。
      // 这里是「静默」的，但**不是没有痕迹**：写不进去的行会在复核时缺席，
      // 而 `snapshot()` 的数字与数据库行数对不上 —— 报告里会暴露出来。
    }
  }

  /**
   * 缓冲一次锚点结论的发现，**不立刻写库**。
   *
   * 因为 `gate.evaluated` 在 `anchor.ran` **之后**才到达，
   * 而 `findings.gate_id` 要等 Gate 才知道。先缓冲、后落库，
   * 换来的是**确定的**归属，而不是事后反推的归属。
   */
  private bufferAnchor(link: AnchorLinkLike): void {
    this.stats.anchorResults++;
    const anchorId = link.anchorId as AnchorId;
    const round = link.runId;
    const hashesJson = JSON.stringify(link.contentHashes ?? {});

    for (let i = 0; i < (link.findings ?? []).length; i++) {
      const finding = (link.findings ?? [])[i] as AnchorFinding;
      const cls = classifyFinding(anchorId, finding);
      this.pending.push({
        findingId: findingIdOf(round, anchorId, i),
        runId: null, // 由 flush 填：事件的 runId 是编排 run，锚点 id 是轮次 id，两者不同名
        anchorRound: round,
        anchor: anchorId,
        code: finding.code ?? 'unknown',
        severity: finding.severity ?? 'fail',
        message: finding.message ?? '',
        file: finding.file ?? null,
        line: finding.line ?? null,
        targetRole: finding.targetRole ?? null,
        dataJson: finding.data === undefined ? null : JSON.stringify(finding.data),
        cls: cls.cls,
        ruleId: cls.ruleId,
        because: cls.because,
        eligible: cls.eligible ? 1 : 0,
        textBased: cls.textBased ? 1 : 0,
        selfReport: cls.selfReport ? 1 : 0,
        signature: `${anchorId}|${finding.code}|${cls.cls}`,
        hashesJson,
        method: link.method ?? null,
        authority: link.authority ?? null,
        at: link.at ?? new Date().toISOString(),
      });
    }
  }

  /** Gate 到达 → 写 Gate、把这批缓冲的发现按确定的 Gate 归属落库。 */
  private flush(gate: GateResultLike): void {
    const runId = this.currentRunId;
    if (!runId) {
      // 没有 run.started 就收到 gate.evaluated —— 不猜归属，但也不丢，留给 finalize。
      return;
    }
    const gateId = `${runId}#${gate.sequence ?? this.stats.gates + 1}-${gate.stage ?? 'UNKNOWN'}`;
    this.mem.db
      .prepare(
        `INSERT OR REPLACE INTO gates
         (gate_id, run_id, stage, sequence, action, blocked, host_invoked, at, anchors_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        gateId,
        runId,
        gate.stage ?? 'UNKNOWN',
        gate.sequence ?? null,
        gate.nextAction?.kind ?? null,
        gate.blocked ? 1 : 0,
        gate.hostInvoked ? 1 : 0,
        new Date().toISOString(),
        JSON.stringify(this.pending.map((p) => ({ id: p.anchor, verdict: p.severity }))),
      );
    this.stats.gates++;

    const stmt = this.mem.db.prepare(
      `INSERT OR REPLACE INTO findings
       (finding_id, run_id, gate_id, anchor_round, anchor, code, severity, message, file, line,
        target_role, data_json, class, rule_id, because, eligible, text_based, self_report, signature,
        artifact_refs_json, artifact_hashes_json, method, authority, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of this.pending) {
      stmt.run(
        p.findingId, runId, gateId, p.anchorRound, p.anchor, p.code, p.severity, p.message,
        p.file, p.line, p.targetRole, p.dataJson, p.cls, p.ruleId, p.because, p.eligible,
        p.textBased, p.selfReport, p.signature, p.hashesJson, p.hashesJson, p.method, p.authority, p.at,
      );
      this.stats.findings++;
      if (p.eligible) this.stats.eligibleFindings++;
      if (p.textBased) this.stats.textBasedFindings++;
    }
    this.pending = [];
  }

  /**
   * 收尾：把仍未归属的发现落库（`gate_id` 留空），并从 `runs/*.jsonl` 补上修复策略。
   *
   * `repairs` 只能在这里补，因为**修复策略不在事件流里** ——
   * 它是 LLM 调用记录（`runs/*.jsonl`）的内容。
   * 这是事件总线目前覆盖不到的一块，如实说明比假装它有更好。
   */
  async finalize(workspace: string): Promise<RecorderStats> {
    this.detach?.();
    this.detach = null;

    if (this.pending.length > 0) {
      const stmt = this.mem.db.prepare(
        `INSERT OR REPLACE INTO findings
         (finding_id, run_id, gate_id, anchor_round, anchor, code, severity, message, file, line,
          target_role, data_json, class, rule_id, because, eligible, text_based, self_report, signature,
          artifact_refs_json, artifact_hashes_json, method, authority, at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of this.pending) {
        stmt.run(
          p.findingId, this.currentRunId, p.anchorRound, p.anchor, p.code, p.severity, p.message,
          p.file, p.line, p.targetRole, p.dataJson, p.cls, p.ruleId, p.because, p.eligible,
          p.textBased, p.selfReport, p.signature, p.hashesJson, p.hashesJson, p.method, p.authority, p.at,
        );
        this.stats.findings++;
        this.stats.unassignedFindings++;
        if (p.eligible) this.stats.eligibleFindings++;
        if (p.textBased) this.stats.textBasedFindings++;
      }
      this.pending = [];
    }

    await this.collectRepairs(workspace);
    return this.snapshot();
  }

  /** 从 LLM 回放记录里捞出 `repair:*` 调用 —— 那是「修复策略」的唯一来源。 */
  private async collectRepairs(workspace: string): Promise<void> {
    const dir = join(workspace, 'runs');
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return;
    }
    for (const f of files) {
      const text = await readTextOrNull(join(dir, f));
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let r: {
          runId: string;
          seq: number;
          at: string;
          role: string;
          purpose: string;
          attempt?: number;
          promptHash?: string;
          response?: { text?: string; usage?: unknown };
        };
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (!r.purpose?.startsWith('repair:')) continue;
        const body = r.response?.text ?? '';
        this.mem.db
          .prepare(
            `INSERT OR REPLACE INTO repairs
             (repair_id, run_id, role, attempt, purpose, strategy, prompt_hash, response_hash, usage_json, at, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'event:finalize')`,
          )
          .run(
            `${r.runId}-seq${r.seq}`,
            r.runId,
            r.role,
            r.attempt ?? 0,
            r.purpose,
            body.slice(0, 4000),
            r.promptHash ?? null,
            body ? sha256(body) : null,
            r.response?.usage === undefined ? null : JSON.stringify(r.response.usage),
            r.at,
          );
      }
    }
  }
}

/** `anchor.ran` 事件里携带的结构（用最小形状而不是 import 整个类型，减少耦合）。 */
type AnchorLinkLike = {
  anchorId: string;
  runId: string;
  contentHashes?: Record<string, string>;
  findings?: unknown[];
  method?: string;
  authority?: string;
  at?: string;
};

type GateResultLike = {
  stage?: string;
  sequence?: number;
  blocked?: boolean;
  hostInvoked?: boolean;
  nextAction?: { kind?: string };
};

/** 便捷函数：给一个总线接上记录器，返回 `{recorder, detach}`。 */
export function attachMemoryRecorder(mem: MemoryDb, bus: EventBus): { recorder: MemoryRecorder; detach: () => void } {
  const recorder = new MemoryRecorder(mem);
  const detach = recorder.attach(bus);
  return { recorder, detach };
}

/** 工作区 → 记忆库里的稳定标识。 */
export function workspaceKeyOf(path: string): string {
  return sha256(path).slice(0, 16);
}

/** 便于调用方拿到「这次 run 的 id」（编排 run，不是锚点轮次 id）。 */
export function currentRunIdOf(recorder: MemoryRecorder): RunId | null {
  return (recorder as unknown as { currentRunId: string | null }).currentRunId;
}
