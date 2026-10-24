import { Buffer } from 'node:buffer';
import type { ServerResponse } from 'node:http';

/**
 * 单页任务看板 HTML。
 * 全部样式与脚本内联，不引用任何第三方前端库、构建产物或外部资源；
 * 页面内脚本通过 fetch 调用契约声明的 /api/tasks 系列接口。
 */
export const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>任务看板</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #f5f6f8; color: #1f2328; }
header { padding: 20px 24px; background: #1f2328; color: #ffffff; }
h1 { margin: 0; font-size: 20px; }
main { max-width: 760px; margin: 0 auto; padding: 24px; }
form { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
input[type="text"], select { padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; background: #ffffff; }
input[type="text"] { flex: 1 1 240px; }
button { padding: 8px 14px; border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; font-size: 14px; cursor: pointer; }
button:hover { background: #f0f2f4; }
#create-button { background: #1f883d; border-color: #1f883d; color: #ffffff; }
#create-button:hover { background: #1a7f37; }
.message { min-height: 20px; margin: 0 0 12px; font-size: 14px; }
.message.error { color: #cf222e; }
.message.ok { color: #1a7f37; }
.filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
li.task { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: #ffffff; border: 1px solid #d0d7de; border-radius: 8px; }
li.empty { color: #656d76; padding: 16px 0; }
.task-title { flex: 1 1 auto; font-size: 15px; word-break: break-word; }
.task-meta { color: #656d76; font-size: 12px; white-space: nowrap; }
.task-actions { display: flex; gap: 8px; }
.status-doing .task-title { color: #9a6700; }
.status-done .task-title { color: #656d76; text-decoration: line-through; }
</style>
</head>
<body>
<header>
  <h1>任务看板</h1>
</header>
<main>
  <form id="create-form">
    <input id="title-input" type="text" placeholder="输入任务标题" autocomplete="off" required>
    <select id="status-select">
      <option value="todo">todo</option>
      <option value="doing">doing</option>
      <option value="done">done</option>
    </select>
    <button id="create-button" type="submit">新建任务</button>
  </form>
  <p id="message" class="message" role="status" aria-live="polite"></p>
  <div class="filters">
    <button type="button" data-filter="">全部</button>
    <button type="button" data-filter="todo">todo</button>
    <button type="button" data-filter="doing">doing</button>
    <button type="button" data-filter="done">done</button>
  </div>
  <ul id="task-list"></ul>
  <noscript>该页面需要启用 JavaScript 才能使用任务看板。</noscript>
</main>
<script>
(function () {
  'use strict';

  var API = '/api/tasks';
  var STATUSES = ['todo', 'doing', 'done'];

  var listEl = document.getElementById('task-list');
  var messageEl = document.getElementById('message');
  var formEl = document.getElementById('create-form');
  var inputEl = document.getElementById('title-input');
  var statusEl = document.getElementById('status-select');
  var currentFilter = '';

  function showMessage(text, isError) {
    messageEl.textContent = text;
    messageEl.className = isError ? 'message error' : 'message ok';
  }

  function describeError(payload, statusCode) {
    if (payload && typeof payload.error === 'string' && payload.error !== '') {
      return payload.error;
    }
    return '请求失败（HTTP ' + statusCode + '）';
  }

  function request(url, options) {
    return fetch(url, options).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        if (text !== '') {
          try {
            payload = JSON.parse(text);
          } catch (parseError) {
            payload = null;
          }
        }
        if (!response.ok) {
          throw new Error(describeError(payload, response.status));
        }
        return payload;
      });
    });
  }

  function createTaskRow(task) {
    var li = document.createElement('li');
    li.className = 'task status-' + task.status;

    var titleEl = document.createElement('span');
    titleEl.className = 'task-title';
    titleEl.textContent = task.title;
    li.appendChild(titleEl);

    var metaEl = document.createElement('span');
    metaEl.className = 'task-meta';
    metaEl.textContent = task.createdAt;
    li.appendChild(metaEl);

    var actions = document.createElement('span');
    actions.className = 'task-actions';

    var select = document.createElement('select');
    select.setAttribute('aria-label', '修改任务状态');
    STATUSES.forEach(function (value) {
      var option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      if (value === task.status) {
        option.selected = true;
      }
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      updateTaskStatus(task.id, select.value);
    });
    actions.appendChild(select);

    var removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = '删除';
    removeButton.addEventListener('click', function () {
      removeTask(task.id);
    });
    actions.appendChild(removeButton);

    li.appendChild(actions);
    return li;
  }

  function loadTasks() {
    var url = currentFilter === '' ? API : API + '?status=' + encodeURIComponent(currentFilter);
    return request(url, { method: 'GET' }).then(function (payload) {
      var tasks = Array.isArray(payload) ? payload : [];
      listEl.textContent = '';
      if (tasks.length === 0) {
        var empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = '暂无任务';
        listEl.appendChild(empty);
        return;
      }
      tasks.forEach(function (task) {
        listEl.appendChild(createTaskRow(task));
      });
    }).catch(function (error) {
      showMessage(error.message, true);
    });
  }

  function updateTaskStatus(id, status) {
    request(API + '/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status })
    }).then(function () {
      showMessage('已更新任务状态：' + status, false);
      return loadTasks();
    }).catch(function (error) {
      showMessage(error.message, true);
      return loadTasks();
    });
  }

  function removeTask(id) {
    request(API + '/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      showMessage('已删除任务', false);
      return loadTasks();
    }).catch(function (error) {
      showMessage(error.message, true);
      return loadTasks();
    });
  }

  formEl.addEventListener('submit', function (event) {
    event.preventDefault();
    var title = inputEl.value.trim();
    if (title === '') {
      showMessage('标题不能为空', true);
      return;
    }
    var body = { title: title, status: statusEl.value };
    request(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function () {
      inputEl.value = '';
      showMessage('已创建任务', false);
      return loadTasks();
    }).catch(function (error) {
      showMessage(error.message, true);
    });
  });

  var filterButtons = document.querySelectorAll('[data-filter]');
  Array.prototype.forEach.call(filterButtons, function (button) {
    button.addEventListener('click', function () {
      currentFilter = button.getAttribute('data-filter') || '';
      loadTasks();
    });
  });

  loadTasks();
})();
</script>
</body>
</html>
`;

/** 以 text/html 输出单页任务看板（200，含 Content-Length）。 */
export function sendIndexPage(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(INDEX_HTML, 'utf8')));
  res.end(INDEX_HTML);
}
