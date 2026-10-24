import { DEFAULT_HOST, createServer, resolvePort } from '../app.ts';

/**
 * 进程入口（`npm start` → `node src/api/server.ts`）。
 *
 * 这里只做一件事：把 src/app.ts 里已经实现了全部契约路由（GET /health、GET /、
 * GET/POST /api/tasks、PATCH/DELETE /api/tasks/{id}）的请求处理器真正挂到
 * 127.0.0.1:<port> 上监听，并在模块顶层直接调用 listen，
 * 使入口被直接执行时服务常驻、进程不会在就绪前退出。
 * 路由/存储/页面逻辑一律复用现有模块，不在此重复实现。
 */

/** 端口来自 PORT 环境变量，缺省为 app.ts 的 DEFAULT_PORT（8792）。 */
const port = resolvePort(process.env.PORT);

/** 监听地址固定为回环地址 127.0.0.1。 */
const host = DEFAULT_HOST;

const server = createServer();

server.on('error', (error: Error) => {
  console.error(`[task-board] 服务启动失败：${error.message}`);
  process.exit(1);
});

// 顶层直接 listen：入口文件被直接执行时自身启动服务，进程保持监听。
server.listen(port, host, () => {
  console.log(`[task-board] 服务已启动：http://${host}:${port}`);
});

function shutdown(): void {
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
