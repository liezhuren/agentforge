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
  /**
   * 本次调用的元信息。**`usage` 必须带上**：没有它就无法回答
   * 「这次改动让上下文涨了多少 token」—— 而那个数字决定改动是否划算，
   * 不能靠字符数估算（估出来的是 2.7 字符/token 的平均值，误差不小）。
   */
  llm?: {
    provider: string;
    model: string;
    runId: string;
    latencyMs: number;
    usage?: { promptTokens: number; completionTokens: number };
  };
  /** 上下文健康状况（截断/省略了多少），供报告与测试断言。 */
  contextStats?: VerifierContextStats;
};

export type SemanticVerifierOptions = {
  provider: LlmProvider;
  maxAttempts?: number;
  temperature?: number;
  logger?: Logger;
  model?: string;
};

/**
 * 把确定性锚点（A1–A7）的最新结论渲染成一段紧凑的「事实」文本。
 *
 * 只取对「判断需求是否达成」有用、且**模型无法自己编出来**的字段：
 * 真实退出码、真实通过/失败数、真实 HTTP 状态码、失败用例名。
 * `stdoutTail` / `treeHash` 这类内部字段不渲染（既占 token 又与判定无关）。
 *
 * 必须以「事实」而非「结论」的口吻呈现 —— 所以结尾明确写了
 * 「机械通过 ≠ 需求达成」，避免验证者把它当成可以直接抄的答案。
 */
function renderAnchorFacts(ctx: RoleContext): string | null {
  const IDS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] as const;
  const META_KEYS = [
    'exitCode',
    'command',
    'passed',
    'failed',
    'failing',
    'httpStatus',
    'healthUrl',
    'errorCount',
    'endpoints',
    'missing',
    'calledPaths',
    'declared',
    'registry',
  ] as const;

  const lines: string[] = [];
  for (const id of IDS) {
    const r = ctx.store.latestAnchorRun(id);
    if (!r) continue;

    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const bits: string[] = [];
    for (const k of META_KEYS) {
      if (meta[k] === undefined) continue;
      const v = JSON.stringify(meta[k]);
      bits.push(`${k}=${v.length > 200 ? v.slice(0, 200) + '…' : v}`);
    }

    const shown = [...r.findings.filter((f) => f.severity === 'fail'), ...r.findings.filter((f) => f.severity === 'warn')].slice(0, 3);
    const detail = shown.length
      ? ' | ' + shown.map((f) => `[${f.severity}] ${f.code}: ${f.message.slice(0, 160)}`).join(' | ')
      : '';

    lines.push(`${id} [${r.verdict}] ${r.method}${bits.length ? ' — ' + bits.join(' ') : ''}${detail}`);
  }

  if (lines.length === 0) return null;

  return [
    '--- 机械检查事实（确定性锚点产出，可直接引用；这是事实不是结论）---',
    ...lines,
    '注意：机械检查通过 **不等于** 需求达成 —— A 层检查的是「代码是否自洽」' +
      '（包真实、符号存在、能编译、测试能跑、服务能起、契约一致），' +
      '它不判断「需求描述的行为是否真的被实现」。上面这些字段（退出码、通过数、' +
      'HTTP 状态码、失败用例名）是你可以引用的事实；判断仍由你来做。',
  ].join('\n');
}

/**
 * 验证器上下文的预算。**按文件分别给**，而不是一刀切截断整个文档。
 *
 * ## 为什么（一次真实测量，docs/07 §L12）
 *
 * 原来的实现是每个工件 `JSON.stringify(content, null, 2).slice(0, 8000)` ——
 * 一个 8000 字符的总闸门。后果实测出来是这样的：
 *
 *   12 轮真实运行里 **30 个 / 57 个工件被截断**（53%）；
 *   上下文里平均只显示了 **66% 的内容**，最差的两轮只有 44% / 48%。
 *
 * 而最大的那份（llm-5 的 TestSuite-002，5 个文件、24,371 字符）**只显示了三分之一**。
 * 验证者的工作恰恰是「在代码里找需求被实现的证据」—— 把它要看的代码切掉一半，
 * 然后怪它说「确认不了」，是拿错了工具去回答问题。
 *
 * ## 关键数据：按文件给预算几乎零成本
 *
 * 实测 150 个文件的字符分布：中位 1,981，90 分位 7,268，最大 13,110。
 * **只有 8 个文件超过 8000 字符。**
 * 也就是说「每个文件各给一份预算」能保住 142/150 个文件的完整性 ——
 * 而按文档切只保住了 47%。
 *
 * ## 另外两处顺带的改进
 *
 * 1. **不再用 JSON 转义代码**。`JSON.stringify` 会把整个文件压成**一行**，
 *    换行变成 `\n`、引号变成 `\"` —— 实测膨胀到源码的 **1.9 倍**。
 *    更糟的是：验证者必须引用**行号区间**，而一行转义字符串根本没法数行号。
 *    现在直接给源码，并且**每行都标上真实行号**，让它的引用能对得上。
 * 2. **截断必须说出来**。以前是静默切断，模型只能从坏掉的 JSON 里猜。
 *    现在明确写「本文件另有 N 行未显示」，让它知道边界在哪 ——
 *    「未验证 ≠ 通过」在提示词层面同样成立。
 */
export const VERIFIER_CONTEXT_BUDGETS = {
  /** 单个文件的上限（保住 149/150 个真实文件完整）。 */
  perFile: 12_000,
  /** 单个结构化工件（需求/PRD/契约等）的上限。 */
  perStructuredArtifact: 12_000,
  /** 全部上下文的安全阀：超了就整块省略后面的工件，并**如实列出省略了谁**。 */
  total: 200_000,
} as const;

export type VerifierContextStats = {
  /** 渲染进上下文的工件数。 */
  artifacts: number;
  /** 代码文件总数 / 其中被截断的个数。 */
  files: number;
  filesTruncated: number;
  /** 结构化工件里被截断的个数。 */
  artifactsTruncated: number;
  /** 因总预算被整块省略的工件 id（必须让人类看得见）。 */
  omitted: string[];
  /** 上下文总字符数（粗略的 token 代理）。 */
  chars: number;
};

/** 给代码加真实行号：验证者要引用行区间，没有行号它只能猜。 */
export function numberLines(content: string, from = 1): string {
  const lines = content.split('\n');
  const pad = String(from + lines.length - 1).length;
  return lines.map((l, i) => `${String(from + i).padStart(pad)}| ${l}`).join('\n');
}

/** 按**行边界**截断（绝不在行中间切断，否则行号与内容会错位）。 */
function truncateLines(text: string, cap: number): { text: string; hiddenLines: number } {
  if (text.length <= cap) return { text, hiddenLines: 0 };
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > cap) break;
    kept.push(l);
    used += l.length + 1;
  }
  return { text: kept.join('\n'), hiddenLines: lines.length - kept.length };
}

/** 渲染一个带 `files` 的代码工件（CodeModule / TestSuite）：逐个文件、带行号、按文件给预算。 */
function renderCodeArtifact(
  a: { id: string; kind: string; scope?: string; content: unknown },
  stats: VerifierContextStats,
): string {
  const c = a.content as { files?: Array<{ path: string; content: string }>; framework?: string; covers?: string[] };
  const files = c.files ?? [];
  const head =
    `--- ${a.id} (${a.kind}${a.scope ? `/${a.scope}` : ''})` +
    `${c.framework ? ` — framework=${c.framework}` : ''}` +
    `${c.covers?.length ? ` covers=${c.covers.join(',')}` : ''}` +
    `；共 ${files.length} 个文件 ---`;

  const parts = [head];
  for (const [i, f] of files.entries()) {
    stats.files++;
    const numbered = numberLines(f.content ?? '', 1);
    const { text, hiddenLines } = truncateLines(numbered, VERIFIER_CONTEXT_BUDGETS.perFile);
    const totalLines = (f.content ?? '').split('\n').length;
    if (hiddenLines > 0) stats.filesTruncated++;
    parts.push(
      `[文件 ${i + 1}/${files.length}] ${f.path}（${totalLines} 行）\n` +
        text +
        (hiddenLines > 0
          ? `\n…[本文件另有 ${hiddenLines} 行（共 ${totalLines} 行）未显示 —— 未显示的部分你无法确认，不要据此判 met]`
          : ''),
    );
  }
  return parts.join('\n');
}

/** 渲染结构化工件（需求/PRD/任务图/契约/测试报告）：JSON 形态本来就是它的自然形态。 */
function renderStructuredArtifact(
  a: { id: string; kind: string; scope?: string; content: unknown },
  stats: VerifierContextStats,
): string {
  const json = JSON.stringify(a.content, null, 2);
  if (json.length > VERIFIER_CONTEXT_BUDGETS.perStructuredArtifact) stats.artifactsTruncated++;
  const { text, hiddenLines } = truncateLines(json, VERIFIER_CONTEXT_BUDGETS.perStructuredArtifact);
  return (
    `--- ${a.id} (${a.kind}${a.scope ? `/${a.scope}` : ''}) ---\n` +
    text +
    (hiddenLines > 0 ? `\n…[本工件另有 ${hiddenLines} 行未显示 —— 未显示的部分不要据此判 met]` : '')
  );
}

export type VerifierContext = {
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  stats: VerifierContextStats;
};

/**
 * 构造验证器的完整上下文。
 *
 * 抽成导出函数有两个目的：
 *   1. **能被直接检查**（`scripts/dump-verifier-context.ts`）：不花一分 token
 *      就能看到验证器实际收到了什么、有多少被截断 —— 这一层以前完全不可见，
 *      而正是它悄悄丢掉了 34% 的内容。
 *   2. 能被单测断言「不许有静默截断」。
 */
export function buildVerifierContext(ctx: RoleContext): VerifierContext {
  const stats: VerifierContextStats = {
    artifacts: 0,
    files: 0,
    filesTruncated: 0,
    artifactsTruncated: 0,
    omitted: [],
    chars: 0,
  };

  const reqArt = ctx.store.head('Requirement');
  const reqs = reqArt
    ? ((reqArt.content as { requirements: Array<Record<string, unknown>> }).requirements ?? [])
    : [];

  // ── 只把「有权读」的工件渲染进上下文 ──────────────────────────
  //
  // 这里原本是一份**硬编码**的 kind 列表，而注释却写着「与 LlmRoleRunner
  // 同一套读权限纪律」—— 实际上它并没有跟随矩阵，两者已经漂移，
  // 而漂移的后果是实打实的（真实 LLM 实测，docs/07 §L12）。
  //
  // 现在直接读矩阵：**声明与实现之间不再有第二份清单可以漂移**。
  const role = 'test' as const; // 语义验证器以 test 角色身份运行
  const blocks: string[] = [];
  let used = 0;

  for (const kind of READ_PERMISSIONS[role]) {
    for (const a of ctx.store.heads(kind)) {
      const isCode = kind === 'CodeModule' || kind === 'TestSuite';
      const text = isCode ? renderCodeArtifact(a, stats) : renderStructuredArtifact(a, stats);
      // 安全阀：超预算就整块省略（不切一半），并如实记下省了谁
      if (used + text.length > VERIFIER_CONTEXT_BUDGETS.total) {
        stats.omitted.push(a.id);
        continue;
      }
      used += text.length;
      stats.artifacts++;
      blocks.push(text);
    }
  }

  // ── 机械检查事实 ──────────────────────────────────────────
  //
  // 为什么要把锚点结果也给它（真实 LLM 实测，docs/07 §L12）：
  // 验证者抱怨它缺的东西里，「npm run typecheck 退出码」「HTTP 状态码与响应体」
  // 这两类**系统早就测过了** —— A4 跑过真 tsc、A6 真的起服务打过 HTTP 探针，
  // 结果就存在锚点运行记录里。但它只被喂了**工件**，看不到锚点结果，
  // 于是只能如实报「无法确认」。
  //
  // 这不是放宽标准：给的是**事实**，不是结论。判断「需求是否达成」仍然是它的事。
  const anchorFacts = renderAnchorFacts(ctx);
  if (anchorFacts) blocks.push(anchorFacts);

  const messages = [
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
        '   代码是按**真实行号**渲染的（每行形如 `  12| const x = 1`），请直接引用那个行号。',
        '2. 只能引用你在上下文里**确实看到**的工件与代码。没看到就填 verdict="uncertain" 并说明缺少什么。',
        '   如果某处标了「另有 N 行未显示」，那部分你确实没看到 —— 不要据此判 met。',
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

  stats.chars = messages.reduce((n, m) => n + m.content.length, 0);
  return { messages, stats };
}

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

    const { messages: baseMessages, stats } = buildVerifierContext(ctx);

    // 上下文的健康状况必须留痕：截断是**有意**的（有预算），
    // 但它绝不能是**静默**的 —— 「未验证 ≠ 通过」在提示词层面同样成立。
    if (stats.filesTruncated > 0 || stats.artifactsTruncated > 0 || stats.omitted.length > 0) {
      this.logger.warn(
        `验证上下文存在截断：文件 ${stats.filesTruncated}/${stats.files}、` +
          `工件 ${stats.artifactsTruncated}、整块省略 ${stats.omitted.length}` +
          `${stats.omitted.length ? `（${stats.omitted.join(',')}）` : ''}`,
      );
    }

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
      lastLlm = {
        provider: res.provider,
        model: res.model,
        runId: res.runId,
        latencyMs: res.latencyMs,
        ...(res.usage ? { usage: { promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens } } : {}),
      };

      if (res.json === undefined) {
        lastError = res.parseError ?? '模型未返回可解析的 JSON';
        repairHint = `你上一次的输出不是合法 JSON（${lastError}）。请只输出 JSON 对象。`;
        continue;
      }

      const errors = validateSchema(res.json, requirementVerdictsSchema, requirementVerdictsSchema);
      if (errors.length === 0) {
        const parsed = res.json as { requirementVerdicts: Array<Record<string, unknown>> };
        return {
          proposals: parsed,
          attempts: attempt + 1,
          contextStats: stats,
          ...(lastLlm ? { llm: lastLlm } : {}),
        };
      }
      lastError = formatSchemaErrors(errors);
      repairHint = buildRepairHint(errors);
      this.logger.warn(`语义验证第 ${attempt + 1} 次未过 schema`, { errors: errors.length });
    }

    return {
      proposals: null,
      attempts: this.maxAttempts,
      schemaError: lastError,
      contextStats: stats,
      ...(lastLlm ? { llm: lastLlm } : {}),
    };
  }
}
