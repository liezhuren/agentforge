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
  CodeModule,
  EvidenceRef,
  ForgeEvent,
  ProjectProfile,
  RunId,
  RoleId,
  TestSuiteDoc,
} from '../../core/src/types.ts';
import type { Logger } from '../../core/src/logger.ts';
import type { ContractState } from '../../core/src/projectcontract.ts';

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
  /**
   * 项目契约（验证基准）的当前状态，由编排器注入。A8 检查它。
   *
   * 为 `undefined` 时 A8 报 SKIPPED —— 锚点包里拿不到基准，就绝不假装检查过。
   * 注意这里放的是**状态**而不是文件内容：文件本身已经被编排器按契约规整过了
   * （见 `core/src/projectcontract.ts`），所以 A8 要报的是「产出**尝试**改基准」这件事，
   * 而不是「基准现在是坏的」。
   */
  contract?: ContractState;
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

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * 机械归因：**优先按工件事实**，其次才按目录命名约定。
 *
 * ## 为什么必须有这个函数（真实 LLM 实测发现的缺陷，docs/07 §L10）
 *
 * 原来的归因只有 `attributeByPath` —— 一张写死的目录前缀表。
 * 实测后果很严重：模型把服务端写在 `src/server.ts`（完全合法的布局），
 * 而表里只有 `src/server/`（带斜杠，指目录）⇒ 一条都不匹配 ⇒ `UNRESOLVED`。
 *
 * 归因失败的连锁反应是致命的：
 *   派不出工单 ⇒ **没法打回给角色返工** ⇒ 只能召集圆桌 ⇒
 *   圆桌要开会、要产决议、要校验，成本高出几个数量级，而且经常得出 SHARED。
 *
 * 也就是说：**「系统为什么老是开圆桌」的真正原因，是归因器哑了。**
 * 打回（RETRY_ROLE）才是第一优先的手段，圆桌是归因不清时的兜底。
 *
 * 更糟的是那张表还会**给出错误答案**：模型把前端数据层写在 `src/api/tasks.ts`，
 * 按表 `src/api/` → backend（错的，那是 frontend 的工件）。
 *
 * 而归属关系本来就是**已知的确定性事实** —— 每个 `CodeModule` / `TestSuite` 工件
 * 都记录了 `producer` 与它包含的文件列表。按事实归因与目录命名无关，
 * 模型怎么摆文件布局都不影响。
 *
 * 三级策略（从强到弱）：
 *   ① 精确路径：某个工件声明了这个文件 ⇒ 该工件的 producer
 *   ② 声明目录：失败文件落在某个工件声明的目录下，且**只有一个**工件认领该目录
 *   ③ 命名约定：`DEFAULT_ATTRIBUTION` 兜底（工件还没产出时的退路）
 */
export function attributeByArtifact(ctx: AnchorContext, path: string): RoleId | 'UNRESOLVED' {
  const p = normPath(path);

  // ── 收集「工件事实」：路径 → 角色 ──────────────────────────────
  const declared: Array<{ path: string; role: RoleId }> = [];
  for (const a of ctx.store.heads('CodeModule')) {
    const files = (a.content as CodeModule | undefined)?.files ?? [];
    for (const f of files) {
      if (f?.path) declared.push({ path: normPath(f.path), role: a.producer as RoleId });
    }
  }
  for (const a of ctx.store.heads('TestSuite')) {
    const files = (a.content as TestSuiteDoc | undefined)?.files ?? [];
    for (const f of files) {
      if (f?.path) declared.push({ path: normPath(f.path), role: 'test' });
    }
  }

  // ① 精确匹配：最强、无歧义
  for (const d of declared) {
    if (d.path === p) return d.role;
  }

  // ② / ③ 按**具体度**（前缀长度）比较两种来源，谁更具体谁赢。
  //
  // 为什么不能简单地「先目录后命名」：一个声明了 `src/server.ts` 的模块，
  // 它的「声明目录」就是 `src/` —— 那等于让它认领整个 src/，
  // 会把 `src/web/unknown.ts` 这类明显属于前端的文件也抢走。
  // 反过来也不能「先命名后目录」：那样 `src/api/` 的命名规则会盖过
  // 工件事实里「frontend 声明了 src/api/tasks.ts」这件事。
  //
  // 比长度是两者的正确仲裁：`src/web/`（8）比 `src/`（4）更具体 ⇒ 命名胜；
  // `src/api/`（8）与工件声明的 `src/api/`（8）等长 ⇒ 同长度时**工件事实优先**。
  const byDir = new Map<string, Set<RoleId>>();
  for (const d of declared) {
    const i = d.path.lastIndexOf('/');
    if (i <= 0) continue; // 顶层文件没有目录，不参与目录级匹配
    const dir = d.path.slice(0, i + 1);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir)!.add(d.role);
  }

  let best: { role: RoleId; len: number; fromArtifact: boolean } | null = null;
  const consider = (role: RoleId, len: number, fromArtifact: boolean) => {
    if (!best || len > best.len || (len === best.len && fromArtifact && !best.fromArtifact)) {
      best = { role, len, fromArtifact };
    }
  };

  for (const [dir, owners] of byDir) {
    // 只在「该目录被唯一一个角色认领」时才用，避免乱归因
    if (owners.size === 1 && p.startsWith(dir)) consider([...owners][0], dir.length, true);
  }
  for (const r of DEFAULT_ATTRIBUTION) {
    if (p.startsWith(r.prefix)) consider(r.role, r.prefix.length, false);
  }

  return best ? (best as { role: RoleId }).role : 'UNRESOLVED';
}

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
