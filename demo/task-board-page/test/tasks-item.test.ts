import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { resetStore } from '../src/tasks/store.ts';
import {
  asArray,
  asRecord,
  callApi,
  deleteTask,
  patchTask,
  postTask,
  startTestServer,
  taskIdOf,
} from './helpers.ts';
import type { TestServer } from './helpers.ts';

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  resetStore();
});

test('R-007：PATCH /api/tasks/{id} 把 status 改为 done 并写入内存存储', async () => {
  const id = taskIdOf((await postTask(server.baseUrl, { title: '要改状态的任务' })).body);

  const res = await patchTask(server.baseUrl, id, { status: 'done' });
  assert.equal(res.status, 200);
  const updated = asRecord(res.body);
  assert.equal(updated['id'], id);
  assert.equal(updated['status'], 'done');

  const tasks = asArray((await callApi(`${server.baseUrl}/api/tasks`)).body);
  const found = tasks.map((item) => asRecord(item)).find((task) => task['id'] === id);
  assert.ok(found, '更新后应能在任务列表中找回该任务');
  assert.equal(found['status'], 'done');
});

test('R-007：PATCH 支持把 status 改为 doing，并能被 ?status=doing 过滤命中', async () => {
  const id = taskIdOf((await postTask(server.baseUrl, { title: '改成 doing' })).body);

  const res = await patchTask(server.baseUrl, id, { status: 'doing' });
  assert.equal(res.status, 200);
  assert.equal(asRecord(res.body)['status'], 'doing');

  const filtered = asArray((await callApi(`${server.baseUrl}/api/tasks?status=doing`)).body);
  assert.equal(filtered.length, 1);
  assert.equal(asRecord(filtered[0])['id'], id);
});

test('R-007：PATCH 不存在的 id 返回 404 与可解析的 JSON 错误体', async () => {
  const res = await patchTask(server.baseUrl, 'no-such-task-id', { status: 'done' });
  assert.equal(res.status, 404);
  assert.equal(typeof asRecord(res.body)['error'], 'string');
});

test('R-007：PATCH 的 status 缺失或非法时返回 400 且不修改任务', async () => {
  const id = taskIdOf((await postTask(server.baseUrl, { title: '不可变' })).body);

  const missing = await patchTask(server.baseUrl, id, {});
  assert.equal(missing.status, 400);

  const invalid = await patchTask(server.baseUrl, id, { status: 'archived' });
  assert.equal(invalid.status, 400);

  const tasks = asArray((await callApi(`${server.baseUrl}/api/tasks`)).body);
  assert.equal(tasks.length, 1);
  assert.equal(asRecord(tasks[0])['status'], 'todo');
});

test('R-008：DELETE /api/tasks/{id} 成功删除且列表不再包含该 id', async () => {
  const id = taskIdOf((await postTask(server.baseUrl, { title: '待删除' })).body);
  await postTask(server.baseUrl, { title: '保留任务' });

  const res = await deleteTask(server.baseUrl, id);
  assert.ok(res.status >= 200 && res.status < 300, `期望 2xx，实际 ${res.status}`);
  assert.equal(asRecord(res.body)['id'], id);

  const tasks = asArray((await callApi(`${server.baseUrl}/api/tasks`)).body);
  assert.equal(tasks.length, 1);
  assert.ok(
    !tasks.map((item) => asRecord(item)).some((task) => task['id'] === id),
    '被删除的任务不应再出现在列表中',
  );
});

test('R-008：DELETE 不存在的 id 返回 404，重复删除第二次也返回 404', async () => {
  const missing = await deleteTask(server.baseUrl, 'missing-task-id');
  assert.equal(missing.status, 404);
  assert.equal(typeof asRecord(missing.body)['error'], 'string');

  const id = taskIdOf((await postTask(server.baseUrl, { title: '删两次' })).body);
  const first = await deleteTask(server.baseUrl, id);
  assert.equal(first.status, 200);
  const second = await deleteTask(server.baseUrl, id);
  assert.equal(second.status, 404);
});
