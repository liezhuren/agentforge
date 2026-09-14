/**
 * 项目契约（验证基准）的单元测试。
 *
 * 这一层的存在理由见 `src/projectcontract.ts` 的模块注释；
 * 一句话：**被验证者不得修改验证基准**。
 *
 * 这里刻意把「产出的内容」直接喂给纯函数，而不是跑一次编排器 ——
 * 契约保护是确定性的，不该需要一次真实 LLM 运行才能验证
 * （对照 docs/HANDOFF.md §6.7：最严重的一个缺陷 12 轮真实运行一次都没碰到，
 *  因为每轮都开新工作区，反而是读代码读出来的）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  ENGINE_PROTECTED_FILES,
  enforceProjectContract,
  normalizeRelPath,
  readProjectContract,
} from '../src/projectcontract.ts';
import { GeneratedTypesPathError, writeContractTypes } from '../src/contractcodegen.ts';
import type { ContractDoc } from '../src/types.ts';

async function makeRoot(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'af-contract-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}

const PKG = JSON.stringify(
  {
    name: 'task-board',
    version: '1.0.0',
    scripts: { typecheck: 'tsc --noEmit', test: 'node run-tests.mjs', start: 'node src/server.ts' },
    agentforge: { healthUrl: 'http://127.0.0.1:8787/health' },
  },
  null,
  2,
);

// ════════════════════════════════════════════════════════════════
// 快照
// ════════════════════════════════════════════════════════════════

test('契约快照：package.json 的顶层键全部被固化为基准', async () => {
  const root = await makeRoot({ 'package.json': PKG });
  try {
    const { contract } = await readProjectContract(root);
    assert.equal(contract.pkgExists, true);
    assert.deepEqual(Object.keys(contract.pkgKeys).sort(), [
      'agentforge',
      'name',
      'scripts',
      'version',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约快照：空白工作区如实报「没有基准」，而不是假装有保护', async () => {
  const root = await makeRoot({});
  try {
    const { contract, notes } = await readProjectContract(root);
    assert.equal(contract.pkgExists, false);
    assert.deepEqual(contract.pkgKeys, {});
    assert.deepEqual(contract.protectedFiles, {});
    // 一个静默生效的保护机制和一个静默失效的保护机制一样危险 —— 必须可解释
    assert.ok(
      notes.some((n) => n.includes('契约基准为空')),
      `说明里必须点明「本次没有基准」，实际：${JSON.stringify(notes)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约快照：tsconfig.json 存在即受保护；不存在则不保护（允许产出创建）', async () => {
  const withTs = await makeRoot({ 'package.json': PKG, 'tsconfig.json': '{"compilerOptions":{}}' });
  const withoutTs = await makeRoot({ 'package.json': PKG });
  try {
    const a = await readProjectContract(withTs);
    assert.ok(ENGINE_PROTECTED_FILES.includes('tsconfig.json'));
    assert.ok(a.contract.protectedFiles['tsconfig.json'], 'tsconfig 存在时应被保护');

    const b = await readProjectContract(withoutTs);
    assert.equal(b.contract.protectedFiles['tsconfig.json'], undefined, '不存在时不应凭空保护');
  } finally {
    await rm(withTs, { recursive: true, force: true });
    await rm(withoutTs, { recursive: true, force: true });
  }
});

test('契约快照：项目自己声明的 protectedFiles 也被保护（引擎不硬编码项目特有的文件）', async () => {
  const root = await makeRoot({
    'package.json': JSON.stringify({
      name: 'x',
      agentforge: { protectedFiles: ['run-tests.mjs', 'vitest.config.ts'] },
    }),
    'run-tests.mjs': 'console.log(1)',
  });
  try {
    const { contract } = await readProjectContract(root);
    assert.ok(contract.protectedFiles['run-tests.mjs'], '声明的文件存在时应被保护');
    assert.equal(contract.protectedFiles['vitest.config.ts'], undefined, '声明了但不存在 → 允许创建');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 强制执行：package.json 的已声明键
// ════════════════════════════════════════════════════════════════

test('契约：产出删掉已声明的键 → 违规，且落盘内容保留项目原值', async () => {
  const root = await makeRoot({ 'package.json': PKG });
  try {
    const { contract } = await readProjectContract(root);
    // 真实数据：llm-12 的 CodeModule-T-02-api 交出的就是这种东西
    const evil = JSON.stringify({
      name: 'task-board',
      version: '0.1.0',
      type: 'module',
      scripts: { typecheck: 'tsc --noEmit', test: 'node --test', start: 'node src/server.ts' },
    });

    const res = enforceProjectContract({
      contract,
      files: [{ path: 'package.json', content: evil }],
      producer: 'backend',
      artifactKind: 'CodeModule',
    });

    const removed = res.violations.filter((v) => v.code === 'contract-key-removed');
    assert.deepEqual(removed.map((v) => v.key), ['agentforge'], '删掉 agentforge 必须被报出来');
    assert.equal(removed[0]?.targetRole, 'backend', '归因必须落到产出它的角色，工单才能派出去');

    const written = JSON.parse(res.files[0]!.content) as Record<string, unknown>;
    assert.ok(written['agentforge'], '项目的 agentforge 声明必须被保留');
    assert.deepEqual(written['scripts'], (JSON.parse(PKG) as Record<string, unknown>)['scripts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约：产出改写已声明的键 → 违规，键路径精确到子键', async () => {
  const root = await makeRoot({ 'package.json': PKG });
  try {
    const { contract } = await readProjectContract(root);
    const evil = JSON.stringify({
      name: 'task-board',
      version: '1.0.0',
      scripts: { typecheck: 'tsc --noEmit', test: 'node --experimental-strip-types --test', start: 'node src/server.ts' },
      agentforge: { healthUrl: 'http://127.0.0.1:8787/health' },
    });

    const res = enforceProjectContract({
      contract,
      files: [{ path: 'package.json', content: evil }],
      producer: 'backend',
      artifactKind: 'CodeModule',
    });

    const changed = res.violations.filter((v) => v.code === 'contract-key-changed');
    assert.equal(changed.length, 1, JSON.stringify(res.violations, null, 2));
    assert.equal(changed[0]?.key, 'scripts.test', '必须点名到具体是哪个子键被换了');
    // 换掉测试命令 = 换掉测量工具本身，这是本次要防的核心向量
    const written = JSON.parse(res.files[0]!.content) as { scripts: Record<string, string> };
    assert.equal(written.scripts['test'], 'node run-tests.mjs', '测试命令必须保持项目原值');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约：产出新增未声明的键 → 允许（不是所有改动都要拦）', async () => {
  const root = await makeRoot({ 'package.json': PKG });
  try {
    const { contract } = await readProjectContract(root);
    const attempted = JSON.stringify({
      ...(JSON.parse(PKG) as Record<string, unknown>),
      description: '任务看板',
      type: 'module',
    });

    const res = enforceProjectContract({
      contract,
      files: [{ path: 'package.json', content: attempted }],
      producer: 'backend',
      artifactKind: 'CodeModule',
    });

    assert.deepEqual(res.violations, [], '新增键不构成违规');
    const written = JSON.parse(res.files[0]!.content) as Record<string, unknown>;
    assert.equal(written['description'], '任务看板');
    assert.equal(written['type'], 'module');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约：产出写出非法 JSON 的 package.json → 违规且不落盘（不能让 A4/A5 一起变 SKIPPED）', async () => {
  const root = await makeRoot({ 'package.json': PKG });
  try {
    const { contract } = await readProjectContract(root);
    const res = enforceProjectContract({
      contract,
      files: [{ path: 'package.json', content: '{ 这不是 JSON' }],
      producer: 'backend',
      artifactKind: 'CodeModule',
    });
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0]?.code, 'contract-file-invalid');
    assert.equal(res.files.length, 0, '不该把坏掉的 package.json 写下去');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 强制执行：受保护的验证配置文件
// ════════════════════════════════════════════════════════════════

test('契约：产出改写受保护的验证配置文件 → 该文件被丢弃并报违规', async () => {
  const root = await makeRoot({ 'package.json': PKG, 'tsconfig.json': '{"compilerOptions":{"strict":true}}' });
  try {
    const { contract } = await readProjectContract(root);
    // 真实数据：llm-12 的 tsconfig 把测试目录排除出了类型检查
    const evil = JSON.stringify({
      compilerOptions: { strict: true },
      include: ['src'],
      exclude: ['node_modules', 'test', '**/*.test.ts'],
    });

    const res = enforceProjectContract({
      contract,
      files: [
        { path: 'tsconfig.json', content: evil },
        { path: 'src/api/routes.ts', content: 'export const x = 1;\n' },
      ],
      producer: 'backend',
      artifactKind: 'CodeModule',
    });

    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0]?.code, 'contract-file-overwritten');
    assert.equal(res.violations[0]?.path, 'tsconfig.json');
    assert.deepEqual(
      res.files.map((f) => f.path),
      ['src/api/routes.ts'],
      '受保护文件必须从产出里剔除，正常源码不受影响',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约：受保护文件内容没变（等价重写）→ 不算违规', async () => {
  const ts = '{"compilerOptions":{"strict":true}}';
  const root = await makeRoot({ 'package.json': PKG, 'tsconfig.json': ts });
  try {
    const { contract } = await readProjectContract(root);
    const res = enforceProjectContract({
      contract,
      files: [{ path: 'tsconfig.json', content: ts }],
      producer: 'backend',
      artifactKind: 'CodeModule',
    });
    assert.deepEqual(res.violations, [], '原样带出来不该被当成篡改');
    assert.equal(res.files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 空白工作区：允许创建，创建后即收编
// ════════════════════════════════════════════════════════════════

test('契约：空白工作区允许产出创建 package.json，创建后即收编（第二个角色就改不动了）', async () => {
  const root = await makeRoot({});
  try {
    const first = await readProjectContract(root);
    const created = JSON.stringify({ name: 'p', scripts: { test: 'node run-tests.mjs' } });

    const r1 = enforceProjectContract({
      contract: first.contract,
      files: [{ path: 'package.json', content: created }],
      producer: 'backend',
      artifactKind: 'CodeModule',
    });
    assert.deepEqual(r1.violations, [], '从零开始的项目必须能创建 package.json');
    assert.equal(r1.contract.pkgExists, true, '创建后应当被收编为契约');

    // 第二个角色（或同一个角色的返工）改它 → 违规
    const r2 = enforceProjectContract({
      contract: r1.contract,
      files: [{ path: 'package.json', content: JSON.stringify({ name: 'p', scripts: { test: 'exit 0' } }) }],
      producer: 'frontend',
      artifactKind: 'CodeModule',
    });
    assert.equal(r2.violations.length, 1);
    assert.equal(r2.violations[0]?.code, 'contract-key-changed');
    assert.equal(r2.violations[0]?.targetRole, 'frontend');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 路径越界
// ════════════════════════════════════════════════════════════════

test('契约：产出试图写到项目根之外 → 拒绝落盘并报违规', async () => {
  const root = await makeRoot({ 'package.json': PKG });
  try {
    const { contract } = await readProjectContract(root);
    const res = enforceProjectContract({
      contract,
      files: [
        { path: '../escaped.ts', content: 'x' },
        { path: 'src/../../escaped2.ts', content: 'x' },
        { path: 'C:/Windows/System32/evil.ts', content: 'x' },
        { path: 'src/ok.ts', content: 'export const ok = 1;\n' },
      ],
      producer: 'backend',
      artifactKind: 'CodeModule',
    });

    assert.equal(res.violations.filter((v) => v.code === 'path-escapes-project').length, 3);
    assert.deepEqual(res.files.map((f) => f.path), ['src/ok.ts'], '只有工作区内的路径允许落盘');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('路径归一化：./ 前缀与反斜杠被统一，但 .. 不得逃出根', () => {
  assert.equal(normalizeRelPath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRelPath('src\\a.ts'), 'src/a.ts');
  assert.equal(normalizeRelPath('src/../lib/a.ts'), 'lib/a.ts');
  assert.equal(normalizeRelPath('../a.ts'), null);
  assert.equal(normalizeRelPath('a/../../b.ts'), null);
  assert.equal(normalizeRelPath('/etc/passwd'), null);
  assert.equal(normalizeRelPath(''), null);
});

// ════════════════════════════════════════════════════════════════
// 同一个信任边界的第二个入口：契约代码生成器
// ════════════════════════════════════════════════════════════════
//
// `generatedTypesPath` 是 **PM 的 Contract 工件自己声明的** —— 也就是
// 「产出的内容决定写盘位置」。它和 materializeFiles 属于同一类风险，
// 所以必须有同样的守卫。
//
// 这几个用例放在同一个文件里是刻意的：它们是**同一件事的两个入口**，
// 分开写迟早会漏掉一个（docs/07 §L13 的教训：当年漏掉缓存命中那条 early return，
// 让「反复跑同一个项目」这个最常规的用法第二次起每次调用都 400）。

function contractDoc(generatedTypesPath: string): ContractDoc {
  return {
    version: 1,
    openapi: { openapi: '3.1.0', paths: { '/api/tasks': {} } },
    jsonSchemas: { Task: { type: 'object', properties: { id: { type: 'string' } } } },
    generatedTypesPath,
    changeRequests: [],
  };
}

test('契约代码生成：正常路径可以写，并且真的落盘', async () => {
  const root = await makeRoot({});
  try {
    const gen = await writeContractTypes(root, contractDoc('shared/contract/types.ts'));
    assert.equal(gen.path, 'shared/contract/types.ts');
    assert.ok(gen.bytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约代码生成：路径越出项目根 → 抛错，不写任何文件', async () => {
  const root = await makeRoot({});
  try {
    await assert.rejects(
      () => writeContractTypes(root, contractDoc('../outside.ts')),
      (e: unknown) => e instanceof GeneratedTypesPathError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('契约代码生成：路径指向受保护的验证基准 → 抛错（PM 不能靠改路径覆盖 package.json）', async () => {
  const root = await makeRoot({ 'package.json': PKG });
  try {
    // 关键：即使路径合法（就在项目根下），也不能是验证基准文件 ——
    // 否则引擎会拿生成的 TypeScript 覆盖掉项目契约。
    await assert.rejects(
      () =>
        writeContractTypes(root, contractDoc('package.json'), {
          forbiddenPaths: ['package.json', 'tsconfig.json'],
        }),
      (e: unknown) => e instanceof GeneratedTypesPathError && e.relPath === 'package.json',
    );

    const after = await readProjectContract(root);
    assert.ok(after.contract.pkgExists, 'package.json 必须原封不动');
    assert.ok(after.contract.pkgKeys['agentforge'], '键也必须还在');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
