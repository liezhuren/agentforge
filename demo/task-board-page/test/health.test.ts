import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DEFAULT_HOST, DEFAULT_PORT, resolvePort } from '../src/app.ts';
import { asRecord, callApi, startTestServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test('R-002：GET /health 返回 200、application/json 与 {status:"ok"}', async () => {
  const res = await callApi(`${server.baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/i);
  assert.deepEqual(asRecord(res.body), { status: 'ok' });
});

test('R-001：服务就绪后连续两次 GET /health 都返回 200（进程未在就绪前退出）', async () => {
  const first = await callApi(`${server.baseUrl}/health`);
  assert.equal(first.status, 200);
  const second = await callApi(`${server.baseUrl}/health`);
  assert.equal(second.status, 200);
  assert.ok(
    server.baseUrl.startsWith('http://127.0.0.1:'),
    `期望服务监听 127.0.0.1，实际为 ${server.baseUrl}`,
  );
});

test('R-001：默认监听 127.0.0.1:8792，PORT 环境变量可覆盖', () => {
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PORT, 8792);
  assert.equal(resolvePort(undefined), 8792);
  assert.equal(resolvePort(''), 8792);
  assert.equal(resolvePort('9100'), 9100);
  assert.equal(resolvePort('not-a-port'), 8792);
});

test('R-002：未命中路径返回 404 与可解析的 JSON 错误体', async () => {
  const res = await callApi(`${server.baseUrl}/definitely-not-a-route`);
  assert.equal(res.status, 404);
  assert.equal(typeof asRecord(res.body)['error'], 'string');
});
