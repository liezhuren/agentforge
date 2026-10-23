import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRequestHandler } from '../src/app.ts';
import { SEED_ADMIN_PASSWORD, SEED_ADMIN_USERNAME } from '../src/store/store.ts';

/** 任务书要求的 18 个论文属性字段名（与 R-003 逐字对应）。 */
const PAPER_FIELDS_18: readonly string[] = [
  'title',
  'paperType',
  'publishedAt',
  'publication',
  'conferenceName',
  'conferenceAddress',
  'venueLevel',
  'indexCategory',
  'eiNumber',
  'doi',
  'issn',
  'cnNumber',
  'affiliation',
  'moeCategory',
  'schoolRanking',
  'publishScope',
  'volumeIssue',
  'projectSource',
];

const PAPER_OPTIONAL_FIELDS: readonly string[] = PAPER_FIELDS_18.filter((field) => field !== 'title');

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

let server: Server | undefined;
let port = 0;

interface ApiResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

interface RequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

/** 直接对一个真实监听的本地端口发起 HTTP 请求（不使用 fetch，也不 spawn 任何子进程）。 */
function apiRequest(path: string, options: RequestOptions = {}): Promise<ApiResponse> {
  return new Promise<ApiResponse>((resolve, reject) => {
    const headers: Record<string, string> = {};
    let payload: Buffer | undefined;
    if (options.rawBody !== undefined) {
      payload = Buffer.from(options.rawBody, 'utf8');
      headers['Content-Type'] = options.contentType ?? 'text/plain';
    } else if (options.body !== undefined) {
      payload = Buffer.from(JSON.stringify(options.body), 'utf8');
      headers['Content-Type'] = 'application/json';
    }
    if (payload !== undefined) headers['Content-Length'] = String(payload.byteLength);
    if (options.token !== undefined && options.token.length > 0) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          if (text.length > 0) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`期望 JSON 对象，实际为 ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`期望 JSON 数组，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

function asNonEmptyString(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} 应为字符串`);
  assert.ok((value as string).length > 0, `${label} 不应为空字符串`);
  return value as string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let uniqueCounter = 0;

function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${RUN_ID}_${uniqueCounter}`;
}

interface TestUser {
  username: string;
  password: string;
  userId: string;
}

async function registerUser(prefix = 'user'): Promise<TestUser> {
  const username = uniqueName(prefix);
  const password = 'secret_pw_42';
  const res = await apiRequest('/api/auth/register', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 201, `注册应返回 201，实际 ${res.status}，响应：${res.text}`);
  const userId = asNonEmptyString(asRecord(res.json).userId, 'userId');
  return { username, password, userId };
}

async function loginToken(user: TestUser): Promise<string> {
  const res = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { username: user.username, password: user.password },
  });
  assert.equal(res.status, 200, `登录应返回 200，实际 ${res.status}，响应：${res.text}`);
  return asNonEmptyString(asRecord(res.json).token, 'token');
}

let adminTokenCache: string | null = null;

async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const res = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { username: SEED_ADMIN_USERNAME, password: SEED_ADMIN_PASSWORD },
  });
  assert.equal(
    res.status,
    200,
    `种子管理员 ${SEED_ADMIN_USERNAME} 登录失败（HTTP ${res.status}），无法验证管理员能力：${res.text}`,
  );
  adminTokenCache = asNonEmptyString(asRecord(res.json).token, 'admin token');
  return adminTokenCache;
}

async function createPaper(token: string, body: Record<string, unknown>): Promise<string> {
  const res = await apiRequest('/api/papers', { method: 'POST', token, body });
  assert.equal(res.status, 201, `创建论文应返回 201，实际 ${res.status}，响应：${res.text}`);
  return asNonEmptyString(asRecord(res.json).id, 'paper id');
}

async function getPaper(id: string): Promise<Record<string, unknown>> {
  const res = await apiRequest(`/api/papers/${encodeURIComponent(id)}`);
  assert.equal(res.status, 200, `读取论文 ${id} 应返回 200，实际 ${res.status}，响应：${res.text}`);
  return asRecord(res.json);
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const collected: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      collected.push(full);
    }
  }
  return collected;
}

before(async () => {
  const handler = createRequestHandler();
  const created = createHttpServer(handler);
  await new Promise<void>((resolve, reject) => {
    created.once('error', reject);
    created.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = created.address();
  assert.ok(address !== null && typeof address === 'object', '测试服务器应返回端口信息');
  port = (address as AddressInfo).port;
  server = created;
});

after(async () => {
  const current = server;
  if (current === undefined) return;
  await new Promise<void>((resolve) => {
    current.close(() => {
      resolve();
    });
  });
});

test('R-001 GET /health 返回 2xx、application/json 且 status 为 ok（连续两次请求仍成功）', async () => {
  const first = await apiRequest('/health');
  assert.ok(first.status >= 200 && first.status <= 299, `首次健康检查状态码应在 2xx，实际 ${first.status}`);
  const contentType = String(first.headers['content-type'] ?? '');
  assert.ok(
    contentType.includes('application/json'),
    `健康检查 content-type 应包含 application/json，实际：${contentType}`,
  );
  assert.equal(asRecord(first.json).status, 'ok');

  await delay(50);
  const second = await apiRequest('/health');
  assert.ok(second.status >= 200 && second.status <= 299, `再次健康检查状态码应在 2xx，实际 ${second.status}`);
  assert.equal(asRecord(second.json).status, 'ok');
});

test('R-002 错误响应体为 { error: string } 且状态码语义化（404 / 401 / 400）', async () => {
  const missing = await apiRequest('/api/papers/__not_exist__');
  assert.equal(missing.status, 404, `读取不存在的论文应返回 404，实际 ${missing.status}`);
  assert.equal(typeof asRecord(missing.json).error, 'string');

  const anonymous = await apiRequest('/api/papers', { method: 'POST', body: { title: '未认证创建' } });
  assert.equal(anonymous.status, 401, `未携带凭证创建论文应返回 401，实际 ${anonymous.status}`);
  assert.equal(typeof asRecord(anonymous.json).error, 'string');

  const token = await adminToken();
  const notJson = await apiRequest('/api/papers', { method: 'POST', token, rawBody: 'x', contentType: 'text/plain' });
  assert.equal(notJson.status, 400, `非 JSON 请求体应返回 400，实际 ${notJson.status}，响应：${notJson.text}`);
  assert.equal(typeof asRecord(notJson.json).error, 'string');
});

test('R-003 一篇填满 18 个字段的论文写入后可按字段原样读回', async () => {
  const token = await adminToken();
  const input: Record<string, string> = {
    title: uniqueName('全字段论文'),
    paperType: '期刊论文',
    publishedAt: '2024-03-01',
    publication: '计算机学报',
    conferenceName: '中国计算机大会',
    conferenceAddress: '北京国家会议中心',
    venueLevel: 'A 类',
    indexCategory: 'EI 收录',
    eiNumber: 'EI2024001',
    doi: '10.1000/full-field',
    issn: '1000-1239',
    cnNumber: 'CN11-1234/TP',
    affiliation: '示例大学计算机学院',
    moeCategory: '工学',
    schoolRanking: '前 10',
    publishScope: '国内外公开发行',
    volumeIssue: '2024 年第 3 期',
    projectSource: '国家自然科学基金',
  };
  const id = await createPaper(token, input);
  const paper = await getPaper(id);
  for (const field of PAPER_FIELDS_18) {
    assert.ok(Object.prototype.hasOwnProperty.call(paper, field), `论文对象应包含字段 ${field}`);
  }
  for (const [key, expected] of Object.entries(input)) {
    assert.equal(paper[key], expected, `字段 ${key} 读回值应与写入值一致`);
  }
});

test('R-003 仅传 title 时其余 17 个字段存在且为空字符串', async () => {
  const token = await adminToken();
  const title = uniqueName('最简论文');
  const id = await createPaper(token, { title });
  const paper = await getPaper(id);
  assert.equal(paper.title, title);
  for (const field of PAPER_OPTIONAL_FIELDS) {
    assert.equal(typeof paper[field], 'string', `字段 ${field} 应为字符串`);
    assert.equal(paper[field], '', `字段 ${field} 应为空字符串`);
  }
});

test('R-003 缺失 title 的创建请求返回 400', async () => {
  const token = await adminToken();
  const res = await apiRequest('/api/papers', { method: 'POST', token, body: { paperType: '期刊论文' } });
  assert.equal(res.status, 400, `缺失 title 应返回 400，实际 ${res.status}，响应：${res.text}`);
  assert.equal(typeof asRecord(res.json).error, 'string');
});

test('R-004 管理员创建论文返回 201 与 id，详情一致且列表长度 +1', async () => {
  const token = await adminToken();
  const beforeList = asArray((await apiRequest('/api/papers')).json);
  const title = uniqueName('管理员上传论文');
  const id = await createPaper(token, { title, doi: '10.1000/r004' });
  assert.ok(id.length > 0, '创建论文应返回非空 id');
  const paper = await getPaper(id);
  assert.equal(paper.title, title);
  const afterList = asArray((await apiRequest('/api/papers')).json);
  assert.equal(afterList.length, beforeList.length + 1, '创建后论文列表长度应恰好 +1');
  assert.ok(
    afterList.map((item) => asRecord(item)).some((item) => item.id === id),
    '创建后论文列表应包含该 id',
  );
});

test('R-005 管理员编辑论文生效并落库，编辑不存在的论文返回 404', async () => {
  const token = await adminToken();
  const id = await createPaper(token, { title: uniqueName('待编辑论文') });
  const put = await apiRequest(`/api/papers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    token,
    body: { doi: '10.1000/xyz' },
  });
  assert.equal(put.status, 200, `编辑论文应返回 200，实际 ${put.status}，响应：${put.text}`);
  assert.equal(asRecord(put.json).doi, '10.1000/xyz');
  const paper = await getPaper(id);
  assert.equal(paper.doi, '10.1000/xyz');
  const missing = await apiRequest('/api/papers/__not_exist__', {
    method: 'PUT',
    token,
    body: { doi: '10.1000/none' },
  });
  assert.equal(missing.status, 404, `编辑不存在的论文应返回 404，实际 ${missing.status}`);
});

test('R-006 管理员删除论文返回 204，之后详情 404 且列表不含该 id；删除不存在返回 404', async () => {
  const token = await adminToken();
  const id = await createPaper(token, { title: uniqueName('待删除论文') });
  const del = await apiRequest(`/api/papers/${encodeURIComponent(id)}`, { method: 'DELETE', token });
  assert.equal(del.status, 204, `删除论文应返回 204，实际 ${del.status}，响应：${del.text}`);
  const after = await apiRequest(`/api/papers/${encodeURIComponent(id)}`);
  assert.equal(after.status, 404, `删除后详情应返回 404，实际 ${after.status}`);
  const list = asArray((await apiRequest('/api/papers')).json).map((item) => asRecord(item));
  assert.ok(!list.some((item) => item.id === id), '删除后论文列表不应包含该 id');
  const missing = await apiRequest('/api/papers/__not_exist__', { method: 'DELETE', token });
  assert.equal(missing.status, 404, `删除不存在的论文应返回 404，实际 ${missing.status}`);
});

test('R-007 注册返回 201 与 userId，重复用户名 409，缺密码 400，响应不含明文密码', async () => {
  const username = uniqueName('reg');
  const password = 'secret_pw_42';
  const res = await apiRequest('/api/auth/register', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 201, `注册应返回 201，实际 ${res.status}，响应：${res.text}`);
  const body = asRecord(res.json);
  asNonEmptyString(body.userId, 'userId');
  assert.ok(!Object.prototype.hasOwnProperty.call(body, 'password'), '注册响应体不应包含 password 字段');
  assert.ok(!res.text.includes(password), '注册响应体不应出现明文密码');

  const duplicate = await apiRequest('/api/auth/register', { method: 'POST', body: { username, password } });
  assert.equal(duplicate.status, 409, `重复用户名注册应返回 409，实际 ${duplicate.status}`);

  const missingPassword = await apiRequest('/api/auth/register', {
    method: 'POST',
    body: { username: uniqueName('nopwd') },
  });
  assert.equal(missingPassword.status, 400, `缺少 password 应返回 400，实际 ${missingPassword.status}`);
});

test('R-008 登录返回 token，Bearer 凭证可访问 /api/me；缺凭证 401；错误密码 401', async () => {
  const user = await registerUser('login');
  const token = await loginToken(user);
  const me = await apiRequest('/api/me', { token });
  assert.equal(me.status, 200, `携带凭证访问 /api/me 应返回 200，实际 ${me.status}`);
  assert.equal(asRecord(me.json).userId, user.userId);
  const anonymous = await apiRequest('/api/me');
  assert.equal(anonymous.status, 401, `不带凭证访问 /api/me 应返回 401，实际 ${anonymous.status}`);
  const wrong = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { username: user.username, password: 'wrong_password_xyz' },
  });
  assert.equal(wrong.status, 401, `错误密码登录应返回 401，实际 ${wrong.status}`);
});

test('R-009 免登录浏览论文列表与详情，不存在的 id 返回 404', async () => {
  const token = await adminToken();
  const id = await createPaper(token, { title: uniqueName('公开浏览论文') });
  const listRes = await apiRequest('/api/papers');
  assert.equal(listRes.status, 200, `不带凭证获取论文列表应返回 200，实际 ${listRes.status}`);
  const list = asArray(listRes.json);
  assert.ok(list.length > 0, '论文列表应为非空数组');
  const paper = await getPaper(id);
  for (const field of PAPER_FIELDS_18) {
    assert.ok(Object.prototype.hasOwnProperty.call(paper, field), `详情应包含 18 个属性中的 ${field}`);
  }
  const missing = await apiRequest('/api/papers/__not_exist__');
  assert.equal(missing.status, 404);
});

test('R-010 登录用户可对论文发表评论并列出；未登录 401；论文不存在 404；空内容 400', async () => {
  const admin = await adminToken();
  const paperId = await createPaper(admin, { title: uniqueName('评论论文') });
  const user = await registerUser('commenter');
  const token = await loginToken(user);
  const commentsPath = `/api/papers/${encodeURIComponent(paperId)}/comments`;

  const created = await apiRequest(commentsPath, { method: 'POST', token, body: { content: '很有启发' } });
  assert.equal(created.status, 201, `发表评论应返回 201，实际 ${created.status}，响应：${created.text}`);
  const commentId = asNonEmptyString(asRecord(created.json).id, 'comment id');

  const listRes = await apiRequest(commentsPath);
  assert.equal(listRes.status, 200);
  const list = asArray(listRes.json).map((item) => asRecord(item));
  const found = list.find((item) => item.id === commentId);
  assert.ok(found, '评论列表应包含刚创建的评论');
  assert.equal(found.content, '很有启发');
  assert.equal(found.userId, user.userId);

  const anonymous = await apiRequest(commentsPath, { method: 'POST', body: { content: '未登录评论' } });
  assert.equal(anonymous.status, 401, `不带 token 发表评论应返回 401，实际 ${anonymous.status}`);

  const missingPaper = await apiRequest('/api/papers/__not_exist__/comments', {
    method: 'POST',
    token,
    body: { content: '论文不存在' },
  });
  assert.equal(missingPaper.status, 404, `对不存在的论文发表评论应返回 404，实际 ${missingPaper.status}`);

  const emptyContent = await apiRequest(commentsPath, { method: 'POST', token, body: { content: '' } });
  assert.equal(emptyContent.status, 400, `空内容评论应返回 400，实际 ${emptyContent.status}`);
});

test('R-011 支持对评论的回复（parentCommentId），不存在的父评论返回 404', async () => {
  const admin = await adminToken();
  const paperId = await createPaper(admin, { title: uniqueName('回复论文') });
  const commentsPath = `/api/papers/${encodeURIComponent(paperId)}/comments`;

  const authorA = await registerUser('authorA');
  const tokenA = await loginToken(authorA);
  const authorB = await registerUser('authorB');
  const tokenB = await loginToken(authorB);

  const parentRes = await apiRequest(commentsPath, { method: 'POST', token: tokenA, body: { content: '父评论' } });
  assert.equal(parentRes.status, 201);
  const parentId = asNonEmptyString(asRecord(parentRes.json).id, 'parentId');

  const replyRes = await apiRequest(commentsPath, {
    method: 'POST',
    token: tokenB,
    body: { content: '补充一点', parentCommentId: parentId },
  });
  assert.equal(replyRes.status, 201, `回复评论应返回 201，实际 ${replyRes.status}，响应：${replyRes.text}`);
  const replyId = asNonEmptyString(asRecord(replyRes.json).id, 'replyId');

  const list = asArray((await apiRequest(commentsPath)).json).map((item) => asRecord(item));
  for (const comment of list) {
    for (const field of ['id', 'parentCommentId', 'userId', 'content']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(comment, field),
        `每条评论都应包含字段 ${field}，实际 ${JSON.stringify(comment)}`,
      );
    }
  }

  const reply = list.find((item) => item.id === replyId);
  assert.ok(reply, '评论列表中应存在该回复');
  assert.equal(reply.parentCommentId, parentId);
  assert.equal(reply.userId, authorB.userId);

  const topLevel = list.find((item) => item.id === parentId);
  assert.ok(topLevel, '评论列表中应存在父评论');
  assert.equal(topLevel.parentCommentId, null);

  const badParent = await apiRequest(commentsPath, {
    method: 'POST',
    token: tokenB,
    body: { content: '孤儿回复', parentCommentId: '__not_exist__' },
  });
  assert.equal(badParent.status, 404, `不存在的父评论应返回 404，实际 ${badParent.status}`);
});

test('R-012 好友请求与接受：接受前不算好友，接受后双方互为好友', async () => {
  const userA = await registerUser('friendA');
  const tokenA = await loginToken(userA);
  const userB = await registerUser('friendB');
  const tokenB = await loginToken(userB);

  const requestRes = await apiRequest('/api/friends/requests', {
    method: 'POST',
    token: tokenA,
    body: { toUserId: userB.userId },
  });
  assert.equal(requestRes.status, 201, `发送好友请求应返回 201，实际 ${requestRes.status}，响应：${requestRes.text}`);
  const requestBody = asRecord(requestRes.json);
  const requestId = asNonEmptyString(requestBody.requestId ?? requestBody.id, 'requestId');

  const pending = await apiRequest('/api/friends/requests', { token: tokenB });
  assert.equal(pending.status, 200);
  assert.ok(
    asArray(pending.json)
      .map((item) => asRecord(item))
      .some((item) => item.requestId === requestId),
    'B 的待处理好友请求中应包含该 requestId',
  );

  const friendsBefore = asArray((await apiRequest('/api/friends', { token: tokenA })).json);
  assert.ok(!friendsBefore.includes(userB.userId), '接受前 A 的好友列表中不应包含 B');

  const accept = await apiRequest(`/api/friends/requests/${encodeURIComponent(requestId)}/accept`, {
    method: 'POST',
    token: tokenB,
  });
  assert.equal(accept.status, 200, `接受好友请求应返回 200，实际 ${accept.status}，响应：${accept.text}`);

  const friendsA = asArray((await apiRequest('/api/friends', { token: tokenA })).json);
  const friendsB = asArray((await apiRequest('/api/friends', { token: tokenB })).json);
  assert.ok(friendsA.includes(userB.userId), '接受后 A 的好友列表应包含 B');
  assert.ok(friendsB.includes(userA.userId), '接受后 B 的好友列表应包含 A');

  const selfRequest = await apiRequest('/api/friends/requests', {
    method: 'POST',
    token: tokenA,
    body: { toUserId: userA.userId },
  });
  assert.equal(selfRequest.status, 400, `对自己发好友请求应返回 400，实际 ${selfRequest.status}`);
  const missingTarget = await apiRequest('/api/friends/requests', {
    method: 'POST',
    token: tokenA,
    body: { toUserId: '__not_exist__' },
  });
  assert.equal(missingTarget.status, 404, `对不存在用户发好友请求应返回 404，实际 ${missingTarget.status}`);
});

test('R-013 关注 / 取消关注 / 关注者列表 / 自我关注与不存在用户', async () => {
  const userA = await registerUser('followA');
  const tokenA = await loginToken(userA);
  const userB = await registerUser('followB');

  const follow = await apiRequest(`/api/follows/${encodeURIComponent(userB.userId)}`, {
    method: 'POST',
    token: tokenA,
  });
  assert.ok([200, 204].includes(follow.status), `关注应返回 200 或 204，实际 ${follow.status}`);

  const followers = await apiRequest(`/api/users/${encodeURIComponent(userB.userId)}/followers`);
  assert.equal(followers.status, 200);
  assert.ok(asArray(followers.json).includes(userA.userId), 'B 的关注者列表应包含 A');

  const unfollow = await apiRequest(`/api/follows/${encodeURIComponent(userB.userId)}`, {
    method: 'DELETE',
    token: tokenA,
  });
  assert.ok([200, 204].includes(unfollow.status), `取消关注应返回 200 或 204，实际 ${unfollow.status}`);

  const afterUnfollow = await apiRequest(`/api/users/${encodeURIComponent(userB.userId)}/followers`);
  assert.ok(!asArray(afterUnfollow.json).includes(userA.userId), '取消关注后关注者列表不应包含 A');

  const selfFollow = await apiRequest(`/api/follows/${encodeURIComponent(userA.userId)}`, {
    method: 'POST',
    token: tokenA,
  });
  assert.equal(selfFollow.status, 400, `关注自己应返回 400，实际 ${selfFollow.status}`);

  const missing = await apiRequest('/api/follows/__not_exist__', { method: 'POST', token: tokenA });
  assert.equal(missing.status, 404, `关注不存在用户应返回 404，实际 ${missing.status}`);
});

test('R-014 兴趣关键词维护生效，匹配兴趣的论文排在推荐首位', async () => {
  const admin = await adminToken();
  const user = await registerUser('rec');
  const token = await loginToken(user);
  const keyword = uniqueName('兴趣关键词');

  const put = await apiRequest('/api/me/interests', { method: 'PUT', token, body: { interests: [keyword] } });
  assert.equal(put.status, 200, `更新兴趣应返回 200，实际 ${put.status}，响应：${put.text}`);
  const me = await apiRequest('/api/me', { token });
  assert.equal(me.status, 200);
  assert.deepEqual(asRecord(me.json).interests, [keyword]);

  const matchedId = await createPaper(admin, { title: `${keyword} 相关研究` });
  await delay(5);
  const unrelatedId = await createPaper(admin, { title: uniqueName('无关主题论文') });
  assert.notEqual(matchedId, unrelatedId);

  const rec = await apiRequest('/api/recommendations', { token });
  assert.equal(rec.status, 200, `获取推荐应返回 200，实际 ${rec.status}，响应：${rec.text}`);
  const list = asArray(rec.json).map((item) => asRecord(item));
  assert.ok(list.length > 0, '推荐列表不应为空');
  assert.equal(list[0].id, matchedId, '标题命中兴趣词的论文应排在推荐首位');
});

test('R-014 无兴趣用户按 createdAt 倒序推荐；未认证 401；非法 interests 400', async () => {
  const admin = await adminToken();
  const fresh = await registerUser('recfresh');
  const token = await loginToken(fresh);

  await createPaper(admin, { title: uniqueName('较早论文') });
  await delay(10);
  const newestId = await createPaper(admin, { title: uniqueName('最新论文') });

  const rec = await apiRequest('/api/recommendations', { token });
  assert.equal(rec.status, 200);
  const list = asArray(rec.json).map((item) => asRecord(item));
  assert.ok(list.length >= 2, '推荐列表应包含多篇论文');
  assert.equal(list[0].id, newestId, '无兴趣用户应最先看到最新创建的论文');
  for (let index = 1; index < list.length; index += 1) {
    const previous = String(list[index - 1].createdAt);
    const current = String(list[index].createdAt);
    assert.ok(previous >= current, `推荐列表应按 createdAt 倒序，第 ${index - 1} 项 ${previous} 不应早于第 ${index} 项 ${current}`);
  }

  const anonymous = await apiRequest('/api/recommendations');
  assert.equal(anonymous.status, 401, `不带 token 获取推荐应返回 401，实际 ${anonymous.status}`);

  const badInterests = await apiRequest('/api/me/interests', {
    method: 'PUT',
    token,
    body: { interests: 'not-an-array' },
  });
  assert.equal(badInterests.status, 400, `interests 非字符串数组应返回 400，实际 ${badInterests.status}`);
});

test('R-015 普通用户创建/编辑/删除论文均返回 403 且数据不被改动；管理员同类操作成功', async () => {
  const admin = await adminToken();
  const paperId = await createPaper(admin, { title: uniqueName('权限论文'), doi: '10.1000/orig' });
  const user = await registerUser('plain');
  const token = await loginToken(user);

  const createRes = await apiRequest('/api/papers', { method: 'POST', token, body: { title: uniqueName('越权创建') } });
  assert.equal(createRes.status, 403, `普通用户创建论文应返回 403，实际 ${createRes.status}；响应：${createRes.text}`);

  const before = await getPaper(paperId);
  const putRes = await apiRequest(`/api/papers/${encodeURIComponent(paperId)}`, {
    method: 'PUT',
    token,
    body: { title: '被篡改', doi: '10.1000/hacked' },
  });
  assert.equal(putRes.status, 403, `普通用户编辑论文应返回 403，实际 ${putRes.status}`);
  const after = await getPaper(paperId);
  assert.deepEqual(after, before, '普通用户编辑失败后论文数据不应发生任何变化');

  const delRes = await apiRequest(`/api/papers/${encodeURIComponent(paperId)}`, { method: 'DELETE', token });
  assert.equal(delRes.status, 403, `普通用户删除论文应返回 403，实际 ${delRes.status}`);
  const stillThere = await apiRequest(`/api/papers/${encodeURIComponent(paperId)}`);
  assert.equal(stillThere.status, 200, '普通用户删除失败后论文仍应可读');

  const adminCreate = await apiRequest('/api/papers', {
    method: 'POST',
    token: admin,
    body: { title: uniqueName('管理员新建') },
  });
  assert.equal(adminCreate.status, 201, `管理员创建论文应返回 201，实际 ${adminCreate.status}`);
  const adminUpdate = await apiRequest(`/api/papers/${encodeURIComponent(paperId)}`, {
    method: 'PUT',
    token: admin,
    body: { doi: '10.1000/orig2' },
  });
  assert.equal(adminUpdate.status, 200, `管理员编辑论文应返回 200，实际 ${adminUpdate.status}`);
  const adminDelete = await apiRequest(`/api/papers/${encodeURIComponent(paperId)}`, {
    method: 'DELETE',
    token: admin,
  });
  assert.equal(adminDelete.status, 204, `管理员删除论文应返回 204，实际 ${adminDelete.status}`);
});

test('R-016 GET / 无需凭证返回 HTML，且包含全部界面锚点', async () => {
  const res = await apiRequest('/');
  assert.equal(res.status, 200, `GET / 应返回 200，实际 ${res.status}`);
  const contentType = String(res.headers['content-type'] ?? '');
  assert.ok(contentType.includes('text/html'), `GET / 的 content-type 应包含 text/html，实际：${contentType}`);
  for (const anchor of ['login-form', 'paper-list', 'comment-thread', 'friend-panel', 'recommendation-list']) {
    assert.ok(res.text.includes(`id="${anchor}"`), `HTML 中应包含锚点 id="${anchor}"`);
  }
});

test('R-016 页面中直接出现的 /api/ 字面路径均不返回 404', async () => {
  const page = await apiRequest('/');
  assert.equal(page.status, 200);
  const pattern = /\/api\/[A-Za-z0-9_\-/]+/g;
  const paths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(page.text)) !== null) {
    const raw = match[0].replace(/\/+$/, '');
    if (raw.length > '/api/'.length) paths.add(raw);
  }
  assert.ok(paths.size > 0, '页面中应至少出现一个 /api/ 接口路径');
  for (const path of paths) {
    const res = await apiRequest(path);
    assert.notEqual(res.status, 404, `页面引用的接口 ${path} 不应返回 404（实际 ${res.status}）`);
  }
});

test('R-017 同一进程内数据跨请求共享（论文三次读取一致、评论与关注跨用户可见）', async () => {
  const admin = await adminToken();
  const id = await createPaper(admin, { title: uniqueName('持久论文') });
  const first = await apiRequest(`/api/papers/${encodeURIComponent(id)}`);
  const second = await apiRequest(`/api/papers/${encodeURIComponent(id)}`);
  const third = await apiRequest(`/api/papers/${encodeURIComponent(id)}`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.deepEqual(second.json, first.json, '连续两次读取同一论文应返回完全相同的 JSON');
  assert.deepEqual(third.json, first.json, '第三次读取同一论文应返回完全相同的 JSON');

  const userA = await registerUser('persistA');
  const tokenA = await loginToken(userA);
  const userB = await registerUser('persistB');
  const tokenB = await loginToken(userB);

  const commentRes = await apiRequest(`/api/papers/${encodeURIComponent(id)}/comments`, {
    method: 'POST',
    token: tokenA,
    body: { content: '跨用户可见的评论' },
  });
  assert.equal(commentRes.status, 201);
  const commentId = asNonEmptyString(asRecord(commentRes.json).id, 'comment id');
  const listForB = asArray((await apiRequest(`/api/papers/${encodeURIComponent(id)}/comments`, { token: tokenB })).json).map(
    (item) => asRecord(item),
  );
  assert.ok(
    listForB.some((item) => item.id === commentId && item.content === '跨用户可见的评论'),
    '用户 B 应能读到用户 A 发表的评论',
  );

  const follow = await apiRequest(`/api/follows/${encodeURIComponent(userB.userId)}`, { method: 'POST', token: tokenA });
  assert.ok([200, 204].includes(follow.status), `关注应返回 200 或 204，实际 ${follow.status}`);
  const followers = asArray((await apiRequest(`/api/users/${encodeURIComponent(userB.userId)}/followers`)).json);
  assert.ok(followers.includes(userA.userId), '独立请求应能读到 A 对 B 的关注关系');
});

test('R-018 src 下相对导入均带 .ts 扩展名，且不存在 child_process / spawn( 调用', async () => {
  const files = await collectTsFiles(SRC_DIR);
  assert.ok(files.length > 0, `应扫描到 ${SRC_DIR} 下的 TypeScript 文件`);
  const importPattern = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    importPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(source)) !== null) {
      const specifier = match[1];
      assert.ok(specifier.endsWith('.ts'), `${file} 的相对导入 "${specifier}" 未带 .ts 扩展名`);
    }
    assert.ok(!source.includes('child_process'), `${file} 不应引用 child_process`);
    assert.ok(!/\bspawn\s*\(/.test(source), `${file} 不应调用 spawn(`);
  }
});
