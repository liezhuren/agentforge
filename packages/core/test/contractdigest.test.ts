/**
 * 契约摘要与切片覆盖检查的测试。
 *
 * 这两个东西配合起来解决一个真实缺陷（`docs/07 §O2`）：
 * 契约 6.6 万字符、上下文预算 2.4 万 → 契约被**静默跳过** → 后端照自然语言猜接口 →
 * A7 报 13 个端点未实现。修法是「放不下就给确定性摘要 + 按任务切片」，
 * 而切分又会引入「某个端点没人认领」，所以必须配覆盖检查。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSliceCoverage, digestContract } from '../src/contractdigest.ts';
import type { ContractDoc } from '../src/types.ts';

/** 造一个「大」契约：多个端点 + 带 $ref 的模型。 */
function bigContract(): ContractDoc {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    paths[`/api/thing${i}`] = {
      get: { responses: { '200': { description: 'ok' } } },
      post: { responses: { '201': { description: 'created' } } },
    };
  }
  paths['/health'] = { get: { responses: { '200': { description: 'ok' } } } };

  return {
    version: 1,
    generatedTypesPath: 'src/shared/contract-types.ts',
    openapi: { openapi: '3.1.0', paths },
    jsonSchemas: {
      Status: { type: 'string', enum: ['a', 'b'] },
      Thing: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { $ref: '#/$defs/Status' },
          note: { type: ['string', 'null'] },
          tags: { type: 'array', items: { $ref: '#/$defs/Status' } },
          nested: { type: 'object', properties: { a: { type: 'string' } } },
        },
      },
      Loose: { type: 'object' },
    },
  } as unknown as ContractDoc;
}

test('摘要：把大契约压到很小，且保留「写代码需要的信息」', () => {
  const c = bigContract();
  const full = JSON.stringify(c, null, 2).length;
  const d = digestContract(c);

  assert.ok(d.length < full / 5, `摘要应当显著更小：${d.length} vs ${full}`);
  // 端点：方法 + 路径 + 成功状态码
  assert.match(d, /\/api\/thing0: GET → 200, POST → 201/);
  assert.match(d, /\/health: GET → 200/);
  // 模型：$ref 解析成名字、可空、引用数组（嵌套对象压成一行，保留 schemaToTs 的字段分隔格式）
  assert.match(d, /Thing \{ id:string, status:Status, note\?:string \| null, tags\?:Status\[\]/);
  assert.match(d, /nested\?:\{ a\?: string; \}/);
  assert.match(d, /Loose: Record<string, unknown>/);
  // 生成的类型文件路径必须带上（这是「该 import 谁」）
  assert.match(d, /src\/shared\/contract-types\.ts/);
});

test('摘要：确定性 —— 同一份契约两次输出完全一致', () => {
  const c = bigContract();
  assert.equal(digestContract(c), digestContract(c));
});

test('摘要：声明切片时只列该任务的端点与模型', () => {
  const c = bigContract();
  const d = digestContract(c, { slice: { paths: ['/api/thing3'], schemas: ['Thing'] } });

  assert.match(d, /端点 1\/21/);
  assert.match(d, /模型 1\/3/);
  assert.match(d, /\/api\/thing3/);
  assert.doesNotMatch(d, /\/api\/thing4/, '没声明的端点不该出现');
  assert.doesNotMatch(d, /Loose/, '没声明的模型不该出现');
});

test('摘要：切片的路径在契约里不存在时，说明是 0 个而不是假装有', () => {
  const c = bigContract();
  const d = digestContract(c, { slice: { paths: ['/api/nope'] } });
  assert.match(d, /端点 0\/21/);
  assert.match(d, /（无）/);
});

test('摘要：超出上限时**显式说明还有多少没列**，不静默截断', () => {
  const c = bigContract();
  const d = digestContract(c, { maxPaths: 2, maxSchemas: 1 });
  assert.match(d, /另有 19 个端点未列出/);
  assert.match(d, /另有 2 个模型未列出/);
});

test('覆盖检查：没人认领的端点 / 契约里没有的端点，都要报出来', () => {
  const c = bigContract();
  const cov = checkSliceCoverage(c, [
    { paths: ['/api/thing0', '/api/ghost'], schemas: ['Thing', 'GhostModel'] },
  ]);

  assert.ok(cov.orphanPaths.includes('/api/thing1'), '没被认领的端点要报');
  assert.ok(!cov.orphanPaths.includes('/api/thing0'), '被认领的不报');
  assert.deepEqual(cov.phantomPaths, ['/api/ghost'], '契约里没有的端点要报');
  assert.ok(cov.orphanSchemas.includes('Loose'));
  assert.deepEqual(cov.phantomSchemas, ['GhostModel']);
});

test('覆盖检查：多个任务的切片取并集 —— 只要有人认领就不算孤儿', () => {
  const c = bigContract();
  const allPaths = Object.keys(c.openapi!.paths!);
  const cov = checkSliceCoverage(c, [
    { paths: allPaths.slice(0, 10) },
    { paths: allPaths.slice(10) },
  ]);
  assert.deepEqual(cov.orphanPaths, [], '并集覆盖了全部端点，就不该报孤儿');
});

/**
 * 🔴 真实缺陷（cb-3）：契约把 OpenAPI 的结构性键 `components` 写进了 `paths`，
 * 覆盖率检查于是要求「有任务认领 components」——
 * 没有任何任务会去认领它，CONTRACTING 连挂两轮，最后**带债通过**，
 * 3 条需求在写第一行代码之前就被标成 `ACCEPTED_WITH_DEBT`。
 *
 * 判据必须是「键以 / 开头」（OpenAPI 的硬性要求），而不是「键存在」。
 */
test('🔴 契约 paths 里的结构性键（components）不该被要求认领', () => {
  const c = {
    version: 1,
    openapi: {
      openapi: '3.1.0',
      paths: {
        '/api/a': {},
        '/api/b': {},
        // PM 把 components 放错了层级
        components: { schemas: { Thing: { type: 'object' } } },
      },
    },
    jsonSchemas: { Thing: { type: 'object' } },
    generatedTypesPath: 'shared/contract/types.ts',
    changeRequests: [],
  } as unknown as ContractDoc;

  const cov = checkSliceCoverage(c, [{ paths: ['/api/a', '/api/b'] }, { schemas: ['Thing'] }]);
  assert.deepEqual(cov.orphanPaths, [], 'components 不是端点，不该被要求认领');
  assert.deepEqual(cov.phantomPaths, [], '只认领真端点不该算漂移');
  assert.deepEqual(cov.orphanSchemas, []);
});

test('🔴 但任务真的去认领一个非端点键时，仍然算契约漂移', () => {
  const c = {
    version: 1,
    openapi: { openapi: '3.1.0', paths: { '/api/a': {}, components: {} } },
    jsonSchemas: {},
    generatedTypesPath: 'shared/contract/types.ts',
    changeRequests: [],
  } as unknown as ContractDoc;

  const cov = checkSliceCoverage(c, [{ paths: ['/api/a', 'components'] }]);
  assert.deepEqual(cov.phantomPaths, ['components'], '把结构键当接口认领，说明 PM 概念错了，必须报出来');
});