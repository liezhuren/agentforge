/**
 * 语义验证器：为 B1 锚点产出「目标达成」提议。
 *
 * 关键设计：**它只产出提议，不产出判定。**
 * B1 锚点会逐条核验提议引用的证据是否真实存在（文件/行区间），
 * 核验失败的判定**整条作废**（INVALID_EVIDENCE），最终 verdict 由程序给出。
 *
 * 由「测试」角色承担这项验证，而不是主理人 —— 主理人的职责是对抗性找茬（B3），
 * 让同一个角色既做验收又做找茬会削弱两者的独立性。
 */

import type { JsonSchema } from '../../core/src/schemas.ts';
import { buildRepairHint, formatSchemaErrors, validateSchema } from '../../core/src/schemas.ts';
import type { Logger } from '../../core/src/logger.ts';
import { silentLogger } from '../../core/src/logger.ts';
import type { LlmProvider } from '../../llm/src/types.ts';
import type { RoleContext } from './types.ts';
import { READ_PERMISSIONS } from './types.ts';

/** 提议的输出 schema。注意 evidenceRefs 至少一条 —— 没证据的判定在 B1 处会作废。 */
export const requirementVerdictsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['requirementVerdicts'],
  properties: {
    requirementVerdicts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirementId', 'verdict', 'rationale', 'evidenceRefs'],
        properties: {
          requirementId: { type: 'string', minLength: 1 },
          verdict: { type: 'string', enum: ['met', 'not-met', 'uncertain'] },
          /*
           * rationale 刻意不设 minLength（只要求非空）。
           *
           * 第一版写了 minLength: 5，结果一条「也写了」（3 字）的简短理由就让整个
           * schema 校验失败 → 结构化重试耗尽 → 提议为 null → B1 判 SKIPPED。
           * 也就是说：**一个字数约束把一个次要瑕疵放大成了「整轮语义验证被跳过」**。
           *
           * 字数从来不是我们关心的东西 —— 真正的门槛是下面 evidenceRefs 的**证据核验**
           * （文件是否存在、行号是否越界、区间内容是否与声称相符）。
           * 用一个会误伤的代理指标去守一道已经有真机制把守的门，是纯粹的负收益。
           */
          rationale: { type: 'string', minLength: 1 },
          evidenceRefs: {
            type: 'array',
            minItems: 1,
            items: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'path', 'startLine', 'endLine'],
                  properties: {
                    kind: { const: 'file' },
                    path: { type: 'string', minLength: 1 },
                    startLine: { type: 'integer', minimum: 1 },
                    endLine: { type: 'integer', minimum: 1 },
                    expect: { type: 'string' },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'artifactId'],
                  properties: { kind: { const: 'artifact' }, artifactId: { type: 'string', minLength: 1 } },
                },
              ],
            },
          },
        },
      },
    },
  },
};

export type VerifyOutcome = {
  /** 与 anchors 的 SemanticProposals 结构一致（此处不引入跨包依赖，保持结构兼容即可）。 */
  proposals: { requirementVerdicts: Array<Record<string, unknown>> } | null;
  attempts: number;
  schemaError?: string;
  llm?: { provider: string; model: string; runId: string; latencyMs: number };
};

export type SemanticVerifierOptions = {
  provider: LlmProvider;
  maxAttempts?: number;
  temperature?: number;
  logger?: Logger;
  model?: string;
};

export class SemanticVerifier {
  private provider: LlmProvider;
  private maxAttempts: number;
  private temperature: number;
  private logger: Logger;
  private model?: string;

  constructor(opts: SemanticVerifierOptions) {
    this.provider = opts.provider;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.temperature = opts.temperature ?? 0.1;
    this.logger = opts.logger ?? silentLogger('verifier');
    this.model = opts.model;
  }

  async verify(ctx: RoleContext): Promise<VerifyOutcome> {
    const reqArt = ctx.store.head('Requirement');
    if (!reqArt) return { proposals: null, attempts: 0, schemaError: '尚无需求工件' };

    const reqs = (reqArt.content as { requirements: Array<Record<string, unknown>> }).requirements;

    // ── 只把「有权读」的工件渲染进上下文 ──────────────────────────
    //
    // 这里原本是一份**硬编码**的 kind 列表，而注释却写着「与 LlmRoleRunner
    // 同一套读权限纪律」—— 实际上它并没有跟随矩阵，两者已经漂移，
    // 而漂移的后果是实打实的（真实 LLM 实测，docs/07 §L12）：
    //
    // 列表里没有 TestReport，于是「测试到底跑没跑过、退出码多少、过了几条」
    // 这些**系统本来就有的事实**从未进入验证者的视野。而它的系统提示写着
    // 「只能引用你确实看到的工件；没看到就填 uncertain 并说明缺什么」——
    // 它就如实报了 45% 的 uncertain，理由每一轮都一样。
    //
    // 现在直接读矩阵：**声明与实现之间不再有第二份清单可以漂移**。
    const role = 'test' as const; // 语义验证器以 test 角色身份运行
    const blocks: string[] = [];
    for (const kind of READ_PERMISSIONS[role]) {
      for (const a of ctx.store.heads(kind)) {
        blocks.push(`--- ${a.id} (${a.kind}${a.scope ? `/${a.scope}` : ''}) ---\n${JSON.stringify(a.content, null, 2).slice(0, 8000)}`);
      }
    }

    const baseMessages = [
      {
        role: 'system' as const,
        content: [
          '你是 AgentForge 的【目标达成验证者】。',
          '你的任务是逐条判断需求是否真正被实现，并为每条判断提供**真实存在**的证据。',
          '',
          '铁律：',
          '1. 每条需求的 evidenceRefs 必须引用**真实存在的文件与真实的行号区间**。',
          '   系统会逐个核验：文件不存在、行号越界、行区间内容与你的声称不符 —— 只要一条不通过，',
          '   这条判定就**整条作废**，等同你没做判断。编造证据不会得分，只会让整条判定被丢弃。',
          '2. 只能引用你在上下文里**确实看到**的工件与代码。没看到就填 verdict="uncertain" 并说明缺少什么。',
          '3. 不要为了「看起来完成了」而判 met。判 not-met 或 uncertain 都不是失败，编造证据才是。',
          '4. 只输出 JSON 对象，不要任何解释文字或 Markdown 围栏。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: [
          `【用户的原始诉求】\n${ctx.userBrief}`,
          `【需要逐条判定的需求】\n${JSON.stringify(reqs, null, 2)}`,
          blocks.length > 0 ? `【可读工件与代码】\n${blocks.join('\n\n')}` : '【可读工件与代码】目前为空。',
          '【输出要求】对**每一条**需求给出判定，严格输出符合 schema 的单个 JSON 对象。',
        ].join('\n\n'),
      },
    ];

    let repairHint: string | undefined;
    let lastError = '';
    let lastLlm: VerifyOutcome['llm'];

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const res = await this.provider.complete({
        role: 'test',
        purpose: 'verify:requirements',
        messages: repairHint
          ? [...baseMessages, { role: 'assistant' as const, content: '(上一次输出未通过校验)' }, { role: 'user' as const, content: repairHint }]
          : baseMessages,
        schema: requirementVerdictsSchema,
        schemaName: 'RequirementVerdicts',
        temperature: this.temperature,
        attempt,
        ...(this.model ? { model: this.model } : {}),
      });
      lastLlm = { provider: res.provider, model: res.model, runId: res.runId, latencyMs: res.latencyMs };

      if (res.json === undefined) {
        lastError = res.parseError ?? '模型未返回可解析的 JSON';
        repairHint = `你上一次的输出不是合法 JSON（${lastError}）。请只输出 JSON 对象。`;
        continue;
      }

      const errors = validateSchema(res.json, requirementVerdictsSchema, requirementVerdictsSchema);
      if (errors.length === 0) {
        const parsed = res.json as { requirementVerdicts: Array<Record<string, unknown>> };
        return { proposals: parsed, attempts: attempt + 1, ...(lastLlm ? { llm: lastLlm } : {}) };
      }
      lastError = formatSchemaErrors(errors);
      repairHint = buildRepairHint(errors);
      this.logger.warn(`语义验证第 ${attempt + 1} 次未过 schema`, { errors: errors.length });
    }

    return { proposals: null, attempts: this.maxAttempts, schemaError: lastError, ...(lastLlm ? { llm: lastLlm } : {}) };
  }
}
