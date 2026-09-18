/**
 * L2 检索：**先筛、再排**（filter-then-rank）。
 *
 * ## 顺序不是实现细节，它是三条约束的落点
 *
 * ```
 * 1. SQL 确定性筛      ← 失效机制 / 类白名单 / 出处完整性在这里生效
 * 2. 相似度排序        ← 向量只影响这一层的**顺序**
 * 3. 组装出处          ← 出处不完整的命中被丢弃并计数
 * ```
 *
 * 如果把顺序反过来（先按相似度取 topK、再过滤），会出现一种很难发现的坏情况：
 * **结果集被污染后又被裁掉，于是「筛掉了多少」这件事被隐藏了** ——
 * 报告里只看到「返回了 5 条」，看不出「其实有 40 条因为出处不完整被丢了」。
 * 先筛后排还让前置筛选能吃到索引（`idx_findings_class`）。
 *
 * ## 类过滤比相似度更重要（一个可验证的判断）
 *
 * 根因类是由**确定性规则**从结构化字段（`tsCode` / `exitCode` / `deliverable`）
 * 判出来的，所以「同一个类的历史发现」是**精确**关系，而不是相似关系。
 * 相似度只在两个地方还有增量价值：
 *   a. 类没识别出来（`unknown`）的残留；
 *   b. 类相同、但要挑**哪一条**最像（例如挑一条最相关的历史修复策略）。
 *
 * 所以默认路径是 `retrieveByClass()` —— 它**完全不用向量**，零依赖、零不确定性。
 * `retrieveBySimilarity()` 是它的补充，不是它的替代。
 * 这个判断值不值，由 `scripts/memory-retrieval-bench.ts` 在真实数据上量（见那里的结论）。
 */

import type { RootCauseClass } from './rootcause.ts';
import type { EmbeddingProvider } from './embed.ts';
import { blobToVec, dot, vecToBlob } from './db.ts';
import { embeddingContentHashNormalized } from './embed.ts';
import { verifyProvenance, type Provenance } from './provenance.ts';
import type { MemoryDb } from './db.ts';

export type FindingRow = {
  finding_id: string;
  run_id: string | null;
  gate_id: string | null;
  anchor_round: string;
  anchor: string;
  code: string;
  severity: string;
  message: string;
  file: string | null;
  target_role: string | null;
  class: string;
  eligible: number;
  signature: string;
  at: string;
};

export type RetrievalHit = {
  refKind: 'finding';
  refId: string;
  /** 相似度分数。类检索路径下为 null（没有相似度这回事，别伪造一个 0）。 */
  score: number | null;
  /** 命中的是确定性筛选还是相似度 —— 报告里要说清结论是怎么来的。 */
  ranker: 'class' | 'cosine';
  row: FindingRow;
  provenance: Provenance;
};

export type RetrievalReport = {
  hits: RetrievalHit[];
  /** 候选总数（过滤后、排序前）。 */
  candidates: number;
  /** 因为出处不完整被丢弃的数量 —— 必须上报，不能静默。 */
  droppedNoProvenance: number;
  /** 丢弃原因的样例（最多 3 条），便于人看懂到底缺什么。 */
  droppedSamples: { findingId: string; problems: string[] }[];
  /** 实际用了哪个排序器。 */
  ranker: 'class' | 'cosine';
};

export type ClassQuery = {
  cls: RootCauseClass | string;
  /** 只要可进记忆的那些（默认 true）。 */
  eligibleOnly?: boolean;
  /** 排除某次 run —— 用于「不要拿这次 run 自己的历史当经验」这种自证陷阱。 */
  excludeRunId?: string;
  /** 只要 fail 级；默认不过滤（warn 也有价值，A7 的 33 条就是 warn）。 */
  severity?: 'fail' | 'warn';
  topK?: number;
  /** 出处不完整的一律丢弃（默认 true）。关掉只在诊断时用。 */
  requireProvenance?: boolean;
};

const ROW_COLUMNS = `f.finding_id, f.run_id, f.gate_id, f.anchor_round, f.anchor, f.code,
  f.severity, f.message, f.file, f.target_role, f.class, f.eligible, f.signature, f.at`;

/**
 * 按根因类精确检索历史发现。**不涉及任何向量**。
 *
 * 这是默认路径：类的判定是确定性的，所以「同类历史」是精确集合而不是相似集合。
 */
export function retrieveByClass(mem: MemoryDb, q: ClassQuery): RetrievalReport {
  const requireProv = q.requireProvenance !== false;
  const where: string[] = ['f.class = ?'];
  const params: (string | number)[] = [q.cls];
  if (q.eligibleOnly !== false) where.push('f.eligible = 1');
  if (q.severity) {
    where.push('f.severity = ?');
    params.push(q.severity);
  }
  if (q.excludeRunId) {
    // run_id 可能为 NULL（老 run 的锚点 id 与编排 id 不同名）——
    // 那些行的归属靠 anchor_round，所以排除逻辑不能把它们一起误杀：
    // 只有**明确等于** excludeRunId 的才排除。
    where.push('(f.run_id IS NULL OR f.run_id <> ?)');
    params.push(q.excludeRunId);
  }

  const rows = mem.db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM findings f
       WHERE ${where.join(' AND ')}
       ORDER BY f.at DESC`,
    )
    .all(...params) as unknown as FindingRow[];

  const hits: RetrievalHit[] = [];
  const droppedSamples: { findingId: string; problems: string[] }[] = [];
  let dropped = 0;

  for (const row of rows) {
    if (requireProv) {
      const p = verifyProvenance(mem, row.finding_id);
      if (!p || p.problems.length > 0) {
        dropped++;
        if (droppedSamples.length < 3) {
          droppedSamples.push({
            findingId: row.finding_id,
            problems: p ? p.problems : ['记忆库里找不到这条 finding'],
          });
        }
        continue;
      }
      hits.push({ refKind: 'finding', refId: row.finding_id, score: null, ranker: 'class', row, provenance: p });
    } else {
      const p = verifyProvenance(mem, row.finding_id);
      if (!p) {
        dropped++;
        continue;
      }
      hits.push({ refKind: 'finding', refId: row.finding_id, score: null, ranker: 'class', row, provenance: p });
    }
  }

  const topK = q.topK ?? 5;
  return {
    hits: hits.slice(0, topK),
    candidates: rows.length,
    droppedNoProvenance: dropped,
    droppedSamples,
    ranker: 'class',
  };
}

export type SimilarityQuery = {
  text: string;
  cls?: RootCauseClass | string;
  eligibleOnly?: boolean;
  excludeRunId?: string;
  topK?: number;
  requireProvenance?: boolean;
  /** 向量索引未命中时是否现算（默认 true）。关掉可以看清「索引覆盖率」这个指标。 */
  lazyIndex?: boolean;
};

/**
 * 相似度检索：**在同一批确定性过滤之后**按余弦相似度排序。
 *
 * 向量只决定顺序。若某条候选还没有向量，默认**现算并落库**（lazy index）——
 * 而不是跳过它。跳过会让「没建索引」伪装成「不相关」，那正是 §9.4 说的
 * 「可疑的零结果」：看起来是检索没找到，实际是我们没给它建索引。
 */
export async function retrieveBySimilarity(
  mem: MemoryDb,
  embedder: EmbeddingProvider,
  q: SimilarityQuery,
): Promise<RetrievalReport> {
  const requireProv = q.requireProvenance !== false;
  const lazy = q.lazyIndex !== false;
  const topK = q.topK ?? 5;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.cls) {
    where.push('f.class = ?');
    params.push(q.cls);
  }
  if (q.eligibleOnly) where.push('f.eligible = 1');
  if (q.excludeRunId) {
    where.push('(f.run_id IS NULL OR f.run_id <> ?)');
    params.push(q.excludeRunId);
  }

  const rows = mem.db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM findings f
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    )
    .all(...params) as unknown as FindingRow[];

  const [qvec] = await Promise.resolve(embedder.embed([q.text]));
  if (!qvec) {
    return { hits: [], candidates: rows.length, droppedNoProvenance: 0, droppedSamples: [], ranker: 'cosine' };
  }

  const stored = mem.db
    .prepare(`SELECT ref_id, dim, vec FROM embeddings WHERE ref_kind='finding' AND model = ?`)
    .all(embedder.id) as unknown as { ref_id: string; dim: number; vec: Uint8Array }[];
  const vecById = new Map<string, Float32Array>();
  for (const s of stored) vecById.set(s.ref_id, blobToVec(s.vec, s.dim));

  const hits: RetrievalHit[] = [];
  const droppedSamples: { findingId: string; problems: string[] }[] = [];
  let dropped = 0;

  for (const row of rows) {
    const p = verifyProvenance(mem, row.finding_id);
    if (!p || p.problems.length > 0) {
      if (requireProv) {
        dropped++;
        if (droppedSamples.length < 3) {
          droppedSamples.push({
            findingId: row.finding_id,
            problems: p ? p.problems : ['记忆库里找不到这条 finding'],
          });
        }
        continue;
      }
    }
    if (!p) {
      dropped++;
      continue;
    }

    let vec = vecById.get(row.finding_id);
    if (!vec) {
      if (!lazy) continue;
      const [computed] = await Promise.resolve(embedder.embed([row.message]));
      if (!computed) continue;
      vec = computed;
      storeEmbedding(mem, 'finding', row.finding_id, embedder, computed, row.message);
      vecById.set(row.finding_id, computed);
    }

    hits.push({
      refKind: 'finding',
      refId: row.finding_id,
      score: dot(qvec, vec),
      ranker: 'cosine',
      row,
      provenance: p,
    });
  }

  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return {
    hits: hits.slice(0, topK),
    candidates: rows.length,
    droppedNoProvenance: dropped,
    droppedSamples,
    ranker: 'cosine',
  };
}

/**
 * 把检索结果渲染成给人看的报告块。
 *
 * 刻意**不**渲染成「提示词片段」：这个函数的输出是给报告/控制台读的。
 * 进提示词的只有经验库里的 `active` 经验（见 `lessons.ts`），
 * 两者的文字形态不同是**故意的** —— 免得有人顺手把报告里的东西塞进提示词。
 */
export function renderRetrievalReport(r: RetrievalReport, opts: { maxItems?: number } = {}): string {
  const max = opts.maxItems ?? 5;
  const lines: string[] = [];
  lines.push(
    `候选 ${r.candidates} 条，排序器 ${r.ranker}，` +
      `因出处不完整丢弃 ${r.droppedNoProvenance} 条，返回 ${Math.min(r.hits.length, max)} 条`,
  );
  for (const h of r.hits.slice(0, max)) {
    const score = h.score === null ? '' : `（相似度 ${h.score.toFixed(3)}）`;
    lines.push(
      `- [${h.row.anchor}/${h.row.code}] ${h.row.message.slice(0, 100)}${score}\n` +
        `    出处：${h.provenance.run?.runId ?? h.provenance.anchorRound} · 轮次 ${h.provenance.anchorRound} · ${h.provenance.at} · 规则 ${h.provenance.ruleId}`,
    );
  }
  if (r.droppedSamples.length > 0) {
    lines.push('丢弃样例（前 3 条）：');
    for (const d of r.droppedSamples) lines.push(`- ${d.findingId}：${d.problems.join('；')}`);
  }
  return lines.join('\n');
}

/** 写入/更新一条向量。`contentHash` 变了才重算 —— 由调用方决定是否跳过。 */
export function storeEmbedding(
  mem: MemoryDb,
  refKind: string,
  refId: string,
  embedder: EmbeddingProvider,
  vec: Float32Array,
  content: string,
): void {
  mem.db
    .prepare(
      `INSERT OR REPLACE INTO embeddings (ref_kind, ref_id, model, dim, vec, content_hash, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      refKind,
      refId,
      embedder.id,
      vec.length,
      vecToBlob(vec),
      embeddingContentHashNormalized(content),
      new Date().toISOString(),
    );
}

/**
 * 给所有还没有向量的 finding 建索引。
 *
 * 返回**实测**覆盖率，绝不返回「应该都建好了」。
 */
export async function indexFindings(
  mem: MemoryDb,
  embedder: EmbeddingProvider,
  opts: { limit?: number } = {},
): Promise<{ indexed: number; total: number; skippedFresh: number }> {
  const total = (
    mem.db.prepare('SELECT COUNT(*) AS n FROM findings').get() as { n: number }
  ).n;

  const rows = mem.db
    .prepare(
      `SELECT f.finding_id, f.message FROM findings f
       LEFT JOIN embeddings e
         ON e.ref_kind = 'finding' AND e.ref_id = f.finding_id AND e.model = ?
       WHERE e.ref_id IS NULL`,
    )
    .all(embedder.id) as unknown as { finding_id: string; message: string }[];

  const limit = opts.limit ?? rows.length;
  const todo = rows.slice(0, limit);
  let indexed = 0;
  for (const r of todo) {
    const [vec] = await Promise.resolve(embedder.embed([r.message]));
    if (!vec) continue;
    storeEmbedding(mem, 'finding', r.finding_id, embedder, vec, r.message);
    indexed++;
  }
  return { indexed, total, skippedFresh: total - rows.length };
}
