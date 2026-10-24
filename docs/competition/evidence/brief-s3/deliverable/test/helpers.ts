import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/app.ts';
import { resetStore } from '../src/tasks/store.ts';

/** 一次测试服务句柄：真实 HTTP 监听在 127.0.0.1 的临时端口上。 */
export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** 发起请求时可用的最小选项集合。 */
export interface CallOptions {
  method: string;
  headers?: { [name: string]: string };
  body?: string;
}

/** 一次 HTTP 调用的解析结果。 */
export interface ApiResponse {
  status: number;
  contentType: string;
  text: string;
  body: unknown;
}

/**
 * 清空内存仓库，并在 127.0.0.1 的随机空闲端口启动真实 HTTP 服务。
 * 直接在进程内 listen（不 spawn 任何子进程），供各测试文件用 fetch 断言响应。
 */
export async function startTestServer(): Promise<TestServer> {
  resetStore();
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** 发起 HTTP 请求，并把响应体尽量解析为 JSON。 */
export async function callApi(url: string, options?: CallOptions): Promise<ApiResponse> {
  const response = await fetch(url, options);
  const text = await response.text();
  let body: unknown = undefined;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text,
    body,
  };
}

/** POST /api/tasks。 */
export function postTask(baseUrl: string, payload: unknown): Promise<ApiResponse> {
  return callApi(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** PATCH /api/tasks/{id}。 */
export function patchTask(baseUrl: string, id: string, payload: unknown): Promise<ApiResponse> {
  return callApi(`${baseUrl}/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** DELETE /api/tasks/{id}。 */
export function deleteTask(baseUrl: string, id: string): Promise<ApiResponse> {
  return callApi(`${baseUrl}/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 断言值是普通 JSON 对象并返回它。 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`期望 JSON 对象，实际得到：${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** 断言值是 JSON 数组并返回它。 */
export function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`期望 JSON 数组，实际得到：${JSON.stringify(value)}`);
  }
  return value;
}

/** 从任务对象里取出 id（断言为非空字符串）。 */
export function taskIdOf(value: unknown): string {
  const id = asRecord(value)['id'];
  if (typeof id !== 'string' || id === '') {
    throw new Error(`期望非空字符串 id，实际得到：${JSON.stringify(id)}`);
  }
  return id;
}
