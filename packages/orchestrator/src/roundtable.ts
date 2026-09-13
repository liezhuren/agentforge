/**
 * 圆桌会议（docs/05-roundtable-and-directive.md §1）。
 *
 * 这是唯一允许自由文本通信的场合，但**产物必须结构化**。
 *
 * 机械主持（非 LLM）负责：
 *   1. 触发条件判定 T1–T5（不可被任何角色否决）
 *   2. 按固定议程推进（第 1 轮立场陈述 / 第 2 轮交叉质询）
 *   3. **丢弃无证据发言**（引用不存在的文件/工件的发言直接作废）
 *   4. **反「和稀泥」机械校验**：决议必须可执行，否则直接判无效并升级真人
 *
 * 第 4 条针对的是 LLM 圆桌最典型的失败：产出漂亮的、四平八稳的、
 * 什么都没解决的会议纪要。
 */

import type {
  AnchorId,
  AnchorRunResult,
  ArtifactId,
  CommandPolicy,
  ContractDoc,
  EvidenceRef,
  Falsifier,
  RoundtableFact,
  RoundtableMinuteDoc,
  RoundtableResolution,
  RoundtableStatement,
  RoundtableTrigger,
  RoleId,
  StageId,
} from '../../core/src/types.ts';
import { TRIGGER_DESCRIPTIONS } from '../../core/src/types.ts';
import { DEFAULT_COMMAND_POLICY, execCapture } from '../../core/src/exec.ts';
import type { AnchorContext } from '../../anchors/src/index.ts';
import { verifyEvidence } from '../../anchors/src/index.ts';
import type { Logger } from '../../core/src/logger.ts';
import { silentLogger } from '../../core/src/logger.ts';

// ════════════════════════════════════════════════════════════════
// 触发条件（机械判定）
// ════════════════════════════════════════════════════════════════

export type TriggerContext = {
  stage: StageId;
  /** 本阶段主理人阻断尝试次数。 */
  stageBlockAttempts: number;
  /** 账本给出的阻断权终止标志（R3）。 */
  stageBlockingRevoked: boolean;
  /** 主理人无法归因的异议数（T2）。 */
  unattributedObjections: number;
  /** 该阶段所有 A 层锚点结果。 */
  anchors: AnchorRunResult[];
  /** 上一轮圆桌已经开过几次（避免无限开会）。 */
  roundtablesHeld: number;
};

export type TriggerDecision =
  | { trigger: RoundtableTrigger; reason: string }
  | null;

/**
 * 判定是否召集圆桌。返回 null 表示不需要。
 *
 * 注意顺序：T2 排在 T1 之前判定。因为「无法归因」是更根本的信息 ——
 * 它说明连问题属于谁都不清楚，比「次数到了」更该开会。
 */
export function determineTrigger(ctx: TriggerContext): TriggerDecision {
  if (ctx.unattributedObjections > 0) {
    return {
      trigger: 'T2',
      reason: `${ctx.unattributedObjections} 条异议无法归因到具体角色`,
    };
  }
  if (ctx.stageBlockingRevoked || ctx.stageBlockAttempts >= 3) {
    return {
      trigger: 'T1',
      reason: `本阶段阻断尝试 ${ctx.stageBlockAttempts} 次，已达上限`,
    };
  }

  // T3：同一契约/实现存在互相矛盾的产出（同一逻辑工件的多个 head 冲突）
  const conflict = detectConflictingArtifacts(ctx.anchors);
  if (conflict) return { trigger: 'T3', reason: conflict };

  // T5：契约变更请求影响 ≥ 2 个角色且无人认领
  const cr = detectUnclaimedContractChange(ctx.anchors);
  if (cr) return { trigger: 'T5', reason: cr };

  return null;
}

/** T3：两个角色对同一 scope 的代码给出互相矛盾的产出（都以 head 形式存在且内容不同）。 */
function detectConflictingArtifacts(anchors: AnchorRunResult[]): string | null {
  const dup = anchors.find((a) => a.findings.some((f) => f.code === 'conflicting-artifacts'));
  if (dup) {
    const f = dup.findings.find((x) => x.code === 'conflicting-artifacts')!;
    return f.message;
  }
  return null;
}

/** T5：契约里存在 status='proposed' 且 impact 覆盖 ≥2 个角色的变更请求。 */
function detectUnclaimedContractChange(anchors: AnchorRunResult[]): string | null {
  const a7 = anchors.find((a) => a.anchorId === 'A7');
  if (!a7) return null;
  const f = a7.findings.find((x) => x.code === 'contract-change-unclaimed');
  return f ? f.message : null;
}

// ════════════════════════════════════════════════════════════════
// 与会者与议程
// ════════════════════════════════════════════════════════════════

/**
 * 由机械主持按归因自动邀请与会者。
 * 未受邀角色不得发言 —— 防止无关角色把战场扩大。
 */
export function inviteParticipants(
  trigger: RoundtableTrigger,
  ctx: {
    objectionTargets: Array<RoleId | 'UNRESOLVED'>;
    anchorFindings: Array<{ targetRole?: RoleId | 'UNRESOLVED' }>;
    contractImpact?: RoleId[];
  },
): RoleId[] {
  const invited = new Set<RoleId>(['host']); // 主理人必然与会

  const consider = (r?: RoleId | 'UNRESOLVED') => {
    if (r && r !== 'UNRESOLVED' && r !== 'host') invited.add(r);
  };

  switch (trigger) {
    case 'T1':
      ctx.objectionTargets.forEach(consider);
      break;
    case 'T2':
      // 归因不清：所有可能相关的角色都得到场，这正是圆桌的意义
      (['pm', 'frontend', 'backend', 'test'] as RoleId[]).forEach((r) => invited.add(r));
      break;
    case 'T3':
      (['frontend', 'backend'] as RoleId[]).forEach((r) => invited.add(r));
      break;
    case 'T4':
      ctx.anchorFindings.forEach((f) => consider(f.targetRole));
      break;
    case 'T5':
      (ctx.contractImpact ?? ['pm', 'frontend', 'backend']).forEach((r) => invited.add(r));
      break;
  }

  if (invited.size < 2) {
    // 圆桌至少要有两方，否则不构成协商
    (['pm', 'backend'] as RoleId[]).forEach((r) => invited.add(r));
  }
  return [...invited];
}

export function buildAgenda(args: {
  trigger: RoundtableTrigger;
  objections: Array<{ id: string; claim: string; targetRole: RoleId | 'UNRESOLVED' }>;
  anchors: AnchorRunResult[];
}): string[] {
  const agenda: string[] = [TRIGGER_DESCRIPTIONS[args.trigger]];

  for (const o of args.objections.slice(0, 8)) {
    agenda.push(`异议 ${o.id}（归因：${o.targetRole}）：${o.claim}`);
  }

  const hard = args.anchors.filter((a) => a.verdict === 'FAIL' || a.verdict === 'INVALID_EVIDENCE');
  for (const a of hard) {
    const fails = a.findings.filter((f) => f.severity === 'fail');
    agenda.push(
      `锚点 ${a.anchorId} 硬失败 ${fails.length} 项，机械归因：` +
        `${[...new Set(fails.map((f) => f.targetRole ?? 'UNRESOLVED'))].join(', ')}`,
    );
  }

  return agenda;
}

// ════════════════════════════════════════════════════════════════
// 反「和稀泥」机械校验
// ════════════════════════════════════════════════════════════════

/** 无行动指向的措辞 —— 这类决议等于什么都没解决。 */
const HEDGING_PHRASES = [
  '综合考虑',
  '综合考量',
  '都有道理',
  '各方都有道理',
  '折中',
  '各退一步',
  '共同改进',
  '协同优化',
  '加强沟通',
  '提升质量',
  '提高可维护性',
  '建议关注',
  '有待观察',
  '继续保持',
  '视情况而定',
  'balabalabala',
];

export type ResolutionCheck = { ok: true } | { ok: false; reason: string };

/**
 * 校验圆桌决议是否可执行。任一不满足即判无效 → 直接升级真人。
 *
 * 这是本文件最重要的一段代码：LLM 圆桌最擅长的就是产出
 * 「大家都说得有道理，我们综合考虑一下」这种漂亮但零信息量的纪要。
 * 必须由机械规则来拆穿它。
 *
 * `facts` 参数是第 2 轮当场执行 falsifier 的产物，它带来一条**新的否决规则**：
 * **决议不得把责任归给一个机械证据已经证明它没问题的角色。**
 * 没有这条规则的话，一场有确凿机械证据的会议仍然可能得出「各打五十大板」的结论。
 */
export function validateResolution(
  resolution: RoundtableResolution | null,
  opts: { verifyAcceptanceIsCheckable?: boolean; facts?: RoundtableFact[] } = {},
): ResolutionCheck {
  if (!resolution) return { ok: false, reason: '未产出任何决议（resolution 为 null）' };

  if (!resolution.decision || resolution.decision.trim().length < 5) {
    return { ok: false, reason: '决议内容为空或过于简略' };
  }

  if (!Array.isArray(resolution.actions) || resolution.actions.length === 0) {
    return { ok: false, reason: '决议没有行动项 —— 这是一次「什么都没解决」的会议' };
  }

  for (const [i, a] of resolution.actions.entries()) {
    if (!a.owner || !/^(pm|frontend|backend|test)$/.test(a.owner)) {
      return {
        ok: false,
        reason: `行动项 #${i + 1} 没有明确负责人（得到 ${JSON.stringify(a.owner)}）—— 「大家」不是负责人`,
      };
    }
    if (!a.action || a.action.trim().length < 3) {
      return { ok: false, reason: `行动项 #${i + 1} 的动作描述过于简略` };
    }
    if (!Array.isArray(a.acceptance) || a.acceptance.length === 0) {
      return { ok: false, reason: `行动项 #${i + 1} 没有验收条件，无法判断是否完成` };
    }
    if (opts.verifyAcceptanceIsCheckable ?? true) {
      for (const [j, acc] of a.acceptance.entries()) {
        if (!isMechanicallyCheckable(acc)) {
          return {
            ok: false,
            reason: `行动项 #${i + 1} 的验收条件 #${j + 1} 无法被机械验证（「${acc.slice(0, 40)}」）—— 验收条件必须能被锚点或测试检查`,
          };
        }
      }
    }
  }

  if (resolution.attribution === undefined || resolution.attribution === null) {
    return { ok: false, reason: '决议没有给出问题归因' };
  }

  // ── 与机械确证的事实一致性 ──────────────────────────────────
  //
  // 只约束「被 falsifier 确证」的那一类事实（outcome === 'sustained'）：
  //   反驳成立 → 反驳方是对的 → 问题在 `implicates`（被质询方）身上。
  // 若决议把责任归给别人（且不是 SHARED），那它与机械证据矛盾。
  //
  // 刻意**不**用 refuted 的事实去否决决议：那条反驳被证伪只说明
  // 「这个论点站不住」，不等于「被质询方一定没问题」——
  // 用否定性证据去限制归因会矫枉过正。
  const sustained = (opts.facts ?? []).filter((f) => f.outcome === 'sustained');
  if (sustained.length > 0) {
    const implicated = new Set<RoleId>(sustained.map((f) => f.implicates));
    const attribution = resolution.attribution;
    const detail = sustained
      .map((f) => `${f.role} 的反驳「${f.claim.slice(0, 40)}」已被机械证实（implicates=${f.implicates}）`)
      .join('；');

    // 归因为「需求/契约本身的缺陷」是一种**逃逸**：机械证据证明的是
    // 「实现与冻结契约不符」，它无法推出「契约是错的」。放任这条路，
    // 任何被 falsifier 逼到墙角的角色都可以改口说「是需求写得不好」。
    // 而且改需求是**真人保留的决定**（全局不变量：机器人不得静默改写需求），
    // 所以这里不是判它错，而是判它「无权自己决定」→ 升级真人。
    if (attribution === 'REQUIREMENT_DEFECT' || attribution === 'CONTRACT_DEFECT') {
      return {
        ok: false,
        reason:
          `决议把问题归因为「${attribution}」，但当场执行的 falsifier 已确证问题出在 ` +
          `${[...implicated].join('/')} 的产出上。转向需求/契约等于绕开机械证据，` +
          `且修改需求是真人保留的权限 —— 必须升级真人裁决，机器人无权自行改需求。${detail}`,
      };
    }

    // 到这一步 attribution 的类型已收窄为 RoleId | 'SHARED'（两个 DEFECT 分支已返回）
    const acceptable = attribution === 'SHARED' || implicated.has(attribution);
    if (!acceptable) {
      return {
        ok: false,
        reason:
          `决议归因指向「${attribution}」，但机械证据指向 ${[...implicated].join('/')} —— ` +
          `决议不得与当场执行的 falsifier 结果矛盾。${detail}`,
      };
    }
  }

  const normalized = `${resolution.decision} ${resolution.actions.map((a) => a.action).join(' ')}`;
  const hit = HEDGING_PHRASES.find((p) => normalized.includes(p));
  if (hit) {
    const hasConcreteAction = resolution.actions.some(
      (a) => a.action.length > 12 && !HEDGING_PHRASES.some((p) => a.action.includes(p)),
    );
    if (!hasConcreteAction) {
      return {
        ok: false,
        reason: `决议使用了无行动指向的措辞（「${hit}」）且没有任何具体动作 —— 和稀泥决议无效，升级真人裁决`,
      };
    }
  }

  return { ok: true };
}

/**
 * 验收条件是否可被机械检查。
 * 必须含有一个「可验证的抓手」：脚本命令、路径/端点、锚点编号、测试名、
 * 明确的数量或次数断言、或一个具体的字段名。
 *
 * ## 这是一条**启发式规则**，而且它的两个方向的错误率都没有被测量过
 *
 * 诚实说明（见 docs/07 §L7）：这里的模式表是逐步补出来的，凭据是「真实 LLM 产出的
 * 验收条件被误杀」这类具体案例。它**没有**经过靶场标定，
 * 所以既不能声称低误杀，也不能声称低放过。
 *
 * 两个方向的风险不对称，必须分清：
 *   - **误杀**（把可检查的判成不可检查）：决议被判无效 → 升级真人。
 *     代价是真人多一次介入，但**不会让坏东西通过**。
 *   - **放过**（把不可检查的判成可检查）：一条无法验证的验收条件进入工单，
 *     最后由「某个人说它完成了」来收尾 —— 这正是本项目要消灭的东西。
 *
 * 所以这里的取舍是**宁可误杀**。但误杀也要尽量少：
 * 下面这些模式确实修掉过真实的误杀案例。
 */
export function isMechanicallyCheckable(acceptance: string): boolean {
  const patterns = [
    /A[1-7]\s*锚点/, // 锚点编号
    // 只写编号也算抓手（真实 LLM 写的是「A6 原始输出日志」）。
    // 锚点编号是本项目的验证词汇表，指到它就是指到了一个可查的东西。
    /\b[AB][1-7]\b/,
    /B[1-3]\s*(锚点|验证)/,
    /\/[a-zA-Z0-9_\-/{}:.]{2,}/, // 路径或端点（必须有前导斜杠）
    /\b(npm|pnpm|node|npx|tsc|vitest|jest)\b/, // 命令名
    /\.(ts|tsx|js|jsx|json|md|css|html)\b/, // 文件名
    // 测试类断言。
    // 注意**不要**在中文两侧写 `\b` —— 见下方说明。
    /(测试|用例|test|spec)[^。；]{0,20}(通过|失败|成功|存在|覆盖|断言)/i,
    /(返回|响应|状态码|status)[^。；]{0,20}\d{3}/i,
    // 具体的判定动词
    /(不存在|等于|不等于|包含|不包含|不再|必须为|个数|数量|为空|非空|大于|小于)/,
    // 明确的次数 / 数量断言（真实 LLM 常这么写：「连续执行 3 次结果一致」）
    // 中文数字也要认 —— 模型写「连续两次」和写「连续 2 次」一样常见。
    /\d+\s*(次|个|条|项|种|遍)/,
    /[一二两三四五六七八九十]+\s*(次|个|条|项|种|遍)/,
    // 退出码断言
    /(退出码|exit\s*code|exitCode)[^。；]{0,12}\d/i,
    // 具体字段名 / 标识符（camelCase 或 snake_case）——
    // 「并记录 3 次 runId」里的 runId 就是一个可核验的抓手，
    // 第一版因为它不含斜杠而被误杀，导致一条本来可用的圆桌决议被判无效。
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/, // camelCase
    /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, // snake_case
  ];
  return patterns.some((p) => p.test(acceptance));
}

/**
 * 修 `\b` 的坑（写在代码旁边，因为这是最容易重复犯的一个错误）。
 *
 * `\b` 是 **ASCII 词边界**：它要求一侧是 `[A-Za-z0-9_]`、另一侧不是。
 * 中文字符在 JS 正则里属于「非词字符」，所以：
 *
 *   /\b不存在\b/.test('这个字段不存在')   // false —— 永远匹配不上
 *   /\b不存在\b/.test('a不存在')          // true  —— 前面是 ASCII 才成立
 *
 * 也就是说 `\b不存在\b` 这种写法**在纯中文句子里恒为 false**，
 * 是一条静默失效的规则：测试很容易写成「拿含 ASCII 的字符串去测」从而全部通过，
 * 而真实输入全是中文时它什么也不做。
 *
 * 第一版这里有三条模式都犯了这个错误（测试/用例、返回/状态码、不存在/等于…），
 * 它们从来没有生效过。**要么不加 `\b`，要么只在纯 ASCII 的 token 上用。**
 */

// ════════════════════════════════════════════════════════════════
// 会议
// ════════════════════════════════════════════════════════════════

export type RoundtableParticipant = {
  role: RoleId;
  /**
   * 针对当前议程发言。
   * 第 2 轮时 `against` 指向被质询方，并且**可以携带 falsifier** ——
   * 机械主持会当场执行它，用执行结果而不是措辞来裁决这场反驳。
   */
  speak(
    round: 1 | 2,
    against?: RoleId,
  ): Promise<{ claim: string; evidence: EvidenceRef[]; suggests?: string; falsifier?: Falsifier }>;
};

/**
 * 圆桌中被**机械确证**的事实。
 *
 * 类型定义在 `core/types.ts`，因为它要经事件流到达前端（`roundtable.closed`），
 * 属于线上数据结构而非本模块内部细节。这里只做转出，见文件末尾的 re-export。
 */

export type RoundtableResult = {
  minute: RoundtableMinuteDoc;
  /** 决议是否通过机械校验。false 时必须升级真人。 */
  resolutionValid: boolean;
  invalidReason?: string;
  /** 被丢弃的发言（证据核验失败，或被 falsifier 证伪）。 */
  discardedStatements: number;
  /** 被机械确证/证伪的事实。 */
  facts: RoundtableFact[];
  /** 当场执行过的 falsifier 次数。 */
  falsifiersRun: number;
  anchorsCited: AnchorId[];
};

export const MAX_ROUNDS = 2;

export type RoundtableSessionOptions = {
  trigger: RoundtableTrigger;
  participants: RoleId[];
  agenda: string[];
  anchorContext: AnchorContext;
  logger?: Logger;
  /** 执行 falsifier 用的命令安全策略（与机械裁判共用）。 */
  commandPolicy?: CommandPolicy;
  /** falsifier 执行超时。 */
  falsifierTimeoutMs?: number;
  /**
   * 机械归因指向的角色（异议的 targetRole + 锚点 findings 的 targetRole）。
   * 用于决定第 2 轮谁质询谁 —— 交叉质询必须跟着证据走，不能跟着数组顺序走。
   */
  focusTargets?: RoleId[];
};

export class RoundtableSession {
  readonly trigger: RoundtableTrigger;
  readonly participants: RoleId[];
  readonly agenda: string[];
  private ctx: AnchorContext;
  private logger: Logger;
  private commandPolicy: CommandPolicy;
  private falsifierTimeoutMs: number;
  private focusTargets: RoleId[];
  private statements: RoundtableStatement[] = [];
  private facts: RoundtableFact[] = [];
  private falsifiersRun = 0;

  constructor(args: RoundtableSessionOptions) {
    this.trigger = args.trigger;
    this.participants = args.participants;
    this.agenda = args.agenda;
    this.ctx = args.anchorContext;
    this.logger = args.logger ?? silentLogger('roundtable');
    this.commandPolicy = args.commandPolicy ?? DEFAULT_COMMAND_POLICY;
    this.falsifierTimeoutMs = args.falsifierTimeoutMs ?? 60_000;
    this.focusTargets = args.focusTargets ?? [];
  }

  /**
   * 主持一场圆桌。轮数上限 2（docs/05 §1.2）：
   * 多智能体辩论的边际收益在第 2 轮后迅速衰减，而成本线性增长；
   * 更长的辩论只会让「更能说」的角色获胜，而不是「更对」的角色获胜。
   *
   * 第 2 轮在本实现里不是「再吵一轮」，而是**用可执行的反驳来终结争议**：
   * 反驳带 falsifier → 当场执行 → 用结果判定谁对。
   */
  async run(
    speakers: Map<RoleId, RoundtableParticipant>,
    synthesize: (
      statements: RoundtableStatement[],
      agenda: string[],
      facts: RoundtableFact[],
    ) => Promise<RoundtableResolution | null>,
  ): Promise<RoundtableResult> {
    // ── 第 1 轮：立场陈述 ──────────────────────────────────────
    for (const role of this.participants) {
      const sp = speakers.get(role);
      if (!sp) continue;
      await this.collect(role, 1, sp, undefined);
    }

    // ── 第 2 轮：交叉质询（仅在第 1 轮出现实质分歧时） ──────────
    if (this.hasDisagreement()) {
      for (const role of this.participants) {
        const sp = speakers.get(role);
        if (!sp) continue;
        const against = this.pickOpponent(role);
        await this.collect(role, 2, sp, against);
        await this.executeFalsifier(this.statements.length - 1);
      }
    }

    // ── 收敛：产出候选决议，再由**机械校验**判定它是否合格 ──────
    //
    // 注意分工：机械主持负责**流程**（议程、证据核验、falsifier 执行、轮数上限）与
    // **决议合法性校验**（validateResolution）；决议的**内容**由 LLM 提议。
    // 这正是全局不变量「LLM 提议、程序裁决」在圆桌场景的体现。
    const resolution = await synthesize(this.liveStatements(), this.agenda, this.facts);
    const check = validateResolution(resolution, { facts: this.facts });
    const discarded = this.statements.filter((s) => s.discarded).length;

    this.logger.info(
      `圆桌结束：trigger=${this.trigger} 发言=${this.statements.length} 丢弃=${discarded} ` +
        `falsifier=${this.falsifiersRun}（确证 ${this.facts.filter((f) => f.outcome === 'sustained').length}）`,
      { resolutionValid: check.ok, ...(check.ok ? {} : { invalidReason: check.reason }) },
    );

    return {
      minute: {
        trigger: this.trigger,
        participants: this.participants,
        agenda: this.agenda,
        statements: this.statements,
        resolution,
        ...(check.ok ? {} : { escalation: 'HUMAN' as const, invalidReason: check.reason }),
        anchorsCited: [],
        facts: this.facts,
      },
      resolutionValid: check.ok,
      ...(check.ok ? {} : { invalidReason: check.reason }),
      discardedStatements: discarded,
      facts: this.facts,
      falsifiersRun: this.falsifiersRun,
      anchorsCited: [],
    };
  }

  /**
   * 交给 synthesize 的发言集合：**被丢弃的不给**。
   *
   * 这是「当场执行 falsifier」真正的用处：一条被机械证伪的反驳不该出现在
   * 决议的输入里 —— 否则 LLM 会把它当成一个平等的主张来「综合考虑」，
   * 而机械已经证明它是错的。
   */
  private liveStatements(): RoundtableStatement[] {
    return this.statements.filter((s) => !s.discarded);
  }

  /** 收集一次发言，并对证据做确定性核验。核验失败 → 发言被丢弃。 */
  private async collect(
    role: RoleId,
    round: 1 | 2,
    speaker: RoundtableParticipant,
    against?: RoleId,
  ): Promise<void> {
    let claim = '';
    let evidence: EvidenceRef[] = [];
    let falsifier: Falsifier | undefined;
    try {
      const out = await speaker.speak(round, against);
      claim = out.claim;
      evidence = out.evidence;
      falsifier = out.falsifier;
    } catch (err) {
      this.statements.push({
        role,
        round,
        claim: `<发言失败>`,
        evidence: [],
        discarded: `发言过程异常：${(err as Error).message}`,
        ...(against ? { againstRole: against } : {}),
      });
      return;
    }

    // 无证据发言直接被丢弃 —— 这是圆桌不变成吵架的关键
    if (evidence.length === 0) {
      this.statements.push({
        role,
        round,
        claim,
        evidence: [],
        ...(falsifier ? { falsifier } : {}),
        discarded: '未提供任何证据引用，发言被丢弃（圆桌不接受无证据主张）',
        ...(against ? { againstRole: against } : {}),
      });
      return;
    }

    const bad: string[] = [];
    for (const ref of evidence) {
      const v = await verifyEvidence(ref, this.ctx);
      if (!v.ok) bad.push(v.reason ?? '未知原因');
    }

    this.statements.push({
      role,
      round,
      claim,
      evidence,
      ...(falsifier ? { falsifier } : {}),
      ...(bad.length > 0 ? { discarded: `证据核验失败：${bad.join('；')}` } : {}),
      ...(against ? { againstRole: against } : {}),
    });
  }

  /**
   * 当场执行一条发言携带的 falsifier，并按结果裁决这条发言的去留。
   *
   * 判定语义（与机械裁判一致，避免两套规则）：
   *   `expect: 'exit-nonzero'`  → 命令非零退出 = 反驳成立
   *   `expect: 'output-matches'` → 输出匹配模式 = 反驳成立
   * 命令被安全策略拒绝或跑不起来 → `inconclusive`（无法裁决，不惩罚任何一方）。
   */
  private async executeFalsifier(index: number): Promise<void> {
    const st = this.statements[index];
    if (!st || st.discarded || st.falsifier?.kind !== 'executable') return;

    const f = st.falsifier;
    const run = await execCapture(f.command, {
      cwd: this.ctx.projectRoot,
      policy: this.commandPolicy,
      timeoutMs: this.falsifierTimeoutMs,
    });
    this.falsifiersRun++;

    if (run.deniedReason || run.spawnError || run.timedOut) {
      const detail = run.deniedReason ?? run.spawnError ?? '执行超时';
      st.falsifierOutcome = {
        command: f.command,
        exitCode: run.exitCode,
        matched: false,
        outcome: 'inconclusive',
        detail: `无法执行：${detail}`,
      };
      this.logger.warn(`圆桌 falsifier 无法执行（${st.role}）：${detail}`);
      return;
    }

    const matched =
      f.expect === 'exit-nonzero'
        ? run.exitCode !== 0
        : f.pattern !== undefined && new RegExp(f.pattern).test(run.stdout + run.stderr);

    st.falsifierOutcome = {
      command: f.command,
      exitCode: run.exitCode,
      matched,
      outcome: matched ? 'sustained' : 'refuted',
    };

    if (matched) {
      // 反驳成立 → 记为机械确证的事实
      this.facts.push({
        statementIndex: index,
        role: st.role,
        ...(st.againstRole ? { against: st.againstRole } : {}),
        claim: st.claim,
        command: f.command,
        exitCode: run.exitCode,
        outcome: 'sustained',
        implicates: st.againstRole ?? st.role,
      });
      this.logger.info(`圆桌反驳被机械证实（${st.role} → ${st.againstRole ?? '未指名'}）：exit ${run.exitCode}`);
    } else {
      // 反驳被证伪 → **整条发言丢弃**，不进决议输入
      st.discarded = `携带的 falsifier 未能复现，反驳被机械证伪（exit ${run.exitCode}）—— 该主张不作为决议依据`;
      this.facts.push({
        statementIndex: index,
        role: st.role,
        ...(st.againstRole ? { against: st.againstRole } : {}),
        claim: st.claim,
        command: f.command,
        exitCode: run.exitCode,
        outcome: 'refuted',
        implicates: st.role,
      });
      this.logger.info(`圆桌反驳被机械证伪（${st.role}）：exit ${run.exitCode}，该发言已丢弃`);
    }
  }

  /** 是否存在实质分歧：有被丢弃的发言，或不同角色的有效主张在归因上不一致。 */
  private hasDisagreement(): boolean {
    const valid = this.statements.filter((s) => s.round === 1 && !s.discarded);
    if (valid.length < 2) return false;
    return new Set(valid.map((s) => s.role)).size >= 2;
  }

  /**
   * 选谁作为第 2 轮的质询对象。
   *
   * 优先级：
   *   1. **机械归因指向的角色**（`focusTargets`：异议 targetRole + 锚点 findings targetRole）
   *      —— 焦点必须跟着证据走。
   *   2. **轮转配对**：第 i 位发言者质询名单里的下一位（环状）。
   *
   * 第一版写的是「取第一个不等于自己的角色」，那会让第 2 轮退化成所有人排队质询
   * 同一个人（名单里排第一的那个）—— 圆桌于是变成围攻，而 T2 恰恰是
   * 「还不知道该怪谁」的场合，围攻一个可能无辜的人是最坏的结果。
   * 轮转配对让一轮下来覆盖多组配对，把「谁对谁错」真正摊开来检验。
   */
  private pickOpponent(role: RoleId): RoleId | undefined {
    const valid = this.statements.filter((s) => s.round === 1 && !s.discarded);
    const others = valid.filter((s) => s.role !== role);
    if (others.length === 0) return undefined;

    const focus = this.focusTargets.find((t) => others.some((s) => s.role === t));
    if (focus) return focus;

    const roster = valid.map((s) => s.role);
    const i = roster.indexOf(role);
    if (i >= 0) {
      for (let k = 1; k <= roster.length; k++) {
        const cand = roster[(i + k) % roster.length];
        if (cand !== role) return cand;
      }
    }
    return others[0].role;
  }

  get allStatements(): RoundtableStatement[] {
    return this.statements;
  }

  get confirmedFacts(): RoundtableFact[] {
    return this.facts;
  }
}

export type { ArtifactId, ContractDoc, RoundtableFact, RoundtableResolution };
