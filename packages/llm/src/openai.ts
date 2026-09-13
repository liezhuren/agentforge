/**
 * OpenAI 兼容 Provider。
 *
 * 覆盖绝大多数实际可用的端点：OpenAI / DeepSeek / Moonshot / 通义 / 智谱 /
 * OpenRouter / vLLM / LM Studio / llama.cpp server……它们都实现了
 * `POST {baseUrl}/chat/completions`。
 *
 * 「给用户找他期望的 LLM 的权利」这条诉求在这里落地：
 * 用户只需要在 agentforge.config.json 里给每个角色填 {provider, model}，
 * 不需要改一行代码。不同厂商的差异（结构化输出强度、token 参数名、
 * 是否支持 reasoning_effort）被收敛成几个配置项。
 */

import { randomUUID } from 'node:crypto';
import type { JsonSchema } from '../../core/src/schemas.ts';
import type { JsonSchemaMode, LlmCapabilities, LlmProvider, LlmRequest, LlmResponse } from './types.ts';
import { extractJson, postJson, type FetchLike } from './http.ts';
import { toStrictJsonSchema } from './strictschema.ts';

export type TokenParamName = 'max_tokens' | 'max_completion_tokens';

export type OpenAiCompatConfig = {
  /** 用户可读的 provider 名（配置里的键）。 */
  name: string;
  /** 例如 https://api.deepseek.com/v1（末尾斜杠可有可无）。 */
  baseUrl: string;
  apiKey?: string;
  /** 该 provider 的默认模型；角色级绑定可覆盖。 */
  defaultModel: string;
  /**
   * 结构化输出的强制强度。
   * 'auto' 表示尚未探测，第一次请求会用 strict 试，失败后由 probe 写回真实能力。
   */
  jsonMode?: JsonSchemaMode | 'auto';
  /**
   * 发 strict 请求时是否先对 schema 做兼容转换。
   *
   * 这个开关必须存在，而且是踩过坑才加上的：能力探测会发现「严格模式可用，
   * 但我们的 schema 需要转换（可选字段→required+nullable、oneOf→anyOf）」，
   * 可是如果 Provider 在真正发请求时又把原始 schema 塞回去，
   * 端点在第一次真实调用时照样 400 —— 探测结论白搭。
   * 因此 probe 判定 needsSanitize 后必须**写回 Provider**。
   */
  strictSchema?: 'auto' | 'as-is' | 'sanitize';
  /** 部分新模型要求 max_completion_tokens。 */
  tokenParam?: TokenParamName;
  /** 该端点是否接受 reasoning_effort（推理型模型）。 */
  supportsReasoningEffort?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * 重试退避基础毫秒数（指数增长）。
   * 生产环境保持默认的 500ms；测试里设成 1 以免重试用例白等几秒。
   */
  backoffMs?: number;
  /** 额外请求头（例如某些网关需要的 X-Title）。 */
  headers?: Record<string, string>;
  /** 价格表（美元 / 百万 token），用于成本预算与报告。 */
  pricing?: { input: number; output: number };
  fetchImpl?: FetchLike;
  /** 重试观测（测试与日志用）。 */
  onRetry?: (info: { attempt: number; status?: number; error?: string; delayMs: number }) => void;
};

export type OpenAiChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
};

export class OpenAiCompatProvider implements LlmProvider {
  readonly name: string;
  readonly config: OpenAiCompatConfig;
  private resolvedJsonMode: JsonSchemaMode | 'auto';
  private resolvedStrictSchema: 'as-is' | 'sanitize';

  constructor(config: OpenAiCompatConfig) {
    this.name = config.name;
    this.config = config;
    this.resolvedJsonMode = config.jsonMode ?? 'auto';
    this.resolvedStrictSchema = config.strictSchema === 'sanitize' ? 'sanitize' : 'as-is';
  }

  /** 探测结果由 probe 写回，避免重复试错。 */
  setJsonMode(mode: JsonSchemaMode): void {
    this.resolvedJsonMode = mode;
  }

  /** 探测发现需要转换时由 probe 写回。见 strictSchema 字段的说明。 */
  setStrictSchemaMode(mode: 'as-is' | 'sanitize'): void {
    this.resolvedStrictSchema = mode;
  }

  get jsonMode(): JsonSchemaMode | 'auto' {
    return this.resolvedJsonMode;
  }

  get strictSchemaMode(): 'as-is' | 'sanitize' {
    return this.resolvedStrictSchema;
  }

  async capabilities(): Promise<LlmCapabilities> {
    return {
      jsonSchema: this.resolvedJsonMode === 'auto' ? 'strict' : this.resolvedJsonMode,
      toolCalling: true,
      streaming: true,
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const model = req.model ?? this.config.defaultModel;
    const mode: JsonSchemaMode = this.resolvedJsonMode === 'auto' ? 'strict' : this.resolvedJsonMode;

    const messages = [...req.messages];
    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    };

    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body[this.config.tokenParam ?? 'max_tokens'] = req.maxTokens;
    if (req.reasoningEffort && this.config.supportsReasoningEffort !== false) {
      body.reasoning_effort = req.reasoningEffort;
    }

    // ── 结构化输出：三种强度 ────────────────────────────────────
    if (req.schema) {
      if (mode === 'strict') {
        const schema = this.resolvedStrictSchema === 'sanitize' ? toStrictJsonSchema(req.schema).schema : req.schema;
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: req.schemaName ?? 'output', strict: true, schema },
        };
      } else if (mode === 'json-mode') {
        body.response_format = { type: 'json_object' };
        // json_object 模式不传 schema，因此必须把 schema 写进提示词
        appendSchemaHint(body, req.schema, req.schemaName);
      } else {
        appendSchemaHint(body, req.schema, req.schemaName);
      }
    }

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { ...(this.config.headers ?? {}) };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    const result = await postJson(url, body, headers, {
      timeoutMs: this.config.timeoutMs ?? 120_000,
      maxRetries: this.config.maxRetries ?? 3,
      ...(this.config.backoffMs !== undefined ? { backoffMs: this.config.backoffMs } : {}),
      ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
      ...(this.config.onRetry ? { onRetry: this.config.onRetry } : {}),
    });

    if (!result.ok) throw result.error;

    const payload = result.json as OpenAiChatResponse;

    // 有些网关把错误放在 200 响应体里
    if (payload.error) {
      throw new Error(`LLM 端点返回错误：${payload.error.message ?? JSON.stringify(payload.error)}`);
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? '';
    const latencyMs = Date.now() - started;

    const base: Omit<LlmResponse, 'json' | 'parseError'> = {
      provider: this.name,
      model: payload.model ?? model,
      text: content,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
      },
      latencyMs,
      runId: `${this.name}-${randomUUID().slice(0, 8)}`,
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };

    if (!req.schema) {
      // 即使调用方没要结构化输出，「空响应」也一定是坏的 —— 不能静默返回空串，
      // 否则下游只会看到「模型什么都没说」，而不知道是 token 预算被推理吃光了。
      const blank = explainBlankContent(content, choice?.finish_reason);
      return blank ? { ...base, parseError: blank } : { ...base };
    }

    // 需要结构化输出：解析（必要时修复）。修复的痕迹必须留在响应里 ——
    // 下游（与人类）有权知道「这条结论来自一段被修复过的文本」。
    const extracted = extractJson(content);
    if (!extracted) {
      // 措辞必须指向**真实原因**。第一版一律写「无法解析为 JSON」，
      // 结果推理型模型把预算烧光、输出为空时，报的是「JSON 解析失败」——
      // 排查方向被彻底带偏（真实端点实测发现，见 docs/07 §L1）。
      const why = explainBlankContent(content, choice?.finish_reason);
      return {
        ...base,
        parseError: why ?? `模型输出无法解析为 JSON（前 300 字符）：${content.slice(0, 300)}`,
      };
    }
    return {
      ...base,
      json: extracted.value,
      ...(extracted.repaired ? { parseError: `JSON 经过修复：${extracted.note}` } : {}),
    };
  }
}

/**
 * 解释「输出为空 / 被截断」的真实原因。返回 null 表示内容非空且未被截断。
 *
 * 为什么值得单独一个函数：这两种情况的原因与「格式遵从度」完全不同，
 * 而修法也完全不同 —— 前者要加 maxTokens 或换模型，后者要改提示词或换模型。
 * 把它们都报成「JSON 解析失败」，等于让用户去修一个不存在的问题。
 *
 * 真实端点实测（docs/07 §L1）：推理型模型（deepseek-flash）会先把
 * `max_tokens` 花在不可见的推理 token 上。cap 设 64 时实测 5 次里 3 次
 * `finish_reason=length` + `completion_tokens=64` + 可见文本长度 0。
 */
function explainBlankContent(content: string, finishReason: string | undefined): string | null {
  const blank = content.trim().length === 0;
  if (blank && finishReason === 'length') {
    return (
      '模型输出为空，且 finish_reason=length —— token 预算已耗尽但没产出任何可见内容。' +
      '典型原因是 max_tokens 太小，而**推理型模型会先把预算花在不可见的推理 token 上**。' +
      '请提高 maxTokens，或改用非推理模型。'
    );
  }
  if (blank) {
    return `模型返回了空内容（finish_reason=${finishReason ?? '未提供'}）—— 端点请求成功，但没有任何输出。`;
  }
  if (finishReason === 'length') {
    return (
      `模型输出被 max_tokens 截断（已产出 ${content.length} 字符），JSON 不完整因而无法解析。` +
      '请提高 maxTokens。'
    );
  }
  return null;
}

/**
 * prompt-only 模式下把 schema 追加进最后一条 user 消息。
 *
 * 直接把 JSON Schema 原样贴进去比用自然语言描述字段更可靠 ——
 * 模型见过大量 JSON Schema，对 `required` / `enum` / `additionalProperties`
 * 的语义有稳定的先验。
 */
function appendSchemaHint(body: Record<string, unknown>, schema: JsonSchema, schemaName?: string): void {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const hint = [
    '',
    '【输出格式要求】',
    `你必须只输出一个 JSON 对象${schemaName ? `（${schemaName}）` : ''}，不要任何解释文字或 Markdown 代码围栏。`,
    '它必须符合以下 JSON Schema：',
    JSON.stringify(schema, null, 2),
  ].join('\n');

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser) lastUser.content += hint;
  else messages.push({ role: 'user', content: hint });
}
