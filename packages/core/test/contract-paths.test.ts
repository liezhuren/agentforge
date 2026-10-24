/**
 * 「契约必须声明至少一条路径」+ 校验器补齐 minProperties。
 *
 * ## 为什么会有这组测试
 *
 * 2026-10-24 定位成功率问题时发现：失败的两次（brief-s1、agentforge-project）
 * 交上来的契约都是**数据模型写了 4–7 个、接口路径只有 `/health`**，
 * 而任务图照常声明 `/api/tasks`、`/api/tasks/{id}` —— 于是 A7 每轮报
 * `phantom-contract-path`，连改 9 轮不动，最后带债收场。
 *
 * 更关键的是：**当时的校验器根本不支持 `minProperties`**，
 * 所以「契约必须至少声明一条路径」这条约束**没法表达** —— 一份空契约完全合法。
 * 这不是模型能力问题，是这套 schema 少了一类可表达的约束。
 *
 * 这组测试守两件事：
 *   1. 校验器真的支持 minProperties（否则 schema 上的约束只是装饰）；
 *   2. 契约 schema 真的拒绝空 paths（否则缺陷会复活）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSchema } from '../src/schema.ts';
import { validateArtifactContent } from '../src/schemas.ts';

test('校验器：minProperties 真的生效（空对象必须失败）', () => {
  const schema = { type: 'object', minProperties: 1 };
  const errors = validateSchema({}, schema, schema);
  assert.equal(errors.length, 1, '空对象必须报一条错');
  assert.equal(errors[0]!.keyword, 'minProperties');
  assert.match(errors[0]!.message, /至少/);
});

test('校验器：minProperties 满足时不报错，且 maxProperties 也支持', () => {
  const s = { type: 'object', minProperties: 1, maxProperties: 2 };
  assert.equal(validateSchema({ a: 1 }, s, s).length, 0);
  assert.equal(validateSchema({ a: 1, b: 2 }, s, s).length, 0);
  const errs = validateSchema({ a: 1, b: 2, c: 3 }, s, s);
  assert.equal(errs.length, 1);
  assert.equal(errs[0]!.keyword, 'maxProperties');
});

test('校验器：错误路径指向出错的对象（便于回喂给模型）', () => {
  const schema = {
    type: 'object',
    properties: { openapi: { type: 'object', properties: { paths: { type: 'object', minProperties: 1 } } } },
  };
  const errors = validateSchema({ openapi: { paths: {} } }, schema, schema);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.path, '$.openapi.paths', `路径要能定位到具体位置：${errors[0]!.path}`);
});

/** 一份字段齐全、只有 paths 为空的契约（复刻 brief-s1 的真实产物形状）。 */
function contractWith(paths: Record<string, unknown>) {
  return {
    version: 1,
    openapi: { openapi: '3.1.0', paths },
    jsonSchemas: {},
    generatedTypesPath: 'src/shared/contract-types.ts',
    changeRequests: [],
  };
}

test('🔴 契约 paths 为空 → schema 必须拒绝（这就是 brief-s1 的死因）', () => {
  const r = validateArtifactContent('Contract', contractWith({}));
  assert.equal(r.ok, false, '空 paths 的契约不该通过校验');
  const errors = 'errors' in r ? r.errors : [];
  assert.ok(
    errors.some((e) => e.keyword === 'minProperties'),
    `应当由 minProperties 拦下：${JSON.stringify(errors)}`,
  );
});

test('契约至少有一条路径 → 通过（别误伤正常契约）', () => {
  const r = validateArtifactContent('Contract', contractWith({ '/health': {} }));
  assert.equal(r.ok, true, 'paths 非空的契约必须通过');
});

test('多条路径的契约也合法 —— 约束是"非空"，不是"必须含业务路径"', () => {
  // 刻意不要求"必须有业务端点"：有些项目真的只暴露健康检查。
  // 要拦的是**完全没有路径**，不是**路径不够多**。
  const r = validateArtifactContent('Contract', contractWith({ '/health': {}, '/api/tasks': {} }));
  assert.equal(r.ok, true, 'paths 非空的契约必须通过');
});
