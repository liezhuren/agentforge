/**
 * Gate 门禁：把一个阶段的检查结果折算成「下一步做什么」。
 *
 * 不变量（docs/01-architecture.md §6 第 8 条）：**本文件不含 LLM 调用**。
 * `nextAction` 由程序计算，不由 LLM 决定 —— 如果让模型决定「下一步做什么」，
 * 整个系统立刻变成不可调试的黑箱。模型只负责产出工件（roles）与提议（B 层锚点输入）。
 *
 * 最关键的一条判定顺序：
 *   **A 层有硬失败时不去打扰主理人。**
 *   编译器已经知道错在哪个文件，能机械归因并直接派工单；
 *   让 LLM 再复述一遍只会更模糊、顺手编几个理由，并给它制造滥报机会。
 */

import type {
  AnchorId,
  AnchorRunResult,
  AnchoredReviewDoc,
  ArtifactKind,
  BlockReason,
  DirectiveRecord,
  GateResult,
  Objection,
  ProjectProfile,
  RoleId,
  StageId,
  WorkOrder,
} from '../../core/src/types.ts';
import type { ArtifactStore } from '../../core/src/store.ts';
import type { EventBus } from '../../core/src/events.ts';
import type { DecisionLog } from '../../core/src/decisionlog.ts';
import type { Logger } from '../../core/src/logger.ts';
import { silentLogger } from '../../core/src/logger.ts';
import {
  ANCHOR_INDEX,
  attributionOf,
  isHardFailure,
  runAnchors,
  type AnchorContext,
  type SemanticProposals,
} from '../../anchors/src/index.ts';
import type { HostLedger } from './ledger.ts';
import type { MechanicalJudge, ArbitrationSummary } from './judge.ts';
import { buildAgenda, determineTrigger, type TriggerDecision } from './roundtable.ts';
import { newBundleId, type EscalationBundle } from './escape.ts';

/**
 * 各阶段跑哪些锚点。
 *
 * 刻意不做「每阶段都全跑」，也不做「没意义的检查也跑一遍」：
 *  - INTAKE 不放锚点：需求的可验收性已经由工件 schema 强制（acceptance 至少一条），
 *    而覆盖矩阵（B2 的主体）要等任务图存在才有意义。在 INTAKE 跑 B2 只会必然得到
 *    「尚无任务图」的 FAIL —— 那不是发现问题，是检查用错了地方。
 *  - REVIEW 是唯一含 B3 的阶段，因此也是**唯一唤醒主理人**的阶段。
 */
export const STAGE_ANCHORS: Record<StageId, AnchorId[]> = {
  INTAKE: [],
  PLANNING: ['B2'],
  CONTRACTING: ['A7', 'B2'],
  BUILDING: ['A1', 'A2', 'A3', 'A4', 'A5', 'A8', 'B2'],
  REVIEW: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'B1', 'B2', 'B3'],
  ROUNDTABLE: [],
  ARBITRATION: [],
  DELIVERED: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'B1', 'B2'],
};

/** 归因优先级：问题落到谁头上，工单就派给谁。 */
const ROLE_PRIORITY: RoleId[] = ['backend', 'frontend', 'test', 'pm'];

export type GateDeps = {
  store: ArtifactStore;
  profile: ProjectProfile;
  ledger: HostLedger;
  judge: MechanicalJudge;
  bus?: EventBus;
  log?: DecisionLog;
  logger?: Logger;
  /** 由编排器提供，保证每次 Gate 用同一份 projectRoot 与离线设置。 */
  makeAnchorContext: (proposals: SemanticProposals) => AnchorContext;
};
export type GateInput = {
  stage: StageId;
  sequence: number;
  /** B 层语义提议（由 roles 层 / LLM 产出，Gate 只转交不采信）。 */
  proposals?: SemanticProposals;
  /** 主理人本轮提交的审查包。A 层全绿时才会被使用。 */
  hostReview?: AnchoredReviewDoc | null;
  /** 当前生效的真人建议书。 */
  directives?: DirectiveRecord[];
  /** 上一轮 Gate 的硬失败签名（T4：同类失败反复出现且归因分散）。 */
  previousHardFailureSignature?: string | null;
  roundtableAttempted?: boolean;
  roundtablesHeld?: number;
  humanAvailable?: boolean;
  /** 需求清单（用于异议升级时确定受影响需求）。 */
  requirementIds?: string[];
};

export type GateOutput = GateResult & {
  summary: ArbitrationSummary | null;
  trigger: TriggerDecision;
  escalation?: EscalationBundle;
  /** 硬失败签名，供下一轮比对（T4）。 */
  hardFailureSignature: string | null;
};

export class Gate {
  private deps: GateDeps;
  private logger: Logger;
  private orderSeq = 0;
  private bundleSeq = 0;

  constructor(deps: GateDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? silentLogger('gate');
  }

  async evaluate(input: GateInput): Promise<GateOutput> {
    const { stage, sequence } = input;
    const directives = input.directives ?? [];

    // ── 人类的物理刹车优先于一切 ─────────────────────────────────
    const hold = directives.filter((d) => d.kind === 'hold');
    if (hold.length > 0) {
      const ledger = this.deps.ledger.snapshot();
      return this.mkResult({
        stage,
        sequence,
        anchors: [],
        hardFailures: [],
        objections: [],
        arbitration: [],
        blocked: true,
        reason: 'USER_HOLD',
        ledger,
        nextAction: { kind: 'HOLD', reason: hold[hold.length - 1].text },
        hostInvoked: false,
        workOrders: [],
        aLayerHealthy: true,
        summary: null,
        trigger: null,
        hardFailureSignature: null,
      });
    }

    // ── 1. 跑本阶段的锚点 ────────────────────────────────────────
    const anchorIds = STAGE_ANCHORS[stage];
    const ctx = this.deps.makeAnchorContext(input.proposals ?? {});
    const anchors =
      anchorIds.length === 0
        ? []
        : await runAnchors(
            ctx,
            anchorIds.map((id) => ANCHOR_INDEX.get(id)!).filter(Boolean),
          );

    const aAnchors = anchors.filter((a) => a.anchorId.startsWith('A'));
    const hardFailures = aAnchors.filter(isHardFailure);
    const aLayerHealthy = hardFailures.length === 0;
    const signature = hardFailures.length > 0 ? this.signatureOf(hardFailures) : null;

    // ── 2. A 层有硬失败：机械归因 → 直接派工单，不叫主理人 ───────
    if (hardFailures.length > 0) {
      const orders = this.buildWorkOrders(hardFailures, stage);
      const attribution = attributionOf(hardFailures);
      const roles = Object.keys(attribution).filter((r) => r !== 'UNRESOLVED');
      const hasUnresolved = (attribution['UNRESOLVED'] ?? 0) > 0;

      // ── 优先打回，圆桌只是兜底（真实 LLM 实测改正，docs/07 §L10）────
      //
      // 原来的判定是 `roles.length >= 2 || hasUnresolved`，即**只要有一条归不了因**
      // 就把整个阶段判定为「需要开会」。实测这是在自找麻烦：
      // 同一轮里 A6 明明已经明确归到 backend、本可以直接打回返工，
      // 却因为 A3/A4 归因缺失而陪着一起进圆桌 ——
      // 圆桌要开会、要产决议、要校验，成本比打回高一到两个数量级。
      //
      // 正确的优先级是：**能归因就打回，一条都归不了因才开会。**
      //   - roles.length >= 2 → 真的是「互相甩锅」（多个角色都被指到），需要协商
      //   - roles.length === 1 → 有明确责任方 ⇒ **打回**
      //   - roles.length === 0 → 没有任何可打回的对象 ⇒ 这才需要圆桌
      //
      // 注意最后一种情况里「部分归因缺失」不构成开会的理由：
      // 打回已经归到的那部分，下一轮 Gate 会重新评估 ——
      // 那时若只剩归不了的，再开会也不迟。**先做能做的事。**
      const wantsRoundtable = roles.length >= 2 || roles.length === 0;

      // ── 不再为「没变化的失败」反复开会 ──────────────────────────
      //
      // 实测出现过一个阶段连开 6 次 T4 圆桌：圆桌产出有效决议 → 派工单 →
      // 角色返工 → 硬失败签名**完全没变** → 又满足 T4 → 再开会 …… 循环烧钱。
      // （TriggerContext.roundtablesHeld 这个字段本来就是为「避免无限开会」而加的，
      //  但它此前从未被读过 —— 防护是空的。）
      //
      // 规则：**已经开过圆桌、且本轮硬失败签名与上一轮完全相同** ⇒ 不再开会。
      // 此时改为打回主责角色，编排层会识别「修复无效」并转逃生流程（1 轮收敛）。
      const roundtableAlreadyHeld = (input.roundtablesHeld ?? 0) > 0;
      const signatureUnchanged =
        signature !== null && signature === (input.previousHardFailureSignature ?? null);
      const t4 = wantsRoundtable && !(roundtableAlreadyHeld && signatureUnchanged);

      const primaries = roles.length > 0 ? (roles as RoleId[]) : [];
      const target = this.pickPrimaryRole(primaries);

      const nextAction = t4
        ? { kind: 'ROUNDTABLE' as const, trigger: 'T4' as const }
        : { kind: 'RETRY_ROLE' as const, target, orders: orders.map((o) => o.id) };

      this.logger.warn(
        `[${stage}] A 层硬失败 ${hardFailures.length} 个，归因=${JSON.stringify(attribution)}，` +
          `生成工单 ${orders.length} 张，nextAction=${nextAction.kind}${t4 ? '(T4)' : ''}`,
      );

      const result = this.mkResult({
        stage,
        sequence,
        anchors,
        hardFailures,
        objections: [],
        arbitration: [],
        blocked: true,
        reason: 'ANCHOR_HARD_FAIL',
        ledger: this.deps.ledger.snapshot(),
        nextAction,
        hostInvoked: false,
        workOrders: orders,
        aLayerHealthy: false,
        summary: null,
        trigger: t4 ? { trigger: 'T4', reason: this.t4Reason(roles, hasUnresolved) } : null,
        hardFailureSignature: signature,
      });
      await this.record(result);
      return result;
    }

    // ── 3. A 层健康：现在才轮到主理人 ────────────────────────────
    //
    // 主理人只在「锚点集合里含 B3（对抗审查）」的阶段被唤醒 —— 目前就是 REVIEW。
    // 在 BUILDING 等阶段叫它来审查没有意义：那时还没有完整的可审对象，
    // 只会产生基于半成品的猜测，而猜测正是幻觉的温床。
    const hostStage = anchorIds.includes('B3');
    const hostReview = hostStage ? (input.hostReview ?? null) : null;
    const hostInvoked = hostReview !== null;

    const objections: Objection[] = hostReview ? hostReview.objections : [];

    // 异议必须先广播、再裁决：前端要能实时看到「主理人刚提了什么」，
    // 而不是等裁决完才一次性看到结果。
    for (const o of objections) this.deps.bus?.emit({ t: 'objection.raised', objection: o });

    const summary = await this.deps.judge.arbitrateAll(objections, aAnchors);

    for (const a of summary.results) this.deps.bus?.emit({ t: 'objection.arbitrated', arbitration: a });

    // 语义锚（B1/B2）的硬失败也要路由 —— 它们同样是机械归因的
    //
    // 注意这里额外并入「交付阻断性缺口」：REVIEW 阶段若 B1 完全没有得到语义提议
    // （SKIPPED），说明「目标是否达成」根本没被验证过。SKIPPED 本身不是 FAIL，
    // 但**允许它在交付前静默通过，等于把「未验证」当成了「通过」**——
    // 那正是全局不变量第 4 条要禁止的事。这是一个真实存在过的静默通过漏洞。
    const semanticHard = [
      ...anchors.filter((a) => a.anchorId === 'B1' || a.anchorId === 'B2').filter(isHardFailure),
      ...blockingGaps(stage, anchors, this.deps.store),
    ];
    const semanticOrders = this.buildWorkOrders(semanticHard, stage);

    const valid = summary.results.filter((r) => r.verdict === 'VALID');
    const validObjections = valid
      .map((r) => objections.find((o) => o.id === r.objectionId))
      .filter((o): o is Objection => Boolean(o));

    // ── 4. 决定 nextAction ──────────────────────────────────────
    const trigger = determineTrigger({
      stage,
      stageBlockAttempts: this.deps.ledger.stageBlockAttempts,
      stageBlockingRevoked: this.deps.ledger.stageBlockingRevoked,
      unattributedObjections: objections.filter((o) => o.targetRole === 'UNRESOLVED' && o.severity === 'blocker')
        .length,
      anchors,
      roundtablesHeld: input.roundtablesHeld ?? 0,
    });

    let blocked = false;
    let reason: BlockReason | undefined;
    let nextAction: GateResult['nextAction'];
    let orders: WorkOrder[] = [];
    let escalation: EscalationBundle | undefined;

    if (validObjections.length > 0) {
      // 有效异议：阻断生效，按归因派工单
      const targets = validObjections
        .map((o) => o.targetRole)
        .filter((r): r is RoleId => r !== 'UNRESOLVED');
      const target = this.pickPrimaryRole(targets);
      orders = validObjections.map((o) => this.orderFromObjection(o, stage, target));
      blocked = true;
      reason = 'VALID_OBJECTION';
      nextAction = { kind: 'RETRY_ROLE', target, orders: orders.map((o) => o.id) };
    } else if (semanticOrders.length > 0) {
      // B2 抓出的需求覆盖缺失 / B1 判定未达成：同样是机械可归因的硬失败
      orders = semanticOrders;
      blocked = true;
      reason = 'ANCHOR_HARD_FAIL';
      nextAction = {
        kind: 'RETRY_ROLE',
        target: this.pickPrimaryRole(semanticOrders.map((o) => o.to)),
        orders: orders.map((o) => o.id),
      };
    } else if (trigger) {
      blocked = true;
      reason = 'ROUNDTABLE_PENDING';
      nextAction = { kind: 'ROUNDTABLE', trigger: trigger.trigger };
    } else {
      nextAction = { kind: 'ADVANCE', to: nextStageOf(stage) };
    }

    // ── 5. 需要人类回答的异议：打包升级 ──────────────────────────
    if (summary.requiresHuman > 0 && trigger) {
      escalation = this.buildEscalation({
        stage,
        reason: 'human-question-required',
        objections,
        summary,
        anchors,
        agenda: buildAgenda({ trigger: trigger.trigger, objections, anchors }),
      });
    }

    const result = this.mkResult({
      stage,
      sequence,
      anchors,
      hardFailures: [],
      objections,
      arbitration: summary.results,
      blocked,
      ...(reason ? { reason } : {}),
      ledger: this.deps.ledger.snapshot(),
      nextAction,
      hostInvoked,
      workOrders: orders,
      aLayerHealthy: true,
      summary,
      trigger,
      hardFailureSignature: null,
      ...(escalation ? { escalation } : {}),
    });
    await this.record(result);
    return result;
  }

  // ── 内部 ──────────────────────────────────────────────────────

  /** 硬失败签名：用于识别「同一批问题反复出现」。 */
  private signatureOf(failures: AnchorRunResult[]): string {
    const parts: string[] = [];
    for (const f of failures) {
      for (const finding of f.findings.filter((x) => x.severity === 'fail')) {
        parts.push(`${f.anchorId}:${finding.code}:${finding.file ?? '-'}:${finding.line ?? '-'}`);
      }
    }
    return parts.sort().join('|');
  }

  private t4Reason(roles: string[], hasUnresolved: boolean): string {
    if (hasUnresolved && roles.length === 0) return '执行类锚点失败但机械归因完全失灵（无任何文件可归属）';
    if (hasUnresolved) return `执行类锚点失败，归因分散到 ${roles.join('/')}，且存在无法归属的问题`;
    return `执行类锚点失败，归因分散到 ${roles.length} 个角色（${roles.join('/')}），疑似互相甩锅`;
  }

  private pickPrimaryRole(roles: RoleId[]): RoleId {
    for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r;
    return roles[0] ?? 'backend';
  }

  /**
   * 从锚点失败生成派工单。
   * 每个 finding 都自带文件归属，因此这是纯机械操作 —— 这正是「不需要 LLM 归因」的落点。
   */
  private buildWorkOrders(failures: AnchorRunResult[], stage: StageId): WorkOrder[] {
    const byRole = new Map<RoleId, { findings: typeof failures; anchorId: AnchorId; runId: string }>();

    for (const f of failures) {
      for (const finding of f.findings.filter((x) => x.severity === 'fail')) {
        const role = (finding.targetRole ?? 'UNRESOLVED') as RoleId;
        const key: RoleId = role === ('UNRESOLVED' as RoleId) ? 'backend' : role;
        const cur = byRole.get(key);
        if (cur) cur.findings.push(f);
        else byRole.set(key, { findings: [f], anchorId: f.anchorId, runId: f.runId });
      }
    }

    const orders: WorkOrder[] = [];
    for (const [role, group] of byRole) {
      const findings = group.findings.flatMap((f) => f.findings.filter((x) => x.severity === 'fail'));
      const acceptance = [...new Set(findings.map((f) => acceptanceFor(f, group.anchorId)))];
      this.orderSeq++;
      const order: WorkOrder = {
        id: `WO-${String(this.orderSeq).padStart(3, '0')}`,
        stage,
        to: role,
        reason: { kind: 'anchor-fail', anchorId: group.anchorId, runId: group.runId, detail: findings },
        target: targetFor(role),
        acceptance,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      const contractHash = this.deps.store.frozenContractHash();
      if (contractHash) order.contractHash = contractHash;
      orders.push(order);
      this.deps.bus?.emit({ t: 'workorder.created', order });
    }
    return orders;
  }

  private orderFromObjection(o: Objection, stage: StageId, fallback: RoleId): WorkOrder {
    const to = o.targetRole === 'UNRESOLVED' ? fallback : o.targetRole;
    this.orderSeq++;
    const order: WorkOrder = {
      id: `WO-${String(this.orderSeq).padStart(3, '0')}`,
      stage,
      to,
      reason: { kind: 'valid-objection', objectionId: o.id },
      target: targetFor(to),
      // 验收条件必须可被锚点或测试机械验证，否则工单不合法
      acceptance: [
        `${o.claim}（该异议已由机械裁判判为有效，falsifier 已复现问题）`,
        o.proposedFix
          ? `按建议修复：${o.proposedFix}`
          : `修复后必须使对应锚点重新 PASS，且原 falsifier 不再复现问题`,
      ],
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    const contractHash = this.deps.store.frozenContractHash();
    if (contractHash) order.contractHash = contractHash;
    this.deps.bus?.emit({ t: 'workorder.created', order });
    return order;
  }

  private buildEscalation(args: {
    stage: StageId;
    reason: EscalationBundle['reason'];
    objections: Objection[];
    summary: ArbitrationSummary;
    anchors: AnchorRunResult[];
    agenda: string[];
  }): EscalationBundle {
    this.bundleSeq++;
    const bundle = buildBundle(args, this.bundleSeq);
    this.deps.bus?.emit({ t: 'escalation.human', bundleId: bundle.id });
    return bundle;
  }

  /**
   * 构造 Gate 结果。
   *
   * `at` 由这里统一盖章，而不是让三个调用点各写一遍 ——
   * 那三个调用点**一个都没写**（`GateResult.at` 是必填字段），
   * 所以事件流里的每次 `gate.evaluated` 都带着 `at: undefined`。
   * 这类「类型上要求、运行时从未被赋值的字段」是零依赖 + 类型剥离环境下最难发现的一种缺陷：
   * 编译器是唯一能看见它的地方，而这个项目的编译器此前恰好是坏的。
   */
  private mkResult(r: Omit<GateOutput, 'at'> & { at?: string }): GateOutput {
    return { at: new Date().toISOString(), ...r } as GateOutput;
  }

  private async record(result: GateOutput): Promise<void> {
    this.deps.bus?.emit({ t: 'gate.evaluated', result });
    this.deps.bus?.emit({ t: 'ledger.updated', ledger: result.ledger });
    await this.deps.log?.append('gate.evaluated', {
      stage: result.stage,
      sequence: result.sequence,
      blocked: result.blocked,
      reason: result.reason,
      hostInvoked: result.hostInvoked,
      nextAction: result.nextAction,
      anchors: result.anchors.map((a) => ({ id: a.anchorId, verdict: a.verdict })),
      ledger: result.ledger,
    });
  }
}

// ════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════

/**
 * Gate 层的不变式缺口：那些「不是某个锚点的 FAIL，但绝不能允许静默通过」的情况。
 *
 * 存在理由（真实缺陷）：`SKIPPED ≠ PASS` 是全局不变量，但锚点的 SKIPPED
 * 在 Gate 这一步原本只会导致 `nextAction = ADVANCE` —— 也就是**未验证被当成了通过**。
 * 曾经出现过「INTAKE 产出失败 → 根本没有需求工件 → 一路 ADVANCE 到 DELIVERED」
 * 这种荒唐结果。这里把这类缺口提升为硬失败。
 *
 * 归因给具体角色，确保它们走的是「派工单修复」的正常路径，而不是直接升级。
 */
export function blockingGaps(
  stage: StageId,
  anchors: AnchorRunResult[],
  store: ArtifactStore,
): AnchorRunResult[] {
  const gaps: AnchorRunResult[] = [];
  const at = new Date().toISOString();

  const synth = (code: string, message: string, targetRole: RoleId): AnchorRunResult => ({
    // 语义上属于 B2（需求完整性/覆盖）那一类，因此复用其 ID；
    // method 明确标为 Gate 不变式检查，便于人类区分它并非锚点本身的结论。
    anchorId: 'B2',
    runId: `gate-invariant-${code}`,
    subjects: [],
    contentHashes: {},
    verdict: 'FAIL',
    findings: [{ code, severity: 'fail', message, targetRole }],
    method: 'gate-invariant-check',
    authority: 'authoritative',
    at,
    durationMs: 0,
  });

  // 缺口 1：过了 INTAKE 之后必须存在需求工件。
  // 否则后续所有阶段的「覆盖矩阵」「达成判定」都无的放矢。
  if (stage !== 'INTAKE' && !store.head('Requirement')) {
    gaps.push(
      synth(
        'missing-requirements',
        '进入后续阶段却不存在任何需求工件 —— 没有需求就无法判断做对没有。未验证 ≠ 通过',
        'pm',
      ),
    );
  }

  // 缺口 2：REVIEW 阶段必须真的做过「目标达成」判定（B1 不能是 SKIPPED）
  if (stage === 'REVIEW') {
    const b1 = anchors.find((a) => a.anchorId === 'B1');
    if (b1 && b1.verdict === 'SKIPPED') {
      gaps.push({
        ...b1,
        verdict: 'FAIL',
        findings: [
          {
            code: 'semantic-verification-missing',
            severity: 'fail',
            message:
              'REVIEW 阶段没有得到任何需求达成判定（B1 为 SKIPPED）—— 无法据此声称交付完成。未验证 ≠ 通过',
            targetRole: 'test',
            data: { anchorId: 'B1', originalVerdict: b1.verdict },
          },
        ],
      });
    }
  }

  return gaps;
}

/**
 * 派工单的目标工件。
 *
 * 必须带上 scope：修复工单会据此路由到 `repair:CodeModule:api` 这样的 purpose。
 * 第一版漏了 scope，导致后端工单被派成 `repair:CodeModule`（无 scope），
 * 修复请求根本落不到正确的工件上。
 */
export function targetFor(role: RoleId): WorkOrder['target'] {
  switch (role) {
    case 'frontend':
      return { newKind: 'CodeModule', scope: 'web' };
    case 'backend':
      return { newKind: 'CodeModule', scope: 'api' };
    case 'test':
      return { newKind: 'TestSuite' };
    case 'pm':
      return { newKind: 'Requirement' };
    default:
      return { newKind: 'CodeModule' };
  }
}

/** 把机械发现的失败翻译成可被锚点或测试验收的工单条件。 */
export function acceptanceFor(finding: { code: string; file?: string; line?: number; data?: unknown }, anchorId: AnchorId): string {
  const loc = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '项目';
  const d = (finding.data ?? {}) as Record<string, unknown>;
  switch (finding.code) {
    case 'unknown-export':
      return `修正 ${loc} 中对 "${String(d.specifier)}" 的符号导入（符号 ${String(d.symbol)} 不存在），使 A2 锚点 PASS`;
    case 'uncertain-export':
      return `确认 ${loc} 中 "${String(d.symbol)}" 的真实来源，使 A2 锚点的该条 WARN 消除`;
    case 'unresolved-import':
      return `使 ${loc} 的导入 "${String(d.specifier)}" 能解析到真实文件，使 A3 锚点 PASS`;
    case 'invalid-package-name':
    case 'missing-pkg':
    case 'disallowed-dependency':
      return `修正 package.json 中对 "${String(d.name)}" 的依赖声明，使 A1 锚点 PASS`;
    case 'forbidden-dependency':
      return `移除被真人建议书禁止的依赖/导入 "${String(d.name)}"，使 A1 锚点 PASS（这是用户约束，不可协商）`;
    case 'compile-error':
      return `消除 ${loc} 的类型/编译错误，使 A4 锚点 PASS`;
    case 'tests-failed':
    case 'no-tests-ran':
      return `使测试真实执行且全部通过（A5 锚点报告 pass>0 且 fail=0），使 A5 锚点 PASS`;
    case 'runtime-probe-failed':
      return `使服务能启动并响应 ${String(d.healthUrl)}，使 A6 锚点 PASS`;
    case 'unimplemented-endpoint':
      return `实现契约端点 ${String(d.path)}，使 A7 锚点 PASS`;
    case 'contract-not-frozen':
    case 'missing-generated-types':
      return `使契约冻结且生成类型文件存在于 ${String(d.path ?? '契约声明的路径')}，使 A7 锚点 PASS`;
    case 'requirement-untasked':
    case 'requirement-not-in-prd':
      return `为需求 ${String(d.requirementId)} 补齐任务拆解与 PRD 覆盖，使 B2 锚点 PASS`;
    case 'requirement-untested':
      return `为需求 ${String(d.requirementId)} 补充测试用例（在 TestSuite 的 covers 中声明），使 B2 锚点 PASS`;
    case 'deliverable-missing':
      return `交付任务 ${String(d.taskId)} 声明的 ${String(d.deliverable)} 工件，使 B2 锚点 PASS`;
    case 'requirement-not-met':
    case 'requirement-unverified':
    case 'evidence-invalid':
    case 'evidence-missing':
      return `补全需求 ${String(d.requirementId)} 的实现并提供可核验的证据（真实文件+行区间），使 B1 锚点 PASS`;
    case 'semantic-verification-missing':
      return '为**每一条**需求给出达成判定，并附可核验的证据（真实存在的文件与真实行号区间），使 B1 锚点 PASS';
    case 'missing-requirements':
      return '产出可验收的需求清单（每条含 acceptance），使 B2 锚点 PASS';
    case 'contract-duplication':
      return `移除 ${loc} 中手写的模型 "${String(d.model)}"，改为引用契约生成的类型，使 A7 锚点 PASS`;
    /**
     * A8：产出不得修改验证基准。
     *
     * 验收条件刻意写成「不要再交这个文件」，而不是「把它改回来」——
     * 文件本身已经被编排器保留了项目原值（盘上是好的），
     * 要修的是**产出的行为**：把项目契约文件从这次产出里删掉。
     */
    case 'contract-key-removed':
    case 'contract-key-changed':
      return (
        `不要把 ${loc} 里项目声明的键 "${String(d.key ?? '')}" 删掉或改写 —— ` +
        `该文件已存在，它是验证基准的一部分，产出只应写 ${String(d.artifactKind ?? 'CodeModule')} ` +
        `自己负责的源码文件（不要附带 package.json / tsconfig.json）`
      );
    case 'contract-file-overwritten':
      return `从产出里去掉 ${loc}：它是受保护的验证配置文件（验证基准），产出不得改写它`;
    case 'contract-file-invalid':
      return `不要写 ${loc}（内容不是合法 JSON 对象，无法作为契约基准），只写自己负责的源码文件`;
    case 'path-escapes-project':
      return `把产出路径 ${loc} 改成项目工作区内的相对路径（不得越出项目根）`;
    case 'undeclared-endpoint':
      return `修正 ${loc} 中对未声明端点 ${String(d.called)} 的调用，或走契约变更流程，使 A7 锚点 PASS`;
    default:
      return `修复 ${loc} 的 ${finding.code} 问题，使 ${anchorId} 锚点 PASS`;
  }
}

function buildBundle(
  args: {
    stage: StageId;
    reason: EscalationBundle['reason'];
    objections: Objection[];
    summary: ArbitrationSummary;
    anchors: AnchorRunResult[];
    agenda: string[];
  },
  seq: number,
): EscalationBundle {
  const id = newBundleId(args.stage, seq);
  const refuted = args.summary.refuted;
  const unfalsifiable = args.summary.unfalsifiable;
  return {
    id,
    stage: args.stage,
    reason: args.reason,
    summary:
      `阶段 ${args.stage} 出现无法机械裁决的争议：` +
      `有效异议 ${args.summary.valid} 条、误报 ${refuted} 条、不可证伪 ${unfalsifiable} 条。` +
      (args.summary.requiresHuman > 0 ? `其中 ${args.summary.requiresHuman} 条只有人才能回答。` : ''),
    agenda: args.agenda,
    objections: args.objections,
    arbitration: args.summary.results,
    anchors: args.anchors.map((a) => ({
      anchorId: a.anchorId,
      verdict: a.verdict,
      failCount: a.findings.filter((f) => f.severity === 'fail').length,
      attribution: [
        ...new Set(a.findings.filter((f) => f.severity === 'fail').map((f) => f.targetRole ?? 'UNRESOLVED')),
      ],
    })),
    availableActions: [
      { kind: 'resume', description: '解除当前阻断，强制推进（打破死锁的终极手段）' },
      { kind: 'override', description: '推翻某个角色的决定，并说明你认为正确的做法' },
      { kind: 'constraint', description: '追加硬约束（例如禁止引入某个库），Gate 会校验产物是否违反' },
      { kind: 'requirement', description: '修改或追加需求，系统会生成新的需求条目' },
      { kind: 'hold', description: '暂停整个流水线，等待你进一步介入' },
      { kind: 'let-it-pass', description: '明知有争议仍选择继续 —— 系统会记为技术债，而不是「已通过」' },
    ],
    createdAt: new Date().toISOString(),
  };
}

/** 阶段推进顺序。BUILDING ⇄ REVIEW 是主循环，由编排器控制往复。 */
export const STAGE_ORDER: StageId[] = [
  'INTAKE',
  'PLANNING',
  'CONTRACTING',
  'BUILDING',
  'REVIEW',
  'DELIVERED',
];

export function nextStageOf(stage: StageId): StageId {
  const i = STAGE_ORDER.indexOf(stage);
  if (i === -1 || i === STAGE_ORDER.length - 1) return 'DELIVERED';
  return STAGE_ORDER[i + 1];
}
