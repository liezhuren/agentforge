/**
 * MockProvider：不联网、不花钱、可注入任意幻觉。
 *
 * 这不是「测试替身」这么简单 —— 它是 P1 的核心工具：
 * 只有能精确注入某一类幻觉（假包、假符号、假证据、漏需求、假通过），
 * 才能验证锚点与机械裁判**确实**拦得住它。
 *
 * 用法：
 *   const p = new MockProvider({ script: { intake: {...}, 'code:api': {...} } });
 *   p.inject('code:api', hallucination.nonexistentPackage());
 */

import { randomUUID } from 'node:crypto';
import { sha256, stableStringify } from '../../core/src/hash.ts';
import type {
  LlmCapabilities,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmCallRecord,
} from './types.ts';

export type MockHandler = (req: LlmRequest) => unknown | Promise<unknown>;

export type MockScript = Record<string, unknown | MockHandler>;

export type MockProviderOptions = {
  name?: string;
  script: MockScript;
  capabilities?: Partial<LlmCapabilities>;
  /** 模拟延迟，用于测试超时与并发行为。 */
  latencyMs?: number;
  /** 这些 purpose 第一次调用时故意失败（模拟格式错误），用于测试结构化重试。 */
  failFirstAttemptFor?: string[];
  /** 这些 purpose 直接抛错，用于测试降级路径。 */
  throwFor?: string[];
  /** 每个 purpose 的最大可调用次数，超出后抛错（用于捕捉无限循环）。 */
  maxCallsPerPurpose?: number;
  /**
   * 要求每次调用都必须传 `schema`，否则抛错。
   *
   * 存在的理由（真实 LLM 实测发现的缺陷，见 docs/07 §L4）：
   * MockProvider 默认**不看 schema**，直接返回脚本值 —— 于是「编排器忘了传 schema」
   * 这个缺陷在 Mock 下完全不可见，却在真实 provider 下致命：
   * `OpenAiCompatProvider` 在 `!req.schema` 时直接返回裸文本（`json` 为 undefined），
   * 调用方拿到 `{}`，圆桌的每条发言都变成「(无主张) + 无证据」而被全部丢弃。
   *
   * 打开这个开关跑一遍完整流程，就能把**这一类**遗漏一次性抓出来 ——
   * 不必等接了真实 provider 才发现。
   *
   * 这就是「Mock 通过 ≠ 真实通过」的具体修法：
   * 让 Mock 也模拟真实 provider 的一条硬性契约（要结构化输出就必须声明 schema）。
   */
  requireSchema?: boolean;
};

export type MockCall = {
  role: string;
  purpose: string;
  attempt: number;
  lastUserMessage: string;
};

/**
 * 确定性 Mock：同一 purpose 永远返回同一份内容，
 * 这样「同一次编排的成败」不会因为模型随机性而变化 —— 编排的确定性才可被验证。
 */
export class MockProvider implements LlmProvider {
  readonly name: string;
  private script: MockScript;
  private caps: LlmCapabilities;
  private latencyMs: number;
  private failFirst: Set<string>;
  private throwFor: Set<string>;
  private maxCallsPerPurpose: number;
  private requireSchema: boolean;
  /**
   * 打开 `requireSchema` 后，所有「没传 schema 的调用」的 purpose 清单。
   *
   * 为什么光靠抛异常不够：有些调用点（例如圆桌的 `collect`）会把发言过程中的异常
   * **捕获并记为「发言失败」**，然后继续跑完流程。于是「编排器忘了传 schema」
   * 会被吞掉，测试看到的是一个正常结束的 run。
   * 记录清单能让测试直接断言「有没有这一类遗漏」，不受吞异常影响。
   */
  readonly schemaViolations: string[] = [];
  private callsByPurpose = new Map<string, number>();
  readonly calls: MockCall[] = [];
  readonly records: LlmCallRecord[] = [];
  private seq = 0;
  private runId = `mock-${randomUUID().slice(0, 8)}`;

  constructor(opts: MockProviderOptions) {
    this.name = opts.name ?? 'mock';
    this.script = opts.script;
    this.latencyMs = opts.latencyMs ?? 0;
    this.failFirst = new Set(opts.failFirstAttemptFor ?? []);
    this.throwFor = new Set(opts.throwFor ?? []);
    this.maxCallsPerPurpose = opts.maxCallsPerPurpose ?? 200;
    this.requireSchema = opts.requireSchema ?? false;
    this.caps = {
      jsonSchema: 'strict',
      toolCalling: true,
      streaming: false,
      ...opts.capabilities,
    };
  }

  /** 动态改写某个 purpose 的返回内容。用于在同一测试里切换「正常 / 注入幻觉」。 */
  inject(purpose: string, value: unknown | MockHandler): void {
    this.script[purpose] = value;
  }

  /** 清空调用计数（但不改脚本），用于判断「第二轮是否被调用」。 */
  resetCounts(): void {
    this.callsByPurpose.clear();
    this.calls.length = 0;
  }

  callCount(purpose: string): number {
    return this.callsByPurpose.get(purpose) ?? 0;
  }

  calledPurposes(): string[] {
    return [...this.callsByPurpose.keys()];
  }

  async capabilities(): Promise<LlmCapabilities> {
    return this.caps;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const n = (this.callsByPurpose.get(req.purpose) ?? 0) + 1;
    this.callsByPurpose.set(req.purpose, n);
    this.calls.push({
      role: req.role,
      purpose: req.purpose,
      attempt: req.attempt ?? 0,
      lastUserMessage: req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '',
    });

    if (n > this.maxCallsPerPurpose) {
      throw new Error(
        `MockProvider: purpose "${req.purpose}" 被调用 ${n} 次，超过上限 ${this.maxCallsPerPurpose} —— 疑似编排死循环`,
      );
    }
    if (this.throwFor.has(req.purpose)) {
      throw new Error(`MockProvider: purpose "${req.purpose}" 被配置为抛错`);
    }
    if (this.requireSchema && !req.schema) {
      this.schemaViolations.push(req.purpose);
      throw new Error(
        `MockProvider(requireSchema): purpose "${req.purpose}" 没有传 schema。` +
          `真实 provider 此时会直接返回裸文本（json 为 undefined），调用方拿到的是空对象 —— ` +
          `这在 Mock 下不可见，但在真实端点下会让整条路径静默失效。` +
          `要么补上 schema，要么明确说明这次调用不需要结构化输出。`,
      );
    }
    if (this.failFirst.has(req.purpose) && n === 1) {
      // 模拟模型第一次输出格式错误：返回无法解析为 JSON 的文本
      return this.record(req, started, '这不是合法的 JSON {{{', undefined, 'mock 第一次输出格式错误');
    }

    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const entry = this.script[req.purpose];
    if (entry === undefined) {
      throw new Error(
        `MockProvider: 没有为 purpose "${req.purpose}" 配置脚本。已配置：${Object.keys(this.script).join(', ')}`,
      );
    }

    let value: unknown;
    try {
      value = typeof entry === 'function' ? await (entry as MockHandler)(req) : entry;
    } catch (err) {
      throw new Error(`MockProvider: purpose "${req.purpose}" 的处理函数抛错：${(err as Error).message}`);
    }

    // 支持 { __raw: "文本" } 形式来模拟「模型不听话、不返回 JSON」
    if (value && typeof value === 'object' && '__raw' in (value as Record<string, unknown>)) {
      const raw = String((value as { __raw: unknown }).__raw);
      return this.record(req, started, raw, undefined, 'mock 返回了非 JSON 文本');
    }

    return this.record(req, started, JSON.stringify(value, null, 2), value);
  }

  private record(
    req: LlmRequest,
    started: number,
    text: string,
    json: unknown,
    parseError?: string,
  ): LlmResponse {
    this.seq++;
    const latencyMs = Date.now() - started;
    const promptHash = sha256(
      stableStringify({
        role: req.role,
        purpose: req.purpose,
        messages: req.messages,
        schemaName: req.schemaName,
        temperature: req.temperature,
      }),
    );

    this.records.push({
      runId: this.runId,
      seq: this.seq,
      at: new Date().toISOString(),
      provider: this.name,
      model: req.model ?? 'mock-model',
      role: req.role,
      purpose: req.purpose,
      attempt: req.attempt ?? 0,
      promptHash,
      structured: req.schema !== undefined,
      ...(req.schemaName !== undefined ? { schemaName: req.schemaName } : {}),
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      response: { text, json, parseError },
      latencyMs,
    });

    return {
      provider: this.name,
      model: req.model ?? 'mock-model',
      text,
      json,
      usage: {
        promptTokens: Math.ceil(JSON.stringify(req.messages).length / 4),
        completionTokens: Math.ceil(text.length / 4),
      },
      latencyMs,
      runId: `${this.runId}#${this.seq}`,
      parseError,
      finishReason: 'stop',
    };
  }
}

/**
 * 注意：录制用的 `RecordingProvider` 在 recorder.ts 里（带 jsonl 落盘）。
 * 这里曾在早期版本也导出一个同名类，导致 `export *` 出现重复导出而整个包无法加载 ——
 * 同名导出在 TS 里不报错（类型被擦除后 `export *` 直接冲突），
 * 所以这类问题只能靠「真的把包 import 一次」来发现。
 */
export function toJsonl(records: LlmCallRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}
