/**
 * 角色运行器接口。
 *
 * 「接口即通信」（docs/04）在类型上的落地：
 *  - 角色**读不到**它无权读的工件（context 装配时就过滤掉，不是靠提示词请求它别看）
 *  - 角色**写不出**不合 schema 的工件（产出必须过 core 的 schema 校验，失败则结构化重试）
 *  - 角色之间没有对话通道，只有 produce/repair 两个动作，产物是类型化工件
 */

import type {
  ArtifactKind,
  CodeScope,
  LlmRequest,
  LlmResponse,
  ProjectProfile,
  RoleId,
  StageId,
  WorkOrder,
} from '../../core/src/types.ts';
import type { ArtifactStore } from '../../core/src/store.ts';

/** 角色可读工件矩阵：接口化通信的「读权限」一侧。 */
export const READ_PERMISSIONS: Record<RoleId, ArtifactKind[]> = {
  pm: ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'TestReport', 'Directive', 'DebtRecord', 'AnchoredReview'],
  frontend: ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'CodeModule', 'TestSuite', 'TestReport', 'Directive'],
  backend: ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'CodeModule', 'TestSuite', 'TestReport', 'Directive'],
  test: ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'CodeModule', 'TestSuite', 'Directive'],
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
