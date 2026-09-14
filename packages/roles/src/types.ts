/**
 * 角色运行器接口。
 *
 * 「接口即通信」（docs/04）在类型上的落地：
 *  - 角色**读不到**它无权读的工件（context 装配时就过滤掉，不是靠提示词请求它别看）
 *  - 角色**写不出**不合 schema 的工件（产出必须过 core 的 schema 校验，失败则结构化重试）
 *  - 角色之间没有对话通道，只有 produce/repair 两个动作，产物是类型化工件
 */

import type { ArtifactKind, CodeScope, ProjectProfile, RoleId, StageId, WorkOrder } from '../../core/src/types.ts';
import type { ArtifactStore } from '../../core/src/store.ts';
// LlmRequest / LlmResponse 属于 llm 包，不在 core 里。
// 原来写 `from '../../core/src/types.ts'` —— 那两个成员根本不存在，
// 但因为 `import type` 会在运行时被整行擦除，这个错**从来没有暴露过**。
import type { LlmRequest, LlmResponse } from '../../llm/src/types.ts';

/** 角色可读工件矩阵：接口化通信的「读权限」一侧。 */
export const READ_PERMISSIONS: Record<RoleId, ArtifactKind[]> = {
  pm: ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'TestReport', 'Directive', 'DebtRecord', 'AnchoredReview'],
  frontend: ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'CodeModule', 'TestSuite', 'TestReport', 'Directive'],
  backend: ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'CodeModule', 'TestSuite', 'TestReport', 'Directive'],
  /**
   * ⚠️ `TestReport` 曾经**漏了**（真实 LLM 实测发现，docs/07 §L12）。
   *
   * 语义验证器（判断「需求是否达成」的那个）正是以 `test` 角色身份运行的，
   * 而它的系统提示写明「只能引用你确实看到的工件；没看到就填 uncertain 并说明缺什么」。
   * 于是它每一轮都如实报 uncertain，理由一模一样：
   *
   *   「实现层有可见证据……但 R-001 的三条验收全部依赖运行时验证，
   *     上下文中不存在任何测试文件与 npm run test 输出」
   *
   * 结果是 45% 的需求判定落在 uncertain —— 而缺的那个事实（测试到底跑没跑过、
   * 退出码是多少、过了几条）**系统本来就有**，只是没给到它手上。
   *
   * 注意这不是「放宽标准」：TestReport 里是**执行事实**（命令、退出码、通过/失败数、
   * 失败用例名），正是判定「需求是否达成」最该依据的东西。
   * 而且它由编排器从 A5 的真实执行固化（见 orchestrator.publishTestReport），
   * 不是 LLM 编的。
   */
  test: ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'CodeModule', 'TestSuite', 'TestReport', 'Directive'],
  // 主理人必须能读到全部代码与契约才能审查 —— 但**不能写**它们（写权限矩阵另一侧）
  host: [
    'Requirement',
    'PRD',
    'TaskGraph',
    'Contract',
    'CodeModule',
    'TestSuite',
    'TestReport',
    'Directive',
    'DebtRecord',
  ],
};

export type RoleContext = {
  stage: StageId;
  store: ArtifactStore;
  profile: ProjectProfile;
  /** 该角色当前持有的工单。 */
  workOrders: WorkOrder[];
  /** 冻结契约 hash，下游必须绑定。 */
  contractHash: string | null;
  /** 原始用户诉求文本。 */
  userBrief: string;
  /** 已激活的真人建议书（优先级最高）。 */
  directives: Array<{ kind: string; text: string; constraints?: string[] }>;
};

export type ProduceRequest = {
  kind: ArtifactKind;
  scope?: CodeScope;
  taskId?: string;
  requirementIds?: string[];
  /** 本次产出的具体指令（由编排器根据阶段与工单生成）。 */
  instruction: string;
};

export type ProduceResult = {
  kind: ArtifactKind;
  content: unknown;
  /** 结构化重试次数（schema 校验失败后回喂错误重试）。 */
  attempts: number;
  /** schema 校验最终失败时的错误说明。 */
  schemaError?: string;
  llm?: { provider: string; model: string; runId: string; latencyMs: number };
};

export type RoleRunner = {
  role: RoleId;
  /** 按需产出工件。 */
  produce(req: ProduceRequest, ctx: RoleContext): Promise<ProduceResult>;
  /** 针对派工单修复既有工件（返回新版本内容）。 */
  repair(order: WorkOrder, ctx: RoleContext): Promise<ProduceResult>;
};

/** 构造发给 LLM 的请求（供测试断言 prompt 内容与结构）。 */
export type LlmRequestBuilder = (args: {
  role: RoleId;
  req: ProduceRequest;
  ctx: RoleContext;
  repairHint?: string;
  attempt: number;
}) => LlmRequest;

export type { LlmRequest, LlmResponse };
