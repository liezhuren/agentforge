import type { HealthStatus } from '../shared/contract-types.ts';
import type { Router } from '../http/router.ts';
import { sendJson } from '../http/respond.ts';
import { registerPaperRoutes } from './papers.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerCommentRoutes } from './comments.ts';
import { registerSocialRoutes } from './social.ts';
import { registerRecommendationRoutes } from './recommendations.ts';
import { registerHomeRoutes } from './home.ts';
import { registerContractAliases } from './contract-aliases.ts';

export const HEALTH_PAYLOAD: HealthStatus = { status: 'ok' };

const registeredRouters = new WeakSet<Router>();

/**
 * GET /health -> 200 { status: "ok" }
 *
 * 该函数是每个版本的 src/app.ts 都必然导入的稳定注册入口，因此论文、认证、评论、
 * 好友/关注、首页推荐、Web 首页以及契约原文形式端点也从这里挂载：
 * 即便 app.ts 被后续任务重写，只要仍提供 /health，其余端点就依然可用。
 * 各 register*Routes 对同一 router 幂等，重复挂载无副作用。
 */
export function registerHealthRoutes(router: Router): Router {
  if (registeredRouters.has(router)) return router;
  registeredRouters.add(router);

  router.get('/health', ({ res }) => {
    sendJson(res, 200, HEALTH_PAYLOAD);
  });
  registerPaperRoutes(router);
  registerAuthRoutes(router);
  registerCommentRoutes(router);
  registerSocialRoutes(router);
  registerRecommendationRoutes(router);
  registerHomeRoutes(router);
  // 放在既有 :param 路由之后注册，保证常规请求仍优先命中既有实现。
  registerContractAliases(router);
  return router;
}
