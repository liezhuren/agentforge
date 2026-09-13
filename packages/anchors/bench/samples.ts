/**
 * 幻觉靶场 · 样本集。
 *
 * 组织方式：**每个注入样本都配一个干净对照组**。
 * 例如「编造的 import 路径」（期望 A3 FAIL）对应「真实的 import 路径」（期望干净）。
 * 没有对照组的检出率没有意义 —— 一个永远返回 FAIL 的锚点检出率是 100%。
 *
 * 覆盖的幻觉形态，按「模型实际会怎么错」来设计，而不是按「锚点怎么实现的」：
 *   编造包名 / 编造符号 / 编造模块路径 / 类型不匹配 / 假装测过 / 服务起不来 /
 *   契约漂移 / 编造证据 / 需求丢失 …
 *
 * 诚实声明：这些样本是**我手写的**，所以它测的是「锚点能不能抓出我想到的这类幻觉」，
 * 而不是「锚点能不能抓出真实世界里的所有幻觉」。
 */

import { execPath } from 'node:process';
import type { BenchContext, BenchSample } from './harness.ts';

const OK_TSC = { cmd: execPath, args: ['-e', 'process.exit(0)'] };
const BAD_TSC = { cmd: execPath, args: ['-e', 'console.log("src/a.ts(1,1): error TS2304: Cannot find name x");process.exit(1)'] };
const OK_TEST = { cmd: execPath, args: ['-e', "console.log('# pass 3\\n# fail 0')"] };
const BAD_TEST = { cmd: execPath, args: ['-e', "console.log('# pass 2\\n# fail 1');process.exit(1)"] };
const ZERO_TEST = { cmd: execPath, args: ['-e', "console.log('# pass 0\\n# fail 0')"] };

/** 一个真实存在的假包：A2 必须能读到它的 .d.ts 才能判断符号存不存在。 */
const LEFTPAD = {
  dts: [
    'export declare function padLeft(s: string, n: number): string;',
    'export declare function padRight(s: string, n: number): string;',
    '',
  ].join('\n'),
  js: 'exports.padLeft = () => ""; exports.padRight = () => "";\n',
};

/** 一份「正好合规」的契约内容。 */
export const GOOD_CONTRACT = {
  version: 1,
  openapi: { openapi: '3.1.0', paths: { '/api/tasks': {} } },
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
};

/** 契约生成的共享类型文件（真实项目里由确定性代码生成器写出）。 */
const GENERATED_TYPES = [
  '// 本文件由 AgentForge 从冻结契约自动生成，请勿手工编辑。',
  'export interface Task {',
  '  id: string;',
  '  title: string;',
  '}',
  '',
  'export const API_PATHS = { "/api/tasks": "/api/tasks" } as const;',
  '',
].join('\n');

/** 一段合规的后端代码：导入契约类型、实现契约端点。 */
const GOOD_API = [
  "import type { Task } from '../../shared/contract/types.ts';",
  '',
  'export function listTasks(): Task[] {',
  '  return [];',
  '}',
  '',
  "export const ROUTES = ['/api/tasks'];",
  '',
].join('\n');

/** 一段合规的前端代码。 */
const GOOD_WEB = [
  "import type { Task } from '../../shared/contract/types.ts';",
  '',
  'export async function loadTasks(): Promise<Task[]> {',
  "  const res = await fetch('/api/tasks');",
  '  return res.json();',
  '}',
  '',
].join('\n');

/** 一份「正好合规」的需求集 + PRD + 任务图 + 测试套件，供 B2 使用。 */
async function seedCoverage(
  ctx: BenchContext,
  over: {
    prdIds?: string[];
    taskReqIds?: string[];
    covers?: string[];
  } = {},
): Promise<void> {
  const prdIds = over.prdIds ?? ['R-001', 'R-002'];
  const taskReqIds = over.taskReqIds ?? ['R-001', 'R-002'];
  const covers = over.covers ?? ['R-001', 'R-002'];

  await ctx.pkg({ name: 'bench', version: '1.0.0', private: true });
  await ctx.file('src/api/routes.ts', GOOD_API);
  await ctx.artifact({
    kind: 'Requirement',
    producer: 'pm',
    content: {
      requirements: [
        { id: 'R-001', text: '用户可以创建任务', acceptance: ['POST /api/tasks 返回 201'], priority: 'must', status: 'open', origin: 'user' },
        { id: 'R-002', text: '用户可以列出全部任务', acceptance: ['GET /api/tasks 返回 200'], priority: 'must', status: 'open', origin: 'user' },
      ],
    },
  });
  await ctx.artifact({
    kind: 'PRD',
    producer: 'pm',
    content: {
      title: '看板 PRD',
      summary: '提供任务的创建与查询能力，覆盖两条 must 级需求。',
      requirementIds: prdIds,
      milestones: [],
      nonGoals: [],
    },
  });
  await ctx.artifact({
    kind: 'TaskGraph',
    producer: 'pm',
    content: {
      tasks: [
        {
          id: 'T-01',
          title: '实现任务 API',
          owner: 'backend',
          scope: 'api',
          dependsOn: [],
          requirementIds: taskReqIds,
          deliverable: 'CodeModule',
          acceptance: ['A4 锚点 PASS'],
        },
      ],
    },
  });
  await ctx.artifact({
    kind: 'CodeModule',
    producer: 'backend',
    scope: 'api',
    content: { files: [{ path: 'src/api/routes.ts', content: GOOD_API }] },
  });
  await ctx.artifact({
    kind: 'TestSuite',
    producer: 'test',
    content: {
      framework: 'node:test',
      files: [{ path: 'tests/a.test.ts', content: '// placeholder\n' }],
      covers,
    },
  });
}

// ════════════════════════════════════════════════════════════════
// 样本
// ════════════════════════════════════════════════════════════════

export const SAMPLES: BenchSample[] = [
  // ── A1 包真实性 ──────────────────────────────────────────────
  {
    id: 'A1-01-invalid-name',
    group: 'A1 包真实性',
    title: '包名非法（大写）',
    injection: '依赖写成 "Task-Queue" —— npm 包名必须全小写，这是编造包的最强信号',
    anchors: ['A1'],
    expect: { kind: 'detect', anchorId: 'A1', atLeast: 'FAIL' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { 'Task-Queue': '^1.0.0' } });
    },
  },
  {
    id: 'A1-02-typosquat',
    group: 'A1 包真实性',
    title: '包名拼写近似知名包（typo-squatting）',
    injection: '依赖写成 "loadsh"（与 lodash 编辑距离 2）—— 可能是拼错，也可能是投毒包',
    anchors: ['A1'],
    // 只期望 WARN：拼写相近**不等于**幻觉，判 FAIL 会误伤真实存在的包
    expect: { kind: 'detect', anchorId: 'A1', atLeast: 'WARN' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { loadsh: '^4.17.21' } });
    },
  },
  {
    id: 'A1-03-allowlist',
    group: 'A1 包真实性',
    title: '违反用户约束白名单',
    injection: '用户投了 constraint「只允许 leftpad-real」，代码却引入了 lodash',
    anchors: ['A1'],
    expect: { kind: 'detect', anchorId: 'A1', atLeast: 'FAIL' },
    profile: { dependencyAllowlist: ['leftpad-real'] },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { lodash: '^4.17.21' } });
    },
  },
  {
    id: 'A1-05-denylist-declared',
    group: 'A1 包真实性',
    title: '声明了被真人建议书明确禁止的依赖',
    injection: '用户投了 constraint「不得引入 lodash」，package.json 里却声明了它',
    anchors: ['A1'],
    expect: { kind: 'detect', anchorId: 'A1', atLeast: 'FAIL' },
    profile: { deniedDependencies: ['lodash'] },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { lodash: '^4.17.21' } });
    },
  },
  {
    id: 'A1-06-denylist-imported',
    group: 'A1 包真实性',
    title: '【对抗】导入了被禁的包，但**没有**声明在 package.json 里',
    injection:
      'package.json 里干干净净，代码里却 import 了被禁的 lodash ——' +
      '只查 package.json 的实现会完全漏掉这种情况（依赖可能间接存在、或装在了别处）',
    anchors: ['A1'],
    expect: { kind: 'detect', anchorId: 'A1', atLeast: 'FAIL' },
    profile: { deniedDependencies: ['lodash'] },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', version: '1.0.0' });
      await ctx.file('src/api/routes.ts', "import { chunk } from 'lodash';\n\nexport const x = chunk([], 1);\n");
    },
  },
  {
    id: 'A1-07-denylist-clean',
    group: 'A1 包真实性',
    title: '【对照】黑名单生效时，未列出的包正常放行',
    injection: '无 —— 对照组。禁止了 lodash，但项目用的是 leftpad-real，不该被误伤',
    anchors: ['A1'],
    expect: { kind: 'clean' },
    profile: { deniedDependencies: ['lodash'] },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { 'leftpad-real': '^1.0.0' } });
      await ctx.npm('leftpad-real', LEFTPAD);
      await ctx.file('src/api/routes.ts', "import { padLeft } from 'leftpad-real';\n\nexport const x = padLeft('a', 3);\n");
    },
  },
  {
    id: 'A1-04-clean',
    group: 'A1 包真实性',
    title: '【对照】依赖全部合法且已安装',
    injection: '无 —— 对照组',
    anchors: ['A1'],
    expect: { kind: 'clean' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { 'leftpad-real': '^1.0.0' } });
      await ctx.npm('leftpad-real', LEFTPAD);
      await ctx.file(
        'src/api/routes.ts',
        [
          "import { padLeft } from 'leftpad-real';",
          '',
          'export function pad(s: string): string {',
          '  return padLeft(s, 4);',
          '}',
          '',
        ].join('\n'),
      );
    },
  },

  // ── A2 符号真实性 ────────────────────────────────────────────
  {
    id: 'A2-01-unknown-export',
    group: 'A2 符号真实性',
    title: '包真实存在，但符号不存在（幻觉 API）',
    injection: "import { padRigth } from 'leftpad-real' —— 包是真的，padRigth 从没被导出过",
    anchors: ['A2'],
    expect: { kind: 'detect', anchorId: 'A2', atLeast: 'FAIL' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { 'leftpad-real': '^1.0.0' } });
      await ctx.npm('leftpad-real', LEFTPAD);
      await ctx.file('src/api/routes.ts', "import { padRigth } from 'leftpad-real';\n\nexport const x = padRigth('a', 3);\n");
    },
  },
  {
    id: 'A2-02-real-exports',
    group: 'A2 符号真实性',
    title: '【对照】导入的符号确实被导出',
    injection: '无 —— 对照组（padLeft / padRight 都真实存在）',
    anchors: ['A2'],
    expect: { kind: 'clean' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { 'leftpad-real': '^1.0.0' } });
      await ctx.npm('leftpad-real', LEFTPAD);
      await ctx.file('src/api/routes.ts', "import { padLeft, padRight } from 'leftpad-real';\n\nexport const x = padLeft(padRight('a', 1), 1);\n");
    },
  },
  {
    id: 'A2-03-cjs-default',
    group: 'A2 符号真实性',
    title: 'CJS 包的 default 导入（歧义）',
    injection: "import x from 'cjs-only' —— 只有 module.exports，是否存在 default 在互操作下是歧义的",
    anchors: ['A2'],
    // 只期望 WARN：这类情况判 FAIL 会造成大量误报（Node 的 CJS 互操作会把 module.exports 当 default）
    expect: { kind: 'detect', anchorId: 'A2', atLeast: 'WARN' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench', dependencies: { 'cjs-only': '^1.0.0' } });
      await ctx.npm('cjs-only', { dts: 'declare function thing(): void;\nexport = thing;\n', js: 'module.exports = function () {};\n' });
      await ctx.file('src/api/routes.ts', "import thing from 'cjs-only';\n\nexport const x = thing;\n");
    },
  },

  // ── A3 导入可解析 ────────────────────────────────────────────
  {
    id: 'A3-01-fabricated-path',
    group: 'A3 导入可解析',
    title: '编造的相对模块路径',
    injection: "import { repo } from './task-repository.ts' —— 磁盘上没有这个文件",
    anchors: ['A3'],
    expect: { kind: 'detect', anchorId: 'A3', atLeast: 'FAIL' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.file('src/api/routes.ts', "import { repo } from './task-repository.ts';\n\nexport const x = repo;\n");
    },
  },
  {
    id: 'A3-02-real-path',
    group: 'A3 导入可解析',
    title: '【对照】相对导入真实存在',
    injection: '无 —— 对照组（当前目录下真的有 store.ts）',
    anchors: ['A3'],
    expect: { kind: 'clean' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.file('src/api/store.ts', 'export const repo = 1;\n');
      await ctx.file('src/api/routes.ts', "import { repo } from './store.ts';\n\nexport const x = repo;\n");
    },
  },
  {
    id: 'A3-03-nested-real-path',
    group: 'A3 导入可解析',
    title: '【对照】跨目录相对导入（验证解析基准是「导入文件所在目录」而非项目根）',
    injection: '无 —— 对照组。这条专门防止把「项目根解析」的旧 bug 改回来',
    anchors: ['A3'],
    expect: { kind: 'clean' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.file('src/api/deep/nested.ts', 'export const deep = 1;\n');
      await ctx.file('src/api/routes.ts', "import { deep } from './deep/nested.ts';\n\nexport const x = deep;\n");
    },
  },

  // ── A4 编译 ──────────────────────────────────────────────────
  {
    id: 'A4-01-compile-error',
    group: 'A4 编译/类型',
    title: '类型检查报错',
    injection: 'tsc 输出一条 TS2304 错误并以非零码退出',
    anchors: ['A4'],
    expect: { kind: 'detect', anchorId: 'A4', atLeast: 'FAIL' },
    profile: { typecheck: BAD_TSC },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.file('src/a.ts', 'export const x: number = undefined as never;\n');
    },
  },
  {
    id: 'A4-02-clean-compile',
    group: 'A4 编译/类型',
    title: '【对照】类型检查通过',
    injection: '无 —— 对照组',
    anchors: ['A4'],
    expect: { kind: 'clean' },
    profile: { typecheck: OK_TSC },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.file('src/a.ts', 'export const x = 1;\n');
    },
  },
  {
    id: 'A4-03-toolchain-missing',
    group: 'A4 编译/类型',
    title: '工具链缺失（必须明确表示未验证，而不是 PASS）',
    injection: '未安装 typecheck 工具 —— 这不是「发现缺陷」，而是「无法验证」',
    anchors: ['A4'],
    // 测的不变量是 SKIPPED ≠ PASS，不是「必须报 FAIL」。
    // 一开始我把它归进 detect/WARN，结果把锚点的**正确**行为判成了漏报 ——
    // 靶场跑起来之后才发现评分标准本身需要一档「诚实跳过」。
    expect: { kind: 'not-pass', anchorId: 'A4' },
    profile: { typecheck: { cmd: 'definitely-not-installed-tool', args: [] } },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.file('src/a.ts', 'export const x = 1;\n');
    },
  },

  // ── A5 测试 ──────────────────────────────────────────────────
  {
    id: 'A5-01-tests-failed',
    group: 'A5 测试执行',
    title: '测试失败',
    injection: '测试汇总里 fail=1 且退出码非零',
    anchors: ['A5'],
    expect: { kind: 'detect', anchorId: 'A5', atLeast: 'FAIL' },
    profile: { test: BAD_TEST },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
    },
  },
  {
    id: 'A5-02-no-tests-ran',
    group: 'A5 测试执行',
    title: '声明了测试套件却 0 项通过（假装测过）',
    injection: 'TestSuite 工件存在，但测试命令报 pass=0 —— 典型的「假装测过」',
    anchors: ['A5'],
    expect: { kind: 'detect', anchorId: 'A5', atLeast: 'FAIL' },
    profile: { test: ZERO_TEST },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.artifact({
        kind: 'TestSuite',
        producer: 'test',
        content: { framework: 'node:test', files: [{ path: 'tests/a.test.ts', content: '// 空测试\n' }], covers: ['R-001'] },
      });
    },
  },
  {
    id: 'A5-03-clean-tests',
    group: 'A5 测试执行',
    title: '【对照】测试全部通过',
    injection: '无 —— 对照组',
    anchors: ['A5'],
    expect: { kind: 'clean' },
    profile: { test: OK_TEST },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.artifact({
        kind: 'TestSuite',
        producer: 'test',
        content: { framework: 'node:test', files: [{ path: 'tests/a.test.ts', content: '// 真测试\n' }], covers: ['R-001'] },
      });
    },
  },
  {
    id: 'A5-04-no-test-command',
    group: 'A5 测试执行',
    title: '未配置测试命令（必须明确表示未验证）',
    injection: 'profile 里没有 test —— 未验证，不能被当作通过',
    anchors: ['A5'],
    expect: { kind: 'not-pass', anchorId: 'A5' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
    },
  },
  {
    id: 'A5-05-unparseable-output',
    group: 'A5 测试执行',
    title: '【对抗】测试命令退出 0，但输出里没有任何可解析的测试计数',
    injection:
      '命令成功但什么都没说（没有 pass/fail 计数，也没有 TestSuite 工件）——' +
      '这种情况下「退出码为 0」并不等于「测试通过」，锚点必须说明它其实什么都没验证到',
    anchors: ['A5'],
    expect: { kind: 'detect', anchorId: 'A5', atLeast: 'WARN' },
    profile: { test: { cmd: execPath, args: ['-e', "console.log('all good, nothing to report')"] } },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
    },
  },

  // ── A6 运行时 ────────────────────────────────────────────────
  {
    id: 'A6-01-runtime-crash',
    group: 'A6 运行时',
    title: '服务启动即崩溃',
    injection: '进程打印错误后以退出码 2 结束 —— 编译通过 ≠ 能跑',
    anchors: ['A6'],
    expect: { kind: 'detect', anchorId: 'A6', atLeast: 'FAIL' },
    profile: {
      run: {
        cmd: execPath,
        args: ['-e', "console.error('boom: missing env DB_URL'); process.exit(2);"],
        healthUrl: 'http://127.0.0.1:39581/health',
      },
    },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
    },
  },
  {
    id: 'A6-02-clean-runtime',
    group: 'A6 运行时',
    title: '【对照】服务正常启动并响应探针',
    injection: '无 —— 对照组（真的起一个 HTTP 服务）',
    anchors: ['A6'],
    expect: { kind: 'clean' },
    profile: {
      run: {
        cmd: execPath,
        args: ['-e', "require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(39582)"],
        healthUrl: 'http://127.0.0.1:39582/health',
      },
    },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
    },
  },

  // ── A7 契约一致性 ────────────────────────────────────────────
  {
    id: 'A7-01-not-frozen',
    group: 'A7 契约一致性',
    title: '契约未冻结',
    injection: '契约存在但没有 frozenHash —— 前后端无法保证基于同一版本工作',
    anchors: ['A7'],
    expect: { kind: 'detect', anchorId: 'A7', atLeast: 'FAIL' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.artifact({ kind: 'Contract', producer: 'pm', content: GOOD_CONTRACT });
      await ctx.file('shared/contract/types.ts', GENERATED_TYPES);
      await ctx.file('src/api/routes.ts', GOOD_API);
    },
  },
  {
    id: 'A7-02-missing-generated-types',
    group: 'A7 契约一致性',
    title: '契约声明的生成类型文件不存在',
    injection: '契约说生成到 shared/contract/types.ts，但那个文件根本不在 —— 前后端只能各自手写类型',
    anchors: ['A7'],
    expect: { kind: 'detect', anchorId: 'A7', atLeast: 'FAIL' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      const id = await ctx.artifact({ kind: 'Contract', producer: 'pm', content: GOOD_CONTRACT });
      await ctx.file('src/api/routes.ts', GOOD_API);
      void id;
    },
  },
  {
    id: 'A7-03-unimplemented-endpoint',
    group: 'A7 契约一致性',
    title: '契约端点未被后端实现',
    injection: '契约声明 /api/tasks，但后端代码里找不到任何实现痕迹',
    anchors: ['A7'],
    expect: { kind: 'detect', anchorId: 'A7', atLeast: 'FAIL' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.artifact({ kind: 'Contract', producer: 'pm', content: GOOD_CONTRACT });
      await ctx.file('shared/contract/types.ts', GENERATED_TYPES);
      await ctx.artifact({
        kind: 'CodeModule',
        producer: 'backend',
        scope: 'api',
        content: { files: [{ path: 'src/api/routes.ts', content: "import type { Task } from '../../shared/contract/types.ts';\nexport const nothing = 1;\n" }] },
      });
    },
  },
  {
    id: 'A7-04-undeclared-endpoint',
    group: 'A7 契约一致性',
    title: '前端调用了契约未声明的端点',
    injection: "前端 fetch('/api/legacy/tasks') —— 契约里只有 /api/tasks。这就是契约漂移",
    anchors: ['A7'],
    expect: { kind: 'detect', anchorId: 'A7', atLeast: 'WARN' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      // 必须冻结契约：靶场样本的黄金法则是「只注入一个缺陷」。
      // 忘了冻结会同时注入第二个缺陷（contract-not-frozen 是 FAIL），
      // 于是期望的 WARN 变成 FAIL —— 测出来的就不是「契约漂移能不能被抓到」，
      // 而是「两个缺陷混在一起会怎样」。这类混淆会让指标失去归因能力。
      const id = await ctx.artifact({ kind: 'Contract', producer: 'pm', content: GOOD_CONTRACT });
      await ctx.store.freeze(id);
      await ctx.file('shared/contract/types.ts', GENERATED_TYPES);
      await ctx.artifact({ kind: 'CodeModule', producer: 'backend', scope: 'api', content: { files: [{ path: 'src/api/routes.ts', content: GOOD_API }] } });
      await ctx.artifact({
        kind: 'CodeModule',
        producer: 'frontend',
        scope: 'web',
        content: {
          files: [
            {
              path: 'src/web/client.ts',
              content: "import type { Task } from '../../shared/contract/types.ts';\nexport const load = () => fetch('/api/legacy/tasks');\nexport const t: Task[] = [];\n",
            },
          ],
        },
      });
    },
  },
  {
    id: 'A7-05-contract-duplication',
    group: 'A7 契约一致性',
    title: '手写重复契约模型（契约漂移的源头）',
    injection: '契约里已有 Task，后端却又手写了一份 interface Task，且没引用生成的类型文件',
    anchors: ['A7'],
    expect: { kind: 'detect', anchorId: 'A7', atLeast: 'WARN' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      // 同上：只注入「手写重复模型」这一个缺陷，因此契约必须已冻结
      const id = await ctx.artifact({ kind: 'Contract', producer: 'pm', content: GOOD_CONTRACT });
      await ctx.store.freeze(id);
      await ctx.file('shared/contract/types.ts', GENERATED_TYPES);
      await ctx.artifact({
        kind: 'CodeModule',
        producer: 'backend',
        scope: 'api',
        content: {
          files: [
            {
              path: 'src/api/routes.ts',
              content: "interface Task { id: string; title: string }\nexport const ROUTES = ['/api/tasks'];\nexport const t: Task[] = [];\n",
            },
          ],
        },
      });
    },
  },
  {
    id: 'A7-06-clean-contract',
    group: 'A7 契约一致性',
    title: '【对照】契约冻结、类型已生成、端点已实现、无重复模型',
    injection: '无 —— 对照组',
    anchors: ['A7'],
    expect: { kind: 'clean' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      const id = await ctx.artifact({ kind: 'Contract', producer: 'pm', content: GOOD_CONTRACT });
      await ctx.store.freeze(id);
      await ctx.file('shared/contract/types.ts', GENERATED_TYPES);
      await ctx.artifact({ kind: 'CodeModule', producer: 'backend', scope: 'api', content: { files: [{ path: 'src/api/routes.ts', content: GOOD_API }] } });
      await ctx.artifact({ kind: 'CodeModule', producer: 'frontend', scope: 'web', content: { files: [{ path: 'src/web/client.ts', content: GOOD_WEB }] } });
    },
  },
  {
    id: 'A7-07-endpoint-only-in-comment',
    group: 'A7 契约一致性',
    title: '【对抗】端点只出现在注释里，没有真正实现',
    injection:
      '代码里写着「// TODO: 实现 /api/tasks」，但一行实现都没有 ——' +
      'A7 的端点覆盖检查是**子串匹配**，注释里的路径同样是子串。这条样本专门用来暴露这个弱点',
    anchors: ['A7'],
    expect: { kind: 'detect', anchorId: 'A7', atLeast: 'FAIL' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      const id = await ctx.artifact({ kind: 'Contract', producer: 'pm', content: GOOD_CONTRACT });
      await ctx.store.freeze(id);
      await ctx.file('shared/contract/types.ts', GENERATED_TYPES);
      await ctx.artifact({
        kind: 'CodeModule',
        producer: 'backend',
        scope: 'api',
        content: {
          files: [
            {
              path: 'src/api/routes.ts',
              content:
                "import type { Task } from '../../shared/contract/types.ts';\n\n// TODO: 实现 /api/tasks\nexport const nothing: Task[] = [];\n",
            },
          ],
        },
      });
    },
  },
  {
    id: 'A7-08-clean-parameterized-path',
    group: 'A7 契约一致性',
    title: '【对照】契约声明了带参数的端点，前端用模板字符串调用它',
    injection:
      '无 —— 对照组。契约声明 /api/tasks/{id}，前端写 fetch(`/api/tasks/${id}`)。' +
      '这条用来验证 A7 的「端点归一化」确实能把 {id} 与 ${id} 视作同一个路径，而不是误报契约漂移',
    anchors: ['A7'],
    expect: { kind: 'clean' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      const contract = {
        ...GOOD_CONTRACT,
        openapi: { openapi: '3.1.0', paths: { '/api/tasks': {}, '/api/tasks/{id}': {} } },
      };
      const id = await ctx.artifact({ kind: 'Contract', producer: 'pm', content: contract });
      await ctx.store.freeze(id);
      await ctx.file('shared/contract/types.ts', GENERATED_TYPES);
      await ctx.artifact({
        kind: 'CodeModule',
        producer: 'backend',
        scope: 'api',
        content: {
          files: [
            {
              path: 'src/api/routes.ts',
              content:
                "import type { Task } from '../../shared/contract/types.ts';\n\nexport const ROUTES = ['/api/tasks', '/api/tasks/{id}'];\nexport const list = (): Task[] => [];\n",
            },
          ],
        },
      });
      await ctx.artifact({
        kind: 'CodeModule',
        producer: 'frontend',
        scope: 'web',
        content: {
          files: [
            {
              path: 'src/web/client.ts',
              content:
                "import type { Task } from '../../shared/contract/types.ts';\n\nexport async function load(id: string): Promise<Task> {\n  const res = await fetch(`/api/tasks/${id}`);\n  return res.json();\n}\n",
            },
          ],
        },
      });
    },
  },

  // ── B1 目标达成 ──────────────────────────────────────────────
  {
    id: 'B1-01-fabricated-evidence',
    group: 'B1 目标达成',
    title: '判定引用了不存在的文件',
    injection: '提议说「我实现了」，证据指向 src/api/ghost.ts —— 该文件不存在',
    anchors: ['B1'],
    expect: { kind: 'detect', anchorId: 'B1', atLeast: 'FAIL' },
    proposals: {
      requirementVerdicts: [
        { requirementId: 'R-001', verdict: 'met', rationale: '已实现', evidenceRefs: [{ kind: 'file', path: 'src/api/ghost.ts', startLine: 1, endLine: 3 }] },
        { requirementId: 'R-002', verdict: 'met', rationale: '已实现', evidenceRefs: [{ kind: 'file', path: 'src/api/ghost.ts', startLine: 1, endLine: 3 }] },
      ],
    },
    build: async (ctx) => {
      await seedCoverage(ctx);
    },
  },
  {
    id: 'B1-02-line-out-of-range',
    group: 'B1 目标达成',
    title: '证据行号越界',
    injection: '证据声称第 999 行 —— 文件只有几行。编造证据的典型形态',
    anchors: ['B1'],
    expect: { kind: 'detect', anchorId: 'B1', atLeast: 'FAIL' },
    proposals: {
      requirementVerdicts: [
        { requirementId: 'R-001', verdict: 'met', rationale: '已实现', evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 999, endLine: 1000 }] },
        { requirementId: 'R-002', verdict: 'met', rationale: '已实现', evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 999, endLine: 1000 }] },
      ],
    },
    build: async (ctx) => {
      await seedCoverage(ctx);
    },
  },
  {
    id: 'B1-03-content-mismatch',
    group: 'B1 目标达成',
    title: '引用的行区间不含所声称的内容',
    injection: '证据引用第 1 行并声称那里有 createTask —— 那一行其实是 import',
    anchors: ['B1'],
    expect: { kind: 'detect', anchorId: 'B1', atLeast: 'FAIL' },
    proposals: {
      requirementVerdicts: [
        { requirementId: 'R-001', verdict: 'met', rationale: 'createTask 在第 1 行', evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 1, expect: 'createTask' }] },
        { requirementId: 'R-002', verdict: 'met', rationale: 'listTasks 在第 1 行', evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 1, expect: 'listTasks' }] },
      ],
    },
    build: async (ctx) => {
      await seedCoverage(ctx);
    },
  },
  {
    id: 'B1-04-clean-evidence',
    group: 'B1 目标达成',
    title: '【对照】证据真实且指向正确内容',
    injection: '无 —— 对照组（第 3-5 行确实是 listTasks）',
    anchors: ['B1'],
    expect: { kind: 'clean' },
    proposals: {
      requirementVerdicts: [
        { requirementId: 'R-001', verdict: 'met', rationale: 'listTasks 已实现', evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 3, endLine: 5, expect: 'listTasks' }] },
        { requirementId: 'R-002', verdict: 'met', rationale: 'listTasks 已实现', evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 3, endLine: 5, expect: 'listTasks' }] },
      ],
    },
    build: async (ctx) => {
      await seedCoverage(ctx);
    },
  },

  // ── B2 需求覆盖 ──────────────────────────────────────────────
  {
    id: 'B2-01-missing-in-prd',
    group: 'B2 需求覆盖',
    title: '需求在传递中丢失（未进 PRD）',
    injection: 'PRD 只覆盖 R-001，R-002 消失了',
    anchors: ['B2'],
    expect: { kind: 'detect', anchorId: 'B2', atLeast: 'FAIL' },
    build: async (ctx) => {
      await seedCoverage(ctx, { prdIds: ['R-001'] });
    },
  },
  {
    id: 'B2-02-untasked',
    group: 'B2 需求覆盖',
    title: '需求没有任何任务实现',
    injection: '任务图只覆盖 R-001',
    anchors: ['B2'],
    expect: { kind: 'detect', anchorId: 'B2', atLeast: 'FAIL' },
    build: async (ctx) => {
      await seedCoverage(ctx, { taskReqIds: ['R-001'] });
    },
  },
  {
    id: 'B2-03-untested',
    group: 'B2 需求覆盖',
    title: 'must 级需求无测试覆盖',
    injection: 'TestSuite.covers 只声明了 R-001',
    anchors: ['B2'],
    expect: { kind: 'detect', anchorId: 'B2', atLeast: 'FAIL' },
    build: async (ctx) => {
      await seedCoverage(ctx, { covers: ['R-001'] });
    },
  },
  {
    id: 'B2-04-clean-coverage',
    group: 'B2 需求覆盖',
    title: '【对照】需求 → PRD → 任务 → 产物 → 测试 全覆盖',
    injection: '无 —— 对照组',
    anchors: ['B2'],
    expect: { kind: 'clean' },
    build: async (ctx) => {
      await seedCoverage(ctx);
    },
  },
  {
    id: 'B2-05-not-started',
    group: 'B2 需求覆盖',
    title: '【对照】实现尚未开始（必须在 WARN 而不是 FAIL）',
    injection: '无 —— 对照组。「还没写代码」不是缺陷，在 PLANNING 阶段必然如此',
    anchors: ['B2'],
    expect: { kind: 'clean' },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.artifact({
        kind: 'Requirement',
        producer: 'pm',
        content: {
          requirements: [
            { id: 'R-001', text: '用户可以创建任务', acceptance: ['POST /api/tasks 返回 201'], priority: 'must', status: 'open', origin: 'user' },
          ],
        },
      });
      await ctx.artifact({
        kind: 'PRD',
        producer: 'pm',
        content: { title: 'P', summary: '这是一个足够长的摘要文本', requirementIds: ['R-001'], milestones: [], nonGoals: [] },
      });
      await ctx.artifact({
        kind: 'TaskGraph',
        producer: 'pm',
        content: {
          tasks: [
            {
              id: 'T-01',
              title: '实现 API',
              owner: 'backend',
              scope: 'api',
              dependsOn: [],
              requirementIds: ['R-001'],
              deliverable: 'CodeModule',
              acceptance: ['A4 锚点 PASS'],
            },
          ],
        },
      });
    },
  },

  // ── B3 对抗审查 ──────────────────────────────────────────────
  {
    id: 'B3-01-objection-fake-evidence',
    group: 'B3 对抗审查',
    title: '主理人的异议引用了不存在的证据',
    injection: '异议声称「后端隐藏了未授权调用」，证据指向不存在文件 —— 机械裁判应据此判其不可证伪',
    anchors: ['B3'],
    expect: { kind: 'detect', anchorId: 'B3', atLeast: 'FAIL' },
    proposals: { objections: [{ id: 'O-1', evidence: [{ kind: 'file', path: 'src/api/hidden.ts', startLine: 1, endLine: 2 }] }] },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.artifact({
        kind: 'AnchoredReview',
        producer: 'host',
        content: {
          stage: 'REVIEW',
          noObjection: false,
          objections: [
            {
              id: 'O-1',
              stage: 'REVIEW',
              author: 'host',
              targetRole: 'backend',
              severity: 'blocker',
              claim: '后端在隐藏文件里做了未授权的外部调用',
              evidence: [{ kind: 'file', path: 'src/api/hidden.ts', startLine: 1, endLine: 2 }],
              falsifier: { kind: 'question', text: '谁确认？' },
              claimHash: 'a'.repeat(16),
              evidenceHash: 'b'.repeat(16),
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    },
  },
  {
    id: 'B3-02-clean-objection',
    group: 'B3 对抗审查',
    title: '【对照】异议证据真实存在',
    injection: '无 —— 对照组',
    anchors: ['B3'],
    expect: { kind: 'clean' },
    proposals: { objections: [{ id: 'O-2', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }] }] },
    build: async (ctx) => {
      await ctx.pkg({ name: 'bench' });
      await ctx.file('src/api/routes.ts', GOOD_API);
      await ctx.artifact({
        kind: 'AnchoredReview',
        producer: 'host',
        content: {
          stage: 'REVIEW',
          noObjection: false,
          objections: [
            {
              id: 'O-2',
              stage: 'REVIEW',
              author: 'host',
              targetRole: 'backend',
              severity: 'blocker',
              claim: '后端导入了契约类型但没有校验响应结构',
              evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }],
              falsifier: { kind: 'question', text: '谁来确认响应校验策略？' },
              claimHash: 'c'.repeat(16),
              evidenceHash: 'd'.repeat(16),
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    },
  },
];

/** 供报告与测试使用：正例（注入了幻觉）与对照组的数量。 */
export const SAMPLE_STATS = {
  total: SAMPLES.length,
  injected: SAMPLES.filter((s) => s.expect.kind !== 'clean').length,
  clean: SAMPLES.filter((s) => s.expect.kind === 'clean').length,
  groups: [...new Set(SAMPLES.map((s) => s.group))],
};
