import { randomUUID } from 'node:crypto';
import type { Task, TaskStatus } from '../shared/contract-types.ts';

/** 任务状态的唯一事实来源：POST 校验、GET 过滤、PATCH 校验全部复用它。 */
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done'];

/** 进程内内存仓库（模块级单例），不写入任何持久化介质。 */
const tasks = new Map<string, Task>();

/** 判断任意值是否为合法的任务状态。 */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** 创建任务所需的输入。 */
export interface CreateTaskInput {
  title: string;
  status?: TaskStatus;
}

/**
 * 列出任务：status 为 undefined 时返回全部；否则按 status 精确匹配。
 * 非法 status 值自然匹配不到任何任务，返回空数组。
 */
export function listTasks(status?: string): Task[] {
  const all = Array.from(tasks.values());
  if (status === undefined) {
    return all;
  }
  return all.filter((task) => task.status === status);
}

/** 创建任务：id 唯一非空，createdAt 为 ISO 8601，status 缺省为 'todo'。 */
export function createTask(input: CreateTaskInput): Task {
  const task: Task = {
    id: randomUUID(),
    title: input.title,
    status: input.status ?? 'todo',
    createdAt: new Date().toISOString(),
  };
  tasks.set(task.id, task);
  return task;
}

/** 按 id 查询单个任务，不存在返回 undefined。 */
export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

/** 更新任务状态并返回更新后的对象，id 不存在返回 undefined。 */
export function updateTaskStatus(id: string, status: TaskStatus): Task | undefined {
  const existing = tasks.get(id);
  if (existing === undefined) {
    return undefined;
  }
  const updated: Task = { ...existing, status };
  tasks.set(id, updated);
  return updated;
}

/** 删除任务并返回被删除的对象，id 不存在返回 undefined。 */
export function deleteTask(id: string): Task | undefined {
  const existing = tasks.get(id);
  if (existing === undefined) {
    return undefined;
  }
  tasks.delete(id);
  return existing;
}

/** 清空内存仓库（仅测试使用）。 */
export function resetStore(): void {
  tasks.clear();
}
