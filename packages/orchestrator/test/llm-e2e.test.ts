import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { DecisionLog, silentLogger, type ProjectProfile } from '../../core/src/index.ts';
import {
  ReplayProvider,
  buildLlm,
  listRuns,
  loadRunRecords,
  parseConfig,
  type ForgeConfig,
} from '../../llm/src/index.ts';
import { createBoundRoleRunners } from '../../roles/src/index.ts';
import { SemanticVerifier } from '../../roles/src/verify.ts';
import { FakeOpenAiServer } from '../../llm/test/fake-server.ts';
import { Orchestrator, type RunSummary } from '../src/orchestrator.ts';
import { API_CODE, TOKENS_PER_CALL, rolePlayer } from './role-player.ts';

// ════════════════════════════════════════════════════════════════

async function write(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function scaffold(root: string): Promise<ProjectProfile> {
  await write(
    root,
    'package.json',
    JSON.stringify(
      { name: 'p2-e2e', version: '1.0.0', dependencies: { 'leftpad-real': '^1.0.0' }, scripts: {} },
      null,
      2,
    ),
  );
  await write(
    root,
    'node_modules/leftpad-real/package.json',
    JSON.stringify({ name: 'leftpad-real', version: '1.0.0', types: 'index.d.ts', main: 'index.js' }, null, 2),
  );
  await write(
    root,
    'node_modules/leftpad-real/index.d.ts',
    'export declare function padLeft(s: string, n: number): string;\n',
  );
  return {
    name: 'p2-e2e',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: { cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
    test: { cmd: process.execPath, args: ['-e', "console.log('# pass 3\\n# fail 0')"] },
    run: null,
    knownPackages: ['lodash', 'express'],
    dependencyAllowlist: null,
  };
}

function configFor(server: FakeOpenAiServer, root: string, over: Record<string, unknown> = {}): ForgeConfig {
  return parseConfig({
    version: 1,
    providers: {
      fake: {
        kind: 'openai-compat',
        baseUrl: server.baseUrl,
        apiKey: 'test',
        defaultModel: 'role-player',
        jsonMode: (over.jsonMode as string) ?? 'auto',
        backoffMs: 1,
      },
    },
    roles: {
      // 刻意让五个角色用不同模型名，验证「每角色可绑定不同模型」真的生效
      pm: { provider: 'fake', model: 'pm-model', temperature: 0.3 },
      frontend: { provider: 'fake', model: 'fe-model' },
      backend: { provider: 'fake', model: 'be-model' },
      test: { provider: 'fake', model: 'test-model' },
      host: { provider: 'fake', model: 'host-model', temperature: 0.1 },
    },
    budget: (over.budget as object) ?? { totalTokens: 10_000_000, onExceed: 'stop' },
    probe: { enabled: over.probe !== false, useCache: false },
    runsDir: join(root, 'runs'),
  });
}

async function runPipeline(
  root: string,
  server: FakeOpenAiServer,
  over: Record<string, unknown> = {},
): Promise<{ summary: RunSummary; built: Awaited<ReturnType<typeof buildLlm>> }> {
  const config = configFor(server, root, over);
  const built = await buildLlm(config, { root, runId: 'e2e-run', probe: over.probe !== false, record: true });
  const runners = createBoundRoleRunners(built.roleProviders, config.roles);
  const orch = new Orchestrator({
    projectRoot: root,
    profile: await scaffold(root),
    userBrief: '做一个任务看板：能创建任务，也能列出全部任务。',
    runners,
    verifier: new SemanticVerifier({ provider: built.roleProviders.test, logger: silentLogger('v') }),
    provider: built.roleProviders.pm,
    humanAvailable: false,
    offline: true,
    log: new DecisionLog(root),
    logger: silentLogger('e2e'),
  });
  const summary = await orch.run();
  return { summary, built };
}

// ════════════════════════════════════════════════════════════════

test('P2 端到端：真实 HTTP Provider（含能力探测）驱动完整流水线到 DELIVERED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-p2-'));
  const server = await new FakeOpenAiServer(rolePlayer()).start();
  try {
    const { summary, built } = await runPipeline(root, server);

    assert.equal(summary.delivery, 'complete', JSON.stringify(summary.traces, null, 2));
    assert.equal(summary.finalStage, 'DELIVERED');

    // 能力探测真的跑过，并得出 strict（因为假端点接受 json_schema）
    assert.equal(built.probes.length > 0, true);
    assert.equal(built.probes[0].jsonSchema, 'strict');
    assert.equal(built.probes[0].strictNeedsSanitize, true, '我们的工件 schema 需要兼容转换');

    // 每角色绑定不同模型 —— 请求体里的 model 字段应该各不相同
    const models = new Set(server.requests.map((r) => r.body.model));
    for (const m of ['pm-model', 'be-model', 'fe-model', 'test-model', 'host-model']) {
      assert.ok(models.has(m), `应有以 ${m} 发出的请求，实际：${[...models].join(', ')}`);
    }

    // 契约生成物写到磁盘（A7 检查它存在）
    const gen = await readFile(join(root, 'shared/contract/types.ts'), 'utf8');
    assert.ok(gen.includes('export interface Task'));

    // 预算记账：每次响应 300+120=420 tokens
    //
    // 注意探测流量**刻意不计入**角色预算：探测是「了解端点能力」的基础设施动作，
    // 不是某个角色的工作量，把它算进角色限额会让「探测几个模型」直接吃掉角色的额度。
    // 这一点是设计意图，所以这里显式把它减掉再断言。
    const probeCalls = server.requests.filter(
      (r) => (r.body.response_format as { json_schema?: { name?: string } })?.json_schema?.name === 'Probe',
    ).length;
    assert.ok(probeCalls > 0, '本用例启用了探测，应当能看到探测请求');
    const budget = built.budget!.snapshot();
    assert.equal(budget.totalTokens, (server.callCount - probeCalls) * TOKENS_PER_CALL, '账目必须与真实角色调用次数吻合');

    // 调用记录与决策日志
    const runs = await listRuns(join(root, 'runs'));
    assert.deepEqual(runs.map((r) => r.runId), ['e2e-run']);
    const log = new DecisionLog(root);
    await log.init();
    assert.deepEqual(await log.verify(), { ok: true });
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('P2 端到端：离线回放整条流水线，结果与原始 run 完全一致（零成本、无网络）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-p2-replay-'));
  const server = await new FakeOpenAiServer(rolePlayer()).start();
  let original: RunSummary | undefined;
  try {
    original = (await runPipeline(root, server)).summary;
  } finally {
    await server.stop();
  }

  const replayRoot = await mkdtemp(join(tmpdir(), 'af-p2-replay-ws-'));
  // 一个「必然失败」的端点：如果回放期间有任何真实请求，测试就会暴露
  const deadServer = await new FakeOpenAiServer(() => ({ status: 500, body: { error: { message: 'should not be called' } } })).start();
  try {
    const records = await loadRunRecords(join(root, 'runs'), 'e2e-run');
    assert.ok(records.length > 5, `应录到多次调用，实际 ${records.length}`);

    const config = configFor(deadServer, replayRoot, { probe: false });
    const replayer = new ReplayProvider({ records });
    const providers = Object.fromEntries(
      (['pm', 'frontend', 'backend', 'test', 'host'] as const).map((r) => [r, replayer]),
    ) as Record<'pm' | 'frontend' | 'backend' | 'test' | 'host', ReplayProvider>;

    await scaffold(replayRoot);
    const runners = createBoundRoleRunners(providers, config.roles);
    const orch = new Orchestrator({
      projectRoot: replayRoot,
      profile: await scaffold(replayRoot),
      userBrief: '做一个任务看板：能创建任务，也能列出全部任务。',
      runners,
      verifier: new SemanticVerifier({ provider: providers.test, logger: silentLogger('v') }),
      provider: providers.pm,
      humanAvailable: false,
      offline: true,
      log: new DecisionLog(replayRoot),
      logger: silentLogger('replay'),
    });
    const replayed = await orch.run();

    assert.equal(deadServer.callCount, 0, '回放期间不得发起任何真实请求');
    assert.equal(replayed.delivery, original!.delivery);
    assert.equal(replayed.finalStage, original!.finalStage);
    assert.deepEqual(
      replayed.traces.map((t) => [t.stage, t.finalAction]),
      original!.traces.map((t) => [t.stage, t.finalAction]),
      '回放必须复现同样的阶段轨迹 —— 这正是回放存在的理由',
    );

    // 重新生成的代码与首次一致
    const api = await readFile(join(replayRoot, 'src/api/routes.ts'), 'utf8');
    const api0 = await readFile(join(root, 'src/api/routes.ts'), 'utf8');
    assert.equal(api, api0);
    assert.ok(api.includes('padLeft'));
  } finally {
    await deadServer.stop();
    await rm(replayRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('P2 端到端：端点拒绝严格模式时，流水线仍能跑通（自动降级到 json-mode）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-p2-degrade-'));
  // 拒绝 json_schema，接受 json_object
  const server = await new FakeOpenAiServer((ctx) => {
    const rf = ctx.body.response_format as { type?: string } | undefined;
    if (rf?.type === 'json_schema') {
      return { status: 400, body: { error: { message: "response_format 'json_schema' not supported" } } };
    }
    return rolePlayer()(ctx);
  }).start();
  try {
    const { summary, built } = await runPipeline(root, server);
    assert.equal(built.probes[0].jsonSchema, 'json-mode', '应探测到端点不支持严格模式');
    assert.ok(
      built.probes[0].evidence.some((e) => e.includes('严格模式探测失败（capability）')),
      `降级原因必须留证，实际：${JSON.stringify(built.probes[0].evidence)}`,
    );
    assert.equal(built.probes[0].fatal, undefined, '能力问题不是致命问题，应当降级继续');
    // 降级后仍应跑通（约束由提示词 + 本地 schema 校验 + 结构化重试承担）
    assert.equal(summary.delivery, 'complete', JSON.stringify(summary.traces, null, 2));

    // 关键断言：**探测之外**不应再出现 json_schema 请求。
    // 探测自身会先试一次 strict 再降级（每个被用到的 provider|model 各一次），那是探测的正常代价。
    const allStrict = server.requests.filter(
      (r) => (r.body.response_format as { type?: string })?.type === 'json_schema',
    ).length;
    const probeStrict = server.requests.filter(
      (r) =>
        (r.body.response_format as { type?: string })?.type === 'json_schema' &&
        (r.body.response_format as { json_schema?: { name?: string } })?.json_schema?.name === 'Probe',
    ).length;
    assert.equal(allStrict, probeStrict, `探测之外不得再发 json_schema（探测 ${probeStrict} 次，总计 ${allStrict} 次）`);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('P2 端到端：预算 stop 超限时流水线不被静默放行（走逃生层而不是崩溃）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-p2-budget-'));
  const server = await new FakeOpenAiServer(rolePlayer()).start();
  try {
    // 每次响应 420 tokens；给一个很小的预算让它在流水线中途超限
    const { summary } = await runPipeline(root, server, {
      budget: { totalTokens: 900, onExceed: 'stop' },
      probe: false,
    });
    assert.notEqual(summary.delivery, 'complete', '预算耗尽不应报「完整交付」');
    assert.ok(
      summary.traces.some((t) =>
        t.blockedReasons.some((r) => r.startsWith('production-failed') || r.startsWith('review-failed')),
      ),
      `预算超限应被当作受控路径而非崩溃，实际：${JSON.stringify(summary.traces.map((t) => t.blockedReasons))}`,
    );
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('P2 端到端：产物被真实写盘，且 API 代码来自 HTTP 响应（不是测试内部构造）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-p2-artifacts-'));
  const server = await new FakeOpenAiServer(rolePlayer()).start();
  try {
    await runPipeline(root, server);
    const api = await readFile(join(root, 'src/api/routes.ts'), 'utf8');
    assert.equal(api, API_CODE, '磁盘上的代码必须与端点返回的内容一致');
    // 决策日志里应记得住契约冻结与生成的类型文件
    const log = new DecisionLog(root);
    await log.init();
    const frozen = log.find('artifact.frozen');
    assert.equal(frozen.length, 1, '契约冻结必须留痕');
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
