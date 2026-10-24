import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Task, TaskStatus } from '../shared/contract-types.ts';
import { readJsonBody, sendError, sendJson } from '../http.ts';
import { deleteTask, isTaskStatus, updateTaskStatus } from './store.ts';

/** 契约中的单任务资源：PATCH /api/tasks/{id} 与 DELETE /api/tasks/{id}。 */
export const TASK_ITEM_PATH = '/api/tasks/{id}';

/** 单任务资源路径的冒号写法，供路由表与日志复用。 */
export const TASK_ITEM_PATH_COLON = '/api/tasks/:id';

/** 单任务资源前缀；parseTaskId 与 app.ts 的分支判断共用。 */
export const TASK_ITEM_PREFIX = '/api/tasks/';

/** 匹配 `/api/tasks/{id}` 形态的单任务路径（恰好一段非空 id，更深的路径视为未命中）。 */
export const TASK_ITEM_PATTERN = /^\/api\/tasks\/[^/]+$/;

/** 仅接受非数组的普通对象作为请求体。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把任意值收敛为契约 TaskStatus；不是合法状态时返回 null。 */
function toTaskStatus(value: unknown): TaskStatus | null {
  if (!isTaskStatus(value)) {
    return null;
  }
  return value as TaskStatus;
}

/** DELETE /api/tasks/{id}：存在则删除并返回被删对象（200），不存在返回 404。 */
function handleDeleteTask(res: ServerResponse, id: string): void {
  const removed: Task | undefined = deleteTask(id);
  if (removed === undefined) {
    sendError(res, 404, `任务不存在：${id}`);
    return;
  }
  sendJson(res, 200, removed);
}

/** PATCH /api/tasks/{id}：status 缺失/非法 → 400；id 不存在 → 404；成功 200 + 更新后的任务。 */
async function handleUpdateTask(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    sendError(res, 400, parsed.message);
    return;
  }
  if (!isPlainObject(parsed.value)) {
    sendError(res, 400, '请求体必须是 JSON 对象');
    return;
  }

  const status = toTaskStatus(parsed.value['status']);
  if (status === null) {
    sendError(res, 400, "status 必须是 'todo' | 'doing' | 'done' 之一");
    return;
  }

  const updated: Task | undefined = updateTaskStatus(id, status);
  if (updated === undefined) {
    sendError(res, 404, `任务不存在：${id}`);
    return;
  }
  sendJson(res, 200, updated);
}

/**
 * 从 URL pathname 中解析任务 id；不是合法的单任务路径时返回 null。
 * 只接受恰好一段的非空路径片段（`/api/tasks/{id}`）。
 */
export function parseTaskId(pathname: string): string | null {
  if (!TASK_ITEM_PATTERN.test(pathname)) {
    return null;
  }
  const raw = pathname.slice(TASK_ITEM_PREFIX.length);
  if (raw === '' || raw.includes('/')) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * 处理 /api/tasks/{id} 单任务资源。
 * 返回 true 表示已接管该请求（已写出响应）；false 表示路径不是单任务资源或方法不被支持，
 * 由调用方决定后续分支（统一 404）。
 */
export function handleTaskItem(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): boolean {
  const id = parseTaskId(url.pathname);
  if (id === null) {
    return false;
  }
  if (method === 'PATCH') {
    void handleUpdateTask(req, res, id).catch(() => {
      if (!res.writableEnded) {
        sendError(res, 500, '服务内部错误');
      }
    });
    return true;
  }
  if (method === 'DELETE') {
    handleDeleteTask(res, id);
    return true;
  }
  return false;
}
