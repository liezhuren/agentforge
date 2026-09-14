/**
 * A8「验证基准未被篡改」的行为测试。
 *
 * A8 是唯一一个**检查产出行为、而不是产出内容**的确定性锚点：
 * 它回答的是「被验证者有没有试图改动验证基准」。
 *
 * 存在理由见 `packages/core/src/projectcontract.ts`，实测数据见 docs/HANDOFF.md §8.1：
 * 第 12 轮真实运行里 backend 角色附了一份自己写的 package.json，
 * 把项目声明的 healthUrl 删掉 → A6 静默 SKIPPED，而 run 照常走到交付。
 *
 * 注意这里刻意**不**跑真实 LLM、也不跑整个编排器：
 * A8 的输入是契约状态，输出是 verdict，两者都是确定性的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { ArtifactStore, type ProjectProfile } from '../../core/src/index.ts';
import type { ContractState } from '../../core/src/projectcontract.ts';
import { A8, createAnchorContext, runAnchors } from '../src/index.ts';

function profile(): ProjectProfile {
  return {
    name: 'fixture',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: null,
    test: null,
    run: null,
    knownPackages: [],
    dependencyAllowlist: null,
  };
}

async function makeCtx(contract?: ContractState) {
  const root = await mkdtemp(join(tmpdir(), 'af-a8-'));
  const abs = join(root, 'src', 'api', 'routes.ts');
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, 'export const x = 1;\n', 'utf8');
  const store = new ArtifactStore(root);
  await store.init();
  const ctx = createAnchorContext({
    projectRoot: root,
    store,
    profile: profile(),
    offline: true,
    ...(contract ? { contract } : {}),
  });
  return { root, ctx, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const baseline: ContractState = {
  hasBaseline: true,
  declaredPkgKeys: ['name', 'scripts', 'agentforge'],
  protectedFiles: ['tsconfig.json'],
  violations: [],
};

test('A8：没有契约状态 → SKIPPED（拿不到基准就绝不假装检查过）', async () => {
  const { ctx, cleanup } = await makeCtx();
  try {
    const out = await A8.run(ctx);
    assert.equal(out.verdict, 'SKIPPED');
    assert.equal(out.findings[0]?.code, 'contract-not-tracked');
    assert.equal(out.authority, 'none');
  } finally {
    await cleanup();
  }
});

test('A8：本次运行确实没有基准 → 不适用（SKIPPED），而不是伪造 PASS', async () => {
  const empty: ContractState = {
    hasBaseline: false,
    declaredPkgKeys: [],
    protectedFiles: [],
    violations: [],
  };
  const { ctx, cleanup } = await makeCtx(empty);
  try {
    assert.equal(await A8.appliesTo!(ctx), false);
    // 走 runAnchors 时 appliesTo=false 会变成一条说明性的 SKIPPED
    const [res] = await runAnchors(ctx, [A8], { respectApplicability: true });
    assert.equal(res?.verdict, 'SKIPPED');
    assert.equal(res?.findings[0]?.code, 'not-applicable');
  } finally {
    await cleanup();
  }
});

test('A8：契约完好 → PASS，且报告保护范围（人类要能看见基准是什么）', async () => {
  const { ctx, cleanup } = await makeCtx(baseline);
  try {
    const out = await A8.run(ctx);
    assert.equal(out.verdict, 'PASS');
    assert.deepEqual(out.findings, []);
    assert.equal(out.authority, 'authoritative');
    assert.deepEqual(out.meta?.['declaredPkgKeys'], ['name', 'scripts', 'agentforge']);
    assert.deepEqual(out.meta?.['protectedFiles'], ['tsconfig.json']);
    assert.equal(out.meta?.['violations'], 0);
  } finally {
    await cleanup();
  }
});

test('A8：产出篡改过基准 → FAIL，且按 targetRole 机械归因（能直接派工单）', async () => {
  const tampered: ContractState = {
    ...baseline,
    violations: [
      {
        code: 'contract-key-removed',
        path: 'package.json',
        key: 'agentforge',
        declared: '{"healthUrl":"http://127.0.0.1:8787/health"}',
        targetRole: 'backend',
        artifactKind: 'CodeModule',
        message: '产出删掉了项目在 package.json 里声明的键 "agentforge"',
      },
      {
        code: 'contract-file-overwritten',
        path: 'tsconfig.json',
        targetRole: 'backend',
        artifactKind: 'CodeModule',
        message: '产出试图改写受保护的验证配置文件 tsconfig.json',
      },
    ],
  };
  const { ctx, cleanup } = await makeCtx(tampered);
  try {
    const out = await A8.run(ctx);
    assert.equal(out.verdict, 'FAIL', '一次没能生效的篡改尝试依旧是篡改尝试');
    assert.equal(out.findings.length, 2);
    assert.ok(out.findings.every((f) => f.severity === 'fail'), '不得降级为 warn —— 那会重演「静默通过」');
    assert.ok(
      out.findings.every((f) => f.targetRole === 'backend'),
      '归因必须落到产出它的角色，否则 Gate 生不出工单',
    );
    assert.equal(out.meta?.['violations'], 2);
  } finally {
    await cleanup();
  }
});

test('A8：只有违规、没有基准时仍然适用（违规本身就是要报的事实）', async () => {
  const state: ContractState = {
    hasBaseline: false,
    declaredPkgKeys: [],
    protectedFiles: [],
    violations: [
      {
        code: 'path-escapes-project',
        path: '../outside.ts',
        targetRole: 'frontend',
        artifactKind: 'CodeModule',
        message: '产出试图写到项目根之外',
      },
    ],
  };
  const { ctx, cleanup } = await makeCtx(state);
  try {
    assert.equal(await A8.appliesTo!(ctx), true);
    const out = await A8.run(ctx);
    assert.equal(out.verdict, 'FAIL');
  } finally {
    await cleanup();
  }
});

test('A8：锚点注册表里必须是 A 层（否则机械归因与「不唤醒主理人」都会失效）', async () => {
  const { ctx, cleanup } = await makeCtx(baseline);
  try {
    assert.equal(A8.layer, 'A');
    // 跑一次确认它没被 FACT_ANCHORS 漏掉
    const results = await runAnchors(ctx, [A8]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.anchorId, 'A8');
  } finally {
    await cleanup();
  }
});
