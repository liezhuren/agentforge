import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { ArtifactStore, resolveExecutable, type ProjectProfile } from '../../core/src/index.ts';
import {
  A6,
  ALL_ANCHORS,
  ANCHOR_INDEX,
  attributeByArtifact,
  attributeByPath,
  attributionOf,
  createAnchorContext,
  runAnchors,
  type SemanticProposals,
} from '../src/index.ts';

// ════════════════════════════════════════════════════════════════
// 幻觉靶场：在真实磁盘上构造一个「被模型写坏了的项目」
// ════════════════════════════════════════════════════════════════

type Fixture = {
  root: string;
  store: ArtifactStore;
  profile: ProjectProfile;
  cleanup(): Promise<void>;
};

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

function baseProfile(over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: 'fixture',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: null,
    test: null,
    run: null,
    knownPackages: ['lodash', 'express', 'react', 'zod'],
    dependencyAllowlist: null,
    ...over,
  };
}

/**
 * 构造靶场：
 *  - leftpad-real：真实存在于 node_modules，且**确实导出** padLeft
 *  - Left-Pad：非法包名（幻觉包名的典型形态）
 *  - loadsh：与 lodash 编辑距离 2（typo-squatting）
 *  - src/api/index.ts：导入真实符号、**不存在的符号**（幻觉 API）、**不存在的相对路径**（编造模块）
 */
async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'af-range-'));

  await write(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'fixture',
        version: '1.0.0',
        dependencies: { 'leftpad-real': '^1.0.0', 'Left-Pad': '^1.0.0', loadsh: '^4.17.0' },
      },
      null,
      2,
    ),
  );

  // 真实的假包：有 .d.ts，导出 padLeft / padRight
  await write(
    root,
    'node_modules/leftpad-real/package.json',
    JSON.stringify({ name: 'leftpad-real', version: '1.0.0', types: 'index.d.ts', main: 'index.js' }, null, 2),
  );
  await write(
    root,
    'node_modules/leftpad-real/index.d.ts',
    [
      'export declare function padLeft(s: string, n: number): string;',
      'export declare function padRight(s: string, n: number): string;',
      'export interface PadOptions { char?: string }',
      '',
    ].join('\n'),
  );

  await write(
    root,
    'src/api/index.ts',
    [
      "import { padLeft, padRight } from 'leftpad-real';",
      "import { padRigth } from 'leftpad-real';", // 幻觉符号（拼错）
      "import { helper } from './missing-module.ts';", // 编造的模块路径
      "import { thing } from '@/aliased/thing';", // 别名导入，只警告
      '',
      'export const OK = padLeft(padRight("a", 1), 1) + helper + thing;',
      '',
    ].join('\n'),
  );

  const store = new ArtifactStore(root);
  await store.init();

  return {
    root,
    store,
    profile: baseProfile(),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function ctxFor(f: Fixture, proposals: SemanticProposals = {}, offline = true) {
  return createAnchorContext({
    projectRoot: f.root,
    store: f.store,
    profile: f.profile,
    offline,
    proposals,
    runPrefix: 'test',
  });
}

async function runOne(f: Fixture, id: Parameters<typeof ANCHOR_INDEX.get>[0], proposals: SemanticProposals = {}) {
  const ctx = ctxFor(f, proposals);
  const anchors = [ANCHOR_INDEX.get(id)!];
  const results = await runAnchors(ctx, anchors);
  return results[0];
}

// ════════════════════════════════════════════════════════════════
// A1 · 包真实性
// ════════════════════════════════════════════════════════════════

test('A1：非法包名（幻觉包）被判 FAIL，并机械归因到导入它的角色', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A1');
    assert.equal(r.verdict, 'FAIL');

    const invalid = r.findings.find((x) => x.code === 'invalid-package-name');
    assert.ok(invalid, '应识别出非法包名');
    assert.ok(invalid!.message.includes('Left-Pad'));
    assert.equal(invalid!.targetRole, 'UNRESOLVED', '没有任何文件导入它，归因应为 UNRESOLVED');
  } finally {
    await f.cleanup();
  }
});

test('A1：typo-squatting 与未安装被标记为 WARN 而不是 FAIL', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A1');
    const squat = r.findings.find((x) => x.code === 'typosquat');
    assert.ok(squat, 'loadsh 应被识别为与 lodash 高度相似');
    assert.ok(squat!.message.includes('lodash'));
    assert.equal(squat!.severity, 'warn', '拼写相近不等于幻觉，不应判 FAIL');

    assert.ok(r.findings.some((x) => x.code === 'not-installed' && x.message.includes('loadsh')));
  } finally {
    await f.cleanup();
  }
});

test('A1：离线时绝不报 PASS（未验证 ≠ 通过）', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A1');
    assert.ok(
      r.findings.some((x) => x.code === 'registry-unchecked'),
      '离线必须显式声明远端未核实',
    );
    assert.notEqual(r.verdict, 'PASS');
    assert.equal(r.meta?.registry, 'skipped-offline');
  } finally {
    await f.cleanup();
  }
});

test('A1：缺少 package.json 时 SKIPPED，而不是 PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-nopkg-'));
  try {
    const store = new ArtifactStore(root);
    await store.init();
    const ctx = createAnchorContext({
      projectRoot: root,
      store,
      profile: baseProfile(),
      offline: true,
      runPrefix: 't',
    });
    const [r] = await runAnchors(ctx, [ANCHOR_INDEX.get('A1')!]);
    assert.equal(r.verdict, 'SKIPPED');
    assert.equal(r.authority, 'none');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A1：用户约束白名单（建议书 constraint）生效', async () => {
  const f = await makeFixture();
  try {
    f.profile = baseProfile({ dependencyAllowlist: ['leftpad-real'] });
    const r = await runOne(f, 'A1');
    const disallowed = r.findings.filter((x) => x.code === 'disallowed-dependency');
    assert.equal(disallowed.length, 2, 'Left-Pad 与 loadsh 都应被白名单拦下');
    assert.equal(r.verdict, 'FAIL');
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// A2 · 符号真实性 —— 比「包存在」强一级的关键锚点
// ════════════════════════════════════════════════════════════════

test('A2：包真实存在但符号不存在 → FAIL（幻觉 API）', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A2');
    assert.equal(r.verdict, 'FAIL');

    const bad = r.findings.find((x) => x.code === 'unknown-export');
    assert.ok(bad, 'padRigth 不存在于 leftpad-real 的导出中');
    assert.ok(bad!.message.includes('padRigth'));
    assert.ok(bad!.message.includes('leftpad-real'));
    assert.equal(bad!.file, 'src/api/index.ts');
    assert.equal(bad!.line, 2);
    assert.equal(bad!.targetRole, 'backend', 'src/api/** 应机械归因到后端');
  } finally {
    await f.cleanup();
  }
});

test('A2：真实存在的符号不得被误报（防误杀）', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A2');
    const wrongly = r.findings.filter(
      (x) => x.code === 'unknown-export' && (x.message.includes('padLeft') || x.message.includes('padRight')),
    );
    assert.equal(wrongly.length, 0, 'padLeft/padRight 确实存在，不得误报');
  } finally {
    await f.cleanup();
  }
});

test('A2：无法定位入口时降级为 WARN 并把 authority 标为 approximate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-noentry-'));
  try {
    await write(
      root,
      'package.json',
      JSON.stringify({ name: 'x', dependencies: { weird: '1.0.0' } }, null, 2),
    );
    await write(root, 'node_modules/weird/package.json', JSON.stringify({ name: 'weird' }));
    await write(root, 'src/web/app.ts', "import { nothing } from 'weird';\n");

    const store = new ArtifactStore(root);
    await store.init();
    const ctx = createAnchorContext({
      projectRoot: root,
      store,
      profile: baseProfile(),
      offline: true,
      runPrefix: 't',
    });
    const [r] = await runAnchors(ctx, [ANCHOR_INDEX.get('A2')!]);
    assert.equal(r.verdict, 'WARN');
    assert.equal(r.authority, 'approximate');
    assert.equal(r.findings[0].targetRole, 'frontend');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// A3 · 导入可解析
// ════════════════════════════════════════════════════════════════

test('A3：编造的相对模块路径 → FAIL 且带文件+行', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A3');
    assert.equal(r.verdict, 'FAIL');
    const bad = r.findings.find((x) => x.code === 'unresolved-import');
    assert.ok(bad);
    assert.ok(bad!.message.includes('./missing-module.ts'));
    assert.equal(bad!.line, 3);
    assert.equal(bad!.targetRole, 'backend');
  } finally {
    await f.cleanup();
  }
});

test('A3：别名导入只警告不误杀', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A3');
    assert.ok(r.findings.some((x) => x.code === 'alias-unresolved'));
    assert.equal(
      r.findings.filter((x) => x.code === 'unresolved-import').length,
      1,
      '别名导入不得被算作未解析',
    );
  } finally {
    await f.cleanup();
  }
});

test('A3：真实存在的相对导入必须放行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-relok-'));
  try {
    await write(root, 'src/api/real.ts', 'export const a = 1;\n');
    await write(root, 'src/api/index.ts', "import { a } from './real.ts';\nexport const b = a;\n");
    const store = new ArtifactStore(root);
    await store.init();
    const ctx = createAnchorContext({
      projectRoot: root,
      store,
      profile: baseProfile(),
      offline: true,
      runPrefix: 't',
    });
    const [r] = await runAnchors(ctx, [ANCHOR_INDEX.get('A3')!]);
    assert.equal(r.verdict, 'PASS');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// A4 · 编译 / 类型检查
// ════════════════════════════════════════════════════════════════

test('A4：未配置 typecheck → SKIPPED（未验证 ≠ 通过）', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A4');
    assert.equal(r.verdict, 'SKIPPED');
    assert.ok(r.findings[0].message.includes('未验证 ≠ 通过'));
  } finally {
    await f.cleanup();
  }
});

test('A4：结构化诊断被解析并机械归因（真实执行子进程）', async () => {
  const f = await makeFixture();
  try {
    f.profile = baseProfile({
      typecheck: {
        cmd: process.execPath,
        args: [
          '-e',
          [
            "console.log('src/api/index.ts(2,10): error TS2305: Module has no exported member padRigth');",
            "console.log('src/web/app.tsx(9,3): error TS2322: Type string is not assignable');",
            'process.exit(1);',
          ].join(''),
        ],
      },
    });
    const r = await runOne(f, 'A4');
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.findings.length, 2);

    const api = r.findings.find((x) => x.file === 'src/api/index.ts')!;
    assert.equal(api.targetRole, 'backend');
    assert.equal(api.line, 2);
    assert.equal(api.col, 10);
    assert.ok(api.message.includes('TS2305'));

    const web = r.findings.find((x) => x.file === 'src/web/app.tsx')!;
    assert.equal(web.targetRole, 'frontend');

    assert.deepEqual(r.meta?.attribution, { backend: 1, frontend: 1 });
  } finally {
    await f.cleanup();
  }
});

test('A4：工具链缺失 → SKIPPED，绝不伪造 PASS', async () => {
  const f = await makeFixture();
  try {
    f.profile = baseProfile({ typecheck: { cmd: 'tsc-does-not-exist', args: ['--noEmit'] } });
    const r = await runOne(f, 'A4');
    assert.equal(r.verdict, 'SKIPPED');
    assert.equal(r.findings[0].code, 'toolchain-missing');
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// A5 · 测试执行
// ════════════════════════════════════════════════════════════════

test('A5：失败计数被解析，退出码非零 → FAIL', async () => {
  const f = await makeFixture();
  try {
    f.profile = baseProfile({
      test: {
        cmd: process.execPath,
        args: ['-e', "console.log('# pass 3\\n# fail 2'); process.exit(1);"],
      },
    });
    const r = await runOne(f, 'A5');
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.meta?.passed, 3);
    assert.equal(r.meta?.failed, 2);
    assert.equal(r.findings[0].targetRole, 'test');
  } finally {
    await f.cleanup();
  }
});

test('A5：声明了测试套件却 0 项通过 → 判 FAIL（假装测过）', async () => {
  const f = await makeFixture();
  try {
    f.profile = baseProfile({
      test: { cmd: process.execPath, args: ['-e', "console.log('# pass 0\\n# fail 0');"] },
    });
    await f.store.put({
      kind: 'TestSuite',
      producer: 'test',
      content: {
        framework: 'node:test',
        files: [{ path: 'tests/a.test.ts', content: '// empty' }],
        covers: ['R-001'],
      },
    });
    const r = await runOne(f, 'A5');
    assert.equal(r.verdict, 'FAIL');
    assert.ok(r.findings.some((x) => x.code === 'no-tests-ran'));
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// A6 · 运行时行为（真实启动服务 + HTTP 探针）
// ════════════════════════════════════════════════════════════════

test('A6：真实启动 HTTP 服务并探针成功 → PASS', async () => {
  const f = await makeFixture();
  const port = 39000 + Math.floor(Math.random() * 2000);
  try {
    f.profile = baseProfile({
      run: {
        cmd: process.execPath,
        args: [
          '-e',
          `require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(${port})`,
        ],
        healthUrl: `http://127.0.0.1:${port}/health`,
      },
    });
    const r = await runOne(f, 'A6');
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.findings));
    assert.equal(r.meta?.httpStatus, 200);
    assert.equal(r.authority, 'authoritative');
  } finally {
    await f.cleanup();
  }
});

test('A6：服务起不来 → FAIL，并携带 stdout/stderr 取证', async () => {
  const f = await makeFixture();
  const port = 39000 + Math.floor(Math.random() * 2000);
  try {
    f.profile = baseProfile({
      run: {
        cmd: process.execPath,
        args: ['-e', "console.error('boom: missing env DB_URL'); process.exit(2);"],
        healthUrl: `http://127.0.0.1:${port}/health`,
      },
    });
    const r = await runOne(f, 'A6');
    assert.equal(r.verdict, 'FAIL');
    assert.ok(r.findings[0].message.includes('就绪前退出'));
    assert.ok(String(r.meta?.stderrTail).includes('missing env DB_URL'));
  } finally {
    await f.cleanup();
  }
});

test('A6：未配置 run → SKIPPED', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A6');
    assert.equal(r.verdict, 'SKIPPED');
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// A7 · 契约一致性
// ════════════════════════════════════════════════════════════════

test('A7：无契约 → SKIPPED', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'A7');
    assert.equal(r.verdict, 'SKIPPED');
  } finally {
    await f.cleanup();
  }
});

test('A7：未冻结契约 + 缺生成类型 + 端点未实现 + 前端契约漂移', async () => {
  const f = await makeFixture();
  try {
    // 未冻结的契约
    await f.store.put({
      kind: 'Contract',
      producer: 'pm',
      content: {
        version: 1,
        openapi: { openapi: '3.1.0', paths: { '/api/tasks': {}, '/api/tasks/{id}': {} } },
        jsonSchemas: { Task: { type: 'object' } },
        generatedTypesPath: 'shared/contract/types.ts',
        changeRequests: [],
      },
    });
    // 后端只实现了其中一个端点
    await f.store.put({
      kind: 'CodeModule',
      producer: 'backend',
      scope: 'api',
      content: {
        files: [
          {
            path: 'src/api/routes.ts',
            content: "app.get('/api/tasks', handler);\ninterface Task { id: string }\n",
          },
        ],
      },
    });
    // 前端调用了一个契约里没有的端点
    await f.store.put({
      kind: 'CodeModule',
      producer: 'frontend',
      scope: 'web',
      content: {
        files: [{ path: 'src/web/api.ts', content: "fetch('/api/secrets');\ninterface Task { id: string }\n" }],
      },
    });

    const r = await runOne(f, 'A7');
    assert.equal(r.verdict, 'FAIL');

    const codes = r.findings.map((x) => x.code);
    assert.ok(codes.includes('contract-not-frozen'));
    assert.ok(codes.includes('missing-generated-types'));
    assert.ok(codes.includes('unimplemented-endpoint'));
    assert.ok(codes.includes('undeclared-endpoint'));
    assert.equal(codes.filter((c) => c === 'contract-duplication').length, 2, '前后端各手写了一份 Task');

    const dup = r.findings.filter((x) => x.code === 'contract-duplication');
    assert.deepEqual(
      dup.map((d) => d.targetRole).sort(),
      ['backend', 'frontend'],
    );
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// B 层 · 语义锚的证据核验（防「顺着幻觉自我确认」）
// ════════════════════════════════════════════════════════════════

async function seedRequirements(f: Fixture, count = 2) {
  const reqs = Array.from({ length: count }, (_, i) => ({
    id: `R-00${i + 1}`,
    text: `用户能够完成第 ${i + 1} 项操作`,
    acceptance: ['HTTP 探针返回 200'],
    priority: 'must' as const,
    status: 'open' as const,
    origin: 'user' as const,
  }));
  await f.store.put({ kind: 'Requirement', producer: 'pm', content: { requirements: reqs } });
  return reqs;
}

test('B1：证据指向不存在的文件 → 判定整条作废（INVALID_EVIDENCE）', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 1);
    const proposals: SemanticProposals = {
      requirementVerdicts: [
        {
          requirementId: 'R-001',
          verdict: 'met',
          rationale: '我写了实现',
          evidenceRefs: [{ kind: 'file', path: 'src/api/nonexistent.ts', startLine: 1, endLine: 3 }],
        },
      ],
    };
    const r = await runOne(f, 'B1', proposals);
    assert.equal(r.verdict, 'INVALID_EVIDENCE');
    assert.equal(r.findings[0].code, 'evidence-invalid');
    assert.ok(r.findings[0].message.includes('文件不存在'));
  } finally {
    await f.cleanup();
  }
});

test('B1：行号越界 → 判定作废（编造证据无法得分）', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 1);
    const proposals: SemanticProposals = {
      requirementVerdicts: [
        {
          requirementId: 'R-001',
          verdict: 'met',
          rationale: '在第 999 行实现了',
          evidenceRefs: [{ kind: 'file', path: 'src/api/index.ts', startLine: 999, endLine: 1000 }],
        },
      ],
    };
    const r = await runOne(f, 'B1', proposals);
    assert.equal(r.verdict, 'INVALID_EVIDENCE');
    assert.ok(r.findings[0].message.includes('越界'));
  } finally {
    await f.cleanup();
  }
});

test('B1：引用的行区间不含所声称内容 → 判定作废', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 1);
    const proposals: SemanticProposals = {
      requirementVerdicts: [
        {
          requirementId: 'R-001',
          verdict: 'met',
          rationale: '这里实现了 handler',
          evidenceRefs: [
            { kind: 'file', path: 'src/api/index.ts', startLine: 1, endLine: 1, expect: 'app.post' },
          ],
        },
      ],
    };
    const r = await runOne(f, 'B1', proposals);
    assert.equal(r.verdict, 'INVALID_EVIDENCE');
    assert.ok(r.findings[0].message.includes('未包含所声称的内容'));
  } finally {
    await f.cleanup();
  }
});

test('B1：证据真实且判定为达成 → PASS', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 1);
    const proposals: SemanticProposals = {
      requirementVerdicts: [
        {
          requirementId: 'R-001',
          verdict: 'met',
          rationale: 'padLeft 已在第 1 行导入并使用',
          evidenceRefs: [
            { kind: 'file', path: 'src/api/index.ts', startLine: 1, endLine: 1, expect: 'padLeft' },
          ],
        },
      ],
    };
    const r = await runOne(f, 'B1', proposals);
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.findings));
  } finally {
    await f.cleanup();
  }
});

test('B1：需求没有判定 → FAIL（未验证 ≠ 通过）', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 2);
    const proposals: SemanticProposals = {
      requirementVerdicts: [
        {
          requirementId: 'R-001',
          verdict: 'met',
          rationale: 'ok',
          evidenceRefs: [{ kind: 'file', path: 'src/api/index.ts', startLine: 1, endLine: 1 }],
        },
      ],
    };
    const r = await runOne(f, 'B1', proposals);
    assert.equal(r.verdict, 'FAIL');
    assert.ok(r.findings.some((x) => x.code === 'requirement-unverified' && x.message.includes('R-002')));
  } finally {
    await f.cleanup();
  }
});

test('B1：无提议 → SKIPPED，不得算通过', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 1);
    const r = await runOne(f, 'B1');
    assert.equal(r.verdict, 'SKIPPED');
  } finally {
    await f.cleanup();
  }
});

test('B2：需求覆盖矩阵抓出漏掉的需求与缺失的交付物', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 3);
    await f.store.put({
      kind: 'PRD',
      producer: 'pm',
      content: {
        title: 'PRD',
        summary: '这是一个足够长的产品需求文档摘要',
        requirementIds: ['R-001', 'R-002'], // 漏了 R-003
        milestones: [],
        nonGoals: [],
      },
    });
    await f.store.put({
      kind: 'TaskGraph',
      producer: 'pm',
      content: {
        tasks: [
          {
            id: 'T-01',
            title: '实现 R-001 的前端',
            owner: 'frontend',
            scope: 'web',
            dependsOn: [],
            requirementIds: ['R-001'],
            deliverable: 'CodeModule',
            acceptance: ['A4 锚点 PASS'],
          },
        ],
      },
    });
    // 需要一个代码工件，B2 才会检查「测试覆盖」与「产物交付」——
    // 在实现尚未开始时这两项必然为真，判 FAIL 会变成误伤（见 B2 内 implementationStarted 的说明）。
    // 这里只给 api 工件，因此 T-01 声明要交付的 web 工件仍然缺失。
    await f.store.put({
      kind: 'CodeModule',
      producer: 'backend',
      scope: 'api',
      content: { files: [{ path: 'src/api/index.ts', content: 'export const a = 1;\n' }] },
    });

    const r = await runOne(f, 'B2');
    assert.equal(r.verdict, 'FAIL');
    const codes = r.findings.map((x) => x.code);
    assert.ok(codes.includes('requirement-not-in-prd'), 'R-003 丢失应被发现');
    assert.ok(codes.includes('requirement-untasked'), 'R-002 无任务应被发现');
    assert.ok(codes.includes('requirement-untested'));
    assert.ok(codes.includes('deliverable-missing'), 'T-01 声称交付 web 工件，但库中只有 api 工件');

    const matrix = r.meta?.matrix as Array<Record<string, unknown>>;
    assert.equal(matrix.length, 3);
    assert.equal(matrix[0].requirementId, 'R-001');
    assert.equal(matrix[2].requirementId, 'R-003');
  } finally {
    await f.cleanup();
  }
});

test('B2：实现尚未开始时不得把「还没做」判成缺陷（未开始 ≠ 已失败）', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 2);
    await f.store.put({
      kind: 'PRD',
      producer: 'pm',
      content: {
        title: 'PRD',
        summary: '这是一个足够长的产品需求文档摘要',
        requirementIds: ['R-001', 'R-002'],
        milestones: [],
        nonGoals: [],
      },
    });
    await f.store.put({
      kind: 'TaskGraph',
      producer: 'pm',
      content: {
        tasks: [
          {
            id: 'T-01',
            title: '实现两条需求',
            owner: 'backend',
            scope: 'api',
            dependsOn: [],
            requirementIds: ['R-001', 'R-002'],
            deliverable: 'CodeModule',
            acceptance: ['A4 锚点 PASS'],
          },
        ],
      },
    });
    // 没有任何 CodeModule —— 这正是 PLANNING 阶段的真实状态
    const r = await runOne(f, 'B2');
    assert.equal(r.verdict, 'WARN', '不得因「还没写代码」判 FAIL');
    const codes = r.findings.map((x) => x.code);
    assert.ok(codes.includes('implementation-not-started'));
    assert.ok(!codes.includes('requirement-untested'), '实现未开始不该报「需求未被测试覆盖」');
    assert.ok(!codes.includes('deliverable-missing'), '实现未开始不该报「产物缺失」');
  } finally {
    await f.cleanup();
  }
});

test('B2：不可验收的 PM 需求在 schema 门禁处就被拒绝（比 B2 检查更早的一道闸）', async () => {
  const f = await makeFixture();
  try {
    // 第一道闸：工件 schema 强制 acceptance 至少一条。PM 产不出「无法验收的需求」。
    await assert.rejects(
      () =>
        f.store.put({
          kind: 'Requirement',
          producer: 'pm',
          content: {
            requirements: [
              { id: 'R-001', text: '系统要好用', acceptance: [], priority: 'must', status: 'open', origin: 'user' },
            ],
          },
        }),
      /SCHEMA_REJECT/,
    );

    // 第二道闸（纵深防御）：即便有工件绕过 schema（例如未来放宽约束），B2 仍会独立指出。
    const reqArt = f.store.get('Requirement-001');
    assert.equal(reqArt, null, '被拒的工件不得入库');
  } finally {
    await f.cleanup();
  }
});

test('B2：requirement-unverifiable 是纵深防御（直接构造内容时生效）', async () => {
  const f = await makeFixture();
  try {
    await seedRequirements(f, 1);
    // 模拟「绕过 store schema」的历史数据 / 人工注入
    const art = f.store.require('Requirement-001');
    (art.content as { requirements: Array<{ acceptance: string[] }> }).requirements[0].acceptance = [];

    const r = await runOne(f, 'B2');
    assert.equal(r.verdict, 'FAIL');
    assert.ok(r.findings.some((x) => x.code === 'requirement-unverifiable' && x.targetRole === 'pm'));
  } finally {
    await f.cleanup();
  }
});

test('B3：异议引用不存在的证据 → INVALID_EVIDENCE（主理人自己也在锚点约束之下）', async () => {
  const f = await makeFixture();
  try {
    await f.store.put({
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
            claim: '后端接口缺少错误处理，违反契约',
            evidence: [{ kind: 'file', path: 'src/api/fake.ts', startLine: 1, endLine: 2 }],
            falsifier: { kind: 'question', text: '谁来确认？' },
            claimHash: 'aaaaaaaa',
            evidenceHash: 'bbbbbbbb',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });

    const r = await runOne(f, 'B3', {
      objections: [
        {
          id: 'O-1',
          evidence: [{ kind: 'file', path: 'src/api/fake.ts', startLine: 1, endLine: 2 }],
        },
      ],
    });
    assert.equal(r.verdict, 'INVALID_EVIDENCE');
    assert.equal(r.findings[0].code, 'objection-evidence-invalid');
  } finally {
    await f.cleanup();
  }
});

test('B3：异议证据真实 → PASS', async () => {
  const f = await makeFixture();
  try {
    const r = await runOne(f, 'B3', {
      objections: [
        {
          id: 'O-2',
          evidence: [{ kind: 'file', path: 'src/api/index.ts', startLine: 1, endLine: 2 }],
        },
      ],
    });
    assert.equal(r.verdict, 'PASS');
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 运行器整体
// ════════════════════════════════════════════════════════════════

test('runAnchors：结果绑定内容 hash 并写入工件锚点链', async () => {
  const f = await makeFixture();
  try {
    await f.store.put({
      kind: 'CodeModule',
      producer: 'backend',
      scope: 'api',
      content: { files: [{ path: 'src/api/index.ts', content: 'export const a = 1;\n' }] },
    });
    const ctx = ctxFor(f);
    const results = await runAnchors(ctx, ALL_ANCHORS);

    assert.equal(results.length, ALL_ANCHORS.length);
    // runId 唯一
    assert.equal(new Set(results.map((r) => r.runId)).size, results.length);

    const cm = f.store.head('CodeModule')!;
    assert.ok(cm.anchorChain.length > 0, '锚点结论必须写入工件锚点链');
    for (const link of cm.anchorChain) {
      assert.equal(link.contentHashes[cm.id], cm.contentHash, '锚点必须绑定当时的内容 hash');
    }
  } finally {
    await f.cleanup();
  }
});

test('runAnchors：机械归因汇总可用于直接派工单（不打扰主理人）', async () => {
  const f = await makeFixture();
  try {
    f.profile = baseProfile({
      typecheck: {
        cmd: process.execPath,
        args: [
          '-e',
          [
            "console.log('src/api/a.ts(1,1): error TS1: x');",
            "console.log('src/api/b.ts(1,1): error TS1: y');",
            "console.log('src/web/c.ts(1,1): error TS1: z');",
            'process.exit(1);',
          ].join(''),
        ],
      },
    });
    const ctx = ctxFor(f);
    const results = await runAnchors(ctx, [ANCHOR_INDEX.get('A4')!]);
    assert.deepEqual(attributionOf(results), { backend: 2, frontend: 1 });
  } finally {
    await f.cleanup();
  }
});

test('A6：服务进程**起不来**时必须转成一次报告，绝不能让整个进程崩溃', async () => {
  // 真实 LLM run 里踩到的严重缺陷（docs/07 §L6）：
  // A6 用 `spawn('npm', ['start'])` 启动服务，Windows 上直接 ENOENT。
  // 而 spawn 失败是**异步的 'error' 事件**，不是同步抛出 ——
  // 所以 Gate 那层「锚点抛异常不得让整个 Gate 崩溃」的 try/catch 抓不到它，
  // 结果是整个 node 进程被未处理的 error 打死：
  // 一次「服务起不来」被升级成了「AgentForge 崩了」。
  //
  // **锚点绝不可以有能力杀死整个 run。**
  // 这条测试的「通过」本身就证明了修复有效 —— 修复前它会直接崩掉测试进程。
  const f = await makeFixture();
  try {
    const ctx = ctxFor(f);
    ctx.profile = baseProfile({
      run: {
        // 一个必然不存在的可执行文件：模拟「服务根本起不来」
        cmd: 'agentforge-definitely-not-a-real-binary-xyz',
        args: ['start'],
        healthUrl: 'http://127.0.0.1:9/health',
      },
    });
    const [r] = await runAnchors(ctx, [A6]);

    assert.ok(r, 'A6 必须返回一个结果，而不是让进程消失');
    assert.notEqual(r.verdict, 'PASS', '服务起不来绝不能报 PASS');
    assert.ok(
      r.findings.some((x) => x.message.includes('无法启动') || x.message.includes('未响应')),
      `应说明服务没能启动：${JSON.stringify(r.findings)}`,
    );
  } finally {
    await f.cleanup();
  }
});

test('A6：Windows 上必须把 npm 解析成 npm.cmd（否则运行时探针永远跑不起来）', async () => {
  // 同一个缺陷的另一半：`spawn('npm')` 在 Windows 上 ENOENT，
  // 而 `spawn('npm.cmd')` 又因 CVE-2024-27980 同步抛 EINVAL。
  // §H1 已经为 execCapture 修过这件事，A6 当时漏了 —— 于是
  // 「A4/A5 能跑，唯独 A6 一跑就把进程打死」，这个组合最难归因。
  const resolved = resolveExecutable('npm');
  if (process.platform === 'win32') {
    assert.ok(/\.(cmd|exe|bat|com)$/i.test(resolved.path), `Windows 上应解析出带扩展名的真实路径，得到 ${resolved.path}`);
    assert.equal(resolved.needsShell, resolved.path.toLowerCase().endsWith('.cmd') || resolved.path.toLowerCase().endsWith('.bat'));
  } else {
    assert.equal(resolved.path, 'npm', '非 Windows 平台保持原样');
    assert.equal(resolved.needsShell, false);
  }
});

test('归因【关键】：必须按工件事实归因，而不是目录命名约定（否则打回不了）', async () => {
  // 真实 LLM 实测发现的缺陷（docs/07 §L10）。这一条回答的是
  // 「系统为什么老是开圆桌、而不是直接打回让角色返工」：
  //
  // 打回需要**责任人**。而原来的归因只有一张写死的目录前缀表
  // （`src/api/` → backend、`src/server/` → backend …）。
  // 模型把服务端写在 `src/server.ts` —— 表里是 `src/server/`（带斜杠，指目录），
  // 于是**一条都不匹配**、归因变成 UNRESOLVED ⇒ 派不出工单 ⇒ 没法打回 ⇒ 只能开圆桌。
  //
  // 更糟的是那张表还会给出**错误答案**：模型把前端数据层放在 `src/api/tasks.ts`，
  // 按表 `src/api/` → backend，而那其实是 frontend 的工件。
  //
  // 而归属关系本来就是确定性事实：CodeModule 工件记录了 producer 与它包含的文件。
  const f = await makeFixture();
  try {
    const ctx = ctxFor(f);

    // 场景 A：旧表**认不出**的布局（顶层 src/server.ts，不属于任何已知目录前缀）
    await f.store.put({
      kind: 'CodeModule',
      producer: 'backend',
      content: { files: [{ path: 'src/server.ts', content: '' }, { path: 'src/index.ts', content: '' }] },
    } as never);
    assert.equal(
      attributeByArtifact(ctx, 'src/server.ts'),
      'backend',
      'src/server.ts 是 backend 的工件 ⇒ 必须归给 backend（旧表会给出 UNRESOLVED）',
    );
    assert.equal(attributeByPath('src/server.ts'), 'UNRESOLVED', '（对照：仅按命名约定确实认不出来）');

    // 场景 B：旧表**归错人**的布局（frontend 的工件落在 src/api/ 下）
    await f.store.put({
      kind: 'CodeModule',
      producer: 'frontend',
      content: { files: [{ path: 'src/api/tasks.ts', content: '' }] },
    } as never);
    assert.equal(
      attributeByArtifact(ctx, 'src/api/tasks.ts'),
      'frontend',
      '该文件属于 frontend 的工件 ⇒ 必须归给 frontend（旧表会错归 backend）',
    );
    assert.equal(attributeByPath('src/api/tasks.ts'), 'backend', '（对照：仅按命名约定会归错人）');

    // 场景 C：测试文件按工件归给 test
    await f.store.put({
      kind: 'TestSuite',
      producer: 'test',
      content: { framework: 'node:test', files: [{ path: 'tests/api.test.ts', content: '' }], covers: [] },
    } as never);
    assert.equal(attributeByArtifact(ctx, 'tests/api.test.ts'), 'test');

    // 场景 D：完全没有任何工件声明过的文件 → 回落到命名约定（不能凭空归因）
    assert.equal(attributeByArtifact(ctx, 'src/web/unknown.ts'), 'frontend', '未声明时回落到目录约定');
    assert.equal(attributeByArtifact(ctx, 'totally/unknown.ts'), 'UNRESOLVED', '无从判断就必须如实说不知道');
  } finally {
    await f.cleanup();
  }
});

test('锚点抛异常不得让整个 Gate 崩溃，而是转成 FAIL 并记录', async () => {
  const f = await makeFixture();
  try {
    const boom = {
      id: 'A1' as const,
      title: '会爆炸的锚点',
      layer: 'A' as const,
      async run() {
        throw new Error('内部错误');
      },
    };
    const ctx = ctxFor(f);
    const [r] = await runAnchors(ctx, [boom]);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.findings[0].code, 'anchor-crashed');
    assert.ok(r.error?.includes('内部错误'));
  } finally {
    await f.cleanup();
  }
});
