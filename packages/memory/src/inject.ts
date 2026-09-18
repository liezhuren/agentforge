/**
 * 经验注入：把 `active` 经验变成角色提示词里的一段话。**这是记忆系统唯一影响产出的出口。**
 *
 * ## 谁能收到经验：只有写代码和写测试的角色
 *
 * 这不是随意的白名单，而是「经验库不进判定路径」那条边界的具体化：
 *
 * | 角色 | 收不收 | 为什么 |
 * |---|---|---|
 * | `frontend` / `backend` | ✅ | 它们在写代码 —— 正是约定该被传达的对象 |
 * | `test` | ✅ | 它在写测试。⚠️ 注意**语义验证器也以 `test` 身份运行**，但它是另一个类（`SemanticVerifier`），那条路径不读经验（由边界测试守） |
 * | `pm` | ❌ | **PM 产出 Requirement / PRD / TaskGraph / Contract —— 也就是判定基准**。让 LLM 写的经验去影响基准文本，等于绕开锚点改判定标准，正是 A8 守的那条线 |
 * | `host` | ❌ | 主理人是**对抗性找茬**的一方。给它看已知的历史经验，会让它盯着旧问题、放过新问题 —— 那是把对抗性审查变成了按清单核对 |
 *
 * ## 经验以什么形式进去
 *
 * 与 `environmentNotes` **走同一个通道**（`renderConventions` 渲染的「项目约定」块），
 * 因为 `docs/HANDOFF.md §8.0-mem` 已经把关系定死了：
 * 「`environmentNotes` 已经是『项目声明的约定，引擎原样注入』——记忆系统应该是它的**自动供给**，
 * 不是另起一套。」
 *
 * 区别只有两点，而且两点都必须保留：
 * 1. **人类声明的**约定在 `package.json` 里，是持久的、人工写的；
 *    **经验**在记忆库里，是机器归纳的、可失效的、可被反证的。
 * 2. 经验注入时会**单独标注来源**（「来自本项目历次真实运行的经验」），
 *    这样报告里能分清「这条是项目方要求的」还是「系统自己总结的」。
 */

import type { RoleId } from '../../core/src/index.ts';
import {
  injectableLessons,
  recordInjection,
  renderLessonPromptBlock,
  type Lesson,
  type InjectableOptions,
} from './lessons.ts';
import type { MemoryDb } from './db.ts';

/**
 * 允许收到经验的角色。理由见文件头那张表。
 * 导出为常量是为了让边界测试能直接断言，而不是去读一段注释。
 */
export const MEMORY_INJECTION_ROLES: readonly RoleId[] = ['frontend', 'backend', 'test'];

export function roleAcceptsMemory(role: RoleId): boolean {
  return MEMORY_INJECTION_ROLES.includes(role);
}

export type MemoryInjection = {
  /** 该角色本次实际收到的条数。 */
  count: number;
  /** 注入进提示词的文本块（空字符串表示没注入）。 */
  block: string;
  /** 被注入的经验 id —— 写进 `lesson_events`，之后才能回答「这条经验有没有用」。 */
  lessonIds: string[];
  /** 因环境指纹变化被降级的（这次没进提示词）。 */
  expired: Lesson[];
  /** 因证据不可用被拒绝的。 */
  rejected: { lessonId: string; reason: string }[];
  /** 逐条出处，供报告展示（模型看不到）。 */
  provenance: { lessonId: string; text: string; evidence: { findingId: string; why: string }[] }[];
};

/**
 * 构造某个角色的记忆注入。
 *
 * `record: true`（默认）会把这次注入写进 `lesson_events` ——
 * **这是「这条经验有没有用」唯一的数据来源**，所以默认必须记。
 * 不记的话，经验会永远停在 `unproven`，也就永远无法证明它该不该留。
 */
export function buildMemoryInjection(
  mem: MemoryDb,
  opts: {
    role: RoleId;
    currentEnvHash: string;
    runId?: string | null;
    /** 取经验时先按类过滤（例如只给 backend 契约类）。省略则给全部可进记忆的类。 */
    classes?: InjectableOptions['classes'];
    limit?: number;
    record?: boolean;
    now?: string;
  },
): MemoryInjection {
  const empty: MemoryInjection = {
    count: 0,
    block: '',
    lessonIds: [],
    expired: [],
    rejected: [],
    provenance: [],
  };

  if (!roleAcceptsMemory(opts.role)) {
    return {
      ...empty,
      rejected: [
        {
          lessonId: '(role)',
          reason:
            `角色 ${opts.role} 不在经验注入白名单内（${MEMORY_INJECTION_ROLES.join('/')}）。` +
            'PM 的产出是判定基准，主理人是对抗审查方 —— 两者收到经验都会改变判定性质，不只是改变产出。',
        },
      ],
    };
  }

  const { lessons, expired, rejected } = injectableLessons(mem, {
    currentEnvHash: opts.currentEnvHash,
    ...(opts.classes ? { classes: opts.classes } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  if (lessons.length === 0) {
    return { ...empty, expired, rejected };
  }

  const block = renderLessonPromptBlock(lessons);
  const lessonIds = lessons.map((l) => l.lessonId);

  if (opts.record !== false) {
    // 同步记录，不 fire-and-forget：注入记录是「这条经验有没有用」的唯一数据来源，
    // 异步写会让「刚注入就被反证统计漏掉」变成一种偶发竞态。
    recordInjection(mem, lessonIds, {
      runId: opts.runId ?? null,
      ...(opts.now ? { at: opts.now } : {}),
      detail: `注入给 ${opts.role}`,
    });
  }

  return {
    count: lessons.length,
    block,
    lessonIds,
    expired,
    rejected,
    provenance: lessons.map((l) => ({ lessonId: l.lessonId, text: l.text, evidence: l.provenance })),
  };
}
