import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonSchema } from '../../core/src/schemas.ts';
import {
  BudgetExceededError,
  BudgetTracker,
  BudgetedProvider,
  ConfigError,
  FATAL_KINDS,
  FileCapabilityCache,
  JsonlRunRecorder,
  LlmHttpError,
  LlmSetupError,
  LlmTimeoutError,
  MockProvider,
  OpenAiCompatProvider,
  ProbeOutputError,
  ReplayMissError,
  ReplayProvider,
  RecordingProvider,
  buildLlm,
  classifyProbeFailure,
  expandEnv,
  extractJson,
  firstBalanced,
  isUnreachable,
  loadConfigFile,
  loadRunRecords,
  parseConfig,
  probeCacheKey,
  probeJsonSchemaMode,
  stripBom,
  templateConfig,
  toStrictJsonSchema,
  type ForgeConfig,
} from '../src/index.ts';
import { FakeOpenAiServer, behaviors, defaultChatResponse, type FakeBehavior } from './fake-server.ts';

// ════════════════════════════════════════════════════════════════
// 严格模式 schema 转换
// ════════════════════════════════════════════════════════════════

const SAMPLE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
    note: { type: 'string' },
    kind: { oneOf: [{ const: 'file' }, { const: 'artifact' }] },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
};

test('strict 转换：可选字段 → required + nullable，oneOf → anyOf，剔除不支持的约束', () => {
  const { schema, changes, lossy } = toStrictJsonSchema(SAMPLE_SCHEMA);
  const props = schema.properties as Record<string, Record<string, unknown>>;

  assert.deepEqual(schema.required, ['id', 'note', 'kind', 'tags'], '所有属性都必须出现在 required 里');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(props.note.type, ['string', 'null'], '可选字段用 nullable 表达');
  assert.deepEqual(props.id.type, 'string', '原本必填的字段不应被改成 nullable');
  assert.ok(Array.isArray(props.kind.anyOf), 'oneOf 应转为 anyOf');
  assert.ok(!('minLength' in props.id), '严格模式不支持的关键字应被剔除');
  assert.ok(!('minItems' in props.tags), 'minItems 应被剔除');
  assert.equal(lossy, true);
  assert.ok(changes.some((c) => c.includes('oneOf')), JSON.stringify(changes));
});

test('strict 转换：已兼容的 schema 不应产生任何改动', () => {
  const already: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string' } },
  };
  const { changes } = toStrictJsonSchema(already);
  assert.deepEqual(changes, [], '不该做无谓转换（否则会白白丢掉约束）');
});

test('strict 转换：本地校验强度不因转换而降低（原始 schema 仍被使用）', () => {
  // 转换只放宽服务端约束；客户端仍按原始 schema 校验。
  const { schema } = toStrictJsonSchema(SAMPLE_SCHEMA);
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.ok(!('minLength' in props.id));
  // 原始 schema 未被修改（纯函数）
  const orig = SAMPLE_SCHEMA.properties as Record<string, Record<string, unknown>>;
  assert.equal(orig.id.minLength, 1, '转换不得就地修改输入');
});

// ════════════════════════════════════════════════════════════════
// JSON 提取与修复
// ════════════════════════════════════════════════════════════════

test('extractJson：直接解析 / 围栏 / 括号平衡提取 / 尾随逗号修复', () => {
  assert.deepEqual(extractJson('{"a":1}'), { value: { a: 1 }, repaired: false });

  const fenced = extractJson('好的：\n```json\n{"a":1}\n```\n完毕');
  assert.equal(fenced?.repaired, true);
  assert.deepEqual(fenced?.value, { a: 1 });

  const embedded = extractJson('结果是 {"a":{"b":[1,2]}} 这样');
  assert.deepEqual(embedded?.value, { a: { b: [1, 2] } });

  const trailing = extractJson('{"a":1,}');
  assert.deepEqual(trailing?.value, { a: 1 });

  assert.equal(extractJson('完全不是 JSON'), null);
  assert.equal(extractJson(''), null);
});

test('firstBalanced：跳过字符串字面量里的括号', () => {
  assert.equal(firstBalanced('x {"a":"}"} y'), '{"a":"}"}');
  assert.equal(firstBalanced('x {"a":"\\""} y'), '{"a":"\\""}');
  assert.equal(firstBalanced('没有括号'), null);
});

// ════════════════════════════════════════════════════════════════
// OpenAI 兼容 Provider：真实 HTTP
// ════════════════════════════════════════════════════════════════

async function withServer<T>(behavior: FakeBehavior, fn: (s: FakeOpenAiServer) => Promise<T>): Promise<T> {
  const s = await new FakeOpenAiServer(behavior).start();
  try {
    return await fn(s);
  } finally {
    await s.stop();
  }
}

function providerFor(s: FakeOpenAiServer, over: Record<string, unknown> = {}) {
  return new OpenAiCompatProvider({
    name: 'fake',
    baseUrl: s.baseUrl,
    apiKey: 'test-key',
    defaultModel: 'fake-model',
    jsonMode: 'strict',
    timeoutMs: 5000,
    maxRetries: 1,
    // 退避设成 1ms：否则重试用例要白等几秒，测试套件会变得没人愿意跑
    backoffMs: 1,
    ...over,
  } as never);
}

test('Provider：正常返回时解析 JSON 并带上 usage / model / finishReason', async () => {
  await withServer(behaviors.ok(), async (s) => {
    const p = providerFor(s);
    const res = await p.complete({
      role: 'pm',
      purpose: 't',
      messages: [{ role: 'user', content: 'hi' }],
      schema: SAMPLE_SCHEMA,
      schemaName: 'Sample',
    });
    assert.deepEqual(res.json, { ok: true, note: 'probe', tag: 'x' });
    assert.equal(res.provider, 'fake');
    assert.equal(res.model, 'fake-model');
    assert.equal(res.usage?.promptTokens, 120);
    assert.equal(res.finishReason, 'stop');
    assert.equal(res.parseError, undefined);
  });
});

test('Provider：Authorization 头与端点路径正确', async () => {
  await withServer(behaviors.ok(), async (s) => {
    const p = providerFor(s);
    await p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(s.requests[0].url, '/v1/chat/completions');
    assert.equal(s.requests[0].headers.authorization, 'Bearer test-key');
  });
});

test('Provider：baseUrl 末尾斜杠被规范化', async () => {
  await withServer(behaviors.ok(), async (s) => {
    const p = providerFor(s, { baseUrl: s.baseUrl + '///' });
    await p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(s.requests[0].url, '/v1/chat/completions');
  });
});

test('Provider：strict 模式发送 response_format.json_schema，且经转换后符合严格模式要求', async () => {
  await withServer(behaviors.ok(), async (s) => {
    const p = providerFor(s, { strictSchema: 'sanitize' });
    await p.complete({
      role: 'pm',
      purpose: 't',
      messages: [{ role: 'user', content: 'x' }],
      schema: SAMPLE_SCHEMA,
      schemaName: 'Sample',
    });
    const rf = s.lastBody.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
    };
    assert.equal(rf.type, 'json_schema');
    assert.equal(rf.json_schema.strict, true);
    assert.equal(rf.json_schema.name, 'Sample');
    assert.equal(rf.json_schema.schema.additionalProperties, false);
    assert.deepEqual(rf.json_schema.schema.required, ['id', 'note', 'kind', 'tags']);
  });
});

test('Provider：json-mode 降级时不发 schema，但把 schema 写进提示词', async () => {
  await withServer(behaviors.ok(), async (s) => {
    const p = providerFor(s, { jsonMode: 'json-mode' });
    await p.complete({
      role: 'pm',
      purpose: 't',
      messages: [{ role: 'user', content: '基础提示' }],
      schema: SAMPLE_SCHEMA,
    });
    assert.deepEqual(s.lastBody.response_format, { type: 'json_object' });
    const messages = s.lastBody.messages as Array<{ role: string; content: string }>;
    const user = messages.find((m) => m.role === 'user')!;
    assert.ok(user.content.includes('基础提示'));
    assert.ok(user.content.includes('JSON Schema'), '必须把 schema 传给模型');
    assert.ok(user.content.includes('additionalProperties'));
  });
});

test('Provider：prompt-only 降级时既不发 response_format 也不发 json_schema', async () => {
  await withServer(behaviors.ok(), async (s) => {
    const p = providerFor(s, { jsonMode: 'prompt-only' });
    await p.complete({
      role: 'pm',
      purpose: 't',
      messages: [{ role: 'user', content: 'x' }],
      schema: SAMPLE_SCHEMA,
    });
    assert.equal(s.lastBody.response_format, undefined);
    const messages = s.lastBody.messages as Array<{ content: string }>;
    assert.ok(messages.some((m) => m.content.includes('JSON Schema')));
  });
});

test('Provider：Markdown 围栏里的 JSON 被修复，且 parseError 留下痕迹', async () => {
  await withServer(behaviors.fencedJson(), async (s) => {
    const p = providerFor(s);
    const res = await p.complete({
      role: 'pm',
      purpose: 't',
      messages: [{ role: 'user', content: 'x' }],
      schema: SAMPLE_SCHEMA,
    });
    assert.deepEqual(res.json, { ok: true, note: 'fenced', tag: 1 });
    assert.ok(res.parseError?.includes('修复'), '修复必须可追溯，人类有权知道结论来自被修复过的文本');
  });
});

test('Provider：无法解析时返回 parseError 而不是抛异常（交由结构化重试处理）', async () => {
  await withServer(behaviors.garbage(), async (s) => {
    const p = providerFor(s);
    const res = await p.complete({
      role: 'pm',
      purpose: 't',
      messages: [{ role: 'user', content: 'x' }],
      schema: SAMPLE_SCHEMA,
    });
    assert.equal(res.json, undefined);
    assert.ok(res.parseError?.includes('无法解析'));
  });
});

test('Provider：429 会重试并最终成功（不是直接失败）', async () => {
  await withServer(behaviors.rateLimitThenOk(2), async (s) => {
    const retries: number[] = [];
    const p = providerFor(s, {
      maxRetries: 4,
      onRetry: (i: { attempt: number }) => retries.push(i.attempt),
    });
    const res = await p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }], schema: SAMPLE_SCHEMA });
    assert.deepEqual(res.json, { ok: true, note: 'probe', tag: 'x' });
    assert.equal(s.callCount, 3, '两次 429 + 一次成功');
    assert.deepEqual(retries, [1, 2]);
  });
});

test('Provider：401 这类 4xx 不重试（重试只会烧钱并掩盖真正的错误）', async () => {
  await withServer(behaviors.unauthorized(), async (s) => {
    const p = providerFor(s, { maxRetries: 4 });
    await assert.rejects(
      () => p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] }),
      (e: Error) => e instanceof LlmHttpError && e.status === 401 && e.retryable === false,
    );
    assert.equal(s.callCount, 1, '不得重试');
  });
});

test('Provider：500 会重试到上限后抛错', async () => {
  await withServer(behaviors.always500(), async (s) => {
    const p = providerFor(s, { maxRetries: 3 });
    await assert.rejects(
      () => p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] }),
      (e: Error) => e instanceof LlmHttpError && e.status === 500 && e.retryable === true,
    );
    assert.equal(s.callCount, 3);
  });
});

test('Provider：超时抛 LlmTimeoutError', async () => {
  await withServer(behaviors.hang(), async (s) => {
    const p = providerFor(s, { timeoutMs: 120, maxRetries: 1 });
    await assert.rejects(
      () => p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] }),
      (e: Error) => e instanceof LlmTimeoutError,
    );
  });
});

test('Provider：200 响应体里带 error 也要当失败（有些网关这么干）', async () => {
  await withServer(behaviors.errorInBody(), async (s) => {
    const p = providerFor(s);
    await assert.rejects(
      () => p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] }),
      /model overloaded/,
    );
  });
});

test('Provider：响应不是 JSON 时报 INVALID_JSON_BODY 且不重试', async () => {
  await withServer(behaviors.notJsonAtAll(), async (s) => {
    const p = providerFor(s, { maxRetries: 3 });
    await assert.rejects(
      () => p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] }),
      (e: Error) => e instanceof LlmHttpError && e.code === 'INVALID_JSON_BODY',
    );
    assert.equal(s.callCount, 1);
  });
});

// ════════════════════════════════════════════════════════════════
// 能力探测：降级链
// ════════════════════════════════════════════════════════════════

test('探测：端点支持严格模式 → 定为 strict，并写回 Provider', async () => {
  await withServer(behaviors.ok(), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', strictSchema: 'auto', maxRetries: 3 });
    const out = await probeJsonSchemaMode(p);
    assert.equal(out.jsonSchema, 'strict');
    assert.equal(out.reachable, true);
    assert.equal(out.strictNeedsSanitize, true, '我们的样例 schema 确实需要转换');
    assert.equal(p.jsonMode, 'strict', '结论必须写回 Provider，否则真实调用会失效');
    assert.equal(p.strictSchemaMode, 'sanitize', '转换模式也必须写回');
    assert.ok(out.evidence.some((e) => e.includes('严格模式可用')));
  });
});

test('探测：严格模式被拒 → 降级到 json-mode，且后续请求确实换成 json_object', async () => {
  await withServer(behaviors.rejectStrict(), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 3 });
    const out = await probeJsonSchemaMode(p);
    assert.equal(out.jsonSchema, 'json-mode');
    assert.equal(p.jsonMode, 'json-mode');
    assert.equal(out.reachable, true);
    assert.equal(out.conclusive, true);
    assert.equal(out.fatal, undefined, '「不支持某功能」不是致命问题，不该拦下来');
    assert.ok(out.evidence.some((e) => e.includes('严格模式探测失败（capability）')), JSON.stringify(out.evidence));

    // 探测后再发一次真实请求，验证它真的走了 json_object
    await p.complete({ role: 'pm', purpose: 'real', messages: [{ role: 'user', content: 'x' }], schema: SAMPLE_SCHEMA });
    assert.deepEqual(s.lastBody.response_format, { type: 'json_object' });
  });
});

test('探测：端点不可达 → 判为致命（unreachable），不做降级', async () => {
  // 指向一个没有监听的端口
  const p = new OpenAiCompatProvider({
    name: 'dead',
    baseUrl: 'http://127.0.0.1:9/v1',
    defaultModel: 'm',
    jsonMode: 'auto',
    timeoutMs: 800,
    maxRetries: 1,
  });
  const out = await probeJsonSchemaMode(p);
  assert.equal(out.reachable, false);
  assert.equal(out.fatal?.kind, 'unreachable');
  assert.ok(out.evidence.some((e) => e.includes('致命问题')), JSON.stringify(out.evidence));
  assert.ok(out.evidence.some((e) => e.includes('baseUrl')));
  assert.equal(isUnreachable(out.fatal?.message ?? ''), true);
});

test('探测：401（API key 错误）必须判为致命 auth，**不得**伪装成「不支持严格模式」', async () => {
  // 这是用真实端点实测才发现的 bug：
  // 第一版把 401 当成能力问题，连降两级后报 prompt-only + reachable:true，
  // 用户看到「一切正常，只是结构化输出弱一点」，实际每次调用都会 401 失败。
  await withServer(behaviors.unauthorized(), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 1 });
    const out = await probeJsonSchemaMode(p);
    assert.equal(out.fatal?.kind, 'auth');
    assert.equal(out.reachable, false);
    assert.notEqual(out.jsonSchema, 'prompt-only', '不得降级到 prompt-only 来掩盖鉴权失败');
    assert.ok(out.evidence.some((e) => e.includes('API key')), JSON.stringify(out.evidence));
    // 只试了一次就停下 —— 降级重试毫无意义
    assert.equal(s.callCount, 1, '致命问题应立刻停止降级链');
  });
});

test('探测：404 判为致命 base-url（常见错误：漏写 /v1）', async () => {
  await withServer(() => ({ status: 404, body: { error: { message: 'Not Found' } } }), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 1 });
    const out = await probeJsonSchemaMode(p);
    assert.equal(out.fatal?.kind, 'base-url');
    assert.ok(out.evidence.some((e) => e.includes('/v1')), JSON.stringify(out.evidence));
    assert.equal(s.callCount, 1);
  });
});

test('探测：400 提到模型名不存在 → 判为致命 model', async () => {
  await withServer(
    () => ({ status: 400, body: { error: { message: "The model 'gpt-9' does not exist" } } }),
    async (s) => {
      const p = providerFor(s, { jsonMode: 'auto', maxRetries: 1 });
      const out = await probeJsonSchemaMode(p);
      assert.equal(out.fatal?.kind, 'model');
      assert.equal(s.callCount, 1);
    },
  );
});

test('探测：429 限流 → 无结论（conclusive=false），但**不是**致命，也不能据此判定不支持', async () => {
  await withServer(behaviors.rateLimitThenOk(999), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 1 });
    const out = await probeJsonSchemaMode(p);
    assert.equal(out.conclusive, false, '限流下得不出能力结论');
    assert.equal(out.reachable, true, '限流不等于不可用');
    assert.equal(out.fatal, undefined);
    assert.ok(out.evidence.some((e) => e.includes('不能据此判断')), JSON.stringify(out.evidence));
  });
});

test('buildLlm：全部 provider 都致命时立刻失败并说清原因（而不是跑出一堆带债交付）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-fatal-'));
  try {
    const cfg = parseConfig({
      version: 1,
      providers: {
        a: { kind: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'm', jsonMode: 'auto', timeoutMs: 500, maxRetries: 1 },
      },
      roles: { pm: { provider: 'a' } },
      probe: { enabled: true, useCache: false },
    });
    await assert.rejects(
      () => buildLlm(cfg, { root: dir, probe: true, record: false }),
      (e: Error) => e instanceof LlmSetupError && e.message.includes('所有 LLM provider 都不可用') && e.message.includes('配置问题'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 探测：请求成功但输出不合用（真实端点实测发现的 bug，docs/07 §L1）
// ════════════════════════════════════════════════════════════════

test('分类：「请求成功但输出不合用」必须与「网络不可达」区分开 —— 它不致命', () => {
  // 这条断言是整组修复的核心。第一版把没有状态码的错误一律当网络层错误，
  // 于是「模型没吐出合法 JSON」被升级成 unreachable（致命、不降级），
  // 整个流水线拒绝启动，还提示用户去检查 API key / baseUrl / 网络 —— 全部指错方向。
  // 空输出必须看 finish_reason 才能定性：只有 length 才是预算问题。
  // 不知道 finish_reason 时判成「预算不足」是一种不负责任的猜测。
  const budget = classifyProbeFailure(new ProbeOutputError('empty', '模型返回了空内容', 'length'));
  assert.equal(budget.kind, 'token-budget');
  assert.equal(FATAL_KINDS.includes(budget.kind), false, 'token 预算不足不是配置错误，绝不能拦下整个 run');

  const emptyStop = classifyProbeFailure(new ProbeOutputError('empty', '模型返回了空内容', 'stop'));
  assert.equal(emptyStop.kind, 'empty-response');
  assert.equal(FATAL_KINDS.includes(emptyStop.kind), false);

  const unparseable = classifyProbeFailure(new ProbeOutputError('unparseable', '无法解析为 JSON'));
  assert.equal(unparseable.kind, 'output-format');
  assert.equal(FATAL_KINDS.includes(unparseable.kind), false);

  const truncated = classifyProbeFailure(new ProbeOutputError('truncated', '被截断'));
  assert.equal(truncated.kind, 'token-budget');

  // 对照组：真正的网络错误仍然是致命的
  assert.equal(classifyProbeFailure(new Error('fetch failed')).kind, 'unreachable');
  assert.equal(FATAL_KINDS.includes('unreachable'), true);
});

test('探测：预算被推理烧光（输出为空）→ 不致命、降级到 prompt-only、且如实标注「无结论」', async () => {
  await withServer(behaviors.rejectStrictThenUnparseable('empty'), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 1 });
    const out = await probeJsonSchemaMode(p);

    assert.equal(out.fatal, undefined, '绝不能判成致命 —— 否则整个流水线拒绝启动');
    assert.equal(out.reachable, true, '端点和鉴权都没问题，只是模型没给输出');
    assert.equal(out.conclusive, false, '没拿到合法 JSON，就不能声称「测出来了」');
    assert.equal(out.jsonSchema, 'prompt-only', '按最保守的档位继续');
    assert.ok(out.evidence.some((e) => e.includes('推理')), JSON.stringify(out.evidence));
    assert.ok(out.evidence.some((e) => e.includes('没有得到确定结论')), JSON.stringify(out.evidence));
  });
});

test('探测：模型不照 schema 输出（有内容但非 JSON）→ 同样不致命，且指出是格式遵从度问题', async () => {
  await withServer(behaviors.rejectStrictThenUnparseable('garbage'), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 1 });
    const out = await probeJsonSchemaMode(p);
    assert.equal(out.fatal, undefined);
    assert.equal(out.reachable, true);
    assert.equal(out.conclusive, false);
    assert.equal(out.jsonSchema, 'prompt-only');
    assert.ok(out.evidence.some((e) => e.includes('格式遵从度')), JSON.stringify(out.evidence));
  });
});

test('分类：空输出且 finish_reason=stop **不是** token 预算问题（两者修法不同）', async () => {
  // 真实端点实测（docs/07 §L6）：探测遇到「请求成功 + 输出为空 + finish_reason=stop」。
  // 这与「finish_reason=length 导致空输出」是完全不同的原因：
  // 前者提高 maxTokens 毫无用处，后者才是预算不足。
  // 把它们混成一句「max_tokens 不够」，就是让用户去修一个不存在的参数。
  await withServer(behaviors.rejectStrictThenUnparseable('empty-stop'), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 1 });
    const out = await probeJsonSchemaMode(p);
    assert.equal(out.fatal, undefined, '同样不能判成致命');
    assert.equal(out.reachable, true);
    assert.equal(out.conclusive, false);
    assert.equal(out.jsonSchema, 'prompt-only');
    const ev = out.evidence.join('\n');
    assert.ok(ev.includes('不是 token 预算问题'), ev);
    assert.ok(ev.includes('finish_reason=stop'), ev);
    assert.equal(ev.includes('提高 maxTokens 或换非推理模型即可'), false, '不能把 stop 的情形也归因成预算不足');
  });

  // 分类层面也要能区分
  assert.equal(classifyProbeFailure(new ProbeOutputError('empty', 'x', 'stop')).kind, 'empty-response');
  assert.equal(classifyProbeFailure(new ProbeOutputError('empty', 'x', 'length')).kind, 'token-budget');
  assert.equal(FATAL_KINDS.includes('empty-response'), false);
});

test('探测：探测自身的 maxTokens 必须留足余量（回归锁）', async () => {
  // 这一条是防回归的「报警器」：探测用 64 个 token 时，
  // 推理型模型会把预算全花在不可见的推理上，可见输出为零 ——
  // 于是探测**用自己的吝啬**判定了对方的能力不足（真实端点实测，docs/07 §L1）。
  await withServer(behaviors.ok(), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 1 });
    await probeJsonSchemaMode(p);
    const sent = s.requests[0].body.max_tokens as number;
    assert.ok(
      typeof sent === 'number' && sent >= 256,
      `探测请求的 max_tokens=${sent}，对推理型模型太小 —— 会把预算耗在推理上导致空输出。` +
        `探测的预算不足会被误读成被测对象能力不足。`,
    );
  });
});

test('Provider：空输出且 finish_reason=length 时，parseError 必须点明 token 预算而不是「JSON 解析失败」', async () => {
  await withServer(behaviors.emptyBecauseLength(), async (s) => {
    const p = providerFor(s);
    const res = await p.complete({
      role: 'pm',
      purpose: 't',
      messages: [{ role: 'user', content: 'x' }],
      schema: SAMPLE_SCHEMA,
      schemaName: 'Sample',
    });
    assert.equal(res.json, undefined);
    assert.ok(res.parseError, '空输出必须留下痕迹，不能静默返回空串');
    assert.ok(res.parseError!.includes('max_tokens'), res.parseError);
    assert.ok(res.parseError!.includes('推理'), res.parseError);
    // 关键：不能把真实原因说成「JSON 解析失败」，那会把排查方向带偏
    assert.equal(res.parseError!.includes('无法解析为 JSON'), false, res.parseError);
  });
});

test('Provider：输出被截断时，parseError 说明是被 max_tokens 截断', async () => {
  await withServer(behaviors.truncatedJson(), async (s) => {
    const p = providerFor(s);
    const res = await p.complete({
      role: 'pm',
      purpose: 't',
      messages: [{ role: 'user', content: 'x' }],
      schema: SAMPLE_SCHEMA,
      schemaName: 'Sample',
    });
    assert.ok(res.parseError?.includes('截断'), res.parseError);
    assert.ok(res.parseError?.includes('maxTokens'), res.parseError);
  });
});

test('Provider：即使调用方没要结构化输出，空响应也必须留下 parseError（不能静默返回空串）', async () => {
  await withServer(behaviors.emptyBecauseLength(), async (s) => {
    const p = providerFor(s);
    const res = await p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.text, '');
    assert.ok(res.parseError, '不传 schema 的调用最容易静默吞掉空响应');
  });
});

test('探测：连 response_format 都不支持 → 降级到 prompt-only', async () => {
  await withServer(behaviors.rejectAllStructured(), async (s) => {
    const p = providerFor(s, { jsonMode: 'auto', maxRetries: 3 });
    const out = await probeJsonSchemaMode(p);
    assert.equal(out.jsonSchema, 'prompt-only');
    assert.equal(p.jsonMode, 'prompt-only');
    assert.equal(out.reachable, true, '端点是通的，只是不支持结构化输出 —— 这两件事必须区分');
    assert.ok(out.evidence.some((e) => e.includes('prompt-only')));

    await p.complete({ role: 'pm', purpose: 'real', messages: [{ role: 'user', content: 'x' }], schema: SAMPLE_SCHEMA });
    assert.equal(s.lastBody.response_format, undefined);
  });
});

test('探测：端点不可达 → reachable=false，且与「不支持某功能」区分开', async () => {
  // 指向一个没有监听的端口
  const p = new OpenAiCompatProvider({
    name: 'dead',
    baseUrl: 'http://127.0.0.1:9/v1',
    defaultModel: 'm',
    jsonMode: 'auto',
    timeoutMs: 800,
    maxRetries: 1,
  });
  const out = await probeJsonSchemaMode(p);
  assert.equal(out.reachable, false);
  assert.equal(out.fatal?.kind, 'unreachable');
  assert.ok(out.evidence.some((e) => e.includes('致命问题')), JSON.stringify(out.evidence));
  assert.equal(isUnreachable(out.fatal?.message ?? ''), true);
});

test('探测：缓存命中时不发请求，且结果一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-cap-'));
  try {
    await withServer(behaviors.ok(), async (s) => {
      const cache = new FileCapabilityCache(dir);
      const p1 = providerFor(s, { jsonMode: 'auto' });
      const first = await probeJsonSchemaMode(p1, { cache });
      const callsAfterFirst = s.callCount;
      assert.ok(callsAfterFirst > 0);

      const p2 = providerFor(s, { jsonMode: 'auto' });
      const second = await probeJsonSchemaMode(p2, { cache });
      assert.equal(second.live, false, '缓存命中不该再发请求');
      assert.equal(s.callCount, callsAfterFirst, '请求数不应增加');
      assert.equal(second.jsonSchema, first.jsonSchema);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('探测：「无结论」与「致命」的结果**不得**写进缓存（否则「稍后重试」永远不发生）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-cap-'));
  try {
    const cache = new FileCapabilityCache(dir);

    // ① 无结论：证据里写着「请稍后重试」，缓存却会让「稍后」永远不来
    await withServer(behaviors.rateLimitThenOk(999), async (s) => {
      const out = await probeJsonSchemaMode(providerFor(s, { jsonMode: 'auto', maxRetries: 1 }), { cache });
      assert.equal(out.conclusive, false);
      // 用这个 server 的真实 baseUrl 去查，否则查的是一个永远不存在的 key，断言等于没写
      const hit = await cache.get(probeCacheKey('fake', s.baseUrl, 'fake-model'));
      assert.equal(hit, null, '无结论不得入缓存');
    });

    // ② 致命：一次网络抖动不该让这个 (provider, model) 永远被判不可用
    const dead = new OpenAiCompatProvider({
      name: 'dead',
      baseUrl: 'http://127.0.0.1:9/v1',
      defaultModel: 'm',
      jsonMode: 'auto',
      timeoutMs: 500,
      maxRetries: 1,
    });
    const deadOut = await probeJsonSchemaMode(dead, { cache });
    assert.equal(deadOut.fatal?.kind, 'unreachable');
    assert.equal(
      await cache.get(probeCacheKey('dead', 'http://127.0.0.1:9/v1', 'm')),
      null,
      '致命结果不得入缓存 —— 否则用户除了手删 capabilities.json 没有出路',
    );

    // ③ 正常有结论的结果照常缓存（不要矫枉过正把缓存整个废掉）
    await withServer(behaviors.ok(), async (s) => {
      const out = await probeJsonSchemaMode(providerFor(s, { jsonMode: 'auto' }), { cache });
      assert.equal(out.conclusive, true);
      assert.equal(out.fatal, undefined);
      // 端口是随机分配的，直接查这个 provider 自己的 key
      const hit = await cache.get(probeCacheKey('fake', s.baseUrl, 'fake-model'));
      assert.ok(hit, '有结论且可用的结果必须被缓存（否则每次都白探一遍）');
      assert.equal(hit!.jsonSchema, 'strict');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MockProvider(requireSchema)：不传 schema 的调用必须抛错 —— 让 Mock 也遵守真实 provider 的契约', async () => {
  // 为什么需要这个开关（docs/07 §L4）：
  // MockProvider 默认不看 schema、直接返回脚本值，于是「编排器忘了传 schema」
  // 在 Mock 下完全不可见 —— 而真实 provider 在 `!req.schema` 时直接返回裸文本
  // （json 为 undefined），调用方拿到空对象，整条路径静默失效。
  const p = new MockProvider({ script: { t: { claim: 'x' } }, requireSchema: true });
  await assert.rejects(
    () => p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] }),
    (e: Error) => e.message.includes('没有传 schema'),
  );
  // 传了 schema 就能正常走
  const ok = await p.complete({
    role: 'pm',
    purpose: 't',
    messages: [{ role: 'user', content: 'x' }],
    schema: SAMPLE_SCHEMA,
    schemaName: 'Sample',
  });
  assert.deepEqual(ok.json, { claim: 'x' });

  // 默认关闭：既有用法不受影响
  const lax = new MockProvider({ script: { t: { claim: 'x' } } });
  const r = await lax.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(r.json, { claim: 'x' });
});

test('录制：必须记录「这次调用有没有声明结构化输出契约」（事后归因的关键证据）', async () => {
  // 真实 LLM 实测的教训（docs/07 §L4）：圆桌的 LLM 调用忘了传 schema，
  // 于是 `json` 恒为 undefined、每条发言都被丢弃、决议恒为 null。
  // 排查时第一个要问的就是「这次调用到底有没有声明 schema」——
  // 而当年的记录里**没有这个字段**，只能靠读代码猜。
  // 记录存在的意义恰恰是事后归因，所以它必须能回答这个问题。
  const dir = await mkdtemp(join(tmpdir(), 'af-rec-'));
  try {
    const rec = new JsonlRunRecorder(dir, 'r1');
    const fakeResponse = {
      provider: 'mock',
      model: 'm',
      text: '{"ok":true}',
      json: { ok: true },
      latencyMs: 5,
      runId: 'x#1',
    };

    // ① 忘了传 schema 的调用
    await rec.record({
      request: { role: 'pm', purpose: 'no-schema', messages: [{ role: 'user', content: 'x' }] },
      response: fakeResponse,
    });
    // ② 正常声明了结构化契约的调用
    await rec.record({
      request: {
        role: 'pm',
        purpose: 'with-schema',
        messages: [{ role: 'user', content: 'x' }],
        schema: SAMPLE_SCHEMA,
        schemaName: 'Sample',
      },
      response: fakeResponse,
    });

    const lines = (await readFile(rec.path, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines[0].structured, false, '没传 schema 必须被明确记为 structured: false');
    assert.equal(lines[0].schemaName, undefined, '没有 schemaName 就不能凭空造一个');
    assert.equal(lines[1].structured, true);
    assert.equal(lines[1].schemaName, 'Sample');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('【关键】缓存命中时也必须把探测结论写回 Provider（否则重跑同一工作区会 400）', async () => {
  // 真实 LLM 实测发现的严重缺陷（docs/07 §L13）。
  //
  // 写回原本只发生在 finish() 里 —— 也就是**真的探测过**的那条路径。
  // 缓存命中那条 early return 漏了写回，于是 provider 停在配置里的 `auto`，
  // 而 auto 在 OpenAiCompatProvider 里解析成 `strict`。
  //
  // 为什么 11 轮真实运行都没碰到：每次都开新工作区 ⇒ 缓存是冷的 ⇒ 真探测 ⇒ 写回正确。
  // 但「用户有一个项目、反复对它跑」这个**最常规的用法**会直接崩：
  // 缓存命中 → 停在 strict → 端点若不支持严格模式，每一次结构化调用都 400。
  const dir = await mkdtemp(join(tmpdir(), 'af-capwb-'));
  try {
    const cache = new FileCapabilityCache(dir);
    await cache.set(probeCacheKey('fake', 'http://127.0.0.1:1/v1', 'fake-model'), {
      provider: 'fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'fake-model',
      jsonSchema: 'json-mode',
      reachable: true,
      conclusive: true,
      evidence: ['（来自上次运行的缓存）'],
      strictNeedsSanitize: false,
      live: true,
      probedAt: new Date().toISOString(),
    });

    const p = new OpenAiCompatProvider({
      name: 'fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'k',
      defaultModel: 'fake-model',
      jsonMode: 'auto', // 配置里是 auto
      maxRetries: 1,
    });
    assert.equal(p.jsonMode, 'auto', '前置条件：provider 初始是 auto');

    const out = await probeJsonSchemaMode(p, { cache });

    assert.equal(out.live, false, '应当命中缓存、不发请求');
    assert.equal(out.jsonSchema, 'json-mode');
    assert.equal(
      p.jsonMode,
      'json-mode',
      '缓存命中也必须写回 —— 否则 provider 停在 auto（= strict），重跑同一工作区的每次调用都会 400',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缓存命中的写入不得把「不可用」的结论应用到 Provider 上', async () => {
  // 只写回「可用且非致命」的结论。把坏结论应用到 provider 上会让后续调用
  // 带着错误的模式继续跑；真正该做的是让 buildLlm 抛 LlmSetupError。
  const dir = await mkdtemp(join(tmpdir(), 'af-capwb2-'));
  try {
    const cache = new FileCapabilityCache(dir);
    await cache.set(probeCacheKey('fake', 'http://127.0.0.1:1/v1', 'fake-model'), {
      provider: 'fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'fake-model',
      jsonSchema: 'strict',
      reachable: false,
      conclusive: true,
      evidence: ['上次探测：端点不可达'],
      strictNeedsSanitize: false,
      fatal: { kind: 'unreachable', message: '上次探测：端点不可达' },
      live: true,
      probedAt: new Date().toISOString(),
    });

    const p = new OpenAiCompatProvider({
      name: 'fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'k',
      defaultModel: 'fake-model',
      jsonMode: 'json-mode',
      maxRetries: 1,
    });
    await probeJsonSchemaMode(p, { cache });
    assert.equal(p.jsonMode, 'json-mode', '致命结论不得写回，应保持原配置');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 预算
// ════════════════════════════════════════════════════════════════

test('预算：warn 策略只警告一次并继续，snapshot 的账目自洽', async () => {
  const tracker = new BudgetTracker({ totalTokens: 100, onExceed: 'warn' });
  const notices: string[] = [];
  await withServer(behaviors.ok(), async (s) => {
    const p = new BudgetedProvider({
      inner: providerFor(s),
      tracker,
      role: 'pm',
      pricing: { input: 1, output: 2 },
      onExceeded: (r) => notices.push(r),
    });
    for (let i = 0; i < 3; i++) {
      await p.complete({ role: 'pm', purpose: 't', messages: [{ role: 'user', content: 'x' }] });
    }
  });
  const snap = tracker.snapshot();
  assert.equal(snap.totalPromptTokens, 360, '120 × 3');
  assert.equal(snap.totalCompletionTokens, 120, '40 × 3');
  assert.equal(snap.totalTokens, 480);
  // 120/1e6*1 + 40/1e6*2 = 0.00012 + 0.00008 = 0.0002 每次
  assert.ok(Math.abs(snap.totalUsd - 0.0006) < 1e-9, `实际 ${snap.totalUsd}`);
  assert.equal(notices.length, 1, 'warn 模式只警告一次');
  assert.equal(snap.exceeded, true);
});

test('预算：stop 策略在超限后抛 BudgetExceededError（让编排器走逃生层）', async () => {
  const tracker = new BudgetTracker({ totalTokens: 100, onExceed: 'stop' });
  await withServer(behaviors.ok(), async (s) => {
    const p = new BudgetedProvider({ inner: providerFor(s), tracker, role: 'backend' });
    await p.complete({ role: 'backend', purpose: 'a', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(s.callCount, 1);
    await assert.rejects(
      () => p.complete({ role: 'backend', purpose: 'b', messages: [{ role: 'user', content: 'x' }] }),
      (e: Error) => e instanceof BudgetExceededError,
    );
    assert.equal(s.callCount, 1, '超限后不得再发请求');
  });
});

test('预算：按角色独立限额', async () => {
  const tracker = new BudgetTracker({
    perRoleTokens: { backend: 100 } as never,
    onExceed: 'stop',
  });
  await withServer(behaviors.ok(), async (s) => {
    const backend = new BudgetedProvider({ inner: providerFor(s), tracker, role: 'backend' });
    const frontend = new BudgetedProvider({ inner: providerFor(s), tracker, role: 'frontend' });
    await backend.complete({ role: 'backend', purpose: 't', messages: [{ role: 'user', content: 'x' }] });
    await assert.rejects(() => backend.complete({ role: 'backend', purpose: 't2', messages: [{ role: 'user', content: 'x' }] }));
    // 别的角色不受影响
    await frontend.complete({ role: 'frontend', purpose: 't3', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(s.callCount, 2);
  });
});

// ════════════════════════════════════════════════════════════════
// 录制与回放
// ════════════════════════════════════════════════════════════════

test('录制与回放：同一 run 可零成本确定性重跑', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-replay-'));
  try {
    const recorder = new JsonlRunRecorder(dir, 'run-test');
    const schema = SAMPLE_SCHEMA;
    const reqs = [
      { role: 'pm' as const, purpose: 'p1', messages: [{ role: 'user' as const, content: '第一问' }], schema },
      { role: 'host' as const, purpose: 'p2', messages: [{ role: 'user' as const, content: '第二问' }], schema },
    ];

    // 1) 录制
    await withServer(behaviors.ok(), async (s) => {
      const p = new RecordingProvider({ inner: providerFor(s), recorder });
      for (const r of reqs) await p.complete(r);
      assert.equal(s.callCount, 2);
    });

    const records = await loadRunRecords(dir, 'run-test');
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.promptHash.length === 64));

    // 2) 回放：不再需要任何服务器
    const replay = new ReplayProvider({ records });
    for (const r of reqs) {
      const res = await replay.complete(r);
      assert.deepEqual(res.json, { ok: true, note: 'probe', tag: 'x' });
      assert.equal(res.latencyMs, 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回放：遇到未录制的分支时报错而不是静默补一次真实调用', async () => {
  const replay = new ReplayProvider({ records: [] });
  await assert.rejects(
    () => replay.complete({ role: 'pm', purpose: 'never-recorded', messages: [{ role: 'user', content: 'x' }] }),
    (e: Error) => e instanceof ReplayMissError && e.message.includes('回放缺少对应的调用记录'),
  );
});

test('回放：同一 prompt 被合法调用多次时按 FIFO 依次取用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-fifo-'));
  try {
    const recorder = new JsonlRunRecorder(dir, 'r');
    const req = { role: 'pm' as const, purpose: 'same', messages: [{ role: 'user' as const, content: '同样的提示' }] };

    let n = 0;
    await withServer(() => ({ body: { ...(defaultChatResponse({}) as object), choices: [{ message: { content: JSON.stringify({ n: ++n }) } }] } }), async (s) => {
      const p = new RecordingProvider({ inner: providerFor(s), recorder });
      await p.complete(req);
      await p.complete(req);
    });

    const records = await loadRunRecords(dir, 'r');
    const replay = new ReplayProvider({ records });
    const a = await replay.complete(req);
    const b = await replay.complete(req);
    // 这两个请求没带 schema，所以 Provider 不会去解析 JSON（解析是 schema 驱动的按需行为），
    // 因此断言在 text 上 —— 要验证的是 FIFO 顺序，不是解析。
    assert.equal(JSON.parse(a.text).n, 1);
    assert.equal(JSON.parse(b.text).n, 2, '同一个键要按录制顺序依次取出，不能都拿到第一条');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('录制：失败的调用也会留痕（「有没有走到模型」本身是重要证据）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-fail-'));
  try {
    const recorder = new JsonlRunRecorder(dir, 'rf');
    await withServer(behaviors.unauthorized(), async (s) => {
      const p = new RecordingProvider({ inner: providerFor(s, { maxRetries: 1 }), recorder });
      await assert.rejects(() => p.complete({ role: 'pm', purpose: 'boom', messages: [{ role: 'user', content: 'x' }] }));
    });
    const records = await loadRunRecords(dir, 'rf');
    assert.equal(records.length, 1);
    assert.equal(records[0].provider, '(failed)');
    assert.ok(records[0].response.parseError?.includes('401'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 配置层
// ════════════════════════════════════════════════════════════════

test('配置：合法配置被解析，缺省角色绑定回落到 defaultProvider', () => {
  const cfg = parseConfig({
    version: 1,
    defaultProvider: 'a',
    providers: { a: { kind: 'openai-compat', baseUrl: 'http://x/v1', defaultModel: 'm' } },
    roles: { host: { provider: 'a', model: 'strong', temperature: 0.1 } },
  });
  assert.equal(cfg.roles.host?.model, 'strong');
  assert.equal(cfg.roles.pm?.provider, 'a', '未显式绑定的角色回落到 defaultProvider');
  assert.equal(cfg.roles.test?.provider, 'a');
});

test('配置：错误被一次性列清楚（而不是抛第一个就停）', () => {
  try {
    parseConfig({
      version: 2,
      providers: {
        a: { kind: 'bogus', baseUrl: 'x', defaultModel: 'm' },
        b: { kind: 'openai-compat', baseUrl: '', defaultModel: '' },
      },
      roles: { pm: { provider: 'nope' }, notarole: { provider: 'b' } },
      budget: { onExceed: 'explode' },
    });
    assert.fail('应当抛 ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    const p = (e as ConfigError).problems;
    assert.ok(p.some((x) => x.includes('version')));
    assert.ok(p.some((x) => x.includes('kind')));
    assert.ok(p.some((x) => x.includes('baseUrl')));
    assert.ok(p.some((x) => x.includes('defaultModel')));
    assert.ok(p.some((x) => x.includes('pm.provider')));
    assert.ok(p.some((x) => x.includes('notarole')));
    assert.ok(p.some((x) => x.includes('onExceed')));
    assert.ok(p.length >= 7, `应列出全部问题，实际 ${p.length} 条`);
  }
});

test('配置：apiKey 支持 ${ENV_VAR}，缺失时明确报错而不是静默留空', () => {
  const problems: string[] = [];
  process.env.AF_TEST_KEY = 'secret-123';
  try {
    assert.equal(expandEnv('${AF_TEST_KEY}', problems, 'k'), 'secret-123');
    assert.equal(expandEnv('Bearer ${AF_TEST_KEY}', problems, 'k'), 'Bearer secret-123');
    // ⚠️ 这里刻意**不用** `assert.deepEqual(problems, [])`。
    //
    // `assert.deepEqual` 在 @types/node 里是一个**断言函数**：它会把第一个参数
    // 的类型收窄成第二个参数的类型，于是 `problems` 被收窄成空元组 `[]`，
    // 之后 `problems[0]` 的类型就变成 `never`（TS2339）、`problems.length === 1` 也不可能成立。
    //
    // 表达式全对，被收窄的是**变量** —— 断言库与类型检查互相作用的陷阱。
    // 这个文件此前没有任何类型检查，所以从来没人发现。
    assert.equal(problems.length, 0, `不该有问题，实际：${JSON.stringify(problems)}`);

    expandEnv('${AF_TEST_DOES_NOT_EXIST}', problems, 'providers.a.apiKey');
    assert.equal(problems.length, 1, `应报出一个未定义变量问题，实际：${JSON.stringify(problems)}`);
    assert.ok(problems[0]!.includes('AF_TEST_DOES_NOT_EXIST'), problems[0]);
  } finally {
    delete process.env.AF_TEST_KEY;
  }
});

test('配置：带 UTF-8 BOM 的配置文件必须能读（Windows 上极常见）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-bom-'));
  try {
    const body = JSON.stringify({
      version: 1,
      providers: { p: { kind: 'openai-compat', baseUrl: 'http://x/v1', defaultModel: 'm' } },
      roles: { pm: { provider: 'p' } },
    });
    // 模拟 PowerShell 的 `Set-Content -Encoding utf8` / 记事本产物
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'agentforge.config.json'), '\uFEFF' + body, 'utf8');

    const cfg = await loadConfigFile(join(dir, 'agentforge.config.json'));
    assert.equal(cfg.roles.pm?.provider, 'p');

    // 没有 BOM 的也必须正常
    await writeFile(join(dir, 'plain.json'), body, 'utf8');
    const cfg2 = await loadConfigFile(join(dir, 'plain.json'));
    assert.equal(cfg2.roles.pm?.provider, 'p');

    assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
    assert.equal(stripBom('{"a":1}'), '{"a":1}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置：模板可直接解析且五个角色都有绑定', () => {
  process.env.DEEPSEEK_API_KEY = 'k';
  try {
    const cfg = parseConfig(templateConfig());
    for (const role of ['pm', 'frontend', 'backend', 'test', 'host'] as const) {
      assert.ok(cfg.roles[role], `角色 ${role} 应有绑定`);
      assert.ok(cfg.providers[cfg.roles[role]!.provider], `角色 ${role} 的 provider 必须存在`);
    }
    assert.equal(cfg.roles.host?.model, 'deepseek-reasoner', '审查类角色默认用推理模型');
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test('buildLlm：五角色可用不同 provider，且探测结论写回；不可达时给出警告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-build-'));
  try {
    await withServer(behaviors.rejectStrict(), async (s) => {
      const cfg: ForgeConfig = parseConfig({
        version: 1,
        providers: {
          good: { kind: 'openai-compat', baseUrl: s.baseUrl, defaultModel: 'm1', jsonMode: 'auto' },
          dead: { kind: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'm2', jsonMode: 'auto', timeoutMs: 500, maxRetries: 1 },
        },
        roles: {
          host: { provider: 'good', model: 'm1' },
          pm: { provider: 'good' },
          frontend: { provider: 'good' },
          backend: { provider: 'dead' },
          test: { provider: 'good' },
        },
        probe: { enabled: true, useCache: false },
      });

      const built = await buildLlm(cfg, { root: dir, probe: true, record: false });
      assert.equal(built.roleModels.host, 'm1');
      assert.equal(built.roleProviders.host.name, 'good');
      assert.equal(built.roleProviders.backend.name, 'dead');

      const goodProbe = built.probes.find((p) => p.provider === 'good');
      assert.equal(goodProbe?.jsonSchema, 'json-mode', '端点拒绝严格模式，应已探测到');
      assert.ok(goodProbe?.evidence.some((e) => e.includes('严格模式探测失败（capability）')), JSON.stringify(goodProbe?.evidence));

      const deadProbe = built.probes.find((p) => p.provider === 'dead');
      assert.equal(deadProbe?.reachable, false);
      assert.equal(deadProbe?.fatal?.kind, 'unreachable');
      assert.ok(
        built.warnings.some((w) => w.includes('dead') && w.includes('unreachable')),
        `应明确告诉用户是哪个 provider 出了什么问题，实际：${JSON.stringify(built.warnings)}`,
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildLlm：提供 runId 时自动录制，runs/ 下生成可回放的 jsonl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-rec-'));
  try {
    await withServer(behaviors.ok(), async (s) => {
      const cfg = parseConfig({
        version: 1,
        providers: { p: { kind: 'openai-compat', baseUrl: s.baseUrl, defaultModel: 'm', jsonMode: 'strict' } },
        roles: { pm: { provider: 'p' } },
        probe: { enabled: false },
        runsDir: join(dir, 'runs'),
      });
      const built = await buildLlm(cfg, { root: dir, runId: 'run-abc' });
      assert.ok(built.recorder, '有 runId 就该录制');
      await built.roleProviders.pm.complete({
        role: 'pm',
        purpose: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        schema: SAMPLE_SCHEMA,
      });
      const text = await readFile(join(dir, 'runs', 'run-abc.jsonl'), 'utf8');
      const rec = JSON.parse(text.trim());
      assert.equal(rec.purpose, 'x');
      assert.equal(rec.role, 'pm');
      assert.equal(rec.runId, 'run-abc');

      // 真的能回放
      const records = await loadRunRecords(join(dir, 'runs'), 'run-abc');
      assert.equal(records.length, 1);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildLlm：关闭探测时明确警告「假定支持严格输出」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-noprobe-'));
  try {
    const cfg = parseConfig({
      version: 1,
      providers: { p: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: 'qwen' } },
      roles: { pm: { provider: 'p' } },
      probe: { enabled: false },
    });
    const built = await buildLlm(cfg, { root: dir, probe: false });
    assert.equal(built.probes.length, 0);
    assert.ok(built.warnings.some((w) => w.includes('能力探测已关闭')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
