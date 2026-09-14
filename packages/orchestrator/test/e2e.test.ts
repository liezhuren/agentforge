import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { DecisionLog, EventBus, silentLogger, type ForgeEvent, type ProjectProfile } from '../../core/src/index.ts';
import { MockProvider } from '../../llm/src/index.ts';
import { createRoleRunners } from '../../roles/src/index.ts';
import { SemanticVerifier } from '../../roles/src/verify.ts';
import { Orchestrator, requirementStatusForVerdict } from '../src/orchestrator.ts';

// ════════════════════════════════════════════════════════════════
// 项目脚手架（模拟一个真实的 TS 项目：package.json + 已安装依赖）
// ════════════════════════════════════════════════════════════════

async function write(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

// 用 node 造出确定性结果：真实环境里这里会是真实的 tsc / 测试运行器。
// 抽成常量是为了让「动态重推 profile」的测试能复用同一份命令定义 ——
// 两处各写一份迟早会漂移。
const TYPECHECK_CMD = { cmd: process.execPath, args: ['-e', 'process.exit(0)'] };
const TEST_CMD = { cmd: process.execPath, args: ['-e', "console.log('# pass 4\\n# fail 0')"] };

async function scaffoldProject(root: string): Promise<ProjectProfile> {
  await write(
    root,
    'package.json',
    JSON.stringify({ name: 'task-board', version: '1.0.0', dependencies: { 'leftpad-real': '^1.0.0' } }, null, 2),
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
    name: 'task-board',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    // 用 node 造出确定性结果：真实环境里这里会是真实的 tsc / 测试运行器
    typecheck: TYPECHECK_CMD,
    test: TEST_CMD,
    run: null,
    knownPackages: ['lodash', 'express', 'react'],
    dependencyAllowlist: null,
  };
}

const USER_BRIEF = '做一个任务看板：能创建任务，也能列出全部任务。';

// ════════════════════════════════════════════════════════════════
// Mock 脚本：一个「各方面都合规」的项目
// ════════════════════════════════════════════════════════════════

const API_CODE = [
  "import { padLeft } from 'leftpad-real';",
  "import type { Task } from '../../shared/contract/types';",
  '',
  'const store: Task[] = [];',
  '',
  'export function listTasks(): Task[] {',
  '  return store;',
  '}',
  '',
  'export function createTask(title: string): Task {',
  '  const task: Task = { id: padLeft(String(store.length + 1), 4), title };',
  '  store.push(task);',
  '  return task;',
  '}',
  '',
  "export const ROUTES = ['/api/tasks'];",
  '',
].join('\n');

const WEB_CODE = [
  "import type { Task } from '../../shared/contract/types';",
  '',
  'export async function loadTasks(): Promise<Task[]> {',
  "  const res = await fetch('/api/tasks');",
  '  return res.json();',
  '}',
  '',
  'export async function addTask(title: string): Promise<Task> {',
  "  const res = await fetch('/api/tasks', { method: 'POST', body: JSON.stringify({ title }) });",
  '  return res.json();',
  '}',
  '',
].join('\n');

function happyScript(over: Record<string, unknown> = {}) {
  return {
    'produce:Requirement': {
      requirements: [
        {
          id: 'R-001',
          text: '用户可以创建任务',
          acceptance: ['POST /api/tasks 返回 201 且任务被持久化'],
          priority: 'must',
          status: 'open',
          origin: 'user',
        },
        {
          id: 'R-002',
          text: '用户可以列出全部任务',
          acceptance: ['GET /api/tasks 返回 200 且包含已创建的任务'],
          priority: 'must',
          status: 'open',
          origin: 'user',
        },
      ],
    },
    'produce:PRD': {
      title: '任务看板 PRD',
      summary: '提供任务的创建与查询能力，覆盖两条 must 级需求。',
      requirementIds: ['R-001', 'R-002'],
      milestones: [{ name: 'M1', deliverables: ['REST API', '前端数据层'] }],
      nonGoals: ['不做多租户', '不做权限系统'],
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
          acceptance: ['A4 锚点 PASS'],
        },
      ],
    },
    'produce:Contract': {
      version: 1,
      openapi: { openapi: '3.1.0', paths: { '/api/tasks': {} } },
      jsonSchemas: {
        Task: {
          type: 'object',
          required: ['id', 'title'],
          properties: { id: { type: 'string' }, title: { type: 'string' } },
        },
      },
      generatedTypesPath: 'shared/contract/types.ts',
      changeRequests: [],
    },
    'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
    'produce:CodeModule:web': { files: [{ path: 'src/web/client.ts', content: WEB_CODE }] },
    'produce:TestSuite': {
      framework: 'node:test',
      files: [
        {
          path: 'tests/tasks.test.ts',
          content: [
            "import { test } from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { createTask, listTasks } from '../src/api/routes.ts';",
            '',
            "test('创建任务后可以列出它', () => {",
            "  const t = createTask('写代码');",
            '  assert.equal(t.title, "写代码");',
            '  assert.ok(listTasks().length >= 1);',
            '});',
            '',
          ].join('\n'),
        },
      ],
      covers: ['R-001', 'R-002'],
    },
    'produce:AnchoredReview': { stage: 'REVIEW', objections: [], noObjection: true },
    'verify:requirements': {
      requirementVerdicts: [
        {
          requirementId: 'R-001',
          verdict: 'met',
          rationale: 'createTask 已实现并在测试中被验证',
          evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 10, endLine: 14, expect: 'createTask' }],
        },
        {
          requirementId: 'R-002',
          verdict: 'met',
          rationale: 'listTasks 已实现',
          evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8, expect: 'listTasks' }],
        },
      ],
    },
    ...over,
  };
}

async function setup(
  script: Record<string, unknown>,
  opts: {
    humanAvailable?: boolean;
    maxCyclesPerStage?: number;
    profileOverride?: Partial<ProjectProfile>;
    refreshProfile?: (base: ProjectProfile) => Promise<{ profile: ProjectProfile; notes?: string[] } | null>;
    bus?: EventBus;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'af-e2e-'));
  const profile = { ...(await scaffoldProject(root)), ...(opts.profileOverride ?? {}) };
  const provider = new MockProvider({ script });
  const runners = createRoleRunners(provider);
  const verifier = new SemanticVerifier({ provider });
  const log = new DecisionLog(root);

  const orch = new Orchestrator({
    projectRoot: root,
    profile,
    userBrief: USER_BRIEF,
    runners,
    verifier,
    provider,
    humanAvailable: opts.humanAvailable ?? false,
    offline: true,
    log,
    logger: silentLogger('e2e'),
    ...(opts.maxCyclesPerStage ? { maxCyclesPerStage: opts.maxCyclesPerStage } : {}),
    ...(opts.refreshProfile ? { refreshProfile: opts.refreshProfile } : {}),
    ...(opts.bus ? { bus: opts.bus } : {}),
  });

  return {
    root,
    provider,
    orch,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ════════════════════════════════════════════════════════════════
// 验收用例 1：全部工件合法 → 一次通过到 DELIVERED
// ════════════════════════════════════════════════════════════════

test('端到端：全部合规的项目一次通过到 DELIVERED', async () => {
  const { root, orch, cleanup } = await setup(happyScript());
  try {
    const summary = await orch.run();

    assert.equal(summary.delivery, 'complete', JSON.stringify(summary.traces, null, 2));
    assert.equal(summary.finalStage, 'DELIVERED');
    assert.deepEqual(
      summary.traces.map((t) => t.stage),
      ['INTAKE', 'PLANNING', 'CONTRACTING', 'BUILDING', 'REVIEW'],
    );
    for (const t of summary.traces) {
      assert.ok(t.finalAction.startsWith('ADVANCE'), `${t.stage} 应正常推进，实际 ${t.finalAction}`);
    }

    // 主理人只在 REVIEW 阶段被唤醒 —— 其余阶段不该浪费一次模型调用
    const hostStages = summary.traces.filter((t) => t.hostInvoked).map((t) => t.stage);
    assert.deepEqual(hostStages, ['REVIEW']);

    // 一个干净的项目里，主理人不该有任何误报（precision 应为 1）
    assert.equal(summary.ledger.precision, 1);
    assert.equal(summary.ledger.falsePositives, 0);
    assert.equal(summary.debtIds.length, 0, '不该有技术债');

    // 契约生成物必须真的写到磁盘上了（A7 锚点会检查它存在）
    const gen = await readFile(join(root, 'shared/contract/types.ts'), 'utf8');
    assert.ok(gen.includes('export interface Task'), gen);
    assert.ok(gen.includes('API_PATHS'));
    assert.ok(gen.includes('请勿手工编辑'));

    // 代码真的落到磁盘、可被锚点检查
    const api = await readFile(join(root, 'src/api/routes.ts'), 'utf8');
    assert.ok(api.includes('leftpad-real'));

    // 决策日志哈希链完整（历史不可改写）
    const log = new DecisionLog(root);
    await log.init();
    assert.deepEqual(await log.verify(), { ok: true });
    assert.ok(log.length > 10, `决策日志应记录全流程，实际 ${log.length} 条`);
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例 2：幻觉包 → A 层硬失败 → **不叫主理人**，直接派工单
// ════════════════════════════════════════════════════════════════

test('【关键】能归因就打回：一条归不了因，不得把整个阶段拖进圆桌', async () => {
  // 真实 LLM 实测改正（docs/07 §L10）。原来的判定是
  //   `t4 = roles.length >= 2 || hasUnresolved`
  // 即**只要有一条归不了因**，整个阶段就判定「需要开会」。
  // 后果：同一轮里 A2 已经明确归到 backend、本可以直接打回返工，
  // 却因为另一个文件归不了因而陪着进圆桌 —— 而圆桌的成本高出一到两个数量级。
  //
  // 正确优先级：能归因就打回，**一条都归不了因才开会**。先做能做的事。
  const hallucinated = API_CODE.replace(
    "import { padLeft } from 'leftpad-real';",
    "import { padLeft, padRigth } from 'leftpad-real';",
  );

  const { root, orch, cleanup } = await setup(
    happyScript({
      'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: hallucinated }] },
      'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
      // 打回之后 backend 修好了幻觉符号，但那个游离文件的坏导入仍在、
      // 且它不属于任何工件 ⇒ 归因依然缺失 ⇒ 这一轮才真的需要圆桌。
      // （这正是设计的意图：**先做完能做的事，剩下的才开会。**）
      'roundtable:pm': {
        claim: '无法判断 src/loose.ts 属于谁的产出，需要补上归属信息',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }],
      },
      'roundtable:frontend': {
        claim: '文件不在我的工件清单里',
        evidence: [{ kind: 'file', path: 'src/web/client.ts', startLine: 1, endLine: 2 }],
      },
      'roundtable:backend': {
        claim: '文件不在我的工件清单里',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8 }],
      },
      'roundtable:test': {
        claim: '该文件未被任何工件声明',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }],
      },
      'roundtable:resolution': {
        attribution: 'SHARED',
        decision: 'src/loose.ts 未被任何 CodeModule 工件声明，先由后端把它纳入工件归属再判定',
        actions: [
          { owner: 'backend', action: '把 src/loose.ts 纳入 CodeModule 工件声明', acceptance: ['A3 锚点 PASS'] },
        ],
      },
    }),
  );
  try {
    // 额外丢一个「不属于任何 CodeModule 工件」的文件到磁盘上，制造一条归不了因的失败：
    // src/loose.ts 的导入指向不存在的模块 ⇒ A3 硬失败，且无法判断该归给谁。
    await write(root, 'src/loose.ts', "import { nothing } from './does-not-exist';\nexport const x = nothing;\n");

    const summary = await orch.run();

    // A2（幻觉符号，能归因到 backend）与 A3（游离文件，归不了因）同时硬失败。
    const building = summary.traces.find((t) => t.stage === 'BUILDING')!;
    const actions = building.nextActions;

    // ① **首次动作必须是打回**，而不是开会：
    //    有可归责的对象时先让它返工 —— 打回比开圆桌便宜一到两个数量级。
    assert.ok(
      actions[0]?.includes('RETRY_ROLE') && actions[0]?.includes('backend'),
      `首个动作应当是把能归因的失败打回给 backend，实际：${JSON.stringify(actions)}`,
    );

    // ② 开会次数必须有界。
    //    修复前这里会连开 7 次 T4 直到撞上阶段循环上限（真实 LLM 上更贵）——
    //    根因是「硬失败签名」只在 RETRY_ROLE 分支更新，圆桌分支从不更新，
    //    于是圆桌之后的下一轮拿当前签名去比一个过期值，「签名未变」永远不成立、
    //    「不为没变化的失败反复开会」那道闸门形同虚设。
    const roundtableCount = actions.filter((a) => a.includes('ROUNDTABLE')).length;
    assert.ok(
      roundtableCount <= 1,
      `归不了因的失败至多开一次圆桌；实际开了 ${roundtableCount} 次：${JSON.stringify(actions)}`,
    );

    // ③ 且最终必须收敛到逃生流程，而不是无限循环
    assert.ok(
      building.blockedReasons.includes('repair-ineffective') || building.blockedReasons.includes('stage-cycle-limit'),
      `反复无效之后应当转逃生流程，实际阻断原因：${JSON.stringify(building.blockedReasons)}`,
    );
    assert.notEqual(summary.delivery, 'complete', '这个场景本来就修不好（游离文件无人认领），应当带债或升级真人');
  } finally {
    await cleanup();
  }
});

test('端到端：注入幻觉符号 → A 层硬失败时不唤醒主理人，直接机械派工单', async () => {
  const hallucinated = API_CODE.replace(
    "import { padLeft } from 'leftpad-real';",
    "import { padLeft, padRigth } from 'leftpad-real';",
  );
  const providerCallsBefore: string[] = [];

  const { root, orch, provider, cleanup } = await setup(
    happyScript({
      'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: hallucinated }] },
      // 修复后返回正确的代码
      'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
    }),
  );
  try {
    void providerCallsBefore;
    const summary = await orch.run();

    // BUILDING 阶段的第一次 Gate 应因 A2 硬失败而阻断，且**没有**唤醒主理人
    const building = summary.traces.find((t) => t.stage === 'BUILDING')!;
    assert.ok(building.blockedReasons.includes('ANCHOR_HARD_FAIL'));
    assert.equal(
      provider.callCount('produce:AnchoredReview'),
      1,
      '主理人只应在最终 REVIEW 阶段被调用一次，不得因 A 层失败被反复叫来',
    );

    // 工单被机械归因并派给后端
    const apiOrders = summary.workOrders.filter((w) => w.to === 'backend');
    assert.ok(apiOrders.length >= 1, '应生成派给后端的工单');
    assert.ok(
      apiOrders.some((o) => o.acceptance.some((a) => a.includes('A2 锚点'))),
      `工单验收条件应指向 A2 锚点，实际：${JSON.stringify(apiOrders.map((o) => o.acceptance))}`,
    );

    // 修复后必须能通过
    assert.equal(summary.delivery, 'complete', JSON.stringify(summary.traces, null, 2));
    const fixed = await readFile(join(root, 'src/api/routes.ts'), 'utf8');
    assert.ok(!fixed.includes('padRigth'), '修复后的代码不应再包含幻觉符号');
  } finally {
    await cleanup();
  }
});

test('端到端：注入编造的模块路径 → A3 硬失败 → 归因到后端', async () => {
  const bad = API_CODE.replace(
    "import type { Task } from '../../shared/contract/types';",
    "import type { Task } from './nonexistent-repo.ts';",
  );
  const { orch, cleanup } = await setup(
    happyScript({
      'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: bad }] },
      'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
    }),
  );
  try {
    const summary = await orch.run();
    const order = summary.workOrders.find((w) => w.to === 'backend');
    assert.ok(order, '应有派给后端的工单');
    assert.ok(
      order!.acceptance.some((a) => a.includes('A3 锚点')),
      JSON.stringify(order!.acceptance),
    );
    assert.equal(summary.delivery, 'complete');
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例 4：B1 提议引用不存在的行 → 判定作废
// ════════════════════════════════════════════════════════════════

test('端到端：语义验证编造证据 → B1 判 INVALID_EVIDENCE 并派工单要求补证据', async () => {
  const { orch, cleanup } = await setup(
    happyScript({
      'verify:requirements': {
        requirementVerdicts: [
          {
            requirementId: 'R-001',
            verdict: 'met',
            rationale: '我写了实现',
            evidenceRefs: [{ kind: 'file', path: 'src/api/does-not-exist.ts', startLine: 1, endLine: 5 }],
          },
          {
            requirementId: 'R-002',
            verdict: 'met',
            rationale: '也写了',
            evidenceRefs: [{ kind: 'file', path: 'src/api/does-not-exist.ts', startLine: 1, endLine: 5 }],
          },
        ],
      },
      // 角色按工单「修复」但只是重新提交同样的代码，问题依旧
      'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
    }),
    { maxCyclesPerStage: 2 },
  );
  try {
    const summary = await orch.run();
    // 证据核验失败 → B1 硬失败 → 生成工单（而不是静默通过）
    assert.ok(summary.workOrders.length > 0, '应有的工单');
    const all = summary.workOrders.flatMap((w) => w.acceptance).join('\n');
    assert.ok(all.includes('B1 锚点'), `工单验收条件应指向 B1，实际：${all}`);
    // 因为证据始终没被修正，最终必须带债而不是「完整交付」
    assert.notEqual(summary.delivery, 'complete', JSON.stringify(summary.traces, null, 2));
  } finally {
    await cleanup();
  }
});

test('Gate 不变式：REVIEW 未做达成判定时不得静默交付（SKIPPED ≠ PASS）', async () => {
  const { orch, cleanup } = await setup(
    happyScript({
      // 验证器永远拿不到合法输出 → 提议为 null → B1 SKIPPED
      'verify:requirements': { __raw: '我觉得应该都实现了吧' },
      'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
    }),
    { maxCyclesPerStage: 2 },
  );
  try {
    const summary = await orch.run();
    assert.notEqual(summary.delivery, 'complete', '未验证不得被当成通过');
    const review = summary.traces.find((t) => t.stage === 'REVIEW')!;
    assert.ok(
      summary.workOrders.some((w) => w.acceptance.some((a) => a.includes('B1 锚点'))),
      '应生成指向 B1 的补证据工单',
    );
    assert.ok(review.nextActions.length > 0);
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例 12：圆桌无决议 + 真人不可用 → 带债通过
// ════════════════════════════════════════════════════════════════

test('端到端：主理人甩锅（无法归因）→ T2 圆桌；圆桌无有效决议 + 真人不可用 → 带债通过并写 TECH_DEBT.md', async () => {
  const objection = {
    id: 'O-1',
    stage: 'REVIEW',
    author: 'host',
    targetRole: 'UNRESOLVED',
    severity: 'blocker',
    claim: '整体架构不合理，前后端职责边界不清，建议推倒重来',
    evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 19 }],
    falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    claimHash: 'aaaaaaaaaaaaaaaa',
    evidenceHash: 'bbbbbbbbbbbbbbbb',
    createdAt: new Date().toISOString(),
  };

  const { root, orch, cleanup } = await setup(
    happyScript({
      'produce:AnchoredReview': { stage: 'REVIEW', objections: [objection], noObjection: false },
      // 圆桌各方发言：都给真实证据（否则发言会被丢弃）
      'roundtable:pm': {
        claim: '需求本身没有歧义，职责边界在契约里已经写清楚了',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }],
      },
      'roundtable:frontend': {
        claim: '前端只通过契约类型与后端交互，没有越界',
        evidence: [{ kind: 'file', path: 'src/web/client.ts', startLine: 1, endLine: 2 }],
      },
      'roundtable:backend': {
        claim: '后端严格按契约实现端点，没有职责越界',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8 }],
      },
      'roundtable:test': {
        claim: '测试覆盖了两条 must 需求，未发现跨层调用',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }],
      },
      // 决议「和稀泥」：没有行动项 → 机械校验必须判无效
      'roundtable:resolution': {
        attribution: 'SHARED',
        decision: '综合考虑各方意见，大家都有道理，后续加强沟通',
        actions: [],
      },
    }),
  );
  try {
    const summary = await orch.run();

    // 主理人的甩锅异议无法归因 → 不阻断，但触发 T2 圆桌
    const review = summary.traces.find((t) => t.stage === 'REVIEW')!;
    assert.ok(
      review.nextActions.some((a) => a.includes('ROUNDTABLE(T2)')),
      `应触发 T2 圆桌，实际：${review.nextActions.join(', ')}`,
    );

    // 圆桌和稀泥决议被判无效 → 真人不可用 → 带债通过
    assert.equal(summary.delivery, 'with-debt', JSON.stringify(summary.traces, null, 2));
    assert.ok(summary.debtIds.length >= 1, '应记录技术债');

    // TECH_DEBT.md 必须真的写出来了，且如实标注
    const debt = await readFile(join(root, 'TECH_DEBT.md'), 'utf8');
    assert.ok(debt.includes('未偿技术债'));
    assert.ok(debt.includes('不是「已通过」'), '债务文件必须明确否认真实性');
    assert.ok(debt.includes('O-1'), '必须记录未解决的异议编号');

    // 受影响需求必须被标记为 ACCEPTED_WITH_DEBT（第三态），而不是 met
    assert.ok(summary.techDebtRequirements.length > 0, '应有需求被标记带债');
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例 11：圆桌产出有效决议 → 按其行动项推进
// ════════════════════════════════════════════════════════════════

test('端到端：圆桌产出可执行决议 → 决议生效，不升级真人、不记债', async () => {
  const objection = {
    id: 'O-2',
    stage: 'REVIEW',
    author: 'host',
    targetRole: 'UNRESOLVED',
    severity: 'blocker',
    claim: '整体职责边界需要明确，当前无法判断该由谁负责这部分逻辑',
    evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 19 }],
    falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    claimHash: 'cccccccccccccccc',
    evidenceHash: 'dddddddddddddddd',
    createdAt: new Date().toISOString(),
  };

  const { orch, cleanup } = await setup(
    happyScript({
      'produce:AnchoredReview': { stage: 'REVIEW', objections: [objection], noObjection: false },
      'roundtable:pm': {
        claim: '边界在契约中已定义，建议以契约为准',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }],
      },
      'roundtable:frontend': {
        claim: '前端不越界',
        evidence: [{ kind: 'file', path: 'src/web/client.ts', startLine: 1, endLine: 2 }],
      },
      'roundtable:backend': {
        claim: '后端不越界',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8 }],
      },
      'roundtable:test': {
        claim: '测试覆盖充分',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }],
      },
      // 可执行决议：有明确负责人 + 可被锚点机械验证的验收条件
      'roundtable:resolution': {
        attribution: 'SHARED',
        decision: '确认以冻结契约为职责边界的唯一依据，并在代码注释中标明所属层',
        actions: [
          {
            owner: 'backend',
            action: '在 src/api/routes.ts 顶部加入分层说明注释',
            acceptance: ['A4 锚点 PASS', 'A7 锚点 PASS'],
          },
        ],
      },
    }),
  );
  try {
    const summary = await orch.run();
    // 决议有效 → 生成 roundtable-action 工单
    const rtOrders = summary.workOrders.filter((w) => w.reason.kind === 'roundtable-action');
    assert.ok(rtOrders.length >= 1, '有效决议应生成行动项工单');
    assert.equal(rtOrders[0].to, 'backend');
    assert.deepEqual(rtOrders[0].acceptance, ['A4 锚点 PASS', 'A7 锚点 PASS']);
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例 12b：第 2 轮交叉质询 —— 反驳当场执行，决议被机械证据否决
// ════════════════════════════════════════════════════════════════

test('端到端：圆桌当场执行反驳 → 机械事实确立；与事实矛盾的决议被判无效并升级真人', async () => {
  const objection = {
    id: 'O-3',
    stage: 'REVIEW',
    author: 'host',
    targetRole: 'UNRESOLVED',
    severity: 'blocker',
    claim: '整体职责边界不清，无法判断问题该归给谁',
    evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 19 }],
    falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    claimHash: 'eeeeeeeeeeeeeeee',
    evidenceHash: 'ffffffffffffffff',
    createdAt: new Date().toISOString(),
  };

  // 一条「占位测试」：只 import 了 node:test，从未 import 被测模块。
  // 因此「测试是否真的在测东西」是一个**真能跑出非零退出码**的检查 ——
  // 这正是第 2 轮要用的可执行反驳。
  const HOLLOW_TEST = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('占位：这里应当覆盖 R-001 / R-002', () => {",
    '  assert.ok(true);',
    '});',
    '',
  ].join('\n');

  const FALSIFIER =
    "node -e \"const fs=require('fs');const t=fs.readFileSync('tests/tasks.test.ts','utf8');" +
    "process.exit(/import[^;]*api\\/routes/.test(t)?0:1)\"";

  const { root, orch, cleanup } = await setup(
    happyScript({
      'produce:TestSuite': {
        framework: 'node:test',
        files: [{ path: 'tests/tasks.test.ts', content: HOLLOW_TEST }],
        // 工件**声称**覆盖了两条 must 需求 —— 但占位测试根本没有断言任何行为
        covers: ['R-001', 'R-002'],
      },
      'produce:AnchoredReview': { stage: 'REVIEW', objections: [objection], noObjection: false },
      'roundtable:pm': {
        claim: '需求本身没有歧义',
        evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }],
      },
      'roundtable:frontend': {
        claim: '前端不越界',
        evidence: [{ kind: 'file', path: 'src/web/client.ts', startLine: 1, endLine: 2 }],
      },
      // 第 1 轮：陈述立场。第 2 轮：携带一个**可执行**的反驳。
      // 轮转配对下 backend 的质询对象是 test（有效发言顺序 pm→frontend→backend→test）。
      'roundtable:backend': (req: { messages: Array<{ role: string; content: string }> }) => {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        if (!user.includes('第 2 轮')) {
          return {
            claim: '后端严格按契约实现端点',
            evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8 }],
          };
        }
        return {
          claim: '所谓「已被测试验证」是空的：测试从未 import 被测模块',
          evidence: [{ kind: 'file', path: 'tests/tasks.test.ts', startLine: 1, endLine: 6 }],
          falsifier: { kind: 'executable', command: FALSIFIER, expect: 'exit-nonzero' },
        };
      },
      'roundtable:test': {
        claim: '测试覆盖充分',
        evidence: [{ kind: 'file', path: 'tests/tasks.test.ts', startLine: 1, endLine: 2 }],
      },
      // 决议习惯性地把责任推给 pm —— 与刚被执行的机械证据（指向 test）矛盾
      'roundtable:resolution': {
        attribution: 'pm',
        decision: '需求描述过于笼统，导致测试无法落地，责任在需求侧',
        actions: [
          {
            owner: 'pm',
            action: '重写 R-001 / R-002 的验收条件，给出可观测的判定点',
            acceptance: ['A7 锚点 PASS'],
          },
        ],
      },
    }),
    { humanAvailable: true },
  );

  try {
    const summary = await orch.run();

    // ① 反驳被**当场执行**，并记为机械事实
    const minutes = await readFile(
      join(root, 'artifacts', 'RoundtableMinute', 'RoundtableMinute-001.json'),
      'utf8',
    );
    const minute = JSON.parse(minutes) as {
      content: {
        facts?: Array<{ role: string; against?: string; outcome: string; implicates: string }>;
        escalation?: string;
        invalidReason?: string;
        statements: Array<{ role: string; round: number; falsifierOutcome?: { outcome: string } }>;
      };
    };
    const facts = minute.content.facts ?? [];
    const sustained = facts.filter((f) => f.outcome === 'sustained');
    assert.equal(sustained.length, 1, `应有且仅有一条被确证的事实：${JSON.stringify(facts)}`);
    assert.equal(sustained[0].role, 'backend', '提出反驳的是 backend');
    assert.equal(sustained[0].implicates, 'test', '反驳针对 test → 事实指向 test');

    // 发言上必须留有执行结果 —— 这是「用执行结果裁决」的取证
    const backendR2 = minute.content.statements.find((s) => s.role === 'backend' && s.round === 2);
    assert.equal(backendR2?.falsifierOutcome?.outcome, 'sustained');

    // ② 与机械事实矛盾的决议被判无效，并升级真人
    assert.equal(minute.content.escalation, 'HUMAN', '无效决议必须升级真人');
    assert.ok(minute.content.invalidReason?.includes('机械证据'), minute.content.invalidReason);
    assert.equal(summary.delivery, 'awaiting-human', JSON.stringify(summary.traces, null, 2));
    assert.equal(summary.finalStage, 'REVIEW', '必须在争议阶段停下，而不是带着矛盾结论往下走');
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例 14：profile 动态重推 —— 让 A4/A5 从「没得查」变成真检查
// ════════════════════════════════════════════════════════════════

/** 跑一遍 happyScript，收集每个阶段的 Gate 结果（anchors 只能从事件流拿到）。 */
async function runCollectingGates(opts: {
  refreshProfile?: (base: ProjectProfile) => Promise<{ profile: ProjectProfile; notes?: string[] } | null>;
}): Promise<{
  gates: Array<{ stage: string; anchors: Array<{ anchorId: string; verdict: string }> }>;
  delivery: string;
  cleanup: () => Promise<void>;
}> {
  const bus = new EventBus();
  const gates: Array<{ stage: string; anchors: Array<{ anchorId: string; verdict: string }> }> = [];
  bus.on((e: ForgeEvent) => {
    if (e.t === 'gate.evaluated') {
      gates.push({ stage: String(e.result.stage), anchors: e.result.anchors as never });
    }
  });
  const { orch, cleanup } = await setup(happyScript(), {
    bus,
    // 起点：没有 typecheck / test 脚本 —— 等价于「刚建好的空工作区」
    profileOverride: { typecheck: null, test: null },
    ...(opts.refreshProfile ? { refreshProfile: opts.refreshProfile } : {}),
  });
  const summary = await orch.run();
  return { gates, delivery: summary.delivery, cleanup };
}

test('端到端：代码落盘后重推 profile，A4/A5 从「没得查（SKIPPED）」变成真的执行', async () => {
  // 这一条锁定的是真实 LLM 跑通流程时发现的缺口：
  // profile 原本只在**启动时**推导一次，而那一刻工作区是空的，
  // 于是「从零生成一个项目」这条最需要锚点把关的路径上，A4/A5 全程 SKIPPED。
  // SKIPPED ≠ PASS 是对的，但「没得查」不该是常态。
  //
  // 用对照实验表达：同一份脚本跑两遍，唯一差别是有没有 refreshProfile。
  const control = await runCollectingGates({});
  const treated = await runCollectingGates({
    refreshProfile: async (base) => ({
      profile: { ...base, typecheck: TYPECHECK_CMD, test: TEST_CMD },
      notes: [],
    }),
  });

  try {
    const pick = (
      r: Awaited<ReturnType<typeof runCollectingGates>>,
      stage: string,
      id: string,
    ) => r.gates.find((g) => g.stage === stage)?.anchors.find((a) => a.anchorId === id)?.verdict;

    // 对照组：代码写出来了，但没人告诉锚点「这个项目怎么编译」→ 只能报 SKIPPED
    assert.equal(pick(control, 'BUILDING', 'A4'), 'SKIPPED', '对照组的 A4 应当是 SKIPPED（没得查）');
    assert.equal(pick(control, 'BUILDING', 'A5'), 'SKIPPED', '对照组的 A5 应当是 SKIPPED（没得查）');

    // 实验组：重推 profile 之后，A4/A5 必须真的执行
    assert.notEqual(pick(treated, 'BUILDING', 'A4'), 'SKIPPED', '重推后 A4 必须真的执行编译检查');
    assert.notEqual(pick(treated, 'BUILDING', 'A5'), 'SKIPPED', '重推后 A5 必须真的执行测试');
    assert.equal(pick(treated, 'BUILDING', 'A4'), 'PASS');
    assert.equal(pick(treated, 'BUILDING', 'A5'), 'PASS');

    assert.equal(control.delivery, 'complete');
    assert.equal(treated.delivery, 'complete');
  } finally {
    await control.cleanup();
    await treated.cleanup();
  }
});

test('端到端：refreshProfile 抛错时沿用原 profile，不让整个 run 崩掉', async () => {
  const r = await runCollectingGates({
    refreshProfile: async () => {
      throw new Error('故意抛错：模拟推导 profile 失败');
    },
  });
  try {
    // 推导失败 → 维持「没有 typecheck/test」→ A4 诚实报 SKIPPED。
    // 这比让 run 崩掉好：诚实地说「没查到」永远优于假装查过。
    const building = r.gates.find((g) => g.stage === 'BUILDING');
    assert.equal(building?.anchors.find((a) => a.anchorId === 'A4')?.verdict, 'SKIPPED');
    assert.equal(r.delivery, 'complete', '推导失败不该阻断交付，只是锚点没得查');
  } finally {
    await r.cleanup();
  }
});

test('【关键】角色提示词必须包含项目约定（否则 A4 的失败其实是编排层的错）', async () => {
  // 真实 LLM 实测发现（docs/07 §L5）：A4 报了 7 个编译错误，根因只有一个 ——
  // 模型写的相对导入没有 `.ts` 扩展名。但那对绝大多数 TS 项目是正常写法，
  // 是这个项目的 tsconfig 要求显式扩展名而**没人告诉它**。
  //
  // 这类失败看起来像「模型能力不足」，实际是「约定没有传达」。
  // 锚点判得没错（那确实是编译错误），错的是编排层让模型按另一套规则写代码。
  const { provider, orch, cleanup } = await setup(happyScript());
  try {
    await orch.run();
    const prompts = provider.calls.map((c) => c.lastUserMessage).join('\n');
    assert.ok(prompts.includes('项目约定'), '角色提示词必须包含「项目约定」一节');
    assert.ok(
      prompts.includes('显式文件扩展名') && prompts.includes('allowImportingTsExtensions'),
      '必须把「相对导入要带 .ts 扩展名」这条最容易踩的约定写明 —— 它同时影响编译与运行',
    );
    // 约定必须来自 profile，而不是写死的通用建议
    assert.ok(prompts.includes(process.execPath) || prompts.includes('npm run'), '应当把真实的编译/测试命令告诉角色');
  } finally {
    await cleanup();
  }
});

test('【关键】有 run 命令时，提示词必须说明「入口必须自启」（否则 A5+A6 一起失败）', async () => {
  // 真实 LLM 实测发现（docs/07 §L8）：生成的入口文件只导出了 `startServer()`、
  // 顶层从不调用它，于是 `node src/api/server.ts` 加载完就 exit 0。
  // 两个独立锚点同时报错：A6「服务进程在就绪前退出（exit 0）」，
  // A5 里所有依赖真实 HTTP 的测试连接失败。
  //
  // 模型的写法不算错（导出工厂函数便于测试），错的是 profile 里明明有 run/healthUrl
  // 而 renderConventions 只告诉了它编译与测试命令 —— 又一次「约定没传达」。
  const { provider, orch, cleanup } = await setup(happyScript(), {
    profileOverride: {
      run: { cmd: 'npm', args: ['start'], healthUrl: 'http://127.0.0.1:8787/health' },
    },
  });
  try {
    await orch.run();
    const prompts = provider.calls.map((c) => c.lastUserMessage).join('\n');
    assert.ok(prompts.includes('npm start'), '必须告诉角色真实的启动命令');
    assert.ok(prompts.includes('http://127.0.0.1:8787/health'), '必须告诉角色健康检查地址');
    assert.ok(
      prompts.includes('被直接执行时必须自己启动服务'),
      '必须点名「只导出不调用会让进程立刻退出」这个失败形态 —— 光给命令不足以避免它',
    );
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例 14b：TestReport 必须由真实执行固化
// ════════════════════════════════════════════════════════════════

test('【关键】TestReport 必须由真实执行固化，不能由 LLM 撰写', async () => {
  // 真实 LLM 实测发现的系统性假失败（docs/07 §L8）：
  // PM 的任务图自然会声明「测试任务交付 TestReport」，B2 锚点会拿声明的交付物
  // 去核对工件库。而此前**没有任何代码路径产出过 TestReport**，
  // 于是 B2 必定报 deliverable-missing，派出的工单又无法通过重试修复
  // —— 项目必然带债，而且失败被错误地归因到 test 角色头上。
  const { root, orch, cleanup } = await setup(happyScript());
  try {
    await orch.run();

    const dir = join(root, 'artifacts', 'TestReport');
    const reports = (await readdir(dir).catch(() => [])) as string[];
    assert.ok(reports.length > 0, '测试真的跑过之后，必须有一份 TestReport 工件');

    const doc = JSON.parse(await readFile(join(dir, reports[0]), 'utf8')) as {
      producer: string;
      content: { command: string; exitCode: number; passed: number; failed: number };
    };

    assert.equal(doc.producer, 'orchestrator', '执行事实只能由编排器固化，不能挂在角色名下');
    assert.equal(doc.content.exitCode, 0);
    assert.equal(doc.content.passed, 4, '数字必须来自真实解析，不是模型编的');
    assert.equal(doc.content.failed, 0);
    assert.ok(doc.content.command.length > 0, '必须记录真正执行过的命令，否则这份报告不可复核');
  } finally {
    await cleanup();
  }
});

test('TestReport 不得在「没测过」时伪造：A5 没得跑就不写报告', async () => {
  // 与 SKIPPED ≠ PASS 同一条原则：没测过不能被写成一份看起来测过的报告。
  const { root, orch, cleanup } = await setup(happyScript(), {
    profileOverride: { test: null }, // 没有测试命令 → A5 报 SKIPPED
  });
  try {
    await orch.run();
    const reports = await readdir(join(root, 'artifacts', 'TestReport')).catch(() => []);
    assert.deepEqual(reports, [], '没有执行事实时，宁可不产出工件，也不写空报告');
  } finally {
    await cleanup();
  }
});

test('【关键】B1 的判定必须回写成需求验收状态（否则 status 永远是 open）', async () => {
  // 真实 LLM 实测发现的「假绿灯」（docs/07 §L11）：
  // B1 每轮都给出 met / not-met / uncertain，但**从来没有人把它写回需求工件** ——
  // 9 轮真实运行里 requirement.status 全部停在初始值 `open`。
  // 而 delivery 的初值是 complete、控制台把 complete 显示成「全部需求通过验证」，
  // 于是出现：**唯一被判 complete 的那轮，恰好也是两条需求都判 uncertain 的那轮。**
  //
  // 一条需求的判定证据（evidenceRefs 必须真实存在，否则 B1 判 INVALID_EVIDENCE）
  const ref = { kind: 'file' as const, path: 'src/api/routes.ts', startLine: 6, endLine: 8 };

  const statusesFor = async (verdict: 'met' | 'uncertain' | 'not-met') => {
    const { root, orch, cleanup } = await setup(
      happyScript({
        'verify:requirements': {
          requirementVerdicts: [
            { requirementId: 'R-001', verdict, rationale: '测试用判定', evidenceRefs: [ref] },
            { requirementId: 'R-002', verdict, rationale: '测试用判定', evidenceRefs: [ref] },
          ],
        },
      }),
    );
    try {
      const summary = await orch.run();
      const dir = join(root, 'artifacts', 'Requirement');
      const files = (await readdir(dir)) as string[];
      // 取最新版本（回写会产生新版本，supersedes 链）
      const latest = JSON.parse(await readFile(join(dir, files[files.length - 1]), 'utf8')) as {
        content: { requirements: Array<{ id: string; status: string }> };
      };
      return { summary, statuses: latest.content.requirements.map((r) => `${r.id}:${r.status}`) };
    } finally {
      await cleanup();
    }
  };

  // ① met → met（确认达成）
  const a = await statusesFor('met');
  assert.deepEqual(a.statuses, ['R-001:met', 'R-002:met'], 'met 必须被回写');
  assert.deepEqual(
    a.summary.requirementStatuses.map((r) => r.status),
    ['met', 'met'],
    '报告里也必须带上，否则用户只能去翻工件库',
  );

  // ② uncertain → unverified（**查过了但确认不了**，与 open「还没查」刻意分开）
  const b = await statusesFor('uncertain');
  assert.deepEqual(b.statuses, ['R-001:unverified', 'R-002:unverified'], 'uncertain 必须回写成 unverified');
  assert.ok(
    b.summary.requirementStatuses.some((r) => r.status === 'unverified'),
    '「确认不了」必须能被看到 —— 这是判断系统可信度最关键的单个数字',
  );

  // ③ not-met → **绝不能**被记成已达成。
  //    实际会发生什么取决于逃生路径：门禁会因这条 fail 阻断 → 重试 → 逃生，
  //    若走到「带债通过」，需求会被标成 `accepted_with_debt`（第三态）；
  //    若还在流程中，则保持 `open`。两者都可接受 —— 唯独不能是 met。
  const c = await statusesFor('not-met');
  for (const s of c.statuses) {
    assert.ok(
      s.endsWith(':open') || s.endsWith(':accepted_with_debt'),
      `not-met 不得被记成 met/unverified，实际：${s}`,
    );
  }
  assert.notEqual(c.summary.delivery, 'complete', 'not-met 时不可能完整交付');
});

test('NoteReport：占位（保证上面的测试不会因文件顺序而假过）', async () => {
  // 上一条测试从 artifacts/Requirement/ 里取"最后一个文件"当作最新版本。
  // 这个假设依赖 store 的 id 递增顺序，属于隐式契约 —— 这里显式验证一次：
  // 单次运行只应产生一个"初始 + 若干次回写"的版本序列，且最后一个的状态是最终态。
  const { root, orch, cleanup } = await setup(happyScript());
  try {
    const summary = await orch.run();
    const dir = join(root, 'artifacts', 'Requirement');
    const files = ((await readdir(dir)) as string[]).sort();
    assert.ok(files.length >= 1, '至少有一个 Requirement 工件');
    const last = JSON.parse(await readFile(join(dir, files[files.length - 1]), 'utf8')) as {
      content: { requirements: Array<{ id: string; status: string }> };
    };
    const fromArtifact = last.content.requirements.map((r) => r.status);
    const fromSummary = summary.requirementStatuses.map((r) => r.status);
    assert.deepEqual(fromArtifact, fromSummary, '工件里的最终状态必须与报告一致（同一个事实不能有两个版本）');
  } finally {
    await cleanup();
  }
});

test('【关键】验证器的上下文必须包含机械检查事实（否则它只能报「确认不了」）', async () => {
  // 真实 LLM 实测（docs/07 §L12）：45% 的需求判定落在 uncertain，
  // 而验证器给出的理由高度一致 —— 它缺的东西里有两类**系统早就测过了**：
  //   「npm run typecheck 退出码」      → A4 真的跑过 tsc
  //   「HTTP 状态码与响应体」            → A6 真的起服务打过探针
  // 只是这些事实存在锚点运行记录里，而它只被喂了**工件**。
  //
  // 隔离重放实测：补上这块之后，llm-11 的两条需求从 uncertain 变成 met，
  // 且理由里明确引用了 A4/A5/A6 的字段 —— 而那次交付是**真的**（独立验证过
  // 真 tsc 退出 0、7 个测试全过、/health 200、POST 201、写后读一致）。
  // 也就是说：之前的 uncertain 是假阴性，这个修复把假阴性变成了正确的正例。
  const { provider, orch, cleanup } = await setup(happyScript());
  try {
    await orch.run();

    const verifyCall = provider.calls.find((c) => c.purpose === 'verify:requirements');
    assert.ok(verifyCall, '应当发起过一次 verify:requirements');
    const prompt = verifyCall.lastUserMessage;

    assert.ok(prompt.includes('机械检查事实'), '上下文里必须有这一块');
    // 具体到「模型编不出来」的字段
    assert.ok(/A4 \[PASS\]/.test(prompt), `应当包含 A4 的结论与退出码：${prompt.slice(0, 200)}`);
    assert.ok(prompt.includes('exitCode'), '必须给真实退出码（这是它反复说缺的东西）');
    assert.ok(/A5 \[PASS\]/.test(prompt), '应当包含 A5 的测试执行结果');
    assert.ok(prompt.includes('passed'), '必须给真实通过数');

    // 关键：必须说明「机械通过 ≠ 需求达成」，否则验证者会直接抄结论
    assert.ok(
      prompt.includes('不等于') && prompt.includes('需求达成'),
      '必须明确告诉它这是事实不是结论 —— 否则它会把 A 层 PASS 直接当成需求 met',
    );
  } finally {
    await cleanup();
  }
});

test('【关键】锚点运行记录不得跨 Gate 互相覆盖（runId 必须每个 Gate 唯一）', async () => {
  // 真实 LLM 实测发现的缺陷（docs/07 §L14）。
  //
  // createAnchorContext 内部有一个从 1 开始的计数器，runId 形如 `${prefix}-001`。
  // 原来 prefix 就是 this.runId，而每次 Gate 都会新建一个 ctx ——
  // 于是**每个 Gate 都从 -001 重新编号**，`anchors/${runId}.json` 后写覆盖先写。
  //
  // 实测后果：跑了 7 个 Gate 的运行，anchors/ 目录里只剩**最后一个 Gate** 的
  // 10 条记录，前面 6 次的锚点结论全部丢失。两个真问题：
  //   1. 审计历史没了（事后无法回答「这个失败是第几轮出现的」）
  //   2. 更严重：`{kind:'anchor', runId}` 形式的证据引用会解析到**另一个 Gate
  //      的结果**，而 B1/B3 都要核验这种引用 —— 等于用错误的记录为判定背书
  const { root, orch, cleanup } = await setup(happyScript());
  try {
    await orch.run();

    const dir = join(root, 'anchors');
    const files = (await readdir(dir)) as string[];
    const runs = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as { anchorId: string; runId: string }),
    );

    // 每个 Gate 的锚点都要留下记录：INTAKE 0 + PLANNING 1 + CONTRACTING 2 + BUILDING 6 + REVIEW 10 = 19
    assert.ok(
      runs.length >= 15,
      `应当保留所有 Gate 的锚点记录（预期 ~19 条），实际只剩 ${runs.length} 条 —— 说明后面的 Gate 覆盖了前面的`,
    );

    const ids = runs.map((r) => r.runId);
    assert.equal(new Set(ids).size, ids.length, `runId 必须唯一，实际有重复：${ids.filter((v, i) => ids.indexOf(v) !== i).join(', ')}`);

    // 同一次运行里，同一个锚点应当出现多次（不同 Gate 各一次）
    const a5Count = runs.filter((r) => r.anchorId === 'A5').length;
    assert.ok(a5Count >= 2, `A5 在 BUILDING 与 REVIEW 都会跑，应当有 ≥2 条记录，实际 ${a5Count} 条`);
  } finally {
    await cleanup();
  }
});

test('需求状态映射必须是全量映射（not-met 不得被漏掉，否则过期状态清不掉）', () => {
  // 踩过的「少报」坑（docs/07 §L14）：最初把 not-met 排除在外，
  // 于是上一轮写的 unverified 永远不会被重置 ——
  // REVIEW 第一次判 uncertain → 写 unverified；重试后第二次判 not-met → 被过滤掉不写
  // → 状态停在 unverified。一个「已确认未达成」的需求被显示成「查过但说不清」。
  assert.equal(requirementStatusForVerdict('met'), 'met');
  assert.equal(requirementStatusForVerdict('not-met'), 'open', 'not-met 必须写回 open，否则清不掉过期的 unverified');
  assert.equal(requirementStatusForVerdict('uncertain'), 'unverified');
  assert.equal(requirementStatusForVerdict('unverified'), 'unverified');
  // 四个 verdict 都有归宿，没有「不处理」的分支
  for (const v of ['met', 'not-met', 'uncertain', 'unverified'] as const) {
    assert.ok(['met', 'open', 'unverified'].includes(requirementStatusForVerdict(v)));
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例 15：每一次 LLM 调用都必须声明 schema（Mock 通过 ≠ 真实通过）
// ════════════════════════════════════════════════════════════════

test('不变式【关键】：整条流程里每一次 LLM 调用都必须传 schema', async () => {
  // 真实 LLM 实测发现的缺陷（docs/07 §L4）：
  // 编排器调用 LLM 产出圆桌发言与决议时**没有传 schema**。
  // OpenAiCompatProvider 在 `!req.schema` 时直接返回裸文本（json 为 undefined），
  // 于是每条发言都变成「(无主张) + 无证据」被机械主持全部丢弃、决议恒为 null ——
  // 圆桌在真实端点下**完全不可用**。
  //
  // 而 MockProvider 不看 schema、直接返回脚本值，把这个缺陷完整地掩盖住了。
  // 所以这里打开 requireSchema，让 Mock 也遵守真实 provider 的那条硬性契约。
  // 这条测试抓的不是某一个调用点，而是**这一类**遗漏。
  const root = await mkdtemp(join(tmpdir(), 'af-schema-'));
  const profile = await scaffoldProject(root);
  const provider = new MockProvider({
    script: happyScript({
      // 让流程真的走到圆桌（圆桌是出问题的那条路径）
      'produce:AnchoredReview': {
        stage: 'REVIEW',
        noObjection: false,
        objections: [
          {
            id: 'O-1',
            stage: 'REVIEW',
            author: 'host',
            targetRole: 'UNRESOLVED',
            severity: 'blocker',
            claim: '整体职责边界不清，无法判断该归给谁',
            evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 19 }],
            falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
            claimHash: 'a1a1a1a1a1a1a1a1',
            evidenceHash: 'b1b1b1b1b1b1b1b1',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      'roundtable:pm': { claim: '边界在契约里', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }] },
      'roundtable:frontend': { claim: '前端不越界', evidence: [{ kind: 'file', path: 'src/web/client.ts', startLine: 1, endLine: 2 }] },
      'roundtable:backend': { claim: '后端不越界', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8 }] },
      'roundtable:test': { claim: '测试覆盖充分', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }] },
      'roundtable:resolution': {
        attribution: 'SHARED',
        decision: '以冻结契约为职责边界的唯一依据',
        actions: [{ owner: 'backend', action: '在 routes.ts 顶部加入分层说明注释', acceptance: ['A4 锚点 PASS'] }],
      },
    }),
    requireSchema: true,
  });

  const orch = new Orchestrator({
    projectRoot: root,
    profile,
    userBrief: USER_BRIEF,
    runners: createRoleRunners(provider),
    verifier: new SemanticVerifier({ provider }),
    provider,
    humanAvailable: false,
    offline: true,
    log: new DecisionLog(root),
    logger: silentLogger('schema-invariant'),
  });

  try {
    await orch.run();
  } catch (err) {
    assert.fail(`流程本身崩溃了：${(err as Error).message}`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }

  // 关键断言：不能只看「流程有没有崩」——
  // 圆桌的 collect 会把发言异常吞掉并记成「发言失败」，run 照样正常结束。
  // 所以直接查「有没有哪一次调用忘了传 schema」。
  assert.deepEqual(
    provider.schemaViolations,
    [],
    `以下 LLM 调用没有传 schema：${provider.schemaViolations.join(', ')}\n` +
      `真实 provider 下这会让该调用静默拿到空对象（见 docs/07 §L4）。`,
  );
});

// ════════════════════════════════════════════════════════════════
// 验收用例 13：人类建议书 resume 强制推进
// ════════════════════════════════════════════════════════════════

test('端到端：真人投递 hold 建议书 → 流水线立即暂停（物理刹车优先于一切机器人）', async () => {
  const { orch, cleanup } = await setup(happyScript());
  try {
    await orch.submitDirective({ kind: 'hold', text: '先停一下，我要看看 PRD 再决定' });
    const summary = await orch.run();
    assert.equal(summary.delivery, 'held');
    assert.equal(summary.totalCycles, 0, '暂停应发生在任何 Gate 之前');
  } finally {
    await cleanup();
  }
});

test('端到端：约束类建议书（依赖白名单）由 A1 锚点在 Gate 中强制校验', async () => {
  const { orch, cleanup } = await setup(happyScript());
  try {
    const d = await orch.submitDirective({
      kind: 'constraint',
      text: '禁止引入未列入白名单的依赖',
      constraints: ['依赖白名单：仅允许 leftpad-real'],
    });
    assert.equal(d.kind, 'constraint');
    assert.ok(d.hash.length === 64, '建议书必须带 hash 进决策日志');
    assert.equal(orch.events.filter((e) => e.t === 'directive.received').length, 1);
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 事件流：前端（P4）将只消费这些事件
// ════════════════════════════════════════════════════════════════

test('端到端：事件流覆盖全流程关键节点（前端只需投影事件）', async () => {
  const { orch, cleanup } = await setup(happyScript());
  try {
    await orch.run();
    const types = new Set(orch.events.map((e) => e.t));
    for (const expected of ['stage.enter', 'artifact.published', 'anchor.ran', 'gate.evaluated', 'ledger.updated', 'run.finished']) {
      assert.ok(types.has(expected as never), `事件流缺少 ${expected}，实际：${[...types].join(', ')}`);
    }
  } finally {
    await cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 不伪造产出：schema 反复失败时绝不写坏工件
// ════════════════════════════════════════════════════════════════

test('端到端：角色产出反复不合 schema → 不伪造工件，走逃生流程', async () => {
  const { orch, cleanup } = await setup(
    happyScript({
      // 永远不返回合法 JSON
      'produce:Requirement': { __raw: '我觉得需求大概是这样的，但我不太确定……' },
    }),
  );
  try {
    const summary = await orch.run();
    assert.notEqual(summary.delivery, 'complete', '不得在需求缺失的情况下声称完成');
    // 结构化重试确实发生了（maxAttempts 默认 3）
    assert.ok(
      summary.traces[0].blockedReasons.some((r) => r.includes('production-failed')),
      JSON.stringify(summary.traces[0]),
    );
    assert.equal(summary.ledger.precision, 1, '产出失败不该被记到主理人头上');
  } finally {
    await cleanup();
  }
});

test('端到端：结构化重试会把具体校验错误回喂给模型（不是盲目重试）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-retry-'));
  try {
    const profile = await scaffoldProject(root);
    const provider = new MockProvider({
      script: happyScript(),
      // 第一次故意返回格式错误
      failFirstAttemptFor: ['produce:Requirement'],
    });
    const runners = createRoleRunners(provider);
    const verifier = new SemanticVerifier({ provider });
    const orch = new Orchestrator({
      projectRoot: root,
      profile,
      userBrief: USER_BRIEF,
      runners,
      verifier,
      provider,
      offline: true,
      logger: silentLogger('e2e'),
    });

    const summary = await orch.run();
    assert.equal(summary.delivery, 'complete', '重试后应能成功');
    assert.equal(provider.callCount('produce:Requirement'), 2, '第一次失败 + 第二次成功');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 验收用例：产出不得修改验证基准（A8 / 项目契约）
// ════════════════════════════════════════════════════════════════
//
// 真实数据（docs/HANDOFF.md §8.1）：第 12 轮真实运行里，backend 角色交出的
// CodeModule 附了一份自己写的 package.json，把项目声明的 agentforge.healthUrl 删掉，
// 于是 A6 静默变成 SKIPPED —— 而那次运行**照常走到了交付**。
// 同一份产出还把 tsconfig.json 的 exclude 改成排除测试目录，削弱了 A4。
//
// 这个用例复现那个场景，并验证三件事：
//   1. 盘上的基准**原封不动**（被验证者改不动验证基准）
//   2. 这次尝试**没有被静默吞掉**：A8 FAIL，并且机械归因到 backend 派了工单
//   3. 返工后能正常收敛 —— 保护机制不惩罚已经改好的角色

/** llm-12 那份产出的忠实复刻：删掉项目声明的 dependencies 键。 */
const TAMPERED_PKG = JSON.stringify(
  {
    name: 'task-board',
    version: '0.1.0',
    type: 'module',
    scripts: { typecheck: 'tsc --noEmit', test: 'node --test', start: 'node src/api/routes.ts' },
  },
  null,
  2,
);

/** 把测试目录排除出类型检查 —— 静默削弱 A4。 */
const TAMPERED_TSCONFIG = JSON.stringify(
  {
    compilerOptions: { strict: true },
    include: ['src'],
    exclude: ['node_modules', 'tests', '**/*.test.ts'],
  },
  null,
  2,
);

const ORIGINAL_TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2);

test('契约：产出试图改写 package.json / tsconfig.json → 基准原封不动，A8 FAIL 并派工单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-contract-e2e-'));
  try {
    const profile = await scaffoldProject(root);
    // tsconfig 必须在**运行开始之前**就存在，才会进入契约基准
    await write(root, 'tsconfig.json', ORIGINAL_TSCONFIG);

    const events: ForgeEvent[] = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e));

    const provider = new MockProvider({
      script: happyScript({
        // 第一次产出：夹带私货，试图替换项目契约
        'produce:CodeModule:api': {
          files: [
            { path: 'src/api/routes.ts', content: API_CODE },
            { path: 'package.json', content: TAMPERED_PKG },
            { path: 'tsconfig.json', content: TAMPERED_TSCONFIG },
          ],
        },
        // 返工：干净的产出（真实模型被打回后也会这样重交）
        'repair:CodeModule:api': {
          files: [{ path: 'src/api/routes.ts', content: API_CODE }],
        },
      }),
    });
    const runners = createRoleRunners(provider);
    const verifier = new SemanticVerifier({ provider });
    const log = new DecisionLog(root);
    const orch = new Orchestrator({
      projectRoot: root,
      profile,
      userBrief: USER_BRIEF,
      runners,
      verifier,
      provider,
      humanAvailable: false,
      offline: true,
      log,
      bus,
      logger: silentLogger('contract-e2e'),
    });

    const summary = await orch.run();

    // ── 1. 盘上的基准原封不动 ────────────────────────────────
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    assert.deepEqual(
      pkg.dependencies,
      { 'leftpad-real': '^1.0.0' },
      '项目在 package.json 里声明的 dependencies 不得被产出删掉',
    );
    assert.equal(
      await readFile(join(root, 'tsconfig.json'), 'utf8'),
      ORIGINAL_TSCONFIG,
      '受保护的 tsconfig.json 不得被产出改写（那段 exclude 会让测试逃过类型检查）',
    );

    // ── 2. 这次尝试没有被静默吞掉 ────────────────────────────
    const a8 = events
      .filter((e): e is Extract<ForgeEvent, { t: 'anchor.ran' }> => e.t === 'anchor.ran')
      .map((e) => e.result)
      .filter((r) => r.anchorId === 'A8');
    assert.ok(a8.length > 0, 'A8 必须被真的跑过（注册进 STAGE_ANCHORS 了吗？）');
    const failed = a8.find((r) => r.verdict === 'FAIL');
    assert.ok(failed, `A8 必须报 FAIL，实际：${a8.map((r) => r.verdict).join(',')}`);
    assert.ok(
      failed.findings.some((f) => f.code === 'contract-key-removed' && f.targetRole === 'backend'),
      JSON.stringify(failed.findings, null, 2),
    );
    assert.ok(
      failed.findings.some((f) => f.code === 'contract-file-overwritten'),
      '改写 tsconfig 也必须被报出来',
    );

    const order = summary.workOrders.find((o) => o.to === 'backend');
    assert.ok(order, '必须按机械归因派出工单，否则保护机制只是日志');
    assert.ok(
      order.acceptance.some((a) => a.includes('不要') && a.includes('package.json')),
      `验收条件必须告诉角色「别附带契约文件」，实际：${JSON.stringify(order.acceptance)}`,
    );

    // 决策日志里留痕（哈希链可 verify，历史不可改写）
    await log.init();
    const raw = await readFile(join(root, 'decisions.jsonl'), 'utf8').catch(() => '');
    assert.ok(
      raw.includes('project.contract.violation'),
      `违规必须写进决策日志，实际日志：${raw.slice(0, 400)}`,
    );
    assert.deepEqual(await log.verify(), { ok: true });

    // ── 3. 返工后能收敛（保护机制不惩罚已经改好的角色）────────
    assert.equal(summary.delivery, 'complete', JSON.stringify(summary.traces, null, 2));
    assert.equal(summary.finalStage, 'DELIVERED');
    assert.ok(
      summary.traces.some((t) => t.stage === 'BUILDING' && t.cycles >= 1),
      '应当经历一次返工',
    );
    // 关键：违规按 Gate 结算、用完即清 —— 第二名返工干净了，A8 就该放行，
    // 而不是让这个 run 从此永远 FAIL 到只能带债通过。
    const laterA8 = a8.filter((r) => r.verdict === 'PASS');
    assert.ok(laterA8.length > 0, `返工后 A8 应当转为 PASS，实际序列：${a8.map((r) => r.verdict).join(',')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约：干净的项目里 A8 PASS，且不产生任何工单（保护机制不误报）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-contract-clean-'));
  try {
    const profile = await scaffoldProject(root);
    await write(root, 'tsconfig.json', ORIGINAL_TSCONFIG);

    const events: ForgeEvent[] = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e));

    const provider = new MockProvider({ script: happyScript() });
    const orch = new Orchestrator({
      projectRoot: root,
      profile,
      userBrief: USER_BRIEF,
      runners: createRoleRunners(provider),
      verifier: new SemanticVerifier({ provider }),
      provider,
      humanAvailable: false,
      offline: true,
      bus,
      logger: silentLogger('contract-clean'),
    });

    const summary = await orch.run();
    assert.equal(summary.delivery, 'complete', JSON.stringify(summary.traces, null, 2));

    const a8 = events
      .filter((e): e is Extract<ForgeEvent, { t: 'anchor.ran' }> => e.t === 'anchor.ran')
      .map((e) => e.result)
      .filter((r) => r.anchorId === 'A8');
    assert.ok(a8.length > 0);
    assert.ok(
      a8.every((r) => r.verdict === 'PASS'),
      `没有任何篡改时 A8 不得报 FAIL，实际：${a8.map((r) => r.verdict).join(',')}`,
    );
    assert.equal(summary.workOrders.length, 0, '不该凭空产生工单');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
