/**
 * 控制台服务端：HTTP API + SSE 事件流 + 前端静态资源。
 *
 * 三条设计原则：
 *  1. **前端只是投影**（docs/05 §4）：视图数据全部来自 `/api/state` 与 SSE 事件，
 *     前端不持有真相，刷新/重连不丢状态。
 *  2. **人类介入路径是头等公民**：`/api/directive` 与 `/api/pause` 不是附属功能，
 *     而是「真人建议书高于一切机器人意见」这条优先级的入口。
 *  3. **服务端自带静态资源服务**：不需要另起一个前端服务器，
 *     一个 `node packages/server/src/cli.ts` 就能把控制台跑起来。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { silentLogger, type Logger } from '../../core/src/index.ts';
import { RunManager, type StartRequest } from './run-manager.ts';
import { DEMO_SCENARIOS } from '../../orchestrator/src/demo-project.ts';
import { listRuns } from '../../llm/src/recorder.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export type ServerOptions = {
  root: string;
  workspaceRoot?: string;
  /** 前端构建产物目录（默认 apps/web/dist）。 */
  staticDir?: string;
  port?: number;
  host?: string;
  logger?: Logger;
};

export type ForgeServer = {
  server: Server;
  manager: RunManager;
  url: string;
  close(): Promise<void>;
};

const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`请求体不是合法 JSON：${(e as Error).message}`);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload, 'utf8'),
    'cache-control': 'no-store',
    // 本地开发工具：允许 Vite dev server（另一个端口）直接访问
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

export async function createForgeServer(opts: ServerOptions): Promise<ForgeServer> {
  const logger = opts.logger ?? silentLogger('server');
  const root = resolve(opts.root);
  const staticDir = resolve(opts.staticDir ?? join(root, 'apps', 'web', 'dist'));
  const manager = new RunManager({
    root,
    ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
    logger,
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: Error) => {
      logger.error(`请求处理失败：${err.message}`);
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    if (path.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(res, path);
  }

  /**
   * 组装完整状态载荷。
   *
   * **`/api/state` 与 SSE 首帧必须用同一个函数**：早先版本两处各写一份，
   * SSE 那份漏了 `scenarios`，结果是「刷新后正常、重连后白屏」——
   * 前端的 `state.scenarios.map()` 在收到 SSE 首帧后就炸了。
   * 类型检查抓不到它，因为我把 `scenarios` 声明成了必填字段（谎报）。
   *
   * 教训：**同一份数据有两个出口时，必须只有一个构造点。**
   */
  async function fullState() {
    const base = manager.state();
    const metas = await manager.artifactMetas();
    return {
      ...base,
      artifacts: metas.length > 0 ? metas.map((m) => ({ ...m })) : base.artifacts,
      budget: manager.budgetNow(),
      scenarios: Object.values(DEMO_SCENARIOS).map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        humanAvailable: s.humanAvailable,
      })),
    };
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;

    // ── 状态快照 ────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/state') {
      return json(res, 200, await fullState());
    }

    // ── 事件流（SSE） ───────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
        'x-accel-buffering': 'no',
      });
      // 首帧推一次完整状态：前端重连后不需要额外的拉取就能对齐。
      // 用与 /api/state 完全相同的载荷（同一个 fullState()）。
      res.write(`event: state\ndata: ${JSON.stringify(await fullState())}\n\n`);

      const off = manager.onEvent((e) => {
        res.write(`event: forge\ndata: ${JSON.stringify(e)}\n\n`);
      });
      // 心跳：防止中间设备把空闲连接掐掉
      const beat = setInterval(() => res.write(`: ping\n\n`), 15_000);
      req.on('close', () => {
        clearInterval(beat);
        off();
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, { ok: true, running: manager.isRunning, status: manager.state().status });
    }

    if (req.method === 'GET' && path === '/api/scenarios') {
      return json(res, 200, Object.values(DEMO_SCENARIOS));
    }

    // ── 启动 run ────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/run') {
      const body = (await readBody(req)) as StartRequest;
      try {
        const runtime = await manager.start(body);
        return json(res, 202, { accepted: true, runtime });
      } catch (e) {
        return json(res, 409, { accepted: false, error: (e as Error).message });
      }
    }

    // ── 真人建议书（人类介入的主入口） ──────────────────────────
    if (req.method === 'POST' && path === '/api/directive') {
      const body = (await readBody(req)) as {
        kind?: string;
        text?: string;
        constraints?: string[];
        targetRefs?: string[];
      };
      const valid = ['requirement', 'constraint', 'override', 'resume', 'hold'];
      if (!body.kind || !valid.includes(body.kind)) {
        return json(res, 400, { error: `kind 必须是 ${valid.join(' / ')} 之一` });
      }
      if (!body.text || body.text.trim().length === 0) {
        return json(res, 400, { error: 'text 不能为空 —— 建议书必须能被机械校验，不接受「随口一说」' });
      }
      try {
        const directive = await manager.submitDirective({
          kind: body.kind as never,
          text: body.text,
          ...(body.constraints ? { constraints: body.constraints } : {}),
          ...(body.targetRefs ? { targetRefs: body.targetRefs } : {}),
        });
        return json(res, 201, directive);
      } catch (e) {
        return json(res, 409, { error: (e as Error).message });
      }
    }

    if (req.method === 'POST' && path === '/api/pause') {
      const body = (await readBody(req)) as { reason?: string };
      try {
        const d = await manager.pause(body.reason ?? '人类从控制台暂停');
        return json(res, 201, d);
      } catch (e) {
        return json(res, 409, { error: (e as Error).message });
      }
    }

    // ── 工件详情 ────────────────────────────────────────────────
    if (req.method === 'GET' && path.startsWith('/api/artifacts/')) {
      const id = decodeURIComponent(path.slice('/api/artifacts/'.length));
      const state = manager.state();
      const ws = state.runtime?.workspace;
      if (!ws) return json(res, 404, { error: '还没有运行过，无法读取工件' });
      const found = await findArtifactFile(ws, id);
      if (!found) return json(res, 404, { error: `找不到工件 ${id}` });
      return json(res, 200, JSON.parse(await readFile(found, 'utf8')));
    }

    // ── 事件流回放用的 run 列表 ─────────────────────────────────
    if (req.method === 'GET' && path === '/api/runs') {
      const ws = manager.state().runtime?.workspace;
      const dirs = [ws ? join(ws, 'runs') : null, join(root, 'runs')].filter((d): d is string => Boolean(d));
      const all: Array<{ runId: string; calls: number; bytes: number; dir: string }> = [];
      for (const d of dirs) {
        for (const r of await listRuns(d)) all.push({ ...r, dir: d });
      }
      return json(res, 200, all);
    }

    // ── 技术债文件 ──────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/tech-debt') {
      const ws = manager.state().runtime?.workspace;
      if (!ws) return json(res, 404, { error: '还没有运行过' });
      const f = join(ws, 'TECH_DEBT.md');
      if (!existsSync(f)) return json(res, 200, { text: null, message: '本次 run 没有产生技术债' });
      return json(res, 200, { text: await readFile(f, 'utf8') });
    }

    return json(res, 404, { error: `未知接口 ${path}` });
  }

  async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    if (!existsSync(staticDir)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(notBuiltPage(staticDir));
      return;
    }
    // 防目录穿越
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    let file = join(staticDir, rel);
    if (!file.startsWith(staticDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, 'index.html');
    } catch {
      // SPA 回退：未命中的路径交给前端路由
      file = join(staticDir, 'index.html');
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': data.byteLength,
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  const port = opts.port ?? 0;
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((res2) => server.listen(port, host, res2));
  const actual = (server.address() as AddressInfo).port;
  const url = `http://${host}:${actual}`;
  logger.info(`AgentForge 控制台：${url}`);

  return {
    server,
    manager,
    url,
    close: () =>
      new Promise<void>((res2) => {
        server.close(() => res2());
      }),
  };
}

/** 在工件目录里按 id 找文件（工件按 kind 分目录存放）。 */
async function findArtifactFile(workspace: string, id: string): Promise<string | null> {
  const dir = join(workspace, 'artifacts');
  if (!existsSync(dir)) return null;
  for (const kind of await readdir(dir)) {
    const f = join(dir, kind, `${id}.json`);
    if (existsSync(f)) return f;
  }
  return null;
}

function notBuiltPage(staticDir: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>AgentForge 控制台</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:60px auto;padding:0 24px;line-height:1.7;color:#e6e6e6;background:#111}
code{background:#222;padding:2px 6px;border-radius:4px}pre{background:#1a1a1a;padding:16px;border-radius:8px;overflow:auto}
h1{font-size:20px}.muted{color:#888}</style>
<h1>AgentForge 控制台前端尚未构建</h1>
<p class="muted">服务端的 API 与事件流已经可用，只是没有找到静态资源目录：</p>
<pre>${staticDir}</pre>
<p>构建前端：</p>
<pre>cd apps/web
npm install          # 首次需要
npm run build</pre>
<p>然后刷新本页。</p>
<p class="muted">你也可以先用 API：<code>GET /api/state</code>、<code>GET /api/events</code>（SSE）、
<code>POST /api/run</code>、<code>POST /api/directive</code>。</p>
</html>`;
}
