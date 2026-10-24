import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from './shared/contract-types.ts';

/** 允许缓冲的请求体上限（字节），避免无限制读取。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** 以 application/json 写出响应体（含 Content-Length）。 */
export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(payload, 'utf8')));
  res.end(payload);
}

/** 按契约 ErrorResponse 结构写出 JSON 错误响应。 */
export function sendError(res: ServerResponse, statusCode: number, message: string): void {
  const body: ErrorResponse = { error: message };
  sendJson(res, statusCode, body);
}

/** 请求体解析结果：成功时携带解析后的任意值，失败时携带可读原因。 */
export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/**
 * 读取并解析请求体为 JSON。
 * 空体、非法 JSON、超出长度上限、读取错误都返回 ok:false，由调用方决定状态码。
 */
export function readJsonBody(req: IncomingMessage): Promise<JsonBodyResult> {
  return new Promise<JsonBodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const settle = (result: JsonBodyResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle({ ok: false, message: '请求体过大' });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        settle({ ok: false, message: '请求体不能为空' });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        settle({ ok: true, value: parsed });
      } catch {
        settle({ ok: false, message: '请求体不是合法的 JSON' });
      }
    });

    req.on('error', () => {
      settle({ ok: false, message: '读取请求体失败' });
    });
  });
}
