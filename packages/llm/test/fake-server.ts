/**
 * 本地假的 OpenAI 兼容服务器（测试用）。
 *
 * 为什么不用真实端点做验证：
 *   1. 环境无外网（连 baidu 都不通），这是硬约束
 *   2. 即使有网，真实端点也**测不了错误路径** —— 你没法让 OpenAI 稳定返回 429、
 *      没法让它拒绝 json_schema、没法让它故意超时
 *   3. 真实端点不确定、要花钱、不可复现
 *
 * 这个假服务器是真 HTTP 服务器（node:http），走真 socket、真状态码、真响应头，
 * 因此它验证的是完整的网络栈行为，不是 mock 掉 fetch 的假象。
 *
 * 它同时是「能力探测」的靶子：可以按测试需要让它拒绝严格模式、拒绝 response_format、
 * 先 429 再成功、卡住不返回 —— 于是降级链与重试策略都能被真的走一遍。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
// 注意：AddressInfo 是纯类型，必须用 `import type` ——
// Node 的类型剥离会把普通 import 保留下来，运行时会因「node:net 没有这个导出」而报错。
import type { AddressInfo } from 'node:net';

export type FakeReply = {
  status?: number;
  body?: unknown;
  /** 直接返回原始文本（用于测试非 JSON 响应）。 */
  rawText?: string;
  /** 自定义响应头。 */
  headers?: Record<string, string>;
  /** 延迟多少毫秒再响应（用于测试超时）。 */
  delayMs?: number;
  /** 直接断开连接（模拟网络故障）。 */
  destroy?: boolean;
};

export type FakeBehavior = (req: {
  body: Record<string, unknown>;
  headers: IncomingMessage['headers'];
  url: string;
  callIndex: number;
}) => FakeReply | Promise<FakeReply>;

export type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
  headers: IncomingMessage['headers'];
};

export class FakeOpenAiServer {
  private server: Server | null = null;
  private behavior: FakeBehavior;
  readonly requests: CapturedRequest[] = [];
  port = 0;

  constructor(behavior: FakeBehavior) {
    this.behavior = behavior;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get callCount(): number {
    return this.requests.length;
  }

  /** 只看最后一次请求体（断言请求形状时最常用）。 */
  get lastBody(): Record<string, unknown> {
    return this.requests[this.requests.length - 1]?.body ?? {};
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');

    let body: Record<string, unknown> = {};
    try {
      body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = { __unparsed: raw };
    }

    const callIndex = this.requests.length;
    this.requests.push({ url: req.url ?? '', body, headers: req.headers });

    let reply: FakeReply;
    try {
      reply = await this.behavior({ body, headers: req.headers, url: req.url ?? '', callIndex });
    } catch (e) {
      reply = { status: 500, body: { error: { message: `假服务器行为函数抛错：${(e as Error).message}` } } };
    }

    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));

    if (reply.destroy) {
      req.socket.destroy();
      return;
    }

    const status = reply.status ?? 200;
    const payload =
      reply.rawText !== undefined ? reply.rawText : JSON.stringify(reply.body ?? defaultChatResponse(body));

    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload, 'utf8'),
      ...(reply.headers ?? {}),
    });
    res.end(payload);
  }
}

/**
 * 默认行为：回显一个标准的 chat.completion 响应，内容是固定的合法 JSON。
 *
 * 刻意**不做任何启发式判断**（早先版本会去看提示词里有没有 "ok" 来决定返回什么，
 * 结果测试的失败原因变得很隐蔽：断言不匹配时你看不出是逻辑错了还是假服务器猜错了）。
 * 需要别的载荷就用 `behaviors.sequence(...)` 或自定义行为显式指定。
 */
export function defaultChatResponse(body: Record<string, unknown>): unknown {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model: body.model ?? 'fake-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '{"ok":true,"note":"probe","tag":"x"}' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  };
}

/** 常用的行为构造器。 */
export const behaviors = {
  /** 完全正常的端点。 */
  ok: (): FakeBehavior => () => ({}),

  /** 拒绝严格模式（json_schema），但接受 json_object —— 模拟只支持弱结构化输出的端点。 */
  rejectStrict: (): FakeBehavior => ({ body }) => {
    const rf = body.response_format as { type?: string } | undefined;
    if (rf?.type === 'json_schema') {
      return {
        status: 400,
        body: {
          error: {
            message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
            type: 'invalid_request_error',
            code: 'unsupported_response_format',
          },
        },
      };
    }
    return {};
  },

  /** 完全不支持 response_format —— 模拟最小实现的自建网关。 */
  rejectAllStructured: (): FakeBehavior => ({ body }) => {
    if (body.response_format !== undefined) {
      return {
        status: 400,
        body: { error: { message: "Unknown parameter: 'response_format'.", type: 'invalid_request_error' } },
      };
    }
    return {};
  },

  /** 前 N 次返回 429，之后成功（测试重试与 Retry-After）。 */
  rateLimitThenOk: (times: number, retryAfterSec?: number): FakeBehavior => {
    let n = 0;
    return () => {
      n++;
      if (n <= times) {
        // 显式标注类型：三元两边的推断结果是 `{'retry-after': string} | {'retry-after'?: undefined}`，
        // 后者因为那个 optional undefined 与 `Record<string, string>` 不相容。
        const headers: Record<string, string> =
          retryAfterSec !== undefined ? { 'retry-after': String(retryAfterSec) } : {};
        return {
          status: 429,
          headers,
          body: { error: { message: 'Rate limit reached', type: 'rate_limit_error' } },
        };
      }
      return {};
    };
  },

  /** 永远 500（测试重试耗尽）。 */
  always500: (): FakeBehavior => () => ({
    status: 500,
    body: { error: { message: 'Internal server error' } },
  }),

  /** 永远 401（测试不可重试的 4xx）。 */
  unauthorized: (): FakeBehavior => () => ({
    status: 401,
    body: { error: { message: 'Invalid API key', type: 'authentication_error' } },
  }),

  /** 永远超时。 */
  hang: (): FakeBehavior => () => ({ delayMs: 30_000 }),

  /** 200 但响应体里带 error（有些网关这么干）。 */
  errorInBody: (): FakeBehavior => () => ({
    body: { error: { message: 'model overloaded', type: 'server_error' } },
  }),

  /** 返回带 Markdown 围栏的 JSON（测试 JSON 修复）。 */
  fencedJson: (): FakeBehavior => () => ({
    body: {
      id: 'x',
      model: 'fake',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '好的，这是结果：\n```json\n{"ok": true, "note": "fenced", "tag": 1}\n```\n希望有帮助！',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  }),

  /** 返回完全无法解析的文本。 */
  garbage: (): FakeBehavior => () => ({
    body: {
      id: 'x',
      model: 'fake',
      choices: [{ message: { role: 'assistant', content: '我觉得这个需求大概是要做一个看板吧，但我不太确定……' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  }),

  /**
   * 模拟**推理型模型把 token 预算烧光**：请求成功（200），
   * 但可见内容为空，且 finish_reason=length。
   *
   * 这是真实端点实测到的现象（docs/07 §L1）：deepseek-flash 在 max_tokens=64 时，
   * 实测 5 次里 3 次 completion_tokens=64、finish_reason=length、content=''。
   * 必须能复现它，否则「探测把自己的吝啬误读成对方的能力不足」这个 bug 会再回来。
   */
  emptyBecauseLength: (): FakeBehavior => () => ({
    body: {
      id: 'x',
      model: 'fake',
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 64 },
    },
  }),

  /**
   * 请求成功、但返回**空内容且 finish_reason=stop**。
   *
   * 与 `emptyBecauseLength` 是**不同**的失败（真实端点实测到过，docs/07 §L6）：
   * 端点声称正常结束却什么都没给 —— 这不是 token 预算问题，
   * 提高 maxTokens 不会有用。两者必须被区分，否则用户会去改一个无关的参数。
   */
  emptyWithStop: (): FakeBehavior => () => ({
    body: {
      id: 'x',
      model: 'fake',
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    },
  }),

  /** 输出被 max_tokens 截断在半句 —— JSON 不完整。 */
  truncatedJson: (): FakeBehavior => () => ({
    body: {
      id: 'x',
      model: 'fake',
      choices: [{ message: { role: 'assistant', content: '{"ok": true, "note": "probe' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 64 },
    },
  }),

  /**
   * 拒绝严格模式，但 json_object 请求**成功却给不出合法 JSON**。
   * 用于验证：这类失败不得被当成配置错误（那会让整条流水线拒绝启动）。
   */
  rejectStrictThenUnparseable: (reply: 'empty' | 'empty-stop' | 'garbage' | 'truncated'): FakeBehavior => ({ body }) => {
    const rf = body.response_format as { type?: string } | undefined;
    if (rf?.type === 'json_schema') {
      return {
        status: 400,
        body: {
          error: {
            message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
            type: 'invalid_request_error',
            code: 'unsupported_response_format',
          },
        },
      };
    }
    const content =
      reply === 'empty' || reply === 'empty-stop'
        ? ''
        : reply === 'truncated'
          ? '{"ok": true, "note": "probe'
          : '我不太确定，大概是这样吧……';
    return {
      body: {
        id: 'x',
        model: 'fake',
        choices: [
          {
            message: { role: 'assistant', content },
            // empty/truncated 是「预算耗尽」；empty-stop 是端点声称正常结束但没给内容；
            // garbage 是模型没照做但正常结束
            finish_reason: reply === 'empty' || reply === 'truncated' ? 'length' : 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 64 },
      },
    };
  },

  /** 返回非 JSON 原始文本（测试 INVALID_JSON_BODY）。 */
  notJsonAtAll: (): FakeBehavior => () => ({ rawText: '<html>502 Bad Gateway</html>', status: 200 }),

  /** 组合：按调用序号依次给出不同行为。 */
  sequence: (...steps: Array<FakeReply | FakeBehavior>): FakeBehavior => {
    let n = 0;
    return (ctx) => {
      const step = steps[Math.min(n, steps.length - 1)];
      n++;
      return typeof step === 'function' ? step(ctx) : step;
    };
  },
};
