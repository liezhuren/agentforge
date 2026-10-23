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
import type { Artifact, ArtifactKind, CodeModule, RoleId, WorkOrder } from '../../core/src/types.ts';
import type { ArtifactStore } from '../../core/src/store.ts';
import { digestContract } from '../../core/src/contractdigest.ts';
import { renderModuleCards } from './modulecard.ts';
// LlmRequest 属于 llm 包（原写成从 core 导入 —— 那个成员不存在，且运行时被擦除所以从不报错）
import type { LlmContextReport, LlmRequest } from '../../llm/src/types.ts';
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
    this.maxContextChars = opts.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
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
    /**
     * 本次调用的上下文预算。正常情况下就是 `maxContextChars`，
     * 只有在**模型明确报「上下文超长」**时才会被减半重试（见下面的 catch）。
     *
     * 为什么要这条兜底：预算默认 6 万字符，正常项目远远用不到窗口上限，
     * 但「换一个更小的模型」「换一个限制更严的网关」「项目再大一轮」都会让
     * 请求突然超长。那时如果直接抛错，整轮 run 会因为**一次可自适应的失败**而终止 ——
     * 这是最不划算的失败方式（已经烧掉的 token 全都白烧）。
     */
    let contextBudget = this.maxContextChars;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const request = this.buildRequest({ role: this.role, req, ctx, action, repairHint, attempt, contextChars: contextBudget });

      let res;
      try {
        res = await this.provider.complete(request);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (CONTEXT_OVERFLOW_RE.test(msg) && contextBudget >= MIN_CONTEXT_CHARS * 2) {
          const next = Math.floor(contextBudget / 2);
          this.logger.warn(`${this.role} 的上下文超出模型窗口，预算 ${contextBudget} → ${next} 后重试`, {
            purpose: request.purpose,
          });
          contextBudget = next;
          // 不算一次「产出失败」：这是同一份任务的同一轮，只是换了更小的上下文
          attempt--;
          continue;
        }
        throw e;
      }

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
    /** 覆盖本次的上下文预算（上下文超长后减半重试用）。省略即用 `maxContextChars`。 */
    contextChars?: number;
  }): LlmRequest {
    const { req, ctx, action, repairHint, attempt } = args;
    const schema = ARTIFACT_CONTENT_SCHEMAS[req.kind] as JsonSchema;

    const rendered = this.renderContext(req, ctx, args.contextChars ?? this.maxContextChars);
    const messages: LlmRequest['messages'] = [
      { role: 'system', content: ROLE_SYSTEM_PROMPTS[this.role] },
      { role: 'user', content: rendered.text },
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
      // 输入审计：这一行让「模型到底看到了什么」在 run 日志里可查
      context: rendered.report,
      ...(this.model ? { model: this.model } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    };
  }

  private renderContext(
    req: ProduceRequest,
    ctx: RoleContext,
    budget: number,
  ): { text: string; report: LlmContextReport } {
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
    const selection = selectContext({
      store: ctx.store,
      readable,
      role: this.role,
      req,
      budget,
    });

    parts.push(
      selection.blocks.length > 0
        ? `【你可读的工件（这就是你与其他角色之间的全部通信内容）】\n${selection.blocks.join('\n\n')}`
        : `【你可读的工件】目前没有任何已发布的工件。`,
    );

    // ⚠️ 省略必须是**看得见**的。
    //
    // 但只「告诉模型」不够 —— 第 21 轮实测证明模型会**无视**这条提示继续盲写
    // （它没有别的选择：不给规格它也只能写）。所以这件事同时被记进 run 日志
    // （`LlmContextReport`），让「输入被饿死」变成一个**可查的事故**，
    // 而不是一句可能被忽略的提示词。
    if (selection.omitted.length > 0) {
      parts.push(
        `【因上下文预算未注入的工件 —— 你没看到它们，不代表它们不存在】\n` +
          selection.omitted
            .map((o) => `- ${o.id}（${o.kind}）：${o.chars} 字符，${o.reason === 'tier-cap' ? '所属分层的额度已用完' : '剩余预算放不下'}`)
            .join('\n') +
          `\n如果你的任务依赖上面的工件，请在产出里**明确说明你缺什么**，不要凭猜测编写。`,
      );
    }

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

    return { text: parts.join('\n\n'), report: selection.report };
  }
}

/**
 * 上下文预算的默认值。
 *
 * ── 这个数字的两次修正（都是被真实失败逼出来的）───────────────────
 *
 * 第一次（第 14 轮）：6.6 万字符的契约被整体跳过 → 补了「放不下就压成摘要」。
 *
 * 第二次（第 21 轮，`docs/07 §R`）：摘要修好之后，**预算的分配方式**仍然是主角。
 * 24,000 字符被「需求 + PRD + 任务图」吃掉 22,824（95%），
 * 于是契约只能塞进摘要，**全部代码模块与全部测试报告一件都进不去**：
 * 后端在不知道别人导出了什么的情况下写分发逻辑（28/39 测试挂 501 的成因），
 * 在看不到测试报告的情况下修 bug（6 轮不收敛的成因）。
 *
 * ── 为什么是 6 万，而不是「干脆给 60 万」──────────────────────────
 *
 * 提高预算只能治**表面**，而且会和这个项目的初衷冲突：AgentForge 的价值就在于
 * **把复杂任务切小、降低单个模型面对的上下文压力**，模型之间的信息传递**只传接口**。
 * 把全部源码堆进一个上下文，等于把多角色系统退化成单一大上下文 ——
 * 切分就白做了，而且下次项目更大时它会再次溢出。
 *
 * 所以正确的修法是**两条一起**：
 *   ① 预算从 24,000 提到 60,000（约 2.8 万 token，仍然是个「小任务」的量级）
 *   ② 代码类工件改成**接口卡**（`modulecard.ts`）：只给导出签名，不给实现。
 *      11 个模块的全部签名约 5 千字符，而它们的全文是 20 万字符 —— 差 40 倍。
 *
 * 前者保证「装得下该装的东西」，后者保证「该装的东西本来就不大」。
 * 只做前者会不断膨胀；只做后者会连契约都挤不进去。
 */
export const DEFAULT_MAX_CONTEXT_CHARS = 60_000;

/**
 * 预算的下限：减半重试不会把上下文缩到「等于没给」。
 * 低于这个值再退，就只剩一句「你自己猜吧」—— 那时如实失败比假装在干活好。
 */
const MIN_CONTEXT_CHARS = 20_000;

/**
 * 「这次请求超出了模型上下文窗口」的错误特征。
 *
 * 各家网关的措辞不统一（OpenAI / DeepSeek / 各种中转），所以按**语义特征**匹配
 * 而不是按固定字符串。匹配失败也不要紧 —— 最坏情况是这次 run 失败并如实报错，
 * 而不是静默产出垃圾。
 */
const CONTEXT_OVERFLOW_RE =
  /context length|context_length|maximum context|too many tokens|token limit|reduce the length|prompt is too long|context window|超出.{0,6}上下文|上下文.{0,6}(超长|过长|超过)|内容过长/i;

/** 分层配额：一层一类工件，**先到先得只在本层内成立**。 */
type ContextTier = {
  label: string;
  kinds: ArtifactKind[];
  /** 占总预算的比例。 */
  share: number;
  /** 下限（字符）：预算很小时也要保证这一层能装下关键工件。 */
  min: number;
  /**
   * `full`（默认）：注入工件正文。
   * `cards`：**不注入正文**，只注入该层模块的导出签名（见 `modulecard.ts`）。
   * 这是「模型之间的信息传递只传接口」这条规则在代码层的一次落地。
   */
  mode?: 'full' | 'cards';
};

/**
 * ⚠️ 分层顺序本身就是设计决定，不是实现细节。
 *
 * 旧的实现是「按 `READ_PERMISSIONS` 的顺序把所有工件塞进同一个池子」，
 * 而那个顺序恰好把**体积最大、最不可压缩**的散文排在最前面
 * （Requirement / PRD / TaskGraph），把**最关键的**（Contract / TestReport）
 * 排在最后。于是预算在到达关键工件之前就耗尽了。
 *
 * 分层的理由是**失效后果不同**：
 *   - 没有契约 → 接口必然写错（无法事后补救，只能返工）
 *   - 没有测试报告 → 修复是盲修（6 轮不收敛的成因）
 *   - 不知道别人导出了什么 → 不可能接线（28/39 测试挂 501 的成因）
 *   - 没有 PRD 原文 → 影响表达质量，不影响正确性（且 TaskGraph 与它高度重复）
 *
 * ⚠️ 注意「知道别人导出了什么」和「读到别人的实现」是**两件事**，
 * 它们被刻意拆成 `模块接口`（cards）与 `代码全文`（full）两层：
 * 前三层保证**接口与事实**永远在，第四层是**尽力而为**。
 * 这才是「切分小任务 + 只传接口」该有的形状 ——
 * 而不是把所有源码堆进一个大上下文（那等于取消了切分本身的意义）。
 */
function tiersFor(role: RoleId): ContextTier[] {
  const contract: ContextTier = { label: '规格', kinds: ['Contract'], share: 0.15, min: 4_000 };
  const facts: ContextTier = { label: '执行事实', kinds: ['TestReport', 'Directive'], share: 0.1, min: 3_000 };
  const cards: ContextTier = {
    label: '模块接口（只给导出签名，不给实现）',
    kinds: ['CodeModule', 'TestSuite'],
    share: 0.25,
    min: 6_000,
    mode: 'cards',
  };
  const bodies: ContextTier = { label: '代码全文（尽力而为）', kinds: ['CodeModule'], share: 0.25, min: 0 };
  const prose: ContextTier = {
    label: '需求与计划',
    kinds: ['Requirement', 'PRD', 'TaskGraph', 'DebtRecord', 'AnchoredReview'],
    share: 0.25,
    min: 4_000,
  };

  switch (role) {
    case 'pm':
    case 'host':
      // 这两者审规格与事实；通读实现不是它们的活
      return [contract, facts, { ...cards, share: 0.2 }, { ...bodies, share: 0.15 }, { ...prose, share: 0.4 }];
    case 'test':
      // 测试最需要「接口长什么样」与「之前挂了什么」，代码全文最不重要
      return [
        contract,
        { ...facts, share: 0.15 },
        { ...cards, share: 0.35 },
        { ...bodies, share: 0.15 },
        { ...prose, share: 0.2 },
      ];
    default:
      // backend / frontend
      return [contract, facts, cards, bodies, prose];
  }
}

export type ContextSelection = {
  blocks: string[];
  omitted: LlmContextReport['omitted'];
  report: LlmContextReport;
};

/**
 * 接口卡前面的那段说明。
 *
 * 写它不是礼貌，是**防一个特定误解**：模型可能把「接口存在」读成「实现存在」，
 * 于是不去调用别人的模块 —— 而那种失败的表现和「信息饥饿」一模一样
 * （模块导出了、没人调用），根因却完全不同。
 */
const CARD_HEADER = [
  '下面是**其他模块导出的签名**，不是它们的完整代码。这些模块由别的任务实现。',
  '你要做的是：在自己的模块里 **import 并调用**它们，构成完整的请求链路；',
  '**不要重复实现它们已有的功能**，也不要把「签名存在」当成「已经接好了」。',
  '如果你负责的是入口/分发逻辑，必须真的调用这些函数，而不是回一个占位响应（如 501）。',
].join('\n');

/**
 * 把工件渲染成提示词里的正文。
 *
 * **为什么要单独一个函数**：原来是 `JSON.stringify(content, null, 2)`。
 * 对代码类工件这是双重浪费 ——
 *   ① 2 空格缩进把体积放大一截（散文类工件里接近一半字符是缩进和换行）；
 *   ② 更糟的是**代码被 JSON 转义成了一行**（`\n` → `\\n`、引号 → `\"`），
 *      模型既难读，tokenizer 也更费（转义序列往往吃掉独立 token）。
 *
 * 所以：代码文件按**原文**贴出来（用 `<<<FILE path>>>` 分隔，不用 Markdown 围栏 ——
 * 代码里可能出现 ``` ），其余字段仍用紧凑 JSON。这不是性能优化，
 * 是为了让「同 100k 字符」装下更多真实信息。
 */
export function renderArtifactBody(content: unknown): string {
  const maybe = content as { files?: unknown } | null;
  const files = maybe?.files;
  if (Array.isArray(files) && files.length > 0) {
    const ok = files.every(
      (f) => f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string' && typeof (f as { content?: unknown }).content === 'string',
    );
    if (ok) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(content as Record<string, unknown>)) if (k !== 'files') rest[k] = v;
      const head = Object.keys(rest).length > 0 ? `${JSON.stringify(rest)}\n` : '';
      const body = (files as Array<{ path: string; content: string }>)
        .map((f) => `<<<FILE ${f.path}>>>\n${f.content}\n<<<END FILE>>>`)
        .join('\n');
      return head + body;
    }
  }
  return JSON.stringify(content) ?? 'null';
}

/**
 * 按分层配额挑选要注入的工件。
 *
 * 导出是为了让「预算花在哪」这件事**可以被单元测试钉住** ——
 * 这条逻辑的 bug 曾经在系统里静默存在了 20 轮，因为它只影响提示词内容，
 * 不产生任何失败的测试。
 */
export function selectContext(args: {
  store: ArtifactStore;
  readable: Set<ArtifactKind>;
  role: RoleId;
  req: ProduceRequest;
  budget: number;
}): ContextSelection {
  const { store, readable, role, req, budget } = args;
  const blocks: string[] = [];
  const omitted: LlmContextReport['omitted'] = [];
  const injected: LlmContextReport['injected'] = [];

  let remaining = budget;
  let carried = 0;
  let cardsHeaderEmitted = false;

  for (const tier of tiersFor(role)) {
    if (remaining <= 0) {
      // 预算彻底用完：本层全部记为「放不下」，而不是悄悄消失
      for (const kind of tier.kinds) {
        if (!readable.has(kind)) continue;
        for (const a of store.heads(kind)) {
          const chars = tier.mode === 'cards' ? 0 : renderArtifactBody(a.content).length;
          omitted.push({ id: a.id, kind: a.kind, chars, reason: 'no-space' });
        }
      }
      continue;
    }

    const cap = Math.max(tier.min, Math.floor(budget * tier.share));
    let tierLeft = Math.min(remaining, cap + carried);

    // 本层内的排序：先按 kind 的声明顺序，再让「同 scope」优先，最后新的优先。
    // 同 scope 优先是给修复用的：后端返工时要看的是 api 代码，不是前端页面。
    const kindRank = new Map(tier.kinds.map((k, i) => [k, i]));
    const candidates: Artifact[] = [];
    for (const kind of tier.kinds) {
      if (!readable.has(kind)) continue;
      candidates.push(...store.heads(kind));
    }
    candidates.sort((a, b) => {
      const ka = kindRank.get(a.kind) ?? 99;
      const kb = kindRank.get(b.kind) ?? 99;
      if (ka !== kb) return ka - kb;
      const sa = req.scope && a.scope === req.scope ? 0 : 1;
      const sb = req.scope && b.scope === req.scope ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return b.createdAt.localeCompare(a.createdAt);
    });

    for (const a of candidates) {
      /**
       * 「接口层」：不给实现，只给导出签名。
       *
       * 这一层是**保证送达**的 —— 它便宜（11 个模块的全部签名约 5 千字符，
       * 而它们的全文是 20 万字符），而缺了它「接线」在物理上不可能。
       * 它取代了原先「要么塞全文、要么什么都看不到」的二元选择。
       */
      if (tier.mode === 'cards') {
        const files = ((a.content as CodeModule).files ?? []).map((f) => ({ path: f.path, content: f.content }));
        /**
         * ⚠️ 第一张卡前面必须带一段说明：「这是签名，不是实现」。
         *
         * 这个坑是**预判**出来的（`docs/competition/09 §F9`），不是踩出来的 ——
         * 但它的危害足够大：如果模型把「接口存在」读成「实现存在」，
         * 它就会**不去调用**别人的模块，而且不会报错 ——
         * 于是表现和「信息饥饿」一模一样（模块导出了、没人调用），
         * 但根因完全不同，修法也完全不同。
         *
         * 说明文字**算进第一张卡的长度**，而不是单独一块：
         * 报告里 `used` 必须等于所有 `injected` 之和，
         * 否则「这些字符花在哪了」就又要靠猜了（那是这一整轮的教训）。
         */
        const withHeader = !cardsHeaderEmitted;
        const allowance = withHeader ? Math.max(0, tierLeft - CARD_HEADER.length - 2) : tierLeft;
        let card = renderModuleCards([{ id: a.id, version: a.version, files }], { maxTotalChars: allowance });
        if (card.length === 0) continue;
        if (withHeader) card = `${CARD_HEADER}\n\n${card}`;
        if (card.length > tierLeft) {
          omitted.push({ id: a.id, kind: a.kind, chars: card.length, reason: 'tier-cap' });
          continue;
        }
        cardsHeaderEmitted = true;
        tierLeft -= card.length;
        remaining -= card.length;
        injected.push({ id: a.id, kind: a.kind, chars: card.length, card: true });
        blocks.push(`--- 接口 ${a.id}（${a.kind}${a.scope ? `/${a.scope}` : ''} by ${a.producer} v${a.version}）---\n${card}`);
        continue;
      }

      let body = renderArtifactBody(a.content);
      let digest: true | undefined;

      /**
       * **契约是唯一「必须送到」的工件。**
       *
       * 第 14 轮：6.6 万字符的契约被整体跳过，提示词里只剩一句 hash，
       * 后端于是照自然语言发明接口路径（A4 过、A7 报 13 个端点未实现）。
       * 策略：放不下就换成确定性摘要（实测压到 4%–6%），并说明这是摘要。
       * 有任务声明的切片时按切片裁剪，没有就整份摘要。
       */
      if (a.kind === 'Contract' && body.length > tierLeft) {
        const slice = req.contractSlice;
        const digestText = digestContract(a.content as never, { ...(slice ? { slice } : {}) });
        const note =
          `（完整契约 ${body.length} 字符，超出本次上下文预算 ${tierLeft} 字符（该层可用额度），已压缩为可执行信息；` +
          `字段描述、示例、pattern 等解释性内容未包含）\n`;
        if (note.length + digestText.length <= tierLeft) {
          body = note + digestText;
          digest = true;
        }
      }

      if (body.length > tierLeft) {
        omitted.push({
          id: a.id,
          kind: a.kind,
          chars: body.length,
          // 放不进本层，但总预算还有富余 → 是分层额度的问题，不是预算不够
          reason: body.length <= remaining ? 'tier-cap' : 'no-space',
        });
        continue;
      }

      tierLeft -= body.length;
      remaining -= body.length;
      injected.push({ id: a.id, kind: a.kind, chars: body.length, ...(digest ? { digest } : {}) });
      blocks.push(
        `--- 工件 ${a.id}（${a.kind}${a.scope ? `/${a.scope}` : ''} by ${a.producer} v${a.version}）---\n${body}`,
      );
    }

    carried = Math.max(0, tierLeft);
  }

  return {
    blocks,
    omitted,
    report: { budget, used: budget - remaining, injected, omitted },
  };
}


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
  opts: {
    logger?: Logger;
    maxAttempts?: number;
    /**
     * 上下文预算（字符）。见 `ForgeConfig.context` 的说明；
     * 省略即 `DEFAULT_MAX_CONTEXT_CHARS`（100000，第 21 轮实测后从 24000 提高）。
     */
    maxContextChars?: number;
  } = {},
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
      ...(opts.maxContextChars !== undefined ? { maxContextChars: opts.maxContextChars } : {}),
      ...(opts.logger ? { logger: opts.logger.child(role) } : {}),
    });
  }
  return out;
}
