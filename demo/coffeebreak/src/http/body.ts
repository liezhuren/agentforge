import type { IncomingMessage } from 'node:http';
import { badRequest } from './errors.ts';

export const MAX_BODY_BYTES = 1024 * 1024;

/** 判断请求是否真的带了请求体。 */
export function hasRequestBody(req: IncomingMessage): boolean {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string' && contentLength.trim() !== '' && Number(contentLength) > 0) {
    return true;
  }
  return typeof req.headers['transfer-encoding'] === 'string';
}

/** Content-Type 是否为 JSON（含 +json 后缀）。 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (typeof contentType !== 'string' || contentType.trim() === '') return false;
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mime === 'application/json' || mime.endsWith('+json');
}

/** 读取请求体原始字符串。 */
export function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error: Error) => {
      reject(error);
    });
  });
}

/**
 * 读取并解析 JSON 请求体。
 * 非 JSON Content-Type、空请求体、非法 JSON、非对象 JSON 一律抛出 400。
 */
export async function readJsonBody<T extends Record<string, unknown> = Record<string, unknown>>(
  req: IncomingMessage,
): Promise<T> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw badRequest('请求体必须为 JSON（Content-Type: application/json）');
  }
  const raw = await readRawBody(req);
  if (raw.trim() === '') {
    throw badRequest('请求体不能为空');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('请求体不是合法的 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('请求体必须为 JSON 对象');
  }
  return parsed as T;
}
