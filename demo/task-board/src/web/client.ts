import type { Task } from '../../shared/contract/types.ts';

export type TaskListResponse = { items: Task[] };

export async function loadTasks(baseUrl = ""): Promise<Task[]> {
  const res = await fetch(`${baseUrl}/api/tasks`);
  if (!res.ok) throw new Error(`GET /api/tasks 失败：${res.status}`);
  const body = (await res.json()) as TaskListResponse;
  return body.items;
}

export async function addTask(title: string, baseUrl = ""): Promise<Task> {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`POST /api/tasks 失败：${res.status}`);
  return (await res.json()) as Task;
}
