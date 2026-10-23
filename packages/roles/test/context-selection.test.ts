/**
 * 上下文装配：分层配额 + 模块接口卡 + 输入审计。
 *
 * 这一组测试守的是**第 21 轮那个事故**（`docs/07 §R`）：
 * 一次 run 跑了 75 分钟，输入**始终停在 ~10.6k token**，而项目从 0 行长到 4443 行。
 * 原因是 24,000 字符的池子被「需求 + PRD + 任务图」吃掉 95%，
 * 契约、全部代码模块、全部测试报告一件都没进去。
 *
 * 它之所以能藏 20 轮，是因为**装配逻辑只影响提示词内容，不产生任何失败的测试**。
 * 所以这里必须把它钉住 —— 否则下次改排序又会静默退回原样。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ArtifactStore } from '../../core/src/store.ts';
import { JsonlRunRecorder, RecordingProvider } from '../../llm/src/recorder.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../../llm/src/types.ts';
import { extractExportedSignatures, renderModuleCards } from '../src/modulecard.ts';
import { DEFAULT_MAX_CONTEXT_CHARS, LlmRoleRunner, renderArtifactBody, selectContext } from '../src/runner.ts';
import { READ_PERMISSIONS, type ProduceRequest, type RoleContext } from '../src/types.ts';

function profile() {
  return {
    name: 'ctx-fixture',
    language: 'typescript' as const,
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: null,
    test: null,
    run: null,
    knownPackages: [],
    dependencyAllowlist: null,
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'af-ctx-select-'));
  const store = new ArtifactStore(dir);
  await store.init();
  return {
    dir,
    store,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function bigContract(pathCount = 40) {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < pathCount; i++) {
    paths[`/api/thing${i}`] = {
      get: { description: 'x'.repeat(300), responses: { '200': {} } },
    };
  }
  return {
    version: 1,
    openapi: { openapi: '3.1.0', paths },
    jsonSchemas: { Thing: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    generatedTypesPath: 'shared/contract/types.ts',
    changeRequests: [],
  };
}

/** 造一份「散文很大、代码很多、契约很大」的真实工作区。 */
async function seedFatProject(store: ArtifactStore) {
  // 注意：工件在写库时会过 schema，所以这里必须给全必填字段。
  // （这也顺带说明为什么装配逻辑只能靠单元测试守：它碰不到任何 schema 差异。）
  await store.put({
    kind: 'Requirement',
    producer: 'pm',
    content: {
      requirements: [
        {
          id: 'R-001',
          text: `系统必须能推荐论文。${'y'.repeat(8_000)}`,
          acceptance: ['GET /api/recommendations 返回 200'],
          priority: 'must',
          status: 'open',
          origin: 'user',
        },
      ],
    },
  });
  await store.put({
    kind: 'PRD',
    producer: 'pm',
    content: {
      title: '茶歇系统',
      summary: `产品需求文档摘要。${'z'.repeat(6_000)}`,
      requirementIds: ['R-001'],
      milestones: [{ name: 'M1', deliverables: ['可演示'] }],
      nonGoals: ['移动端原生 App'],
    },
  });
  await store.put({
    kind: 'TaskGraph',
    producer: 'pm',
    content: {
      tasks: [
        {
          id: 'T-01',
          title: `实现论文模块。${'w'.repeat(9_000)}`,
          owner: 'backend',
          scope: 'api',
          dependsOn: [],
          requirementIds: ['R-001'],
          deliverable: 'CodeModule',
          acceptance: ['POST /api/papers 返回 201'],
        },
      ],
    },
  });
  const contract = await store.put({ kind: 'Contract', producer: 'pm', content: bigContract() });
  await store.freeze(contract.id);

  for (let i = 1; i <= 3; i++) {
    await store.put({
      kind: 'CodeModule',
      producer: 'backend',
      scope: 'api',
      content: {
        files: [
          {
            path: `src/api/mod${i}.ts`,
            content: [
              "import type { Thing } from '../../shared/contract/types.ts';",
              '',
              `export function handleThing${i}Route(req: Request): Response {`,
              '  return { ok: true } as Response;',
              '}',
              '',
              `export const THING${i}_PATHS = ['/api/thing${i}'];`,
              '',
              'function internalHelper() {',
              '  return 1;',
              '}',
              `// ${'filler '.repeat(400)}`,
            ].join('\n'),
          },
        ],
      },
    });
  }
  await store.put({
    kind: 'TestReport',
    // TestReport 的写权限只给 test / orchestrator（system 会被 store 拒绝）
    producer: 'test',
    content: {
      command: 'npm test',
      exitCode: 1,
      passed: 12,
      failed: 28,
      failing: [{ name: 'papers 201', message: 'expected 201, got 501' }],
    },
  });
}

function ctxOf(store: ArtifactStore): RoleContext {
  return {
    stage: 'BUILDING',
    store,
    profile: profile(),
    workOrders: [],
    contractHash: null,
    userBrief: '做一个茶歇系统',
    directives: [],
  };
}

const backendReq: ProduceRequest = { kind: 'CodeModule', scope: 'api', instruction: '实现任务 T-001' };

function select(store: ArtifactStore, req: ProduceRequest = backendReq, budget = DEFAULT_MAX_CONTEXT_CHARS) {
  return selectContext({ store, readable: new Set(READ_PERMISSIONS.backend), role: 'backend', req, budget });
}

// ════════════════════════════════════════════════════════════════

test('🔴 契约不再被散文饿死：需求/PRD/任务图再大，契约也必须进上下文', async () => {
  const f = await fixture();
  try {
    await seedFatProject(f.store);
    // 旧行为：三件散文共 23k，把 24k 预算吃光 → 契约被整件丢弃。
    // 这里用**当时的预算**复现旧场景，验证新分配方式能救回契约。
    const sel = select(f.store, backendReq, 24_000);

    const kinds = sel.report.injected.map((x) => x.kind);
    assert.ok(kinds.includes('Contract'), '契约必须永远在上下文里 —— 没有它，接口只能靠猜');
    const contract = sel.report.injected.find((x) => x.kind === 'Contract')!;
    assert.equal(contract.digest, true, '24k 预算下契约应当是摘要，而不是被丢弃');
    assert.ok(sel.blocks.join('\n').includes('/api/thing0'), '摘要里必须含端点');
    assert.ok(sel.report.used <= 24_000, `实际注入 ${sel.report.used} 超出预算 24000`);
  } finally {
    await f.cleanup();
  }
});

test('🔴 测试报告与模块接口必须优先于散文：它们是「修复」与「接线」的前提', async () => {
  const f = await fixture();
  try {
    await seedFatProject(f.store);
    const sel = select(f.store, backendReq, 24_000);
    const kinds = sel.report.injected.map((x) => x.kind);

    assert.ok(kinds.includes('TestReport'), '看不到「哪条测试挂了」，修复就是盲修');
    // 模块接口（cards）必须在散文之前 —— 它是接线的唯一依据
    const firstCard = sel.report.injected.findIndex((x) => x.card);
    assert.ok(firstCard >= 0, '没有注入任何模块接口卡');

    const blockText = sel.blocks.join('\n');
    assert.match(blockText, /export function handleThing1Route/, '接口卡里必须有导出签名');
    // ⚠️ 只断言**接口卡那几块**里没有实现正文。
    // 「代码全文」是单独一层、尽力而为，它当然会把正文带进来 —— 那是它的职责。
    const cardBlocks = sel.blocks.filter((b) => b.startsWith('--- 接口 '));
    assert.ok(cardBlocks.length > 0);
    assert.ok(
      !cardBlocks.join('\n').includes('filler filler filler'),
      '接口卡不许把实现正文带进来（那就不叫「传接口」了）',
    );
  } finally {
    await f.cleanup();
  }
});

test('🔴 接口卡 ≠ 全文：同样是「知道」，字符量差一个数量级', async () => {
  const f = await fixture();
  try {
    await seedFatProject(f.store);
    const sel = select(f.store);
    const cards = sel.report.injected.filter((x) => x.card);
    assert.ok(cards.length >= 3, `应至少注入 3 个模块的接口卡，实际 ${cards.length}`);
    for (const c of cards) {
      assert.ok(c.chars < 1_500, `单个模块的接口卡不该超过 1500 字符（实际 ${c.chars}）—— 否则就不是「接口」了`);
    }
    // 对照：这些模块的全文有多大
    const full = f.store.heads('CodeModule').reduce((n, a) => n + JSON.stringify(a.content).length, 0);
    const cardTotal = cards.reduce((n, c) => n + c.chars, 0);
    assert.ok(full > cardTotal * 3, `接口卡应显著小于全文：全文 ${full} vs 接口 ${cardTotal}`);
  } finally {
    await f.cleanup();
  }
});

test('🔴 预算用完时，被丢掉的工件要**记进审计报告**，不能悄悄消失', async () => {
  const f = await fixture();
  try {
    await seedFatProject(f.store);
    const sel = select(f.store, backendReq, 6_000);
    assert.ok(sel.report.omitted.length > 0, '预算很小时必然有工件进不去，必须被记下来');
    for (const o of sel.report.omitted) {
      assert.ok(['tier-cap', 'no-space'].includes(o.reason), '必须说明是「预算不够」还是「本层额度用完」');
      assert.equal(typeof o.chars, 'number');
    }
    const totalHeads = f.store.heads().length;
    const accounted = sel.report.injected.length + sel.report.omitted.length;
    assert.ok(
      accounted >= totalHeads - 2,
      `头部工件共 ${totalHeads} 个，注入+丢弃只覆盖 ${accounted} 个 —— 有工件既没进上下文也没被记录`,
    );
  } finally {
    await f.cleanup();
  }
});

test('代码类工件按原文渲染：不做 JSON 转义（转义会把代码压成一行，模型难读也更费 token）', () => {
  const body = renderArtifactBody({
    files: [{ path: 'src/api/a.ts', content: 'export function f() {\n  return "x";\n}\n' }],
  });
  assert.ok(body.includes('\n  return "x";'), '代码必须保留真实换行与引号');
  assert.ok(!body.includes('\\n'), '不许出现 JSON 转义出来的字面 \\n');
  assert.ok(body.includes('<<<FILE src/api/a.ts>>>'), '必须有文件名分隔，否则模型不知道这是哪个文件');
});

test('非代码工件用紧凑 JSON（不再有 2 空格缩进的浪费）', () => {
  const content = { requirements: [{ id: 'R-001', text: 'x'.repeat(500) }] };
  const compact = renderArtifactBody(content);
  assert.equal(compact, JSON.stringify(content), '非代码工件应当是紧凑 JSON');
  assert.ok(compact.length < JSON.stringify(content, null, 2).length, '紧凑序列化必须更短');
});

test('导出签名抽取：只认导出声明，跳过再导出与实现正文', () => {
  const sigs = extractExportedSignatures(
    [
      "import type { X } from './x.ts';",
      'export function handleA(req: Request): Response {',
      '  return null as never;',
      '}',
      'export async function handleB(',
      '  req: Request,',
      '  res: Response,',
      '): Promise<void> {}',
      'export const PATHS = ["/api/a"];',
      'export interface Thing { id: string }',
      'export type Alias = string;',
      'export { local as remote };',
      'export * from "./other.ts";',
      'export default function () {}',
      'function notExported() {}',
    ].join('\n'),
  );
  assert.ok(sigs.includes('export function handleA(req: Request): Response'));
  assert.ok(sigs.some((s) => s.includes('handleB') && s.includes('Promise<void>')), '跨行签名要拼成一行');
  assert.ok(sigs.includes('export const PATHS'));
  assert.ok(sigs.includes('export interface Thing'));
  assert.ok(sigs.includes('export type Alias = string'));
  assert.ok(!sigs.some((s) => s.includes('remote')), '再导出不含实现信息，不该列出');
  assert.ok(!sigs.some((s) => s.includes('notExported')), '非导出不该列出');
  assert.ok(!sigs.some((s) => s.includes('return null')), '不许把函数体带进来');
  assert.ok(!sigs.some((s) => s.includes('export default')), '默认导出没有名字，列出来没用');
});

test('renderModuleCards：每个文件带路径、总长受限（截断时显式说明）', () => {
  const text = renderModuleCards([
    {
      id: 'CodeModule-T-001',
      version: 1,
      files: [
        { path: 'src/api/a.ts', content: 'export function a(): void {}\n' },
        { path: 'src/api/b.ts', content: 'export const b = 1;\n' },
      ],
    },
  ]);
  assert.ok(text.includes('@@ src/api/a.ts') && text.includes('@@ src/api/b.ts'));
  assert.ok(text.includes('export function a(): void'));

  const tiny = renderModuleCards(
    [
      {
        id: 'M',
        version: 1,
        files: [
          {
            path: 'f.ts',
            // 必须是**互不相同**的导出：同名声明会被去重，
            // 用重复行造不出「超长」的接口卡。
            content: Array.from({ length: 200 }, (_, i) => `export const x${i} = ${i};`).join('\n'),
          },
        ],
      },
    ],
    { maxTotalChars: 100 },
  );
  assert.ok(tiny.length <= 140, `超限必须截断，实际 ${tiny.length}`);
  assert.ok(tiny.includes('截断'), '截断必须写出来，不能静默');
});

// ════════════════════════════════════════════════════════════════

/** 极简假 Provider：按脚本返回或抛错，并记录收到的请求。 */
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  calls: LlmRequest[] = [];
  private step = 0;
  // ⚠️ 不能用参数属性（`constructor(private readonly script)`）：
  // Node 的 strip-only 类型剥离不支持它，会在加载期直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  private readonly script: Array<{ json?: unknown; error?: string }>;
  constructor(script: Array<{ json?: unknown; error?: string }>) {
    this.script = script;
  }
  capabilities() {
    return Promise.resolve({ jsonSchema: 'strict' as const, toolCalling: false, streaming: false });
  }
  complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const s = this.script[Math.min(this.step++, this.script.length - 1)]!;
    if (s.error) return Promise.reject(new Error(s.error));
    return Promise.resolve({
      provider: this.name,
      model: 'm',
      text: JSON.stringify(s.json ?? {}),
      json: s.json ?? {},
      usage: { promptTokens: 1, completionTokens: 1 },
      latencyMs: 1,
      runId: 'run-test',
    });
  }
}

test('🔴 输入审计：run 日志里必须能查到「注入了什么、丢了什么」', async () => {
  const f = await fixture();
  try {
    await seedFatProject(f.store);
    const provider = new ScriptedProvider([{ json: { files: [{ path: 'src/api/new.ts', content: 'export const a = 1;\n' }] } }]);
    const recorder = new JsonlRunRecorder(join(f.dir, 'runs'), 'run-audit');
    const runner = new LlmRoleRunner({ role: 'backend', provider: new RecordingProvider({ inner: provider, recorder }) });

    const res = await runner.produce(backendReq, ctxOf(f.store));
    assert.equal(res.content !== null, true);

    const lines = (await readFile(join(f.dir, 'runs', 'run-audit.jsonl'), 'utf8')).trim().split('\n');
    const rec = JSON.parse(lines[0]!);
    assert.ok(rec.context, '记录里必须有 context 字段 —— 没有它，「为什么老是做不对」只能靠猜');
    assert.equal(typeof rec.context.budget, 'number');
    assert.ok(rec.context.injected.length > 0, '至少要记下注入了哪些工件');
    assert.ok(
      rec.context.injected.some((x: { kind: string }) => x.kind === 'Contract'),
      '审计记录里必须能看到契约进没进上下文',
    );
    assert.equal(rec.context.used, rec.context.injected.reduce((n: number, x: { chars: number }) => n + x.chars, 0));
  } finally {
    await f.cleanup();
  }
});

test('🔴 上下文超长时自动减半重试，而不是让整轮 run 死掉', async () => {
  const f = await fixture();
  try {
    await seedFatProject(f.store);
    const provider = new ScriptedProvider([
      { error: "400 This model's maximum context length is 65536 tokens, please reduce the length of the messages." },
      { json: { files: [{ path: 'src/api/new.ts', content: 'export const a = 1;\n' }] } },
    ]);
    const runner = new LlmRoleRunner({ role: 'backend', provider, maxContextChars: 60_000 });

    const res = await runner.produce(backendReq, ctxOf(f.store));
    assert.notEqual(res.content, null, '自适应之后应当成功，而不是把整轮 run 打死');
    assert.equal(provider.calls.length, 2);
    assert.equal(provider.calls[0]!.context!.budget, 60_000);
    assert.equal(provider.calls[1]!.context!.budget, 30_000, '预算必须减半重试');
    assert.equal(res.attempts, 1, '「上下文超长」不该算作一次产出失败消耗重试次数');
  } finally {
    await f.cleanup();
  }
});

test('非上下文类错误照旧直接抛出（不要把所有错误都当成「预算问题」吞掉）', async () => {
  const f = await fixture();
  try {
    await seedFatProject(f.store);
    const provider = new ScriptedProvider([{ error: '401 invalid api key' }]);
    const runner = new LlmRoleRunner({ role: 'backend', provider, maxContextChars: 60_000 });
    await assert.rejects(() => runner.produce(backendReq, ctxOf(f.store)), /401 invalid api key/);
    assert.equal(provider.calls.length, 1, '认证错误不该被重试成「预算减半」');
  } finally {
    await f.cleanup();
  }
});
