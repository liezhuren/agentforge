/**
 * 能力探测（Capability Probe）。
 *
 * 用户诉求是「给他找他期望的 LLM 的权利」，但不同端点对结构化输出的支持差异很大：
 * 云端大模型多数支持 `response_format: json_schema`，但严格模式对 schema 有硬性要求；
 * 小模型/自建网关常常只支持 `json_object`，甚至什么都不支持。
 *
 * **不能假设**。猜错的代价是：要么每次请求都 400 失败，要么静默退化成
 * 「模型自由发挥文本」而我们的 schema 门禁天天在结构化重试上烧钱。
 *
 * 所以第一次使用某个 (provider, model) 时真发一次探测请求，逐级降级，
 * 把**实际可用的那一级**与**证据**（端点返回的错误原文）都记下来，并缓存。
 *
 * 与全局不变的量的关系：这是「不猜、去测」的一个具体应用 ——
 * 探测结果带着证据（evidence），人类能看见系统为什么认为该端点只支持 prompt-only。
 */

import type { JsonSchema } from '../../core/src/schemas.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { JsonSchemaMode } from './types.ts';
import type { OpenAiCompatProvider } from './openai.ts';
import { toStrictJsonSchema } from './strictschema.ts';

/**
 * 探测用的 schema 刻意包含严格模式最容易出问题的两个特征：
 *   - 可选字段（`note` 不在 required 里）→ 需要转成 required + nullable
 *   - `oneOf` 联合类型（`tag`）→ 严格模式不支持，需要转成 anyOf
 * 用真实工件 schema 去探太笨重，用这个最小样本就能暴露端点的真实能力。
 */
export const PROBE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    note: { type: 'string' },
    tag: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  },
};

export type ProbeOutcome = {
  provider: string;
  baseUrl: string;
  model: string;
  /** 最终选定的结构化强度。 */
  jsonSchema: JsonSchemaMode;
  /** 端点是否**可用**（网络通 + 鉴权通过 + 模型存在）。 */
  reachable: boolean;
  /** 本次探测是否得出了确定结论（限流等情况下为 false）。 */
  conclusive: boolean;
  /** 逐级降级的证据链，人类可审计。 */
  evidence: string[];
  /** 严格模式是否需要 schema 转换。 */
  strictNeedsSanitize: boolean;
  /** 致命问题：不是能力问题，而是配置/凭据问题，重试与降级都无意义。 */
  fatal?: { kind: ProbeFailureKind; message: string };
  /** 探测是否真的发起了网络请求（缓存命中时为 false）。 */
  live: boolean;
  probedAt: string;
};

/**
 * 探测失败的分类。
 *
 * **这个分类是本文件最重要的部分。** 第一版只区分了「连不上」与「其它」，
 * 结果把 401（API key 错误）当成了「端点不支持严格模式」，
 * 于是连降两级、报告 `prompt-only`、`reachable: true` ——
 * 用户看到的是一切正常，只是结构化输出弱一点；
 * 真实情况是**每一次调用都会 401 失败**。
 *
 * 用真实端点实测时被这个 bug 抓了个正着（见 docs/07 §G9）。
 * 所以分类必须按「该怎么修」来切，而不是按「HTTP 状态码区间」来切：
 *
 *   unreachable   → 检查网络 / baseUrl 主机名
 *   auth          → 检查 API key
 *   base-url      → 检查 baseUrl 路径（最常见：漏了 /v1 或多了 /v1）
 *   model         → 检查模型名
 *   rate-limited  → 稍后重试；本次探测无结论（不是能力问题！）
 *   capability    → 端点确实不支持该功能，可以安全降级
 *   output-format → 请求成功但输出不是合法 JSON；格式遵从度问题，继续降级
 *   token-budget  → 请求成功但输出为空/被截断；**max_tokens 太小**（推理型模型尤其容易撞上）
 *   unknown       → 未知 400，降级但留证
 *
 * 后两类是第二次用真实端点实测时补上的（docs/07 §L1）：
 * 它们都**不致命**，因为都不是「配置写错了」，而是降级链本来就该处理的东西。
 */
export type ProbeFailureKind =
  | 'unreachable'
  | 'auth'
  | 'base-url'
  | 'model'
  | 'rate-limited'
  | 'capability'
  | 'output-format'
  | 'token-budget'
  | 'empty-response'
  | 'unknown';

/** 哪些失败意味着「这个 provider 现在根本不能用」，应当立即停下而不是降级。 */
export const FATAL_KINDS: ProbeFailureKind[] = ['unreachable', 'auth', 'base-url', 'model'];

/**
 * 探测请求本身**成功了**（HTTP 200），但模型的输出不可用。
 *
 * 存在的理由（真实端点实测发现的 bug，见 docs/07 §L1）：
 * 这个错误没有 HTTP 状态码，于是被 `classifyProbeFailure` 归进了
 * 「没有状态码 ⇒ 网络层错误」那条兜底分支，判成 `unreachable`。
 * 而 `unreachable` 在 FATAL_KINDS 里 ⇒ 不降级 ⇒ 抛 LlmSetupError，
 * **整个流水线拒绝启动**，还提示用户去检查 API key / baseUrl / 网络 —— 全部指错方向。
 *
 * 但它根本不是什么配置问题：请求成功了，是模型的输出没解析出来 ——
 * 而这**正是降级链要处理的那类问题**（strict → json-mode → prompt-only，
 * 后面还有本地 schema 校验与结构化重试兜底）。
 *
 * 「请求失败」与「请求成功但输出不合用」是两种完全不同的失败，
 * 混在一起的结果就是：一个格式遵从度的小毛病，被升级成了「你的配置全错了」。
 */
export class ProbeOutputError extends Error {
  /** empty = 输出为空；truncated = 被 max_tokens 截断；unparseable = 有内容但解析不出 JSON。 */
  readonly outputKind: 'empty' | 'truncated' | 'unparseable';
  /**
   * 端点的 finish_reason。
   *
   * 必须带上它才能把「空输出」定性准确（真实端点实测，docs/07 §L6）：
   *   - `length` + 空 → token 预算被推理吃光（提高 maxTokens 能解决）
   *   - `stop`   + 空 → **不是预算问题**：端点说它正常结束了，却什么都没给。
   *     这是完全不同的原因，修法也不同，不能混为一谈。
   */
  readonly finishReason?: string;
  constructor(outputKind: ProbeOutputError['outputKind'], message: string, finishReason?: string) {
    super(message);
    this.name = 'ProbeOutputError';
    this.outputKind = outputKind;
    this.finishReason = finishReason;
  }
}

export function classifyProbeFailure(err: unknown): { kind: ProbeFailureKind; message: string } {
  const message = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;
  const body = (err as { body?: string })?.body ?? '';
  const hay = `${message}\n${body}`.toLowerCase();

  // 先看「请求是否成功」这个更根本的区分 —— 它在状态码判定之前。
  // 成功但输出不合用 ⇒ 格式遵从度/预算问题，可以降级，绝不能升级成配置错误。
  if (err instanceof ProbeOutputError) {
    if (err.outputKind === 'unparseable') return { kind: 'output-format', message };
    if (err.outputKind === 'truncated') return { kind: 'token-budget', message };
    // 空输出要再看 finish_reason：length 才是预算问题，stop 是另一回事
    return { kind: err.finishReason === 'length' ? 'token-budget' : 'empty-response', message };
  }

  if (typeof status === 'number') {
    if (status === 401 || status === 403) return { kind: 'auth', message };
    if (status === 404) return { kind: 'base-url', message };
    if (status === 429) return { kind: 'rate-limited', message };
    if (status >= 500) return { kind: 'unreachable', message };
    if (status === 400 || status === 422) {
      // 400 有两种截然不同的含义，必须靠正文区分
      if (/response_format|json_schema|json_object|structured|format/.test(hay)) {
        return { kind: 'capability', message };
      }
      if (/model/.test(hay) && /(not found|does not exist|unknown|invalid|unsupported)/.test(hay)) {
        return { kind: 'model', message };
      }
      if (/api key|unauthorized|authentication|invalid.*key/.test(hay)) {
        return { kind: 'auth', message };
      }
      return { kind: 'unknown', message };
    }
    return { kind: 'unknown', message };
  }

  // 没有状态码：网络层错误或超时
  return { kind: 'unreachable', message };
}

/**
 * 判断错误是否属于「连不上」。
 * 保留此函数供外部使用；内部判定请用 classifyProbeFailure（它能区分更多情况）。
 */
export function isUnreachable(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('econnrefused') ||
    m.includes('enotfound') ||
    m.includes('eai_again') ||
    m.includes('etimedout') ||
    m.includes('fetch failed') ||
    m.includes('超时') ||
    m.includes('network') ||
    m.includes('certificate') ||
    m.includes('ssl')
  );
}

export type CapabilityCache = {
  get(key: string): Promise<ProbeOutcome | null>;
  set(key: string, value: ProbeOutcome): Promise<void>;
};

/** 文件缓存：默认落在 <root>/.agentforge/capabilities.json。 */
export class FileCapabilityCache implements CapabilityCache {
  private path: string;
  private data: Record<string, ProbeOutcome> | null = null;

  constructor(root: string) {
    this.path = join(root, '.agentforge', 'capabilities.json');
  }

  private async load(): Promise<Record<string, ProbeOutcome>> {
    if (this.data) return this.data;
    if (!existsSync(this.path)) {
      this.data = {};
      return this.data;
    }
    try {
      this.data = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, ProbeOutcome>;
    } catch {
      this.data = {};
    }
    return this.data;
  }

  async get(key: string): Promise<ProbeOutcome | null> {
    const d = await this.load();
    return d[key] ?? null;
  }

  async set(key: string, value: ProbeOutcome): Promise<void> {
    const d = await this.load();
    d[key] = value;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(d, null, 2), 'utf8');
  }

  /** 清除缓存（配置改了 baseUrl/model 后应重探）。 */
  async clear(): Promise<void> {
    this.data = {};
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, '{}', 'utf8');
  }
}

export function probeCacheKey(provider: string, baseUrl: string, model: string): string {
  return `${provider}|${baseUrl}|${model}`;
}

export type ProbeOptions = {
  cache?: CapabilityCache;
  /** 强制重新探测，忽略缓存。 */
  force?: boolean;
  logger?: (msg: string, data?: unknown) => void;
};

/**
 * 逐级探测某端点的结构化输出能力。
 *
 * 降级链：strict（转换后的 schema）→ json-mode → prompt-only
 *
 * 注意：探测**不抛异常**（除编程错误外）。端点不可达时返回 reachable=false，
 * 由上层决定是报错退出还是降级。理由：探测是「了解环境」的动作，
 * 让它抛异常会把「配置写错了」和「网络抖了一下」混成同一种失败。
 */
export async function probeJsonSchemaMode(
  provider: OpenAiCompatProvider,
  opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const model = provider.config.defaultModel;
  const baseUrl = provider.config.baseUrl;
  const key = probeCacheKey(provider.name, baseUrl, model);

  if (opts.cache && !opts.force) {
    const hit = await opts.cache.get(key);
    // 兼容旧版本缓存（没有 conclusive 字段）
    if (hit) return { ...hit, live: false, conclusive: hit.conclusive ?? true };
  }


  const evidence: string[] = [];
  const sanitized = toStrictJsonSchema(PROBE_SCHEMA);
  const strictNeedsSanitize = sanitized.changes.length > 0;

  const attempt = async (
    mode: JsonSchemaMode,
    useSanitized: boolean,
  ): Promise<{ ok: boolean; error?: unknown }> => {
    const schema = useSanitized ? sanitized.schema : PROBE_SCHEMA;
    const prevMode = provider.jsonMode;
    const prevStrict = provider.strictSchemaMode;
    provider.setJsonMode(mode);
    // 关键：探测时用什么 schema，就要把同样的设置写进 provider ——
    // 否则会出现「探测成功、真实调用却 400」的错位（见 strictSchema 字段说明）。
    if (mode === 'strict') provider.setStrictSchemaMode(useSanitized ? 'sanitize' : 'as-is');
    try {
      const res = await provider.complete({
        role: 'system',
        purpose: 'capability-probe',
        messages: [
          { role: 'system', content: '只输出 JSON，不要任何解释。' },
          { role: 'user', content: '返回 {"ok": true, "note": "probe", "tag": "x"}' },
        ],
        schema,
        schemaName: 'Probe',
        temperature: 0,
        // 512 而不是 64 —— 这是真实端点实测改正的（docs/07 §L1）。
        //
        // 第一版写 64，理由是「期望输出只有十几 token」。对非推理模型够用，
        // 但**推理型模型（如 deepseek-flash）会先把预算花在不可见的推理 token 上**：
        // 实测 5 次里有 3 次 finishReason=length、completion=64、可见文本长度为 0
        // —— 一个字都没剩下，探测于是判定「不可用」。
        //
        // 更荒谬的是失败归因：那 3 次被报成「无法解析为 JSON」→ 无状态码 →
        // 判 unreachable → 整个流水线拒绝启动，还让人去检查 API key 和网络。
        //
        // 教训：**探测自身的预算不足，会被误读成被测对象的能力不足。**
        // 探测的 maxTokens 必须留出「模型啰嗦 / 先推理」的余量，否则它测的是自己的吝啬。
        maxTokens: 512,
      });
      if (res.parseError && res.json === undefined) {
        // 请求成功但输出不合用 —— 这不算「该模式可用」，但**也不是配置问题**。
        // 必须带上 ProbeOutputError 标记，否则会被当成网络错误升级成致命问题。
        provider.setJsonMode(prevMode);
        provider.setStrictSchemaMode(prevStrict);
        const blank = res.text.trim().length === 0;
        const outputKind = blank ? 'empty' : res.finishReason === 'length' ? 'truncated' : 'unparseable';
        return { ok: false, error: new ProbeOutputError(outputKind, res.parseError, res.finishReason) };
      }
      return { ok: true };
    } catch (e) {
      // 失败则回滚到该次尝试之前的状态；成功时保留（finish 会再显式设定一次）
      provider.setJsonMode(prevMode);
      provider.setStrictSchemaMode(prevStrict);
      return { ok: false, error: e };
    }
  };

  const finish = async (outcome: Omit<ProbeOutcome, 'probedAt' | 'live'>): Promise<ProbeOutcome> => {
    const full: ProbeOutcome = { ...outcome, probedAt: new Date().toISOString(), live: true };
    // ── 只缓存**有结论且可用**的结果 ─────────────────────────────
    //
    // 缓存「无结论」会自相矛盾：evidence 里写着「本次探测无结论，请稍后重试」，
    // 而缓存恰恰让「稍后」永远不会发生 —— 下一次运行直接命中这条无结论的记录。
    // 缓存「致命」结果更糟：一次网络抖动会让这个 (provider, model) 永远被判不可用，
    // 用户除了手删 capabilities.json 之外没有出路。
    //
    // 判定原则与 §G9 一致：**不确定的事不要写进事实底座。**
    if (opts.cache && full.conclusive && !full.fatal) await opts.cache.set(key, full);
    opts.logger?.(`能力探测结果：${provider.name}/${model} → ${full.jsonSchema}`, {
      reachable: full.reachable,
      conclusive: full.conclusive,
      strictNeedsSanitize: full.strictNeedsSanitize,
      evidence: full.evidence,
    });
    return full;
  };

  // 1) 严格模式 + 转换后的 schema
  const strict = await attempt('strict', strictNeedsSanitize);
  if (strict.ok) {
    evidence.push(
      strictNeedsSanitize
        ? '严格模式可用；我们定义的 schema 需要先做一次兼容转换（可选字段→required+nullable、oneOf→anyOf）。' +
            `本次转换 ${sanitized.changes.length} 处，示例：${sanitized.changes[0] ?? '-'}`
        : '严格模式可用，且 schema 无需转换。',
    );
    provider.setJsonMode('strict');
    provider.setStrictSchemaMode(strictNeedsSanitize ? 'sanitize' : 'as-is');
    return finish({
      provider: provider.name,
      baseUrl,
      model,
      jsonSchema: 'strict',
      reachable: true,
      conclusive: true,
      evidence,
      strictNeedsSanitize,
    });
  }

  const first = classifyProbeFailure(strict.error);
  evidence.push(`严格模式探测失败（${first.kind}）：${first.message}`);

  // ── 致命问题：降级毫无意义，而且会掩盖真正的原因 ──────────────
  //
  // 这是用真实端点实测才发现的 bug：401（key 错误）曾被当作「不支持严格模式」，
  // 连降两级后报 prompt-only + reachable:true，用户完全看不出自己的 key 是错的。
  // 判定原则：**能通过「改配置」解决的问题，就不该被降级掩盖。**
  if (FATAL_KINDS.includes(first.kind)) {
    const hint =
      first.kind === 'auth'
        ? '请检查 API key（是否设置、是否过期、是否有该模型的权限）'
        : first.kind === 'base-url'
          ? '请检查 baseUrl 的路径前缀（常见错误：漏写或多写了 /v1）'
          : first.kind === 'model'
            ? '请检查模型名是否正确、账号是否有该模型权限'
            : '请检查网络连通性与 baseUrl 主机名';
    evidence.push(`致命问题（${first.kind}）：${hint}。**不做降级** —— 降级只会掩盖真正的原因`);
    return finish({
      provider: provider.name,
      baseUrl,
      model,
      // 保持配置里的意愿值：我们并没有证明它不支持严格模式
      jsonSchema: provider.config.jsonMode === 'auto' || !provider.config.jsonMode ? 'strict' : provider.config.jsonMode,
      reachable: false,
      conclusive: true,
      evidence,
      strictNeedsSanitize,
      fatal: { kind: first.kind, message: first.message },
    });
  }

  // ── 限流：本次探测无结论，但也不是能力问题 ────────────────────
  if (first.kind === 'rate-limited') {
    evidence.push(
      '端点限流（429）：**不能据此判断它不支持严格模式**。本次探测无结论，请稍后重试或检查额度',
    );
    return finish({
      provider: provider.name,
      baseUrl,
      model,
      jsonSchema: 'json-mode', // 保守取中间档，避免误用严格模式
      reachable: true,
      conclusive: false,
      evidence,
      strictNeedsSanitize,
    });
  }

  // 2) json_object 模式
  const jsonMode = await attempt('json-mode', false);
  if (jsonMode.ok) {
    evidence.push('json_object 模式可用：端点只保证「是合法 JSON」，不保证符合 schema。约束由提示词 + 本地校验 + 结构化重试承担。');
    provider.setJsonMode('json-mode');
    return finish({
      provider: provider.name,
      baseUrl,
      model,
      jsonSchema: 'json-mode',
      reachable: true,
      conclusive: true,
      evidence,
      strictNeedsSanitize,
    });
  }
  const second = classifyProbeFailure(jsonMode.error);
  evidence.push(`json_object 模式不可用（${second.kind}）：${second.message}`);

  // 第二次尝试若暴露出致命问题，同样不做降级
  if (FATAL_KINDS.includes(second.kind)) {
    evidence.push(`致命问题（${second.kind}）：**不做降级** —— 降级只会掩盖真正的原因`);
    return finish({
      provider: provider.name,
      baseUrl,
      model,
      jsonSchema: 'json-mode',
      reachable: false,
      conclusive: true,
      evidence,
      strictNeedsSanitize,
      fatal: { kind: second.kind, message: second.message },
    });
  }

  // ── 请求成功但输出不合用 ──────────────────────────────────────
  //
  // 这不是「端点没有这个能力」，而是「模型的格式遵从度 / 预算不够」。
  // 必须如实说明，并把它与「端点确实不支持 json_object」区分开 ——
  // 否则用户会去改配置，而真正该改的是模型选择或 maxTokens。
  if (second.kind === 'output-format' || second.kind === 'token-budget' || second.kind === 'empty-response') {
    const cause =
      second.kind === 'token-budget'
        ? '请求成功但**输出为空或被截断**（finish_reason=length）：探测的 max_tokens 不够。' +
          '**推理型模型会先把预算花在不可见的推理 token 上**，留给可见输出的可能为零。' +
          '这不代表端点不支持结构化输出 —— 提高 maxTokens 或换非推理模型即可。'
        : second.kind === 'empty-response'
          ? '请求成功但**输出为空**，而 finish_reason=stop —— 端点声称它正常结束了，却什么都没给。' +
            '**这不是 token 预算问题**（提高 maxTokens 不会有用）。' +
            '常见原因：网关/端点侧的偶发行为、模型对「json_object + 极小输出」这类参数组合的异常处理。' +
            '它是瞬时的还是稳定的，需要多探几次才能判断。'
          : '请求成功但**输出不是合法 JSON**：端点接受了 json_object 参数，模型却没有照做。' +
            '这是格式遵从度问题（可通过提示词、温度、更强模型改善），不是端点能力缺失。';
    evidence.push(cause);
    evidence.push(
      '因此本次探测**没有得到确定结论**：既不能声称该端点支持（它没给回合法 JSON），' +
        '也不能声称它不支持（请求是成功的）。按最保守的 prompt-only 继续，' +
        '并由本地 schema 校验 + 结构化重试兜底。',
    );
    provider.setJsonMode('prompt-only');
    return finish({
      provider: provider.name,
      baseUrl,
      model,
      jsonSchema: 'prompt-only',
      reachable: true,
      // 刻意标 false：reachable=true 是因为「端点和鉴权都没问题」，
      // 但能力档位是无结论的推断，不能骗人说这是测出来的。
      conclusive: false,
      evidence,
      strictNeedsSanitize,
    });
  }

  // 3) 纯提示词
  evidence.push('降级到 prompt-only：schema 只通过提示词传达，输出格式遵从度最低，结构化重试会是主要纠错手段。');
  provider.setJsonMode('prompt-only');
  return finish({
    provider: provider.name,
    baseUrl,
    model,
    jsonSchema: 'prompt-only',
    reachable: true,
    conclusive: true,
    evidence,
    strictNeedsSanitize,
  });
}
