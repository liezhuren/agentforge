/**
 * 三层死锁逃生（docs/03-host-accountability.md §5）。
 *
 * Safety（不让坏东西过去）由主理人负责，Liveness（不让项目停死）由这里负责。
 * 任何角色都无法让项目停死 —— 这是靠下面三层共同保证的：
 *
 *   第 1 层：圆桌会议（roundtable.ts）—— 有决议就按决议派工单
 *   第 2 层：真人裁决 —— 圆桌无决议时打包升级，人类可用建议书强制推进
 *   第 3 层：带债通过 —— 真人不可用时，**不撒谎地继续前进**
 *
 * 第 3 层的核心是引入第三态 `ACCEPTED_WITH_DEBT`。
 * 传统二态（通过/不通过）逼出两个坏结局：要么橡皮图章，要么死锁。
 * 第三态让系统可以在「不掩盖问题」的前提下继续推进：
 * 问题被记录、被标注、被交给人类，而不是被抹掉或被用来卡死流程。
 *
 * 这与 A5 锚点的 `SKIPPED ≠ PASS` 是同一条原则：**不许把未知当作已知。**
 */

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AnchorRunResult,
  Arbitration,
  Artifact,
  ArtifactId,
  DebtRecordDoc,
  DirectiveKind,
  Objection,
  StageId,
} from '../../core/src/types.ts';
import type { ArtifactStore } from '../../core/src/store.ts';
import type { DecisionLog } from '../../core/src/decisionlog.ts';

// ════════════════════════════════════════════════════════════════
// 升级包（推送给前端「待裁决」收件箱）
// ════════════════════════════════════════════════════════════════

export type EscalationBundle = {
  id: string;
  stage: StageId;
  reason:
    | 'roundtable-deadlock'
    | 'roundtable-resolution-invalid'
    | 'blocked-attempts-exhausted'
    | 'unattributable-dispute'
    | 'human-question-required';
  summary: string;
  /** 争议点（具体，不是泛泛的「有分歧」）。 */
  agenda: string[];
  objections: Objection[];
  arbitration: Arbitration[];
  anchors: Array<{ anchorId: string; verdict: string; failCount: number; attribution: string[] }>;
  roundtableMinuteId?: ArtifactId;
  /** 人类可以做的事 —— 必须是把「人类能怎么办」讲清楚，而不是只把问题丢给人。 */
  availableActions: Array<{ kind: DirectiveKind | 'let-it-pass'; description: string }>;
  createdAt: string;
};

export function buildEscalationBundle(args: {
  id: string;
  stage: StageId;
  reason: EscalationBundle['reason'];
  summary: string;
  agenda: string[];
  objections: Objection[];
  arbitration: Arbitration[];
  anchors: AnchorRunResult[];
  roundtableMinuteId?: ArtifactId;
}): EscalationBundle {
  return {
    id: args.id,
    stage: args.stage,
    reason: args.reason,
    summary: args.summary,
    agenda: args.agenda,
    objections: args.objections,
    arbitration: args.arbitration,
    anchors: args.anchors.map((a) => ({
      anchorId: a.anchorId,
      verdict: a.verdict,
      failCount: a.findings.filter((f) => f.severity === 'fail').length,
      attribution: [...new Set(a.findings.filter((f) => f.severity === 'fail').map((f) => f.targetRole ?? 'UNRESOLVED'))],
    })),
    ...(args.roundtableMinuteId ? { roundtableMinuteId: args.roundtableMinuteId } : {}),
    availableActions: [
      { kind: 'resume', description: '解除当前阻断，强制推进（打破死锁的终极手段）' },
      { kind: 'override', description: '推翻某个角色的决定，并说明你认为正确的做法' },
      { kind: 'constraint', description: '追加硬约束（例如禁止引入某个库），系统会在 Gate 中校验产物是否违反' },
      { kind: 'requirement', description: '修改或追加需求，系统会生成新的需求条目' },
      { kind: 'hold', description: '暂停整个流水线，等待你进一步介入' },
      { kind: 'let-it-pass', description: '明知有争议仍选择继续 —— 系统会把它记为技术债而非「已通过」' },
    ],
    createdAt: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════════
// 第 3 层：带债通过
// ════════════════════════════════════════════════════════════════

export const TECH_DEBT_FILE = 'TECH_DEBT.md';

export type DebtInput = {
  stage: StageId;
  summary: string;
  objections: Objection[];
  arbitration: Arbitration[];
  requirementIds: string[];
  reason: DebtRecordDoc['reason'];
};

export type DebtOutcome = {
  debt: Artifact;
  /** 被标记为 ACCEPTED_WITH_DEBT 的需求编号。 */
  markedRequirements: string[];
  filePath: string;
};

/**
 * 带债通过：记录债务、标记需求、写 TECH_DEBT.md，然后**允许项目继续推进**。
 *
 * 注意这里的措辞纪律：受影响需求被标为 `accepted_with_debt`，
 * **不是** `met`，也不是把异议删掉。交付物是「不完整但不隐讳」的。
 */
export async function passWithDebt(
  store: ArtifactStore,
  log: DecisionLog,
  input: DebtInput,
): Promise<DebtOutcome> {
  const at = new Date().toISOString();

  const debt = await store.put({
    kind: 'DebtRecord',
    producer: 'orchestrator',
    content: {
      stage: input.stage,
      summary: input.summary,
      unresolvedObjectionIds: input.objections.map((o) => o.id),
      affectedRequirementIds: input.requirementIds,
      reason: input.reason,
      at,
    } satisfies DebtRecordDoc,
  });

  // 标记受影响需求为「带债验收」——编排器唯一被允许的 Requirement 写入，且仅限 status 字段
  let marked: string[] = [];
  if (input.requirementIds.length > 0) {
    const updated = await store.markRequirementsDebt(input.requirementIds);
    if (updated) {
      const reqs = (updated.content as { requirements: Array<{ id: string; status: string }> }).requirements;
      marked = reqs.filter((r) => r.status === 'accepted_with_debt').map((r) => r.id);
    }
  }

  const filePath = join(store.root, TECH_DEBT_FILE);
  const existing = existsSync(filePath) ? await readFile(filePath, 'utf8') : header();
  const section = renderDebtSection({ debt, input, marked, at });
  await writeFile(filePath, existing.trimEnd() + '\n' + section, 'utf8');

  await log.append('debt.recorded', {
    debtId: debt.id,
    stage: input.stage,
    reason: input.reason,
    requirementIds: marked,
    objectionIds: input.objections.map((o) => o.id),
  });

  return { debt, markedRequirements: marked, filePath };
}

function header(): string {
  return [
    '# 未偿技术债',
    '',
    '> 本文件由 AgentForge 在「带债通过」时自动生成。',
    '> 这些条目**没有被解决**，只是被明确记录后继续推进 —— 它们不是「已通过」。',
    '> 受影响需求的验收状态是 `ACCEPTED_WITH_DEBT`，而不是 `met`。',
    '',
  ].join('\n');
}

function renderDebtSection(args: {
  debt: Artifact;
  input: DebtInput;
  marked: string[];
  at: string;
}): string {
  const { debt, input, marked, at } = args;
  const lines: string[] = [];
  lines.push(`## [${input.stage}] ${input.summary}`);
  lines.push('');
  lines.push(`- 债务编号：\`${debt.id}\``);
  lines.push(`- 记录时间：${at}`);
  lines.push(`- 未偿原因：\`${input.reason}\`（${
    input.reason === 'human-unavailable'
      ? '真人不可用/超时'
      : input.reason === 'roundtable-deadlock'
        ? '圆桌两轮未达成决议'
        : '用户主动选择放行'
  }）`);
  lines.push(
    `- 受影响需求（已标记 \`accepted_with_debt\`）：${marked.length > 0 ? marked.map((m) => `\`${m}\``).join('、') : '无'}`,
  );
  lines.push('');

  if (input.objections.length > 0) {
    lines.push('### 未解决的异议');
    lines.push('');
    for (const o of input.objections) {
      const arb = input.arbitration.find((a) => a.objectionId === o.id);
      lines.push(`- **${o.id}**（归因：${o.targetRole}，严重度：${o.severity}）`);
      lines.push(`  - 主张：${o.claim}`);
      lines.push(`  - 裁决：\`${arb?.verdict ?? '未裁决'}\`（${arb?.rule ?? '-'}）— ${arb?.reason ?? '-'}`);
      if (o.proposedFix) lines.push(`  - 建议修法：${o.proposedFix}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════
// 逃生决策（机械判定：该走哪一层）
// ════════════════════════════════════════════════════════════════

export type EscapeDecision =
  | { layer: 1; action: 'ROUNDTABLE'; reason: string }
  | { layer: 2; action: 'ESCALATE_HUMAN'; reason: string }
  | { layer: 3; action: 'PASS_WITH_DEBT'; reason: string };

/**
 * 决定走哪一层逃生。
 *
 * 判定是纯机械的（不含 LLM、不含人类判断），且**保证一定有出口** ——
 * 这是「主理人无法让项目停死」这条不变量的最终保证：
 * 无论前面发生什么，这个函数一定会返回一个可执行的动作。
 */
export function decideEscape(args: {
  /** 本阶段圆桌已经开过几次。 */
  roundtablesHeld: number;
  /** 最近一次圆桌是否产出了通过校验的决议。 */
  lastResolutionValid: boolean | null;
  /** 人类是否可用（在线 / 在超时窗口内响应过）。 */
  humanAvailable: boolean;
  /** 该阶段是否已经开过圆桌。 */
  roundtableAttempted: boolean;
}): EscapeDecision {
  if (!args.roundtableAttempted) {
    return { layer: 1, action: 'ROUNDTABLE', reason: '争议尚未经过圆桌协商，先走第 1 层' };
  }
  if (args.lastResolutionValid === true) {
    return { layer: 1, action: 'ROUNDTABLE', reason: '圆桌已产出有效决议，按其行动项推进' };
  }
  if (args.humanAvailable) {
    return {
      layer: 2,
      action: 'ESCALATE_HUMAN',
      reason: `圆桌 ${args.roundtablesHeld} 轮未产出有效决议，升级真人裁决`,
    };
  }
  return {
    layer: 3,
    action: 'PASS_WITH_DEBT',
    reason: `圆桌未产出决议且真人不可用 —— 带债通过，记录问题后继续推进（不掩盖、不卡死）`,
  };
}

export function newBundleId(stage: StageId, seq: number): string {
  return `ESC-${stage}-${String(seq).padStart(3, '0')}`;
}
