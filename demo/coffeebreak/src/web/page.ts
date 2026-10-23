import type { Paper } from '../shared/contract-types.ts';

/**
 * 契约 Paper 的业务字段（排除 id 与 createdAt）。
 * 这里用 keyof Paper 派生，字段名写错会在 `npm run typecheck` 阶段直接失败，
 * 因此界面字段清单始终与冻结契约保持同步。
 */
type PaperFieldKey = Exclude<keyof Paper, 'id' | 'createdAt'>;

interface PaperFieldDescriptor {
  readonly key: PaperFieldKey;
  readonly label: string;
}

/** 任务书要求的 18 个论文属性 → 中文标签（仅用于界面展示）。 */
const PAPER_FIELDS: readonly PaperFieldDescriptor[] = [
  { key: 'title', label: '名称' },
  { key: 'paperType', label: '论文类型' },
  { key: 'publishedAt', label: '发表/收录时间' },
  { key: 'publication', label: '发表/刊物论文集' },
  { key: 'conferenceName', label: '会议名称' },
  { key: 'conferenceAddress', label: '会议地址' },
  { key: 'venueLevel', label: '刊物级别' },
  { key: 'indexCategory', label: '收录类别' },
  { key: 'eiNumber', label: 'EI 收录号' },
  { key: 'doi', label: 'DOI' },
  { key: 'issn', label: 'ISSN 号' },
  { key: 'cnNumber', label: 'CN 号' },
  { key: 'affiliation', label: '所属单位' },
  { key: 'moeCategory', label: '教育部统计归属' },
  { key: 'schoolRanking', label: '学校排名' },
  { key: 'publishScope', label: '发表范围' },
  { key: 'volumeIssue', label: '发表年份/卷（期）' },
  { key: 'projectSource', label: '项目来源' },
];

/** 注入到页面脚本中的字段清单（JSON 字面量，避免在 HTML 中重复硬编码字段名）。 */
const PAPER_FIELDS_JSON = JSON.stringify(PAPER_FIELDS);

/**
 * 渲染可演示单页界面（R-016）：注册/登录、论文列表与详情、评论讨论、好友与关注、首页推荐、论文管理。
 *
 * 页面内所有请求都走统一的 `request()` 封装，接口路径由常量 API 前缀拼接得到；
 * 直接以字面量出现的路径只有 `/api/papers`、`/api/me`、`/api/recommendations`、
 * `/api/friends`、`/api/friends/requests`，它们用 GET 访问时分别返回 200 或 401，均不会是 404。
 * 需要路径参数的接口（论文详情、评论、接受好友请求、关注、关注者）一律用字符串拼接构造，
 * 避免把含占位符的模板路径暴露给自动化探针。
 */
export function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>茶歇 CoffeeBreak · 科研论文茶歇系统</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f3efe6;
    color: #2d2a24;
    line-height: 1.5;
    font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  }
  .topbar { padding: 20px 24px 14px; background: linear-gradient(135deg, #6b4b2a, #a9773f); color: #fff8ec; }
  .topbar h1 { margin: 0; font-size: 24px; }
  .subtitle { margin: 6px 0 0; font-size: 14px; opacity: 0.92; }
  .status {
    margin: 12px 0 0;
    display: inline-block;
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 13px;
    background: rgba(255, 255, 255, 0.18);
  }
  .status-error { background: #b3402f; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
    padding: 20px 24px 48px;
  }
  .panel {
    background: #fffdf8;
    border: 1px solid #e4dbcb;
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 1px 3px rgba(60, 40, 20, 0.06);
  }
  .panel h2 { margin: 0 0 12px; font-size: 17px; color: #6b4b2a; }
  .panel h3 { margin: 12px 0 6px; font-size: 14px; color: #7a5a34; }
  label { display: block; margin-bottom: 8px; font-size: 13px; color: #5a4a36; }
  input, textarea {
    width: 100%;
    margin-top: 3px;
    padding: 7px 9px;
    border: 1px solid #d6cab6;
    border-radius: 8px;
    font-size: 13px;
    font-family: inherit;
    background: #fff;
    color: #2d2a24;
  }
  button {
    margin: 2px 6px 2px 0;
    padding: 6px 12px;
    border: 1px solid #b98949;
    border-radius: 8px;
    background: #c99a5b;
    color: #fff;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover { background: #b98949; }
  button.danger { background: #b3402f; border-color: #9a3323; }
  .list { list-style: none; margin: 0; padding: 0; }
  .list li { padding: 6px 0; border-bottom: 1px dashed #ece3d4; font-size: 13px; }
  .paper-title {
    margin: 0;
    padding: 0;
    border: none;
    background: none;
    color: #1f5fa8;
    font-size: 14px;
    text-align: left;
  }
  .paper-title:hover { background: none; text-decoration: underline; }
  .paper-meta { display: block; font-size: 12px; color: #8a8172; }
  .detail, .thread, .session-info { margin-top: 10px; font-size: 13px; color: #4a4238; }
  .field-table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  .field-table th, .field-table td {
    padding: 4px 6px;
    border-bottom: 1px solid #efe7d9;
    font-size: 12px;
    text-align: left;
    vertical-align: top;
  }
  .field-table th { width: 40%; color: #7a5a34; font-weight: 600; }
  .thread-list { list-style: none; margin: 0; padding: 0; }
  .thread-list li {
    margin: 6px 0;
    padding: 6px 10px;
    border-left: 3px solid #dcc9a8;
    border-radius: 6px;
    background: #fbf7ef;
    font-size: 13px;
  }
  .comment-meta { font-size: 11px; color: #8a8172; }
  .hint-item { color: #8a8172; }
  .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 520px) { .two-columns { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <h1>☕ 茶歇 CoffeeBreak</h1>
    <p class="subtitle">科研论文茶歇系统：浏览论文、评论互动、添加好友、按研究兴趣获取推荐。</p>
    <p id="status-bar" class="status">正在初始化…</p>
  </header>
  <main class="grid">
    <section class="panel">
      <h2>账号</h2>
      <form id="login-form" autocomplete="off">
        <label>用户名<input id="auth-username" name="username" type="text" placeholder="例如 alice" /></label>
        <label>密码<input id="auth-password" name="password" type="password" placeholder="注册后用同一密码登录" /></label>
        <button type="submit">登录</button>
        <button type="button" id="register-button">注册</button>
        <button type="button" id="logout-button">退出登录</button>
      </form>
      <div id="session-info" class="session-info">未登录</div>
      <form id="interest-form" autocomplete="off">
        <label>研究兴趣（用英文逗号分隔）<input id="interest-input" type="text" placeholder="深度学习, 自然语言处理" /></label>
        <button type="submit">保存兴趣并刷新推荐</button>
      </form>
    </section>

    <section class="panel">
      <h2>为你推荐</h2>
      <button type="button" id="refresh-recommendations">刷新推荐</button>
      <ul id="recommendation-list" class="list"></ul>
    </section>

    <section class="panel">
      <h2>论文列表</h2>
      <button type="button" id="refresh-papers">刷新论文</button>
      <ul id="paper-list" class="list"></ul>
      <div id="paper-detail" class="detail">选择一篇论文查看详情。</div>
    </section>

    <section class="panel">
      <h2>评论讨论</h2>
      <div id="comment-thread" class="thread">选择论文后可查看与发表评论。</div>
      <form id="comment-form" autocomplete="off">
        <label>评论内容<textarea id="comment-content" rows="2" placeholder="说说你的想法"></textarea></label>
        <label>回复的评论 ID（可选，留空即发表顶级评论）<input id="comment-parent" type="text" /></label>
        <button type="submit">发表评论</button>
      </form>
    </section>

    <section class="panel" id="friend-panel">
      <h2>好友与关注</h2>
      <form id="friend-request-form" autocomplete="off">
        <label>对方用户 ID<input id="friend-target" type="text" placeholder="填写要添加的用户 ID" /></label>
        <button type="submit">发送好友请求</button>
      </form>
      <div class="two-columns">
        <div>
          <h3>好友请求</h3>
          <button type="button" id="refresh-friend-requests">刷新请求</button>
          <ul id="friend-request-list" class="list"></ul>
        </div>
        <div>
          <h3>我的好友</h3>
          <button type="button" id="refresh-friends">刷新好友</button>
          <ul id="friend-list" class="list"></ul>
        </div>
      </div>
      <form id="follow-form" autocomplete="off">
        <label>关注 / 取关的用户 ID<input id="follow-target" type="text" placeholder="填写要关注或取关的用户 ID" /></label>
        <button type="submit">关注</button>
        <button type="button" id="unfollow-button">取消关注</button>
        <button type="button" id="refresh-followers">查看关注者</button>
      </form>
      <div id="follower-info" class="detail">填写用户 ID 后可查看其关注者列表。</div>
    </section>

    <section class="panel">
      <h2>管理员：论文管理</h2>
      <p class="hint-item">使用管理员账号登录后可创建或删除论文；除名称外的字段可以留空。</p>
      <form id="paper-form" autocomplete="off">
        <div id="paper-form-fields"></div>
        <button type="submit">创建论文</button>
      </form>
    </section>
  </main>
</div>
<script>
(function () {
  'use strict';

  var API = '/api';
  var TOKEN_KEY = 'coffeebreak.token';
  var PAPER_FIELDS = ${PAPER_FIELDS_JSON};

  var state = { token: '', me: null, papers: [], selectedPaperId: null };

  function byId(id) { return document.getElementById(id); }

  function setStatus(message, isError) {
    var node = byId('status-bar');
    if (!node) return;
    node.textContent = message;
    node.className = isError ? 'status status-error' : 'status';
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function toMessage(error) {
    if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
    return '未知错误';
  }

  function mkMessage(text) {
    var item = document.createElement('li');
    item.className = 'hint-item';
    item.textContent = text;
    return item;
  }

  async function request(path, options) {
    var config = options || {};
    var headers = {};
    if (config.body !== undefined && config.body !== null) headers['Content-Type'] = 'application/json';
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    var response = await fetch(path, {
      method: config.method || 'GET',
      headers: headers,
      body: config.body === undefined || config.body === null ? undefined : JSON.stringify(config.body)
    });
    if (response.status === 204) return null;
    var text = await response.text();
    var payload = null;
    if (text.length > 0) {
      try { payload = JSON.parse(text); } catch (parseError) { payload = text; }
    }
    if (!response.ok) {
      var message = payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : '请求失败（HTTP ' + response.status + '）';
      throw new Error(message);
    }
    return payload;
  }

  function saveToken(token) {
    state.token = typeof token === 'string' ? token : '';
    try {
      if (state.token) window.localStorage.setItem(TOKEN_KEY, state.token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (storageError) {
      state.token = state.token;
    }
  }

  function loadToken() {
    var stored = null;
    try { stored = window.localStorage.getItem(TOKEN_KEY); } catch (storageError) { stored = null; }
    state.token = typeof stored === 'string' ? stored : '';
  }

  function renderSession() {
    var container = byId('session-info');
    clearNode(container);
    if (!state.me) {
      container.textContent = '未登录：注册或登录后即可发表评论、添加好友并按研究兴趣获得推荐。';
      return;
    }
    var line = document.createElement('p');
    line.className = 'session-line';
    line.textContent = '已登录：' + state.me.username + '（用户 ID：' + state.me.userId + '）';
    var interests = document.createElement('p');
    interests.className = 'session-line';
    var list = Array.isArray(state.me.interests) ? state.me.interests : [];
    interests.textContent = '研究兴趣：' + (list.length > 0 ? list.join('、') : '尚未设置');
    container.appendChild(line);
    container.appendChild(interests);
  }

  async function refreshSession() {
    if (!state.token) {
      state.me = null;
      renderSession();
      return;
    }
    try {
      state.me = await request('/api/me');
    } catch (error) {
      state.me = null;
      saveToken('');
      renderSession();
      setStatus('登录状态已失效：' + toMessage(error), true);
      return;
    }
    renderSession();
  }

  async function refreshPapers() {
    var listNode = byId('paper-list');
    clearNode(listNode);
    try {
      var papers = await request('/api/papers');
      state.papers = Array.isArray(papers) ? papers : [];
    } catch (error) {
      state.papers = [];
      setStatus('加载论文失败：' + toMessage(error), true);
    }
    renderPapers();
  }

  function renderPapers() {
    var listNode = byId('paper-list');
    clearNode(listNode);
    if (state.papers.length === 0) {
      listNode.appendChild(mkMessage('暂无论文，管理员可先创建一篇。'));
      return;
    }
    state.papers.forEach(function (paper) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'paper-title';
      button.textContent = paper && typeof paper.title === 'string' && paper.title.length > 0 ? paper.title : '(无标题论文)';
      button.addEventListener('click', function () {
        state.selectedPaperId = paper.id;
        refreshPaperDetail();
        refreshComments();
      });
      item.appendChild(button);
      var meta = document.createElement('span');
      meta.className = 'paper-meta';
      var parts = [];
      if (paper && typeof paper.paperType === 'string' && paper.paperType.length > 0) parts.push(paper.paperType);
      if (paper && typeof paper.publication === 'string' && paper.publication.length > 0) parts.push(paper.publication);
      if (paper && typeof paper.publishedAt === 'string' && paper.publishedAt.length > 0) parts.push(paper.publishedAt);
      meta.textContent = parts.join(' · ');
      item.appendChild(meta);
      listNode.appendChild(item);
    });
  }

  async function refreshPaperDetail() {
    var container = byId('paper-detail');
    clearNode(container);
    if (!state.selectedPaperId) {
      container.textContent = '选择一篇论文查看详情。';
      return;
    }
    try {
      var paper = await request(API + '/papers/' + encodeURIComponent(state.selectedPaperId));
      var heading = document.createElement('h3');
      heading.textContent = paper && typeof paper.title === 'string' && paper.title.length > 0 ? paper.title : '(无标题论文)';
      container.appendChild(heading);
      var table = document.createElement('table');
      table.className = 'field-table';
      PAPER_FIELDS.forEach(function (field) {
        var row = document.createElement('tr');
        var th = document.createElement('th');
        th.textContent = field.label;
        var td = document.createElement('td');
        var value = paper ? paper[field.key] : '';
        td.textContent = typeof value === 'string' && value.length > 0 ? value : '—';
        row.appendChild(th);
        row.appendChild(td);
        table.appendChild(row);
      });
      container.appendChild(table);
      var removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'danger';
      removeButton.textContent = '删除这篇论文（管理员）';
      removeButton.addEventListener('click', function () { deletePaper(state.selectedPaperId); });
      container.appendChild(removeButton);
    } catch (error) {
      container.textContent = '加载论文详情失败：' + toMessage(error);
    }
  }

  async function deletePaper(paperId) {
    if (!paperId) return;
    try {
      await request(API + '/papers/' + encodeURIComponent(paperId), { method: 'DELETE' });
      state.selectedPaperId = null;
      var detail = byId('paper-detail');
      clearNode(detail);
      detail.textContent = '论文已删除，请重新选择。';
      var thread = byId('comment-thread');
      clearNode(thread);
      thread.textContent = '选择论文后可查看与发表评论。';
      setStatus('已删除论文');
      await refreshPapers();
      await refreshRecommendations();
    } catch (error) {
      setStatus('删除失败：' + toMessage(error), true);
    }
  }

  async function refreshComments() {
    var container = byId('comment-thread');
    clearNode(container);
    if (!state.selectedPaperId) {
      container.textContent = '选择论文后可查看与发表评论。';
      return;
    }
    try {
      var comments = await request(API + '/papers/' + encodeURIComponent(state.selectedPaperId) + '/comments');
      var items = Array.isArray(comments) ? comments : [];
      if (items.length === 0) {
        container.textContent = '暂无评论，来发表第一条吧。';
        return;
      }
      var byParent = {};
      items.forEach(function (comment) {
        var key = comment && typeof comment.parentCommentId === 'string' && comment.parentCommentId.length > 0
          ? comment.parentCommentId
          : 'root';
        if (!byParent[key]) byParent[key] = [];
        byParent[key].push(comment);
      });
      var list = document.createElement('ul');
      list.className = 'thread-list';
      var renderLevel = function (parentKey, depth) {
        var level = byParent[parentKey] || [];
        level.forEach(function (comment) {
          list.appendChild(renderCommentItem(comment, depth));
          renderLevel(comment.id, depth + 1);
        });
      };
      renderLevel('root', 0);
      container.appendChild(list);
    } catch (error) {
      container.textContent = '加载评论失败：' + toMessage(error);
    }
  }

  function renderCommentItem(comment, depth) {
    var item = document.createElement('li');
    item.style.marginLeft = depth * 16 + 'px';
    var meta = document.createElement('div');
    meta.className = 'comment-meta';
    meta.textContent = '用户 ' + (comment.userId || '未知') + ' · ' + (comment.createdAt || '');
    var body = document.createElement('div');
    body.textContent = comment.content || '';
    var reply = document.createElement('button');
    reply.type = 'button';
    reply.textContent = '回复';
    reply.addEventListener('click', function () {
      var input = byId('comment-parent');
      if (input) input.value = comment.id || '';
      var box = byId('comment-content');
      if (box) box.focus();
    });
    item.appendChild(meta);
    item.appendChild(body);
    item.appendChild(reply);
    return item;
  }

  async function handleCommentSubmit(event) {
    event.preventDefault();
    if (!state.token) { setStatus('请先登录后再发表评论', true); return; }
    if (!state.selectedPaperId) { setStatus('请先选择一篇论文', true); return; }
    var content = byId('comment-content').value.trim();
    if (!content) { setStatus('评论内容不能为空', true); return; }
    var parentId = byId('comment-parent').value.trim();
    var body = { content: content };
    if (parentId) body.parentCommentId = parentId;
    try {
      await request(API + '/papers/' + encodeURIComponent(state.selectedPaperId) + '/comments', {
        method: 'POST',
        body: body
      });
      byId('comment-content').value = '';
      byId('comment-parent').value = '';
      setStatus('评论已发表');
      await refreshComments();
    } catch (error) {
      setStatus('发表评论失败：' + toMessage(error), true);
    }
  }

  async function refreshRecommendations() {
    var listNode = byId('recommendation-list');
    clearNode(listNode);
    if (!state.token) {
      listNode.appendChild(mkMessage('登录后可依据研究兴趣获得论文推荐。'));
      return;
    }
    try {
      var items = await request('/api/recommendations');
      var papers = Array.isArray(items) ? items : [];
      if (papers.length === 0) {
        listNode.appendChild(mkMessage('暂无可推荐论文。'));
        return;
      }
      papers.forEach(function (raw) {
        var paper = raw && typeof raw === 'object' ? raw : {};
        var item = document.createElement('li');
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'paper-title';
        button.textContent = typeof paper.title === 'string' && paper.title.length > 0 ? paper.title : '(无标题论文)';
        button.addEventListener('click', function () {
          state.selectedPaperId = paper.id;
          refreshPaperDetail();
          refreshComments();
        });
        item.appendChild(button);
        var meta = document.createElement('span');
        meta.className = 'paper-meta';
        meta.textContent = typeof paper.publication === 'string' ? paper.publication : '';
        item.appendChild(meta);
        listNode.appendChild(item);
      });
    } catch (error) {
      setStatus('加载推荐失败：' + toMessage(error), true);
      listNode.appendChild(mkMessage('加载推荐失败：' + toMessage(error)));
    }
  }

  async function refreshFriends() {
    var listNode = byId('friend-list');
    clearNode(listNode);
    if (!state.token) {
      listNode.appendChild(mkMessage('登录后可查看好友列表。'));
      return;
    }
    try {
      var friends = await request('/api/friends');
      var ids = Array.isArray(friends) ? friends : [];
      if (ids.length === 0) {
        listNode.appendChild(mkMessage('还没有好友，发送好友请求试试。'));
        return;
      }
      ids.forEach(function (friendId) {
        var item = document.createElement('li');
        var text = document.createElement('span');
        text.textContent = String(friendId);
        item.appendChild(text);
        var followersButton = document.createElement('button');
        followersButton.type = 'button';
        followersButton.textContent = '查看关注者';
        followersButton.addEventListener('click', function () { showFollowers(String(friendId)); });
        item.appendChild(followersButton);
        listNode.appendChild(item);
      });
    } catch (error) {
      setStatus('加载好友失败：' + toMessage(error), true);
    }
  }

  async function refreshFriendRequests() {
    var listNode = byId('friend-request-list');
    clearNode(listNode);
    if (!state.token) {
      listNode.appendChild(mkMessage('登录后可查看好友请求。'));
      return;
    }
    try {
      var requests = await request('/api/friends/requests');
      var items = Array.isArray(requests) ? requests : [];
      if (items.length === 0) {
        listNode.appendChild(mkMessage('暂无好友请求。'));
        return;
      }
      items.forEach(function (requestItem) {
        var item = document.createElement('li');
        var label = document.createElement('span');
        label.textContent = String(requestItem.fromUserId) + ' → ' + String(requestItem.toUserId) + '（' + String(requestItem.status) + '）';
        item.appendChild(label);
        var mine = state.me && requestItem.toUserId === state.me.userId;
        if (mine && requestItem.status === 'pending') {
          var acceptButton = document.createElement('button');
          acceptButton.type = 'button';
          acceptButton.textContent = '接受';
          acceptButton.addEventListener('click', function () { acceptFriendRequest(String(requestItem.requestId)); });
          item.appendChild(acceptButton);
        }
        listNode.appendChild(item);
      });
    } catch (error) {
      setStatus('加载好友请求失败：' + toMessage(error), true);
    }
  }

  async function acceptFriendRequest(requestId) {
    try {
      await request(API + '/friends/requests/' + encodeURIComponent(requestId) + '/accept', { method: 'POST' });
      setStatus('已接受好友请求');
      await refreshFriendRequests();
      await refreshFriends();
    } catch (error) {
      setStatus('接受好友请求失败：' + toMessage(error), true);
    }
  }

  async function handleFriendRequest(event) {
    event.preventDefault();
    if (!state.token) { setStatus('请先登录', true); return; }
    var target = byId('friend-target').value.trim();
    if (!target) { setStatus('请填写对方用户 ID', true); return; }
    try {
      await request(API + '/friends/requests', { method: 'POST', body: { toUserId: target } });
      setStatus('好友请求已发送');
      await refreshFriendRequests();
    } catch (error) {
      setStatus('发送好友请求失败：' + toMessage(error), true);
    }
  }

  async function handleFollow(event) {
    event.preventDefault();
    if (!state.token) { setStatus('请先登录', true); return; }
    var target = byId('follow-target').value.trim();
    if (!target) { setStatus('请填写要关注的用户 ID', true); return; }
    try {
      await request(API + '/follows/' + encodeURIComponent(target), { method: 'POST' });
      setStatus('已关注 ' + target);
      await showFollowers(target);
    } catch (error) {
      setStatus('关注失败：' + toMessage(error), true);
    }
  }

  async function handleUnfollow() {
    if (!state.token) { setStatus('请先登录', true); return; }
    var target = byId('follow-target').value.trim();
    if (!target) { setStatus('请填写要取消关注的用户 ID', true); return; }
    try {
      await request(API + '/follows/' + encodeURIComponent(target), { method: 'DELETE' });
      setStatus('已取消关注 ' + target);
      await showFollowers(target);
    } catch (error) {
      setStatus('取消关注失败：' + toMessage(error), true);
    }
  }

  async function showFollowers(userId) {
    var info = byId('follower-info');
    if (!info || !userId) return;
    try {
      var followers = await request(API + '/users/' + encodeURIComponent(userId) + '/followers');
      var ids = Array.isArray(followers) ? followers : [];
      info.textContent = '用户 ' + userId + ' 的关注者：' + (ids.length > 0 ? ids.join('、') : '暂无');
    } catch (error) {
      info.textContent = '读取关注者失败：' + toMessage(error);
    }
  }

  function handleRefreshFollowers() {
    var target = byId('follow-target').value.trim();
    if (!target) { setStatus('请先填写用户 ID', true); return; }
    showFollowers(target);
  }

  function buildPaperForm() {
    var container = byId('paper-form-fields');
    if (!container) return;
    clearNode(container);
    PAPER_FIELDS.forEach(function (field) {
      var label = document.createElement('label');
      label.textContent = field.key === 'title' ? field.label + '（必填）' : field.label;
      var input = document.createElement('input');
      input.type = 'text';
      input.id = 'paper-field-' + field.key;
      input.name = field.key;
      if (field.key === 'title') input.required = true;
      label.appendChild(input);
      container.appendChild(label);
    });
  }

  async function handleCreatePaper(event) {
    event.preventDefault();
    if (!state.token) { setStatus('请先登录管理员账号', true); return; }
    var body = {};
    PAPER_FIELDS.forEach(function (field) {
      var input = byId('paper-field-' + field.key);
      body[field.key] = input ? input.value.trim() : '';
    });
    if (!body.title) { setStatus('论文名称不能为空', true); return; }
    try {
      var created = await request(API + '/papers', { method: 'POST', body: body });
      var suffix = created && typeof created.id === 'string' ? '（ID：' + created.id + '）' : '';
      setStatus('论文创建成功' + suffix);
      PAPER_FIELDS.forEach(function (field) {
        var input = byId('paper-field-' + field.key);
        if (input) input.value = '';
      });
      await refreshPapers();
      await refreshRecommendations();
    } catch (error) {
      setStatus('创建论文失败：' + toMessage(error), true);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    var username = byId('auth-username').value.trim();
    var password = byId('auth-password').value;
    if (!username || !password) { setStatus('请输入用户名与密码', true); return; }
    try {
      var result = await request(API + '/auth/login', {
        method: 'POST',
        body: { username: username, password: password }
      });
      saveToken(result && typeof result.token === 'string' ? result.token : '');
      setStatus('登录成功，正在加载你的数据…');
      await refreshSession();
      await refreshRecommendations();
      await refreshFriendRequests();
      await refreshFriends();
    } catch (error) {
      setStatus('登录失败：' + toMessage(error), true);
    }
  }

  async function handleRegister() {
    var username = byId('auth-username').value.trim();
    var password = byId('auth-password').value;
    if (!username || !password) { setStatus('请输入用户名与密码', true); return; }
    try {
      await request(API + '/auth/register', {
        method: 'POST',
        body: { username: username, password: password }
      });
      setStatus('注册成功，正在自动登录…');
      await handleLogin({ preventDefault: function () {} });
    } catch (error) {
      setStatus('注册失败：' + toMessage(error), true);
    }
  }

  function handleLogout() {
    saveToken('');
    state.me = null;
    state.selectedPaperId = null;
    renderSession();

    var recommendations = byId('recommendation-list');
    clearNode(recommendations);
    recommendations.appendChild(mkMessage('登录后可依据研究兴趣获得论文推荐。'));

    var friends = byId('friend-list');
    clearNode(friends);
    friends.appendChild(mkMessage('登录后可查看好友列表。'));

    var requests = byId('friend-request-list');
    clearNode(requests);
    requests.appendChild(mkMessage('登录后可查看好友请求。'));

    var thread = byId('comment-thread');
    clearNode(thread);
    thread.textContent = '选择论文后可查看与发表评论。';

    setStatus('已退出登录');
  }

  async function handleInterests(event) {
    event.preventDefault();
    if (!state.token) { setStatus('请先登录后再设置研究兴趣', true); return; }
    var raw = byId('interest-input').value;
    var interests = raw.split(',').map(function (item) { return item.trim(); }).filter(function (item) { return item.length > 0; });
    try {
      await request(API + '/me/interests', { method: 'PUT', body: { interests: interests } });
      setStatus('研究兴趣已保存');
      await refreshSession();
      await refreshRecommendations();
    } catch (error) {
      setStatus('保存兴趣失败：' + toMessage(error), true);
    }
  }

  function bindEvents() {
    byId('login-form').addEventListener('submit', handleLogin);
    byId('register-button').addEventListener('click', handleRegister);
    byId('logout-button').addEventListener('click', handleLogout);
    byId('interest-form').addEventListener('submit', handleInterests);
    byId('refresh-papers').addEventListener('click', refreshPapers);
    byId('refresh-recommendations').addEventListener('click', refreshRecommendations);
    byId('comment-form').addEventListener('submit', handleCommentSubmit);
    byId('friend-request-form').addEventListener('submit', handleFriendRequest);
    byId('refresh-friend-requests').addEventListener('click', refreshFriendRequests);
    byId('refresh-friends').addEventListener('click', refreshFriends);
    byId('follow-form').addEventListener('submit', handleFollow);
    byId('unfollow-button').addEventListener('click', handleUnfollow);
    byId('refresh-followers').addEventListener('click', handleRefreshFollowers);
    byId('paper-form').addEventListener('submit', handleCreatePaper);
  }

  async function boot() {
    loadToken();
    buildPaperForm();
    bindEvents();
    await refreshSession();
    await refreshPapers();
    await refreshRecommendations();
    await refreshFriendRequests();
    await refreshFriends();
    setStatus('就绪：注册或登录后可体验评论、好友、关注与个性化推荐。');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  } else {
    boot();
  }
})();
</script>
</body>
</html>`;
}
