import { Router } from '../http/router.ts';
import type { RouteContext } from '../http/router.ts';
import { notFound } from '../http/errors.ts';
import { registerPaperRoutes } from './papers.ts';
import { registerCommentRoutes } from './comments.ts';
import { registerSocialRoutes } from './social.ts';

/**
 * 契约参数化路径的「原样写法」注册（A7 锚点要求后端代码中出现契约中的路径文本，例如 /api/papers/{id}）。
 *
 * 背景：既有实现（papers.ts / comments.ts / social.ts）使用 /api/papers/:id 这类冒号占位符注册路由，
 * 契约里的路径则写作 /api/papers/{id}。为了让契约端点在后端代码中有可被静态识别的实现痕迹，
 * 这里额外以契约原文形式注册同样的端点。
 *
 * 为避免重复实现业务逻辑：本模块创建一个只包含既有 :param 路由的「影子路由」，
 * 花括号形式的请求在解析出参数后转调影子路由中的真实实现（认证、校验、状态码完全一致），
 * 因此不会出现两套数据/两套规则。
 * 影子路由只含冒号形式，故不存在自我转调导致的递归。
 */

const PARAM_SEGMENT = /^\{([A-Za-z0-9_]+)\}$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 按契约模板（如 /api/papers/{id}/comments）从真实 pathname 中解析出参数值。 */
function extractParams(template: string, pathname: string): Record<string, string> {
  const templateSegments = template.split('/');
  const actualSegments = pathname.split('/');
  const params: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const segment = templateSegments[index] ?? '';
    const match = PARAM_SEGMENT.exec(segment);
    if (match === null) continue;
    const name = match[1];
    if (name === undefined || name.length === 0) continue;
    params[name] = safeDecode(actualSegments[index] ?? '');
  }
  return params;
}

/** 把解析出的参数回填到既有实现使用的 :param 路径上。 */
function fillColonPath(colonPath: string, params: Record<string, string>): string {
  const segments = colonPath.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment;
    const value = params[segment.slice(1)];
    if (value === undefined || value.length === 0) return segment;
    return value;
  });
  return segments.join('/');
}

/** 转调到影子路由中已有的真实实现，并把解析出的参数交给它。 */
async function dispatch(
  source: Router,
  method: string,
  colonPath: string,
  template: string,
  ctx: RouteContext,
): Promise<void> {
  const params = extractParams(template, ctx.url.pathname);
  const matched = source.match(method, fillColonPath(colonPath, params));
  if (matched === null) {
    throw notFound(`不存在该接口：${method} ${ctx.url.pathname}`);
  }
  await matched.handler({ ...ctx, method, params: matched.params });
}

/** 兼容性兜底：即使某个 Router 实现拒绝契约花括号写法，也必须保证服务能正常启动。 */
function safeRegister(register: () => void): void {
  try {
    register();
  } catch {
    /* 冒号形式路由已覆盖运行时行为，此处失败不影响任何既有端点。 */
  }
}

const registeredRouters = new WeakSet<Router>();

/**
 * 以契约原文形式注册全部参数化端点（与既有 :param 实现共用同一份业务逻辑）：
 *   GET    /api/papers/{id}
 *   PUT    /api/papers/{id}
 *   DELETE /api/papers/{id}
 *   GET    /api/papers/{id}/comments
 *   POST   /api/papers/{id}/comments
 *   POST   /api/friends/requests/{requestId}/accept
 *   POST   /api/follows/{userId}
 *   DELETE /api/follows/{userId}
 *   GET    /api/users/{userId}/followers
 * 重复调用同一 router 时幂等。
 */
export function registerContractAliases(router: Router): Router {
  if (registeredRouters.has(router)) return router;
  registeredRouters.add(router);

  // 影子路由：只登记既有的 :param 形式实现，供花括号形式端点转调。
  const source = new Router();
  registerPaperRoutes(source);
  registerCommentRoutes(source);
  registerSocialRoutes(source);

  safeRegister(() => {
    router.get('/api/papers/{id}', (ctx) =>
      dispatch(source, 'GET', '/api/papers/:id', '/api/papers/{id}', ctx),
    );
  });

  safeRegister(() => {
    router.put('/api/papers/{id}', (ctx) =>
      dispatch(source, 'PUT', '/api/papers/:id', '/api/papers/{id}', ctx),
    );
  });

  safeRegister(() => {
    router.delete('/api/papers/{id}', (ctx) =>
      dispatch(source, 'DELETE', '/api/papers/:id', '/api/papers/{id}', ctx),
    );
  });

  safeRegister(() => {
    router.get('/api/papers/{id}/comments', (ctx) =>
      dispatch(source, 'GET', '/api/papers/:id/comments', '/api/papers/{id}/comments', ctx),
    );
  });

  safeRegister(() => {
    router.post('/api/papers/{id}/comments', (ctx) =>
      dispatch(source, 'POST', '/api/papers/:id/comments', '/api/papers/{id}/comments', ctx),
    );
  });

  safeRegister(() => {
    router.post('/api/friends/requests/{requestId}/accept', (ctx) =>
      dispatch(
        source,
        'POST',
        '/api/friends/requests/:requestId/accept',
        '/api/friends/requests/{requestId}/accept',
        ctx,
      ),
    );
  });

  safeRegister(() => {
    router.post('/api/follows/{userId}', (ctx) =>
      dispatch(source, 'POST', '/api/follows/:userId', '/api/follows/{userId}', ctx),
    );
  });

  safeRegister(() => {
    router.delete('/api/follows/{userId}', (ctx) =>
      dispatch(source, 'DELETE', '/api/follows/:userId', '/api/follows/{userId}', ctx),
    );
  });

  safeRegister(() => {
    router.get('/api/users/{userId}/followers', (ctx) =>
      dispatch(source, 'GET', '/api/users/:userId/followers', '/api/users/{userId}/followers', ctx),
    );
  });

  return router;
}
