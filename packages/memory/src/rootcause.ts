/**
 * 机械根因分类：把「锚点发现」归到一个**根因类**上。
 *
 * ## 为什么需要它（这是记忆系统的第一步，且本身就有价值）
 *
 * 这个项目最贵的一类误判是：**约定没传达，失败却长得像「模型能力不足」**。
 * 12 轮真实运行里反复出现（docs/HANDOFF.md §6.1 记了四次）：
 *   - A4 报 TS2835（相对导入缺扩展名）→ 看起来是模型写错，实际是本项目的约定没告诉它
 *   - A5 报 spawn EPERM → 看起来是测试写得烂，实际是环境禁止管道式 stdio
 *   - A6 报「服务在就绪前退出（exit 0）」→ 看起来是模型不会写服务，实际是没人说入口必须自启
 *
 * 分类器把「这次失败指向**环境/约定**」还是「指向**代码本身**」变成一次**确定性判断**，
 * 并给出它依据的是哪一条规则（`ruleId`）—— 于是分类结论本身也是可核查、可追责、可被改错的。
 *
 * ## 三类根因，对应三种完全不同的处置
 *
 * | 类 | 含义 | 处置 |
 * |---|---|---|
 * | `convention:*` | 产出按**另一套**合理规则写的，没人告诉它这一套 | **可以进记忆**（事前告知比事后返工便宜） |
 * | `environment:*` | 环境限制没被传达 | **可以进记忆** |
 * | `contract:*` | 项目声明本身缺失/错配 | 可以进记忆（但要人去改项目声明） |
 * | `baseline:*` | 被验证者动了验证基准 | 可以进记忆（这是硬闸，不进记忆也该被拦） |
 * | `code:*` | **产出真的是错的** | **绝不能进记忆** |
 * | `role:*` | 某个角色的产出质量问题（证据造假/引用不实） | 不进记忆 |
 * | `state:*` | 「还没做」，不是「做错了」 | 不进记忆 |
 * | `verify:*` | 「查过了但确认不了」，是验证能力问题 | 不进记忆 |
 * | `unknown` | 没见过的形态 | **不进记忆**（失败关闭） |
 *
 * ⚠️ **`code:*` 绝不能进记忆，这是这套系统的道德底线。**
 * 如果「模型真的写错了」也被总结成一条「经验」喂回提示词，那记忆系统就变成了
 * 一台**生产借口的机器** —— 它会持续地把真实的实现缺陷包装成「环境问题」，
 * 让流水线越来越绿、产出越来越差。所以本文件里 `code:*` 一律 `eligible: false`，
 * 并且有测试专门守这条线（`memory.test.ts` 的「拒绝类永不进记忆」）。
 *
 * ## 规则的来源
 *
 * 全部规则都从**已发生的真实数据**里归纳（12 轮 / 111 份锚点结论 / 52 份带 findings），
 * 不是凭印象写的。每条规则标注了它依据的是**结构化字段**还是**文本模式**：
 * 前者是硬的（`data.tsCode` / `data.exitCode`），后者会随措辞变化而失效
 * （`textBased: true`），因此文本规则故意写得保守 —— 认不出就归 `unknown`，不猜。
 */

import type { AnchorFinding, AnchorId } from '../../core/src/index.ts';

/**
 * 根因类。
 *
 * 命名规则：`<域>:<具体形态>`。域决定「能不能进记忆」，形态决定「沉淀成哪条经验」。
 */
export type RootCauseClass =
  // ── 约定类：产出按另一套合理规则写的，没人告诉它这一套 ────────────────
  | 'convention:explicit-relative-extension'
  | 'convention:entry-must-self-start'
  | 'convention:import-generated-contract-types'
  | 'convention:engine-published-artifact' // 引擎自己发的工件，任务图不该声明为交付物
  // ── 环境类：环境限制没被传达 ──────────────────────────────────────
  | 'environment:spawn-restricted'
  | 'environment:command-path-mangling'
  | 'environment:offline-registry'
  // ── 契约类：项目声明缺失或错配 ────────────────────────────────────
  | 'contract:missing-declaration' // 缺 healthUrl / 缺 run 命令 → 锚点只能 SKIPPED
  | 'contract:typecheck-misconfigured' // 如 TS18003：tsconfig 里没有任何输入文件
  // ── 基准类：被验证者动了验证基准（A8 守的就是这条）────────────────────
  | 'baseline:tampered'
  // ── 代码类：产出真的是错的 —— 永不进记忆 ───────────────────────────
  | 'code:type-error'
  | 'code:test-assertion-failure'
  | 'code:test-runner-could-not-run'
  | 'code:invented-module-path'
  | 'code:entry-crashes'
  | 'code:http-endpoint-missing'
  | 'code:deliverable-missing'
  | 'code:requirement-not-met'
  | 'code:test-coverage-gap'
  | 'code:contract-drift'
  // ── 角色类：产出质量问题（不是约定问题，也不是简单写错）──────────────
  | 'role:invalid-citation' // 引用了不含所声称内容的行区间（证据造假/幻觉）
  // ── 未完成类：「还没做」不等于「做错了」 ───────────────────────────
  | 'state:not-yet-implemented'
  // ── 验证能力类：「查过了但确认不了」 ────────────────────────────────
  | 'verify:cannot-determine'
  // ── 兜底 ────────────────────────────────────────────────────────
  | 'unknown';

/**
 * 可以沉淀成记忆的根因类。
 *
 * 用**白名单**而不是黑名单：新增一个根因类时，默认结果是「不进记忆」。
 * 记忆能影响后续所有轮次的产出，所以「默认不写入」是唯一安全的默认值。
 */
export const MEMORY_ELIGIBLE_CLASSES: ReadonlySet<RootCauseClass> = new Set<RootCauseClass>([
  'convention:explicit-relative-extension',
  'convention:entry-must-self-start',
  'convention:import-generated-contract-types',
  'convention:engine-published-artifact',
  'environment:spawn-restricted',
  'environment:command-path-mangling',
  'environment:offline-registry',
  'contract:missing-declaration',
  'contract:typecheck-misconfigured',
  'baseline:tampered',
]);

/**
 * **不是「任务能交付」的工件** —— 它们由引擎在特定阶段产出，或干脆是人类输入。
 *
 * 这份集合是**从真实数据里长出来的**，不是一开始就想到的：
 * 第一版只硬编码了 `TestReport`（因为 `docs/HANDOFF.md §8.1` 记过它由引擎发布）。
 * 随后跑 §8.0-next 那轮「难度高一档」的项目时，B2 报了 12 条 `deliverable-missing`，
 * 声明的是 **`AnchoredReview`** 与 **`Directive`** —— 同一类问题的另外两个成员，而分类器**全都没认出来**，
 * 于是它们落进了 `code:deliverable-missing`（= 不进记忆），这一类就永远不会被浮出来。
 *
 * 这件事本身就是记忆系统价值的证据：**换一个项目，同一个坑换张脸又出现了**，
 * 而修法只是把这张表补全 —— 而「该补表」这个判断来自数据，不来自灵感。
 *
 * | 工件 | 谁产出 |
 * |---|---|
 * | `TestReport` | 引擎在 A5 之后从机械事实发布（`publishTestReport`） |
 * | `RoundtableMinute` | 圆桌会议时由引擎产出 |
 * | `DebtRecord` | 引擎记录技术债 |
 * | `Directive` | **真人输入** —— 永远不可能由角色交付 |
 * | `AnchoredReview` | 主理人在 REVIEW 阶段产出；BUILDING 阶段的任务不可能交付它 |
 */
export const NON_TASK_DELIVERABLE_KINDS: ReadonlySet<string> = new Set([
  'TestReport',
  'RoundtableMinute',
  'DebtRecord',
  'Directive',
  'AnchoredReview',
]);

/** 类 → 人可读的中文说明（报告与经验库共用）。 */
export const CLASS_LABELS: Record<RootCauseClass, string> = {
  'convention:explicit-relative-extension': '相对导入缺显式扩展名（本项目约定与多数前端项目不同）',
  'convention:entry-must-self-start': '入口文件未自启（只导出工厂函数，进程随即退出）',
  'convention:import-generated-contract-types': '手写契约类型而没有 import 生成的类型文件',
  'convention:engine-published-artifact': '任务图把「不是任务能交付的东西」声明成了角色交付物',
  'environment:spawn-restricted': '在被禁止管道式 stdio 的环境里 spawn 子进程',
  'environment:command-path-mangling': '带空格的命令路径被拆坏（spawn 之上的 shell 行为）',
  'environment:offline-registry': '无外网，依赖的真实性未能向 registry 核实',
  'contract:missing-declaration': '项目未声明锚点所需的契约（healthUrl / run 命令）',
  'contract:typecheck-misconfigured': '类型检查配置本身有问题（如 tsconfig 没有任何输入文件）',
  'baseline:tampered': '产出改写了验证基准文件',
  'code:type-error': '类型错误（产出自身的问题）',
  'code:test-assertion-failure': '测试断言失败（产出自身的问题）',
  'code:test-runner-could-not-run': '测试运行器根本没能跑起来',
  'code:invented-module-path': '导入了不存在的模块路径',
  'code:entry-crashes': '入口进程崩溃退出',
  'code:http-endpoint-missing': 'HTTP 端点未实现或路径不符',
  'code:deliverable-missing': '任务声明的交付物不存在',
  'code:requirement-not-met': '需求确实未达成',
  'code:test-coverage-gap': '需求没有任何测试覆盖',
  'code:contract-drift': '实现与契约漂移（非类型层面）',
  'role:invalid-citation': '引用的行区间并不包含所声称的内容',
  'state:not-yet-implemented': '尚无产出（未开始 ≠ 已失败，也 ≠ 通过）',
  'verify:cannot-determine': '查过了但确认不了（验证能力问题）',
  unknown: '未识别的形态（保守起见不进记忆）',
};

export type Classification = {
  cls: RootCauseClass;
  /** 命中的规则 id —— 分类器自身的出处，便于审计与改错。 */
  ruleId: string;
  /** 人可读的判断依据（进报告，进不了提示词）。 */
  because: string;
  /** 是否允许沉淀成记忆。`unknown` 与 `code:*` 一律 false。 */
  eligible: boolean;
  /** 依据是文本模式而非结构化字段 —— 更脆弱，报告里要显式标出来。 */
  textBased: boolean;
  /**
   * 这条发现是**引擎在自述自己的模式/配置**，而不是「产出有缺陷」。
   *
   * 为什么必须区分（这是看真实报告时发现的过度概括风险）：
   * `A1|registry-unchecked`（离线模式）每个工作区**必然**出现一次 ——
   * 它不是「发生了 16 次问题」，而是「有 16 个工作区」。
   * 如果按「独立轮次 ≥ 2」就自动提升，它会成为**最容易生效、也最没价值**的一条经验：
   * 证据条数看着很足，实际全是同一个常量被数了很多遍。
   *
   * 所以自述类发现照旧入库（它们是有用的事实），但**不允许自动提升**，
   * 只能由人显式提升。这比调大 `PROMOTE_MIN_SUPPORT` 更准 —— 问题不是数量不够，
   * 是这些数量**不独立**。
   */
  selfReport: boolean;
};

/** `finding.data` 的已知字段。全部可选：不同锚点填的东西不同。 */
type FindingData = {
  tsCode?: string;
  exitCode?: number;
  passed?: number;
  failed?: number;
  stderr?: string;
  stdout?: string;
  raw?: string;
  healthUrl?: string;
  specifier?: string;
  model?: string;
  generatedTypesPath?: string;
  taskId?: string;
  deliverable?: string;
  invalidRefs?: unknown;
};

function asData(f: AnchorFinding): FindingData {
  return (f.data ?? {}) as FindingData;
}

type Rule = {
  id: string;
  /** 只在这些锚点上尝试（省去无谓匹配，也让规则表更可读）。 */
  anchors: AnchorId[];
  /** 返回 null 表示不匹配。 */
  match: (anchorId: AnchorId, f: AnchorFinding, d: FindingData) => string | null;
  cls: RootCauseClass;
  textBased?: boolean;
  /** 见 `Classification.selfReport` —— 引擎自述模式，而非产出缺陷。 */
  selfReport?: boolean;
};

/**
 * 规则表。**顺序即优先级**：越靠前的越具体。
 *
 * 每条规则的 `match` 返回「为什么这么判」的中文说明；返回 null 表示不匹配。
 */
const RULES: Rule[] = [
  // ── A4：编译/类型 ───────────────────────────────────────────────
  {
    id: 'A4.TS2835',
    anchors: ['A4'],
    cls: 'convention:explicit-relative-extension',
    match: (_a, _f, d) =>
      d.tsCode === 'TS2835'
        ? 'TS2835：相对导入需要显式文件扩展名。这是本项目 tsconfig（NodeNext + allowImportingTsExtensions + Node 原生类型剥离）的约定，与多数前端项目不同 —— 属于「约定没传达」，不是模型写错。'
        : null,
  },
  {
    id: 'A4.TS18003',
    anchors: ['A4'],
    cls: 'contract:typecheck-misconfigured',
    match: (_a, f, d) => {
      const blob = `${d.raw ?? ''}${f.message}`;
      return blob.includes('TS18003')
        ? 'TS18003：类型检查配置里没有任何输入文件 —— 说明 tsconfig 的 include/exclude 与产出实际落盘位置不一致，是项目契约错配，不是代码写错。'
        : null;
    },
  },
  {
    id: 'A4.other-ts',
    anchors: ['A4'],
    cls: 'code:type-error',
    match: (_a, _f, d) =>
      d.tsCode ? `类型错误 ${d.tsCode}：产出自身的类型问题。` : null,
  },
  {
    id: 'A4.unparsed',
    anchors: ['A4'],
    cls: 'code:type-error',
    match: (_a, f, d) =>
      d.exitCode !== undefined && d.exitCode !== 0 && !d.tsCode
        ? `类型检查以 exit ${d.exitCode} 失败，但输出无法结构化解析（${f.message.slice(0, 80)}…）—— 先按代码问题处理，需人工确认。`
        : null,
  },

  // ── A5：测试 ───────────────────────────────────────────────────
  {
    id: 'A5.no-counts',
    anchors: ['A5'],
    cls: 'code:test-runner-could-not-run',
    match: (_a, _f, d) =>
      d.exitCode !== undefined &&
      d.exitCode !== 0 &&
      (d.passed ?? 0) === 0 &&
      (d.failed ?? 0) === 0
        ? '测试命令非零退出，但一个通过/失败计数都没解析出来 —— 运行器本身没能跑起来（通常是导入或路径问题），不是断言失败。'
        : null,
  },
  {
    id: 'A5.assertions',
    anchors: ['A5'],
    cls: 'code:test-assertion-failure',
    match: (_a, _f, d) =>
      (d.failed ?? 0) > 0
        ? `测试断言失败 ${d.failed} 项 —— 产出与断言不符，是产出自身的问题。`
        : null,
  },

  // ── A6：运行时探针 ─────────────────────────────────────────────
  {
    id: 'A6.exit0',
    anchors: ['A6'],
    cls: 'convention:entry-must-self-start',
    match: (_a, f) =>
      /exit 0/.test(f.message)
        ? '服务进程在就绪前**以 exit 0 正常退出** —— 这是「入口只导出了 startServer/createServer，却没在顶层调用」的典型形态。写法本身合理（工厂函数便于测试），是约定没传达。'
        : null,
  },
  {
    id: 'A6.path-mangling',
    anchors: ['A6'],
    cls: 'environment:command-path-mangling',
    textBased: true,
    match: (_a, _f, d) =>
      /is not recognized as an internal or external command/.test(d.stderr ?? '')
        ? 'stderr 里出现「is not recognized as an internal or external command」—— 带空格的命令路径被拆坏了，是环境/启动方式的问题，不是产出代码的问题。'
        : null,
  },
  {
    id: 'A6.exit-nonzero',
    anchors: ['A6'],
    cls: 'code:entry-crashes',
    match: (_a, f) =>
      /exit [1-9]/.test(f.message) ? '入口进程以非零码崩溃退出，是产出代码的问题。' : null,
  },
  {
    id: 'A6.http-404',
    anchors: ['A6'],
    cls: 'code:http-endpoint-missing',
    match: (_a, f) =>
      /HTTP 探针返回非成功状态/.test(f.message)
        ? '服务起来了，但探针拿到的不是成功状态（如 404）—— 健康端点没实现或路径不符，是产出自身的问题。'
        : null,
  },
  {
    id: 'A6.no-run',
    anchors: ['A6'],
    cls: 'contract:missing-declaration',
    selfReport: true,
    match: () => '项目没有声明可探测的 run 命令与 healthUrl —— 运行时行为根本没有被检查过（未验证 ≠ 通过）。',
  },

  // ── A1：依赖真实性 ─────────────────────────────────────────────
  {
    id: 'A1.offline',
    anchors: ['A1'],
    cls: 'environment:offline-registry',
    selfReport: true,
    match: () => '离线模式：依赖是否真实存在/是否已废弃未能向 registry 核实。',
  },

  // ── A3：模块路径 ───────────────────────────────────────────────
  {
    id: 'A3.invented',
    anchors: ['A3'],
    cls: 'code:invented-module-path',
    match: (_a, _f, d) => `导入了磁盘上不存在的模块路径（${d.specifier ?? '?'}）—— 这是编造的路径。`,
  },

  // ── A7：契约一致性 ─────────────────────────────────────────────
  {
    id: 'A7.duplication',
    anchors: ['A7'],
    cls: 'convention:import-generated-contract-types',
    match: (_a, _f, d) =>
      d.model
        ? `手写了契约里已定义的模型 "${d.model}"，却没有 import 生成的类型文件（${d.generatedTypesPath ?? '?'}）—— 契约漂移的根源。模型不知道本项目会用代码生成契约类型，属于约定没传达。`
        : null,
  },
  {
    id: 'A7.not-yet',
    anchors: ['A7'],
    cls: 'state:not-yet-implemented',
    match: (_a, f) =>
      /未经验证/.test(f.message) || /尚无/.test(f.message)
        ? `尚无对应产出（${f.message.slice(0, 60)}…）—— 未开始不等于失败。`
        : null,
  },

  // ── A8：验证基准 ───────────────────────────────────────────────
  {
    id: 'A8.tampered',
    anchors: ['A8'],
    cls: 'baseline:tampered',
    match: () => '产出改写了验证基准文件（契约声明、测试运行器等）—— 被验证者不得改验证基准。',
  },

  // ── B1：语义验证 ───────────────────────────────────────────────
  {
    id: 'B1.evidence-invalid',
    anchors: ['B1'],
    cls: 'role:invalid-citation',
    match: () => '判定引用的行区间并不包含所声称的内容 —— 证据核验失败，判定作废（幻觉/凑证据）。',
  },
  {
    id: 'B1.uncertain',
    anchors: ['B1'],
    cls: 'verify:cannot-determine',
    match: () => '查过了但确认不了 —— 这是验证环节的能力问题，不是产出的问题。',
  },
  {
    id: 'B1.not-met',
    anchors: ['B1'],
    cls: 'code:requirement-not-met',
    match: () => '需求确实未达成 —— 产出自身的问题。',
  },

  // ── B2：覆盖矩阵 ───────────────────────────────────────────────
  {
    id: 'B2.non-task-deliverable',
    anchors: ['B2'],
    cls: 'convention:engine-published-artifact',
    textBased: true,
    match: (_a, _f, d) =>
      d.deliverable && NON_TASK_DELIVERABLE_KINDS.has(d.deliverable)
        ? `任务图把 ${d.deliverable} 声明成了角色交付物，但它**不是「任务能交付」的东西**：` +
          '它由引擎在特定阶段产出（或干脆是人类输入）。' +
          '这是任务图与引擎机制之间的错配 —— 要么 PM 不该这样声明，要么 B2 不该对它报缺失。' +
          '⚠️ 哪一边该改需要人判断，记忆系统只负责把这一类稳定地浮出来。'
        : null,
  },
  {
    id: 'B2.deliverable-missing',
    anchors: ['B2'],
    cls: 'code:deliverable-missing',
    match: (_a, f, d) =>
      d.deliverable
        ? `任务的交付物 ${d.deliverable} 不存在 —— 被派了活但没交出来。`
        : /交付/.test(f.message)
          ? '任务声明的交付物不存在。'
          : null,
  },
  {
    id: 'B2.untested',
    anchors: ['B2'],
    cls: 'code:test-coverage-gap',
    match: () => '需求没有任何测试用例覆盖 —— 测试环节的工作没做，不是约定问题。',
  },
  {
    id: 'B2.no-task-graph',
    anchors: ['B2'],
    cls: 'state:not-yet-implemented',
    match: () => '尚无任务图，需求无法被拆解 —— 上游还没产出，不是失败。',
  },

  // ── B3：异议证据 ───────────────────────────────────────────────
  {
    id: 'B3.evidence-invalid',
    anchors: ['B3'],
    cls: 'role:invalid-citation',
    match: () => '异议引用的证据核验失败（行区间不含所声称内容）—— 主理人的证据可信度问题。',
  },
];

/**
 * 分类一个锚点发现。
 *
 * 匹配不到任何规则时返回 `unknown` 且 `eligible: false` —— **失败关闭**。
 * 「没见过的形态」绝不能因为看起来像约定问题就被写进记忆。
 */
export function classifyFinding(anchorId: AnchorId, finding: AnchorFinding): Classification {
  const d = asData(finding);
  for (const rule of RULES) {
    if (!rule.anchors.includes(anchorId)) continue;
    const because = rule.match(anchorId, finding, d);
    if (because === null) continue;
    return {
      cls: rule.cls,
      ruleId: rule.id,
      because,
      eligible: MEMORY_ELIGIBLE_CLASSES.has(rule.cls),
      textBased: rule.textBased === true,
      selfReport: rule.selfReport === true,
    };
  }
  return {
    cls: 'unknown',
    ruleId: 'none',
    because: `没有规则匹配 ${anchorId}/${finding.code} —— 保守归为未识别，不进记忆。`,
    eligible: false,
    textBased: false,
    selfReport: false,
  };
}

/**
 * 类 → **确定性**的规范经验文本。
 *
 * 只对「文本不依赖上下文」的类给规范文本；返回 null 的类必须由 LLM 提议（L3），
 * 且只能是 `proposed` 态。这样做的理由：**能机械写出来的经验，就不该让模型写**
 * —— 少一次 LLM 调用，也少一条「模型措辞影响后续所有轮次」的通道。
 */
export function canonicalLessonText(cls: RootCauseClass): string | null {
  switch (cls) {
    case 'convention:explicit-relative-extension':
      return '相对导入必须带显式文件扩展名（如 `./app.ts`）。本项目由 Node 原生类型剥离直接运行，tsconfig 开启了 allowImportingTsExtensions；写成 `./app` 会同时导致 TS2835 编译失败与运行期无法解析。';
    case 'convention:entry-must-self-start':
      return '入口文件**被直接执行时必须自己启动服务**（在顶层调用 listen，或调用自己导出的 start 函数）。只导出 startServer/createServer 而不调用，会让进程立刻 exit 0 退出。测试可以继续用工厂函数。';
    case 'convention:import-generated-contract-types':
      return '契约里已定义的数据模型（Task 等）**不要手写**，必须 import 生成出来的契约类型文件，否则前后端会各自漂移。';
    case 'environment:spawn-restricted':
      return '禁止在测试或应用代码中 spawn 子进程（执行 npm/node 等外部命令）。当前运行环境禁止管道式 stdio，spawn 会直接 EPERM 失败。测试应当直接 import 被测模块并对返回值断言。';
    case 'environment:command-path-mangling':
      return '启动服务不要经由 shell 拼命令（带空格的路径会被拆坏，报「is not recognized as an internal or external command」）。直接以可执行文件 + 参数数组的方式启动。';
    case 'contract:missing-declaration':
      return '在 package.json 的 agentforge 字段里声明 healthUrl（例如 "http://127.0.0.1:8787/health"），否则运行时探针只能报 SKIPPED，服务到底跑不跑得起来不会被检查。';
    default:
      // 其余（含 baseline:tampered / engine-published / typecheck-misconfigured）
      // 的措辞需要结合具体项目上下文，交给 L3 的 LLM 提议，且只能进 proposed 态。
      return null;
  }
}

/** 便捷判定：这个类能不能进记忆。 */
export function isMemoryEligible(cls: RootCauseClass): boolean {
  return MEMORY_ELIGIBLE_CLASSES.has(cls);
}
