/**
 * P6 · 真实小应用靶场：「任务看板」，一个**真的能编译、真的能跑、真的有测试**的应用。
 *
 * 与 P1 的 `demo-project.ts` 的区别在于「真实度」：
 *
 * | | demo-project | real-app-project |
 * |---|---|---|
 * | typecheck | `node -e "process.exit(0)"` 造结果 | **真 `tsc --noEmit`** |
 * | test | `node -e "console.log('# pass 4')"` 造结果 | **真 `node --test` 跑真测试** |
 * | runtime | null（A6 跳过） | **真启动 HTTP 服务并探针** |
 *
 * 也就是说这里跑完后，A1–A7 七个锚点**全部是真检查**，而且产出的应用可以被独立地
 * 编译、测试、启动 —— 那份独立验证是本阶段唯一的验收依据。
 *
 * 诚实边界：当前环境拿不到可用的 LLM API key，所以**模型输出是脚本化的**
 * （MockProvider 精确返回这份代码）。流水线、锚点、裁判、账本、圆桌、逃生全部是真的；
 * 被脚本化的只有「模型写了什么」。这一点在报告里必须写清楚，
 * 否则就成了「用一个精心准备的样例证明系统能工作」的自我欺骗。
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCapture } from '../../core/src/index.ts';
import type { ProjectProfile } from '../../core/src/types.ts';

const REPO_ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..'));

export const REAL_APP_NAME = 'task-board';
export const REAL_APP_BRIEF = '做一个任务看板：用户可以创建任务，也可以列出全部任务。';
/** A6 运行时探针用的端口。选一个不常见的高位端口，降低与本地服务冲突的概率。 */
export const REAL_APP_PORT = 39517;
export const REAL_APP_HEALTH_URL = `http://127.0.0.1:${REAL_APP_PORT}/health`;

// ════════════════════════════════════════════════════════════════
// 应用源码
//
// 行号是**有意固定**的：B1 的语义验证提议要给出「真实文件 + 真实行区间」的证据，
// 而证据会被逐条核验（文件存在、行号不越界、区间内容与声称相符）。
// 用数组 + join 写出来，行号一眼可数，改动时也不容易悄悄错位。
// ════════════════════════════════════════════════════════════════

/** 后端：任务存储。第 6-8 行是 listTasks，第 10-15 行是 createTask（B1 证据会引用它们）。 */
export const STORE_TS = [
  "import type { Task } from '../../shared/contract/types.ts';",
  '',
  'let sequence = 0;',
  'const tasks: Task[] = [];',
  '',
  'export function listTasks(): Task[] {',
  '  return tasks.map((t) => ({ ...t }));',
  '}',
  '',
  'export function createTask(title: string): Task {',
  '  sequence += 1;',
  '  const task: Task = { id: `T-${String(sequence).padStart(3, "0")}`, title };',
  '  tasks.push(task);',
  '  return task;',
  '}',
  '',
  'export function resetStore(): void {',
  '  tasks.length = 0;',
  '  sequence = 0;',
  '}',
  '',
].join('\n');

/** 后端：HTTP 服务。实现契约里声明的 /api/tasks，并提供 A6 探针用的 /health。 */
export const SERVER_TS = [
  "import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';",
  "import { pathToFileURL } from 'node:url';",
  "import { createTask, listTasks } from './store.ts';",
  '',
  'export const DEFAULT_PORT = 39517;',
  '',
  'function send(res: ServerResponse, status: number, body: unknown): void {',
  '  const payload = JSON.stringify(body);',
  "  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });",
  '  res.end(payload);',
  '}',
  '',
  'async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {',
  '  const chunks: Buffer[] = [];',
  '  for await (const chunk of req) chunks.push(chunk as Buffer);',
  "  const raw = Buffer.concat(chunks).toString('utf8').trim();",
  '  if (raw.length === 0) return {};',
  '  try {',
  '    return JSON.parse(raw) as Record<string, unknown>;',
  '  } catch {',
  '    return {};',
  '  }',
  '}',
  '',
  'async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {',
  "  const url = new URL(req.url ?? '/', 'http://127.0.0.1');",
  '',
  "  if (req.method === 'GET' && url.pathname === '/health') {",
  '    send(res, 200, { ok: true });',
  '    return;',
  '  }',
  "  if (req.method === 'GET' && url.pathname === '/api/tasks') {",
  '    send(res, 200, { items: listTasks() });',
  '    return;',
  '  }',
  "  if (req.method === 'POST' && url.pathname === '/api/tasks') {",
  '    const body = await readJsonBody(req);',
  "    const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : '未命名任务';",
  '    send(res, 201, createTask(title));',
  '    return;',
  '  }',
  "  send(res, 404, { error: 'not found' });",
  '}',
  '',
  'export function createApp(): Server {',
  '  return createServer((req, res) => {',
  '    void handle(req, res);',
  '  });',
  '}',
  '',
  'const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;',
  'if (isEntry) {',
  '  const port = Number(process.env.PORT ?? DEFAULT_PORT);',
  '  createApp().listen(port, "127.0.0.1", () => {',
  '    console.log(`task-board listening on http://127.0.0.1:${port}`);',
  '  });',
  '}',
  '',
].join('\n');

/** 前端数据层：接口类型必须来自契约生成的类型文件，不得手写。 */
export const CLIENT_TS = [
  "import type { Task } from '../../shared/contract/types.ts';",
  '',
  'export type TaskListResponse = { items: Task[] };',
  '',
  'export async function loadTasks(baseUrl = ""): Promise<Task[]> {',
  '  const res = await fetch(`${baseUrl}/api/tasks`);',
  '  if (!res.ok) throw new Error(`GET /api/tasks 失败：${res.status}`);',
  '  const body = (await res.json()) as TaskListResponse;',
  '  return body.items;',
  '}',
  '',
  'export async function addTask(title: string, baseUrl = ""): Promise<Task> {',
  '  const res = await fetch(`${baseUrl}/api/tasks`, {',
  "    method: 'POST',",
  "    headers: { 'content-type': 'application/json' },",
  '    body: JSON.stringify({ title }),',
  '  });',
  '  if (!res.ok) throw new Error(`POST /api/tasks 失败：${res.status}`);',
  '  return (await res.json()) as Task;',
  '}',
  '',
].join('\n');

/** 测试：真跑真的 HTTP 请求，断言退出码与响应体。 */
export const TEST_TS = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import type { AddressInfo } from 'node:net';",
  "import type { Task } from '../shared/contract/types.ts';",
  "import { createApp } from '../src/api/server.ts';",
  "import { resetStore } from '../src/api/store.ts';",
  '',
  'async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {',
  '  resetStore();',
  '  const server = createApp();',
  "  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));",
  '  const { port } = server.address() as AddressInfo;',
  '  try {',
  '    return await fn(`http://127.0.0.1:${port}`);',
  '  } finally {',
  '    await new Promise<void>((resolve) => server.close(() => resolve()));',
  '  }',
  '}',
  '',
  "test('R-001 创建任务：POST /api/tasks 返回 201 且带 id', async () => {",
  '  await withServer(async (base) => {',
  '    const res = await fetch(`${base}/api/tasks`, {',
  "      method: 'POST',",
  "      headers: { 'content-type': 'application/json' },",
  "      body: JSON.stringify({ title: '写文档' }),",
  '    });',
  '    assert.equal(res.status, 201);',
  '    const task = (await res.json()) as Task;',
  "    assert.equal(task.title, '写文档');",
  '    assert.ok(task.id.length > 0);',
  '  });',
  '});',
  '',
  "test('R-002 列出任务：GET /api/tasks 返回 200 且包含已创建的任务', async () => {",
  '  await withServer(async (base) => {',
  '    await fetch(`${base}/api/tasks`, {',
  "      method: 'POST',",
  "      headers: { 'content-type': 'application/json' },",
  "      body: JSON.stringify({ title: 'A' }),",
  '    });',
  '    const res = await fetch(`${base}/api/tasks`);',
  '    assert.equal(res.status, 200);',
  '    const body = (await res.json()) as { items: Task[] };',
  '    assert.equal(body.items.length, 1);',
  "    assert.equal(body.items[0]?.title, 'A');",
  '  });',
  '});',
  '',
  "test('未知路径返回 404', async () => {",
  '  await withServer(async (base) => {',
  '    const res = await fetch(`${base}/health-not-here`);',
  '    assert.equal(res.status, 404);',
  '  });',
  '});',
  '',
].join('\n');

// ════════════════════════════════════════════════════════════════
// 脚手架
// ════════════════════════════════════════════════════════════════

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

/**
 * 装真实工具链（typescript + @types/node）。
 *
 * 为什么要装：A4 的价值完全取决于「真的跑了类型检查」。
 * 用 `node -e process.exit(0)` 造一个恒真的结果，会让 A4 变成一个装饰品 ——
 * 它永远绿，也永远不告诉你任何事。
 *
 * 幂等：node_modules/typescript 已存在就跳过，避免每次 run 都重装。
 */
export async function ensureToolchain(
  root: string,
  opts: { cacheDir?: string; onLog?: (s: string) => void } = {},
): Promise<{ installed: boolean; detail?: string }> {
  if (existsSync(join(root, 'node_modules', 'typescript', 'package.json'))) {
    return { installed: false, detail: '工具链已存在，跳过安装' };
  }
  const cacheDir = opts.cacheDir ?? join(REPO_ROOT, '.npm-cache');
  opts.onLog?.('正在安装真实工具链（typescript + @types/node）…');
  const r = await execCapture('', {
    cwd: root,
    trusted: {
      cmd: 'npm',
      args: ['install', '--no-audit', '--no-fund', '--cache', cacheDir],
    },
    timeoutMs: 300_000,
  });
  if (r.exitCode !== 0) {
    return { installed: false, detail: `工具链安装失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).slice(0, 400)}` };
  }
  opts.onLog?.(`工具链安装完成：${r.stdout.trim().split('\n').slice(-1)[0] ?? ''}`);
  return { installed: true };
}

export async function scaffoldRealApp(root: string): Promise<ProjectProfile> {
  await write(
    root,
    'package.json',
    JSON.stringify(
      {
        name: REAL_APP_NAME,
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          // 真实命令，不是造出来的结果
          typecheck: 'tsc --noEmit -p tsconfig.json',
          test: 'node tests/tasks.test.ts',
          start: 'node src/api/server.ts',
        },
        devDependencies: {
          typescript: '^7.0.0',
          '@types/node': '^26.0.0',
        },
      },
      null,
      2,
    ),
  );

  await write(
    root,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          lib: ['ES2023'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          // 与引擎同一套约定：Node 原生类型剥离要求 import 带 .ts 扩展名
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          erasableSyntaxOnly: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          types: ['node'],
        },
      },
      null,
      2,
    ),
  );

  await write(root, 'README.md', realAppReadme());
  return realAppProfile();
}

export function realAppProfile(): ProjectProfile {
  return {
    name: REAL_APP_NAME,
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    // 三个都配真的：A4 真编译、A5 真跑测试、A6 真启动服务并探针
    typecheck: { cmd: 'npm', args: ['run', 'typecheck'] },
    test: { cmd: 'npm', args: ['run', 'test'] },
    run: { cmd: 'node', args: ['src/api/server.ts'], healthUrl: REAL_APP_HEALTH_URL },
    knownPackages: ['lodash', 'express', 'react', 'zod', 'typescript', '@types/node'],
    dependencyAllowlist: null,
  };
}

function realAppReadme(): string {
  return [
    `# ${REAL_APP_NAME}`,
    '',
    '> 本应用由 AgentForge 的流水线产出（PM → 契约 → 前后端 → 测试 → 审查）。',
    '',
    '## 运行',
    '',
    '```bash',
    'npm install          # 首次：typescript + @types/node',
    'npm run typecheck    # 真实类型检查',
    'npm test             # 真实测试（会真的起 HTTP 服务并发请求）',
    `PORT=${REAL_APP_PORT} npm start`,
    '```',
    '',
    '## 接口',
    '',
    '- `GET /health` → `{ ok: true }`',
    '- `GET /api/tasks` → `{ items: Task[] }`',
    '- `POST /api/tasks` `{ title }` → `201` + `Task`',
    '',
    '接口类型来自 `shared/contract/types.ts` —— 该文件由冻结后的契约**自动生成**，请勿手工编辑。',
    '要改接口请走契约变更流程，否则前后端会各自手写一份类型，最终在集成时崩掉。',
    '',
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════
// Mock 脚本
// ════════════════════════════════════════════════════════════════

/**
 * 「五个角色正常发挥」的脚本化输出。
 *
 * 注意 B1 的证据引用了 `src/api/store.ts` 的**真实行号**：
 *   - R-002 → 第 6-8 行（listTasks）
 *   - R-001 → 第 10-15 行（createTask）
 * B1 会逐条核验这些区间确实存在且确实包含所声称的内容 —— 编造证据会让判定整条作废。
 */
export function realAppScript(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'produce:Requirement': {
      requirements: [
        {
          id: 'R-001',
          text: '用户可以创建任务',
          acceptance: ['POST /api/tasks 返回 201，响应体含非空 id'],
          priority: 'must',
          status: 'open',
          origin: 'user',
        },
        {
          id: 'R-002',
          text: '用户可以列出全部任务',
          acceptance: ['GET /api/tasks 返回 200，且包含已创建的任务'],
          priority: 'must',
          status: 'open',
          origin: 'user',
        },
      ],
    },

    'produce:PRD': {
      title: '任务看板 PRD',
      summary: '提供任务的创建与查询能力，覆盖两条 must 级需求；不引入任何外部运行时依赖。',
      requirementIds: ['R-001', 'R-002'],
      milestones: [{ name: 'M1', deliverables: ['REST API', '前端数据层', '测试'] }],
      nonGoals: ['不做多租户', '不做权限系统', '不做持久化（内存存储）'],
    },

    'produce:TaskGraph': {
      tasks: [
        {
          id: 'T-01',
          title: '实现任务 REST API',
          owner: 'backend',
          scope: 'api',
          dependsOn: [],
          requirementIds: ['R-001', 'R-002'],
          deliverable: 'CodeModule',
          acceptance: ['A4 锚点 PASS', 'A7 锚点 PASS'],
        },
        {
          id: 'T-02',
          title: '实现前端数据层',
          owner: 'frontend',
          scope: 'web',
          dependsOn: [],
          requirementIds: ['R-001', 'R-002'],
          deliverable: 'CodeModule',
          acceptance: ['A4 锚点 PASS', 'A7 锚点 PASS'],
        },
      ],
    },

    'produce:Contract': {
      version: 1,
      openapi: { openapi: '3.1.0', paths: { '/api/tasks': {}, '/health': {} } },
      jsonSchemas: {
        Task: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title'],
          properties: { id: { type: 'string' }, title: { type: 'string' } },
        },
      },
      generatedTypesPath: 'shared/contract/types.ts',
      changeRequests: [],
    },

    'produce:CodeModule:api': {
      files: [
        { path: 'src/api/store.ts', content: STORE_TS },
        { path: 'src/api/server.ts', content: SERVER_TS },
      ],
    },
    'produce:CodeModule:web': {
      files: [{ path: 'src/web/client.ts', content: CLIENT_TS }],
    },

    'produce:TestSuite': {
      framework: 'node:test',
      files: [{ path: 'tests/tasks.test.ts', content: TEST_TS }],
      covers: ['R-001', 'R-002'],
    },

    'produce:AnchoredReview': { stage: 'REVIEW', objections: [], noObjection: true },

    'verify:requirements': {
      requirementVerdicts: [
        {
          requirementId: 'R-001',
          verdict: 'met',
          rationale: 'createTask 已实现；tests/tasks.test.ts 的 R-001 用例真的发 POST 并断言 201',
          evidenceRefs: [
            { kind: 'file', path: 'src/api/store.ts', startLine: 10, endLine: 15, expect: 'createTask' },
          ],
        },
        {
          requirementId: 'R-002',
          verdict: 'met',
          rationale: 'listTasks 已实现；R-002 用例真的发 GET 并断言返回已创建的任务',
          evidenceRefs: [
            { kind: 'file', path: 'src/api/store.ts', startLine: 6, endLine: 8, expect: 'listTasks' },
          ],
        },
      ],
    },

    ...over,
  };
}
