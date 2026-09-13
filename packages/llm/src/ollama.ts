/**
 * Ollama 原生 Provider（本地模型）。
 *
 * 为什么单独写而不复用 OpenAI 兼容层：Ollama 的原生 `/api/chat` 有自己的
 * `format` 字段（直接接受 JSON Schema）、自己的 usage 字段名、以及
 * `options` 嵌套参数。走 OpenAI 兼容端点会丢掉 `format` 的强约束能力，
 * 而本地模型恰恰最需要它（小模型的自由文本格式遵从度差）。
 *
 * 本地模型是这个项目的「零成本反复实验」通道：锚点、裁判、圆桌这些机制
 * 需要跑很多遍才能调参，用云端 API 跑一遍几十次调用会很贵。
 */

import { randomUUID } from 'node:crypto';
import type { JsonSchema } from '../../core/src/schemas.ts';
import type { LlmCapabilities, LlmProvider, LlmRequest, LlmResponse } from './types.ts';
import { extractJson, postJson, type FetchLike } from './http.ts';

export type OllamaConfig = {
  name: string;
  /** 默认 http://127.0.0.1:11434 */
  baseUrl: string;
  defaultModel: string;
  /** 可选的 API key（Ollama 云端或反代网关会需要）。 */
  apiKey?: string;
  /** 是否使用原生 format 字段传 JSON Schema。旧版 Ollama 不支持时置 false。 */
  nativeJsonSchema?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
};

type OllamaChatResponse = {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

export class OllamaProvider implements LlmProvider {
  readonly name: string;
  readonly config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.name = config.name;
    this.config = config;
  }

  async capabilities(): Promise<LlmCapabilities> {
    return {
      jsonSchema: this.config.nativeJsonSchema === false ? 'prompt-only' : 'strict',
      toolCalling: false,
      streaming: true,
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const model = req.model ?? this.config.defaultModel;
    const useNative = this.config.nativeJsonSchema !== false;

    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: {} as Record<string, unknown>,
    };
    const options = body.options as Record<string, unknown>;
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;

    if (req.schema) {
      if (useNative) {
        // 原生 format 直接吃 JSON Schema —— 比提示词约束强得多
        body.format = req.schema as JsonSchema;
      } else {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const hint = `\n\n【输出格式】只输出符合以下 JSON Schema 的单个 JSON 对象：\n${JSON.stringify(req.schema)}`;
        if (lastUser) lastUser.content += hint;
        else messages.push({ role: 'user', content: hint });
      }
    }

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/api/chat`;
    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    const result = await postJson(url, body, headers, {
      timeoutMs: this.config.timeoutMs ?? 300_000, // 本地模型冷启动可能很慢
      maxRetries: this.config.maxRetries ?? 2,
      ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
    });
    if (!result.ok) throw result.error;

    const payload = result.json as OllamaChatResponse;
    if (payload.error) throw new Error(`Ollama 返回错误：${payload.error}`);

    const content = payload.message?.content ?? '';
    const base: Omit<LlmResponse, 'json' | 'parseError'> = {
      provider: this.name,
      model: payload.model ?? model,
      text: content,
      usage: {
        promptTokens: payload.prompt_eval_count ?? 0,
        completionTokens: payload.eval_count ?? 0,
      },
      latencyMs: Date.now() - started,
      runId: `${this.name}-${randomUUID().slice(0, 8)}`,
      finishReason: payload.done ? 'stop' : 'incomplete',
    };

    if (!req.schema) return { ...base };

    const extracted = extractJson(content);
    if (!extracted) {
      return { ...base, parseError: `模型输出无法解析为 JSON（前 300 字符）：${content.slice(0, 300)}` };
    }
    return {
      ...base,
      json: extracted.value,
      ...(extracted.repaired ? { parseError: `JSON 经过修复：${extracted.note}` } : {}),
    };
  }
}
