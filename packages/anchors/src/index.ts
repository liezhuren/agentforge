/**
 * 锚点包入口：上下文构造 + 运行器 + 注册表。
 */

import { join } from 'node:path';
import type { AnchorId, AnchorRunResult, ArtifactStore, ProjectProfile } from '../../core/src/types.ts';
import { readTextOrNull, walkFiles } from '../../core/src/fsutil.ts';
import type { Logger } from '../../core/src/logger.ts';
import { silentLogger } from '../../core/src/logger.ts';
import { A1, A2, A3, A4, A5, A6, A7, A8, FACT_ANCHORS } from './fact.ts';
import { B1, B2, B3, SEMANTIC_ANCHORS } from './semantic.ts';
import type { Anchor, AnchorContext, SemanticProposals } from './types.ts';

export * from './types.ts';
export * from './imports.ts';
export * from './pkgresolve.ts';
export { A1, A2, A3, A4, A5, A6, A7, A8, B1, B2, B3, FACT_ANCHORS, SEMANTIC_ANCHORS };

export const ALL_ANCHORS: Anchor[] = [...FACT_ANCHORS, ...SEMANTIC_ANCHORS];

export const ANCHOR_INDEX: Map<AnchorId, Anchor> = new Map(ALL_ANCHORS.map((a) => [a.id, a]));

/** A 层锚点：决定「是否唤醒主理人」以及「机械归因」的关键。 */
export const A_LAYER_IDS: AnchorId[] = FACT_ANCHORS.map((a) => a.id);

export type CreateContextOptions = {
  projectRoot: string;
  store: ArtifactStore;
  profile: ProjectProfile;
  logger?: Logger;
  offline?: boolean;
  proposals?: SemanticProposals;
  /** 运行 ID 前缀，保证同一 run 内可复现。 */
  runPrefix?: string;
  /** 项目契约（验证基准）的当前状态，供 A8 检查。 */
  contract?: import('../../core/src/projectcontract.ts').ContractState;
  /** 锚点结果广播目标（前端只投影事件，不持有真相）。 */
  emit?: (event: ForgeEvent) => void;
};

export function createAnchorContext(opts: CreateContextOptions): AnchorContext {
  let fileCache: string[] | null = null;
  let counter = 0;
  const previous = new Map<AnchorId, AnchorRunResult>();

  const ctx: AnchorContext = {
    projectRoot: opts.projectRoot,
    store: opts.store,
    profile: opts.profile,
    logger: opts.logger ?? silentLogger('anchors'),
    offline: opts.offline ?? true,
    proposals: opts.proposals ?? {},
    previous,
    async sourceFiles() {
      if (fileCache) return fileCache;
      fileCache = await walkFiles(opts.projectRoot, {
        skipDirs: new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'artifacts', 'anchors']),
      });
      return fileCache;
    },
    async readFile(rel: string) {
      const safe = rel.replace(/\\/g, '/').replace(/^\.\//, '');
      if (safe.split('/').some((s) => s === '..')) return null;
      return readTextOrNull(join(opts.projectRoot, safe));
    },
    nextRunId() {
      counter++;
      return `${opts.runPrefix ?? 'run'}-${String(counter).padStart(3, '0')}`;
    },
    ...(opts.contract ? { contract: opts.contract } : {}),
    emit: opts.emit,
  };
  return ctx;
}

export type RunAnchorsOptions = {
  /** 只运行这些锚点。省略则运行全部。 */
  only?: AnchorId[];
  /** 只运行这一层。 */
  layer?: 'A' | 'B';
  /** 跳过 appliesTo 返回 false 的锚点。 */
  respectApplicability?: boolean;
};

/**
 * 运行锚点。
 *
 * 依赖通过 `requires` 声明：当依赖锚点已经 FAIL 时，下游锚点没有意义
 * （例如 A2 的符号核实依赖 A1 的包解析），此时下游报 SKIPPED 而不是伪造结论。
 */
export async function runAnchors(
  ctx: AnchorContext,
  anchors: Anchor[] = ALL_ANCHORS,
  opts: RunAnchorsOptions = {},
): Promise<AnchorRunResult[]> {
  const selected = anchors
    .filter((a) => (opts.layer ? a.layer === opts.layer : true))
    .filter((a) => (opts.only ? opts.only.includes(a.id) : true));

  const results: AnchorRunResult[] = [];

  for (const anchor of selected) {
    const started = Date.now();
    const runId = ctx.nextRunId();

    if (opts.respectApplicability && anchor.appliesTo) {
      const applies = await anchor.appliesTo(ctx);
      if (!applies) {
        const skipped: AnchorRunResult = {
          anchorId: anchor.id,
          runId,
          subjects: [],
          contentHashes: {},
          verdict: 'SKIPPED',
          findings: [
            { code: 'not-applicable', severity: 'warn', message: `${anchor.title} 在当前项目 profile 下不适用` },
          ],
          method: 'applicability-check',
          authority: 'none',
          at: new Date().toISOString(),
          durationMs: Date.now() - started,
        };
        results.push(skipped);
        ctx.previous.set(anchor.id, skipped);
        continue;
      }
    }

    let outcome;
    try {
      outcome = await anchor.run(ctx);
    } catch (err) {
      outcome = {
        verdict: 'FAIL' as const,
        findings: [
          {
            code: 'anchor-crashed',
            severity: 'fail' as const,
            message: `锚点 ${anchor.id} 执行异常：${(err as Error).message}`,
            targetRole: 'UNRESOLVED' as const,
          },
        ],
        method: 'error',
        authority: 'none' as const,
        subjects: [],
        contentHashes: {},
        error: (err as Error).stack ?? String(err),
      };
    }

    const result: AnchorRunResult = {
      anchorId: anchor.id,
      runId,
      subjects: outcome.subjects,
      contentHashes: outcome.contentHashes,
      verdict: outcome.verdict,
      findings: outcome.findings,
      method: outcome.method,
      authority: outcome.authority,
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...(outcome.meta ? { meta: outcome.meta } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };

    results.push(result);
    ctx.previous.set(anchor.id, result);
    await ctx.store.recordAnchorResult(result);
    ctx.emit?.({ t: 'anchor.ran', result });

    ctx.logger.info(`锚点 ${anchor.id} ${result.verdict}`, {
      findings: result.findings.length,
      method: result.method,
      authority: result.authority,
      durationMs: result.durationMs,
      ...(result.meta ?? {}),
    });
  }

  return results;
}

export function isHardFailure(r: AnchorRunResult): boolean {
  return r.verdict === 'FAIL' || r.verdict === 'INVALID_EVIDENCE';
}

/** 从锚点结果里提取机械归因，按角色汇总问题数。 */
export function attributionOf(results: AnchorRunResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity !== 'fail') continue;
      const k = f.targetRole ?? 'UNRESOLVED';
      out[k] = (out[k] ?? 0) + 1;
    }
  }
  return out;
}
