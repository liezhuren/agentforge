import { DEFAULT_HOST, createServer, resolvePort } from './app.ts';

const port = resolvePort(process.env.PORT);
const host = DEFAULT_HOST;

const server = createServer();

server.on('error', (error: Error) => {
  console.error(`[task-board] 服务启动失败：${error.message}`);
  process.exit(1);
});

// 顶层直接调用 listen：入口文件被直接执行时自身启动服务，进程不会立即退出。
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
