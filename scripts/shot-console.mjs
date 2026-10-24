/**
 * 用 Chrome DevTools Protocol 给一个页面截图 —— 等它**真的渲染完**再截。
 *
 * 为什么不用 `chrome --screenshot`：
 *  - 不带 `--virtual-time-budget`：页面刚 load 就截，React 还没拉到 `/api/state`，
 *    只能拍到「正在连接服务器…」；
 *  - 带 `--virtual-time-budget`：控制台开着 SSE（`/api/events`）这条永不结束的流，
 *    虚拟时间永远推进不完，Chrome 直接挂住（实测挂了 3 分钟）。
 *
 * CDP 的做法是「等条件满足再截」：轮询页面里的判定函数，满足后 `Page.captureScreenshot`。
 * Node 24 自带全局 WebSocket，所以不需要任何依赖。
 *
 * 用法：node scripts/shot-console.mjs <url> <out.png> [判定表达式] [超时毫秒]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:7788/';
const out = process.argv[3] ?? 'console.png';
// 默认判定：页面上出现了正文，且不再显示"正在连接"
const readyExpr =
  process.argv[4] ??
  'Boolean(document.body && document.body.innerText.length > 400 && !document.body.innerText.includes("正在连接"))';
const timeoutMs = Number(process.argv[5] ?? 30_000);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome/Edge');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'cdp-shot-'));
const port = 9333 + Math.floor(Math.random() * 200);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1600,1100',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('Chrome 调试端口没起来');
}

let ws;
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    setTimeout(() => {
      if (pending.has(msgId)) {
        pending.delete(msgId);
        reject(new Error(`${method} 超时`));
      }
    }, 20_000);
  });
}

try {
  const page = await targets();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url });

  // 等条件满足
  const started = Date.now();
  let ok = false;
  while (Date.now() - started < timeoutMs) {
    await sleep(400);
    try {
      const r = await send('Runtime.evaluate', { expression: readyExpr, returnByValue: true });
      if (r?.result?.value === true) {
        ok = true;
        break;
      }
    } catch {
      /* 导航中，忽略 */
    }
  }
  if (!ok) console.error('⚠️ 等待条件超时，仍按当前状态截图');

  await sleep(600); // 让最后一帧稳定
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'), 'base64');
  console.log(`saved: ${out}（等待 ${((Date.now() - started) / 1000).toFixed(1)}s，条件满足=${ok}）`);
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
