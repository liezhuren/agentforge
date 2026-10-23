/**
 * cb-6 端到端验收：用**真实 HTTP** 跑完整用户旅程。
 *
 * 字段名与路径全部照 cb-6 自己的契约/路由来（`title` 而非 `name`、
 * 好友请求走 `/api/friends/requests`、关注走 `/api/follows/{userId}`）——
 * 第一版脚本按记忆里的形状写，结果 12 条"失败"里全是脚本的错，不是项目的错。
 * 这条教训值得记：**验收脚本必须从被测系统的契约里来，不能从印象里来。**
 *
 * 用法：node e2e.mjs [baseUrl]
 */
import { writeFileSync } from 'node:fs';

const LOG = [];
const rawLog = console.log.bind(console);
console.log = (...a) => { LOG.push(a.join(' ')); rawLog(...a); };
const LOG_PATH = process.env.E2E_LOG || '';
const base = process.argv[2] ?? 'http://127.0.0.1:8788';
let pass = 0;
let fail = 0;
const failures = [];

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML */
  }
  return { status: res.status, text, json };
}

function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

console.log(`\n══════ cb-6 端到端验收（${base}）══════`);

const health = await call('GET', '/health');
check('GET /health → 200 且 status=ok', health.status === 200 && health.json?.status === 'ok', JSON.stringify(health.json));

const home = await call('GET', '/');
check('GET / → 200 HTML（界面存在）', home.status === 200 && /<html/i.test(home.text), `${home.text.length} 字节`);
check('首页含论文/推荐区块', /论文|推荐/.test(home.text));

const uname = `demo_${Date.now().toString(36)}`;
const reg = await call('POST', '/api/auth/register', { body: { username: uname, password: 'p1' } });
check('注册 → 201', reg.status === 201, JSON.stringify(reg.json)?.slice(0, 70));
const dupe = await call('POST', '/api/auth/register', { body: { username: uname, password: 'p1' } });
check('重复用户名 → 409', dupe.status === 409, String(dupe.status));
const badReg = await call('POST', '/api/auth/register', { body: { username: uname } });
check('缺密码 → 400', badReg.status === 400, String(badReg.status));

const login = await call('POST', '/api/auth/login', { body: { username: uname, password: 'p1' } });
const token = login.json?.token;
const userId = login.json?.userId;
check('登录 → 200 且返回 token', login.status === 200 && typeof token === 'string');
const badLogin = await call('POST', '/api/auth/login', { body: { username: uname, password: 'wrong' } });
check('错误密码 → 401', badLogin.status === 401, String(badLogin.status));

const adminLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
const adminToken = adminLogin.json?.token;
const adminId = adminLogin.json?.userId;
check('管理员种子账号可登录', adminLogin.status === 200 && typeof adminToken === 'string');

const me = await call('GET', '/api/me', { token });
check('GET /api/me → 200 且用户名一致', me.status === 200 && me.json?.username === uname, JSON.stringify(me.json)?.slice(0, 60));

// 18 项论文属性（字段名照 cb-6 的 toPaper）
const paper = {
  title: '面向科研茶歇的社交推荐',
  paperType: '期刊论文',
  publishedAt: '2026-09-01',
  publication: '计算机学报',
  conferenceName: '',
  conferenceAddress: '',
  venueLevel: '中文核心',
  indexCategory: 'EI',
  eiNumber: 'EI-2026-001',
  doi: '10.1234/demo',
  issn: '1234-5678',
  cnNumber: 'CN-11-1234',
  affiliation: '某大学计算机学院',
  moeCategory: '工学',
  schoolRanking: 'A',
  publishScope: '国内',
  volumeIssue: '2026(9)',
  projectSource: '国家自然科学基金',
};
const created = await call('POST', '/api/papers', { token: adminToken, body: paper });
check('管理员创建论文 → 201', created.status === 201, JSON.stringify(created.json)?.slice(0, 80));
const paperId = created.json?.id;
check('返回论文 id', Boolean(paperId), String(paperId));

const noTitle = await call('POST', '/api/papers', { token: adminToken, body: { ...paper, title: '' } });
check('缺标题 → 400', noTitle.status === 400, String(noTitle.status));

const forbidden = await call('DELETE', `/api/papers/${paperId}`, { token });
check('普通用户删论文 → 403（权限生效）', forbidden.status === 403, String(forbidden.status));

const list = await call('GET', '/api/papers');
check('GET /api/papers → 200 且非空', list.status === 200 && Array.isArray(list.json) && list.json.length >= 1, `长度 ${list.json?.length}`);

const detail = await call('GET', `/api/papers/${paperId}`);
const missingFields = Object.keys(paper).filter((k) => !(k in (detail.json ?? {})));
check('详情 18 项属性齐全', detail.status === 200 && missingFields.length === 0, missingFields.length ? `缺 ${missingFields.join(',')}` : '18/18');

const updated = await call('PUT', `/api/papers/${paperId}`, { token: adminToken, body: { title: '（已编辑）社交推荐' } });
check('管理员编辑论文 → 200 且生效', updated.status === 200 && String(updated.json?.title).includes('已编辑'), String(updated.status));

const c1 = await call('POST', `/api/papers/${paperId}/comments`, { token, body: { content: '这个方向很有意思' } });
check('登录用户发表评论 → 201', c1.status === 201, JSON.stringify(c1.json)?.slice(0, 70));
const commentId = c1.json?.id;
const c2 = await call('POST', `/api/papers/${paperId}/comments`, {
  token: adminToken,
  body: { content: '同意，尤其是推荐部分', parentCommentId: commentId },
});
check('对评论回复 → 201', c2.status === 201, String(c2.status));
const anonComment = await call('POST', `/api/papers/${paperId}/comments`, { body: { content: '匿名' } });
check('未登录评论 → 401', anonComment.status === 401, String(anonComment.status));
const cmts = await call('GET', `/api/papers/${paperId}/comments`);
check('GET 评论列表 → 200 且 ≥2 条', cmts.status === 200 && JSON.stringify(cmts.json).includes('有意思'), String(cmts.status));

const friendReq = await call('POST', '/api/friends/requests', { token, body: { toUserId: adminId } });
check('发起好友请求 → 2xx', friendReq.status >= 200 && friendReq.status < 300, String(friendReq.status));
const reqId = friendReq.json?.requestId ?? friendReq.json?.id;
const pending = await call('GET', '/api/friends/requests', { token: adminToken });
const foundReq = JSON.stringify(pending.json).includes(String(reqId));
check('管理员能看到待处理好友请求', pending.status === 200 && foundReq, String(pending.status));
const accept = await call('POST', `/api/friends/requests/${reqId}/accept`, { token: adminToken });
check('接受好友请求 → 2xx', accept.status >= 200 && accept.status < 300, String(accept.status));
const friends = await call('GET', '/api/friends', { token });
check('好友列表 → 200', friends.status === 200, String(friends.status));

const follow = await call('POST', `/api/follows/${adminId}`, { token });
check('关注他人 → 2xx', follow.status >= 200 && follow.status < 300, String(follow.status));
const followers = await call('GET', `/api/users/${adminId}/followers`);
check('粉丝列表 → 200 且含当前用户 id', followers.status === 200 && JSON.stringify(followers.json).includes(userId), 'returns ' + (JSON.stringify(followers.json) || '').slice(0, 60));
const unfollow = await call('DELETE', `/api/follows/${adminId}`, { token });
check('取消关注 → 2xx', unfollow.status >= 200 && unfollow.status < 300, String(unfollow.status));

const interests = await call('PUT', '/api/me/interests', { token, body: { interests: ['EI', '期刊论文'] } });
check('设置研究兴趣 → 2xx', interests.status >= 200 && interests.status < 300, String(interests.status));
const rec = await call('GET', '/api/recommendations', { token });
const items = Array.isArray(rec.json) ? rec.json : Array.isArray(rec.json?.items) ? rec.json.items : [];
check('推荐接口 → 200 且非空（兴趣匹配生效）', rec.status === 200 && items.length > 0, `item 数 ${items.length}`);
const recNoAuth = await call('GET', '/api/recommendations');
check('未登录推荐 → 401', recNoAuth.status === 401, String(recNoAuth.status));

const deleted = await call('DELETE', `/api/papers/${paperId}`, { token: adminToken });
check('管理员删除论文 → 204', deleted.status === 204, String(deleted.status));
const gone = await call('GET', `/api/papers/${paperId}`);
check('删除后详情 → 404', gone.status === 404, String(gone.status));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail > 0) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exit(fail === 0 ? 0 : 1);
