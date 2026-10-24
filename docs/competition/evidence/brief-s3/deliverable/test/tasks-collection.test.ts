import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { resetStore } from '../src/tasks/store.ts';
import { asArray, asRecord, callApi, postTask, startTestServer } from './helpers.ts';
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

test('R-004/R-010：服务初始状态下 GET /api/tasks 返回 200 与空数组', async () => {
  const res = await callApi(`${server.baseUrl}/api/tasks`);
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/i);
  assert.deepEqual(asArray(res.body), []);
});

test('R-003/R-006：POST /api/tasks 合法请求返回 201 与完整任务对象', async () => {
  const res = await postTask(server.baseUrl, { title: '写代码' });
  assert.equal(res.status, 201);
  const task = asRecord(res.body);
  assert.equal(task['title'], '写代码');
  assert.equal(task['status'], 'todo');
  assert.equal(typeof task['id'], 'string');
  assert.notEqual(task['id'], '');
  assert.equal(typeof task['createdAt'], 'string');
  assert.ok(
    Number.isFinite(Date.parse(String(task['createdAt']))),
    `createdAt 不能被 Date.parse 解析：${String(task['createdAt'])}`,
  );
  assert.deepEqual(Object.keys(task).sort(), ['createdAt', 'id', 'status', 'title']);
});

test('R-003：连续创建的任务 id 不相等，显式传入的 status 被保留', async () => {
  const first = asRecord((await postTask(server.baseUrl, { title: '任务一' })).body);
  const second = asRecord((await postTask(server.baseUrl, { title: '任务二', status: 'doing' })).body);
  assert.notEqual(first['id'], undefined);
  assert.notEqual(second['id'], undefined);
  assert.notEqual(first['id'], second['id']);
  assert.equal(first['status'], 'todo');
  assert.equal(second['status'], 'doing');
});

test('R-004：连续创建 3 个任务后 GET /api/tasks 返回长度为 3 的数组', async () => {
  await postTask(server.baseUrl, { title: 't1' });
  await postTask(server.baseUrl, { title: 't2' });
  await postTask(server.baseUrl, { title: 't3' });

  const res = await callApi(`${server.baseUrl}/api/tasks`);
  assert.equal(res.status, 200);
  const tasks = asArray(res.body);
  assert.equal(tasks.length, 3);
  for (const item of tasks) {
    const task = asRecord(item);
    for (const field of ['id', 'title', 'status', 'createdAt']) {
      assert.ok(field in task, `任务缺少字段 ${field}：${JSON.stringify(task)}`);
    }
  }
});

test('R-005：GET /api/tasks?status=doing 只返回 doing 任务', async () => {
  await postTask(server.baseUrl, { title: '未开始' });
  const doingTask = asRecord((await postTask(server.baseUrl, { title: '进行中', status: 'doing' })).body);

  const res = await callApi(`${server.baseUrl}/api/tasks?status=doing`);
  assert.equal(res.status, 200);
  const tasks = asArray(res.body);
  assert.equal(tasks.length, 1);
  const only = asRecord(tasks[0]);
  assert.equal(only['status'], 'doing');
  assert.equal(only['id'], doingTask['id']);
});

test('R-005：GET /api/tasks?status=todo 返回的元素全部是 todo', async () => {
  await postTask(server.baseUrl, { title: 'a' });
  await postTask(server.baseUrl, { title: 'b' });
  await postTask(server.baseUrl, { title: 'c', status: 'done' });

  const res = await callApi(`${server.baseUrl}/api/tasks?status=todo`);
  assert.equal(res.status, 200);
  const tasks = asArray(res.body);
  assert.equal(tasks.length, 2);
  for (const item of tasks) {
    assert.equal(asRecord(item)['status'], 'todo');
  }
});

test('R-005：没有 done 任务时 GET /api/tasks?status=done 返回 200 与空数组', async () => {
  await postTask(server.baseUrl, { title: '只有 todo' });
  const res = await callApi(`${server.baseUrl}/api/tasks?status=done`);
  assert.equal(res.status, 200);
  assert.deepEqual(asArray(res.body), []);
});

test('R-006：title 缺失、空字符串或全空白时返回 400 且不新增任务', async () => {
  await postTask(server.baseUrl, { title: '既有任务' });
  const beforeTasks = asArray((await callApi(`${server.baseUrl}/api/tasks`)).body);

  const missing = await postTask(server.baseUrl, {});
  assert.equal(missing.status, 400);
  assert.equal(typeof asRecord(missing.body)['error'], 'string');

  const empty = await postTask(server.baseUrl, { title: '' });
  assert.equal(empty.status, 400);

  const blank = await postTask(server.baseUrl, { title: '   ' });
  assert.equal(blank.status, 400);

  const afterTasks = asArray((await callApi(`${server.baseUrl}/api/tasks`)).body);
  assert.equal(afterTasks.length, beforeTasks.length);
});

test('R-006：请求体不是合法 JSON 或为空时返回 400 且不新增任务', async () => {
  const invalid = await callApi(`${server.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'this-is-not-json',
  });
  assert.equal(invalid.status, 400);

  const emptyBody = await callApi(`${server.baseUrl}/api/tasks`, { method: 'POST' });
  assert.equal(emptyBody.status, 400);

  const listAfter = asArray((await callApi(`${server.baseUrl}/api/tasks`)).body);
  assert.deepEqual(listAfter, []);
});

test('R-003/R-006：POST 携带非法 status 返回 400 且不新增任务', async () => {
  const res = await postTask(server.baseUrl, { title: '非法状态', status: 'archived' });
  assert.equal(res.status, 400);
  const listAfter = asArray((await callApi(`${server.baseUrl}/api/tasks`)).body);
  assert.deepEqual(listAfter, []);
});
