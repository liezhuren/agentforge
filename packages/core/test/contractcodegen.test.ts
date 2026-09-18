/**
 * 契约类型生成器的测试。
 *
 * ## 这个文件为什么现在才有
 *
 * `generateContractTypes()` 是「前后端类型不可能分叉」这条承诺的**唯一执行者** ——
 * 契约冻结后由它生成共享类型，双方都只能 import 它。也就是说：
 * **它生成错了，整条下游都会跟着错，而且错得看起来像模型不会写代码。**
 *
 * 它此前**一个测试都没有**（只有 `projectcontract.test.ts` 顺带碰了一下）。
 * 这不是疏忽，是这类组件特别容易漏测：它「总是有输出」，
 * 输出错了也只是类型宽松一点，不会抛异常、不会报错 —— 直到真实运行里
 * 下游角色被判 FAIL 才暴露。
 *
 * ## 致命缺陷（第 13 轮真实运行暴露）
 *
 * `schemaToTs()` 用 `switch (s.type)` 分派，于是三种 JSON Schema 写法**全都**落进
 * `default` 分支、被降级成 `Record<string, unknown>`：
 *
 * 1. `{"$ref":"#/$defs/BookStatus"}` —— 没有 `type` 字段（签名里也没有放「定义表」的地方）
 * 2. `{"type":["string","null"]}` —— `type` 是**数组**，匹配不上任何 `case`
 * 3. `{"type":"array","items":{"$ref":...}}` —— items 里的 ref 同上
 *
 * 而这些写法恰恰是**正确**的 JSON Schema。PM 交出的契约是精确的，
 * 是生成器把精确信息丢掉了。
 *
 * 连锁反应值得完整记下来，因为每一环看起来都像「模型能力不足」：
 * 后端按契约类型写代码 → 16 个编译错误（TS2322/TS2367）→ A4 FAIL → 归因给 backend →
 * 但角色改不动生成物（它来自冻结契约）→ 角色只好**放弃契约类型、自己重声明模型** →
 * A4 PASS → 结果是**契约漂移**（正是 A7 想防的），而 A7 不阻断。
 *
 * 所以下面的回归用例用的是**那一轮真实契约的原文片段**，不是我构造的样本 ——
 * 「能用真实数据验证的，不要用构造样本」（§9.4）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateContractTypes, resolveRefName, schemaToTs } from '../src/contractcodegen.ts';
import type { ContractDoc } from '../src/types.ts';

const KNOWN = new Set(['BookStatus', 'HistoryEntry', 'Book', 'ErrorCode', 'ErrorDetail']);
const ctx = { knownNames: KNOWN };

test('$ref 解析成生成文件里的类型名，而不是 Record<string, unknown>', () => {
  assert.equal(schemaToTs({ $ref: '#/$defs/BookStatus' }, 0, ctx), 'BookStatus');
  // definitions 写法也认
  assert.equal(schemaToTs({ $ref: '#/definitions/BookStatus' }, 0, ctx), 'BookStatus');
});

test('$ref 解析不到时返回 unknown —— 响亮的失败，不是伪装成「任意对象」', () => {
  // 返回 Record<string, unknown> 会让下游代码照常编译，坏契约就一路安静地传到运行期
  assert.equal(schemaToTs({ $ref: '#/$defs/NotDefined' }, 0, ctx), 'unknown');
  assert.equal(schemaToTs({ $ref: '#/somewhere/else' }, 0, ctx), 'unknown');
  assert.equal(resolveRefName('#/$defs/NotDefined', ctx), null);
});

test('联合类型数组 → 可空类型（`type:["string","null"]`）', () => {
  assert.equal(schemaToTs({ type: ['string', 'null'] }, 0, ctx), 'string | null');
  assert.equal(schemaToTs({ type: ['number', 'string'] }, 0, ctx), 'number | string');
  // 去重：`type:["string","string"]` 不该产生 `string | string`
  assert.equal(schemaToTs({ type: ['string', 'string'] }, 0, ctx), 'string');
});

test('array + $ref items → 具名类型数组', () => {
  assert.equal(schemaToTs({ type: 'array', items: { $ref: '#/$defs/HistoryEntry' } }, 0, ctx), 'HistoryEntry[]');
});

test('oneOf 里的 $ref 也能解析', () => {
  assert.equal(
    schemaToTs({ oneOf: [{ $ref: '#/$defs/BookStatus' }, { type: 'null' }] }, 0, ctx),
    'BookStatus | null',
  );
});

test('🔴 回归：用第 13 轮**真实契约**的 schema，生成结果必须保住精确类型', () => {
  /**
   * 下面这些 schema 是 `workspace/llm-13` 那轮真实运行的 Contract 原文（照抄）。
   * 修复前 `generateContractTypes()` 会把 Book.status 生成成 `Record<string, unknown>`，
   * 于是「按契约写代码」必然编译失败。
   */
  const contract = {
    version: 1,
    generatedTypesPath: 'src/shared/contract-types.ts',
    jsonSchemas: {
      BookStatus: { title: 'BookStatus', type: 'string', enum: ['available', 'borrowed', 'overdue'] },
      ErrorCode: {
        title: 'ErrorCode',
        type: 'string',
        enum: ['INVALID_ISBN', 'BOOK_NOT_FOUND', 'ALREADY_BORROWED', 'LIMIT_EXCEEDED'],
      },
      HistoryEntry: {
        title: 'HistoryEntry',
        type: 'object',
        additionalProperties: false,
        required: ['status', 'timestamp'],
        properties: {
          status: { $ref: '#/$defs/BookStatus' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      Book: {
        title: 'Book',
        type: 'object',
        additionalProperties: false,
        required: ['isbn', 'title', 'status', 'borrowerId', 'renewCount', 'history'],
        properties: {
          isbn: { type: 'string', pattern: '^[0-9]{13}$' },
          title: { type: 'string', minLength: 1 },
          status: { $ref: '#/$defs/BookStatus' },
          borrowerId: { type: ['string', 'null'] },
          renewCount: { type: 'integer', minimum: 0 },
          history: { type: 'array', items: { $ref: '#/$defs/HistoryEntry' } },
        },
      },
      ErrorDetail: {
        title: 'ErrorDetail',
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: { code: { $ref: '#/$defs/ErrorCode' }, message: { type: 'string', minLength: 1 } },
      },
    },
    openapi: { paths: { '/books': {}, '/books/{isbn}': {} } },
  } as unknown as ContractDoc;

  const out = generateContractTypes(contract);

  // 精确类型必须被保住
  assert.match(out, /status: BookStatus;/, 'Book.status 必须解析成 BookStatus');
  assert.match(out, /borrowerId: string \| null;/, '可空字段必须是 string | null');
  assert.match(out, /history: HistoryEntry\[\];/, '引用数组必须解析成 HistoryEntry[]');
  assert.match(out, /code: ErrorCode;/, 'ErrorDetail.code 必须解析成 ErrorCode');

  // 而且要**不再**出现「引用被降级」的痕迹。
  // 注意这里不能简单断言「输出里没有 Record<string, unknown>」——
  // 那是过严的：契约若真的声明了一个没有 properties 的对象，出现它是**正确**的。
  // 所以要针对具体字段断言。
  assert.doesNotMatch(out, /status: Record<string, unknown>;/, '引用不得再被降级');
  assert.doesNotMatch(out, /borrowerId: Record<string, unknown>;/, '联合类型不得再被降级');
  assert.doesNotMatch(out, /code: Record<string, unknown>;/, '引用不得再被降级');

  // 枚举与端点常量照旧
  assert.match(out, /export type BookStatus = "available" \| "borrowed" \| "overdue";/);
  assert.match(out, /"\/books"/);
});

test('契约真的没说什么类型时，Record<string, unknown> 仍然是**正确**的输出', () => {
  // 这一条防的是「矫枉过正」：不能为了让上面那条通过就把这个降级也当成 bug 修掉。
  const contract = {
    version: 1,
    generatedTypesPath: 'src/shared/types.ts',
    jsonSchemas: {
      Loose: { title: 'Loose', type: 'object' },
      Closed: { title: 'Closed', type: 'object', additionalProperties: false },
    },
    openapi: { paths: {} },
  } as unknown as ContractDoc;
  const out = generateContractTypes(contract);
  assert.match(out, /export type Loose = Record<string, unknown>;/);
  assert.match(out, /export type Closed = \{\};/);
});
