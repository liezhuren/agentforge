import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Task, TaskStatus } from '../shared/contract-types.ts';
import { readJsonBody, sendError, sendJson } from '../http.ts';
import { createTask, isTaskStatus, listTasks } from './store.ts';

/** 任务集合资源的路径。 */
export const TASKS_PATH = '/api/tasks';

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

/** GET /api/tasks[?status=]：返回全部任务，或按 status 精确过滤后的任务。 */
function handleListTasks(res: ServerResponse, url: URL): void {
  const status = url.searchParams.get('status');
  const result: Task[] = listTasks(status === null ? undefined : status);
  sendJson(res, 200, result);
}

/** POST /api/tasks：title 缺失/空白 → 400；合法请求返回 201 与新建任务。 */
async function handleCreateTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    sendError(res, 400, parsed.message);
    return;
  }
  if (!isPlainObject(parsed.value)) {
    sendError(res, 400, '请求体必须是 JSON 对象');
    return;
  }

  const rawTitle = parsed.value['title'];
  if (typeof rawTitle !== 'string' || rawTitle.trim() === '') {
    sendError(res, 400, 'title 必填且不能为空字符串');
    return;
  }
  const title = rawTitle.trim();

  let status: TaskStatus | undefined;
  const rawStatus: unknown = parsed.value['status'];
  if (rawStatus !== undefined) {
    const parsedStatus = toTaskStatus(rawStatus);
    if (parsedStatus === null) {
      sendError(res, 400, "status 必须是 'todo' | 'doing' | 'done' 之一");
      return;
    }
    status = parsedStatus;
  }

  const created: Task = status === undefined ? createTask({ title }) : createTask({ title, status });
  sendJson(res, 201, created);
}

/**
 * 处理 /api/tasks 集合资源。
 * 返回 true 表示已接管该请求（已写出响应）；false 表示方法不被支持，由调用方决定后续分支。
 */
export function handleTasksCollection(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): boolean {
  if (method === 'GET') {
    handleListTasks(res, url);
    return true;
  }
  if (method === 'POST') {
    void handleCreateTask(req, res).catch(() => {
      if (!res.writableEnded) {
        sendError(res, 500, '服务内部错误');
      }
    });
    return true;
  }
  return false;
}
