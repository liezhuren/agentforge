/**
 * 契约覆盖校验：**契约必须声明任务图要用到的每一条路径**。
 *
 * ── 这条检查为什么必须存在（真实失败，2026-10-24）──────────────────
 *
 * `brief-s1` 与 `agentforge-project` 都是这样死的：PM 先写任务图，
 * 声明了 `/api/tasks`、`/api/tasks/{id}`；然后写契约，**只写了 `/health`**
 * （数据模型倒是写了 4–7 个）。两份工件各自都"合法"，但放在一起是矛盾的。
 *
 * 后果是 A7 每轮报 `phantom-contract-path`（任务声明了契约里没有的端点），
 * PM 返工重写契约，**又抽到一次塌缩** —— 连改 9 轮不动，最后带债收场。
 *
 * 而当时**没有任何机制能在生成时拦下它**：
 *   - `minProperties: 1` 只能拦"完全空的 paths"，拦不住"只有 /health"；
 *   - A7 能发现，但那是 Gate 之后，代价是一整轮返工 + 一次完整上下文。
 *
 * 所以把这条检查前移到**生成的 schema 校验之后**：用同一套「回喂错误 → 重试」
 * 机制（`buildRepairHint`）让 PM 当场补齐，而不是等 Gate 判罚。
 *
 * 刻意只查**一个方向**（任务图 → 契约）。反方向（契约声明了没人认领的路径）
 * 由 A7 的 `orphan-contract-path` 负责 —— 那里报错更合适，因为「多余的端点」
 * 未必是错的（可能是下一步要实现的）。
 */

import type { SchemaError } from '../../core/src/schema.ts';

/** 从契约内容里取路径集合。 */
export function contractPathsOf(contract: unknown): string[] {
  const paths = (contract as { openapi?: { paths?: Record<string, unknown> } } | null)?.openapi?.paths;
  if (!paths || typeof paths !== 'object') return [];
  return Object.keys(paths);
}

/** 从任务图内容里取「所有任务声明的契约路径」的并集。 */
export function taskGraphPathsOf(taskGraph: unknown): string[] {
  const tasks = (taskGraph as { tasks?: Array<{ contractPaths?: unknown }> } | null)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out = new Set<string>();
  for (const t of tasks) {
    const ps = t?.contractPaths;
    if (!Array.isArray(ps)) continue;
    for (const p of ps) {
      if (typeof p === 'string' && p.startsWith('/')) out.add(p);
    }
  }
  return [...out];
}

/**
 * 返回"任务图声明了、但契约没声明"的路径（按路径 -> 任务 id 归组，便于回喂时点名）。
 */
export function missingContractPaths(
  contract: unknown,
  taskGraph: unknown,
): Array<{ path: string; taskIds: string[] }> {
  const declared = new Set(contractPathsOf(contract));
  const tasks = (taskGraph as { tasks?: Array<{ id?: string; contractPaths?: unknown }> } | null)?.tasks;
  if (!Array.isArray(tasks)) return [];

  const missing = new Map<string, string[]>();
  for (const t of tasks) {
    const ps = t?.contractPaths;
    if (!Array.isArray(ps)) continue;
    for (const p of ps) {
      if (typeof p !== 'string' || !p.startsWith('/')) continue;
      if (declared.has(p)) continue;
      const list = missing.get(p) ?? [];
      if (typeof t.id === 'string') list.push(t.id);
      missing.set(p, list);
    }
  }
  return [...missing.entries()].map(([path, taskIds]) => ({ path, taskIds }));
}

/**
 * 把覆盖缺口转成**与 schema 错误同构**的错误，好让现成的 `buildRepairHint`
 * 直接回喂给模型 —— 不需要为这件事新增一条控制流。
 *
 * 没有任务图时返回空数组（无法交叉校验，不应阻塞生成）。
 */
export function contractCoverageErrors(contract: unknown, taskGraph: unknown): SchemaError[] {
  if (taskGraph === null || taskGraph === undefined) return [];
  const missing = missingContractPaths(contract, taskGraph);
  return missing.map(({ path, taskIds }) => ({
    path: '$.openapi.paths',
    keyword: 'contract-coverage',
    message:
      `任务图的任务 ${taskIds.join('/')} 声明了路径 ${JSON.stringify(path)}，但契约的 openapi.paths 里没有它。` +
      '契约必须声明任务要用到的每一条路径（否则实现与契约必然漂移）。' +
      '请补上这条路径（含它的 method 与 request/response 结构），不要删掉任务图里的声明。',
  }));
}
