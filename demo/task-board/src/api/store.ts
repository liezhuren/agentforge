import type { Task } from '../../shared/contract/types.ts';

let sequence = 0;
const tasks: Task[] = [];

export function listTasks(): Task[] {
  return tasks.map((t) => ({ ...t }));
}

export function createTask(title: string): Task {
  sequence += 1;
  const task: Task = { id: `T-${String(sequence).padStart(3, "0")}`, title };
  tasks.push(task);
  return task;
}

export function resetStore(): void {
  tasks.length = 0;
  sequence = 0;
}
