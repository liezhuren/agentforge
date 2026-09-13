/**
 * 诊断：探测为什么时好时坏。
 *
 * 复现 `probeJsonSchemaMode` 里那一次 json-mode 探测请求，原样打印
 * 模型的**完整输出**、finishReason、token 用量与解析结果。
 *
 * 目的是把「探测失败」的原因钉死到具体机制上（截断？夹带说明文字？空响应？），
 * 而不是猜。运行：$env:DEEPSEEK_API_KEY="..."; node scripts/diag-probe.ts [次数]
 */

import { OpenAiCompatProvider } from '../packages/llm/src/openai.ts';
import { toStrictJsonSchema } from '../packages/llm/src/strictschema.ts';
import { extractJson } from '../packages/llm/src/http.ts';

const N = Number(process.argv[2] ?? 5);

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}

// 与 probe.ts 里 PROBE_SCHEMA 等价的形状（这里只要能触发同一条路径）
const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'note', 'tag'],
  properties: { ok: { type: 'boolean' }, note: { type: 'string' }, tag: { type: 'string' } },
};

const sanitized = toStrictJsonSchema(PROBE_SCHEMA as never);

for (const [label, maxTokens, mode] of [
  ['json-mode / maxTokens=64（当前探测用的设置）', 64, 'json-mode'] as const,
  ['json-mode / maxTokens=256', 256, 'json-mode'] as const,
  ['prompt-only / maxTokens=64', 64, 'prompt-only'] as const,
]) {
  console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);
  for (let i = 1; i <= N; i++) {
    const p = new OpenAiCompatProvider({
      name: 'diag',
      baseUrl: 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY,
      defaultModel: 'deepseek-flash',
      jsonMode: mode,
      maxRetries: 1,
    });
    const res = await p.complete({
      role: 'system',
      purpose: 'diag',
      messages: [
        { role: 'system', content: '只输出 JSON，不要任何解释。' },
        { role: 'user', content: '返回 {"ok": true, "note": "probe", "tag": "x"}' },
      ],
      schema: mode === 'json-mode' ? (PROBE_SCHEMA as never) : (sanitized.schema as never),
      schemaName: 'Probe',
      temperature: 0,
      maxTokens,
    });

    const parsed = extractJson(res.text);
    console.log(
      `\n  #${i}  finishReason=${res.finishReason ?? '-'}  ` +
        `completion=${res.usage?.completionTokens}  文本长度=${res.text.length}  ` +
        `解析=${parsed ? '成功' : '失败'}${parsed?.repaired ? '（经修复）' : ''}`,
    );
    console.log(`      原始输出：${JSON.stringify(res.text)}`);
  }
}
