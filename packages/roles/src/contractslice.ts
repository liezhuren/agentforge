/**
 * 契约切片的**兜底**：前端任务永远拿到完整路径清单。
 *
 * ── 为什么需要这条兜底（真实失败，2026-10-24，deliv-break2）──────────────
 *
 * 那一轮是 22 条需求的茶歇系统。契约声明了 18 条路径（`/api/papers/{id}/comments`、
 * `/api/comments/{id}/replies`、`/api/follows/{userId}` …），但 PM 给前端任务
 * `T-012` 声明的切片只有一条：
 *
 *     contractPaths: ["/"]
 *
 * 切片的实现是忠实的 —— 于是前端**只看到 `/` 这一条路径**，其余端点它根本不知道
 * 长什么样，只能自己猜，写出了 `/api/comments`、`/api/follows`、`/api/users`。
 *
 * 于是 A7 每轮报 `undeclared-endpoint` ×3，而返工重跑时喂给它的**还是那一条切片** ——
 * 连改 8 轮也不可能对，最后 `0/22` 需求达成、22 条全部记债。
 *
 * 这就是 `docs/07` 里第 12 号坑（上下文饥饿）在**契约切片**这一层的重演：
 * 信息不是被截断悄悄丢掉的，而是被一个**看起来正确**的切片声明挡在外面。
 *
 * ── 为什么兜底放在引擎侧，而不是去改 PM ────────────────────────────
 *
 * 「页面要用哪些端点」在写页面之前只有 PM 能猜，猜漏是常态；而兜底的成本极低：
 * 摘要里多几条路径（实测整份 18 条路径的摘要约 2–3 千字符，预算 6 万）。
 * 把可靠性放在**不依赖上游正确**的地方，是这套系统一贯的做法。
 *
 * 刻意只处理 `scope === 'web'`：
 *   - 后端任务拿到的是「它要实现的那几个端点」，给全量反而分散注意力；
 *   - 前端任务的天职是**调用**已有端点，它必须知道全集。
 */

import { contractPathsOf } from './contractcoverage.ts';

export type ContractSlice = { paths?: string[]; schemas?: string[] };

export type SliceRequest = { scope?: string; contractSlice?: ContractSlice };

/**
 * 计算本次应当喂给角色的契约切片。
 *
 * - 非 web 任务：原样返回（不改变既有行为）
 * - web 任务：把「契约声明的全部路径」并进切片，去掉上游漏声明造成的信息饥饿
 * - 没有声明切片时：返回 undefined（调用方据此走「整份契约/整份摘要」，本来就是全量）
 */
export function effectiveContractSlice(req: SliceRequest, contractContent: unknown): ContractSlice | undefined {
  const declared = req.contractSlice;
  if (req.scope !== 'web') return declared;
  if (!declared) return undefined;

  const all = contractPathsOf(contractContent);
  if (all.length === 0) return declared; // 契约本身没路径：没有可并的东西

  const merged = [...new Set([...all, ...(declared.paths ?? [])])];
  if (merged.length === (declared.paths ?? []).length && merged.every((p, i) => p === declared.paths?.[i])) {
    return declared; // 已经一致，别制造无谓差异
  }
  return { ...(declared.schemas ? { schemas: declared.schemas } : {}), paths: merged };
}

/**
 * 给前端任务的一句硬约束 —— 直接对着 `undeclared-endpoint` 那类失败。
 *
 * 摘要里已经列了路径，但模型仍可能"顺手"发明一个更顺手的路径（它觉得 `/api/users`
 * 比 `/api/users/{id}/following` 自然）。这句话把话说死：清单之外的路径会被判失败。
 */
export const WEB_ENDPOINT_CONSTRAINT =
  '⚠️ 前端只能调用上面列出的路径。**不要自行发明端点路径** —— ' +
  'A7 会把「契约未声明的端点」判为失败（契约漂移），整轮返工。' +
  '拿不准某个操作该用哪条路径时，选清单里最接近的那条，而不是新建一条。\n';

/** 这条约束只对 web 任务有意义。 */
export function endpointConstraintFor(scope: string | undefined): string | null {
  return scope === 'web' ? WEB_ENDPOINT_CONSTRAINT : null;
}
