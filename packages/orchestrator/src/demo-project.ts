/**
 * 演示项目：一个「任务看板」需求，以及配套的 Mock 脚本。
 *
 * 从 cli-e2e.ts 提取出来，因为现在有三处要用它：
 *   - `cli-e2e.ts` 的三个演示场景
 *   - 服务端的**离线演示模式**（用户没有任何 API key 也能把控制台跑起来看）
 *   - 测试
 * 三份拷贝必然会漂移，所以只留一份。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProjectProfile } from '../../core/src/types.ts';
// 真实应用场景的脚本与脚手架复用 real-app-project，避免两处维护同一份代码
import { realAppScript } from './real-app-project.ts';

export const DEMO_USER_BRIEF = '做一个任务看板：能创建任务，也能列出全部任务。';
export const DEMO_PROJECT_NAME = 'task-board';

// ════════════════════════════════════════════════════════════════
// 代码样本
// ════════════════════════════════════════════════════════════════

export const API_CODE = [
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
  '  const t: Task = { id: padLeft(String(store.length + 1), 4), title };',
  '  store.push(t);',
  '  return t;',
  '}',
  '',
  "export const ROUTES = ['/api/tasks'];",
  '',
].join('\n');

/** 幻觉版：导入了 leftpad-real 中并不存在的 padRigth（A2 锚点会抓出来）。 */
export const API_HALLUCINATED = API_CODE.replace(
  "import { padLeft } from 'leftpad-real';",
  "import { padLeft, padRigth } from 'leftpad-real';",
).replace('padLeft(String(store.length + 1), 4)', 'padRigth(String(store.length + 1), 4)');

export const WEB_CODE = [
  "import type { Task } from '../../shared/contract/types';",
  '',
  'export async function loadTasks(): Promise<Task[]> {',
  "  const res = await fetch('/api/tasks');",
  '  return res.json();',
  '}',
  '',
].join('\n');

export const TEST_CODE = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  "test('占位：真实项目里这里应当覆盖 R-001 / R-002', () => {",
  '  assert.ok(true);',
  '});',
  '',
].join('\n');

// ════════════════════════════════════════════════════════════════
// 工作区脚手架
// ════════════════════════════════════════════════════════════════

/**
 * 搭出一个「真实但最小」的 TS 项目：有 package.json、有已安装的假依赖。
 *
 * 注意 `node_modules/leftpad-real` 是**真的写到磁盘**的：
 * A2 锚点（符号真实性）必须能读到真实的 `.d.ts` 才能判断 `padRigth` 不存在。
 * 如果只在代码里假装有依赖，锚点就没有可核验的事实底座。
 */
export async function scaffoldDemoProject(
  root: string,
  opts: { typecheckPasses?: boolean; testsPass?: boolean } = {},
): Promise<ProjectProfile> {
  const w = async (rel: string, content: string) => {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  };

  await w(
    'package.json',
    JSON.stringify(
      {
        name: DEMO_PROJECT_NAME,
        version: '1.0.0',
        private: true,
        type: 'module',
        dependencies: { 'leftpad-real': '^1.0.0' },
        scripts: {
          // 演示环境没有装 tsc / 测试框架，用 node 造出确定性结果。
          // 真实项目里这里就是 `tsc --noEmit` 与真实的测试命令。
          typecheck: opts.typecheckPasses === false ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"',
          test:
            opts.testsPass === false
              ? 'node -e "console.log(\'# pass 3\\n# fail 1\'); process.exit(1)"'
              : 'node -e "console.log(\'# pass 4\\n# fail 0\')"',
        },
      },
      null,
      2,
    ),
  );
  await w(
    'node_modules/leftpad-real/package.json',
    JSON.stringify({ name: 'leftpad-real', version: '1.0.0', types: 'index.d.ts', main: 'index.js' }, null, 2),
  );
  await w(
    'node_modules/leftpad-real/index.d.ts',
    ['export declare function padLeft(s: string, n: number): string;', ''].join('\n'),
  );
  await w('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2023' } }, null, 2));

  return demoProfile(root);
}

/**
 * 从工作区推导 ProjectProfile。
 * 有 typecheck / test 脚本才配置对应锚点 —— 没有就如实为空，让 A4/A5 报 SKIPPED 而不是 PASS。
 */
export function demoProfile(root: string): ProjectProfile {
  return {
    name: DEMO_PROJECT_NAME,
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: { cmd: 'npm', args: ['run', 'typecheck'] },
    test: { cmd: 'npm', args: ['run', 'test'] },
    run: null,
    knownPackages: ['lodash', 'express', 'react', 'zod'],
    dependencyAllowlist: null,
  };
}

// ════════════════════════════════════════════════════════════════
// Mock 脚本
// ════════════════════════════════════════════════════════════════

/** 各角色「正常发挥」时的产出。 */
export function demoScript(over: Record<string, unknown> = {}): Record<string, unknown> {
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
      files: [{ path: 'tests/tasks.test.ts', content: TEST_CODE }],
      covers: ['R-001', 'R-002'],
    },
    'produce:AnchoredReview': { stage: 'REVIEW', objections: [], noObjection: true },
    'verify:requirements': {
      requirementVerdicts: [
        {
          requirementId: 'R-001',
          verdict: 'met',
          rationale: 'createTask 已实现并在测试中被验证',
          evidenceRefs: [
            { kind: 'file', path: 'src/api/routes.ts', startLine: 10, endLine: 14, expect: 'createTask' },
          ],
        },
        {
          requirementId: 'R-002',
          verdict: 'met',
          rationale: 'listTasks 已实现',
          evidenceRefs: [
            { kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8, expect: 'listTasks' },
          ],
        },
      ],
    },
    ...over,
  };
}

/** 一条「主理人说谎」的异议：声称编译失败，并配一个必然非零退出的假 falsifier。 */
export function lyingObjection(): Record<string, unknown> {
  return {
    id: 'O-1',
    stage: 'REVIEW',
    author: 'host',
    targetRole: 'backend',
    severity: 'blocker',
    claim: '后端代码编译失败，类型检查无法通过，任何下游工作都不该继续',
    evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 9 }],
    falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    claimHash: 'a1a1a1a1a1a1a1a1',
    evidenceHash: 'b1b1b1b1b1b1b1b1',
    createdAt: new Date().toISOString(),
  };
}

/** 一条「甩锅」的异议：无法归因 → 不阻断，但触发 T2 圆桌。 */
export function unattributedObjection(): Record<string, unknown> {
  return {
    id: 'O-9',
    stage: 'REVIEW',
    author: 'host',
    targetRole: 'UNRESOLVED',
    severity: 'blocker',
    claim: '整体架构不合理，前后端职责边界不清，建议推倒重来',
    evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 4 }],
    falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    claimHash: 'c9c9c9c9c9c9c9c9',
    evidenceHash: 'd9d9d9d9d9d9d9d9',
    createdAt: new Date().toISOString(),
  };
}

/** 圆桌四方的「有证据发言」（无证据的发言会被机械主持直接丢弃）。 */
export function roundtableSpeakers(): Record<string, unknown> {
  return {
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
  };
}

/** 「和稀泥」决议：没有行动项 —— 会被 validateResolution 机械判无效。 */
export function hedgingResolution(): Record<string, unknown> {
  return {
    attribution: 'SHARED',
    decision: '综合考虑各方意见，大家都有道理，后续加强沟通',
    actions: [],
  };
}

/** 可执行决议：有明确 owner 与可被锚点验证的验收条件。 */
export function actionableResolution(): Record<string, unknown> {
  return {
    attribution: 'SHARED',
    decision: '确认以冻结契约为职责边界的唯一依据，并在代码注释中标明所属层',
    actions: [
      {
        owner: 'backend',
        action: '在 src/api/routes.ts 顶部加入分层说明注释',
        acceptance: ['A4 锚点 PASS', 'A7 锚点 PASS'],
      },
    ],
  };
}

// ════════════════════════════════════════════════════════════════
// 交叉质询场景（P5）：第 2 轮的反驳**当场执行**
// ════════════════════════════════════════════════════════════════

/**
 * 一条**真的会失败**的检查：演示项目的测试是占位测试，
 * 它只 import 了 `node:test` 与 `assert`，从未 import 被测模块 ——
 * 因此它不可能覆盖任何需求，而 TestSuite 工件却声称 `covers: ['R-001','R-002']`。
 *
 * 用「测试是否 import 了被测模块」而不是「测试文件里有没有出现 R-001 字样」来判定：
 * 后者会被注释里的字样骗过去（TEST_CODE 的注释里恰好写着 R-001 / R-002）。
 * 这正是 A7 锚点踩过的坑，这里不再踩第二次。
 */
export const HOLLOW_TEST_FALSIFIER =
  "node -e \"const fs=require('fs');const t=fs.readFileSync('tests/tasks.test.ts','utf8');" +
  "process.exit(/import[^;]*api\\/routes/.test(t)?0:1)\"";

/**
 * 交叉质询场景的发言：
 *   第 1 轮：四方各自给出有证据的立场。
 *   第 2 轮：backend 对 test 提出一个**可执行**的反驳 ——
 *           机械主持会当场运行它，用执行结果而不是措辞来裁决。
 *
 * 注意轮转配对的结果：第 1 轮有效发言顺序是 [pm, frontend, backend, test]，
 * 所以 backend 的质询对象是 test（名单里的下一位）。
 */
export function crossExamSpeakers(): Record<string, unknown> {
  const base = roundtableSpeakers();
  const backendR1 = base['roundtable:backend'];
  return {
    ...base,
    'roundtable:backend': (req: { messages: Array<{ role: string; content: string }> }) => {
      const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      // 只在第 2 轮携带 falsifier —— 第 1 轮各方只陈述立场
      if (!user.includes('第 2 轮')) return backendR1;
      return {
        claim: '所谓「已被测试验证」是空的：测试从未 import 被测模块，它不可能覆盖任何需求',
        evidence: [{ kind: 'file', path: 'tests/tasks.test.ts', startLine: 1, endLine: 6 }],
        falsifier: { kind: 'executable', command: HOLLOW_TEST_FALSIFIER, expect: 'exit-nonzero' },
      };
    },
  };
}

/**
 * 一条**与机械事实矛盾**的决议：把责任归给 pm。
 *
 * 这模拟 LLM 最典型的圆桌产物 —— 它无视了刚被执行的机械证据，
 * 习惯性地把问题推给「需求描述不够清楚」。机械证据指向 test，
 * 所以这条决议会被 validateResolution 判无效 → 升级真人。
 */
export function misattributedResolution(): Record<string, unknown> {
  return {
    attribution: 'pm',
    decision: '需求描述过于笼统，验收点不明确，导致测试无法落地，责任在需求侧',
    actions: [
      {
        owner: 'pm',
        action: '重写 R-001 / R-002 的验收条件，给出可观测、可断言的判定点',
        acceptance: ['A7 锚点 PASS'],
      },
    ],
  };
}

// ════════════════════════════════════════════════════════════════
// 预设场景（控制台与演示脚本共用）
// ════════════════════════════════════════════════════════════════

export type DemoScenarioId = 'clean' | 'hallucination' | 'deadlock' | 'cross-exam' | 'real-app';

export type DemoScenario = {
  id: DemoScenarioId;
  title: string;
  description: string;
  /** 人类是否可用：决定第 2 层（升级真人）还是第 3 层（带债通过）逃生。 */
  humanAvailable: boolean;
  /**
   * 脚手架类型。
   * 'real-app' 会装真实工具链（typescript + @types/node）并配真 tsc / 真测试 / 真运行时探针，
   * 因此首次运行需要 npm 网络访问，耗时也更长 —— 但它是唯一能让 A4–A6 全部真实执行的模式。
   */
  kind?: 'mock' | 'real-app';
  buildScript(): Record<string, unknown>;
};

export const DEMO_SCENARIOS: Record<DemoScenarioId, DemoScenario> = {
  clean: {
    id: 'clean',
    title: '干净项目',
    description: '各方面都合规，应当一次通过到 DELIVERED，主理人 precision 100%、零技术债。',
    humanAvailable: false,
    buildScript: () => demoScript(),
  },

  hallucination: {
    id: 'hallucination',
    title: '幻觉 + 主理人说谎',
    description:
      '后端导入真实包中不存在的符号（A2 锚点机械归因并派工单）；' +
      '主理人谎称「编译失败」并配一个必然非零退出的假 falsifier —— 被「A4 已 PASS」证伪。',
    humanAvailable: false,
    buildScript: () => {
      let reviewCalls = 0;
      return demoScript({
        'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_HALLUCINATED }] },
        'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
        'produce:AnchoredReview': () => {
          reviewCalls++;
          if (reviewCalls > 1) return { stage: 'REVIEW', objections: [], noObjection: true };
          return { stage: 'REVIEW', noObjection: false, objections: [lyingObjection()] };
        },
      });
    },
  },

  deadlock: {
    id: 'deadlock',
    title: '甩锅 + 和稀泥 + 真人不可用',
    description:
      '无法归因的异议触发 T2 圆桌；圆桌产出的「综合考虑、大家都有道理」被机械校验拒绝；' +
      '真人不可用 → 第 3 层逃生：带债通过，写出 TECH_DEBT.md 并把需求标为 ACCEPTED_WITH_DEBT。',
    humanAvailable: false,
    buildScript: () =>
      demoScript({
        'produce:AnchoredReview': {
          stage: 'REVIEW',
          noObjection: false,
          objections: [unattributedObjection()],
        },
        ...roundtableSpeakers(),
        'roundtable:resolution': hedgingResolution(),
        'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
      }),
  },

  'cross-exam': {
    id: 'cross-exam',
    title: '交叉质询：反驳当场执行，决议被机械证据否决',
    description:
      '无法归因的异议触发 T2 圆桌。第 2 轮 backend 对 test 提出一个**可执行**的反驳 —— ' +
      '机械主持当场运行它（检查测试是否真的 import 了被测模块），确认「测试是占位」属实。' +
      '随后产出的决议却习惯性地把责任推给 pm，与刚被执行的机械证据矛盾 → 决议被判无效 → ' +
      '升级真人裁决（这是唯一演示第 2 层逃生的场景）。',
    humanAvailable: true,
    buildScript: () =>
      demoScript({
        'produce:AnchoredReview': {
          stage: 'REVIEW',
          noObjection: false,
          objections: [unattributedObjection()],
        },
        ...crossExamSpeakers(),
        'roundtable:resolution': misattributedResolution(),
        'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_CODE }] },
      }),
  },

  'real-app': {
    id: 'real-app',
    title: '真实小应用（真 tsc / 真测试 / 真运行时）',
    description:
      '生成一个真的能编译、能跑、有测试的任务看板应用。与上面三个场景不同，这里的 A4/A5/A6 ' +
      '是**真检查**：真跑 tsc --noEmit、真跑测试套件、真启动 HTTP 服务并探针。' +
      '首次运行需要 npm 下载 typescript 与 @types/node（之后有缓存），耗时约 10–30 秒。',
    humanAvailable: false,
    kind: 'real-app',
    // 真实脚本由 real-app-project 提供；这里只做转发，避免两处维护同一份代码
    buildScript: () => realAppScript(),
  },
};
