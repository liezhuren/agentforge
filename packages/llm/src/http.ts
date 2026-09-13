/**
 * HTTP 层公共部分：错误类型、超时、JSON 提取与修复。
 *
 * 为什么要有「JSON 提取与修复」：并不是所有模型/端点都支持严格结构化输出。
 * 能力探测（probe.ts）会把不支持 strict 的端点降级到 prompt-only，
 * 那时模型会返回带 Markdown 围栏、前后解释文字的文本。
 * 直接把这种文本当失败丢掉太浪费 —— 但**修复必须可追溯**：
 * 修复过程会记进 LlmResponse.parseError，人类能看到「这条结论来自被修复过的输出」。
 */

export class LlmHttpError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  body?: string;
  constructor(args: { status: number; code: string; message: string; retryable: boolean; body?: string }) {
    super(args.message);
    this.name = 'LlmHttpError';
    this.status = args.status;
    this.code = args.code;
    this.retryable = args.retryable;
    if (args.body !== undefined) this.body = args.body;
  }
}

export class LlmTimeoutError extends Error {
  timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`LLM 请求超时（${timeoutMs}ms）`);
    this.name = 'LlmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** 把 HTTP 状态码映射为是否值得重试。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type RequestOptions = {
  timeoutMs: number;
  /** 总尝试次数（含首次）。 */
  maxRetries: number;
  /** 重试退避的基础毫秒数，按指数增长。 */
  backoffMs?: number;
  fetchImpl?: FetchLike;
  onRetry?: (info: { attempt: number; status?: number; error?: string; delayMs: number }) => void;
};

export type HttpJsonResult = { ok: true; json: unknown; status: number } | { ok: false; error: Error };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 带超时与重试的 JSON 请求。
 *
 * 注意重试策略是**保守**的：只对「明确可重试」的状态码与网络错误重试。
 * 4xx（除 429/408）一律不重试 —— 那是请求本身有问题（模型名错了、参数不合法、
 * 不支持的结构化输出格式），重试只会浪费钱并掩盖真正的错误。
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: RequestOptions,
): Promise<HttpJsonResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const maxRetries = Math.max(1, opts.maxRetries);
  const backoff = opts.backoffMs ?? 500;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const text = await res.text();

      if (!res.ok) {
        const retryable = isRetryableStatus(res.status);
        const err = new LlmHttpError({
          status: res.status,
          code: `HTTP_${res.status}`,
          message: `LLM 端点返回 ${res.status}：${summarize(text)}`,
          retryable,
          body: text.slice(0, 4000),
        });
        lastError = err;
        if (!retryable || attempt === maxRetries) return { ok: false, error: err };
        const retryAfter = Number(res.headers.get('retry-after') ?? '');
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff * 2 ** (attempt - 1);
        opts.onRetry?.({ attempt, status: res.status, delayMs: delay });
        await sleep(delay);
        continue;
      }

      try {
        return { ok: true, json: JSON.parse(text), status: res.status };
      } catch (e) {
        const err = new LlmHttpError({
          status: res.status,
          code: 'INVALID_JSON_BODY',
          message: `LLM 端点返回了非 JSON 响应：${summarize(text)}`,
          retryable: false,
          body: text.slice(0, 4000),
        });
        return { ok: false, error: err };
      }
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error).name === 'AbortError';
      const err = aborted ? new LlmTimeoutError(opts.timeoutMs) : (e as Error);
      lastError = err;
      if (attempt === maxRetries) return { ok: false, error: err };
      const delay = backoff * 2 ** (attempt - 1);
      opts.onRetry?.({ attempt, error: err.message, delayMs: delay });
      await sleep(delay);
    }
  }

  return { ok: false, error: lastError ?? new Error('未知的 LLM 请求失败') };
}

function summarize(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 300 ? t.slice(0, 300) + '…' : t;
}

// ════════════════════════════════════════════════════════════════
// JSON 提取与修复
// ════════════════════════════════════════════════════════════════

export type JsonExtraction = {
  value: unknown;
  /** 是否经过了修复（非直接 JSON.parse 成功）。 */
  repaired: boolean;
  note?: string;
};

/**
 * 从模型文本中尽力取出一个 JSON 对象。
 *
 * 修复链（每一步都记录在 note 里，便于人类判断这条结论的可信度）：
 *   1. 直接 JSON.parse
 *   2. 去掉 Markdown 代码围栏后解析
 *   3. 提取第一个**括号平衡**的 {...} 或 [...] 片段
 *   4. 去掉尾随逗号后再试
 * 全部失败则返回 null，由调用方决定重试（通常是结构化重试，附上具体错误）。
 */
export function extractJson(text: string): JsonExtraction | null {
  const raw = text?.trim() ?? '';
  if (raw.length === 0) return null;

  const direct = tryParse(raw);
  if (direct !== undefined) return { value: direct, repaired: false };

  const fenced = stripFences(raw);
  if (fenced !== raw) {
    const v = tryParse(fenced);
    if (v !== undefined) return { value: v, repaired: true, note: '从 Markdown 代码围栏中提取' };
  }

  const balanced = firstBalanced(fenced) ?? firstBalanced(raw);
  if (balanced) {
    const v = tryParse(balanced);
    if (v !== undefined) return { value: v, repaired: true, note: '从文本中提取括号平衡的 JSON 片段' };

    const fixed = balanced
      .replace(/,\s*([}\]])/g, '$1') // 尾随逗号
      .replace(/[\u201c\u201d]/g, '"') // 中文引号
      .replace(/[\u2018\u2019]/g, "'");
    const v2 = tryParse(fixed);
    if (v2 !== undefined) return { value: v2, repaired: true, note: '提取片段并修复尾随逗号/引号' };
  }

  return null;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function stripFences(text: string): string {
  const m = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  return m ? m[1].trim() : text;
}

/** 找到第一个括号平衡的 {...} 或 [...] 片段（会跳过字符串字面量里的括号）。 */
export function firstBalanced(text: string): string | null {
  const startObj = text.indexOf('{');
  const startArr = text.indexOf('[');
  let start = -1;
  let open = '';
  let close = '';
  if (startObj === -1 && startArr === -1) return null;
  if (startObj === -1 || (startArr !== -1 && startArr < startObj)) {
    start = startArr;
    open = '[';
    close = ']';
  } else {
    start = startObj;
    open = '{';
    close = '}';
  }

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
