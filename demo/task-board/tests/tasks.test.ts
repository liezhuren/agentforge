import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Task } from '../shared/contract/types.ts';
import { createApp } from '../src/api/server.ts';
import { resetStore } from '../src/api/store.ts';

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  resetStore();
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('R-001 创建任务：POST /api/tasks 返回 201 且带 id', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '写文档' }),
    });
    assert.equal(res.status, 201);
    const task = (await res.json()) as Task;
    assert.equal(task.title, '写文档');
    assert.ok(task.id.length > 0);
  });
});

test('R-002 列出任务：GET /api/tasks 返回 200 且包含已创建的任务', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'A' }),
    });
    const res = await fetch(`${base}/api/tasks`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Task[] };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]?.title, 'A');
  });
});

test('未知路径返回 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health-not-here`);
    assert.equal(res.status, 404);
  });
});
