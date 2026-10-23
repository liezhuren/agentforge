import type { Server } from 'node:http';
import { createApp } from './app.ts';

export const PORT = 8788;

export function createServer(): Server {
  return createApp();
}

/**
 * 启动 HTTP 服务。
 * host 未提供时使用 Node 的默认双栈绑定（同时接受 IPv4/IPv6）。
 */
export function startServer(port: number = PORT, host?: string): Server {
  const server = createApp();
  server.on('error', (error: Error) => {
    console.error(`[coffeebreak] HTTP 服务错误：${error.message}`);
  });
  const onListening = (): void => {
    const address = server.address();
    const shownPort = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`[coffeebreak] HTTP 服务已启动，监听端口 ${shownPort}（健康检查：http://127.0.0.1:${shownPort}/health）`);
  };
  if (typeof host === 'string' && host.length > 0) {
    server.listen(port, host, onListening);
  } else {
    server.listen(port, onListening);
  }
  return server;
}

export function stopServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isTestEntryPoint(entryPath: string): boolean {
  if (entryPath === '') return false;
  const normalized = entryPath.replace(/\\/g, '/');
  if (/\/(test|tests|__tests__)\//.test(normalized)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return true;
  if (/(^|\/)run-tests\.[cm]?[jt]s$/.test(normalized)) return true;
  return false;
}

// 入口文件被直接执行时在顶层启动监听（npm start）。
// 被测试文件 import 时不自动监听，避免测试进程被未关闭的监听句柄挂住。
const autoStartDisabled =
  process.env.COFFEEBREAK_NO_AUTOSTART === '1' || process.env.NODE_ENV === 'test';
const entryPath = process.argv[1] ?? '';

if (!autoStartDisabled && !isTestEntryPoint(entryPath)) {
  startServer();
}
