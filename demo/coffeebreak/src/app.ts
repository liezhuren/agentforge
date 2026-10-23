import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Router } from './http/router.ts';
import type { RouteContext } from './http/router.ts';
import { badRequest, notFound, toErrorResponse } from './http/errors.ts';
import { hasRequestBody, isJsonContentType } from './http/body.ts';
import { sendJson } from './http/respond.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCommentRoutes } from './routes/comments.ts';
import { registerSocialRoutes } from './routes/social.ts';
import { registerRecommendationRoutes } from './routes/recommendations.ts';
import { registerHomeRoutes } from './routes/home.ts';
import { registerContractAliases } from './routes/contract-aliases.ts';

/** 组装路由表；各 register*Routes 对同一 router 幂等，重复挂载无副作用。 */
export function createRouter(): Router {
  const router = new Router();
  registerHealthRoutes(router);
  registerAuthRoutes(router);
  registerCommentRoutes(router);
  registerSocialRoutes(router);
  registerRecommendationRoutes(router);
  registerHomeRoutes(router);
  registerContractAliases(router);
  return router;
}

/** 统一的请求处理入口：路由匹配 + 统一错误响应（{ error: string }）。 */
export async function handleRequest(router: Router, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const method = (req.method ?? 'GET').toUpperCase();
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);

    // 统一约定：带请求体的写请求必须是 JSON（R-002）。
    if (hasRequestBody(req) && !isJsonContentType(req.headers['content-type'])) {
      throw badRequest('请求体必须为 JSON（Content-Type: application/json）');
    }

    const matched = router.match(method, url.pathname);
    if (matched === null) {
      throw notFound(`不存在该接口：${method} ${url.pathname}`);
    }

    const context: RouteContext = {
      req,
      res,
      url,
      method,
      params: matched.params,
      query: url.searchParams,
    };
    await matched.handler(context);
  } catch (error) {
    const payload = toErrorResponse(error);
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, payload.status, payload.body);
  }
}

export function createRequestHandler(router: Router = createRouter()): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleRequest(router, req, res);
  };
}

/** 创建（但不监听）HTTP 服务实例。 */
export function createApp(): Server {
  return createHttpServer(createRequestHandler());
}
