import { createApp } from '../app.ts';

/**
 * 服务启动入口（`npm start` 实际执行的模块）。
 *
 * `npm start` 的脚本是 `node src/api/server.ts`，因此本文件必须在自己被直接执行时
 * 于顶层完成监听，进程才能保持存活；仅导出工厂函数而不调用 listen 会导致进程立刻退出。
 *
 * 服务的路由装配与统一错误处理都交给 ../app.ts 的 createApp()（它内部使用
 * createRequestHandler -> createRouter -> handleRequest），本文件只负责端口解析、
 * 监听与优雅退出，不重复实现任何业务逻辑。
 */

const DEFAULT_PORT = 8788;

/** 端口优先级：环境变量 PORT（合法时） > 契约约定的 8788。 */
function resolvePort(): number {
  const raw = process.env['PORT'];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_PORT;
  return parsed;
}

const port = resolvePort();
const server = createApp();

// 顶层监听：`node src/api/server.ts` 直接执行时服务真正起来并持续监听。
server.listen(port, () => {
  console.log(`[coffeebreak] listening on http://127.0.0.1:${port}`);
});

server.on('error', (error) => {
  console.error('[coffeebreak] server error:', error);
});

function shutdown(signal: string): void {
  console.log(`[coffeebreak] received ${signal}, shutting down`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { DEFAULT_PORT, port, server };
