/**
 * AgentForge 领域模型。
 *
 * 设计约束（不可违反，见 docs/01-architecture.md §6 全局不变量）：
 *  - LLM 永远不是最终裁判：所有 LLM 输出以「工件」或「提议」形态存在，裁决由程序或人类做出。
 *  - 任何 PASS 必须追溯到不依赖 LLM 的事实（A 层锚点）。
 *  - 角色之间不存在未记录的共识：共识要么在工件 schema 里，要么在决策日志里。
 *  - SKIPPED ≠ PASS。
 *  - 锚点结果绑定内容 hash，内容变更即失效（STALE）。
 *
 * 本文件不使用 enum / namespace / 参数属性，以保证 Node 原生类型剥离可直接运行。
 */

// ════════════════════════════════════════════════════════════════
// 角色
// ════════════════════════════════════════════════════════════════

export const ROLE_IDS = ['pm', 'frontend', 'backend', 'test', 'host'] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** 非角色主体：编排器与真人用户。 */
export type ActorId = RoleId | 'orchestrator' | 'human';

export const ROLE_LABELS: Record<RoleId, string> = {
  pm: '产品经理',
  frontend: '前端',
  backend: '后端',
  test: '测试',
  host: '主理人',
};

// ════════════════════════════════════════════════════════════════
// 工件
// ════════════════════════════════════════════════════════════════

export const ARTIFACT_KINDS = [
  'Requirement',
  'PRD',
  'TaskGraph',
  'Contract',
  'CodeModule',
  'TestSuite',
  'TestReport',
  'AnchoredReview',
  'RoundtableMinute',
  'Directive',
  'DebtRecord',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type CodeScope = 'web' | 'api' | 'shared';

export type ArtifactId = string;
export type ObjectionId = string;
export type WorkOrderId = string;
export type RunId = string;

/**
 * 写权限矩阵（docs/04-interface-protocol.md §2）。
 * 角色只能写自己负责的工件类型，越权写入被拒绝 —— 这是「接口即通信」的强制手段之一。
 *
 * 唯一一处受控例外：`Requirement` 允许 `orchestrator` 写入。
 * 原因是「带债通过」（第三层死锁逃生）需要把受影响需求标记为 `ACCEPTED_WITH_DEBT`，
 * 这是系统记账，不是内容创作。该能力被收窄到 `ArtifactStore.markRequirementsDebt`：
 * 它**只允许改动 status 字段**，任何其它字段变化都会被拒绝。
 */
export const WRITE_PERMISSIONS: Record<ArtifactKind, ActorId[]> = {
  Requirement: ['pm', 'human', 'orchestrator'], // orchestrator 仅可用于标记带债（status 字段）
  PRD: ['pm', 'human'],
  TaskGraph: ['pm', 'human'],
  Contract: ['pm', 'human'], // 前端/后端通过「联署意见」参与，不直接改写
  CodeModule: ['frontend', 'backend'],
  TestSuite: ['test', 'frontend', 'backend'],
  /**
   * 测试报告允许 `orchestrator` 写入 —— 这是**受控例外**，理由是内容性质：
   *
   * TestReport 的字段是 `command / exitCode / passed / failed / failing`，
   * 全部是**执行事实**。LLM 不可能知道真实的退出码与通过数，
   * 让它来写只会得到一个看起来合理的编造值 —— 那正是本项目要消灭的东西。
   *
   * 原本只允许 `test` 写入，但没有任何代码路径真的产出过这个工件，
   * 而 B2 锚点会拿 TaskGraph 声明的交付物去核对工件库 ⇒
   * **只要任务图声明了 TestReport 交付物，B2 就必定失败，且重试无法修复**
   * （真实 LLM 实测发现的系统性假失败，见 docs/07 §L8）。
   *
   * 现在由 orchestrator 把 A5（真的跑了测试的那个锚点）的观测结果固化成工件。
   * `test` 权限保留：它仍可写一份补充说明，但不能声称执行数据。
   */
  TestReport: ['test', 'orchestrator'],
  AnchoredReview: ['host'],
  RoundtableMinute: ['orchestrator'],
  Directive: ['human'], // 只有真人能投建议书
  DebtRecord: ['orchestrator'],
};

/** 可以冻结的工件类型（冻结后 hash 锁定，下游只能基于同一 hash 工作）。 */
export const FREEZABLE_KINDS: ArtifactKind[] = ['Contract'];

/**
 * 单例类工件：每个项目只有一个逻辑工件，新内容产生新版本（supersedes 链）。
 * 多例类工件（CodeModule / TestSuite / AnchoredReview / RoundtableMinute /
 * Directive / DebtRecord / TestReport）每次写入默认是新的逻辑工件。
 */
export const SINGLETON_KINDS: ArtifactKind[] = ['Requirement', 'PRD', 'TaskGraph', 'Contract'];

export type AnchorId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'B1' | 'B2' | 'B3';
export type AnchorLayer = 'A' | 'B';

export type AnchorVerdict =
  | 'PASS'
  | 'FAIL'
  | 'WARN'
  | 'SKIPPED' // 未运行。绝不等于 PASS。
  | 'STALE' // 内容 hash 已变，旧结论失效
  | 'INVALID_EVIDENCE'; // B 层断言的证据核验失败 → 判定作废

/** 锚点发现的问题。targetRole 是「机械归因」，可直接生成派工单，无需 LLM 介入。 */
export type AnchorFinding = {
  code: string;
  severity: 'fail' | 'warn';
  message: string;
  file?: string;
  line?: number;
  col?: number;
  targetRole?: RoleId | 'UNRESOLVED';
  data?: unknown;
};

export type AnchorLink = {
  anchorId: AnchorId;
  runId: RunId;
  /** 被检查工件在检查时的内容 hash。内容变了 → 此结论 STALE。 */
  contentHashes: Record<ArtifactId, string>;
  verdict: AnchorVerdict;
  findings: AnchorFinding[];
  /** 产出结论所依据的方法，供人类判断该结论的权威程度。 */
  method: string;
  authority: 'authoritative' | 'approximate' | 'none';
  at: string;
  durationMs: number;
  /** 取证用的附加信息（例如被检查源码树的整体 hash、命令与退出码）。 */
  meta?: Record<string, unknown>;
};

export type Artifact<C = unknown> = {
  id: ArtifactId;
  kind: ArtifactKind;
  producer: ActorId;
  scope?: CodeScope;
  version: number;
  content: C;
  contentHash: string;
  supersedes?: ArtifactId;
  anchorChain: AnchorLink[];
  createdAt: string;
  /** 冻结后的契约 hash。任何下游工件须携带同一 hash。 */
  frozenHash?: string;
};

export type ArtifactMeta = Omit<Artifact, 'content'> & { title: string };

// ── 各工件的内容形状 ────────────────────────────────────────────

export type Requirement = {
  id: string; // R-001
  text: string;
  /** 可验证性：每条需求必须声明如何验证，否则 B2 预检打回。 */
  acceptance: string[];
  priority: 'must' | 'should' | 'could';
  /**
   * 验收状态。四个值各有明确含义，**刻意不合并**：
   *
   *   `open`                —— 尚未确认达成。B1 判 `not-met` 时也留在这里
   *                            （「确认没做到」就是「还没做到」，不需要第五个状态）
   *   `unverified`          —— **查过了，但确认不了**（B1 判 uncertain / 证据无效 / 没有判定）
   *   `met`                 —— 已确认达成（有真实证据支撑）
   *   `accepted_with_debt`  —— 明知未达成仍放行（第三层逃生）
   *
   * `unverified` 与 `open` 分开是刻意设计（真实 LLM 实测补上，docs/07 §L11）：
   * 「还没查」和「查了但说不清」是两种完全不同的处境。
   * 混在一起，就没人能回答「到底有多少需求是我们**确认不了**的」——
   * 而那恰恰是判断这套系统可信度最关键的单个数字。
   */
  status: 'open' | 'unverified' | 'accepted_with_debt' | 'met';
  origin: 'user' | 'pm' | 'directive';
};

export type PrdDoc = {
  title: string;
  summary: string;
  requirementIds: string[];
  milestones: Array<{ name: string; deliverables: string[] }>;
  nonGoals: string[];
};

export type TaskGraph = {
  tasks: Array<{
    id: string; // T-01
    title: string;
    owner: RoleId;
    scope: CodeScope;
    dependsOn: string[];
    requirementIds: string[];
    deliverable: ArtifactKind;
    acceptance: string[];
  }>;
};

export type ContractDoc = {
  version: number;
  openapi: {
    openapi: string;
    paths: Record<string, unknown>;
    components?: unknown;
  };
  jsonSchemas: Record<string, unknown>;
  generatedTypesPath: string;
  changeRequests: ChangeRequest[];
};

export type ChangeRequest = {
  id: string;
  reason: string;
  evidence: EvidenceRef[];
  impact: RoleId[];
  falsifier: Falsifier;
  status: 'proposed' | 'accepted' | 'rejected';
};

export type CodeModule = {
  files: Array<{ path: string; content: string }>;
  note?: string;
};

export type TestSuiteDoc = {
  framework: string;
  files: Array<{ path: string; content: string }>;
  /** 每条测试覆盖的需求，用于 B2 覆盖矩阵。 */
  covers: string[];
};

export type TestReportDoc = {
  command: string;
  exitCode: number;
  passed: number;
  failed: number;
  failing: Array<{ name: string; message: string }>;
};

export type AnchoredReviewDoc = {
  stage: StageId;
  objections: Objection[];
  /** 明确输出「无异议」是合法且不亏的结论（R10）。 */
  noObjection: boolean;
};

export type DirectiveDoc = {
  kind: DirectiveKind;
  text: string;
  targetRefs?: ArtifactId[];
  constraints?: string[];
  supersedes?: ArtifactId[];
  expiresAtStage?: StageId;
};

export type DebtRecordDoc = {
  stage: StageId;
  summary: string;
  unresolvedObjectionIds: ObjectionId[];
  affectedRequirementIds: string[];
  reason: 'human-unavailable' | 'roundtable-deadlock' | 'user-let-it-pass';
  at: string;
};

// ════════════════════════════════════════════════════════════════
// 锚点运行结果（对外投影，含 runId）
// ════════════════════════════════════════════════════════════════

export type AnchorRunResult = AnchorLink & {
  subjects: ArtifactId[];
  error?: string;
};

// ════════════════════════════════════════════════════════════════
// 证据与异议（docs/03-host-accountability.md §2）
// ════════════════════════════════════════════════════════════════

/** 证据引用。必须指向真实存在的东西，否则异议被判 UNFALSIFIABLE。 */
export type EvidenceRef =
  | { kind: 'file'; path: string; startLine: number; endLine: number; expect?: string }
  | { kind: 'artifact'; artifactId: ArtifactId }
  | { kind: 'anchor'; anchorId: AnchorId; runId: RunId };

export type Falsifier =
  | {
      kind: 'executable';
      command: string;
      expect: 'exit-nonzero' | 'output-matches';
      pattern?: string;
    }
  | { kind: 'question'; text: string };

export type Objection = {
  id: ObjectionId;
  stage: StageId;
  author: 'host';
  /** 无法归因时填 UNRESOLVED → 不阻断，自动触发圆桌（规则 R9 / 触发条件 T2）。 */
  targetRole: RoleId | 'UNRESOLVED';
  severity: 'blocker' | 'major' | 'minor';
  claim: string;
  evidence: EvidenceRef[];
  falsifier: Falsifier;
  proposedFix?: string;
  claimHash: string;
  evidenceHash: string;
  createdAt: string;
};

export type EvidenceCheck = {
  ref: EvidenceRef;
  ok: boolean;
  reason?: string;
};

export type ArbitrationVerdict = 'VALID' | 'UNFALSIFIABLE' | 'REFUTED';

export type Arbitration = {
  objectionId: ObjectionId;
  verdict: ArbitrationVerdict;
  /** 触发裁决的具体规则编号，供人类复查裁判是否误判。 */
  rule: string;
  reason: string;
  quotaDelta: number;
  truePositive: boolean;
  falsePositive: boolean;
  evidenceChecks: EvidenceCheck[];
  falsifierRun?: {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    matched: boolean;
    error?: string;
  };
  /** 该异议无法由机器裁决，必须由人回答（question 型 falsifier）。 */
  requiresHuman?: boolean;
  at: string;
};

// ════════════════════════════════════════════════════════════════
// 主理人账本（docs/03-host-accountability.md §4）
// ════════════════════════════════════════════════════════════════

export type HostPolicy = {
  /** R1：每阶段初始阻断额度。 */
  blockQuota: number;
  /** R2：误报扣的额度（应为真报的两倍）。 */
  refutedPenalty: number;
  /** R3：单阶段阻断尝试上限，达到即强制圆桌并终止本阶段阻断权。 */
  stageBlockLimit: number;
  /** R4：累计误报达到此值 → 观察期。 */
  probationFpThreshold: number;
  /** R5：观察期解除所需的连续「A 层全绿」阶段数。 */
  probationClearStages: number;
  /** R7：全局每阶段平均阻断尝试预算。 */
  globalBudgetPerStage: number;
  /** R6：复读惩罚开关。 */
  repeatPenalty: boolean;
};

export const DEFAULT_HOST_POLICY: HostPolicy = {
  blockQuota: 3,
  refutedPenalty: 2,
  stageBlockLimit: 3,
  probationFpThreshold: 2,
  probationClearStages: 2,
  globalBudgetPerStage: 3,
  repeatPenalty: true,
};

export type HostLedgerSnapshot = {
  stage: StageId;
  quota: number;
  blockAttempts: number;
  truePositives: number;
  falsePositives: number;
  unfalsifiable: number;
  probation: boolean;
  probationClearStages: number;
  globalBlockAttempts: number;
  /** precision = tp / (tp + fp)。UI 必须展示，让人类一眼看出这是严格审查者还是杠精。 */
  precision: number;
  /** 本阶段阻断权是否已终止（R3 触发后）。 */
  stageBlockingRevoked: boolean;
};

// ════════════════════════════════════════════════════════════════
// 派工单（docs/04-interface-protocol.md §4）
// ════════════════════════════════════════════════════════════════

export type WorkOrder = {
  id: WorkOrderId;
  stage: StageId;
  to: RoleId;
  reason:
    | { kind: 'anchor-fail'; anchorId: AnchorId; runId: RunId; detail: AnchorFinding[] }
    | { kind: 'valid-objection'; objectionId: ObjectionId }
    | { kind: 'roundtable-action'; minuteId: ArtifactId; actionIndex: number }
    | { kind: 'task-graph'; taskId: string };
  target: ArtifactId | { newKind: ArtifactKind; scope?: CodeScope };
  /** 验收条件必须可被锚点或测试机械验证，否则工单不合法。 */
  acceptance: string[];
  contractHash?: string;
  status: 'open' | 'in-progress' | 'done' | 'rejected';
  createdAt: string;
};

// ════════════════════════════════════════════════════════════════
// 圆桌会议（docs/05-roundtable-and-directive.md §1）
// ════════════════════════════════════════════════════════════════

export const ROUNDTABLE_TRIGGERS = ['T1', 'T2', 'T3', 'T4', 'T5'] as const;
export type RoundtableTrigger = (typeof ROUNDTABLE_TRIGGERS)[number];

export const TRIGGER_DESCRIPTIONS: Record<RoundtableTrigger, string> = {
  T1: '主理人本阶段阻断尝试已达上限（打回 3 次以上）',
  T2: '主理人无法将问题归因给具体角色（targetRole = UNRESOLVED）',
  T3: '两个角色对同一契约/实现给出互相矛盾的产出',
  /**
   * T4 的语义改过一次，因为它原来是「归因**分散**」的同义词，
   * 而「分散」根本不需要开会 —— 派工单天然支持一次派给多个角色。
   * 实测 12 轮真实运行开了 15 场圆桌，绝大多数是把本可以直接打回的问题拖去开会。
   * 现在它只表示「**归因完全失灵**」：一条能派出去的工单都生成不了，
   * 那才是真的无人可派、只能靠协商的处境。
   */
  T4: '执行类锚点失败且机械归因完全失灵（没有任何文件可归属，派不出工单）',
  T5: '契约变更请求影响 ≥ 2 个角色且无人认领',
};

export type RoundtableStatement = {
  role: RoleId;
  round: 1 | 2;
  claim: string;
  evidence: EvidenceRef[];
  /** 证据核验失败时，本发言被丢弃，此处记录原因。 */
  discarded?: string;
  /** 第 2 轮交叉质询时指向谁的主张。 */
  againstRole?: RoleId;
  /**
   * 第 2 轮的反驳可以携带 falsifier。
   *
   * 这是圆桌最关键的一条设计（docs/05 §1.2）：
   * **反驳若能被执行，就当场执行，用结果裁决，不听辩论。**
   * 多智能体辩论最坏的结果是「谁更会说谁赢」，而机械可执行的反驳把胜负
   * 从「表达」转移到「事实」上。
   */
  falsifier?: Falsifier;
  /** 机械主持当场执行 falsifier 的结果。 */
  falsifierOutcome?: {
    command: string;
    exitCode: number;
    matched: boolean;
    /** sustained = 反驳被证实；refuted = 反驳被证伪；inconclusive = 执行不了，无法裁决。 */
    outcome: 'sustained' | 'refuted' | 'inconclusive';
    detail?: string;
  };
};

export type RoundtableResolution = {
  attribution: RoleId | 'SHARED' | 'REQUIREMENT_DEFECT' | 'CONTRACT_DEFECT';
  decision: string;
  actions: Array<{ owner: RoleId; action: string; acceptance: string[] }>;
  contractChange?: ChangeRequest;
};

/**
 * 圆桌中被**机械确证**的事实（docs/05 §1.2）。
 *
 * 第 2 轮的反驳若能执行，就当场执行，结果分三种去向：
 *   - `refuted`      → 该反驳被证伪，**整条发言被丢弃**（不进决议的输入）
 *   - `sustained`    → 该反驳成立，成为一条机械事实，决议**不得与它矛盾**
 *   - `inconclusive` → 执行不了（命令被策略拒绝/跑不起来），不裁决，也不产生事实
 *                      （inconclusive 刻意不在此类型里：它不是事实）
 */
export type RoundtableFact = {
  /** 产生这条事实的发言在 statements 里的下标。 */
  statementIndex: number;
  /** 谁提出的反驳。 */
  role: RoleId;
  /** 反驳针对谁。 */
  against?: RoleId;
  claim: string;
  command: string;
  exitCode: number;
  outcome: 'sustained' | 'refuted';
  /**
   * 这条事实**指向**的角色。
   *
   * 反驳成立时，反驳方是对的、被质询方有问题 → 指向 `against`；
   * 反驳被证伪时，站不住的是反驳方自己的主张 → 指向 `role`。
   * 决议的归因必须落在 sustained 事实的指向集合内（或 SHARED），
   * 否则就是在归罪一个机械证据已经证明它没问题的人。
   */
  implicates: RoleId;
};

export type RoundtableMinuteDoc = {
  trigger: RoundtableTrigger;
  participants: RoleId[];
  agenda: string[];
  statements: RoundtableStatement[];
  resolution: RoundtableResolution | null;
  escalation?: 'HUMAN';
  anchorsCited: AnchorId[];
  invalidReason?: string;
  /** 本场会议当场执行的 falsifier 所确证/证伪的事实。 */
  facts?: RoundtableFact[];
  /** 为产出合法决议尝试了几次（含首次）。>1 说明发生过结构化重试。 */
  resolutionAttempts?: number;
};

// ════════════════════════════════════════════════════════════════
// 真人建议书（docs/05-roundtable-and-directive.md §2）
// ════════════════════════════════════════════════════════════════

/**
 * 真人可以发出的指令类型。
 *
 * `let-it-pass` 是**冲突解决的一半**（见 docs/05 §2 与 HANDOFF 里的原则）：
 *
 *   人可以决定「**要什么**」—— 目标、取舍、愿意承担什么风险。
 *   人不能决定「**事实是什么**」—— 编译过没过、测试跑没跑、服务起没起。
 *
 * 所以 `let-it-pass` 的语义被刻意定为：**照做，但只记为技术债，永远不记为「通过」**。
 * 人有权承担风险，系统无权替他把风险说成成功。
 *
 * 它此前只在界面文案里出现过（介入面板写着「可用动作：… let-it-pass」），
 * 而 `DIRECTIVE_KINDS` 和 `/api/directive` 的校验都没有它 ——
 * 也就是说**界面推荐了一个 API 会返回 400 的动作**。
 */
export const DIRECTIVE_KINDS = [
  'requirement',
  'constraint',
  'override',
  'resume',
  'hold',
  'let-it-pass',
] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];

/**
 * 对一条建议书的**机械裁决说明**。
 *
 * 存在理由：以前人发一条 `override`，它实际只关掉主理人的阻断权；
 * 如果人的本意是「让它过」，那么**什么都不会发生，而且没有任何回复**。
 * 静默无效比明确拒绝更糟 —— 人会以为自己的决定生效了。
 *
 * 现在每条建议书都会被机械检查一遍，并把结论如实回给人类：
 *   - `applied`        —— 生效了
 *   - `no-effect`      —— 收下了，但在当前处境下不会产生任何效果（附原因）
 *   - `cannot-override-facts` —— 它想推翻的是确定性事实，做不到（附那条事实）
 */
export type DirectiveAdvisory = {
  outcome: 'applied' | 'no-effect' | 'cannot-override-facts';
  message: string;
  /** 与人所期望的相冲突的确定性事实（锚点结论）。 */
  blockingFacts?: Array<{ anchorId: string; code: string; message: string }>;
  /** 如果人真正想要的是「继续推进」，那条诚实的路是什么。 */
  alternative?: string;
};

/**
 * 优先级：USER_DIRECTIVE > FROZEN_CONTRACT > HOST_OBJECTION > ROLE_OPINION
 * 建议书不可被机器人忽略或「重新解释」。
 *
 * 注意最后一句的边界：不能被忽略，也不能被曲解成「它想要的样子」。
 * 一条无法产生效果的建议书必须**明说它没有效果**，而不是假装执行了。
 */
export type DirectiveRecord = {
  id: ArtifactId;
  kind: DirectiveKind;
  text: string;
  targetRefs?: ArtifactId[];
  constraints?: string[];
  supersedes?: ArtifactId[];
  expiresAtStage?: StageId;
  at: string;
  hash: string;
  /** 机械裁决说明：这条建议书在当前处境下会／不会产生什么效果。 */
  advisory?: DirectiveAdvisory;
};

// ════════════════════════════════════════════════════════════════
// 阶段与 Gate
// ════════════════════════════════════════════════════════════════

export const STAGES = [
  'INTAKE',
  'PLANNING',
  'CONTRACTING',
  'BUILDING',
  'REVIEW',
  'ROUNDTABLE',
  'ARBITRATION',
  'DELIVERED',
] as const;
export type StageId = (typeof STAGES)[number];

export type NextAction =
  | { kind: 'RETRY_ROLE'; target: RoleId; orders: WorkOrderId[] }
  | { kind: 'ROUNDTABLE'; trigger: RoundtableTrigger }
  | { kind: 'ARBITRATE_HUMAN'; bundleId: string }
  | { kind: 'ADVANCE'; to: StageId }
  | { kind: 'PASS_WITH_DEBT'; debtId: ArtifactId }
  /** 人类按下了暂停（建议书 hold）—— 物理刹车，任何机器人角色都不能越过。 */
  | { kind: 'HOLD'; reason: string };

export type BlockReason =
  | 'ANCHOR_HARD_FAIL'
  | 'VALID_OBJECTION'
  | 'ROUNDTABLE_PENDING'
  | 'USER_HOLD'
  | 'PENDING_HUMAN_ARBITRATION';

export type GateResult = {
  stage: StageId;
  sequence: number;
  anchors: AnchorRunResult[];
  hardFailures: AnchorRunResult[];
  objections: Objection[];
  arbitration: Arbitration[];
  blocked: boolean;
  reason?: BlockReason;
  ledger: HostLedgerSnapshot;
  nextAction: NextAction;
  /** 本阶段是否需要唤醒主理人。A 层有硬失败时为 false —— 编译器能说清的问题不必让 LLM 复述。 */
  hostInvoked: boolean;
  /** 本次 Gate 生成的派工单（机械归因直接派发，无需 LLM 参与）。 */
  workOrders: WorkOrder[];
  /** A 层是否健康（无 FAIL / INVALID_EVIDENCE）。观察期解除进度用它判定。 */
  aLayerHealthy: boolean;
  at: string;
};

// ════════════════════════════════════════════════════════════════
// 项目配置
// ════════════════════════════════════════════════════════════════

export type CommandSpec = { cmd: string; args: string[]; cwd?: string };

/**
 * 被生成项目的技术轮廓。锚点据此决定能跑什么。
 * 命令缺失时锚点必须报 SKIPPED，绝不报 PASS。
 */
export type ProjectProfile = {
  name: string;
  language: 'typescript';
  srcDir: string;
  tsconfigPath: string;
  typecheck: CommandSpec | null;
  test: CommandSpec | null;
  run: (CommandSpec & { healthUrl?: string }) | null;
  /** typo-squatting 检测的已知包集合。 */
  knownPackages: string[];
  /**
   * 依赖白名单。非空时表示「只允许这些」—— 其它任何依赖都会被 A1 判 FAIL。
   * 来源：真人建议书里的「只允许 X」类约束。
   */
  dependencyAllowlist: string[] | null;
  /**
   * 依赖黑名单。非空时，声明或导入了这些包都会被 A1 判 FAIL。
   * 来源：真人建议书里的「不得引入 X」类约束。
   *
   * 与白名单的区别是**语义方向**：白名单是「封闭集合」（列出的才允许），
   * 黑名单是「排除集合」（列出的不允许）。两者可以同时生效。
   */
  deniedDependencies?: string[] | null;
  /**
   * 项目声明的**环境约束**，会原样注入每个角色的提示词。
   *
   * 存在的理由（真实 LLM 实测发现的缺陷，docs/07 §L5/L8）：
   * 模型写的代码/测试完全合理，却因为**运行环境的限制**而失败 ——
   * 实测过两次：
   *   1. 生成的代码要在 Node 原生类型剥离下直接运行 ⇒ 相对导入必须带 `.ts` 扩展名；
   *   2. 受限沙箱禁止管道式 stdio ⇒ 测试里 `spawn` 子进程会直接 EPERM。
   *
   * 这两条都不是模型的错，也都是**锚点判得对、但归因会误导**的情形：
   * A4/A5 报 FAIL 并归因到 backend/test，而真正的原因是约定没有传达。
   *
   * 所以环境约束必须由**项目自己声明**，而不是引擎硬编码 ——
   * 引擎硬编码会让 AgentForge 只能生成适配它自己那台机器的项目，
   * 而它的目标恰恰是「用户接自己的 LLM、生成自己期望的项目」。
   */
  environmentNotes?: string[];
  /**
   * 项目声明的**验证基准文件**（除 `package.json` 与 `tsconfig.json` 之外）：
   * 产出不得改写它们，改写会被 A8 锚点判 FAIL。
   *
   * 为什么需要项目声明这一项（docs/HANDOFF.md §8.1）：
   * 「哪些文件构成验证基础设施」因项目而异 —— 本仓库预置的工作区里是
   * `run-tests.mjs`（一个单进程测试运行器），换个项目可能是 `vitest.config.ts`、
   * `jest.config.js`、`Makefile`。引擎硬编码一份清单只会在别人的项目里出错，
   * 所以只硬编码两样真正普适的（`package.json` 与 `tsconfig.json`），
   * 其余交给项目自己声明 —— 与 `environmentNotes` 同一个道理。
   */
  protectedFiles?: string[];
};

// ════════════════════════════════════════════════════════════════
// 事件（docs/05 §4）
// ════════════════════════════════════════════════════════════════

export type ForgeEvent =
  | { t: 'run.started'; runId: string; brief: string; projectName: string }
  | { t: 'stage.enter'; stage: StageId }
  | { t: 'artifact.published'; id: ArtifactId; kind: ArtifactKind; producer: ActorId }
  | { t: 'anchor.ran'; result: AnchorRunResult }
  | { t: 'objection.raised'; objection: Objection }
  | { t: 'objection.arbitrated'; arbitration: Arbitration }
  | { t: 'ledger.updated'; ledger: HostLedgerSnapshot }
  | { t: 'workorder.created'; order: WorkOrder }
  | { t: 'roundtable.opened'; trigger: RoundtableTrigger; participants: RoleId[] }
  | {
      t: 'roundtable.closed';
      minuteId: ArtifactId;
      resolution: RoundtableResolution | null;
      /** 决议是否通过机械校验。false 时必然升级真人。 */
      resolutionValid: boolean;
      invalidReason?: string;
      /**
       * 当场执行的 falsifier 所确证/证伪的事实。
       * 必填而非可选：圆桌最有价值的信息就是「这场会到底被机械裁决了什么」，
       * 少了它前端只能看到一场措辞漂亮的辩论。
       */
      facts: RoundtableFact[];
      falsifiersRun: number;
      discardedStatements: number;
      /** 为产出合法决议尝试了几次（含首次）。>1 说明发生过结构化重试。 */
      resolutionAttempts: number;
    }
  | { t: 'escalation.human'; bundleId: string }
  | { t: 'debt.recorded'; debtId: ArtifactId; requirementIds: string[] }
  | { t: 'directive.received'; directive: DirectiveRecord }
  | { t: 'gate.evaluated'; result: GateResult }
  | { t: 'run.paused'; reason: string }
  | { t: 'run.resumed'; reason: string }
  | { t: 'run.failed'; message: string }
  | { t: 'run.finished'; stage: StageId; techDebt: number; delivery: RunDelivery };

/**
 * 交付状态。
 * 引入第三态 `with-debt` 是刻意的（docs/03 §5）：
 * 传统二态（通过/不通过）必然逼出「橡皮图章」或「死锁」两个坏结局。
 */
export type RunDelivery = 'complete' | 'with-debt' | 'awaiting-human' | 'held';
