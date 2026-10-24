import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTestServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

let server: TestServer;
let html = '';
let status = 0;
let contentType = '';

before(async () => {
  server = await startTestServer();
  const response = await fetch(`${server.baseUrl}/`);
  status = response.status;
  contentType = response.headers.get('content-type') ?? '';
  html = await response.text();
});

after(async () => {
  await server.close();
});

test('R-009：GET / 返回 200 且 Content-Type 含 text/html', () => {
  assert.equal(status, 200);
  assert.match(contentType, /text\/html/i);
  assert.ok(html.length > 0, '响应体不应为空');
});

test('R-009：页面是完整 HTML 文档', () => {
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /<html[\s>]/i);
});

test('R-009：页面脚本通过 fetch 调用 /api/tasks 系列接口（含改状态与删除）', () => {
  assert.ok(html.includes('/api/tasks'), '页面应引用 /api/tasks');
  assert.ok(html.includes('fetch'), '页面应使用 fetch 调用接口');
  assert.ok(html.includes('POST'), '页面应用 POST 新建任务');
  assert.ok(html.includes('PATCH'), '页面应用 PATCH 修改任务状态');
  assert.ok(html.includes('DELETE'), '页面应用 DELETE 删除任务');
});

test('R-009：页面含新建任务的输入与按钮控件', () => {
  assert.ok(html.includes('<input'), '页面缺少 <input> 控件');
  assert.ok(html.includes('<button'), '页面缺少 <button> 控件');
});

test('R-009：页面不依赖第三方前端库或 CDN', () => {
  assert.ok(!html.includes('<script src="http'), '页面不应通过 http 外链脚本');
  assert.ok(!html.toLowerCase().includes('cdn'), '页面不应引用 CDN 资源');
  assert.ok(!/<script[^>]+src=/i.test(html), '页面不应包含任何 <script src> 外链');
});
