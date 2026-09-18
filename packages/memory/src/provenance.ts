/**
 * 出处（provenance）：三条硬约束里的**第一条**，也是整个记忆系统的地基。
 *
 * > 「每条记忆必须有出处。一条『本项目要求 `.ts` 扩展名』必须能回答
 * > 『谁、在哪一轮、根据什么证据得出的』。**没有出处的记忆就是不可核查的规则** ——
 * > 正是本项目最反对的东西。」
 *
 * ## 一处重要的自我更正
 *
 * 上面那段话（我上一轮写进 `docs/HANDOFF.md` §8.0-mem 的）后面跟了一句推论：
 * 「这条直接排除了『向量库 + 相似检索』那一套」。
 *
 * **那个推论是错的，本轮实测后撤回。** 理由：
 *
 * 它把「检索」和「无出处的检索」当成了一回事。但向量在这里只是**索引键**：
 * `embeddings` 表的主键是 `(ref_kind, ref_id, model)`，检索先筛出**行**、
 * 再按相似度排序，返回的载荷始终是 facts 表里那行**带完整出处**的记录。
 * 相似度决定的是**顺序**，从来不是**内容**。
 *
 * 于是「有没有出处」与「用不用向量」是两个正交的问题。真正排除无出处记忆的，
 * 是这个文件里的 `verifyProvenance()` 与检索时的 `requireProvenance` 开关 ——
 * 一个**确定性检查**，而不是对某种技术的禁令。
 * （这也正是本项目的一贯做法：用可执行的检查代替措辞上的原则。）
 *
 * ## 为什么「出处不完整」要导致**丢弃**而不是降权
 *
 * 因为降权的结果是「它偶尔还是会被注入提示词」—— 那就等于约束没生效。
 * 出处不完整的记忆不是「质量差一点的记忆」，是**不可核查的规则**，
 * 而本项目所有假绿灯都来自不可核查的规则（§6.4）。所以：默认丢弃，并计数上报。
 */

import type { MemoryDb } from './db.ts';

export type Provenance = {
  findingId: string;
  /** 锚点轮次标识（`anchors/` 文件名前缀）。无条件可得。 */
  anchorRound: string;
  anchor: string;
  code: string;
  cls: string;
  /** 分类器自身的出处：命中了哪条规则。 */
  ruleId: string;
  at: string;
  /** 被检查工件在**检查那一刻**的内容 hash —— 事后改动工件就对不上了。 */
  artifactHashes: Record<string, string>;
  method: string | null;
  authority: string | null;
  /** 编排 run 的信息。历史 run 可能解析不到（锚点 id 与编排 id 不同名），那时为 null。 */
  run: {
    runId: string;
    brief: string | null;
    delivery: string | null;
    finalStage: string | null;
    startedAt: string | null;
  } | null;
  /** 非空 = 出处不完整。默认会被检索丢弃。 */
  problems: string[];
};

/**
 * 组装一条 finding 的完整出处链，并**当场检查**它是否完整。
 *
 * 检查项（都是确定性的，不涉及任何模型）：
 * 1. `anchor_round` / `anchor` / `code` / `class` 必须非空 —— 缺一个就说不清「哪来的」
 * 2. `artifactHashes` 必须非空且是合法 JSON 对象 —— 它是「当时被检查的是什么」的唯一凭据
 * 3. `rule_id` 不能是 `none` —— 分类说不清依据的，不能当记忆用
 * 4. `at` 必须存在 —— 没有时间就无法审计「是在哪一轮之后注入的」
 *
 * ⚠️ **`run` 解析不到不算 problem**：老 run 的锚点 runId 与编排 runId 本就不同名
 * （见 `ingest.ts` 的说明）。把「历史数据格式不同」判成「出处不完整」，
 * 会让整套历史记忆被丢掉 —— 那是过度严格，不是严谨。
 */
export function verifyProvenance(mem: MemoryDb, findingId: string): Provenance | null {
  const row = mem.db
    .prepare(
      `SELECT finding_id, run_id, anchor_round, anchor, code, class, rule_id, at,
              artifact_hashes_json, method, authority
       FROM findings WHERE finding_id = ?`,
    )
    .get(findingId) as
    | {
        finding_id: string;
        run_id: string | null;
        anchor_round: string;
        anchor: string;
        code: string;
        class: string;
        rule_id: string;
        at: string;
        artifact_hashes_json: string | null;
        method: string | null;
        authority: string | null;
      }
    | undefined;

  if (!row) return null;

  const problems: string[] = [];
  if (!row.anchor_round) problems.push('缺 anchor_round（不知道是哪一轮的哪次锚点结论）');
  if (!row.anchor) problems.push('缺 anchor（不知道是哪个锚点报的）');
  if (!row.code) problems.push('缺 code（不知道是什么类型的发现）');
  if (!row.class || row.class === 'unknown') {
    problems.push('根因类未识别（unknown）—— 分类说不清依据的发现不能当记忆用');
  }
  if (!row.rule_id || row.rule_id === 'none') problems.push('分类器没有给出规则出处（rule_id = none）');
  if (!row.at) problems.push('缺时间戳（无法审计注入的先后顺序）');

  let artifactHashes: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.artifact_hashes_json ?? '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      artifactHashes = parsed as Record<string, string>;
    }
  } catch {
    problems.push('artifact_hashes_json 不是合法 JSON');
  }
  if (Object.keys(artifactHashes).length === 0) {
    problems.push('没有任何工件内容 hash —— 无法证明「当时被检查的是什么」');
  }

  let run: Provenance['run'] = null;
  if (row.run_id) {
    const r = mem.db
      .prepare(
        `SELECT run_id, brief, delivery, final_stage, started_at FROM runs WHERE run_id = ?`,
      )
      .get(row.run_id) as
      | {
          run_id: string;
          brief: string | null;
          delivery: string | null;
          final_stage: string | null;
          started_at: string | null;
        }
      | undefined;
    if (r) {
      run = {
        runId: r.run_id,
        brief: r.brief,
        delivery: r.delivery,
        finalStage: r.final_stage,
        startedAt: r.started_at,
      };
    }
  }

  return {
    findingId: row.finding_id,
    anchorRound: row.anchor_round,
    anchor: row.anchor,
    code: row.code,
    cls: row.class,
    ruleId: row.rule_id,
    at: row.at,
    artifactHashes,
    method: row.method,
    authority: row.authority,
    run,
    problems,
  };
}

/**
 * 出处 → 一行**人可读**的说明。
 *
 * 这是「可核查」落到界面上的形式：用户点开一条经验，看到的应该是
 * 「在 llm-7 的第 3 轮锚点里，A4 报了 TS2835，当时 src/api/app.ts 的内容 hash 是 1423fec1…」，
 * 而不是「模型觉得应该这样」。
 */
export function describeProvenance(p: Provenance): string {
  const parts: string[] = [];
  const where = p.run ? `${p.run.runId}` : p.anchorRound;
  parts.push(`${where} 的锚点轮次 ${p.anchorRound}`);
  parts.push(`${p.anchor}/${p.code} 判定为「${p.cls}」（规则 ${p.ruleId}）`);
  parts.push(`时间 ${p.at}`);
  const hashKeys = Object.keys(p.artifactHashes);
  if (hashKeys.length > 0) {
    const sample = hashKeys.slice(0, 2).map((k) => `${k}=${p.artifactHashes[k]!.slice(0, 12)}…`);
    parts.push(
      `当时被检查的工件内容 hash：${sample.join('、')}${hashKeys.length > 2 ? ` 等 ${hashKeys.length} 个` : ''}`,
    );
  }
  if (p.method) parts.push(`取证方法：${p.method}`);
  if (p.problems.length > 0) parts.push(`⚠️ 出处不完整：${p.problems.join('；')}`);
  return parts.join('；');
}

/**
 * 批量取出处，并**丢弃**出处不完整的那些。
 *
 * 返回 `{ kept, dropped }` —— dropped 会被上报而不是静默吞掉。
 * 「静默无效比明确拒绝更糟」（§6.11），这条在记忆系统上同样成立：
 * 如果 100 条记忆里有 40 条因为出处不完整被丢了，用户必须看得到这个数字。
 */
export function resolveProvenance(
  mem: MemoryDb,
  findingIds: string[],
): { kept: { findingId: string; provenance: Provenance }[]; dropped: { findingId: string; problems: string[] }[] } {
  const kept: { findingId: string; provenance: Provenance }[] = [];
  const dropped: { findingId: string; problems: string[] }[] = [];
  for (const id of findingIds) {
    const p = verifyProvenance(mem, id);
    if (!p) {
      dropped.push({ findingId: id, problems: ['记忆库里找不到这条 finding'] });
      continue;
    }
    if (p.problems.length > 0) {
      dropped.push({ findingId: id, problems: p.problems });
      continue;
    }
    kept.push({ findingId: id, provenance: p });
  }
  return { kept, dropped };
}
