/**
 * 锚点框架。
 *
 * 核心不变量（docs/02-anchor-protocol.md）：
 *   任何「通过」的结论，都必须能追溯到一个不依赖 LLM 的事实。
 *
 * 因此本层的分工是刻意的：
 *   - A 层锚点：零 LLM，纯确定性检查。
 *   - B 层锚点：**自己也不调用 LLM**。LLM 的语义判定由 roles 层产出
 *     「提议（proposal）」，通过 AnchorContext.proposals 注入；
 *     B 层只负责**核验这些提议的证据是否真实存在**，并由程序给出最终 verdict。
 *
 * 这条结构约束让「LLM 永远是提议、不是裁判」不是一句口号，
 * 而是从依赖关系上就不可能违反：锚点包里根本拿不到 LLM 客户端。
 */

import type {
  AnchorFinding,
  AnchorId,
  AnchorLayer,
  AnchorRunResult,
  ArtifactKind,
  ArtifactStore,
  EvidenceRef,
  ForgeEvent,
  ProjectProfile,
  RunId,
  RoleId,
} from '../../core/src/types.ts';
import type { Logger } from '../../core/src/logger.ts';

// ── 语义提议（由 roles 层 / LLM 产出，锚点只核验不采信）────────────

export type RequirementVerdictProposal = {
  requirementId: string;
  verdict: 'met' | 'not-met' | 'uncertain';
  rationale: string;
  evidenceRefs: EvidenceRef[];
};

export type SemanticProposals = {
  /** 目标达成提议（B1）。 */
  requirementVerdicts?: RequirementVerdictProposal[];
  /** 需求覆盖提议（B2 的补充项，覆盖矩阵主体是机械计算的）。 */
  coverageClaims?: Array<{ requirementId: string; artifactIds: string[] }>;
  /** 主理人的锚定异议（B3 的证据核验对象）。 */
  objections?: Array<{ id: string; evidence: EvidenceRef[] }>;
};

// ── 锚点运行上下文 ────────────────────────────────────────────────

export type AnchorContext = {
  projectRoot: string;
  store: ArtifactStore;
  profile: ProjectProfile;
  logger: Logger;
  /** 离线模式：需要网络的检查必须报 SKIPPED，绝不报 PASS。 */
  offline: boolean;
  proposals: SemanticProposals;
  /** 本次 Gate 已跑过的锚点结果，供依赖引用。 */
  previous: Map<AnchorId, AnchorRunResult>;
  /** 源码文件清单（相对路径，POSIX 风格），惰性缓存。 */
  sourceFiles(): Promise<string[]>;
  readFile(rel: string): Promise<string | null>;
  /** 生成本次运行的唯一 ID（由编排器注入，保证可回放）。 */
  nextRunId(): RunId;
  /** 广播锚点结果。前端只需投影事件，不需要读磁盘。 */
  emit?: (event: ForgeEvent) => void;
};

export type AnchorOutcome = {
  verdict: AnchorRunResult['verdict'];
  findings: AnchorFinding[];
  method: string;
  authority: AnchorRunResult['authority'];
  subjects: string[];
  contentHashes: Record<string, string>;
  meta?: Record<string, unknown>;
  error?: string;
};

export type Anchor = {
  id: AnchorId;
  title: string;
  layer: AnchorLayer;
  /** 该锚点是否有意义（例如 profile 未配置测试命令时 A5 无意义）。 */
  appliesTo?(ctx: AnchorContext): Promise<boolean> | boolean;
  run(ctx: AnchorContext): Promise<AnchorOutcome>;
};

// ── 证据核验（B 层与机械裁判共用的确定性内核）─────────────────────

export type EvidenceVerifyResult = { ok: boolean; reason?: string };

/**
 * 核验一条证据是否真实存在。
 *
 * 这是整套防幻觉机制里最关键的一个函数：LLM 编造证据（引用不存在的文件、
 * 越界的行号、不存在的工件）在这里被结构性拦下，而不是靠「提示词要求它诚实」。
 */
export async function verifyEvidence(ref: EvidenceRef, ctx: AnchorContext): Promise<EvidenceVerifyResult> {
  if (ref.kind === 'file') {
    const text = await ctx.readFile(ref.path);
    if (text === null) return { ok: false, reason: `文件不存在：${ref.path}` };
    const lines = text.split(/\r?\n/);
    if (ref.startLine < 1 || ref.startLine > lines.length) {
      return { ok: false, reason: `起始行 ${ref.startLine} 越界（文件共 ${lines.length} 行）：${ref.path}` };
    }
    if (ref.endLine < ref.startLine) {
      return { ok: false, reason: `行区间非法：${ref.startLine}-${ref.endLine}` };
    }
    if (ref.endLine > lines.length) {
      return {
        ok: false,
        reason: `结束行 ${ref.endLine} 越界（文件共 ${lines.length} 行）：${ref.path}`,
      };
    }
    if (ref.expect) {
      const slice = lines.slice(ref.startLine - 1, ref.endLine).join('\n');
      if (!slice.includes(ref.expect)) {
        return {
          ok: false,
          reason: `引用的行区间未包含所声称的内容 ${JSON.stringify(ref.expect)}：${ref.path}:${ref.startLine}-${ref.endLine}`,
        };
      }
    }
    return { ok: true };
  }

  if (ref.kind === 'artifact') {
    const a = ctx.store.get(ref.artifactId);
    if (!a) return { ok: false, reason: `工件不存在:${ref.artifactId}` };
    return { ok: true };
  }

  const run = ctx.store.getAnchorRun(ref.runId);
  if (!run) return { ok: false, reason: `锚点运行记录不存在：${ref.runId}` };
  if (run.anchorId !== ref.anchorId) {
    return { ok: false, reason: `锚点 ID 与运行记录不符：声称 ${ref.anchorId}，实际 ${run.anchorId}` };
  }
  return { ok: true };
}

// ── 通用工具 ──────────────────────────────────────────────────────

/**
 * 机械归因：把文件路径映射到应负责的角色。
 * 这是「不打扰主理人」的关键 —— 编译器/类型检查器已经知道错在哪个文件，
 * 没必要让 LLM 再推断一遍归因（那正是它最容易甩锅或编造的地方）。
 */
export function attributeByPath(path: string, rules?: Array<{ prefix: string; role: RoleId }>): RoleId | 'UNRESOLVED' {
  const table = rules ?? DEFAULT_ATTRIBUTION;
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const r of table) {
    if (p.startsWith(r.prefix)) return r.role;
  }
  return 'UNRESOLVED';
}

export const DEFAULT_ATTRIBUTION: Array<{ prefix: string; role: RoleId }> = [
  { prefix: 'src/web/', role: 'frontend' },
  { prefix: 'web/', role: 'frontend' },
  { prefix: 'src/api/', role: 'backend' },
  { prefix: 'api/', role: 'backend' },
  { prefix: 'src/server/', role: 'backend' },
  { prefix: 'server/', role: 'backend' },
  { prefix: 'tests/', role: 'test' },
  { prefix: 'test/', role: 'test' },
  { prefix: 'shared/', role: 'pm' },
  { prefix: 'src/shared/', role: 'pm' },
];

export function worstVerdict(verdicts: Array<AnchorRunResult['verdict']>): AnchorRunResult['verdict'] {
  const rank: Record<AnchorRunResult['verdict'], number> = {
    FAIL: 5,
    INVALID_EVIDENCE: 4,
    STALE: 3,
    WARN: 2,
    SKIPPED: 1,
    PASS: 0,
  };
  let worst: AnchorRunResult['verdict'] = 'PASS';
  for (const v of verdicts) if (rank[v] > rank[worst]) worst = v;
  return worst;
}

/** Levenshtein 编辑距离（用于 typo-squatting 检测）。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

export type { ArtifactKind };
