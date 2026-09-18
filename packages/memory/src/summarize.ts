/**
 * L3 的「让 LLM 写经验」这一步。
 *
 * ## 它为什么必须这么薄
 *
 * 这是整个记忆系统里**唯一**让模型产出文字并可能影响后续轮次的地方，
 * 所以它被刻意限制成一个小函数：
 *
 * - 输入是**已经由确定性规则聚好的簇**（哪一类、哪些事实、哪些角色），
 *   模型不参与「该不该总结」「总结哪几条」—— 那些是 `clusterFindings()` 的活。
 * - 输出只有**两个字段**：`lesson`（一句祈使句约定）与 `appliesWhen`（成立条件）。
 * - 产出一律以 `createdBy: llm:<model>` 落成 **`proposed`**，要生效必须过
 *   `promoteLesson()` 的确定性检查。
 *
 * 换句话说：**模型只负责措辞，不负责决策。** 这样即使它写错了，错也停在一个
 * 未生效的候选上，而不会改到任何判定基准。
 *
 * ## 为什么要让模型写，而不是全用确定性文本
 *
 * `canonicalLessonText()` 只覆盖「措辞与上下文无关」的几个类。
 * 其余的类（例如 `baseline:tampered`、`convention:engine-published-artifact`）
 * 得说清「在这个项目里具体该怎么办」，那需要把几条真实证据读成人话 ——
 * 这正是模型擅长而规则表写不动的地方。
 *
 * ## 零依赖
 *
 * `import type` 是**类型**导入，运行时被完全擦除 —— 所以本文件不引入任何运行时依赖，
 * 记忆包的零依赖性质不受影响。
 */

import type { LlmProvider } from '../../llm/src/index.ts';
import type { JsonSchema } from '../../core/src/index.ts';
import { CLASS_LABELS, type RootCauseClass } from './rootcause.ts';
import { proposeLesson, type LessonCluster, type ProposeResult } from './lessons.ts';
import type { MemoryDb } from './db.ts';

/** 经验生成的结构化输出。字段少是故意的 —— 少一个字段就少一条被滥用的通道。 */
export const lessonDraftSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lesson'],
  properties: {
    lesson: { type: 'string', minLength: 10 },
    /** 这条经验在什么条件下成立 —— 约束②要求的「过期条件」在这里被显式问出来。 */
    appliesWhen: { type: 'string' },
    /** 模型自评的把握程度。**只记进 notes 供人看，不参与任何判定。** */
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export type LessonDraft = {
  lesson: string;
  appliesWhen?: string;
  confidence?: string;
};

/**
 * 给模型看的输入。**全部来自真实证据**，没有一条是我们编的背景。
 *
 * 刻意包含「原始失败消息」而不是我们转述的摘要：转述会引入我们自己的理解偏差，
 * 而模型的活是措辞，它需要看到原话。
 */
export type LessonSummaryInput = {
  cls: RootCauseClass | string;
  /** 该簇覆盖的锚点轮次（独立证据数）。 */
  rounds: string[];
  /** 真实失败消息（最多 3 条）。 */
  messages: string[];
  /** 被机械归因到的角色。 */
  roles: string[];
  /** 该类的规范文本（若存在，作为「已确认的说法」提供给模型，要求它不要偏离）。 */
  canonicalText: string | null;
};

export function buildLessonMessages(input: LessonSummaryInput): {
  role: 'system' | 'user';
  content: string;
}[] {
  const label = CLASS_LABELS[input.cls as RootCauseClass] ?? input.cls;
  const sys = [
    '你是一个软件交付流水线的经验记录员。',
    '你的任务：把已经发生的真实失败，写成**一句给后续代码生成角色看的约定**。',
    '',
    '硬性要求：',
    '1. 只写「应当怎么做」，不要复述这次失败的过程，不要评价模型能力。',
    '2. 不要编造未在证据里出现的原因。证据没说的，就不要写。',
    '3. 写成祈使句，一条约定一句话，不要写成段落。',
    '4. 不要提及具体的文件路径、行号、轮次号 —— 那些是这次特有的，不是约定。',
  ].join('\n');

  const user = [
    `失败类别：${input.cls}（${label}）`,
    `独立出现的轮次数：${input.rounds.length}（轮次：${input.rounds.slice(0, 5).join('、')}）`,
    input.roles.length ? `被归因到的角色：${input.roles.join('、')}` : '',
    input.canonicalText ? `\n已确认的规范说法（请以它为准，不要改变含义）：\n${input.canonicalText}` : '',
    '\n真实失败消息（原文）：',
    ...input.messages.map((m) => `- ${m.slice(0, 300)}`),
    '\n请据此写出这条约定，并说明它在什么条件下成立。',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

export function clusterToSummaryInput(cluster: LessonCluster): LessonSummaryInput {
  return {
    cls: cluster.cls,
    rounds: cluster.rounds,
    messages: cluster.messages,
    roles: cluster.roles,
    canonicalText: cluster.canonicalText,
  };
}

export type ProposeFromClusterOptions = {
  provider: LlmProvider;
  envHash: string;
  envParts?: Record<string, string>;
  /** 关掉时只用确定性文本，一次模型调用都不发（省钱的路径）。 */
  useLlm?: boolean;
  model?: string;
};

/**
 * 从一个簇产出经验。
 *
 * 分两条路：
 * - `canonicalText` 存在（类有规范措辞）→ **不发模型调用**，直接落 `proposed`。
 *   省一次调用，也少一条「模型措辞影响后续所有轮次」的通道。
 * - 否则 → 让模型写，仍然是 `proposed`。
 *
 * 无论哪条路，最终都走 `proposeLesson()`，闸门只有一处。
 */
export async function proposeFromCluster(
  mem: MemoryDb,
  cluster: LessonCluster,
  opts: ProposeFromClusterOptions,
): Promise<ProposeResult & { usedLlm: boolean; draft?: LessonDraft }> {
  const wantLlm = opts.useLlm !== false && cluster.canonicalText === null;

  if (!wantLlm) {
    const r = proposeLesson(mem, {
      cls: cluster.cls,
      evidence: cluster.findings,
      createdBy: cluster.canonicalText ? 'canonical:rule-table' : 'canonical:no-text',
      envHash: opts.envHash,
      envParts: opts.envParts,
    });
    return { ...r, usedLlm: false };
  }

  const req: Parameters<LlmProvider['complete']>[0] = {
    // role: 'system' —— 这不是五个角色中任何一个的活，是引擎在总结。
    // 计费上也据此归到 byRole 的 system 桶（见 packages/llm/src/budget.ts）。
    role: 'system',
    purpose: 'memory:lesson',
    messages: buildLessonMessages(clusterToSummaryInput(cluster)),
    schema: lessonDraftSchema,
    schemaName: 'LessonDraft',
    temperature: 0.2,
    ...(opts.model ? { model: opts.model } : {}),
  };

  const res = await opts.provider.complete(req);
  const draft = (res.json ?? safeParse(res.text)) as LessonDraft | null;

  if (!draft || typeof draft.lesson !== 'string' || draft.lesson.trim().length < 10) {
    return {
      ok: false,
      reason:
        `模型没有给出可用的经验文本（json=${res.json === undefined ? 'undefined' : 'present'}，` +
        `text 前 80 字：${res.text.slice(0, 80)}…）。` +
        '经验库不接受空文本 —— 空经验注入提示词等于没注入。',
      usedLlm: true,
    };
  }

  const notes = [
    draft.appliesWhen ? `成立条件：${draft.appliesWhen}` : '',
    draft.confidence ? `模型自评把握：${draft.confidence}（仅供人看，不参与判定）` : '',
  ]
    .filter(Boolean)
    .join('；');

  const r = proposeLesson(mem, {
    cls: cluster.cls,
    evidence: cluster.findings,
    text: draft.lesson.trim(),
    createdBy: `llm:${res.model || opts.model || 'unknown'}`,
    envHash: opts.envHash,
    envParts: opts.envParts,
    ...(notes ? { notes } : {}),
  });

  return { ...r, usedLlm: true, draft };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 端到端的 L3 主流程：聚类 → 逐簇提议 → （可选）自动提升。
 *
 * `promote` 默认 **false**。理由：自动提升是这条链上唯一「让机器自己决定要不要生效」
 * 的动作，而在有真实数据说明它安全之前，默认值必须是「不」。
 * 想开就显式传 `promote: true`，那时提升仍然要过 `promoteLesson()` 的全部检查。
 */
export async function summarizeAndPropose(
  mem: MemoryDb,
  opts: {
    currentEnvHash: string;
    envParts?: Record<string, string>;
    provider?: LlmProvider;
    classes?: string[];
    excludeRunId?: string;
    /** 只处理「独立轮次 >= minSupport」的簇（默认 true）—— 避免把偶发固化成约定。 */
    readyOnly?: boolean;
    promote?: boolean;
    /** 最多处理几个簇（控成本）。 */
    limit?: number;
  },
): Promise<{
  clusters: number;
  proposed: number;
  skipped: number;
  promoted: number;
  usedLlm: number;
  details: { cls: string; result: ProposeResult; usedLlm: boolean }[];
}> {
  // 延迟引入，避免 summarize → lessons → … 的循环 import
  const { clusterFindings, promoteLesson } = await import('./lessons.ts');

  const all = clusterFindings(mem, {
    ...(opts.classes ? { classes: opts.classes } : {}),
    ...(opts.excludeRunId ? { excludeRunId: opts.excludeRunId } : {}),
  });
  const clusters = (opts.readyOnly === false ? all : all.filter((c) => c.readyToPromote)).slice(
    0,
    opts.limit ?? 20,
  );

  const details: { cls: string; result: ProposeResult; usedLlm: boolean }[] = [];
  let proposed = 0;
  let promoted = 0;
  let usedLlm = 0;

  for (const c of clusters) {
    if (!opts.provider && c.canonicalText === null) {
      details.push({
        cls: c.cls,
        result: { ok: false, reason: '该类没有规范文本，且未提供 provider —— 跳过（不猜措辞）' },
        usedLlm: false,
      });
      continue;
    }

    const r = await proposeFromCluster(mem, c, {
      provider: opts.provider as LlmProvider,
      envHash: opts.currentEnvHash,
      ...(opts.envParts ? { envParts: opts.envParts } : {}),
      ...(opts.provider ? {} : { useLlm: false }),
    });
    if (r.usedLlm) usedLlm++;
    if (r.ok) {
      proposed++;
      if (opts.promote) {
        const p = promoteLesson(mem, r.lessonId, { by: 'auto', currentEnvHash: opts.currentEnvHash });
        if (p.ok) promoted++;
      }
    }
    details.push({ cls: c.cls, result: r, usedLlm: r.usedLlm });
  }

  return { clusters: clusters.length, proposed, skipped: clusters.length - proposed, promoted, usedLlm, details };
}
