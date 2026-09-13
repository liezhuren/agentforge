/**
 * 一次性冒烟探测：确认真实 provider / 模型可用，并看清能力探测的结论。
 *
 * 不是常驻工具 —— 正式流程用 `cli-run.ts`（它自己做探测）。
 * 单独写一个的理由：探测很便宜（每个模型几次调用），而完整流水线很贵。
 * 先用最少的钱把「配置是否成立、模型是否真的听话」问清楚，
 * 否则第一次跑完整流水线时，配置错误会和模型行为问题混在一起，很难归因。
 *
 * 运行：$env:DEEPSEEK_API_KEY="..."; node scripts/smoke-llm.ts
 */

import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { loadConfigFile, buildLlm } from '../packages/llm/src/registry.ts';
import { requirementSetSchema } from '../packages/core/src/schemas.ts';
import { validateSchema, formatSchemaErrors } from '../packages/core/src/schema.ts';

const CONFIG = join(import.meta.dirname, '..', 'agentforge.config.json');

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY 环境变量');
  process.exit(1);
}

const workspace = await mkdtemp(join(tmpdir(), 'af-smoke-'));
console.log(`配置：${CONFIG}`);
console.log(`临时工作区：${workspace}\n`);

try {
  const config = await loadConfigFile(CONFIG);
  const built = await buildLlm(config, {
    root: workspace,
    runId: 'smoke',
    record: false,
    probe: true,
    onNotice: (msg, data) => console.log(`[llm] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`),
  });

  console.log('能力探测结论：');
  for (const p of built.probes) {
    const tag =
      p.jsonSchema === 'strict'
        ? 'strict（端点原生支持 json_schema）'
        : p.jsonSchema === 'json-mode'
          ? 'json-mode（降级：只保证是合法 JSON）'
          : 'prompt-only（再降级：全靠提示词）';
    console.log(
      `  ${p.provider}/${p.model}\n` +
        `      可达=${p.reachable}  模式=${tag}\n` +
        `      证据：${p.evidence.join(' / ') || '（无）'}`,
    );
  }
  for (const w of built.warnings) console.log(`  警告：${w}`);

  console.log('\n角色绑定：');
  for (const [role, model] of Object.entries(built.roleModels)) {
    console.log(`  ${role.padEnd(9)} → ${model}`);
  }

  // 一次真实的「结构化输出」调用：这才是流水线真正依赖的能力。
  // 能力探测只说明「端点接受这个参数」，不说明「模型真的会按 schema 输出」。
  //
  // 必须**传 schema**：OpenAiCompatProvider 在 `!req.schema` 时直接返回裸文本
  // （`json` 为 undefined），所以不传 schema 的调用根本没走到解析与修复那条路，
  // 测了等于没测。这里直接用流水线真正用的那份 schema。
  console.log('\n实际结构化调用测试（pm 角色，走真正的 schema 路径）：');
  const schema = requirementSetSchema as Record<string, unknown>;
  const started = Date.now();
  const res = await built.roleProviders.pm.complete({
    role: 'pm',
    purpose: 'smoke:structured',
    schemaName: 'RequirementSet',
    schema,
    messages: [
      { role: 'system', content: '你是需求分析师。只输出 JSON 对象，不要任何解释文字。' },
      {
        role: 'user',
        content: '把「做一个任务看板：能创建任务，也能列出全部任务」拆成需求，覆盖创建与列出两类能力。',
      },
    ],
    temperature: 0.2,
    maxTokens: 2048,
  });
  console.log(`  provider=${res.provider} model=${res.model} 耗时=${Date.now() - started}ms`);
  console.log(`  usage: prompt=${res.usage?.promptTokens} completion=${res.usage?.completionTokens}`);
  console.log(`  finishReason=${res.finishReason ?? '（未提供）'}`);
  console.log(`  文本长度=${res.text.length}`);
  console.log(`  parseError=${res.parseError ?? '（无）'}`);
  console.log(`  json ${res.json ? '已解析' : '为 null'}=${res.json ? JSON.stringify(res.json).slice(0, 700) : '（null）'}`);

  // 光「解析成功」不够 —— 流水线还会拿本地 schema 校验器复核一遍。
  // 两件事分开看：模型会不会输出 JSON，与输出是否符合 schema，是两种不同能力。
  if (res.json) {
    const errors = validateSchema(res.json, schema);
    console.log(`\n  本地 schema 校验：${errors.length === 0 ? '通过' : `不通过（${errors.length} 处）`}`);
    if (errors.length > 0) console.log(formatSchemaErrors(errors).split('\n').slice(0, 8).join('\n'));
  } else {
    const tail = res.text.slice(-200);
    console.log(`  原始文本结尾：…${tail}`);
  }
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
}
