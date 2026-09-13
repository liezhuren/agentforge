import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DecisionLog, silentLogger, type DirectiveRecord } from '../../core/src/index.ts';
import { MockProvider } from '../../llm/src/index.ts';
import { createRoleRunners } from '../../roles/src/index.ts';
import { SemanticVerifier } from '../../roles/src/verify.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { applyDirectivesToProfile, compileDirectives, describeEnforcement } from '../src/directives.ts';
import { DEMO_USER_BRIEF, demoScript, scaffoldDemoProject } from '../src/demo-project.ts';

// ════════════════════════════════════════════════════════════════
// 单元：建议书 → 机械可校验的约束
// ════════════════════════════════════════════════════════════════

function dir(id: string, kind: DirectiveRecord['kind'], text: string, constraints?: string[]): DirectiveRecord {
  return {
    id,
    kind,
    text,
    ...(constraints ? { constraints } : {}),
    at: new Date().toISOString(),
    hash: 'x'.repeat(64),
  };
}

test('编译：识别「不得引入 X」为依赖黑名单', () => {
  const c = compileDirectives([dir('D-1', 'constraint', '不得引入 lodash')]);
  assert.equal(c.constraints.length, 1);
  assert.equal(c.constraints[0].kind, 'deny-dependencies');
  assert.deepEqual(c.constraints[0].values, ['lodash']);
  assert.equal(c.constraints[0].directiveId, 'D-1');
  assert.equal(c.advisory.length, 0);
});

test('编译：识别多种写法与多个包', () => {
  const cases: Array<[string, string[]]> = [
    ['禁止使用 axios', ['axios']],
    ['不许依赖 moment', ['moment']],
    ['不能安装 request', ['request']],
    ['不要引入 lodash', ['lodash']],
    ['lodash 禁止使用', ['lodash']],
    ['不得引入 lodash、axios', ['lodash', 'axios']],
  ];
  for (const [text, expected] of cases) {
    const c = compileDirectives([dir('D', 'constraint', text)]);
    assert.deepEqual(c.constraints[0]?.values, expected, text);
  }
});

test('编译：识别「只允许 X」为依赖白名单（封闭集合语义）', () => {
  const c = compileDirectives([dir('D-2', 'constraint', '只允许 leftpad-real', ['只允许 leftpad-real'])]);
  assert.equal(c.constraints[0].kind, 'allow-dependencies');
  assert.deepEqual(c.constraints[0].values, ['leftpad-real']);
});

test('编译：同一句话同时出现在 constraints[] 与 text 里时只算一条', () => {
  // UI 上引导用户两处都填，不去重的话界面上会出现两条一模一样的规则
  const c = compileDirectives([dir('D', 'constraint', '不得引入 lodash', ['不得引入 lodash'])]);
  assert.equal(c.constraints.length, 1, JSON.stringify(c.constraints));
  assert.equal(c.advisory.length, 0);
});

test('编译：无法机械校验的约束必须进 advisory 并给出原因（不能假装生效）', () => {
  const c = compileDirectives([
    dir('D-3', 'constraint', '代码风格要简洁'),
    dir('D-4', 'constraint', '错误处理要友好'),
  ]);
  assert.equal(c.constraints.length, 0, '这两条不该被编译成任何机械规则');
  assert.equal(c.advisory.length, 2);
  for (const a of c.advisory) {
    assert.ok(a.reason.includes('不会'), `必须说清「不会」被强制校验：${a.reason}`);
    assert.ok(a.reason.includes('不得引入'), '必须告诉用户哪些写法是可编译的');
  }
});

test('编译：非 constraint 类型的建议书不参与', () => {
  const c = compileDirectives([
    dir('D-5', 'hold', '先停一下'),
    dir('D-6', 'resume', '继续'),
    dir('D-7', 'requirement', '不得引入 lodash'),
  ]);
  assert.equal(c.constraints.length, 0);
  assert.equal(c.advisory.length, 0);
});

test('编译：落到 profile 上时 allow / deny 语义方向不能搞反', () => {
  const base = { name: 'x', language: 'typescript' as const, srcDir: 'src', tsconfigPath: 't',
    typecheck: null, test: null, run: null, knownPackages: [], dependencyAllowlist: null };

  const allowProfile = applyDirectivesToProfile(base, compileDirectives([dir('D', 'constraint', '只允许 leftpad-real')]));
  assert.deepEqual(allowProfile.dependencyAllowlist, ['leftpad-real']);
  assert.equal(allowProfile.deniedDependencies, null);

  const denyProfile = applyDirectivesToProfile(base, compileDirectives([dir('D', 'constraint', '不得引入 lodash')]));
  assert.equal(denyProfile.dependencyAllowlist, null);
  assert.deepEqual(denyProfile.deniedDependencies, ['lodash']);
});

test('编译：执行情况报告区分「强制」与「仅指令」', () => {
  const report = describeEnforcement(
    compileDirectives([
      dir('D-a', 'constraint', '不得引入 lodash'),
      dir('D-b', 'constraint', '代码风格要简洁'),
    ]),
  );
  assert.equal(report.enforced.length, 1);
  assert.equal(report.enforced[0].directiveId, 'D-a');
  assert.ok(report.enforced[0].rule.includes('黑名单'));
  assert.deepEqual(report.enforced[0].values, ['lodash']);
  assert.equal(report.advisory.length, 1);
  assert.equal(report.advisory[0].directiveId, 'D-b');
});

// ════════════════════════════════════════════════════════════════
// 集成：约束真的能阻断，对照跑不加约束就通过
// ════════════════════════════════════════════════════════════════

/**
 * 违规版：代码里 import 了 lodash（**没有**声明在 package.json 里，专门测导入路径的检查）。
 *
 * 行号是刻意固定的：B1 的语义验证提议要引用「真实文件 + 真实行区间」，
 * 而区间内容会被逐条核验。故意**让修复版保持完全相同的行数**（第 1 行换成注释、
 * 第 8 行换成不引用 lodash 的实现），这样修复前后行号不变，
 * 验证提议不需要跟着改 —— 否则每修一次证据就失效一次，测试会测出一堆假失败。
 */
const API_VIOLATING = [
  "import { chunk } from 'lodash';", // 1  ← 违规点
  "import { padLeft } from 'leftpad-real';", // 2
  "import type { Task } from '../../shared/contract/types';", // 3
  '', // 4
  'const store: Task[] = [];', // 5
  '', // 6
  'export function listTasks(): Task[] {', // 7
  '  return chunk<Task>(store, 10).flat();', // 8
  '}', // 9
  '', // 10
  'export function createTask(title: string): Task {', // 11
  '  const t: Task = { id: padLeft(String(store.length + 1), 4), title };', // 12
  '  store.push(t);', // 13
  '  return t;', // 14
  '}', // 15
  '', // 16
  "export const ROUTES = ['/api/tasks'];", // 17
  '',
].join('\n');

/** 修复版：行数与上面完全一致，只是不再引用被禁的包。 */
const API_REPAIRED = [
  '// 已按用户约束移除 lodash', // 1
  "import { padLeft } from 'leftpad-real';", // 2
  "import type { Task } from '../../shared/contract/types';", // 3
  '', // 4
  'const store: Task[] = [];', // 5
  '', // 6
  'export function listTasks(): Task[] {', // 7
  '  return store;', // 8
  '}', // 9
  '', // 10
  'export function createTask(title: string): Task {', // 11
  '  const t: Task = { id: padLeft(String(store.length + 1), 4), title };', // 12
  '  store.push(t);', // 13
  '  return t;', // 14
  '}', // 15
  '', // 16
  "export const ROUTES = ['/api/tasks'];", // 17
  '',
].join('\n');

/** 与上面行号对齐的语义验证提议（B1 会逐条核验行区间与内容）。 */
const VERIFY_MATCHING_LINES = {
  requirementVerdicts: [
    {
      requirementId: 'R-001',
      verdict: 'met',
      rationale: 'createTask 已实现',
      evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 11, endLine: 15, expect: 'createTask' }],
    },
    {
      requirementId: 'R-002',
      verdict: 'met',
      rationale: 'listTasks 已实现',
      evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 7, endLine: 9, expect: 'listTasks' }],
    },
  ],
};

async function runOnce(opts: { withDirective: boolean; repairFixes: boolean }): Promise<{
  summary: Awaited<ReturnType<Orchestrator['run']>>;
  root: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'af-dir-'));
  await scaffoldDemoProject(root);

  const script = demoScript({
    'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_VIOLATING }] },
    'verify:requirements': VERIFY_MATCHING_LINES,
    ...(opts.repairFixes
      ? { 'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_REPAIRED }] } }
      : {}),
  });

  const provider = new MockProvider({ script });
  const orch = new Orchestrator({
    projectRoot: root,
    profile: {
      name: 'task-board',
      language: 'typescript',
      srcDir: 'src',
      tsconfigPath: 'tsconfig.json',
      typecheck: { cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
      test: { cmd: process.execPath, args: ['-e', "console.log('# pass 3\\n# fail 0')"] },
      run: null,
      knownPackages: ['lodash', 'express'],
      dependencyAllowlist: null,
    },
    userBrief: DEMO_USER_BRIEF,
    runners: createRoleRunners(provider, { logger: silentLogger('role') }),
    verifier: new SemanticVerifier({ provider, logger: silentLogger('v') }),
    provider,
    humanAvailable: false,
    offline: true,
    log: new DecisionLog(root),
    logger: silentLogger('orch'),
  });

  if (opts.withDirective) {
    await orch.submitDirective({
      kind: 'constraint',
      text: '不得引入 lodash',
      constraints: ['不得引入 lodash'],
    });
  }

  const summary = await orch.run();
  return { summary, root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5 }) };
}

test('集成【对照】没有约束时，导入 lodash 不会被阻断', async () => {
  const r = await runOnce({ withDirective: false, repairFixes: false });
  try {
    assert.equal(r.summary.delivery, 'complete', JSON.stringify(r.summary.traces));
    assert.equal(r.summary.workOrders.length, 0, '不该产生任何工单');
  } finally {
    await r.cleanup();
  }
});

test('集成【关键】投了「不得引入 lodash」之后，A1 真的报 FAIL 并阻断', async () => {
  const r = await runOnce({ withDirective: true, repairFixes: false });
  try {
    // 阻断发生了
    assert.ok(
      r.summary.traces.some((t) => t.blockedReasons.some((b) => b.includes('ANCHOR_HARD_FAIL'))),
      `约束应当导致 A 层硬失败：${JSON.stringify(r.summary.traces.map((t) => t.blockedReasons))}`,
    );
    // 工单的验收条件指向被禁的包
    const acc = r.summary.workOrders.flatMap((w) => w.acceptance).join('\n');
    assert.ok(acc.includes('lodash'), `工单验收条件应当点名 lodash：${acc}`);
    assert.ok(acc.includes('不可协商'), '应当明确这是用户约束');
    // 且约束被记录为「强制生效」
    assert.ok(
      r.summary.directiveEnforcement?.enforced.some((e) => e.values.includes('lodash')),
      JSON.stringify(r.summary.directiveEnforcement),
    );
  } finally {
    await r.cleanup();
  }
});

test('集成【闭环】约束导致阻断 → 角色修复 → 重新校验通过 → 完整交付', async () => {
  const r = await runOnce({ withDirective: true, repairFixes: true });
  try {
    assert.equal(r.summary.delivery, 'complete', JSON.stringify(r.summary.traces));
    // 修复后的代码里不应再有对被禁包的**引用**。
    // 注意不能直接 `includes('lodash')` —— 修复版第 1 行是注释「已按用户约束移除 lodash」，
    // 里面就含这个词。断言要落在「有没有真的导入」上，而不是「有没有出现这个字符串」。
    const code = await readFile(join(r.root, 'src/api/routes.ts'), 'utf8');
    assert.ok(!/from\s+['"]lodash['"]/.test(code), `修复后的代码不该再导入被禁的包：\n${code}`);
    assert.ok(!/require\(\s*['"]lodash['"]\s*\)/.test(code), '也不该用 require 引入');
    // 确实经过了「阻断→修复」
    assert.ok(r.summary.workOrders.length >= 1, '应当产生过派工单');
  } finally {
    await r.cleanup();
  }
});

test('集成：无法机械校验的约束不阻断，但被诚实地报告为「仅指令」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-dir-adv-'));
  try {
    await scaffoldDemoProject(root);
    const provider = new MockProvider({ script: demoScript() });
    const orch = new Orchestrator({
      projectRoot: root,
      profile: {
        name: 'task-board',
        language: 'typescript',
        srcDir: 'src',
        tsconfigPath: 'tsconfig.json',
        typecheck: { cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
        test: { cmd: process.execPath, args: ['-e', "console.log('# pass 3\\n# fail 0')"] },
        run: null,
        knownPackages: ['lodash'],
        dependencyAllowlist: null,
      },
      userBrief: DEMO_USER_BRIEF,
      runners: createRoleRunners(provider, { logger: silentLogger('role') }),
      verifier: new SemanticVerifier({ provider, logger: silentLogger('v') }),
      provider,
      humanAvailable: false,
      offline: true,
      log: new DecisionLog(root),
      logger: silentLogger('orch'),
    });

    await orch.submitDirective({ kind: 'constraint', text: '代码风格要简洁' });
    const summary = await orch.run();

    assert.equal(summary.delivery, 'complete', '无法校验的约束不该阻断流程');
    assert.equal(summary.directiveEnforcement?.enforced.length, 0);
    assert.equal(summary.directiveEnforcement?.advisory.length, 1);
    assert.ok(summary.directiveEnforcement?.advisory[0].reason.includes('不会'));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
