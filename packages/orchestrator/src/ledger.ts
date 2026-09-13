/**
 * 主理人问责账本（docs/03-host-accountability.md §4）。
 *
 * 这是整套系统里最反直觉、也最关键的一块：光给对抗性提示词不够，
 * 必须**同时**给一个可观测、可优化、越诚实越高的评分，并让误报比真报更贵。
 *
 * 规则（编号与文档一致，裁决理由里会引用这些编号供人类复查）：
 *   R1 每阶段初始阻断额度 BLOCK_QUOTA = 3，VALID 扣 1
 *   R2 REFUTED（误报）扣 2 —— 误报代价 = 真报的两倍（反奖励黑客的核心）
 *   R3 单阶段阻断尝试 ≥ 3 → 强制圆桌 + 本阶段阻断权终止
 *   R4 累计误报 ≥ 2 → 观察期（只能提建议，不能阻断）
 *   R5 观察期解除：连续 2 个阶段 A 层锚点全绿、无新误报
 *   R6 复读惩罚（在 judge 中实现，账本记录结果）
 *   R7 全局预算：连续每阶段都用满额度 → 全局观察期
 *   R8 severity != blocker 不阻断
 *   R9 targetRole = UNRESOLVED 不阻断，触发圆桌
 *   R10 输出 NO_OBJECTION 且 A 层全绿 → 不惩罚（给「同意」一个不亏的出口）
 */

import type {
  Arbitration,
  HostLedgerSnapshot,
  HostPolicy,
  StageId,
} from '../../core/src/types.ts';
import { DEFAULT_HOST_POLICY } from '../../core/src/types.ts';

export type LedgerEffect = {
  quotaDelta: number;
  /** 本次裁决是否让主理人进入观察期。 */
  enteredProbation: boolean;
  /** 本次裁决是否让主理人解除观察期。 */
  clearedProbation: boolean;
  /** 达到阻断尝试上限，应当触发圆桌。 */
  shouldConveneRoundtable: boolean;
  reason: string;
};

type LedgerState = {
  stage: StageId;
  quota: number;
  stageBlockAttempts: number;
  stageTruePositives: number;
  stageFalsePositives: number;
  stageUnfalsifiable: number;
  totalTruePositives: number;
  totalFalsePositives: number;
  totalUnfalsifiable: number;
  globalBlockAttempts: number;
  /** 已进入过的阶段数（含当前）。 */
  stagesEntered: number;
  /** 已结束且 A 层全绿的连续阶段数（R5 用）。 */
  probationCleanStages: number;
  probation: boolean;
  stageBlockingRevoked: boolean;
};

export class HostLedger {
  readonly policy: HostPolicy;
  private s: LedgerState;

  constructor(policy: HostPolicy = DEFAULT_HOST_POLICY, firstStage: StageId = 'INTAKE') {
    this.policy = policy;
    this.s = {
      stage: firstStage,
      quota: policy.blockQuota,
      stageBlockAttempts: 0,
      stageTruePositives: 0,
      stageFalsePositives: 0,
      stageUnfalsifiable: 0,
      totalTruePositives: 0,
      totalFalsePositives: 0,
      totalUnfalsifiable: 0,
      globalBlockAttempts: 0,
      stagesEntered: 1,
      probationCleanStages: 0,
      probation: false,
      stageBlockingRevoked: false,
    };
  }

  /**
   * 进入新阶段：重置阶段内配额，并检查 R7 全局预算。
   *
   * R7 的语义是「**连续**每阶段都用满额度」才进入全局观察期，因此需要两个条件：
   *   1. 已完成的阶段数 ≥ 2（一个阶段说明不了「连续」）
   *   2. 累计阻断尝试 ≥ 每阶段上限 × 已完成阶段数（即平均每阶段都卡满）
   *
   * 这里踩过两个坑，记录以免回退：
   *   - 用 `stagesEntered` 当乘数：预算随阶段数同步增长，`attempts >= budget` 永远不成立，R7 等于一条空规则。
   *   - 用 `(stagesEntered - 1)` 但不加「至少 2 个阶段」的前置条件：进入第 2 个阶段时
   *     就会因为第 1 个阶段卡满而立刻触发，把规则变成了「一个阶段卡满就全局观察期」，过于激进。
   */
  beginStage(stage: StageId): { globalProbation: boolean } {
    this.s.stage = stage;
    this.s.quota = this.policy.blockQuota;
    this.s.stageBlockAttempts = 0;
    this.s.stageTruePositives = 0;
    this.s.stageFalsePositives = 0;
    this.s.stageUnfalsifiable = 0;
    this.s.stageBlockingRevoked = false;
    this.s.stagesEntered++;

    const completedStages = this.s.stagesEntered - 1;
    const budget = this.policy.globalBudgetPerStage * completedStages;
    let globalProbation = false;
    if (completedStages >= 2 && this.s.globalBlockAttempts >= budget) {
      globalProbation = true;
      this.s.probation = true;
    }
    return { globalProbation };
  }

  /**
   * 记录一个阶段的结局。A 层健康且本阶段无新误报 → 观察期解除进度 +1（R5）。
   *
   * `aLayerHealthy` 的准确语义是「A 层**无硬失败**」（没有 FAIL / INVALID_EVIDENCE），
   * 而不是字面意义上的「全部 PASS」。理由：SKIPPED 意味着该项目未配置对应工具链
   * （例如没有 typecheck 命令），那是**我们的限制**，不是主理人的过错，
   * 不应该让它永远无法恢复话语权。WARN 同理（如 typo-squatting 待人工确认）。
   */
  endStage(opts: { aLayerHealthy: boolean }): { clearedProbation: boolean } {
    let cleared = false;
    if (opts.aLayerHealthy && this.s.stageFalsePositives === 0) {
      this.s.probationCleanStages++;
      if (this.s.probation && this.s.probationCleanStages >= this.policy.probationClearStages) {
        this.s.probation = false;
        this.s.probationCleanStages = 0;
        cleared = true;
      }
    } else {
      this.s.probationCleanStages = 0;
    }
    return { clearedProbation: cleared };
  }

  /** 主理人此刻是否可以阻断。不可阻断时必须给出原因（会展示给人类与主理人自己）。 */
  canBlock(): { allowed: boolean; reason?: string } {
    // 多个限制可能同时生效（例如既在观察期、本阶段阻断权又被终止）。
    // 全部列出而不是只报第一个 —— 只报一个会让人类与主理人都看不清真实处境。
    const reasons: string[] = [];

    if (this.s.probation) {
      reasons.push(
        `R4/R7：处于观察期（累计误报 ${this.s.totalFalsePositives} 次），只能提建议不能阻断。连续 ${this.policy.probationClearStages} 个阶段 A 层全绿可自动解除`,
      );
    }
    if (this.s.stageBlockingRevoked || this.s.stageBlockAttempts >= this.policy.stageBlockLimit) {
      reasons.push(
        `R3：本阶段（${this.s.stage}）阻断权已终止，阻断尝试 ${this.s.stageBlockAttempts}/${this.policy.stageBlockLimit}。争议应上圆桌会议`,
      );
    }

    if (reasons.length > 0) return { allowed: false, reason: reasons.join('；') };
    return { allowed: true };
  }

  /**
   * 记入一条裁决结果。这是账本的唯一写入口。
   *
   * `countsAsAttempt` 由裁判显式给出，而不是简单看 severity：
   * R8（非 blocker）与 R9（未归因）以及「阻断权已被剥夺后的异议」
   * 属于**连阻断资格都没有**的情形，不该消耗额度。
   * 否则主理人可以通过大量「必然不合格」的异议来试探边界。
   * 但真正的 blocker 尝试（含被驳回的）一律计入 —— 那才是要计成本的。
   */
  record(
    arb: Arbitration,
    severity: 'blocker' | 'major' | 'minor',
    countsAsAttempt?: boolean,
  ): LedgerEffect {
    let quotaDelta = 0;
    let shouldConvene = false;
    let entered = false;
    let reason = '';

    const isAttempt = countsAsAttempt ?? severity === 'blocker';
    if (isAttempt) {
      this.s.stageBlockAttempts++;
      this.s.globalBlockAttempts++;
    }

    switch (arb.verdict) {
      case 'VALID':
        // R1：真报扣 1
        quotaDelta = -1;
        this.s.quota += quotaDelta;
        this.s.stageTruePositives++;
        this.s.totalTruePositives++;
        reason = `R1：有效异议，扣 1 额度`;
        break;

      case 'REFUTED':
        // R2：误报扣 2（允许透支为负）
        quotaDelta = -this.policy.refutedPenalty;
        this.s.quota += quotaDelta;
        this.s.stageFalsePositives++;
        this.s.totalFalsePositives++;
        reason = `R2：误报，扣 ${this.policy.refutedPenalty} 额度（误报代价为真报的两倍）`;
        // R4：累计误报达到阈值 → 观察期
        if (!this.s.probation && this.s.totalFalsePositives >= this.policy.probationFpThreshold) {
          this.s.probation = true;
          this.s.probationCleanStages = 0;
          entered = true;
          reason += `；R4：累计误报达 ${this.s.totalFalsePositives} 次，进入观察期`;
        }
        break;

      case 'UNFALSIFIABLE':
        this.s.stageUnfalsifiable++;
        this.s.totalUnfalsifiable++;
        reason = '不可证伪：不阻断、不计误报（只是不合格，不是撒谎）';
        break;
    }

    // R3：阻断尝试达到上限 → 本阶段阻断权终止 + 触发圆桌
    if (isAttempt && this.s.stageBlockAttempts >= this.policy.stageBlockLimit) {
      this.s.stageBlockingRevoked = true;
      shouldConvene = true;
      reason += `；R3：本阶段阻断尝试 ${this.s.stageBlockAttempts} 次达上限，阻断权终止并触发圆桌会议`;
    }

    return { quotaDelta, enteredProbation: entered, clearedProbation: false, shouldConveneRoundtable: shouldConvene, reason };
  }

  /** R10：显式记录「本轮无异议」——这是正确行为，不惩罚。 */
  recordNoObjection(): void {
    this.s.stageUnfalsifiable += 0;
  }

  /** 人类建议书 resume 的效果：强制恢复阻断权。 */
  humanResume(): void {
    this.s.stageBlockingRevoked = false;
    this.s.stageBlockAttempts = 0;
    this.s.probation = false;
    this.s.probationCleanStages = 0;
  }

  /** 人类建议书 override 的效果：直接豁免本阶段阻断。 */
  humanForceAdvance(): void {
    this.s.stageBlockingRevoked = true;
  }

  get probation(): boolean {
    return this.s.probation;
  }

  get stage(): StageId {
    return this.s.stage;
  }

  get stageBlockingRevoked(): boolean {
    return this.s.stageBlockingRevoked;
  }

  get stageBlockAttempts(): number {
    return this.s.stageBlockAttempts;
  }

  get globalBlockAttempts(): number {
    return this.s.globalBlockAttempts;
  }

  precision(): number {
    const tp = this.s.totalTruePositives;
    const fp = this.s.totalFalsePositives;
    if (tp + fp === 0) return 1; // 尚未提出任何异议，不给惩罚
    return tp / (tp + fp);
  }

  snapshot(): HostLedgerSnapshot {
    return {
      stage: this.s.stage,
      quota: this.s.quota,
      blockAttempts: this.s.stageBlockAttempts,
      truePositives: this.s.totalTruePositives,
      falsePositives: this.s.totalFalsePositives,
      unfalsifiable: this.s.totalUnfalsifiable,
      probation: this.s.probation,
      probationClearStages: this.s.probationCleanStages,
      globalBlockAttempts: this.s.globalBlockAttempts,
      precision: this.precision(),
      stageBlockingRevoked: this.s.stageBlockingRevoked,
    };
  }

  /** 供测试与 UI 读取完整内部状态。 */
  detail() {
    return { ...this.s, precision: this.precision() };
  }
}
