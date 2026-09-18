/**
 * LLM 角色运行器：把「角色」变成一次受 schema 约束的模型调用。
 *
 * 三个关键机制：
 *  1. **读权限在代码里强制**：上下文装配时只放入该角色可读的工件类型。
 *     不是「在提示词里请求它别看别人的东西」—— 它根本拿不到。
 *  2. **schema 门禁 + 结构化重试**：校验失败不是盲目重试，而是把**具体的校验错误**
 *     回喂给模型让它修正，这比「重试三次取最好」有效得多，也便宜得多。
 *  3. **purpose 路由键**：`produce:CodeModule:api` 这种稳定的键既用于 MockProvider 路由，
 *     也用于 runs/ 回放录制 —— 同一输入必然命中同一条记录。
 */

import {
  ARTIFACT_CONTENT_SCHEMAS,
  buildRepairHint,
  formatSchemaErrors,
  validateSchema,
  type JsonSchema,
} from '../../core/src/schemas.ts';
import type { ArtifactKind, RoleId, WorkOrder } from '../../core/src/types.ts';
// LlmRequest 属于 llm 包（原写成从 core 导入 —— 那个成员不存在，且运行时被擦除所以从不报错）
import type { LlmRequest } from '../../llm/src/types.ts';
import type { Logger } from '../../core/src/logger.ts';
import { silentLogger } from '../../core/src/logger.ts';
import type { LlmProvider } from '../../llm/src/types.ts';
import { ROLE_SYSTEM_PROMPTS, ROLE_TEMPERATURE } from './prompts.ts';
import {
  READ_PERMISSIONS,
  type ProduceRequest,
  type ProduceResult,
  type RoleContext,
  type RoleRunner,
} from './types.ts';

export type LlmRoleRunnerOptions = {
  role: RoleId;
  provider: LlmProvider;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** 结构化重试上限。 */
  maxAttempts?: number;
  model?: string;
  logger?: Logger;
  /** 单个工件在上下文里最多渲染多少字符（防止上下文爆炸）。 */
  maxContextChars?: number;
};

/**
 * 稳定的 purpose 键。Mock 路由与回放录制都依赖它。
 */
export function purposeFor(action: 'produce' | 'repair' | 'roundtable', kind?: ArtifactKind, scope?: string): string {
  if (action === 'roundtable') return `roundtable:${kind ?? 'session'}`;
  return `${action}:${kind}${scope ? `:${scope}` : ''}`;
}

/**
 * 把**项目自己的约定**明确告诉角色。
 *
 * 存在的理由（真实 LLM 实测发现的缺陷，见 docs/07 §L5）：
 * 第一次用真实模型跑完整流程时，A4（编译）报了 7 个错误、A5（测试）也失败，
 * 根因**只有一个**：模型写的相对导入没有 `.ts` 扩展名，例如
 * `import { createApp } from './app'`。
 *
 * 而这不是模型的错 —— 那对绝大多数 TS 项目是完全正常的写法。
 * 是这个项目的 tsconfig 要求显式扩展名（`allowImportingTsExtensions` +
 * `moduleResolution: NodeNext`），而**没有人告诉模型这件事**。
 *
 * 关键认识：**这类失败看起来像「模型能力不足」，实际是「约定没有传达」。**
 * 锚点判得完全正确（那确实是编译错误），错的是编排层没把约定说清楚 ——
 * 于是模型按另一套规则写代码，然后被按这一套规则判定。
 *
 * 约定必须来自 profile，而不是在提示词里写死一条通用建议：
 * 不同项目约定不同，写死会让 AgentForge 只能生成跟它自己一模一样的项目。
 */
/**
 * 导出是为了**可测**：经验注入的角色白名单（只有 frontend/backend/test 收经验）
 * 必须有一条能真的失败的测试守着。不导出的话它就只是一个私有实现细节，
 * 改错了没有任何东西会报警 —— 而「没人检查的规则就只是措辞」是这个项目反复吃过的亏（§6.9）。
 */
export function renderConventions(ctx: RoleContext, role: RoleId): string {
  const lines: string[] = [];

  lines.push(`语言：TypeScript；源码目录：${ctx.profile.srcDir}；tsconfig：${ctx.profile.tsconfigPath}`);

  // 相对导入扩展名这件事由 tsconfig 的选项推出，不是凭空写死的建议。
  // Node 原生类型剥离（生成的代码要能被 node 直接运行）要求相对导入带显式扩展名。
  lines.push(
    '相对导入必须带**显式文件扩展名**（例如 `./app.ts`、`../shared/contract-types.ts`）。' +
      '本项目的代码由 Node 原生类型剥离直接运行，且 tsconfig 开启了 allowImportingTsExtensions —— ' +
      '写成 `./app` 会同时导致编译失败（TS2835）与运行期无法解析模块。' +
      '这与多数前端项目（bundler 解析、或写 `.js` 后缀）的做法不同，请以本条为准。',
  );

  lines.push('只允许使用 Node 内置模块与已声明的依赖，不要引入未声明的第三方包。');

  // 项目声明的环境约束 —— 由**项目**决定，而不是引擎硬编码（见 ProjectProfile.environmentNotes）
  for (const note of ctx.profile.environmentNotes ?? []) {
    lines.push(note);
  }

  /**
   * 记忆系统供给的经验 —— 与 `environmentNotes` **同一个通道**，但必须与它可区分。
   *
   * 为什么同一个通道：`docs/HANDOFF.md §8.0-mem` 已经定过关系 ——
   * `environmentNotes` 本来就是「项目声明的约定，引擎原样注入」，
   * 记忆系统是它的**自动供给**，不该另起一套机制。
   *
   * 为什么必须可区分（三点，都不是形式主义）：
   * 1. **来源不同**：`environmentNotes` 是人写的、持久的；经验是机器归纳的、会失效、会被反证。
   * 2. **谁收到不同**：只有写代码/写测试的角色收到经验。PM 的产出就是判定基准
   *    （Requirement / Contract），主理人是对抗审查方 —— 两者收到经验改变的是**判定性质**，
   *    不只是产出。这是 A8 那条边界（被验证者不得改验证基准）在提示词层面的延伸。
   * 3. 语义验证器以 `test` 身份运行，但它是 `SemanticVerifier` 这个**另一个类**，
   *    构造上下文走 `buildVerifierContext`，**不引用 memoryNotes** ——
   *    这条由 `packages/memory/test/memory-boundary.test.ts` 扫真实上下文来守，不靠这段注释。
   */
  const memoryRoles: RoleId[] = ['frontend', 'backend', 'test'];
  if (memoryRoles.includes(role) && (ctx.memoryNotes?.length ?? 0) > 0) {
    lines.push(
      '【以下来自本项目历次真实运行总结的经验 —— 与上面「项目约定」不同，' +
        '这些是**系统自己归纳的**，可能不适用于其它项目】',
    );
    for (const note of ctx.memoryNotes!) lines.push(note);
  }

  if (ctx.profile.typecheck) {
    lines.push(
      `编译检查命令是 \`${ctx.profile.typecheck.cmd} ${ctx.profile.typecheck.args.join(' ')}\`，你的产出必须能通过它。`,
    );
  } else {
    lines.push('当前没有可执行的编译检查命令 —— 你的产出不会被类型检查，请自行保证类型正确。');
  }
  if (ctx.profile.test) {
    lines.push(`测试命令是 \`${ctx.profile.test.cmd} ${ctx.profile.test.args.join(' ')}\`，测试必须能被它真的跑起来。`);
  }

  // ── 启动命令（真实 LLM 实测补上的，见 docs/07 §L8）────────────────
  //
  // 之前这里只说了编译与测试命令，**没说启动命令**，而 profile 里明明有 run/healthUrl。
  // 后果实测到了：backend 角色写出的入口文件只导出了 `startServer()`，
  // 顶层从不调用它 —— `node src/api/server.ts` 加载完模块就 exit 0，服务根本没起来。
  // 两个独立锚点同时报错：A6「服务进程在就绪前退出（exit 0）」，
  // 以及 A5 里所有依赖真实 HTTP 的测试连接失败。
  //
  // 模型的写法本身不算错（导出工厂函数便于测试），错的是**没人告诉它入口必须自启**。
  // 这是 §L5/§L7 的同一类问题：锚点判得对，但根因是约定没传达。
  // ── 项目契约文件（真实 LLM 实测补上的，见 docs/HANDOFF.md §8.1）──────
  //
  // 第 12 轮真实运行里，backend 角色在 CodeModule 里附了一份**自己写的
  // package.json 与 tsconfig.json**，把项目契约整个换掉了：
  // 删掉 agentforge.healthUrl（A6 于是静默 SKIPPED）、删掉 environmentNotes、
  // 把测试命令换成在本环境跑不通的那条，并用 tsconfig 的 exclude 把测试排除出类型检查。
  //
  // 模型的动机几乎肯定是好的（「帮项目补上 package.json」是很常见的做法），
  // 但在这个系统里它是**被验证者改动了验证基准**。
  // 引擎侧已经有硬性阻断（core/src/projectcontract.ts + A8 锚点 + 编排器的两个写盘入口），
  // 这里补上事前的告知 —— 因为「先告诉它，再拦它」比「拦下来再让它返工」便宜得多。
  // 这是 §L5/§L7/§L8 那条规律的第四次应用：**约定没传达，失败就会长得像能力不足。**
  const contractFiles = ['package.json', ...(ctx.profile.protectedFiles ?? [])];
  lines.push(
    `**不要在你的产出里附带项目契约文件**（${contractFiles.join('、')} 等）。` +
      '它们已经存在、由项目方声明，是编译/测试/运行检查的基准 —— ' +
      '引擎会保留项目原值并把它记为一次契约违规（A8 锚点 FAIL）。' +
      '你只负责写自己范围内的源码文件；确实需要新增依赖或脚本时，在说明里提出，不要直接改写这些文件。',
  );

  if (ctx.profile.run) {
    const r = ctx.profile.run;
    lines.push(`启动命令是 \`${r.cmd} ${r.args.join(' ')}\`，服务必须在该命令下真正启动并持续监听。`);
    lines.push(
      '入口文件**被直接执行时必须自己启动服务**（例如在顶层调用 listen）。' +
        '「只导出 startServer / createServer 而不在顶层调用」会让进程立刻退出 —— ' +
        '这在实测里是最常见的失败形态：测试能过（测试自己调用工厂函数），' +
        '但运行时锚点会报「服务进程在就绪前退出」。',
    );
    if (r.healthUrl) {
      lines.push(`健康检查地址是 ${r.healthUrl}，该端点必须返回 2xx，且响应体符合契约。`);
    }
  }

  return `【项目约定（必须遵守）】\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

export class LlmRoleRunner implements RoleRunner {
  readonly role: RoleId;
  private provider: LlmProvider;
  private temperature: number;
  private maxAttempts: number;
  private model?: string;
  private maxTokens?: number;
  private reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  private logger: Logger;
  private maxContextChars: number;

  constructor(opts: LlmRoleRunnerOptions) {
    this.role = opts.role;
    this.provider = opts.provider;
    this.temperature = opts.temperature ?? ROLE_TEMPERATURE[opts.role];
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
    this.reasoningEffort = opts.reasoningEffort;
    this.logger = opts.logger ?? silentLogger(`role:${opts.role}`);
    this.maxContextChars = opts.maxContextChars ?? 24_000;
  }

  async produce(req: ProduceRequest, ctx: RoleContext): Promise<ProduceResult> {
    return this.runWithRetry(req, ctx, 'produce');
  }

  async repair(order: WorkOrder, ctx: RoleContext): Promise<ProduceResult> {
    const target = typeof order.target === 'string' ? order.target : order.target.newKind;
    const kind: ArtifactKind = typeof target === 'string' && target.includes('CodeModule') ? 'CodeModule' : (target as ArtifactKind);
    const req: ProduceRequest = {
      kind,
      ...(order.target && typeof order.target !== 'string' && order.target.scope
        ? { scope: order.target.scope }
        : {}),
      instruction: [
        `你收到一张派工单 ${order.id}，必须修复下列问题。`,
        `验收条件（必须逐条满足）：`,
        ...order.acceptance.map((a, i) => `  ${i + 1}. ${a}`),
        '',
        '问题详情：',
        JSON.stringify(order.reason, null, 2).slice(0, 4000),
      ].join('\n'),
    };
    return this.runWithRetry(req, ctx, 'repair');
  }

  private async runWithRetry(
    req: ProduceRequest,
    ctx: RoleContext,
    action: 'produce' | 'repair',
  ): Promise<ProduceResult> {
    const schema = ARTIFACT_CONTENT_SCHEMAS[req.kind];
    if (!schema) {
      return { kind: req.kind, content: null, attempts: 0, schemaError: `未知工件类型 ${req.kind}` };
    }

    let repairHint: string | undefined;
    let lastError = '';
    let lastLlm: ProduceResult['llm'];

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const request = this.buildRequest({ role: this.role, req, ctx, action, repairHint, attempt });
      const res = await this.provider.complete(request);
      lastLlm = {
        provider: res.provider,
        model: res.model,
        runId: res.runId,
        latencyMs: res.latencyMs,
      };

      // 模型没返回可用 JSON（例如降级到 prompt-only 模式时）
      if (res.json === undefined) {
        lastError = res.parseError ?? '模型未返回可解析的 JSON';
        repairHint = `你上一次的回复不是合法的 JSON（${lastError}）。请只输出一个 JSON 对象，不要任何解释文字或 Markdown 围栏。`;
        this.logger.warn(`${this.role} 第 ${attempt + 1} 次产出无法解析，将重试`, { purpose: request.purpose });
        continue;
      }

      const errors = validateSchema(res.json, schema, schema);
      if (errors.length === 0) {
        return { kind: req.kind, content: res.json, attempts: attempt + 1, ...(lastLlm ? { llm: lastLlm } : {}) };
      }

      lastError = formatSchemaErrors(errors);
      repairHint = buildRepairHint(errors);
      this.logger.warn(`${this.role} 第 ${attempt + 1} 次产出未过 schema，回喂错误后重试`, {
        purpose: request.purpose,
        errors: errors.length,
      });
    }

    // 结构化重试全部失败：如实报告，不伪造工件。
    // 上层会把这次失败当作一个确定性失败处理（生成工单或升级），而不是把坏工件写进库里。
    return {
      kind: req.kind,
      content: null,
      attempts: this.maxAttempts,
      schemaError: `结构化重试 ${this.maxAttempts} 次后仍未通过 schema 校验：\n${lastError}`,
      ...(lastLlm ? { llm: lastLlm } : {}),
    };
  }

  /** 构造请求。导出以便测试断言「上下文里只有该角色有权读的工件」。 */
  buildRequest(args: {
    role: RoleId;
    req: ProduceRequest;
    ctx: RoleContext;
    action: 'produce' | 'repair';
    repairHint?: string;
    attempt: number;
  }): LlmRequest {
    const { req, ctx, action, repairHint, attempt } = args;
    const schema = ARTIFACT_CONTENT_SCHEMAS[req.kind] as JsonSchema;

    const messages: LlmRequest['messages'] = [
      { role: 'system', content: ROLE_SYSTEM_PROMPTS[this.role] },
      { role: 'user', content: this.renderContext(req, ctx) },
    ];

    if (repairHint) {
      messages.push({ role: 'assistant', content: '(上一次输出因未通过校验被退回)' });
      messages.push({ role: 'user', content: repairHint });
    }

    return {
      role: this.role,
      purpose: purposeFor(action, req.kind, req.scope),
      messages,
      schema,
      schemaName: req.kind,
      temperature: this.temperature,
      attempt,
      ...(this.model ? { model: this.model } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    };
  }

  private renderContext(req: ProduceRequest, ctx: RoleContext): string {
    const readable = new Set(READ_PERMISSIONS[this.role]);
    const parts: string[] = [];

    parts.push(`【当前阶段】${ctx.stage}`);
    parts.push(`【用户的原始诉求】\n${ctx.userBrief}`);
    parts.push(renderConventions(ctx, this.role));

    if (ctx.directives.length > 0) {
      parts.push(
        `【真人用户的建议书（优先级最高，不可违背、不可重新解释）】\n` +
          ctx.directives
            .map((d, i) => `${i + 1}. [${d.kind}] ${d.text}${d.constraints ? `\n   硬约束：${d.constraints.join('；')}` : ''}`)
            .join('\n'),
      );
    }

    if (ctx.contractHash) {
      parts.push(
        `【冻结契约 hash】${ctx.contractHash}\n` +
          `下游工件必须绑定这个 hash。契约已冻结，任何一方都不得单方面改动。`,
      );
    }

    if (req.scope) parts.push(`【你负责的范围】${req.scope}`);
    if (req.taskId) parts.push(`【对应任务】${req.taskId}`);
    if (req.requirementIds?.length) parts.push(`【对应需求】${req.requirementIds.join(', ')}`);

    // 接口化通信的核心：只放入该角色**有权读**的工件（代码里过滤，不靠提示词约束）
    const blocks: string[] = [];
    let budget = this.maxContextChars;
    for (const kind of readable) {
      const arts = ctx.store.heads(kind);
      for (const a of arts) {
        const role = a.producer;
        // 同一角色自己的历史产出可以看（便于版本接续），别人的只读公开发布的工件
        const body = JSON.stringify(a.content, null, 2);
        if (body.length > budget) continue;
        budget -= body.length;
        blocks.push(`--- 工件 ${a.id}（${a.kind}${a.scope ? `/${a.scope}` : ''} by ${role} v${a.version}）---\n${body}`);
        if (budget <= 0) break;
      }
      if (budget <= 0) break;
    }

    parts.push(
      blocks.length > 0
        ? `【你可读的工件（这就是你与其他角色之间的全部通信内容）】\n${blocks.join('\n\n')}`
        : `【你可读的工件】目前没有任何已发布的工件。`,
    );

    if (ctx.workOrders.length > 0) {
      parts.push(
        `【你当前持有的工单】\n` +
          ctx.workOrders
            .map((o) => `- ${o.id} → ${o.to}：${JSON.stringify(o.reason).slice(0, 300)}\n  验收：${o.acceptance.join('；')}`)
            .join('\n'),
      );
    }

    parts.push(`【本次任务】\n${req.instruction}`);
    parts.push(`【输出要求】严格输出符合 ${req.kind} schema 的单个 JSON 对象，不要任何额外文字。`);

    return parts.join('\n\n');
  }
}

/** 为五个角色各建一个运行器（共用一个 Provider）。 */
export function createRoleRunners(
  provider: LlmProvider,
  opts: { logger?: Logger; model?: string } = {},
): Record<RoleId, LlmRoleRunner> {
  const roles: RoleId[] = ['pm', 'frontend', 'backend', 'test', 'host'];
  const out = {} as Record<RoleId, LlmRoleRunner>;
  for (const role of roles) {
    out[role] = new LlmRoleRunner({
      role,
      provider,
      ...(opts.logger ? { logger: opts.logger.child(role) } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
  }
  return out;
}

/**
 * 按**角色绑定**创建运行器：每个角色可以有独立的 provider / 模型 / 温度 / 上限。
 *
 * 这是「给用户找他期望的 LLM 的权利」真正生效的地方 ——
 * 同一场 run 里，主理人可以用推理模型（找茬质量最关键），
 * 前后端用便宜的模型（代码量大、锚点会兜底），测试用长上下文模型（要读全部代码）。
 */
export function createBoundRoleRunners(
  providers: Record<RoleId, LlmProvider>,
  bindings: Partial<
    Record<
      RoleId,
      { temperature?: number; maxTokens?: number; model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' }
    >
  >,
  opts: { logger?: Logger; maxAttempts?: number } = {},
): Record<RoleId, LlmRoleRunner> {
  const roles: RoleId[] = ['pm', 'frontend', 'backend', 'test', 'host'];
  const out = {} as Record<RoleId, LlmRoleRunner>;
  for (const role of roles) {
    const b = bindings[role] ?? {};
    out[role] = new LlmRoleRunner({
      role,
      provider: providers[role],
      ...(b.temperature !== undefined ? { temperature: b.temperature } : {}),
      ...(b.maxTokens !== undefined ? { maxTokens: b.maxTokens } : {}),
      ...(b.model !== undefined ? { model: b.model } : {}),
      ...(b.reasoningEffort !== undefined ? { reasoningEffort: b.reasoningEffort } : {}),
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.logger ? { logger: opts.logger.child(role) } : {}),
    });
  }
  return out;
}
