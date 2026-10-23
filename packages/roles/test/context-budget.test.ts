/**
 * 上下文预算（`maxContextChars`）的接线测试。
 *
 * 为什么需要：这个预算以前**不可配置**（`createBoundRoleRunners` 不透传），
 * 而默认 2.4 万在真实项目里太小 —— 第 14 轮那份契约有 6.6 万字符，
 * 于是它被整体跳过，角色只能照自然语言猜接口（`docs/07 §O2`）。
 *
 * 现在两件事分开验证：
 * 1. 预算可配（本文件）
 * 2. 放不下的契约会变成确定性摘要而不是消失（见 `contractdigest.test.ts`
 *    与 `orchestrator/test/e2e.test.ts` 的大契约用例）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ArtifactStore } from '../../core/src/store.ts';
import { MockProvider } from '../../llm/src/mock.ts';
import { LlmRoleRunner } from '../src/runner.ts';
import type { RoleContext } from '../src/types.ts';

function profile() {
  return {
    name: 'budget-fixture',
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

async function fixture(): Promise<{ dir: string; store: ArtifactStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'af-ctx-budget-'));
  const store = new ArtifactStore(dir);
  await store.init();

  // 造一份远超默认 24k 预算的契约
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) {
    paths[`/api/thing${i}`] = {
      get: { description: 'x'.repeat(300), responses: { '200': {} } },
    };
  }
  const art = await store.put({
    kind: 'Contract',
    producer: 'pm',
    content: {
      version: 1,
      openapi: { openapi: '3.1.0', paths },
      jsonSchemas: { Thing: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      generatedTypesPath: 'shared/contract/types.ts',
      changeRequests: [],
    },
  });
  await store.freeze(art.id);

  return { dir, store, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

function ctxOf(store: ArtifactStore): RoleContext {
  return {
    stage: 'BUILDING',
    store,
    profile: profile(),
    workOrders: [],
    contractHash: null,
    userBrief: '做一个东西',
    directives: [],
    // 记忆经验：这里不测，留空
  };
}

test('🔴 maxContextChars 可配：调小之后契约走摘要，而不是被静默跳过', async () => {
  const f = await fixture();
  try {
    const provider = new MockProvider({
      script: {
        'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: 'export const a = 1;\n' }] },
      },
    });
    const runner = new LlmRoleRunner({
      role: 'backend',
      provider,
      maxContextChars: 3_000, // 故意很小 —— 契约（4 万+字符）必然放不下
    });

    await runner.produce(
      { kind: 'CodeModule', scope: 'api', instruction: '实现任务 T-01' },
      ctxOf(f.store),
    );

    const prompt = provider.calls.map((c) => c.lastUserMessage).join('\n');
    assert.ok(prompt.includes('契约摘要'), '预算不够时契约必须被压缩成摘要');
    assert.match(prompt, /超出本次上下文预算/, '必须说明为什么只有摘要');
    assert.match(prompt, /\/api\/thing0/, '摘要里必须含端点');
  } finally {
    await f.cleanup();
  }
});

test('预算足够时给完整契约，且不出现「摘要」字样（不误伤正常路径）', async () => {
  const f = await fixture();
  try {
    const provider = new MockProvider({
      script: {
        'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: 'export const a = 1;\n' }] },
      },
    });
    const runner = new LlmRoleRunner({
      role: 'backend',
      provider,
      maxContextChars: 5_000_000, // 足够大
    });

    await runner.produce(
      { kind: 'CodeModule', scope: 'api', instruction: '实现任务 T-01' },
      ctxOf(f.store),
    );

    const prompt = provider.calls.map((c) => c.lastUserMessage).join('\n');
    assert.ok(prompt.includes('Contract-001'), '预算够时应注入完整契约工件');
    assert.ok(!prompt.includes('超出本次上下文预算'), '不该误报成摘要');
  } finally {
    await f.cleanup();
  }
});
