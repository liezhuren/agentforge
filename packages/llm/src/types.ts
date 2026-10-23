/**
 * LLM Provider 抽象。
 *
 * 用户诉求：「给用户找他期望的 LLM 的权利」。
 * 做法是让每个角色可以独立绑定 {provider, model, temperature, maxTokens, reasoningEffort}，
 * 并通过统一接口接入任何 OpenAI 兼容端点（OpenAI / DeepSeek / 通义 / Moonshot /
 * OpenRouter / vLLM / LM Studio）或本地 Ollama。
 *
 * P1 只实现 MockProvider：不联网、不花钱、可注入任意幻觉，
 * 用于把确定性编排内核（裁判/账本/锚点/圆桌）验证到位。
 * P2 再接真实 Provider —— 顺序是刻意的：先让编排可确定验证，再接不确定的模型。
 */

import type { RoleId } from '../../core/src/types.ts';
import type { JsonSchema } from '../../core/src/schemas.ts';

export type LlmRoleName = RoleId | 'system';

/** 结构化输出的强制强度。不同模型支持程度不同，必须探测后降级。 */
export type JsonSchemaMode = 'strict' | 'json-mode' | 'prompt-only';

export type LlmCapabilities = {
  jsonSchema: JsonSchemaMode;
  toolCalling: boolean;
  streaming: boolean;
  maxContextTokens?: number;
};

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

/**
 * **本次调用「模型到底看到了什么」。**
 *
 * 这个类型是第 21 轮（命题测试复算）逼出来的，不是设计出来的。
 *
 * 当时的现象：一次 run 跑了 75 分钟、30 次调用，输入**始终停在 ~10.6k token**，
 * 而项目从 0 行长到 4443 行。查了两小时才发现：24,000 字符的上下文池被
 * 「需求 + PRD + 任务图」三件散文吃掉了 95%，契约、所有代码模块、所有测试报告
 * 一件都没进去。于是后端在**看不到契约**的情况下写接口，在**看不到别人代码**的
 * 情况下写分发逻辑，在**看不到测试失败事实**的情况下修 bug。
 *
 * 而这一切在系统里**完全不可见**：录制只存了 `promptHash`，没有存「注入了什么、
 * 丢了什么」。归因于是全部落在「模型写得差」上，连跑 20 轮没人怀疑过输入。
 *
 * 所以：**输入完整性必须和输出质量一样被记录**。
 * 不记录它，任何「为什么它就是做不对」的分析都只能是猜。
 */
export type LlmContextReport = {
  /** 本次的字符预算。 */
  budget: number;
  /** 实际注入的字符数（不含本报告自身的说明文字）。 */
  used: number;
  /** 注入了什么。`digest` = 压缩后的契约摘要；`card` = 只给了导出签名（没给实现）。 */
  injected: Array<{ id: string; kind: string; chars: number; digest?: true; card?: true }>;
  /**
   * 没注入什么、为什么。
   * `no-space`：连所属配额都放不下；`tier-cap`：所属分层的额度已用完。
   * 区分这两种很关键 —— 前者要加大预算，后者要调分层比例。
   */
  omitted: Array<{ id: string; kind: string; chars: number; reason: 'no-space' | 'tier-cap' }>;
};

export type LlmRequest = {
  /** 发起请求的角色。 */
  role: LlmRoleName;
  /**
   * 调用目的。这是 MockProvider 的路由键，也是回放录制的索引键。
   * 例如 'intake' | 'planning' | 'contracting' | 'code:api' | 'tests' | 'review' | 'semantic-review'
   */
  purpose: string;
  messages: LlmMessage[];
  /** 要求结构化输出时提供。 */
  schema?: JsonSchema;
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  /** 推理型模型的推理强度（OpenAI o 系列 / DeepSeek reasoner 等）。不支持的端点会忽略它。 */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** 结构化重试次数（由调用方在 schema 校验失败后递增）。 */
  attempt?: number;
  /** 本次注入/丢弃了哪些工件 —— 只用于事后审计，不参与模型调用。 */
  context?: LlmContextReport;
};

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
};

export type LlmResponse = {
  provider: string;
  model: string;
  text: string;
  /** 结构化输出解析结果。prompt-only 模式下可能为空，此时调用方必须自行容错。 */
  json?: unknown;
  usage?: LlmUsage;
  latencyMs: number;
  /** 可回放的运行 ID。 */
  runId: string;
  /** 结构化解析失败时的原因（prompt-only 降级路径下常见）。 */
  parseError?: string;
  finishReason?: string;
};

export interface LlmProvider {
  readonly name: string;
  capabilities(): Promise<LlmCapabilities>;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

// ════════════════════════════════════════════════════════════════
// 调用记录与回放（docs/01 §7：没有回放就无法区分模型问题与编排问题）
// ════════════════════════════════════════════════════════════════

export type LlmCallRecord = {
  runId: string;
  seq: number;
  at: string;
  provider: string;
  model: string;
  role: LlmRoleName;
  purpose: string;
  attempt: number;
  /** prompt 的 hash：回放时用于确认「同样的输入」 */
  promptHash: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * 本次调用声明的结构化输出契约名。
   *
   * 必须记录（真实 LLM 实测的教训，docs/07 §L4）：
   * `OpenAiCompatProvider` 在 `!req.schema` 时**直接返回裸文本**（`json` 为 undefined），
   * 调用方于是拿到空对象、整条路径静默失效。
   * 排查这类问题时，第一个要问的就是「这次调用到底有没有声明 schema」——
   * 不记录它，事后只能靠读代码猜，而记录存在的意义恰恰是**事后归因**。
   *
   * 未声明 schema 时该字段为 undefined。为了让它可被明确区分，
   * 同时记录 `structured: false`（避免「没记录」与「没声明」混淆）。
   */
  schemaName?: string;
  /** 本次调用是否声明了结构化输出契约。 */
  structured: boolean;
  response: {
    text: string;
    json?: unknown;
    usage?: LlmUsage;
    parseError?: string;
    finishReason?: string;
  };
  latencyMs: number;
  /**
   * 这次调用的输入里**实际注入了哪些工件、丢了哪些**。
   * 见 `LlmContextReport` 上那段说明：这是「为什么它老是做不对」唯一可审计的证据。
   */
  context?: LlmContextReport;
};

export type { JsonSchema };
