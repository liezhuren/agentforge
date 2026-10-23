import type { ErrorResponse } from '../shared/contract-types.ts';

export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 500;

/**
 * 统一的 HTTP 业务错误：携带语义化状态码与错误消息。
 * 顶层处理器会把任何 HttpError 转成 { error: string } 的 JSON 响应。
 */
export class HttpError extends Error {
  readonly status: HttpStatus;

  constructor(status: HttpStatus, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }

  toResponse(): ErrorResponse {
    return { error: this.message };
  }
}

export function badRequest(message = '请求参数非法'): HttpError {
  return new HttpError(400, message);
}

export function unauthorized(message = '未认证：缺少或无效的身份凭证'): HttpError {
  return new HttpError(401, message);
}

export function forbidden(message = '无权限执行该操作'): HttpError {
  return new HttpError(403, message);
}

export function notFound(message = '资源不存在'): HttpError {
  return new HttpError(404, message);
}

export function conflict(message = '资源冲突'): HttpError {
  return new HttpError(409, message);
}

export function internalError(message = '服务器内部错误'): HttpError {
  return new HttpError(500, message);
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}

export interface ErrorPayload {
  status: number;
  body: ErrorResponse;
}

/** 把任意异常规整为 { status, body: { error } }，保证错误响应永远是合法 JSON。 */
export function toErrorResponse(error: unknown): ErrorPayload {
  if (error instanceof HttpError) {
    return { status: error.status, body: error.toResponse() };
  }
  const message = error instanceof Error && error.message.length > 0 ? error.message : '服务器内部错误';
  return { status: 500, body: { error: message } };
}
