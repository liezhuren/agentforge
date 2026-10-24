import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { HealthResponse } from './shared/contract-types.ts';
import { sendError, sendJson } from './http.ts';
import { handleTasksCollection } from './tasks/routes.ts';
import { handleTaskItem, TASK_ITEM_PREFIX } from './tasks/item-routes.ts';
import { sendIndexPage } from './web/page.ts';

export { sendError, sendJson } from './http.ts';

/** 默认监听端口，可用 PORT 环境变量覆盖。 */
export const DEFAULT_PORT = 8792;

/** 监听地址固定为回环地址 127.0.0.1。 */
export const DEFAULT_HOST = '127.0.0.1';

/** 解析 PORT 环境变量；缺省或非法值回退到 DEFAULT_PORT。 */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

/**
 * 路由处理入口。
 * 已实现：GET /（单页任务看板 HTML）、GET /health、GET /api/tasks、POST /api/tasks、
 * PATCH /api/tasks/{id}、DELETE /api/tasks/{id}；
 * 其余路径/方法统一返回契约 ErrorResponse 结构的 JSON 404。
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = (req.method ?? 'GET').toUpperCase();

  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? DEFAULT_HOST}`);
  } catch {
    sendError(res, 400, '无法解析的请求地址');
    return;
  }

  const pathname = url.pathname;

  if (pathname === '/' && method === 'GET') {
    sendIndexPage(res);
    return;
  }

  if (pathname === '/health' && method === 'GET') {
    const body: HealthResponse = { status: 'ok' };
    sendJson(res, 200, body);
    return;
  }

  if (pathname === '/api/tasks') {
    if (handleTasksCollection(req, res, url, method)) {
      return;
    }
    sendError(res, 404, `未找到资源：${method} ${pathname}`);
    return;
  }

  if (pathname.startsWith(TASK_ITEM_PREFIX)) {
    if (handleTaskItem(req, res, url, method)) {
      return;
    }
    sendError(res, 404, `未找到资源：${method} ${pathname}`);
    return;
  }

  sendError(res, 404, `未找到资源：${method} ${pathname}`);
}

/** 创建一个尚未开始监听的 HTTP 服务实例，供测试直接复用。 */
export function createServer(): Server {
  return createHttpServer(handleRequest);
}

/** createServer 的别名，便于以「应用工厂」命名调用。 */
export const createApp = createServer;

/** 创建服务并立即在 host:port 上监听。 */
export function startServer(port: number = DEFAULT_PORT, host: string = DEFAULT_HOST): Server {
  const server = createServer();
  server.listen(port, host);
  return server;
}
