/**
 * L3：经验库。**这是整个记忆系统里唯一可能违反约束的一层，所以它被刻意做得最保守。**
 *
 * ## 三条硬约束在这里怎么落地
 *
 * ### ① 出处：经验不是「写下来的」，是**从事实里推出来的**
 * `lessons.evidence_json` 存的是支撑它的 `finding_id` 列表。没有证据的经验**不能**被提升为
 * `active`（`promoteLesson()` 会拒绝，且有测试守）。于是「这条经验哪来的」永远有一个
 * 确定性的答案，而不是「模型说过」。
 *
 * ### ② 失效：`env_hash` 每次使用时**重新核验**，而不是只在写入时检查一次
 * `injectableLessons()` 会拿当前环境指纹去比。指纹不同 → 该经验不进提示词，
 * 并被降级为 `stale`。约束原文允许「带过期条件」**或**「每次使用时重新核验」，
 * 这里选了后者 —— 因为前者依赖我们**预见**哪些条件会变，而我们预见不了。
 *
 * ### ③ LLM 不能写规则：状态机是唯一闸门
 * LLM 产出的文字**只能**落在 `proposed`。从 `proposed` 到 `active` 必须经过
 * `promoteLesson()`，而它检查的全是确定性条件（证据出处完整、证据条数达标、类可进记忆、
 * 环境指纹一致）。**LLM 没有 API 可以直接把一条经验置为 `active`** —— 这是接口层面的
 * 保证，不是纪律层面的。
 *
 * ## 最强的那道闸：**经验库不进判定路径**
 *
 * 前面三条都还是「怎么写得对」。但真正不可逾越的边界是这个：
 *
 * > **锚点、机械裁判、Gate、语义验证器，永远不读经验库。**
 *
 * 因为一旦读了，LLM 写的文字就间接参与了「什么东西算通过」——
 * 那正好是 A8 守的那条线（被验证者不得改验证基准）绕了个弯被破掉。
 *
 * 经验能影响的只有一件事：**下一轮生成时，角色被告知了什么。**
 * 它改变的是「产出」，不是「判定产出的标准」。
 *
 * 这条边界写成测试（`memory-boundary.test.ts`），扫 import 图：
 * 判定路径里的任何模块都不许 import 本包。
 * 理由是这个项目的原话 ——「一个『看起来在检查』的清单，如果没被检查，它就只是措辞」（§6.9）。
 */

import { sha256, stableStringify } from '../../core/src/index.ts';
import { CLASS_LABELS, canonicalLessonText, isMemoryEligible, type RootCauseClass } from './rootcause.ts';
import { resolveProvenance } from './provenance.ts';
import type { MemoryDb } from './db.ts';

/** 经验状态。**`proposed` 是 LLM 能到达的最远状态。** */
export type LessonStatus =
  /** 已提出、未生效。LLM 写的经验一律到这里为止。 */
  | 'proposed'
  /** 已生效：可以被注入角色提示词。 */
  | 'active'
  /** 被反证：注入之后同类失败仍然出现。 */
  | 'refuted'
  /** 环境指纹变了 —— 它成立的前提没了，需重新核验。 */
  | 'stale';

export type Lesson = {
  lessonId: string;
  cls: string;
  text: string;
  status: LessonStatus;
  createdBy: string;
  createdAt: string;
  /** 支撑事实（finding_id 列表）。 */
  evidence: string[];
  supporting: number;
  envHash: string;
  injectedCount: number;
  refutedCount: number;
  lastInjectedAt: string | null;
  promotedAt: string | null;
  notes: string | null;
};

/**
 * 生效所需的最少独立证据条数。
 *
 * **2 是刻意选的，而且它的正当性只到「防单例」为止**：一条只出现过一次的失败，
 * 很可能是一次偶发（模型抽风、网络抖动），把它固化成「本项目的约定」是过度概括。
 * 两条独立证据（不同锚点轮次）才说明它有系统性。
 *
 * ⚠️ 这个数字**没有被标定过** —— 和问责账本那几个参数（`BLOCK_QUOTA` 等）一样，
 * 它需要真实数据才能定。现在选 2 只是「比 1 安全、比 3 不至于永远不生效」。
 * 不要假装它是调优出来的。
 */
export const PROMOTE_MIN_SUPPORT = 2;

export type ProposeInput = {
  cls: RootCauseClass | string;
  /** 支撑这条经验的 finding_id。**必须非空**。 */
  evidence: string[];
  /** 经验文本。省略时尝试用确定性文本（`canonicalLessonText`）。 */
  text?: string;
  /** 谁提出的：`canonical:<ruleId>` / `llm:<model>` / `human:<who>`。 */
  createdBy: string;
  envHash: string;
  envParts?: Record<string, string>;
  notes?: string;
};

export type ProposeResult =
  | { ok: true; lessonId: string; status: LessonStatus; reason: string }
  | { ok: false; reason: string };

/**
 * 写入一条经验。**永远只产出 `proposed`**（即使文本是确定性生成的）——
 * 唯一的例外是人类显式要求直接生效，那走 `promoteLesson()` 的 `by: 'human'` 分支。
 *
 * 这里刻意不提供「直接 active」的参数：多一个开关就多一条被误用的路径。
 */
export function proposeLesson(mem: MemoryDb, input: ProposeInput): ProposeResult {
  const cls = input.cls as RootCauseClass;

  if (!isMemoryEligible(cls)) {
    return {
      ok: false,
      reason:
        `根因类 ${cls} 不允许进记忆。只有「约定/环境/契约/基准」类可以 —— ` +
        '代码类失败不能被总结成经验，否则记忆系统会变成生产借口的机器。',
    };
  }
  if (input.evidence.length === 0) {
    return { ok: false, reason: '没有证据：一条经验必须能指出它依据的是哪些事实（finding_id）。' };
  }

  // 证据本身必须存在且出处完整 —— 不能拿一条「出处不完整」的事实当论据。
  const { kept, dropped } = resolveProvenance(mem, input.evidence);
  if (dropped.length > 0) {
    return {
      ok: false,
      reason:
        `${dropped.length} 条证据出处不完整，不能作为论据：` +
        dropped.map((d) => `${d.findingId}（${d.problems.join('、')}）`).join('；'),
    };
  }

  // 证据的根因类必须与经验声明的类一致 —— 防止「拿 A 类的事实论证 B 类的经验」。
  const clsRows = mem.db
    .prepare(
      `SELECT DISTINCT class FROM findings WHERE finding_id IN (${kept.map(() => '?').join(',')})`,
    )
    .all(...kept.map((k) => k.findingId)) as unknown as { class: string }[];
  const clsSet = new Set(clsRows.map((r) => r.class));
  if (clsSet.size !== 1 || !clsSet.has(cls)) {
    return {
      ok: false,
      reason: `证据的根因类（${[...clsSet].join('、')}）与经验声明的类（${cls}）不一致。`,
    };
  }

  const text = input.text ?? canonicalLessonText(cls);
  if (!text) {
    return {
      ok: false,
      reason:
        `类 ${cls} 没有确定性文本，必须提供 text（由 L3 的 LLM 提议）—— ` +
        '本函数不接受空文本，因为空经验注入提示词等于没注入。',
    };
  }

  const lessonId = `L-${sha256(`${cls}|${text}|${input.envHash}`).slice(0, 16)}`;
  const now = new Date().toISOString();

  mem.db
    .prepare(
      `INSERT INTO lessons
       (lesson_id, class, text, status, created_by, created_at, evidence_json, supporting,
        env_hash, env_parts_json, injected_count, refuted_count, last_injected_at, promoted_at, notes)
       VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?)
       ON CONFLICT(lesson_id) DO UPDATE SET
         evidence_json = excluded.evidence_json,
         supporting    = excluded.supporting,
         notes         = excluded.notes`,
    )
    .run(
      lessonId,
      cls,
      text,
      input.createdBy,
      now,
      JSON.stringify(kept.map((k) => k.findingId)),
      kept.length,
      input.envHash,
      JSON.stringify(input.envParts ?? {}),
      input.notes ?? null,
    );

  mem.db
    .prepare(`INSERT INTO lesson_events (event_id, lesson_id, kind, run_id, at, detail) VALUES (?, ?, ?, NULL, ?, ?)`)
    .run(`E-${sha256(`${lessonId}|created|${now}`).slice(0, 20)}`, lessonId, 'created', now,
      `由 ${input.createdBy} 提出，证据 ${kept.length} 条`);

  return { ok: true, lessonId, status: 'proposed', reason: `已提出（proposed），证据 ${kept.length} 条` };
}

export type PromoteOptions = {
  /** 谁在提升：`human:<who>` 可以绕过证据条数要求，`auto` 不能。 */
  by: 'auto' | `human:${string}`;
  currentEnvHash: string;
  now?: string;
};

export type PromoteResult = { ok: true; reason: string } | { ok: false; reason: string };

/**
 * 把 `proposed` 提升为 `active`。
 *
 * 全部检查都是**确定性**的，没有一条依赖模型的判断：
 * 1. 类必须可进记忆
 * 2. 证据必须存在且出处完整（重新核验一遍 —— 证据可能已被删或环境已变）
 * 3. 环境指纹必须与当前一致
 * 4. 证据条数必须达标（**人类可以豁免这一条**，机器不行）
 */
export function promoteLesson(mem: MemoryDb, lessonId: string, opts: PromoteOptions): PromoteResult {
  const lesson = getLesson(mem, lessonId);
  if (!lesson) return { ok: false, reason: `找不到经验 ${lessonId}` };
  if (lesson.status === 'active') return { ok: true, reason: '已经是 active，无需重复提升' };
  if (lesson.status === 'refuted') {
    return {
      ok: false,
      reason: '这条经验已被反证。要重新启用必须先补证据并走人工确认 —— 不能自动复活一条被反证过的经验。',
    };
  }

  if (!isMemoryEligible(lesson.cls as RootCauseClass)) {
    return { ok: false, reason: `根因类 ${lesson.cls} 不允许生效。` };
  }

  if (lesson.envHash !== opts.currentEnvHash) {
    return {
      ok: false,
      reason:
        '环境指纹不一致 —— 这条经验成立的前提可能已经变了。' +
        '请先核验它在当前环境下是否仍然成立，再用人工提升。',
    };
  }

  const { kept, dropped } = resolveProvenance(mem, lesson.evidence);
  if (kept.length !== lesson.evidence.length || dropped.length > 0) {
    markStale(mem, lessonId, `提升时复核证据发现 ${dropped.length} 条出处不完整`, opts.now);
    return {
      ok: false,
      reason: `证据复核失败：${dropped.length} 条出处不完整（${dropped
        .map((d) => d.findingId)
        .join('、')}）。`,
    };
  }

  const isHuman = opts.by.startsWith('human:');
  if (!isHuman && kept.length < PROMOTE_MIN_SUPPORT) {
    return {
      ok: false,
      reason:
        `证据只有 ${kept.length} 条，少于自动生效所需的 ${PROMOTE_MIN_SUPPORT} 条。` +
        '单次出现的失败可能是偶发，不该被固化成约定（人类确认可以豁免这一条）。',
    };
  }

  // 自述型证据的「条数」是假的：它们随工作区个数增长，不表达「反复发生」。
  // 所以机器不许据此自动提升（人类可以 —— 那时是人类做了判断）。
  if (!isHuman) {
    const sr = (
      mem.db
        .prepare(
          `SELECT COUNT(*) AS n FROM findings
           WHERE finding_id IN (${kept.map(() => '?').join(',')}) AND self_report = 1`,
        )
        .get(...kept.map((k) => k.findingId)) as { n: number }
    ).n;
    if (sr === kept.length) {
      return {
        ok: false,
        reason:
          `全部 ${kept.length} 条证据都是「引擎自述模式」型发现 —— 这个数量等于工作区个数，` +
          '不表达「同一问题反复发生」。机器不得据此自动生效，需人类显式提升。',
      };
    }
  }

  const now = opts.now ?? new Date().toISOString();
  const exempted = isHuman && kept.length < PROMOTE_MIN_SUPPORT;
  // 证据位置以复核结果为准重写一遍 —— 「提升时用的证据」和「当时声称的证据」必须一致。
  mem.db
    .prepare(
      `UPDATE lessons SET status='active', promoted_at=?, evidence_json=?, supporting=? WHERE lesson_id=?`,
    )
    .run(now, JSON.stringify(kept.map((k) => k.findingId)), kept.length, lessonId);
  mem.db
    .prepare(`INSERT INTO lesson_events (event_id, lesson_id, kind, run_id, at, detail) VALUES (?, ?, ?, NULL, ?, ?)`)
    .run(`E-${sha256(`${lessonId}|promoted|${now}`).slice(0, 20)}`, lessonId, 'promoted', now,
      `由 ${opts.by} 提升，证据 ${kept.length} 条${exempted ? '（人类豁免条数要求）' : ''}`);

  // 返回语里也要带上「为什么它能生效」：调用方不该为了知道这件事再去查库。
  return {
    ok: true,
    reason:
      `已生效，证据 ${kept.length} 条` +
      (exempted ? `（人类豁免了「至少 ${PROMOTE_MIN_SUPPORT} 条」的自动门槛）` : ''),
  };
}

/** 降级为 stale（环境变了 / 复核失败）。**不是删除** —— 经验本身没被否定，是前提变了。 */
export function markStale(mem: MemoryDb, lessonId: string, why: string, now?: string): void {
  const at = now ?? new Date().toISOString();
  mem.db.prepare(`UPDATE lessons SET status='stale', notes=? WHERE lesson_id=? AND status <> 'refuted'`).run(why, lessonId);
  mem.db
    .prepare(`INSERT INTO lesson_events (event_id, lesson_id, kind, run_id, at, detail) VALUES (?, ?, ?, NULL, ?, ?)`)
    .run(`E-${sha256(`${lessonId}|staled|${at}`).slice(0, 20)}`, lessonId, 'staled', at, why);
}

/**
 * 把环境指纹不一致的经验批量降级为 `stale`。返回被降级的清单。
 *
 * 应当在**每次使用经验之前**调用（而不是定期）—— 这样「失效」是使用时的性质，
 * 而不是一个需要有人记得去跑的定时任务。
 */
export function expireStaleLessons(mem: MemoryDb, currentEnvHash: string, now?: string): Lesson[] {
  const rows = mem.db
    .prepare(`SELECT lesson_id, env_hash FROM lessons WHERE status = 'active' AND env_hash <> ?`)
    .all(currentEnvHash) as unknown as { lesson_id: string; env_hash: string }[];
  const out: Lesson[] = [];
  for (const r of rows) {
    markStale(
      mem,
      r.lesson_id,
      `环境指纹已变（经验记录的是 ${r.env_hash.slice(0, 12)}…，当前是 ${currentEnvHash.slice(0, 12)}…）`,
      now,
    );
    const l = getLesson(mem, r.lesson_id);
    if (l) out.push(l);
  }
  return out;
}

export type InjectableOptions = {
  currentEnvHash: string;
  /** 只要这些类；省略则全部可进记忆的类。 */
  classes?: (RootCauseClass | string)[];
  /** 单次最多注入几条（防止提示词被经验淹没）。 */
  limit?: number;
  now?: string;
};

/**
 * 取出**可以注入提示词**的经验。
 *
 * 这是唯一的注入入口，它做三件事（顺序有意义）：
 * 1. 把环境指纹不符的 active 经验降级为 stale（**使用时重新核验**）
 * 2. 只取 `status='active'` 且类可进记忆的
 * 3. **逐条复核出处**：证据仍然存在的才返回 —— 证据被删/被改的经验不允许继续生效
 *
 * 返回的每条都带完整出处（`evidence` + 逐条 provenance），
 * 因为「注入提示词」这件事本身就必须可审计：事后要能回答「这一轮它到底被告知了什么」。
 */
export function injectableLessons(
  mem: MemoryDb,
  opts: InjectableOptions,
): { lessons: (Lesson & { provenance: { findingId: string; why: string }[] })[]; expired: Lesson[]; rejected: { lessonId: string; reason: string }[] } {
  const expired = expireStaleLessons(mem, opts.currentEnvHash, opts.now);
  const limit = opts.limit ?? 6;

  const where = [`status = 'active'`, 'env_hash = ?'];
  const params: string[] = [opts.currentEnvHash];
  if (opts.classes && opts.classes.length > 0) {
    where.push(`class IN (${opts.classes.map(() => '?').join(',')})`);
    params.push(...opts.classes.map(String));
  }

  const rows = mem.db
    .prepare(
      `SELECT ${LESSON_COLUMNS} FROM lessons WHERE ${where.join(' AND ')}
       ORDER BY supporting DESC, created_at ASC`,
    )
    .all(...params) as unknown as LessonRow[];

  const lessons: (Lesson & { provenance: { findingId: string; why: string }[] })[] = [];
  const rejected: { lessonId: string; reason: string }[] = [];

  for (const row of rows) {
    if (lessons.length >= limit) break;
    const lesson = rowToLesson(row);
    if (!isMemoryEligible(lesson.cls as RootCauseClass)) {
      rejected.push({ lessonId: lesson.lessonId, reason: `类 ${lesson.cls} 不允许进提示词` });
      continue;
    }
    const { kept, dropped } = resolveProvenance(mem, lesson.evidence);
    if (dropped.length > 0 || kept.length === 0) {
      // 证据没了 → 这条经验不能再生效。降级而不是静默跳过：
      // 「静默无效比明确拒绝更糟」（§6.11）。
      markStale(
        mem,
        lesson.lessonId,
        `注入前复核发现证据不可用：${dropped.map((d) => d.findingId).join('、') || '（已无证据）'}`,
        opts.now,
      );
      rejected.push({ lessonId: lesson.lessonId, reason: '证据已不可用，已降级为 stale' });
      continue;
    }
    lessons.push({
      ...lesson,
      provenance: kept.map((k) => ({
        findingId: k.findingId,
        why: `${k.provenance.anchor}/${k.provenance.code} · ${k.provenance.anchorRound} · ${k.provenance.at}`,
      })),
    });
  }

  return { lessons, expired, rejected };
}

/** 记录一次注入（用于事后回答「这条经验有没有用」）。 */
export function recordInjection(
  mem: MemoryDb,
  lessonIds: string[],
  opts: { runId: string | null; at?: string; detail?: string },
): void {
  const at = opts.at ?? new Date().toISOString();
  for (const lessonId of lessonIds) {
    mem.db
      .prepare(
        `UPDATE lessons SET injected_count = injected_count + 1, last_injected_at = ? WHERE lesson_id = ?`,
      )
      .run(at, lessonId);
    mem.db
      .prepare(`INSERT INTO lesson_events (event_id, lesson_id, kind, run_id, at, detail) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        `E-${sha256(`${lessonId}|injected|${at}|${opts.runId ?? ''}`).slice(0, 20)}`,
        lessonId,
        'injected',
        opts.runId,
        at,
        opts.detail ?? null,
      );
  }
}

/** 经验有效性的判定结果。**名字刻意保守** —— 见 `efficacyOf` 的说明。 */
export type LessonEfficacy = {
  lessonId: string;
  injectedCount: number;
  /** 注入之后、同类失败仍然出现的次数。 */
  refutedCount: number;
  /** 注入之后「有机会复现」的锚点轮次数（暴露次数）。 */
  exposures: number;
  verdict: 'unproven' | 'no-counter-evidence' | 'counter-evidence';
  explanation: string;
};

/**
 * 评估一条经验「有没有用」。
 *
 * ## 为什么结论不叫「有效」而叫「无反证」
 *
 * 因为**观测到「同类失败没再出现」不等于经验起了作用**。它没再出现的原因可能是
 * 那一轮换了个模型、需求变简单了、或者只是运气 —— 这个项目没有做对照实验。
 * 所以能诚实说的只有：「注入之后，我们有 N 次机会看到它复发，一次都没看到」。
 * 把它叫「有效」就是 §6.15 那个错误（「模型说得更肯定了」当成成果）的同类。
 *
 * ## 反证怎么算（必须窄）
 *
 * 只有同时满足才计一次反证：
 * 1. 该经验**被执行过注入**（`lesson_events` 里有 injected 记录）
 * 2. 出现了一条同类 finding，且它的时间**严格晚于**那次注入
 *    （早于注入的失败不可能是「注入之后又犯了」）
 *
 * 第 2 条的时间条件不是形式主义：没有它，把一条经验注入之后，
 * 历史上所有同类失败都会被算成它的反证 —— 它会**一开始就自我否决**。
 */
export function efficacyOf(mem: MemoryDb, lessonId: string): LessonEfficacy | null {
  const lesson = getLesson(mem, lessonId);
  if (!lesson) return null;

  const firstInjection = mem.db
    .prepare(
      `SELECT MIN(at) AS at FROM lesson_events WHERE lesson_id = ? AND kind = 'injected'`,
    )
    .get(lessonId) as { at: string | null };

  if (!firstInjection.at) {
    return {
      lessonId,
      injectedCount: 0,
      refutedCount: 0,
      exposures: 0,
      verdict: 'unproven',
      explanation: '从未被注入过，因此没有任何关于它是否有效的观测。',
    };
  }

  const refutations = (
    mem.db
      .prepare(`SELECT COUNT(*) AS n FROM findings WHERE class = ? AND at > ?`)
      .get(lesson.cls, firstInjection.at) as { n: number }
  ).n;

  // 暴露次数：注入之后结束的锚点轮次（同一工作区、同类根因域的「有机会复发」次数）
  const exposures = (
    mem.db
      .prepare(
        `SELECT COUNT(DISTINCT anchor_round) AS n FROM findings WHERE at > ?`,
      )
      .get(firstInjection.at) as { n: number }
  ).n;

  let verdict: LessonEfficacy['verdict'];
  let explanation: string;
  if (refutations > 0) {
    verdict = 'counter-evidence';
    explanation =
      `注入之后仍出现 ${refutations} 次同类失败（暴露 ${exposures} 轮）—— 反证：` +
      '要么这条经验没被遵守，要么它解决的不是真正的根因。需要重新看证据。';
  } else if (exposures > 0) {
    verdict = 'no-counter-evidence';
    explanation =
      `注入之后有 ${exposures} 轮观测，没有再现同类失败。` +
      '⚠️ 这**不等于它有效** —— 没有对照实验，只能说明「尚无反证」。';
  } else {
    verdict = 'unproven';
    explanation = '注入之后还没有任何后续轮次，无法判断。';
  }

  return { lessonId, injectedCount: lesson.injectedCount, refutedCount: refutations, exposures, verdict, explanation };
}

/**
 * 扫描并记录反证：把「注入后又犯」计进 `refutedCount`，达到阈值则降级为 `refuted`。
 *
 * 返回本次新发现的反证。`threshold` 默认为 2 —— 同样**没有标定过**，
 * 理由与 `PROMOTE_MIN_SUPPORT` 一样：单次复发可能是别的因素，两次才够说明问题。
 */
export function recordRefutations(
  mem: MemoryDb,
  opts: { threshold?: number; now?: string } = {},
): { lessonId: string; refutations: number; demoted: boolean }[] {
  const threshold = opts.threshold ?? 2;
  const now = opts.now ?? new Date().toISOString();
  const active = mem.db
    .prepare(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE status = 'active'`)
    .all() as unknown as LessonRow[];

  const out: { lessonId: string; refutations: number; demoted: boolean }[] = [];
  for (const row of active) {
    const lesson = rowToLesson(row);
    const eff = efficacyOf(mem, lesson.lessonId);
    if (!eff || eff.refutedCount === 0) continue;

    if (eff.refutedCount !== lesson.refutedCount) {
      mem.db
        .prepare(`UPDATE lessons SET refuted_count = ? WHERE lesson_id = ?`)
        .run(eff.refutedCount, lesson.lessonId);
      mem.db
        .prepare(`INSERT INTO lesson_events (event_id, lesson_id, kind, run_id, at, detail) VALUES (?, ?, ?, NULL, ?, ?)`)
        .run(
          `E-${sha256(`${lesson.lessonId}|refuted|${eff.refutedCount}|${now}`).slice(0, 20)}`,
          lesson.lessonId,
          'refuted',
          now,
          `注入后同类失败 ${eff.refutedCount} 次`,
        );
    }

    const demoted = eff.refutedCount >= threshold;
    if (demoted) {
      mem.db
        .prepare(
          `UPDATE lessons SET status='refuted', notes=? WHERE lesson_id=?`,
        )
        .run(`注入之后同类失败 ${eff.refutedCount} 次（阈值 ${threshold}）—— 已停用`, lesson.lessonId);
    }
    out.push({ lessonId: lesson.lessonId, refutations: eff.refutedCount, demoted });
  }
  return out;
}

export function getLesson(mem: MemoryDb, lessonId: string): Lesson | null {
  const row = mem.db
    .prepare(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE lesson_id = ?`)
    .get(lessonId) as unknown as LessonRow | undefined;
  return row ? rowToLesson(row) : null;
}

export function listLessons(
  mem: MemoryDb,
  filter: { status?: LessonStatus; cls?: string } = {},
): Lesson[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.cls) {
    where.push('class = ?');
    params.push(filter.cls);
  }
  const rows = mem.db
    .prepare(
      `SELECT ${LESSON_COLUMNS} FROM lessons ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC`,
    )
    .all(...params) as unknown as LessonRow[];
  return rows.map(rowToLesson);
}

/**
 * 把可注入的经验渲染成**提示词片段**。
 *
 * 形态上刻意与 `renderRetrievalReport()` 不同：这里是给模型读的（简短、祈使句），
 * 那里是给人读的（带出处）。两者不共用渲染函数，免得有人顺手把报告塞进提示词。
 *
 * **出处不在这里展示**（模型不需要看它），但调用方必须用 `recordInjection()` 记下注入，
 * 使得「这一轮被告知了什么」事后可查。
 */
export function renderLessonPromptBlock(
  lessons: (Lesson & { provenance: { findingId: string; why: string }[] })[],
): string {
  if (lessons.length === 0) return '';
  const lines = lessons.map((l) => `- ${l.text}`);
  return [
    '【本项目以往真实运行中总结出的经验（来自实际失败，不是通用建议）】',
    ...lines,
    '（这些经验来自本项目的历次真实运行，可能不适用于其它项目。）',
  ].join('\n');
}

/** 类 → 中文标签（报告用）。 */
export function labelOf(cls: string): string {
  return CLASS_LABELS[cls as RootCauseClass] ?? cls;
}

/** 指纹分组：把一组 finding 按 (类, 签名) 聚成「候选经验簇」。 */
export type LessonCluster = {
  cls: string;
  signature: string;
  findings: string[];
  /** 覆盖到的锚点轮次（用于判断「是不是同一次失败的重复」）。 */
  rounds: string[];
  roles: string[];
  messages: string[];
  canonicalText: string | null;
  /** 是否够条件自动生效。 */
  readyToPromote: boolean;
  /**
   * 这一簇**全部**由「引擎自述模式」型发现构成（见 `rootcause.ts` 的 `selfReport`）。
   *
   * 自述型簇永远不够条件自动生效：它的「独立轮次」等于工作区个数，
   * 不表达「同一个问题反复发生」。可选人提升 —— 但那时是人做了判断，不是系统替他判断。
   */
  selfReport: boolean;
  /** 不够条件自动生效时的原因（报告里直接打出来，别让人猜）。 */
  notReadyReason: string | null;
};

/**
 * 从库里聚合出「候选经验簇」。
 *
 * **这是确定性的**：分组键是 `(class, signature)`，两者都由机械规则得出。
 * 于是「该总结哪几条经验」不需要模型来判断 —— 模型只在 `canonicalText` 为 null 时
 * 负责**措辞**，而且写出来的东西只能是 `proposed`。
 */
export function clusterFindings(
  mem: MemoryDb,
  opts: { classes?: string[]; excludeRunId?: string; minSupport?: number } = {},
): LessonCluster[] {
  const where: string[] = ['f.eligible = 1'];
  const params: string[] = [];
  if (opts.classes?.length) {
    where.push(`f.class IN (${opts.classes.map(() => '?').join(',')})`);
    params.push(...opts.classes);
  }
  if (opts.excludeRunId) {
    where.push('(f.run_id IS NULL OR f.run_id <> ?)');
    params.push(opts.excludeRunId);
  }

  const rows = mem.db
    .prepare(
      `SELECT f.finding_id, f.class, f.signature, f.anchor_round, f.target_role, f.message, f.self_report
       FROM findings f WHERE ${where.join(' AND ')} ORDER BY f.at ASC`,
    )
    .all(...params) as unknown as {
    finding_id: string;
    class: string;
    signature: string;
    anchor_round: string;
    target_role: string | null;
    message: string;
    self_report: number;
  }[];

  const byKey = new Map<string, LessonCluster>();
  const selfReportTally = new Map<string, { yes: number; no: number }>();
  for (const r of rows) {
    const key = `${r.class}||${r.signature}`;
    let c = byKey.get(key);
    if (!c) {
      c = {
        cls: r.class,
        signature: r.signature,
        findings: [],
        rounds: [],
        roles: [],
        messages: [],
        canonicalText: canonicalLessonText(r.class as RootCauseClass),
        readyToPromote: false,
        selfReport: false,
        notReadyReason: null,
      };
      byKey.set(key, c);
      selfReportTally.set(key, { yes: 0, no: 0 });
    }
    c.findings.push(r.finding_id);
    if (!c.rounds.includes(r.anchor_round)) c.rounds.push(r.anchor_round);
    if (r.target_role && !c.roles.includes(r.target_role)) c.roles.push(r.target_role);
    if (c.messages.length < 3) c.messages.push(r.message);
    const t = selfReportTally.get(key)!;
    if (r.self_report) t.yes++;
    else t.no++;
  }

  const minSupport = opts.minSupport ?? PROMOTE_MIN_SUPPORT;
  for (const [key, c] of byKey) {
    const t = selfReportTally.get(key)!;
    c.selfReport = t.no === 0;

    // 「够条件」按**独立轮次**算，不是按条数：同一轮里同一个错误的 7 条编译错误
    // 只是一个现象，不是 7 条独立证据。
    if (c.selfReport) {
      c.readyToPromote = false;
      c.notReadyReason =
        `这一簇全部是「引擎自述模式」型发现（${t.yes} 条）—— 它的独立轮次数等于工作区个数，` +
        '不表达「同一问题反复发生」。要生效必须由人显式提升。';
    } else if (c.rounds.length < minSupport) {
      c.readyToPromote = false;
      c.notReadyReason = `独立轮次只有 ${c.rounds.length}，少于自动生效所需的 ${minSupport}`;
    } else {
      c.readyToPromote = true;
    }
  }

  return [...byKey.values()].sort((a, b) => b.rounds.length - a.rounds.length);
}

/** 内部：stableStringify 在本文件里用于 notes 的稳定化（避免无意义 diff）。 */
export function stableNotes(notes: Record<string, unknown>): string {
  return stableStringify(notes);
}

const LESSON_COLUMNS = `lesson_id, class, text, status, created_by, created_at, evidence_json,
  supporting, env_hash, injected_count, refuted_count, last_injected_at, promoted_at, notes`;

type LessonRow = {
  lesson_id: string;
  class: string;
  text: string;
  status: string;
  created_by: string;
  created_at: string;
  evidence_json: string;
  supporting: number;
  env_hash: string;
  injected_count: number;
  refuted_count: number;
  last_injected_at: string | null;
  promoted_at: string | null;
  notes: string | null;
};

function rowToLesson(row: LessonRow): Lesson {
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(row.evidence_json) as unknown;
    if (Array.isArray(parsed)) evidence = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    evidence = [];
  }
  return {
    lessonId: row.lesson_id,
    cls: row.class,
    text: row.text,
    status: row.status as LessonStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
    evidence,
    supporting: row.supporting,
    envHash: row.env_hash,
    injectedCount: row.injected_count,
    refutedCount: row.refuted_count,
    lastInjectedAt: row.last_injected_at,
    promotedAt: row.promoted_at,
    notes: row.notes,
  };
}
