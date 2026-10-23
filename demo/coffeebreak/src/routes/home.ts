import { Buffer } from 'node:buffer';
import type { ServerResponse } from 'node:http';
import type { Router } from '../http/router.ts';
import { renderHomePage } from '../web/page.ts';

/** 以 text/html 输出页面（R-016 要求 GET / 的 content-type 包含 text/html）。 */
function sendHtml(res: ServerResponse, status: number, html: string): void {
  const payload = Buffer.from(html, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', String(payload.byteLength));
  res.end(payload);
}

const registeredRouters = new WeakSet<Router>();

/**
 * 注册可演示 Web 界面（R-016）：
 *   GET /  公开（无需任何凭证），200 + text/html 单页应用
 * 页面内含注册/登录、论文列表与详情、评论讨论、好友与关注、首页推荐、论文管理等区块，
 * 并通过 fetch 调用本系统已声明的 /api 接口。
 * 同一 router 重复注册时幂等。
 */
export function registerHomeRoutes(router: Router): Router {
  if (registeredRouters.has(router)) return router;
  registeredRouters.add(router);

  router.get('/', ({ res }) => {
    sendHtml(res, 200, renderHomePage());
  });

  return router;
}
