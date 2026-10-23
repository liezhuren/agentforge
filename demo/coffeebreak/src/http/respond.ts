import type { ServerResponse } from 'node:http';

/** 发送 JSON 响应（content-type 固定为 application/json）。 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? null);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.end(body);
}

/** 发送 204 空响应（DELETE 等无响应体的成功场景）。 */
export function sendNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.removeHeader('Content-Type');
  res.end();
}
