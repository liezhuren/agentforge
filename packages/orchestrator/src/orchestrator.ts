/**
 * 阶段状态机（docs/01-architecture.md §2）。
 *
 *   INTAKE ──► PLANNING ──► CONTRACTING ──► BUILDING ⇄ REVIEW ──► DELIVERED
 *                                                  │  ↑
 *                                                  ▼  │
 *                                             ROUNDTABLE
 *                                                  │
 *                                                  ▼
 *                                             ARBITRATION ──► PASS_WITH_DEBT ──► 继续
 *
 * 设计要点：
 *  - 每一步的「下一步做什么」由 Gate 机械算出，不由 LLM 决定。
 *  - 死锁永远有出口：圆桌（第 1 层）→ 真人（第 2 层）→ 带债通过（第 3 层）。
 *  - 角色的产出**不伪造**：schema 结构化重试失败就是不产出，走升级流程，
 *    绝不把坏工件写进库（那会让后续所有锚点失去意义）。
 */

import { randomUUID } from 'node:crypto';
import type {
  AnchorRunResult,
  ArtifactId,
  AnchoredReviewDoc,
  DirectiveAdvisory,
  DirectiveKind,
  DirectiveRecord,
  Falsifier,
  HostPolicy,
  ProjectProfile,
  RoleId,
  RoundtableResolution,
  StageId,
  TestReportDoc,
  WorkOrder,
} from '../../core/src/types.ts';
// EventBus 是 events.ts 里的类，不在 types.ts 里（原写法指向不存在的成员）
import type { EventBus } from '../../core/src/events.ts';
import { DEFAULT_HOST_POLICY } from '../../core/src/types.ts';
import { ArtifactStore, materializeFiles } from '../../core/src/store.ts';
import {
  enforceProjectContract,
  readProjectContract,
  type ContractViolation,
  type ProjectContract,
} from '../../core/src/projectcontract.ts';
import { writeContractTypes, GeneratedTypesPathError } from '../../core/src/contractcodegen.ts';
import { DEFAULT_COMMAND_POLICY } from '../../core/src/exec.ts';
import { DecisionLog } from '../../core/src/decisionlog.ts';
import { EventBus as Bus } from '../../core/src/events.ts';
import { Logger } from '../../core/src/logger.ts';
import { roundtableResolutionSchema, roundtableStatementSchema } from '../../core/src/schemas.ts';
import { createAnchorContext, type AnchorContext, type SemanticProposals } from '../../anchors/src/index.ts';
import type { LlmProvider } from '../../llm/src/types.ts';
import type { RoleContext, RoleRunner } from '../../roles/src/types.ts';
import type { SemanticVerifier } from '../../roles/src/verify.ts';
import { HostLedger } from './ledger.ts';
import { MechanicalJudge } from './judge.ts';
import { Gate, nextStageOf } from './gate.ts';
import { RoundtableSession, buildAgenda, determineTrigger, inviteParticipants } from './roundtable.ts';
import { buildEscalationBundle, decideEscape, passWithDebt, type EscalationBundle } from './escape.ts';
import {
  applyDirectivesToProfile,
  compileDirectives,
  describeEnforcement,
  type DirectiveEnforcementReport,
} from './directives.ts';

export type OrchestratorOptions = {
  /** 被生成项目的工作区根目录（工件、锚点记录、代码都落在这里）。 */
  projectRoot: string;
  profile: ProjectProfile;
  userBrief: string;
  runners: Record<RoleId, RoleRunner>;
  verifier: SemanticVerifier;
  provider: LlmProvider;
  policy?: HostPolicy;
  /** 真人是否在线。false 时第三层逃生（带债通过）会被启用。 */
  humanAvailable?: boolean;
  offline?: boolean;
  logger?: Logger;
  bus?: EventBus;
  log?: DecisionLog;
  store?: ArtifactStore;
  /** 每个阶段最多循环多少个 Gate（防止编排层自身死循环）。 */
  maxCyclesPerStage?: number;
  /** 整个 run 最多推进多少个 Gate。 */
  maxTotalCycles?: number;
  /** 执行 falsifier 用的命令安全策略。圆桌与机械裁判共用同一套。 */
  commandPolicy?: import('../../core/src/exec.ts').CommandPolicy;
  /** falsifier 执行超时。 */
  falsifierTimeoutMs?: number;
  /**
   * 每次 Gate 评估前重新推导被生成项目的 profile。
   *
   * 存在的理由（真实 LLM 跑通流程时发现的缺口）：
   * profile 决定了 A4（编译）/A5（测试）/A6（运行时）能不能真的执行。
   * 而它原本只在启动时从工作区读一次 —— 那时工作区是**空的**，
   * 于是「真实 LLM 从零生成代码」这条最需要锚点把关的路径上，
   * A4/A5/A6 恰好全部退化成 SKIPPED（诚实，但等于没检查）。
   *
   * 有了这个钩子，代码落盘之后的下一次 Gate 就能拿到真实的 typecheck/test 命令，
   * 让锚点从「没得查」变成「真的查」。
   *
   * 返回 null 表示维持现状（例如还没生成 package.json）。
   */
  refreshProfile?: (base: ProjectProfile) => Promise<{ profile: ProjectProfile; notes?: string[] } | null>;
};

export type StageTrace = {
  stage: StageId;
  cycles: number;
  blockedReasons: string[];
  nextActions: string[];
  hostInvoked: boolean;
  finalAction: string;
};

export type RunSummary = {
  runId: string;
  finalStage: StageId;
  traces: StageTrace[];
  totalCycles: number;
  ledger: ReturnType<HostLedger['snapshot']>;
  debtIds: ArtifactId[];
  escalations: EscalationBundle[];
  workOrders: WorkOrder[];
  /** 交付状态：complete / with-debt / awaiting-human / held */
  delivery: 'complete' | 'with-debt' | 'awaiting-human' | 'held';
  techDebtRequirements: string[];
  /** 建议书执行情况：哪些被编译成强制约束、哪些只能作为角色指令（无法机械校验）。 */
  directiveEnforcement: DirectiveEnforcementReport | null;
  /**
   * 逐条需求的最终验收状态。
   *
   * 必须出现在报告里（而不是只躺在工件库里）：
   * `delivery` 表达的是「流程与机械检查」，`requirementStatuses` 表达的是
   * 「需求到底确认了没有」——**这是两件不同的事**，混在一个标签里就会产生假绿灯
   * （实测：唯一被判 complete 的那轮，两条需求都是「确认不了」）。
   */
  requirementStatuses: Array<{ id: string; status: string }>;
};

/**
 * B1 的逐条判定 → 需求验收状态的映射。
 *
 * 抽成纯函数是为了能直接单测 —— 这里踩过一个「少报」的坑（docs/07 §L14）：
 * 最初把 `not-met` 排除在外（理由是想「保持 open 不变」），结果**上一轮写下的
 * `unverified` 永远不会被重置** —— REVIEW 第一次判 uncertain 写成 unverified，
 * 重试后第二次判 not-met 被过滤掉不写，状态就停在 unverified。
 * 一个「已确认未达成」的需求于是被显示成「查过但说不清」。
 *
 * 所以这是**全量映射**，四个 verdict 各有归宿，没有「不处理」的分支。
 */
export function requirementStatusForVerdict(
  verdict: 'met' | 'not-met' | 'uncertain' | 'unverified',
): 'met' | 'open' | 'unverified' {
  if (verdict === 'met') return 'met';
  if (verdict === 'not-met') return 'open';
  return 'unverified';
}

/**
 * 对一条建议书做**机械裁决**：它在当前处境下会／不会产生什么效果。
 *
 * 这个函数本身就是「人可以定目标、不能定事实」那条原则的执行点：
 *
 *   - 人**可以**决定继续推进（`let-it-pass`）—— 系统照做，但只记技术债。
 *   - 人**不能**让一个编译不过、测试挂掉的项目「通过」——
 *     那不是意见分歧，是可被机械证伪的假话。
 *
 * 为什么必须把结论回给人类：以前人发一条 `override`，它实际只关掉主理人的阻断权。
 * 如果人的本意是「让它过」，那么**什么都不会发生，也没有任何回复**。
 * 静默无效比明确拒绝更糟 —— 人会以为自己的决定生效了。
 *
 * 抽成纯函数（与 `requirementStatusForVerdict`、服务端的 `deriveVerdict` 同一套做法），
 * 是为了能脱离编排器直接穷举各个组合 —— 判定逻辑不该只有跑完一整轮才能验。
 */
export function adjudicateDirective(args: {
  kind: DirectiveKind;
  /** 最近一次 Gate 所在的阶段；null 表示还没跑过 Gate。 */
  stage: StageId | null;
  /** 最近一次 Gate 是否被阻断。 */
  blocked: boolean;
  /** 当前未解决的确定性失败。 */
  facts: Array<{ anchorId: string; code: string; message: string }>;
}): DirectiveAdvisory {
  const { kind, facts } = args;
  const where = args.stage ? `阶段 ${args.stage}` : '当前';
  const blockedNow = args.blocked && facts.length > 0;

  if (kind === 'let-it-pass') {
    /**
     * 注意这条指令是**前瞻性**的：它说的是「下一次出现争议时别再纠缠」。
     * 所以「现在没卡住」不等于「它不会产生效果」—— 那个措辞是错的
     * （我自己第一版就是这么写的）。正确的说法是「它会作用于下一次」。
     */
    if (!blockedNow) {
      return {
        outcome: 'applied',
        message:
          `${where}现在没有未解决的确定性失败，所以这条指令暂时无事可做。` +
          `它会**一直有效到下一次争议** —— 那时未解决的问题会被记为技术债，然后继续推进。`,
      };
    }
    return {
      outcome: 'applied',
      message:
        `已**照做**：${where}的 ${facts.length} 条未解决失败会被记为**技术债**，然后继续推进。` +
        `交付状态**不会是「完整」**（而是「带债」）—— 你有权承担风险，` +
        `系统不会替你把风险说成成功。想真正修好请改用具体工单让角色返工。`,
      blockingFacts: facts,
    };
  }

  if (kind === 'override' || kind === 'resume') {
    if (!blockedNow) {
      return {
        outcome: 'applied',
        message: `${where}没有确定性失败，这条指令已生效（解除主理人的阻断权，流水线可继续推进）。`,
      };
    }
    return {
      outcome: 'cannot-override-facts',
      message:
        `这条指令**无法产生你想要的效果**：它只能解除**主理人**的阻断权，` +
        `而${where}卡住的是 ${facts.length} 条**确定性事实**（见下）——` +
        `那些检查不看任何人的意见，包括你的。`,
      blockingFacts: facts,
      alternative:
        '要「别再纠缠、继续往下走」：用 let-it-pass（记为技术债，交付状态是「带债」而不是「完整」）。' +
        '要「把它修好」：把问题派给具体角色返工。',
    };
  }

  if (kind === 'hold') {
    return { outcome: 'applied', message: '已收下：编排器会在下一个阶段边界停下（不会强杀，避免半写状态）。' };
  }

  return {
    outcome: 'applied',
    message: `${where}已收到这条建议书。${
      kind === 'constraint' || kind === 'requirement'
        ? '它是否被编译成机械可校验的规则，见下方的执行情况。'
        : ''
    }`,
  };
}

export class Orchestrator {
  private o: OrchestratorOptions;
  private store: ArtifactStore;
  private bus: EventBus;
  private logger: Logger;
  private ledger: HostLedger;
  private judge: MechanicalJudge;
  private gate: Gate;
  private log: DecisionLog | null;

  private workOrders: WorkOrder[] = [];
  private escalations: EscalationBundle[] = [];
  private debtIds: ArtifactId[] = [];
  private debtRequirements: string[] = [];
  private directives: DirectiveRecord[] = [];
  private roundtablesHeld = 0;
  private lastResolutionValid: boolean | null = null;
  /** 上一轮硬失败签名，用于识别「修复无效」。见 RETRY_ROLE 分支的说明。 */
  private lastHardFailureSignature: string | null = null;
  /**
   * 最近一次回写后的需求验收状态。
   *
   * 存在的意义是让「有多少需求是我们**确认不了**的」变成一个随时可读的数字 ——
   * 在此之前，需求状态永远停在 `open`，这个信息在系统里根本不存在。
   */
  private lastRequirementStatuses: Array<{ id: string; status: string }> = [];
  /** 建议书的执行情况：哪些被编译成强制约束、哪些只能作为指令。 */
  private enforcement: DirectiveEnforcementReport | null = null;
  private judgeCommandPolicy: import('../../core/src/exec.ts').CommandPolicy;
  private falsifierTimeoutMs: number;
  /**
   * 当前生效的 profile。初始为构造时传入的那份，之后可由 `refreshProfile` 更新。
   *
   * 为什么不直接用 `this.o.profile`：那份是**启动时**的快照，
   * 而 A4/A5/A6 能不能真的执行取决于**代码落盘之后**工作区的样子。
   * 详见 OrchestratorOptions.refreshProfile 的说明。
   */
  private effectiveProfile: ProjectProfile;
  private traces: StageTrace[] = [];
  private cycle = 0;
  private runId = `run-${randomUUID().slice(0, 8)}`;
  /**
   * 锚点上下文的序号。保证**每个 Gate 的锚点运行记录 runId 唯一**。
   *
   * 不加它的话，`createAnchorContext` 内部那个从 1 开始的计数器会让每个 Gate
   * 都产出 `-001`…`-010`，于是后一个 Gate 的记录**覆盖**前一个 Gate 的。
   * 详见 makeCtx 里的说明。
   */
  private ctxSeq = 0;
  /**
   * 项目契约：**验证基准**。在第一个角色产出之前固化，之后产出不得删除或改写它。
   *
   * 空对象是初始值（契约还没取快照）；`run()` 一开始就会把它填上。
   * 取快照与强制执行的完整理由见 `core/src/projectcontract.ts` 的模块注释 ——
   * 一句话：**被验证者不能修改验证基准**，否则「每个 PASS 都可追溯到一个
   * 不依赖 LLM 的事实」这条不变量就只是措辞。
   */
  private contract: ProjectContract = { pkgExists: false, pkgKeys: {}, protectedFiles: {} };
  /** 产出对契约的篡改尝试。已全部按「保留原值」处理，但必须报出来（A8）。 */
  private contractViolations: ContractViolation[] = [];
  /**
   * 最近一次 Gate 的结论摘要。
   *
   * 真人建议书可以随时投递，而系统必须能如实回答「它现在会产生什么效果」。
   * 那需要知道**现在卡在哪**（哪个阶段、哪些锚点硬失败）—— 这就是它的用途。
   */
  private lastGate: { stage: StageId; blocked: boolean; anchors: AnchorRunResult[] } | null = null;
  /**
   * 真人已下达「明知有争议，继续推进」。**用一次就消耗掉**。
   *
   * 不做成长期开关的理由：那会把之后任何一次不相关的失败都静默转成技术债，
   * 而「带债」恰恰是最需要被看见的信号。
   */
  private letItPassPending = false;
  /**
   * 已被真人接受为技术债的**硬失败签名**。
   *
   * 为什么需要它：`let-it-pass` 只在**被消耗的那一刻**起作用，
   * 而同一批失败在下一个阶段（REVIEW）会被重新检出 ——
   * 于是系统又开始派工单返工，与人刚刚说的「别再纠缠」直接矛盾。
   *
   * 记签名而不是记「已批准」这个布尔量，正是为了不稀释信号：
   * **只有这一批具体的失败**不再重打，之后出现任何**新的**问题照常处理。
   */
  private acceptedDebtSignatures = new Set<string>();

  constructor(opts: OrchestratorOptions) {
    this.o = opts;
    this.store = opts.store ?? new ArtifactStore(opts.projectRoot);
    this.bus = opts.bus ?? new Bus();
    this.logger = opts.logger ?? new Logger('orchestrator');
    this.log = opts.log ?? null;
    this.ledger = new HostLedger(opts.policy ?? DEFAULT_HOST_POLICY, 'INTAKE');
    this.judgeCommandPolicy = opts.commandPolicy ?? DEFAULT_COMMAND_POLICY;
    this.falsifierTimeoutMs = opts.falsifierTimeoutMs ?? 60_000;
    this.effectiveProfile = opts.profile;
    this.judge = new MechanicalJudge({
      anchorContext: this.makeCtx({}),
      ledger: this.ledger,
      logger: this.logger.child('judge'),
      commandPolicy: this.judgeCommandPolicy,
      falsifierTimeoutMs: this.falsifierTimeoutMs,
    });
    this.gate = new Gate({
      store: this.store,
      profile: opts.profile,
      ledger: this.ledger,
      judge: this.judge,
      // bus 必须始终注入 —— 否则 Gate 的事件（gate.evaluated / ledger.updated）不会出现在
      // 事件流里，前端就会缺少最关键的两个视图数据源。
      bus: this.bus,
      ...(opts.log ? { log: opts.log } : {}),
      logger: this.logger.child('gate'),
      makeAnchorContext: (p: SemanticProposals) => this.makeCtx(p),
    });
  }

  async run(): Promise<RunSummary> {
    await this.ensureInit();

    // ── 固化项目契约（验证基准）────────────────────────────────────
    //
    // 必须在**任何角色产出之前**做。晚一步，「基准」就成了产出自己写的东西 ——
    // 那正是第 12 轮真实运行踩到的坑：后端角色附了一份自己写的 package.json，
    // 把项目声明的 healthUrl 删掉，A6 于是静默 SKIPPED（docs/HANDOFF.md §8.1）。
    try {
      const snap = await readProjectContract(this.o.projectRoot);
      this.contract = snap.contract;
      for (const n of snap.notes) this.logger.info(n);
      await this.log?.append('project.contract.snapshot', {
        pkgExists: snap.contract.pkgExists,
        pkgKeys: Object.keys(snap.contract.pkgKeys),
        protectedFiles: Object.keys(snap.contract.protectedFiles),
        notes: snap.notes,
      });
    } catch (err) {
      // 取快照失败不是致命问题：A8 会因为拿不到基准而报 SKIPPED，
      // 那是**诚实**的结果（未验证 ≠ 通过），好过让整个 run 崩掉。
      this.logger.warn(`固化项目契约失败，本次运行不做契约保护：${(err as Error).message}`);
    }

    this.bus.emit({
      t: 'run.started',
      runId: this.runId,
      brief: this.o.userBrief,
      projectName: this.o.profile.name,
    });
    await this.log?.append('run.started', { project: this.o.profile.name, brief: this.o.userBrief });

    let stage: StageId = 'INTAKE';
    let delivery: RunSummary['delivery'] = 'complete';

    stageLoop: while (true) {
      if (stage === 'DELIVERED') break;
      if (this.cycle >= (this.o.maxTotalCycles ?? 60)) {
        this.logger.warn('达到全局循环上限，停止推进');
        delivery = 'awaiting-human';
        break;
      }

      // ── 人类的物理刹车：放在**任何模型调用之前**检查 ─────────────
      // 人类按了暂停就不该再白烧 token 去产出工件。Gate 里还有一道同样的检查
      // 作为纵深防御（防止运行中途才收到 hold）。
      const holdDirective = this.directives.filter((d) => d.kind === 'hold').at(-1);
      if (holdDirective) {
        this.bus.emit({ t: 'run.paused', reason: holdDirective.text });
        await this.log?.append('stage.entered', { stage, held: true, reason: holdDirective.text });
        delivery = 'held';
        break;
      }

      this.bus.emit({ t: 'stage.enter', stage });
      await this.log?.append('stage.entered', { stage });
      const trace: StageTrace = {
        stage,
        cycles: 0,
        blockedReasons: [],
        nextActions: [],
        hostInvoked: false,
        finalAction: '',
      };
      this.traces.push(trace);

      // ── 产出本阶段工件（schema 失败即不产出，绝不伪造） ─────────
      const produced = await this.produceStage(stage);
      if (!produced.ok) {
        this.logger.error(`[${stage}] 工件产出失败：${produced.reason}`);
        trace.blockedReasons.push(`production-failed: ${produced.reason}`);
        // 产出失败是模型/工具的限制，不是项目缺陷 —— 直接走逃生层
        const escaped = await this.escape({
          stage,
          reason: 'production-failed',
          summary: `角色产出无法通过 schema 校验：${produced.reason}`,
          agenda: [`阶段 ${stage} 的工件产出失败`, produced.reason],
          objections: [],
          arbitration: [],
          anchors: [],
        });
        if (escaped === 'HOLD') {
          delivery = 'held';
          trace.finalAction = 'HOLD';
          break stageLoop;
        }
        if (escaped === 'AWAIT_HUMAN') {
          delivery = 'awaiting-human';
          trace.finalAction = 'AWAIT_HUMAN';
          break stageLoop;
        }
        // 带债通过 → 继续推进
        delivery = 'with-debt';
        this.ledger.endStage({ aLayerHealthy: false });
        stage = nextStageOf(stage);
        continue;
      }

      // ── 阶段内循环：Gate → nextAction ──────────────────────────
      let cycles = 0;
      while (true) {
        cycles++;
        this.cycle++;
        trace.cycles = cycles;
        if (cycles > (this.o.maxCyclesPerStage ?? 8)) {
          this.logger.warn(`[${stage}] 阶段内循环达上限，转逃生流程`);
          trace.blockedReasons.push('stage-cycle-limit');
          const escaped = await this.escape({
            stage,
            reason: 'stage-cycle-limit',
            summary: `阶段 ${stage} 内循环达上限仍未收敛`,
            agenda: [`阶段 ${stage} 反复无法通过门禁`],
            objections: [],
            arbitration: [],
            anchors: [],
          });
          if (escaped === 'HOLD') {
            delivery = 'held';
            trace.finalAction = 'HOLD';
            break stageLoop;
          }
          if (escaped === 'AWAIT_HUMAN') {
            delivery = 'awaiting-human';
            trace.finalAction = 'AWAIT_HUMAN';
            break stageLoop;
          }
          delivery = 'with-debt';
          this.ledger.endStage({ aLayerHealthy: false });
          stage = nextStageOf(stage);
          break;
        }

        // REVIEW 阶段每个 cycle 都要重做语义验证与对抗审查：
        // 它们锚定的是**当前**工件内容，角色修复代码后旧判定就过期了。
        let reviewInput: { proposals: SemanticProposals; hostReview: AnchoredReviewDoc | null };
        if (stage === 'REVIEW') {
          const rr = await this.refreshReview();
          if (!rr.ok) {
            // 「调不动模型」与「模型答不对」是两回事：前者重试无意义，直接走逃生层。
            this.logger.warn(`[${stage}] 审查输入刷新失败：${rr.reason}`);
            trace.blockedReasons.push(`review-failed: ${rr.reason}`);
            const escaped = await this.escape({
              stage,
              reason: 'review-refresh-failed',
              summary: rr.reason,
              agenda: [`阶段 ${stage} 的语义验证无法完成`],
              objections: [],
              arbitration: [],
              anchors: [],
            });
            if (escaped === 'HOLD') {
              delivery = 'held';
              trace.finalAction = 'HOLD';
              break stageLoop;
            }
            if (escaped === 'AWAIT_HUMAN') {
              delivery = 'awaiting-human';
              trace.finalAction = 'AWAIT_HUMAN';
              break stageLoop;
            }
            delivery = 'with-debt';
            this.ledger.endStage({ aLayerHealthy: false });
            stage = nextStageOf(stage);
            break;
          }
          reviewInput = rr;
        } else {
          reviewInput = { proposals: produced.proposals, hostReview: null };
        }

        // 代码已经落盘，现在重新推导 profile —— 让 A4/A5/A6 从「没得查（SKIPPED）」
        // 变成「真的查」。必须在 gate.evaluate 之前。
        await this.refreshEffectiveProfile();

        const gateOut = await this.gate.evaluate({
          stage,
          sequence: cycles,
          proposals: reviewInput.proposals,
          hostReview: reviewInput.hostReview,
          directives: this.directives,
          previousHardFailureSignature: this.lastHardFailureSignature,
          roundtablesHeld: this.roundtablesHeld,
          humanAvailable: this.o.humanAvailable ?? false,
          requirementIds: this.requirementIds(),
        });
        trace.hostInvoked = trace.hostInvoked || gateOut.hostInvoked;
        if (gateOut.reason) trace.blockedReasons.push(gateOut.reason);
        trace.nextActions.push(describeAction(gateOut.nextAction));
        this.workOrders.push(...gateOut.workOrders);

        /**
         * 契约违规**按 Gate 结算**，用完即清。
         *
         * 为什么不累积：A8 要回答的是「本轮产出有没有篡改验证基准」，
         * 和 A4「现在还有没有编译错误」是同一类问题 —— **看的是当下状态，不是历史**。
         * 累积的话，一次没能生效的篡改尝试（文件其实原封不动）会让这个 run
         * 从此永远 A8 FAIL，最后只能带债通过：那既冤枉了已经改好的角色，
         * 也把「带债」这个信号稀释了。
         *
         * 清空的位置必须在这里：A8 是在上面的 `gate.evaluate` 里读的，
         * 之后才轮到返工。返工若再犯，新违规会重新累积到下一轮 Gate。
         */
        this.contractViolations = [];

        // 把 A5 的真实执行结果固化成 TestReport 工件。
        //
        // 必须在 gate 之后：A5 是**在 gate 里**才真的跑测试的，
        // 它的观测结果是这份报告唯一诚实的来源。
        // 放在这里意味着「本轮的测试事实要在下一轮 Gate 才可见」——
        // 所以 B2 的 deliverable-missing 会在当轮报出、下一轮消失，这是符合预期的。
        await this.publishTestReport(gateOut.anchors);

        // 把 B1 的逐条判定回写成需求验收状态。
        await this.syncRequirementStatuses(gateOut.anchors);

        /**
         * 记住本轮的 Gate 结论。
         *
         * 用途：真人随时可能投递建议书，而系统必须能回答
         * 「这条建议书在当前处境下会／不会产生效果」——
         * 那需要知道**现在到底卡在哪**（哪些锚点硬失败、卡在哪个阶段）。
         * 没有它就只能给一个人畜无害的「已收到」，那等于静默无效。
         */
        this.lastGate = { stage, blocked: gateOut.blocked, anchors: gateOut.anchors };

        const action = gateOut.nextAction;

        /**
         * ── 真人说「明知有争议，继续推进」──────────────────────────
         *
         * 语义被刻意定成「**照做，但只记为技术债，永远不记为通过**」。
         *
         * 这就是「人可以定目标、不能定事实」那条原则的落点：
         * 人有权承担风险继续走，系统无权替他把风险说成成功 ——
         * 于是交付状态只会是 `with-debt`，TECH_DEBT.md 里会写明哪些问题被搁置。
         *
         * 「用一次就消耗掉」也是刻意的：这条指令针对的是**当前这场争议**。
         * 若做成长期有效的开关，之后任何一次不相关的失败都会被静默转成债 ——
         * 那会把「带债」这个信号稀释成噪音，而它恰恰是最需要被看见的信号。
         */
        const sig = gateOut.hardFailureSignature;
        const blockedish = action.kind !== 'ADVANCE' && action.kind !== 'HOLD';
        const alreadyAccepted = blockedish && sig !== null && this.acceptedDebtSignatures.has(sig);
        const justAccepted = !alreadyAccepted && blockedish && this.consumeLetItPass();
        if (justAccepted && sig !== null) this.acceptedDebtSignatures.add(sig);

        if (alreadyAccepted || justAccepted) {
          /**
           * 两条路殊途同归，都进债，但**理由不同**，必须分开写：
           *   - justAccepted：刚刚收到人的指令
           *   - alreadyAccepted：这批失败人**已经**接受过了，不该在下一个阶段又被重打一遍
           *
           * 后者是实测补上的：只做「用一次就消耗」时，BUILDING 里接受掉的失败
           * 会在 REVIEW 被重新检出 → 系统又开始派工单返工 →
           * 与人刚说的「别再纠缠」直接矛盾，而且白花钱。
           */
          const facts = gateOut.anchors
            .flatMap((a) => a.findings.map((f) => ({ anchorId: a.anchorId, f })))
            .filter((x) => x.f.severity === 'fail');
          trace.finalAction = justAccepted ? 'LET_IT_PASS→with-debt' : 'ACCEPTED_DEBT→with-debt';
          trace.blockedReasons.push('user-let-it-pass');
          const outcome = await passWithDebt(this.store, this.log ?? (await this.dummyLog()), {
            stage,
            summary:
              `真人已接受这批失败为技术债（${facts.length} 条），${justAccepted ? '本次指令' : '同一批失败在此前阶段已被接受'}：` +
              facts
                .slice(0, 5)
                .map((x) => `${x.anchorId}/${x.f.code}${x.f.file ? `@${x.f.file}` : ''}`)
                .join('；'),
            objections: gateOut.objections,
            arbitration: gateOut.arbitration,
            requirementIds: this.requirementIds(),
            reason: 'user-let-it-pass',
          });
          this.debtIds.push(outcome.debt.id);
          this.debtRequirements.push(...outcome.markedRequirements);
          this.bus.emit({ t: 'debt.recorded', debtId: outcome.debt.id, requirementIds: outcome.markedRequirements });
          this.logger.warn(
            `真人已接受的失败集记为技术债（含本阶段 ${facts.length} 条）—— 交付状态是「带债」而不是「通过」`,
          );
          delivery = 'with-debt';
          this.ledger.endStage({ aLayerHealthy: false });
          stage = nextStageOf(stage);
          break;
        }

        if (action.kind === 'HOLD') {
          trace.finalAction = 'HOLD';
          delivery = 'held';
          this.bus.emit({ t: 'run.paused', reason: action.reason });
          break stageLoop;
        }

        if (action.kind === 'ADVANCE') {
          trace.finalAction = `ADVANCE→${action.to}`;
          const cleared = this.ledger.endStage({ aLayerHealthy: gateOut.aLayerHealthy });
          if (cleared.clearedProbation) this.logger.info('观察期已解除（R5）：连续阶段 A 层健康且无新误报');
          stage = action.to;
          break;
        }

        if (action.kind === 'RETRY_ROLE') {
          trace.finalAction = `RETRY_ROLE→${action.target}`;

          /**
           * 修复无效检测：如果本轮硬失败的**签名**与上一轮完全相同，
           * 说明发出去的工单没有改变任何东西 —— 再重试同一个角色只会重复劳动
           * （在真实 LLM 上还会重复花钱）。
           *
           * 实测中这条很重要：某个锚点的失败根本不是角色能修的
           * （例如测试命令本身写错了，A5 报 no-tests-ran），
           * 系统会白跑满 8 轮循环才放弃。有了这个判断，同样的情况 1 轮就能收敛。
           */
          const signature = gateOut.hardFailureSignature;
          const ineffective =
            signature !== null && signature === this.lastHardFailureSignature && cycles > 1;
          this.lastHardFailureSignature = signature;

          if (ineffective) {
            this.logger.warn(
              `[${stage}] 工单修复后硬失败签名未变（${action.target} 的修复没有改变任何东西），不再重复重试，转逃生流程`,
            );
            trace.blockedReasons.push('repair-ineffective');
            const escaped = await this.escape({
              stage,
              reason: 'repair-ineffective',
              summary:
                `派给「${action.target}」的 ${gateOut.workOrders.length} 张工单执行后，锚点失败情况与修复前完全一致。` +
                `继续重试同一个角色不会有效果 —— 可能是该问题不属于角色的职责范围（例如工具链配置本身有误）`,
              agenda: gateOut.workOrders.flatMap((w) => w.acceptance),
              objections: gateOut.objections,
              arbitration: gateOut.arbitration,
              anchors: gateOut.anchors,
            });
            if (escaped === 'HOLD') {
              delivery = 'held';
              trace.finalAction = 'HOLD';
              break stageLoop;
            }
            if (escaped === 'AWAIT_HUMAN') {
              delivery = 'awaiting-human';
              trace.finalAction = 'AWAIT_HUMAN';
              break stageLoop;
            }
            delivery = 'with-debt';
            this.ledger.endStage({ aLayerHealthy: false });
            stage = nextStageOf(stage);
            break;
          }

          // 把工单交给对应角色修复，产出新版本工件后重新过 Gate
          const repaired = await this.dispatchRepairs(gateOut.workOrders);
          if (!repaired) {
            const escaped = await this.escape({
              stage,
              reason: 'repair-failed',
              summary: `角色 ${action.target} 无法按工单完成修复`,
              agenda: gateOut.workOrders.flatMap((w) => w.acceptance),
              objections: gateOut.objections,
              arbitration: gateOut.arbitration,
              anchors: gateOut.anchors,
            });
            if (escaped === 'HOLD') {
              delivery = 'held';
              trace.finalAction = 'HOLD';
              break stageLoop;
            }
            if (escaped === 'AWAIT_HUMAN') {
              delivery = 'awaiting-human';
              trace.finalAction = 'AWAIT_HUMAN';
              break stageLoop;
            }
            delivery = 'with-debt';
            this.ledger.endStage({ aLayerHealthy: false });
            stage = nextStageOf(stage);
            break;
          }
          continue;
        }

        if (action.kind === 'ROUNDTABLE') {
          trace.finalAction = `ROUNDTABLE(${action.trigger})`;

          // 圆桌之前也要记下本轮硬失败签名。
          //
          // 踩过的坑（真实 LLM 实测，docs/07 §L10）：签名原本**只在 RETRY_ROLE 分支**
          // 更新，圆桌分支从不更新 ⇒ 圆桌之后的下一轮拿当前签名去比一个**过期值**，
          // 「签名未变」永远不成立 ⇒ Gate 里那道「不为没变化的失败反复开会」的闸门失效
          // ⇒ 实测一个阶段连开 7 次 T4 圆桌，直到撞上阶段循环上限。
          this.lastHardFailureSignature = gateOut.hardFailureSignature;

          const rt = await this.holdRoundtable(action.trigger, gateOut);
          if (rt === 'resolved') continue;
          if (rt === 'HOLD') {
            delivery = 'held';
            trace.finalAction = 'HOLD';
            break stageLoop;
          }
          if (rt === 'AWAIT_HUMAN') {
            delivery = 'awaiting-human';
            trace.finalAction = 'AWAIT_HUMAN';
            break stageLoop;
          }
          delivery = 'with-debt';
          this.ledger.endStage({ aLayerHealthy: false });
          stage = nextStageOf(stage);
          break;
        }

        if (action.kind === 'ARBITRATE_HUMAN') {
          trace.finalAction = 'ARBITRATE_HUMAN';
          delivery = 'awaiting-human';
          break stageLoop;
        }

        if (action.kind === 'PASS_WITH_DEBT') {
          trace.finalAction = 'PASS_WITH_DEBT';
          delivery = 'with-debt';
          this.ledger.endStage({ aLayerHealthy: false });
          stage = nextStageOf(stage);
          break;
        }

        // 兜底：不认识的动作不得让循环卡死
        this.logger.warn(`未知 nextAction：${JSON.stringify(action)}`);
        trace.finalAction = 'UNKNOWN→ADVANCE';
        this.ledger.endStage({ aLayerHealthy: false });
        stage = nextStageOf(stage);
        break;
      }
    }

    const summary: RunSummary = {
      runId: this.runId,
      finalStage: stage,
      traces: this.traces,
      totalCycles: this.cycle,
      ledger: this.ledger.snapshot(),
      debtIds: this.debtIds,
      escalations: this.escalations,
      workOrders: this.workOrders,
      delivery,
      techDebtRequirements: this.debtRequirements,
      directiveEnforcement: this.enforcement,
      requirementStatuses: this.lastRequirementStatuses,
    };
    this.bus.emit({ t: 'run.finished', stage, techDebt: this.debtIds.length, delivery });
    await this.log?.append('run.finished', {
      finalStage: stage,
      delivery,
      cycles: this.cycle,
      requirementStatuses: this.lastRequirementStatuses,
      debt: this.debtIds.length,
    });
    return summary;
  }

  // ══════════════════════════════════════════════════════════════
  // 阶段产出
  // ══════════════════════════════════════════════════════════════

  private async produceStage(
    stage: StageId,
  ): Promise<{
    ok: true;
    proposals: SemanticProposals;
    hostReview: AnchoredReviewDoc | null;
  } | { ok: false; reason: string }> {
    try {
      switch (stage) {
        case 'INTAKE':
          if (!(await this.produce('pm', { kind: 'Requirement', instruction: intakeInstruction(this.o.userBrief) })))
            return { ok: false, reason: 'PM 未能产出需求工件' };
          break;

        case 'PLANNING': {
          const needs = !this.store.head('PRD') || !this.store.head('TaskGraph');
          if (needs) {
            if (!(await this.produce('pm', { kind: 'PRD', instruction: planningPrdInstruction() })))
              return { ok: false, reason: 'PM 未能产出 PRD' };
            if (!(await this.produce('pm', { kind: 'TaskGraph', instruction: planningTasksInstruction() })))
              return { ok: false, reason: 'PM 未能产出任务图' };
          }
          break;
        }

        case 'CONTRACTING': {
          const needs = !this.store.head('Contract') || !this.store.head('Contract')?.frozenHash;
          if (needs) {
            if (!(await this.produce('pm', { kind: 'Contract', instruction: contractInstruction() })))
              return { ok: false, reason: 'PM 未能产出契约' };
            const head = this.store.head('Contract');
            if (head && !head.frozenHash) await this.store.freeze(head.id);
          }
          // 冻结后立刻**由程序生成**共享类型文件（不经 LLM）。
          // 前后端都只能 import 这个生成物，契约分叉因此在编译期就被抓住。
          const contract = this.store.head('Contract');
          if (contract) {
            const contractDoc = contract.content as import('../../core/src/types.ts').ContractDoc;
            try {
              const gen = await writeContractTypes(this.o.projectRoot, contractDoc, {
                // 生成物写到哪，是 PM 的 Contract 工件说了算 —— 所以这里要挡住它指向验证基准。
                forbiddenPaths: ['package.json', ...Object.keys(this.contract.protectedFiles)],
              });
              this.logger.info(`已从冻结契约生成共享类型：${gen.path}（${gen.bytes} 字节）`);
              await this.log?.append('artifact.frozen', {
                contractId: contract.id,
                frozenHash: contract.frozenHash,
                generatedTypes: gen.path,
              });
            } catch (err) {
              if (!(err instanceof GeneratedTypesPathError)) throw err;
              // 路径非法不是致命错误：不写盘，把这件事**如实记成一次契约违规**。
              // A7 会因为「生成类型文件不存在」而 FAIL，工单会走正常流程派回 PM ——
              // 也就是「不伪造、不静默、交给机械通道」。
              const v: ContractViolation = {
                code: 'path-escapes-project',
                path: contractDoc.generatedTypesPath,
                key: 'generatedTypesPath',
                targetRole: 'pm',
                artifactKind: 'Contract',
                message:
                  `契约声明的 generatedTypesPath（${contractDoc.generatedTypesPath}）不可写：` +
                  `${err.message}。生成类型文件未落盘，A7 会因此 FAIL。`,
              };
              this.contractViolations.push(v);
              this.logger.warn(v.message);
              await this.log?.append('project.contract.violation', {
                code: v.code,
                path: v.path,
                key: v.key,
                targetRole: v.targetRole,
                artifactKind: v.artifactKind,
              });
            }
          }
          break;
        }

        case 'BUILDING': {
          const tg = this.store.head('TaskGraph');
          const tasks = ((tg?.content as { tasks?: Array<Record<string, unknown>> })?.tasks ?? []) as Array<{
            id: string;
            owner: RoleId;
            scope: 'web' | 'api' | 'shared';
            deliverable: string;
            requirementIds: string[];
          }>;

          if (tasks.length === 0) return { ok: false, reason: '任务图为空，无法派工' };

          for (const t of tasks) {
            if (t.deliverable !== 'CodeModule') continue;
            const ok = await this.produce(t.owner, {
              kind: 'CodeModule',
              scope: t.scope,
              taskId: t.id,
              requirementIds: t.requirementIds,
              instruction: codeInstruction(t),
            });
            if (!ok) return { ok: false, reason: `角色 ${t.owner} 未能产出任务 ${t.id} 的代码` };
          }

          if (!this.store.head('TestSuite')) {
            if (!(await this.produce('test', { kind: 'TestSuite', instruction: testInstruction() })))
              return { ok: false, reason: '测试角色未能产出测试套件' };
          }
          break;
        }

        case 'REVIEW':
          // REVIEW 的产出（语义验证 + 对抗审查）由 refreshReview() 在**每个 cycle** 做，
          // 因为它们锚定的是当前工件内容，修复后必然过期。
          break;

        default:
          break;
      }
      return { ok: true, proposals: {}, hostReview: null };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  /**
   * 刷新 REVIEW 阶段的审查输入：语义验证（B1 提议）+ 主理人对抗审查（B3）。
   *
   * 必须在**每个 Gate cycle** 重跑，而不是每个阶段只做一次。
   * 原因：这两项判断都锚定在「当时的工件内容」上。某个角色按工单修复代码之后，
   * 旧的语义判定就过期了 —— 拿着过期的判定去裁决新代码，
   * 等于让系统用昨日的事实审判今天的提交。
   * （这是编码阶段发现的真实缺陷：修复后重进 REVIEW，验证与审查都没重跑。）
   *
   * 失败处理刻意分成两种，因为它们该走的路完全不同：
   *   - **Provider 层异常**（预算超限、网络错误、鉴权失败）→ 返回 ok:false。
   *     这种失败意味着**根本调不到模型**，重试没有意义，必须立刻走逃生层（暂停/升级真人/带债）。
   *     曾经因为这里没做捕获，一次预算超限直接让整个 run 崩掉 —— 而预算超限
   *     是设计好的控制路径，不是崩溃。
   *   - **schema 重试耗尽**（模型答了但格式不合规）→ 不在这里拦，交给 Gate 的
   *     blockingGaps 生成「补证据」工单（有界循环后仍不通过再走逃生）。
   *     这两种失败的差别是「调不动」与「答不对」，处理方式不该混为一谈。
   */
  private async refreshReview(): Promise<
    { ok: true; proposals: SemanticProposals; hostReview: AnchoredReviewDoc | null } | { ok: false; reason: string }
  > {
    let verify;
    try {
      verify = await this.o.verifier.verify(this.roleContext('test'));
    } catch (err) {
      return { ok: false, reason: `语义验证调用失败：${(err as Error).message}` };
    }

    const proposals: SemanticProposals = verify.proposals
      ? { requirementVerdicts: verify.proposals.requirementVerdicts as never }
      : {};

    // 主理人产出失败不应阻断流程 —— 它只是「没能给出审查意见」，
    // 而流程的正确性由 A 层锚点 + B1 保证。记警告后继续。
    const ok = await this.produce('host', { kind: 'AnchoredReview', instruction: reviewInstruction() });
    if (!ok) this.logger.warn('主理人未能产出审查包，本阶段按「无异议」处理');

    const reviewArt = this.store.head('AnchoredReview');
    const hostReview = reviewArt ? (reviewArt.content as AnchoredReviewDoc) : null;
    if (hostReview) {
      // 把异议的证据转交给 B3 锚点（B3 只核验证据存在性，不做裁决）
      proposals.objections = hostReview.objections.map((o) => ({ id: o.id, evidence: o.evidence }));
    }
    return { ok: true, proposals, hostReview };
  }

  /**
   * 把角色产出的文件清单按项目契约规整一遍，并记录篡改尝试。
   *
   * 必须在 `store.put` **之前**调用，让「工件里的内容」与「盘上的文件」始终一致 ——
   * 否则锚点绑定在工件 hash 上，检查的却是另一个版本的文件，回归会变得无法解释。
   *
   * 违规不会被静默吞掉：每条都写进决策日志（可 verify 的哈希链）并累积给 A8 报 FAIL。
   */
  private applyProjectContract(
    content: unknown,
    producer: RoleId,
    kind: import('../../core/src/types.ts').ArtifactKind,
  ): unknown {
    if (kind !== 'CodeModule' && kind !== 'TestSuite') return content;
    const obj = content as { files?: Array<{ path: string; content: string }> } | null;
    const files = obj?.files;
    if (!Array.isArray(files) || files.length === 0) return content;

    const res = enforceProjectContract({
      contract: this.contract,
      files,
      producer,
      artifactKind: kind,
    });
    // 收编可能扩展了契约（空白工作区里角色创建了 package.json / tsconfig.json）
    this.contract = res.contract;

    if (res.violations.length > 0) {
      this.contractViolations.push(...res.violations);
      for (const v of res.violations) {
        this.logger.warn(`产出违反项目契约：${v.message}`);
        void this.log?.append('project.contract.violation', {
          code: v.code,
          path: v.path,
          ...(v.key ? { key: v.key } : {}),
          ...(v.declared ? { declared: v.declared } : {}),
          ...(v.attempted ? { attempted: v.attempted } : {}),
          targetRole: v.targetRole,
          artifactKind: v.artifactKind,
        });
      }
    }
    return { ...(obj as object), files: res.files };
  }

  /** 调用角色产出一个工件。失败返回 false，**绝不伪造内容**。 */
  private async produce(
    role: RoleId,
    req: { kind: import('../../core/src/types.ts').ArtifactKind; scope?: 'web' | 'api' | 'shared'; taskId?: string; requirementIds?: string[]; instruction: string },
  ): Promise<boolean> {
    const runner = this.o.runners[role];
    const ctx = this.roleContext(role);
    const res = await runner.produce(req as never, ctx);

    if (res.schemaError || res.content === null) {
      this.logger.warn(`角色 ${role} 产出 ${req.kind} 失败`, { error: res.schemaError });
      return false;
    }

    const content = this.applyProjectContract(res.content, role, req.kind);

    try {
      const artifact = await this.store.put({
        kind: req.kind,
        producer: role,
        content,
        ...(req.scope ? { scope: req.scope } : {}),
        // 多例类工件（CodeModule/TestSuite）用 logicalId 区分不同任务
        ...(req.taskId && req.kind === 'CodeModule' ? { logicalId: `CodeModule-${req.taskId}-${req.scope}` } : {}),
      });
      // 代码类工件必须落到磁盘 —— 锚点检查的是真实文件，不是工件里的字符串
      if (req.kind === 'CodeModule' || req.kind === 'TestSuite') {
        const files = (content as { files?: Array<{ path: string; content: string }> }).files ?? [];
        if (files.length > 0) await materializeFiles(this.o.projectRoot, files);
      }
      this.bus.emit({ t: 'artifact.published', id: artifact.id, kind: artifact.kind, producer: artifact.producer });
      await this.log?.append('artifact.published', {
        id: artifact.id,
        kind: artifact.kind,
        producer: artifact.producer,
        version: artifact.version,
      });
      return true;
    } catch (err) {
      this.logger.warn(`角色 ${role} 产出 ${req.kind} 被 store 拒绝：${(err as Error).message}`);
      return false;
    }
  }

  /** 派发修复工单。全部成功返回 true。 */
  private async dispatchRepairs(orders: WorkOrder[]): Promise<boolean> {
    if (orders.length === 0) return true;
    let allOk = true;
    for (const order of orders) {
      const runner = this.o.runners[order.to];
      let res;
      try {
        res = await runner.repair(order, this.roleContext(order.to));
      } catch (err) {
        // 角色运行器抛错（模型不可用、mock 未配置、provider 异常……）**不得让编排崩溃**。
        // 把它当作「这次修复没能完成」处理 → 上抛给逃生层（圆桌 → 真人 → 带债通过）。
        // 编排层的健壮性直接决定「项目不会停死」这条不变量是否成立。
        this.logger.warn(`工单 ${order.id} 修复过程抛出异常：${(err as Error).message}`);
        allOk = false;
        continue;
      }
      if (res.schemaError || res.content === null) {
        this.logger.warn(`工单 ${order.id} 修复失败：${res.schemaError}`);
        allOk = false;
        continue;
      }
      const content = this.applyProjectContract(res.content, order.to, res.kind);
      try {
        // 同样的逻辑工件产生新版本（而不是新增一个逻辑工件）
        await this.store.put({
          kind: res.kind,
          producer: order.to,
          content,
          ...(order.target && typeof order.target !== 'string' && order.target.scope
            ? { scope: order.target.scope }
            : {}),
          logicalId: inferLogicalId(res.kind, content, this.store),
        });
        const files = (content as { files?: Array<{ path: string; content: string }> }).files ?? [];
        if (files.length > 0) await materializeFiles(this.o.projectRoot, files);
      } catch (err) {
        this.logger.warn(`工单 ${order.id} 的新版本被 store 拒绝：${(err as Error).message}`);
        allOk = false;
      }
    }
    return allOk;
  }

  // ══════════════════════════════════════════════════════════════
  // 圆桌与逃生
  // ══════════════════════════════════════════════════════════════

  private async holdRoundtable(
    trigger: string,
    gateOut: { objections: never[] | import('../../core/src/types.ts').Objection[]; arbitration: never[] | import('../../core/src/types.ts').Arbitration[]; anchors: import('../../core/src/types.ts').AnchorRunResult[]; trigger: ReturnType<typeof determineTrigger> },
  ): Promise<'resolved' | 'PASS_WITH_DEBT' | 'AWAIT_HUMAN' | 'HOLD'> {
    this.roundtablesHeld++;
    const objectionTargets = gateOut.objections.map((o) => o.targetRole);
    const anchorFindings = gateOut.anchors.flatMap((a) => a.findings);
    const participants = inviteParticipants(trigger as never, { objectionTargets, anchorFindings });

    // 第 2 轮谁质询谁：跟着**机械归因**走，而不是跟着与会者数组顺序走。
    // 同一份归因数据（异议目标 + 锚点 findings 目标）已经用来决定邀请谁，
    // 这里再用来决定质询谁 —— 保证圆桌的焦点始终是证据指向的地方。
    const focusTargets = [
      ...new Set([
        ...objectionTargets.filter((r): r is RoleId => r !== 'UNRESOLVED'),
        ...anchorFindings.map((f) => f.targetRole).filter((r): r is RoleId => !!r && r !== 'UNRESOLVED'),
      ]),
    ];
    const agenda =
      gateOut.trigger?.trigger === trigger
        ? buildAgenda({ trigger: trigger as never, objections: gateOut.objections, anchors: gateOut.anchors })
        : [`阶段争议：${trigger}`];

    this.bus.emit({ t: 'roundtable.opened', trigger: trigger as never, participants });

    const ctx = this.makeCtx({});
    const session = new RoundtableSession({
      trigger: trigger as never,
      participants,
      agenda,
      anchorContext: ctx,
      logger: this.logger.child('roundtable'),
      // 与机械裁判用**同一套**命令安全策略：圆桌当场执行 falsifier
      // 和裁判执行 falsifier 不该有两套规则（否则会出现「同样的命令，裁判能跑、圆桌不能跑」）
      commandPolicy: this.judgeCommandPolicy,
      falsifierTimeoutMs: this.falsifierTimeoutMs,
      focusTargets,
    });

    // 每位与会者的发言由该角色产出（prompt 要求必须带证据，否则发言被机械丢弃）
    const speakers = new Map(
      participants.map((role) => [
        role,
        {
          role,
          speak: async (round: 1 | 2, against?: RoleId) => {
            const res = await this.o.provider.complete({
              role,
              purpose: `roundtable:${role}`,
              // schema 必须传 —— 否则 OpenAiCompatProvider 直接返回裸文本（json 为 undefined），
              // 每条发言都会变成「(未给出主张) + 无证据」被机械主持丢弃，圆桌永远无效。
              // 这个缺陷只有真实 provider 才暴露得出来：MockProvider 不看 schema，直接返回脚本值。
              schemaName: 'RoundtableStatement',
              schema: roundtableStatementSchema,
              messages: [
                {
                  role: 'system',
                  content:
                    `你是 AgentForge 的 ${role} 角色，正在参加一场圆桌会议。` +
                    `你必须**只**基于真实存在的文件与工件发言，并给出证据引用。` +
                    `没有证据的发言会被机械主持直接丢弃。只输出 JSON。` +
                    (round === 2
                      ? `这是第 2 轮交叉质询。你若能给出一个**可执行**的 falsifier，机械主持会当场运行它，` +
                        `并用执行结果而不是措辞来判定这场反驳 —— 这比说理有力得多，也更难蒙混。` +
                        `falsifier 形如 {"kind":"executable","command":"...","expect":"exit-nonzero"}。`
                      : ''),
                },
                {
                  role: 'user',
                  content: [
                    `【议程】\n${agenda.join('\n')}`,
                    `【你的立场与证据】第 ${round} 轮${against ? `，针对 ${against} 的主张进行质询` : ''}`,
                    round === 2
                      ? '【输出】{"claim":"...","evidence":[{"kind":"file","path":"...","startLine":1,"endLine":2}],"falsifier":{"kind":"executable","command":"...","expect":"exit-nonzero"}}'
                      : '【输出】{"claim":"...","evidence":[{"kind":"file","path":"...","startLine":1,"endLine":2}]}',
                  ].join('\n\n'),
                },
              ],
              temperature: 0.2,
            });
            const j = (res.json ?? {}) as { claim?: string; evidence?: unknown[]; falsifier?: Falsifier };
            return {
              claim: j.claim ?? '(未给出主张)',
              evidence: (j.evidence ?? []) as never,
              ...(j.falsifier ? { falsifier: j.falsifier } : {}),
            };
          },
        },
      ]),
    );

    const result = await session.run(speakers, async (statements, ag, facts, retryHint) => {
      const sustained = facts.filter((f) => f.outcome === 'sustained');
      const refuted = facts.filter((f) => f.outcome === 'refuted');
      const res = await this.o.provider.complete({
        role: 'pm',
        purpose: 'roundtable:resolution',
        // 同样必须传 schema：少了它 res.json 为 undefined → 决议恒为 null →
        // 圆桌永远「未产出任何决议」，只能一路升级真人（实测踩到，见 docs/07 §L4）
        schemaName: 'RoundtableResolution',
        schema: roundtableResolutionSchema,
        messages: [
          {
            role: 'system',
            content:
              '你是圆桌会议的结构化决议产出者。必须产出**可执行**的决议：' +
              '每条行动项都要有明确负责人与可被锚点或测试机械验证的验收条件。' +
              '禁止「综合考虑」「都有道理」「加强沟通」这类无行动指向的措辞。只输出 JSON。' +
              (sustained.length > 0
                ? '注意：有些主张已被**当场执行的 falsifier 机械证实**，你的归因必须落在它们指向的角色上' +
                  '（或明确写 SHARED），不得与机械证据矛盾。'
                : '') +
              // 结构化重试：把上一次**具体的**校验错误回喂，而不是让模型盲改。
              // 校验不过时整份决议会作废并升级真人，所以这一次修正机会很值钱。
              (retryHint
                ? `\n\n【上一次的决议被判无效，原因如下 —— 请针对性修正后重新输出完整决议】\n${retryHint}\n` +
                  '提示：验收条件必须含一个可被程序检查的抓手（命令、文件路径、端点、锚点编号、' +
                  '具体的字段名，或明确的数值/数量断言）。反之，「提升质量」这类无法核验的措辞会被直接拒绝。'
                : ''),
          },
          {
            role: 'user',
            content: [
              `【议程】\n${ag.join('\n')}`,
              `【各方发言（证据已机械核验；被证伪的反驳已剔除）】\n${JSON.stringify(statements, null, 2).slice(0, 8000)}`,
              sustained.length > 0
                ? `【已被机械证实的事实（决议必须与之一致）】\n${sustained
                    .map(
                      (f) =>
                        `- ${f.role} 的反驳「${f.claim}」已复现（命令 \`${f.command}\` 退出码 ${f.exitCode}）→ 问题在 ${f.implicates}`,
                    )
                    .join('\n')}`
                : '【已被机械证实的事实】无 —— 本次会议没有可执行的反驳，归因由你根据发言判断',
              refuted.length > 0
                ? `【已被机械证伪的反驳（不得作为归因依据）】\n${refuted
                    .map((f) => `- ${f.role} 的主张「${f.claim}」未能复现（命令 \`${f.command}\` 退出码 ${f.exitCode}）`)
                    .join('\n')}`
                : '',
              '【输出】符合 RoundtableMinute.resolution 结构的 JSON 对象。',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        temperature: 0.1,
      });
      return (res.json ?? null) as RoundtableResolution | null;
    });

    const minuteArt = await this.store.put({
      kind: 'RoundtableMinute',
      producer: 'orchestrator',
      content: result.minute as never,
    });
    this.bus.emit({
      t: 'roundtable.closed',
      minuteId: minuteArt.id,
      resolution: result.minute.resolution,
      resolutionValid: result.resolutionValid,
      ...(result.invalidReason ? { invalidReason: result.invalidReason } : {}),
      facts: result.facts,
      falsifiersRun: result.falsifiersRun,
      discardedStatements: result.discardedStatements,
      resolutionAttempts: result.resolutionAttempts,
    });
    await this.log?.append('roundtable.closed', {
      minuteId: minuteArt.id,
      trigger,
      participants,
      resolutionValid: result.resolutionValid,
      invalidReason: result.invalidReason,
      discardedStatements: result.discardedStatements,
      falsifiersRun: result.falsifiersRun,
      facts: result.facts,
    });

    this.lastResolutionValid = result.resolutionValid;

    if (result.resolutionValid && result.minute.resolution) {
      // 有有效决议 → 生成行动项工单，回到阶段内循环
      let idx = 0;
      for (const action of result.minute.resolution.actions) {
        idx++;
        const order: WorkOrder = {
          id: `WO-RT-${minuteArt.id}-${idx}`,
          stage: this.ledger.stage,
          to: action.owner,
          reason: { kind: 'roundtable-action', minuteId: minuteArt.id, actionIndex: idx - 1 },
          target: { newKind: 'CodeModule' },
          acceptance: action.acceptance,
          status: 'open',
          createdAt: new Date().toISOString(),
        };
        this.workOrders.push(order);
        this.bus.emit({ t: 'workorder.created', order });
      }
      return 'resolved';
    }

    // 无有效决议 → 走第 2 / 第 3 层
    const escaped = await this.escape({
      stage: this.ledger.stage,
      reason: 'roundtable-deadlock',
      summary: result.invalidReason ?? '圆桌两轮未能产出有效决议',
      agenda,
      objections: gateOut.objections,
      arbitration: gateOut.arbitration,
      anchors: gateOut.anchors,
      roundtableMinuteId: minuteArt.id,
    });
    return escaped;
  }

  /**
   * 三层逃生的执行：第 2 层升级真人，第 3 层带债通过。
   * 这个函数**一定会返回一个可执行结果** —— 它是「项目不会停死」的最终保证。
   */
  private async escape(args: {
    stage: StageId;
    reason: string;
    summary: string;
    agenda: string[];
    objections: import('../../core/src/types.ts').Objection[];
    arbitration: import('../../core/src/types.ts').Arbitration[];
    anchors: import('../../core/src/types.ts').AnchorRunResult[];
    roundtableMinuteId?: ArtifactId;
  }): Promise<'PASS_WITH_DEBT' | 'AWAIT_HUMAN' | 'HOLD'> {
    const hold = this.directives.filter((d) => d.kind === 'hold');
    if (hold.length > 0) {
      this.bus.emit({ t: 'run.paused', reason: hold[hold.length - 1].text });
      return 'HOLD';
    }

    const decision = decideEscape({
      roundtablesHeld: this.roundtablesHeld,
      lastResolutionValid: this.lastResolutionValid,
      humanAvailable: this.o.humanAvailable ?? false,
      roundtableAttempted: this.roundtablesHeld > 0 || args.reason !== 'blocked-attempts-exhausted',
    });

    if (decision.action === 'ROUNDTABLE') {
      // 尚未经过圆桌：这里返回「带债」是错的，但 escape 只在圆桌之后被调用；
      // 为安全起见把这种情况按升级处理，避免无声前进。
      this.logger.warn(`escape 被在没有圆桌的情况下调用（${args.reason}），按升级真人处理`);
    }

    if (decision.action === 'ESCALATE_HUMAN') {
      const bundle = buildEscalationBundle({
        id: `ESC-${args.stage}-${String(this.escalations.length + 1).padStart(3, '0')}`,
        stage: args.stage,
        reason: 'roundtable-deadlock',
        summary: args.summary,
        agenda: args.agenda,
        objections: args.objections,
        arbitration: args.arbitration,
        anchors: args.anchors,
        ...(args.roundtableMinuteId ? { roundtableMinuteId: args.roundtableMinuteId } : {}),
      });
      this.escalations.push(bundle);
      this.bus.emit({ t: 'escalation.human', bundleId: bundle.id });
      await this.log?.append('escalation.human', { bundleId: bundle.id, summary: bundle.summary });
      return 'AWAIT_HUMAN';
    }

    // 第 3 层：带债通过
    const requirementIds = this.requirementIds();
    const outcome = await passWithDebt(this.store, this.log ?? (await this.dummyLog()), {
      stage: args.stage,
      summary: args.summary,
      objections: args.objections,
      arbitration: args.arbitration,
      requirementIds,
      reason: this.o.humanAvailable ? 'user-let-it-pass' : 'human-unavailable',
    });
    this.debtIds.push(outcome.debt.id);
    this.debtRequirements.push(...outcome.markedRequirements);
    this.bus.emit({ t: 'debt.recorded', debtId: outcome.debt.id, requirementIds: outcome.markedRequirements });
    this.logger.warn(`带债通过：${args.summary}（受影响需求 ${outcome.markedRequirements.length} 条，已标记 ACCEPTED_WITH_DEBT）`);
    return 'PASS_WITH_DEBT';
  }

  // ══════════════════════════════════════════════════════════════
  // 上下文与工具
  // ══════════════════════════════════════════════════════════════

  /**
   * 构造锚点上下文。
   * 注意 `offline` 默认 true：没有网络时 A1 的远端核实必须报 WARN 而不是伪造 PASS。
   *
   * profile 在这里**重新计算**（而不是构造时算一次）：
   * 真人可能在 run 进行中才投递 constraint 建议书，
   * 那时下一个 Gate 就必须按新约束检查 —— 否则「随时可介入」就成了一句空话。
   */
  private makeCtx(proposals: SemanticProposals): AnchorContext {
    return createAnchorContext({
      projectRoot: this.o.projectRoot,
      store: this.store,
      profile: applyDirectivesToProfile(this.effectiveProfile, compileDirectives(this.directives)),
      logger: this.logger.child('anchor'),
      offline: this.o.offline ?? true,
      proposals,
      /**
       * runPrefix 必须**每个 ctx 唯一**，否则锚点运行记录会跨 Gate 互相覆盖。
       *
       * 踩过的坑（docs/07 §L14）：`createAnchorContext` 内部有一个从 1 开始的计数器，
       * runId 形如 `${prefix}-001`。原来 prefix 就是 this.runId，
       * 而每次 Gate 都会新建一个 ctx —— 于是**每个 Gate 都从 -001 重新编号**，
       * `anchors/${runId}.json` 后写覆盖先写。
       *
       * 实测后果：跑了 7 个 Gate 的运行，anchors/ 目录里只剩**最后一个 Gate**
       * 的 10 条记录，前面 6 次的锚点结论全部丢失。这会带来两个真问题：
       *   1. 审计历史没了 —— 事后无法回答「这个失败是第几轮出现的」
       *   2. 更严重：`{kind:'anchor', runId}` 形式的证据引用会解析到**另一个 Gate
       *      的结果**（B1/B3 都要核验这种引用），等于用错误的记录为判定背书
       */
      runPrefix: `${this.runId}-c${++this.ctxSeq}`,
      /**
       * 把契约的当前状态交给 A8。
       *
       * `hasBaseline` 为 false 时 A8 会诚实报 SKIPPED（本次运行确实没有可保护的基准），
       * 而不是伪造一个 PASS —— 一个「永远为绿的检查」比没有这个检查更糟。
       */
      contract: {
        hasBaseline: this.contract.pkgExists || Object.keys(this.contract.protectedFiles).length > 0,
        declaredPkgKeys: Object.keys(this.contract.pkgKeys),
        protectedFiles: Object.keys(this.contract.protectedFiles),
        violations: this.contractViolations,
      },
      emit: (e) => this.bus.emit(e),
    });
  }

  /**
   * 在 Gate 评估前重新推导 profile（若配置了 refreshProfile）。
   *
   * 必须发生在**代码落盘之后、锚点运行之前**。放在阶段开始时是错的：
   * BUILDING 阶段刚开始时代码还不存在，而 A4/A5/A6 恰恰要检查那些代码。
   * 放在 Gate 评估之前则刚好 —— 那时本轮的工件已经写完盘了。
   */
  private async refreshEffectiveProfile(): Promise<void> {
    const fn = this.o.refreshProfile;
    if (!fn) return;
    let next: Awaited<ReturnType<typeof fn>> = null;
    try {
      next = await fn(this.o.profile);
    } catch (err) {
      // 推导失败不是致命问题：维持现状即可。锚点会因为「没有命令」而报 SKIPPED，
      // 那是**诚实**的结果，好过让整个 run 崩掉。
      this.logger.warn(`重新推导 profile 失败，沿用启动时的 profile：${(err as Error).message}`);
      return;
    }
    if (!next) return;

    const before = this.effectiveProfile;
    const changed =
      before.typecheck?.cmd !== next.profile.typecheck?.cmd ||
      JSON.stringify(before.typecheck?.args) !== JSON.stringify(next.profile.typecheck?.args) ||
      before.test?.cmd !== next.profile.test?.cmd ||
      JSON.stringify(before.test?.args) !== JSON.stringify(next.profile.test?.args) ||
      before.run?.cmd !== next.profile.run?.cmd;

    this.effectiveProfile = next.profile;
    if (!changed) return;

    // 这是**重要事件**，必须留痕：它决定了 A4/A5/A6 从 SKIPPED 变成真检查，
    // 也就是「交付结论的可信度」发生了变化。
    const describe = (s: ProjectProfile['typecheck']) => (s ? `${s.cmd} ${s.args.join(' ')}` : '（无 → 锚点报 SKIPPED）');
    const line =
      `profile 已更新：typecheck ${describe(before.typecheck)} → ${describe(next.profile.typecheck)}；` +
      `test ${describe(before.test)} → ${describe(next.profile.test)}`;
    this.logger.info(line);
    await this.log?.append('profile.refreshed', {
      typecheck: next.profile.typecheck,
      test: next.profile.test,
      notes: next.notes ?? [],
    });
  }

  /**
   * 把 A5 的**真实执行结果**固化成 `TestReport` 工件。
   *
   * 为什么必须由编排器做（而不是让 test 角色写）：
   * TestReport 的字段是 `command / exitCode / passed / failed / failing` —— 全是执行事实。
   * 让 LLM 写这些，只会得到一个「看起来合理的编造值」，那正是本项目要消灭的东西。
   * 唯一诚实的来源是真的跑过一次测试的那个锚点。
   *
   * 为什么必须有这个工件（真实 LLM 实测发现的系统性假失败，docs/07 §L8）：
   * PM 的任务图自然会声明「测试任务交付 TestReport」，而 B2 锚点会拿声明的交付物
   * 去核对工件库。此前**没有任何代码路径产出过 TestReport**，
   * 于是 B2 必定报 deliverable-missing，派出的工单又无法通过重试修复
   * （因为缺的不是角色的产出，是编排层没做这件事）—— 项目因此必然带债。
   *
   * 纪律：只在 A5 真的执行过测试时才写。A5 报 SKIPPED / 命令起不来时，
   * 我们**没有**执行事实可固化，此时宁可不产出工件，也不写一份空报告 ——
   * 「没测过」不能被写成一份看起来测过的报告。
   */
  private async publishTestReport(anchors: AnchorRunResult[]): Promise<void> {
    const a5 = anchors.find((a) => a.anchorId === 'A5');
    if (!a5 || a5.verdict === 'SKIPPED' || a5.verdict === 'INVALID_EVIDENCE') return;

    const meta = a5.meta as
      | {
          exitCode?: number;
          command?: string;
          passed?: number;
          failed?: number;
          failing?: Array<{ name: string; message: string }>;
        }
      | undefined;

    // 执行事实必须齐全才写：缺任何一项都说明这不是一次干净的观测
    if (
      !meta ||
      typeof meta.exitCode !== 'number' ||
      typeof meta.passed !== 'number' ||
      typeof meta.failed !== 'number'
    ) {
      return;
    }

    try {
      const art = await this.store.put({
        kind: 'TestReport',
        producer: 'orchestrator',
        content: {
          command: meta.command ?? '',
          exitCode: meta.exitCode,
          passed: meta.passed,
          failed: meta.failed,
          failing: meta.failing ?? [],
        } satisfies TestReportDoc,
      });
      await this.log?.append('testreport.published', {
        reportId: art.id,
        exitCode: meta.exitCode,
        passed: meta.passed,
        failed: meta.failed,
        a5Verdict: a5.verdict,
      });
    } catch (err) {
      // 写不进去不该让 run 崩掉：B2 会如实报 deliverable-missing，
      // 那是一个诚实的结果，比崩溃好。
      this.logger.warn(`TestReport 固化失败：${(err as Error).message}`);
    }
  }

  /**
   * 把 B1 的逐条判定回写成 `requirement.status`。
   *
   * ## 为什么必须做（真实 LLM 实测发现的「假绿灯」，docs/07 §L11）
   *
   * B1 每轮都会给出 `met / not-met / uncertain`，但**从来没有人把它写回需求工件**。
   * 实测 9 轮真实运行，`requirement.status` 全部停留在初始值 `open` ——
   * 一个存在、有 schema、有 `met` 枚举值、却永远不变化的字段。
   *
   * 而 `delivery` 的初值是 `'complete'`，控制台把 complete 显示成
   * 「完整交付 = 全部需求通过验证」。于是出现了一个很说明问题的组合：
   * **9 轮里唯一被判「完整交付」的那轮，恰好也是 B1 对两条需求都判 `uncertain` 的那轮。**
   *
   * 这一条只负责「让事实可见」，**不改变交付判定** ——
   * 严格化（未确认就不许叫 complete）是另一个决定，应当基于真实数据再拍板，
   * 而不是顺手一起改（那会让交付语义变动与数据可见性变动混在一起，无法归因）。
   *
   * 映射规则：
   *   `met`                        → `met`
   *   `uncertain` / 证据无效 / 无判定 → `unverified`（**查过但确认不了**）
   *   `not-met`                    → 保持 `open`（确认没做到就是还没做到）
   */
  private async syncRequirementStatuses(anchors: AnchorRunResult[]): Promise<void> {
    const b1 = anchors.find((a) => a.anchorId === 'B1');
    if (!b1) return;

    const meta = b1.meta as
      | { outcomes?: Array<{ requirementId: string; verdict: 'met' | 'not-met' | 'uncertain' | 'unverified' }> }
      | undefined;
    const outcomes = meta?.outcomes ?? [];
    if (outcomes.length === 0) return;

    const updates = outcomes.map((o) => ({
      id: o.requirementId,
      // 全量映射，**不能过滤任何分支** —— 理由见 requirementStatusForVerdict 的说明：
      // 漏掉 not-met 会让上一轮写的 unverified 永远清不掉（少报一个确定的失败）。
      status: requirementStatusForVerdict(o.verdict),
    }));

    if (updates.length === 0) return;

    try {
      const art = await this.store.markRequirementsStatus(updates);
      const statuses = (art?.content as { requirements?: Array<{ id: string; status: string }> } | undefined)?.requirements ?? [];
      this.lastRequirementStatuses = statuses.map((r) => ({ id: r.id, status: r.status }));
      await this.log?.append('requirement.status.synced', {
        updates,
        statuses: this.lastRequirementStatuses,
      });
    } catch (err) {
      // 回写失败不该让 run 崩掉；但必须留痕，否则「状态没被更新」会被误读成「需求没达成」
      this.logger.warn(`需求验收状态回写失败：${(err as Error).message}`);
    }
  }

  private roleContext(role: RoleId): RoleContext {
    void role;
    return {
      stage: this.ledger.stage,
      store: this.store,
      // 与锚点用同一份 profile：角色看到的「这个项目怎么编译/怎么测试」
      // 必须与锚点实际执行的命令一致，否则角色会按一套规则写代码、被另一套规则判定
      profile: this.effectiveProfile,
      workOrders: this.workOrders.filter((w) => w.status === 'open'),
      contractHash: this.store.frozenContractHash(),
      userBrief: this.o.userBrief,
      directives: this.directives.map((d) => ({
        kind: d.kind,
        text: d.text,
        ...(d.constraints ? { constraints: d.constraints } : {}),
      })),
    };
  }

  private requirementIds(): string[] {
    const art = this.store.head('Requirement');
    if (!art) return [];
    return ((art.content as { requirements: Array<{ id: string }> }).requirements ?? []).map((r) => r.id);
  }

  private async dummyLog(): Promise<DecisionLog> {
    const l = new DecisionLog(this.o.projectRoot);
    await l.init();
    return l;
  }

  // ── 人类介入接口（前端调用） ──────────────────────────────────

  /**
   * 惰性初始化。
   *
   * 注意：不能只在 run() 里初始化 store —— 真人可能在流水线启动前就投建议书
   * （例如「先等一下，我要看 PRD」），那时 store 还没有目录与计数器。
   * 因此所有对外入口都必须先 ensureInit()。
   */
  private initPromise: Promise<void> | null = null;
  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.store.init();
        if (this.log) await this.log.init();
      })();
    }
    return this.initPromise;
  }

  /** 真人投递建议书。优先级高于一切机器人意见。 */
  async submitDirective(doc: {
    kind: DirectiveRecord['kind'];
    text: string;
    targetRefs?: ArtifactId[];
    constraints?: string[];
    supersedes?: ArtifactId[];
    expiresAtStage?: StageId;
  }): Promise<DirectiveRecord> {
    await this.ensureInit();
    const art = await this.store.put({ kind: 'Directive', producer: 'human', content: doc });
    const record: DirectiveRecord = {
      id: art.id,
      kind: doc.kind,
      text: doc.text,
      ...(doc.targetRefs ? { targetRefs: doc.targetRefs } : {}),
      ...(doc.constraints ? { constraints: doc.constraints } : {}),
      ...(doc.supersedes ? { supersedes: doc.supersedes } : {}),
      ...(doc.expiresAtStage ? { expiresAtStage: doc.expiresAtStage } : {}),
      at: art.createdAt,
      hash: art.contentHash,
    };

    // ── 真人建议书里的 constraint 编译成机械可校验的规则 ────────────
    //
    // 这段曾经是空的（只有一句 `void allow;`），也就是说文档承诺了
    // 「constraint 由 A1 强制校验」而实际不生效 —— 见 docs/07 §J1。
    // 现在真的编译并落到 profile 上，且**明确区分**「能机械校验的」与「只能作为指令的」。
    //
    // 顺序很重要：必须**先 push 再编译**。第一版写反了，于是刚投的建议书
    // 自己不在编译输入里 —— 表现为「投了约束但 executed 列表是空的」，
    // 用户会以为建议书没生效（确实没生效，但不是因为编译器的问题）。
    this.directives.push(record);

    const compiled = compileDirectives(this.directives);
    this.enforcement = describeEnforcement(compiled);

    if (doc.kind === 'resume') this.ledger.humanResume();
    if (doc.kind === 'override') this.ledger.humanForceAdvance();
    if (doc.kind === 'let-it-pass') this.letItPassPending = true;

    /**
     * 机械裁决：这条建议书在当前处境下到底会不会产生效果。
     *
     * 必须在**副作用之后**算 —— 它回答的是「我刚才那条指令现在意味着什么」，
     * 而不是「如果不考虑我刚做的事会怎样」。
     */
    const advisory = this.adjudicate(record);
    record.advisory = advisory;
    if (advisory.outcome !== 'applied') {
      this.logger.warn(`建议书 ${record.id}（${record.kind}）：${advisory.message}`);
    }

    this.bus.emit({ t: 'directive.received', directive: record });
    await this.log?.append('directive.received', {
      ...record,
      advisory,
      enforcement: {
        enforced: this.enforcement.enforced.filter((e) => e.directiveId === record.id),
        advisory: this.enforcement.advisory.filter((a) => a.directiveId === record.id),
      },
    });
    if (this.enforcement.enforced.some((e) => e.directiveId === record.id)) {
      this.logger.info(`建议书已编译为强制约束：${JSON.stringify(this.enforcement.enforced.filter((e) => e.directiveId === record.id))}`);
    }
    if (this.enforcement.advisory.some((a) => a.directiveId === record.id)) {
      this.logger.warn(
        `建议书无法被机械校验（仅作为角色指令，不会被强制执行）：${this.enforcement.advisory
          .filter((a) => a.directiveId === record.id)
          .map((a) => a.raw)
          .join('；')}`,
      );
    }
    return record;
  }

  /** 本次 run 的建议书执行情况（哪些真的生效、哪些只是指令）。 */
  get directiveEnforcement(): DirectiveEnforcementReport | null {
    return this.enforcement;
  }

  /** 取走「继续推进」指令（用一次即消耗）。 */
  private consumeLetItPass(): boolean {
    if (!this.letItPassPending) return false;
    this.letItPassPending = false;
    return true;
  }

  /**
   * 对一条建议书做机械裁决（收集「现在卡在哪」的事实，交给纯函数判定）。
   *
   * 判定规则本身在 `adjudicateDirective` —— 它是导出的纯函数，可脱离编排器穷举测试。
   * 这里只负责把「当前处境」翻译成它的输入。
   */
  private adjudicate(doc: { kind: DirectiveKind }): DirectiveAdvisory {
    const facts = (this.lastGate?.anchors ?? [])
      .flatMap((a) => a.findings.map((f) => ({ anchorId: a.anchorId as string, f })))
      .filter((x) => x.f.severity === 'fail')
      .map((x) => ({ anchorId: x.anchorId, code: x.f.code, message: x.f.message }));

    return adjudicateDirective({
      kind: doc.kind,
      stage: this.lastGate?.stage ?? null,
      blocked: this.lastGate?.blocked ?? false,
      facts,
    });
  }

  get ledgerRef(): HostLedger {
    return this.ledger;
  }

  get events(): readonly import('../../core/src/types.ts').ForgeEvent[] {
    return this.bus.events();
  }
}

// ════════════════════════════════════════════════════════════════
// 指令文本
// ════════════════════════════════════════════════════════════════

function intakeInstruction(brief: string): string {
  return [
    '把用户的原始诉求拆解为**可验收**的需求清单。',
    `原始诉求：${brief}`,
    '要求：',
    '- 每条需求必须给出 acceptance（怎么验证它做到了），且必须是程序可以检查的形式。',
    '- 编号从 R-001 开始连续。',
    '- 不要设计用户没有要求的功能。',
    '输出 Requirement 集合工件（{"requirements": [...]}）。',
  ].join('\n');
}

function planningPrdInstruction(): string {
  return [
    '基于已发布的 Requirement 工件产出 PRD。',
    '要求：requirementIds 必须覆盖**全部**已发布需求（漏掉任何一条都会让 B2 锚点判 FAIL）。',
    '输出 PRD 工件。',
  ].join('\n');
}

function planningTasksInstruction(): string {
  return [
    '基于需求与 PRD 产出任务图。',
    '要求：',
    '- 每条需求都必须至少被一个任务的 requirementIds 覆盖。',
    '- 每个任务的 acceptance 必须可被锚点或测试机械验证。',
    '- owner 只能是 pm / frontend / backend / test。',
    '输出 TaskGraph 工件。',
  ].join('\n');
}

function contractInstruction(): string {
  return [
    '产出前后端共同遵守的接口契约。',
    '要求：',
    '- openapi.paths 列出全部端点；jsonSchemas 定义全部数据模型。',
    '- generatedTypesPath 指向将要生成的前端/后端共享类型文件。',
    '- 契约一旦冻结即 hash 锁定，因此请一次写完整。',
    '输出 Contract 工件。',
  ].join('\n');
}

function codeInstruction(task: {
  id: string;
  title?: string;
  scope: 'web' | 'api' | 'shared';
  requirementIds: string[];
}): string {
  return [
    `实现任务 ${task.id}${task.title ? `（${task.title}）` : ''}，范围 ${task.scope}。`,
    `对应需求：${task.requirementIds.join(', ')}`,
    '硬性要求：',
    '- 接口类型必须从契约生成的类型文件导入，不要手写契约中已有的模型（A7 锚点会检查）。',
    '- 只导入真实存在且已安装的包与符号（A1/A2 锚点会检查）。',
    '- 相对导入必须指向真实存在的文件（A3 锚点会检查）。',
    '- 代码会被真实执行：跑类型检查、测试与运行时探针。',
    '输出 CodeModule 工件（{"files":[{"path":"...","content":"..."}]}）。',
  ].join('\n');
}

function testInstruction(): string {
  return [
    '为已实现的代码编写测试。',
    '要求：',
    '- 每条 must 级需求都至少有一个测试覆盖，并在 covers 中声明需求编号（B2 锚点会检查）。',
    '- 测试必须真的会失败：不要写空断言或恒真断言。',
    '输出 TestSuite 工件（{"framework":"...","files":[...],"covers":[...]}）。',
  ].join('\n');
}

function reviewInstruction(): string {
  return [
    '对当前阶段的交付物做对抗性审查。',
    '注意：确定性检查（A 层锚点）刚刚全部通过，所以不要再重复它们已经证明的事情。',
    '你的价值在于判断实现是否**语义上偏离了需求**。',
    '每条异议必须给出：可证伪的 claim、真实文件+行区间的 evidence、falsifier、以及 targetRole。',
    '如果确实找不到可证伪的问题，输出 {"stage":"REVIEW","objections":[],"noObjection":true} —— 这是正确答案，不会受惩罚。',
    '输出 AnchoredReview 工件。',
  ].join('\n');
}

function describeAction(a: import('../../core/src/types.ts').NextAction): string {
  switch (a.kind) {
    case 'RETRY_ROLE':
      return `RETRY_ROLE(${a.target},${a.orders.length}张工单)`;
    case 'ROUNDTABLE':
      return `ROUNDTABLE(${a.trigger})`;
    case 'ADVANCE':
      return `ADVANCE(${a.to})`;
    case 'ARBITRATE_HUMAN':
      return 'ARBITRATE_HUMAN';
    case 'PASS_WITH_DEBT':
      return 'PASS_WITH_DEBT';
    case 'HOLD':
      return 'HOLD';
  }
}

/** 修复工件时推断它属于哪个逻辑工件（多例类工件需要显式 logicalId）。 */
function inferLogicalId(
  kind: import('../../core/src/types.ts').ArtifactKind,
  content: unknown,
  store: ArtifactStore,
): string | undefined {
  if (kind !== 'CodeModule') return undefined;
  const files = (content as { files?: Array<{ path: string }> }).files ?? [];
  const first = files[0]?.path ?? '';
  const scope = first.includes('/web/') || first.startsWith('web/') ? 'web' : first.includes('/api/') ? 'api' : 'shared';
  void store;
  return `CodeModule-repair-${scope}`;
}
