/**
 * 契约切片兜底：web 任务永远拿到完整路径清单。
 *
 * ## 真实失败（deliv-break2，2026-10-24）
 *
 * 22 条需求的茶歇系统，契约声明了 18 条路径：
 *
 *   /api/papers/{id}/comments、/api/comments/{id}/replies、/api/follows/{userId} …
 *
 * 而 PM 给前端任务 `T-012` 声明的切片是：
 *
 *   contractPaths: ["/"]
 *
 * 切片实现是忠实的 —— 前端于是只看到 `/`，其余端点它根本不知道长什么样，
 * 自己发明了 `/api/comments`、`/api/follows`、`/api/users`。
 * A7 连报 8 轮 `undeclared-endpoint`，而每轮返工喂给它的**还是那一条切片**，
 * 所以永远改不对 → `0/22` 需求达成、22 条全部记债、`fullyVerified=false`。
 *
 * 这是「上下文饥饿」在**切片**这一层的重演：信息不是被截断丢掉的，
 * 而是被一个**看起来正确**的切片声明挡在门外。
 *
 * 修法：引擎侧兜底 —— web 任务的切片并上契约的全部路径（成本几 KB），
 * 不依赖 PM 把切片声明对。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveContractSlice,
  endpointConstraintFor,
  WEB_ENDPOINT_CONSTRAINT,
} from '../src/contractslice.ts';

/** 复刻 deliv-break2 的契约形状：18 条路径，其中 3 条是前端真正要调的。 */
const contract = {
  version: 1,
  openapi: {
    openapi: '3.1.0',
    paths: Object.fromEntries(
      [
        '/health',
        '/',
        '/api/auth/register',
        '/api/auth/login',
        '/api/users/me',
        '/api/papers',
        '/api/papers/{id}',
        '/api/papers/{id}/comments',
        '/api/comments/{id}/replies',
        '/api/friends',
        '/api/follows/{userId}',
        '/api/users/{id}/following',
        '/api/recommendations',
      ].map((p) => [p, {}]),
    ),
  },
  jsonSchemas: {},
  generatedTypesPath: 'src/shared/contract-types.ts',
  changeRequests: [],
};

test('🔴 前端切片只有 ["/"] → 必须并上契约的全部路径（deliv-break2 的死因）', () => {
  const slice = effectiveContractSlice({ scope: 'web', contractSlice: { paths: ['/'] } }, contract);
  assert.ok(slice, 'web 任务必须得到切片');
  const paths = slice!.paths ?? [];
  assert.equal(paths.length, 13, `应当是契约的全部路径：${JSON.stringify(paths)}`);
  for (const p of ['/api/papers/{id}/comments', '/api/comments/{id}/replies', '/api/follows/{userId}']) {
    assert.ok(paths.includes(p), `前端必须能看到 ${p}，否则它只能自己发明路径`);
  }
});

test('后端任务不受影响（仍只拿它要实现的那几个端点）', () => {
  const declared = { paths: ['/api/papers', '/api/papers/{id}'], schemas: ['Paper'] };
  const slice = effectiveContractSlice({ scope: 'api', contractSlice: declared }, contract);
  assert.equal(slice, declared, '非 web 任务必须原样返回，避免扩大上下文');
});

test('前端没有声明切片时返回 undefined（走「整份契约/整份摘要」，本来就是全量）', () => {
  assert.equal(effectiveContractSlice({ scope: 'web' }, contract), undefined);
});

test('切片已经覆盖全部路径时不制造差异（返回原对象）', () => {
  const all = Object.keys(contract.openapi.paths);
  const declared = { paths: all };
  const slice = effectiveContractSlice({ scope: 'web', contractSlice: declared }, contract);
  assert.equal(slice, declared);
});

test('声明的 schemas 在合并后保留（只补路径，不动 schema 切片）', () => {
  const slice = effectiveContractSlice({ scope: 'web', contractSlice: { paths: ['/'], schemas: ['Paper'] } }, contract);
  assert.deepEqual(slice!.schemas, ['Paper']);
});

test('契约本身没有路径时不乱造（原样返回）', () => {
  const empty = { ...contract, openapi: { openapi: '3.1.0', paths: {} } };
  const declared = { paths: ['/'] };
  assert.equal(effectiveContractSlice({ scope: 'web', contractSlice: declared }, empty), declared);
});

test('约束文案只给 web 任务，且明确禁止发明端点', () => {
  assert.equal(endpointConstraintFor('api'), null);
  assert.equal(endpointConstraintFor(undefined), null);
  const line = endpointConstraintFor('web');
  assert.equal(line, WEB_ENDPOINT_CONSTRAINT);
  assert.match(line!, /不要自行发明端点路径/);
  assert.match(line!, /A7/, '要说明违反后被谁判罚，模型才会当回事');
});

// ════════════════════════════════════════════════════════════════
// 集成：走真正的 selectContext，确认兜底真的进了注入文本
// ════════════════════════════════════════════════════════════════

test('🔴 web 任务：注入文本里必须能看到契约的全部端点（不只是切片那一条）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ArtifactStore } = await import('../../core/src/index.ts');
  const { READ_PERMISSIONS } = await import('../src/types.ts');
  const { selectContext } = await import('../src/runner.ts');

  const dir = await mkdtemp(join(tmpdir(), 'af-slice-'));
  try {
    const store = new ArtifactStore(dir);
    await store.init();

    // 契约要大到"整份放不进契约层"（否则不会走摘要分支）
    const fatPaths: Record<string, unknown> = Object.fromEntries(
      [
        '/health',
        '/',
        '/api/papers',
        '/api/papers/{id}',
        '/api/papers/{id}/comments',
        '/api/comments/{id}/replies',
        '/api/follows/{userId}',
        '/api/users/{id}/following',
      ].map((p) => [p, { summary: 'x'.repeat(400), get: { responses: { '200': { description: 'y'.repeat(400) } } } }]),
    );
    const contract = await store.put({
      kind: 'Contract',
      producer: 'pm',
      content: {
        version: 1,
        openapi: { openapi: '3.1.0', paths: fatPaths },
        jsonSchemas: {},
        generatedTypesPath: 'src/shared/contract-types.ts',
        changeRequests: [],
      },
    });
    await store.freeze(contract.id);

    const sel = selectContext({
      store,
      readable: new Set(READ_PERMISSIONS.frontend),
      role: 'frontend',
      req: {
        kind: 'CodeModule',
        scope: 'web',
        instruction: '实现页面',
        contractSlice: { paths: ['/'] },
      },
      budget: 20_000, // 契约层约 5k；整份 7k+ 放不下 -> 走摘要分支
    });

    const text = sel.blocks.join('\n');
    const injectedContract = sel.report.injected.find((x) => x.kind === 'Contract');
    assert.ok(injectedContract, '契约必须被注入');
    assert.equal(injectedContract!.digest, true, '大契约应当以摘要形式注入');

    for (const p of ['/api/papers/{id}/comments', '/api/comments/{id}/replies', '/api/follows/{userId}']) {
      assert.ok(
        text.includes(p),
        `前端上下文里必须出现 ${p} —— 切片只有 '/' 时，这正是它发明端点的原因`,
      );
    }
    assert.match(text, /不要自行发明端点路径/, '还要明确禁止发明端点');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});