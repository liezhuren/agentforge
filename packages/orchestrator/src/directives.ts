/**
 * 真人建议书 → 机械可校验的约束。
 *
 * ── 为什么需要这个模块 ──
 *
 * 项目的设计里写着「`constraint` 类建议书由 A1 锚点在 Gate 中强制校验」，
 * 但实现里那段代码是空的（只有一句 `void allow;`）——
 * 也就是说**文档承诺了一个不生效的功能**。
 * 这比「没实现」更糟：使用者会以为自己设下的约束正在被强制执行。
 *
 * ── 关键设计：能不能被机械校验，必须对用户可见 ──
 *
 * 真人写下的约束天然分成两类：
 *
 *   ✅ 可机械校验：「不得引入 lodash」「只允许 leftpad-real」
 *      → 编译成 deny/allow 列表，由 A1 锚点强制校验，违反即 FAIL 并派工单
 *
 *   ⚠️ 只能作为指令：「代码风格要简洁」「错误处理要友好」
 *      → 无法机械校验。它们仍会作为上下文传给角色，也仍记进决策日志，
 *        但**不会**被当作已生效的强制约束。
 *
 * 把第二类伪装成第一类是危险的：用户会以为约束正在被执行。
 * 所以编译器明确返回 `advisory` 列表并给出原因，控制台把它单独展示。
 *
 * ── 一个刻意的保守选择 ──
 *
 * 只有**明确写出来**的模式才被编译（「不得引入 X」「只允许 X」等）。
 * 不去做「语义猜测」——例如「不要用重型依赖」这种话，
 * 机器无法判断哪个包算「重型」。猜错方向的代价是：
 * 要么误 ban 一个必要的包，要么给用户虚假的安全感。
 */

import type { ArtifactId, DirectiveRecord, ProjectProfile } from '../../core/src/types.ts';

export type CompiledConstraint = {
  directiveId: ArtifactId;
  /** 原始约束文本（人类可读，便于追溯是哪句话产生了这条规则）。 */
  raw: string;
  kind: 'allow-dependencies' | 'deny-dependencies';
  values: string[];
};

export type AdvisoryConstraint = {
  directiveId: ArtifactId;
  raw: string;
  /** 为什么它无法被机械校验 —— 必须说清楚，否则用户会以为它生效了。 */
  reason: string;
};

export type CompiledDirectives = {
  constraints: CompiledConstraint[];
  advisory: AdvisoryConstraint[];
};

/** 包名（含 scoped）。 */
const PKG = '@?[A-Za-z0-9][A-Za-z0-9._/-]*';
/** 包名列表：「lodash、axios」/「lodash, axios」/「lodash / axios」。 */
const PKG_LIST = `${PKG}(?:\\s*[、,，/]\\s*${PKG})*`;

/**
 * 可编译的约束模式。
 * 每条模式对应一种**明确**的自然语言写法；匹配不到就进 advisory。
 *
 * 注意列表形式（`PKG_LIST`）是必须的：「不得引入 lodash、axios」是很自然的写法，
 * 只捕获单个包名会让第二条约束被**静默忽略** ——
 * 用户以为禁止了两个包，实际只禁止了一个。
 */
const DENY_PATTERNS: RegExp[] = [
  new RegExp(`(?:不得|禁止|不许|不能|不要|严禁)\\s*(?:引入|使用|依赖|安装|添加)\\s*(${PKG_LIST})`, 'g'),
  new RegExp(`(${PKG_LIST})\\s*(?:不得|禁止|不许|不能)\\s*(?:被)?(?:引入|使用|依赖)`, 'g'),
];

const ALLOW_PATTERNS: RegExp[] = [
  new RegExp(`(?:只允许|仅允许|只能使用|白名单)\\s*[:：]?\\s*(${PKG_LIST})`, 'g'),
];

function collect(text: string, patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      for (const raw of m[1].split(/[、,，/\s]+/)) {
        const name = raw.trim().replace(/[.。；;]+$/, '');
        // 过滤掉明显不是包名的碎片（例如「的」「它」这类中文残片）
        if (name.length > 0 && /^@?[A-Za-z0-9]/.test(name)) out.push(name);
      }
    }
  }
  return [...new Set(out)];
}

export function compileDirectives(directives: DirectiveRecord[]): CompiledDirectives {
  const constraints: CompiledConstraint[] = [];
  const advisory: AdvisoryConstraint[] = [];
  /**
   * 去重键：`建议书 | 规则类型 | 包集合`。
   *
   * 为什么需要：一条建议书有两个文本来源（结构化字段 `constraints[]` 与自由文本 `text`），
   * 而用户通常会把同一句话同时填进两处（UI 上就是这么引导的）。
   * 不去重的话，同一条约束会被编译两遍，界面上出现两条一模一样的规则 ——
   * 不是错误，但会让人怀疑「是不是重复生效了」。
   */
  const seen = new Set<string>();

  const add = (c: CompiledConstraint): void => {
    const key = `${c.directiveId}|${c.kind}|${[...c.values].sort().join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    constraints.push(c);
  };

  for (const d of directives) {
    if (d.kind !== 'constraint') continue;

    // 约束文本有两个来源：结构化字段 constraints[]，以及自由文本 text
    const texts = [...(d.constraints ?? []), d.text].filter((t) => typeof t === 'string' && t.length > 0);

    let compiledAny = false;
    const advisorySeen = new Set<string>();
    for (const raw of texts) {
      const deny = collect(raw, DENY_PATTERNS);
      if (deny.length > 0) {
        add({ directiveId: d.id, raw, kind: 'deny-dependencies', values: deny });
        compiledAny = true;
      }
      const allow = collect(raw, ALLOW_PATTERNS);
      if (allow.length > 0) {
        add({ directiveId: d.id, raw, kind: 'allow-dependencies', values: allow });
        compiledAny = true;
      }
      if (deny.length === 0 && allow.length === 0) {
        // 同一段文本在 constraints[] 与 text 里各出现一次时不重复报 advisory
        if (advisorySeen.has(raw)) continue;
        advisorySeen.add(raw);
        advisory.push({
          directiveId: d.id,
          raw,
          reason:
            '无法编译成机械校验规则：只识别「不得引入 X」「只允许 X」这类明确写法。' +
            '它仍会作为上下文传给角色并记入决策日志，但**不会**被强制校验。',
        });
      }
    }
    if (!compiledAny && texts.length === 0) {
      advisory.push({ directiveId: d.id, raw: '(空)', reason: '约束内容为空' });
    }
  }

  return { constraints, advisory };
}

/**
 * 把编译结果落到 ProjectProfile 上。
 *
 * 注意 allow 的语义是**封闭集合**：一旦有任何「只允许 X」的约束，
 * 未列出的依赖一律违规。多条「只允许」会取并集。
 */
export function applyDirectivesToProfile(
  profile: ProjectProfile,
  compiled: CompiledDirectives,
): ProjectProfile {
  const allow = compiled.constraints.filter((c) => c.kind === 'allow-dependencies').flatMap((c) => c.values);
  const deny = compiled.constraints.filter((c) => c.kind === 'deny-dependencies').flatMap((c) => c.values);

  return {
    ...profile,
    dependencyAllowlist: allow.length > 0 ? [...new Set([...(profile.dependencyAllowlist ?? []), ...allow])] : profile.dependencyAllowlist,
    deniedDependencies: deny.length > 0 ? [...new Set([...(profile.deniedDependencies ?? []), ...deny])] : (profile.deniedDependencies ?? null),
  };
}

/** 供 UI 与报告展示：这次 run 里哪些约束真的生效了。 */
export type DirectiveEnforcementReport = {
  enforced: Array<{ directiveId: ArtifactId; raw: string; rule: string; values: string[] }>;
  advisory: AdvisoryConstraint[];
};

export function describeEnforcement(compiled: CompiledDirectives): DirectiveEnforcementReport {
  return {
    enforced: compiled.constraints.map((c) => ({
      directiveId: c.directiveId,
      raw: c.raw,
      rule: c.kind === 'allow-dependencies' ? '依赖白名单（封闭集合）' : '依赖黑名单（排除集合）',
      values: c.values,
    })),
    advisory: compiled.advisory,
  };
}
