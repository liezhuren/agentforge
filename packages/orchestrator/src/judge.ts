/**
 * 机械裁判（Mechanical Judge）。
 *
 * 这是全局不变量第 1 条「LLM 永远不是最终裁判」的落地点：**本文件不含任何 LLM 调用**。
 *
 * 它的职责是给主理人的每条异议一个三档裁决：
 *   VALID          真报：证据真实 + falsifier 可执行并确认问题存在 → 阻断生效，扣 1 额度
 *   UNFALSIFIABLE  不合格但不说谎：证据缺失/无法执行/只有人能回答 → 不阻断、不计误报
 *   REFUTED        误报：falsifier 未能复现，或**断言与已通过的 A 层锚点直接矛盾** → 扣 2 额度
 *
 * 最后一条是本设计最重要的一步：它让**主理人自己也在锚点约束之下**。
 * 声称「这个包不存在」而 A1 已经 PASS、声称「编译失败」而 A4 已经 PASS，
 * 都不是「意见分歧」，而是可被机械证伪的假话。
 */

import type {
  AnchorId,
  Arbitration,
  EvidenceCheck,
  EvidenceRef,
  Objection,
  AnchorRunResult,
  AnchorVerdict,
} from '../../core/src/types.ts';
import {
  execCapture,
  type CommandPolicy,
  type Logger,
  DEFAULT_COMMAND_POLICY,
  silentLogger,
} from '../../core/src/index.ts';
import { verifyEvidence, type AnchorContext } from '../../anchors/src/index.ts';
import type { HostLedger } from './ledger.ts';

// ════════════════════════════════════════════════════════════════
// 与 A 层锚点矛盾检测
// ════════════════════════════════════════════════════════════════

/**
 * A 层锚点各自「说了算」的领域。
 *
 * 只有当对应锚点**确实 PASS**（即对该领域做出了肯定性结论）时，
 * 主理人在同一领域内断言「不存在/失败」才构成可机械证伪的假话。
 * 锚点为 SKIPPED/WARN 时一律不启用此判定 —— 未验证的领域没有权威。
 */
export const A_LAYER_DOMAINS: Array<{
  anchorId: AnchorId;
  /** 断言所涉及的领域关键词。 */
  subjects: string[];
  /** 断言「东西不存在 / 没通过」的措辞。 */
  predicates: string[];
  /** 给人类看的说明。 */
  description: string;
}> = [
  {
    anchorId: 'A1',
    subjects: ['依赖', '依赖包', '第三方包', 'npm 包', 'package.json', 'dependency', 'dependencies'],
    predicates: ['不存在', '找不到', '查不到', '未安装', '没有这个包', '编造', '幻觉', '拼错', '非法'],
    description: 'A1 已核实全部声明依赖（命名合法、可核实存在、符合约束白名单）',
  },
  {
    anchorId: 'A2',
    subjects: ['符号', '导出', '具名导入', 'export', '导出成员', 'api 名', '方法名', '函数名'],
    predicates: ['不存在', '未导出', '没有导出', '未定义', '找不到', '编造', '幻觉', '拼错'],
    description: 'A2 已核实全部裸模块导入的具名符号确实被导出',
  },
  {
    anchorId: 'A3',
    subjects: ['模块', '模块路径', '导入路径', '相对导入', '文件路径', 'import 路径', '引用路径'],
    predicates: ['不存在', '找不到', '缺失', '解析不了', '无法解析', '编造', '路径错误'],
    description: 'A3 已核实全部本地导入都能解析到真实文件',
  },
  {
    anchorId: 'A4',
    subjects: ['编译', '类型', '类型检查', '类型错误', 'tsc', '类型不匹配', '编译错误'],
    predicates: ['失败', '报错', '不通过', '无法编译', '有错误', '过不了', '不匹配'],
    description: 'A4 已真实运行类型检查并确认零错误',
  },
  {
    anchorId: 'A5',
    subjects: ['测试', '用例', '单元测试', '集成测试', 'test'],
    predicates: ['失败', '不通过', '没跑', '未执行', '全部挂了', '报错'],
    description: 'A5 已真实运行测试并确认全部通过',
  },
  {
    anchorId: 'A6',
    subjects: ['服务', '运行时', '进程', '健康检查', '启动'],
    /**
     * 刻意**不**收录「超时」这类泛化措辞：它可能指测试超时、falsifier 超时，
     * 拿去证伪 A6 会误伤诚实的异议。而误报的代价是真报的两倍（R2），
     * 一次误判就足以让主理人学会闭嘴 —— 那比漏判更糟。
     */
    predicates: ['起不来', '无法启动', '没启动', '未能启动', '启动不了', '在就绪前退出', '连不上', '不可达', '探针失败'],
    description: 'A6 已真实启动服务并完成 HTTP 探针（健康检查返回 2xx）',
  },
  {
    anchorId: 'A7',
    subjects: ['契约', 'openapi', '接口定义', '端点', '接口路径', 'contract'],
    predicates: ['未实现', '不存在', '缺失', '不一致', '漂移', '对不上'],
    description: 'A7 已核实实现与冻结契约一致',
  },
  {
    anchorId: 'A8',
    subjects: ['package.json', 'tsconfig', '项目契约', '验证基准', '契约文件', '测试命令', '启动命令'],
    /**
     * 只收录「产出动过验证基准」这一族断言。
     * A8 PASS 的含义是「本轮产出没有删除或改写项目契约」，它能证伪的正是这一族；
     * 至于「测试命令不存在」之类，A8 并不检查命令是否存在 ——
     * 收录进来会超出它的权威范围，把一句可能为真的异议判成撒谎。
     *
     * 动词形态必须列全（被动式"被删"、动宾式"删掉"、光杆"删除"都要有）：
     * 只写"被删"会让这个条目**形同虚设** —— 主理人写「删掉了」就命中不了，
     * 于是加进表里等于没加。这是本项目反复出现的同一类问题：
     * 一个看起来在工作的检查，实际上永远不会触发。
     *
     * 代价也要说清楚：`删除` 这类光杆动词有误报空间（例如「建议删除未使用的字段」
     * 同时含 subject 与谓词）。这是关键词判定的固有局限（见文件头 A_LAYER_DOMAINS 的说明），
     * 靠的是两道保守闸门兜底：**只有该锚点 PASS、且 severity 为 blocker 时才启用**。
     */
    predicates: ['被改', '被删', '被替换', '被覆盖', '被篡改', '删掉', '删了', '删除', '改写', '覆盖掉', '替换掉'],
    description: 'A8 已确认本轮产出没有删除或改写项目契约（验证基准完好）',
  },
];

export type ContradictionCheck = {
  contradicted: boolean;
  anchorId?: AnchorId;
  reason?: string;
};

/**
 * 检测异议是否与已通过的 A 层锚点直接矛盾。
 *
 * 已知局限（诚实记录）：这是**关键词**判定，不是语义理解。
 * 因此设计上做了两处保守处理：
 *   1. 只在该锚点 verdict === 'PASS' 时启用（SKIPPED/WARN 一律不启用）
 *   2. 只在 severity === 'blocker' 时启用
 * 且裁决理由里会写明是「关键词命中哪个领域」，人类可据此复查裁判是否误判。
 * 若出现误判，正确的修法是改这张表或加锚点，而不是让主理人绕过事实底座
 * （docs/05 §3 不变量：人类可以推翻机器人，但不能用「意见」推翻确定性事实）。
 */
export function checkContradiction(
  objection: Objection,
  anchorResults: AnchorRunResult[],
): ContradictionCheck {
  if (objection.severity !== 'blocker') return { contradicted: false };

  const claim = objection.claim.replace(/\s+/g, ' ').toLowerCase();
  const byId = new Map<AnchorId, AnchorRunResult>(anchorResults.map((r) => [r.anchorId, r]));

  for (const domain of A_LAYER_DOMAINS) {
    const run = byId.get(domain.anchorId);
    if (!run || run.verdict !== 'PASS') continue;

    const subjectHit = domain.subjects.find((s) => claim.includes(s.toLowerCase()));
    if (!subjectHit) continue;
    const predicateHit = domain.predicates.find((p) => claim.includes(p.toLowerCase()));
    if (!predicateHit) continue;

    return {
      contradicted: true,
      anchorId: domain.anchorId,
      reason: `异议断言「${subjectHit} + ${predicateHit}」，但 ${domain.anchorId} 锚点已 PASS（${domain.description}）—— 这是可机械证伪的假话，不是意见分歧`,
    };
  }

  // 引用了一个通过的锚点作为阻断依据
  const anchorRefs = objection.evidence.filter((e): e is Extract<EvidenceRef, { kind: 'anchor' }> => e.kind === 'anchor');
  if (anchorRefs.length > 0 && anchorRefs.length === objection.evidence.length) {
    const runs = anchorRefs.map((r) => byId.get(r.anchorId)).filter(Boolean) as AnchorRunResult[];
    if (runs.length === anchorRefs.length && runs.every((r) => r.verdict === 'PASS')) {
      return {
        contradicted: true,
        anchorId: runs[0].anchorId,
        reason: `异议唯一引用的锚点 ${runs.map((r) => r.anchorId).join('/')} 结论为 PASS，不能作为「存在问题」的依据`,
      };
    }
  }

  return { contradicted: false };
}

// ════════════════════════════════════════════════════════════════
// 裁判
// ════════════════════════════════════════════════════════════════

export type MechanicalJudgeOptions = {
  anchorContext: AnchorContext;
  ledger: HostLedger;
  commandPolicy?: CommandPolicy;
  logger?: Logger;
  /** falsifier 执行超时。 */
  falsifierTimeoutMs?: number;
};

export type ArbitrationSummary = {
  results: Arbitration[];
  valid: number;
  refuted: number;
  unfalsifiable: number;
  /** 需要人类回答的异议（question 型 falsifier）。 */
  requiresHuman: number;
  /** 本次裁决后是否应触发圆桌（R3）及触发原因。 */
  conveneRoundtable: boolean;
  /** 被 R8/R9 挡下的阻断尝试（未归因 / 非 blocker）。 */
  blockedByGuard: number;
};

export class MechanicalJudge {
  readonly history: Arbitration[] = [];
  private readonly refutedKeys = new Set<string>();
  private readonly policy;
  private readonly ctx: AnchorContext;
  private readonly ledgerRef: HostLedger;
  private readonly commandPolicy: CommandPolicy;
  private readonly logger: Logger;
  private readonly falsifierTimeoutMs: number;

  constructor(opts: MechanicalJudgeOptions) {
    this.ctx = opts.anchorContext;
    this.ledgerRef = opts.ledger;
    this.commandPolicy = opts.commandPolicy ?? DEFAULT_COMMAND_POLICY;
    this.logger = opts.logger ?? silentLogger('judge');
    this.falsifierTimeoutMs = opts.falsifierTimeoutMs ?? 60_000;
    this.policy = this.ledgerRef.policy;
  }

  /** 批量裁决。返回汇总，供 Gate 决定 nextAction。 */
  async arbitrateAll(
    objections: Objection[],
    anchorResults: AnchorRunResult[],
  ): Promise<ArbitrationSummary> {
    const results: Arbitration[] = [];
    let convene = false;
    let blockedByGuard = 0;

    // 先处理「连阻断资格都没有」的异议：R8（非 blocker）与 R9（未归因）
    // 这样可以避免它们白白消耗阻断额度，也保证 R9 一定触发圆桌（T2）。
    const ordered = [...objections].sort((a, b) => guardRank(a) - guardRank(b));

    for (const o of ordered) {
      const guard = this.preGuard(o);
      let arb: Arbitration;

      if (guard) {
        arb = guard;
        if (o.severity === 'blocker') blockedByGuard++;
      } else {
        arb = await this.arbitrateOne(o, anchorResults);
      }

      results.push(arb);
      this.history.push(arb);

      if (arb.verdict === 'REFUTED') this.refutedKeys.add(repeatKey(o));

      // countsAsAttempt = 真正走过仲裁的 blocker 异议。
      // 被前置守门挡下（R8/R9/账本已禁）的异议不消耗额度 —— 它们不具备阻断资格。
      const effect = this.ledgerRef.record(arb, o.severity, guard === null);
      if (effect.shouldConveneRoundtable) convene = true;
      if (effect.enteredProbation || effect.shouldConveneRoundtable) {
        this.logger.warn(`账本变化：${effect.reason}`, this.ledgerRef.snapshot());
      }
      this.logger.info(`裁决 ${o.id} → ${arb.verdict}（${arb.rule}）`, {
        claim: o.claim.slice(0, 100),
        reason: arb.reason,
      });
    }

    const summary: ArbitrationSummary = {
      results,
      valid: results.filter((r) => r.verdict === 'VALID').length,
      refuted: results.filter((r) => r.verdict === 'REFUTED').length,
      unfalsifiable: results.filter((r) => r.verdict === 'UNFALSIFIABLE').length,
      requiresHuman: results.filter((r) => r.requiresHuman).length,
      conveneRoundtable: convene,
      blockedByGuard,
    };
    return summary;
  }

  /**
   * 前置守门：R8（severity != blocker）与 R9（未归因）。
   * 这两类异议根本不该消耗阻断额度，也不该被记误报 —— 它们只是「不合格」。
   */
  private preGuard(o: Objection): Arbitration | null {
    if (o.severity !== 'blocker') {
      return this.mk(o, 'UNFALSIFIABLE', 'R8-severity', `severity=${o.severity}，只有 blocker 才能阻断（R8）。该意见转入 backlog`);
    }
    if (o.targetRole === 'UNRESOLVED') {
      return this.mk(
        o,
        'UNFALSIFIABLE',
        'R9-unattributed',
        '异议未归因到具体角色（R9）。归因不清不阻断，自动触发圆桌会议（触发条件 T2）',
      );
    }
    const gate = this.ledgerRef.canBlock();
    if (!gate.allowed) {
      return this.mk(o, 'UNFALSIFIABLE', 'ledger-guard', `阻断被账本挡下：${gate.reason}`);
    }
    return null;
  }

  private async arbitrateOne(o: Objection, anchorResults: AnchorRunResult[]): Promise<Arbitration> {
    // ── R6 复读惩罚 ──────────────────────────────────────────────
    if (this.policy.repeatPenalty && this.refutedKeys.has(repeatKey(o))) {
      return this.mk(
        o,
        'REFUTED',
        'R6-repeat',
        '同一异议（相同 claim 与 evidence）此前已被驳回，再次提交视为复读，直接记误报（R6）',
      );
    }

    // ── 证据核验 ────────────────────────────────────────────────
    const evidenceChecks: EvidenceCheck[] = [];
    for (const ref of o.evidence) {
      const v = await verifyEvidence(ref, this.ctx);
      evidenceChecks.push({ ref, ok: v.ok, ...(v.reason ? { reason: v.reason } : {}) });
    }
    if (o.evidence.length === 0) {
      return this.mk(o, 'UNFALSIFIABLE', 'evidence-missing', '异议未提供任何证据引用，无法核验', evidenceChecks);
    }
    const badEvidence = evidenceChecks.filter((c) => !c.ok);
    if (badEvidence.length > 0) {
      return this.mk(
        o,
        'UNFALSIFIABLE',
        'evidence-invalid',
        `异议引用了不存在的证据：${badEvidence.map((c) => c.reason).join('；')}。证据无效 → 不可证伪 → 不阻断`,
        evidenceChecks,
      );
    }

    // ── 与已通过的 A 层锚点矛盾 ─────────────────────────────────
    // 放在 falsifier 之前是刻意的：主理人是被设计成对抗性的，
    // 它可以构造一个「必然非零退出」的假 falsifier 来骗过执行层；
    // 但骗不过「A 层已经 PASS」这个事实。
    const contra = checkContradiction(o, anchorResults);
    if (contra.contradicted) {
      return this.mk(o, 'REFUTED', 'R-contradicts-anchor', contra.reason ?? '与已通过的锚点结论矛盾', evidenceChecks);
    }

    // ── falsifier ───────────────────────────────────────────────
    if (o.falsifier.kind === 'question') {
      return this.mk(
        o,
        'UNFALSIFIABLE',
        'falsifier-human-question',
        `异议只能由人回答才能裁决（「${o.falsifier.text}」）。question 型不可自动裁决 → 不阻断，转待裁决收件箱`,
        evidenceChecks,
        undefined,
        true,
      );
    }

    const f = o.falsifier;
    const run = await execCapture(f.command, {
      cwd: this.ctx.projectRoot,
      policy: this.commandPolicy,
      timeoutMs: this.falsifierTimeoutMs,
    });

    if (run.deniedReason) {
      return this.mk(
        o,
        'UNFALSIFIABLE',
        'falsifier-denied',
        `falsifier 命令被安全策略拒绝（${run.deniedReason}）。命令无法执行 → 裁决不了，不计误报（这是系统的限制，不是异议的错）`,
        evidenceChecks,
        { command: f.command, exitCode: run.exitCode, stdout: '', stderr: '', matched: false, error: run.deniedReason },
      );
    }
    if (run.spawnError || run.timedOut) {
      return this.mk(
        o,
        'UNFALSIFIABLE',
        run.timedOut ? 'falsifier-timeout' : 'falsifier-spawn-error',
        `falsifier 无法执行（${run.timedOut ? '超时' : run.spawnError}）`,
        evidenceChecks,
        {
          command: f.command,
          exitCode: run.exitCode,
          stdout: tail(run.stdout),
          stderr: tail(run.stderr),
          matched: false,
          error: run.spawnError ?? 'timeout',
        },
      );
    }

    const matched =
      f.expect === 'exit-nonzero'
        ? run.exitCode !== 0
        : f.pattern !== undefined && new RegExp(f.pattern).test(run.stdout + run.stderr);

    const falsifierRun = {
      command: f.command,
      exitCode: run.exitCode,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
      matched,
    };

    if (matched) {
      return this.mk(
        o,
        'VALID',
        'falsifier-confirmed',
        `falsifier 执行确认问题存在（exit ${run.exitCode}，期望 ${f.expect}）`,
        evidenceChecks,
        falsifierRun,
      );
    }

    return this.mk(
      o,
      'REFUTED',
      'falsifier-refuted',
      f.expect === 'exit-nonzero'
        ? `falsifier 以退出码 0 结束，未复现所声称的问题 —— 记为误报（R2：误报代价为真报的两倍）`
        : `falsifier 输出未匹配 /${f.pattern}/，未复现所声称的问题 —— 记为误报（R2）`,
      evidenceChecks,
      falsifierRun,
    );
  }

  private mk(
    o: Objection,
    verdict: Arbitration['verdict'],
    rule: string,
    reason: string,
    evidenceChecks: EvidenceCheck[] = [],
    falsifierRun?: Arbitration['falsifierRun'],
    requiresHuman?: boolean,
  ): Arbitration {
    const quotaDelta =
      verdict === 'VALID' ? -1 : verdict === 'REFUTED' ? -this.policy.refutedPenalty : 0;
    return {
      objectionId: o.id,
      verdict,
      rule,
      reason,
      quotaDelta,
      truePositive: verdict === 'VALID',
      falsePositive: verdict === 'REFUTED',
      evidenceChecks,
      ...(falsifierRun ? { falsifierRun } : {}),
      ...(requiresHuman ? { requiresHuman: true } : {}),
      at: new Date().toISOString(),
    };
  }

  /** 已驳回的异议键（供 UI 与复查）。 */
  refutedCount(): number {
    return this.refutedKeys.size;
  }
}

function repeatKey(o: Objection): string {
  return `${o.claimHash}|${o.evidenceHash}`;
}

function guardRank(o: Objection): number {
  if (o.severity !== 'blocker') return 0;
  if (o.targetRole === 'UNRESOLVED') return 1;
  return 2;
}

function tail(s: string, n = 1200): string {
  return s.length <= n ? s : '…' + s.slice(-n);
}

export type { AnchorVerdict };
