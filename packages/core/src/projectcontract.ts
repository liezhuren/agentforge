/**
 * 项目契约：**验证基准**，以及「产出不许改它」这条规则的落点。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 *
 * 第 12 轮真实 LLM 运行（docs/HANDOFF.md §8.1）里，后端角色交出的 CodeModule
 * 直接附了一份自己写的 `package.json`，把项目预置的契约整个替换掉了：
 *
 *   - 删掉 `agentforge.healthUrl`        → A6（真起服务、真发 HTTP）静默变成 SKIPPED
 *   - 删掉 `agentforge.environmentNotes` → 「不许 spawn / 导入要带 .ts」两条约束从提示词里消失
 *   - `scripts.test` 从 `node run-tests.mjs` 换成 `node --experimental-strip-types --test`
 *   - `scripts.start` 指向了另一个文件
 *   - `tsconfig.json` 加了 `exclude: ["test", "**\/*.test.ts"]` → 测试被排除出类型检查
 *
 * 这些都不是「代码写错了」，而是**产出改掉了测量工具本身**。
 * 后果比一般的失败更糟：锚点如实报出 SKIPPED / 弱化，
 * 而它看起来像「环境问题」或「模型能力不足」——**真实原因是被验证者修改了验证基准**。
 * 这直接掏空全项目最核心的那条不变量：
 *
 *   > 每一个 PASS 都必须能追溯到一个不依赖 LLM 的事实。
 *
 * 如果那份事实的**取证方式**可以被被验证者改写，这条不变量就只是措辞。
 *
 * ── 规则 ────────────────────────────────────────────────────────
 *
 * 只有一条，而且是硬的：
 *
 *   > 产出只能**新增**契约里没有的东西，不能**删除或改写**已经声明的东西。
 *
 * 具体化为两件事：
 *
 *   1. `package.json` —— run 开始时**已存在的顶层键**，其值不许被产出改动。
 *      产出新增的键保留（例如补一个 `description`），这是允许的。
 *   2. 验证配置文件 —— `tsconfig.json`，以及项目在
 *      `agentforge.protectedFiles` 里自行声明的文件（例如测试运行器）。
 *      **存在即不许被产出改写**。
 *
 * ── 两个刻意的设计选择 ────────────────────────────────────────────
 *
 * **为什么验证配置文件走「项目声明」而不是引擎硬编码一份清单**：
 * 与 `environmentNotes` 同一个道理（docs/07 §L5）——
 * 「哪些文件属于验证基础设施」是**项目**知道的事，引擎硬编码清单只会在别人的项目里出错。
 * 引擎只硬编码两样真正普适的东西：`package.json`（契约的载体本身）
 * 与 `tsconfig.json`（profile 里已经固定了它的路径，见 `ProjectProfile.tsconfigPath`）。
 *
 * **为什么空白工作区允许产出创建这些文件**：
 * 从零开始的项目没有 `package.json` 是正常的，角色必须能把它写出来
 * （`cli-run.ts` 的注释也说明了这一点：角色一旦写出 package.json，
 * 下一次 Gate 就会拿到真实的 typecheck/test 命令）。
 * 所以「不存在 ⇒ 允许创建，并当场收编进契约」；「已存在 ⇒ 不许改」。
 *
 * 注意本模块是**纯函数 + 只读快照**，不落盘、不写文件：
 * 它只负责回答「这份产出能不能按原样落盘」，把决定权留给调用方（编排器）。
 * 这样它可以被直接单测，也不需要真跑一次 LLM 才能验证。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256, stableStringify } from './hash.ts';
import type { ArtifactKind, RoleId } from './types.ts';

/**
 * 引擎硬编码的验证配置文件。
 *
 * 只有 `tsconfig.json`：它的路径在 `ProjectProfile.tsconfigPath` 里已经写死，
 * A4（编译/类型检查）完全依赖它，而它里面能改出「排除掉测试目录」这种静默弱化。
 * 其余属于项目自己的验证基础设施（测试运行器等）应当由项目声明。
 */
export const ENGINE_PROTECTED_FILES: readonly string[] = ['tsconfig.json'];

/** `package.json` 里项目可以自行扩展契约的地方。 */
export type ContractDeclarations = {
  /** 额外声明为「验证基准」的文件，产出不得改写。 */
  protectedFiles?: string[];
};

export type ContractViolationCode =
  | 'contract-key-removed' // 产出删掉了项目声明的键
  | 'contract-key-changed' // 产出改掉了项目声明的键的值
  | 'contract-file-overwritten' // 产出试图改写受保护的验证配置文件
  | 'contract-file-invalid' // 产出写出的契约文件不是合法 JSON，无法作为基准
  | 'path-escapes-project'; // 产出试图写到项目根之外

export type ContractViolation = {
  code: ContractViolationCode;
  /** 违规文件（相对项目根的 POSIX 路径）。 */
  path: string;
  /** 精确到子键的键路径，例如 `agentforge` / `scripts.test`。 */
  key?: string;
  declared?: string;
  attempted?: string;
  /** 产出这份内容的角色 —— 机械归因的落点，可直接生成派工单。 */
  targetRole: RoleId;
  artifactKind: ArtifactKind;
  message: string;
};

/**
 * run 开始时的契约快照。
 *
 * 它必须**在第一个角色产出之前**取，否则「基准」就成了产出自己写的东西。
 */
export type ProjectContract = {
  /** run 开始时项目根是否已有 `package.json`。 */
  pkgExists: boolean;
  /** `package.json` 的顶层键（含值）。产出不得删除或改写这些键。 */
  pkgKeys: Record<string, unknown>;
  /** 受保护文件 → 内容 hash。 */
  protectedFiles: Record<string, string>;
};

export type EnforceResult = {
  /** 允许落盘的文件清单（可能已剔除 / 规整过内容）。 */
  files: Array<{ path: string; content: string }>;
  violations: ContractViolation[];
  /** 可能已被收编扩展的契约；调用方应当用它替换手里的那份。 */
  contract: ProjectContract;
};

/**
 * 契约的**当前状态**，供 A8 锚点读取。
 *
 * 注意 `violations` 里的每一条都已经按「保留项目原值」处理过了 ——
 * 也就是说盘上的契约仍然是好的。这里仍然要报 FAIL，理由是：
 * **一次没能生效的篡改尝试依旧是篡改尝试**，而且下一次的向量未必在保护范围内。
 * 把它降级成 warn 就等于重演「静默通过」那类假绿灯（docs/07 §L11）。
 */
export type ContractState = {
  /** run 开始时项目是否声明过契约（有 package.json 或受保护文件）。 */
  hasBaseline: boolean;
  /** `package.json` 里被固化为基准的顶层键 —— 让人类看得见保护范围。 */
  declaredPkgKeys: string[];
  /** 受保护文件清单 —— 同上。 */
  protectedFiles: string[];
  violations: ContractViolation[];
};

const PKG = 'package.json';

/** 归一化成相对项目根的 POSIX 路径；逃出项目根时返回 null。 */
export function normalizeRelPath(raw: string): string | null {
  const unified = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null;
  const parts: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // 已经逃出项目根
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

function abbreviate(value: unknown, n = 160): string {
  const s = typeof value === 'string' ? value : stableStringify(value);
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 取 run 开始时的契约快照。
 *
 * 只读，不修改任何文件。`notes` 用于向人类说明「这次运行的保护范围是什么」——
 * 一个静默生效的保护机制和一个静默失效的保护机制一样危险，所以它必须可解释。
 */
export async function readProjectContract(
  projectRoot: string,
): Promise<{ contract: ProjectContract; notes: string[] }> {
  const notes: string[] = [];
  let pkg: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(join(projectRoot, PKG), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    pkg = isPlainObject(parsed) ? parsed : null;
    if (pkg === null) notes.push(`${PKG} 不是一个 JSON 对象，无法作为契约基准`);
  } catch {
    pkg = null; // 没有 package.json 是合法状态（从零开始的项目）
  }

  const declared = isPlainObject(pkg?.['agentforge'])
    ? (pkg['agentforge'] as ContractDeclarations)
    : {};
  const wanted = [...ENGINE_PROTECTED_FILES, ...(declared.protectedFiles ?? [])];

  const protectedFiles: Record<string, string> = {};
  for (const raw of wanted) {
    const rel = normalizeRelPath(raw);
    if (rel === null) {
      notes.push(`契约里声明的受保护文件路径不合法，已忽略：${raw}`);
      continue;
    }
    try {
      const content = await readFile(join(projectRoot, rel), 'utf8');
      protectedFiles[rel] = sha256(content);
    } catch {
      // 文件不存在 → 不保护（允许产出创建它）
    }
  }

  const pkgKeys = pkg ?? {};
  if (Object.keys(pkgKeys).length > 0) {
    notes.push(
      `已固化项目契约：${PKG} 的 ${Object.keys(pkgKeys).length} 个顶层键` +
        (Object.keys(protectedFiles).length > 0
          ? ` + 受保护文件 ${Object.keys(protectedFiles).join(', ')}`
          : '') +
        ' —— 产出不得删除或改写它们（违反会由 A8 报 FAIL）',
    );
  } else {
    notes.push(
      `运行开始时没有 ${PKG}：契约基准为空，允许产出创建它（创建后即收编为契约，后续不得再改）`,
    );
  }

  return { contract: { pkgExists: pkg !== null, pkgKeys, protectedFiles }, notes };
}

/** 顶层键存在但值不同时，往下钻一层，把真正变动的子键找出来（只为了让信息更可用）。 */
function differingSubKeys(
  declared: Record<string, unknown>,
  attempted: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const k of Object.keys(declared)) {
    if (!(k in attempted)) continue; // 整个键都被删了，由上层报
    if (stableStringify(attempted[k]) === stableStringify(declared[k])) continue;
    if (isPlainObject(declared[k]) && isPlainObject(attempted[k])) {
      const d = declared[k] as Record<string, unknown>;
      const a = attempted[k] as Record<string, unknown>;
      for (const sk of new Set([...Object.keys(d), ...Object.keys(a)])) {
        if (stableStringify(a[sk]) !== stableStringify(d[sk])) out.push(`${k}.${sk}`);
      }
    }
  }
  return out;
}

/**
 * 把一份产出规整成「可以落盘」的样子。
 *
 * 这个函数是纯的：给同样的输入永远给同样的输出，不读盘、不写盘。
 * 违规**不会被静默吞掉** —— 每一条都带着「谁改的、改了什么、原值是什么、它想改成什么」，
 * 由编排器记录进决策日志并交给 A8 锚点报 FAIL。
 */
export function enforceProjectContract(args: {
  contract: ProjectContract;
  files: Array<{ path: string; content: string }>;
  producer: RoleId;
  artifactKind: ArtifactKind;
}): EnforceResult {
  const { producer, artifactKind } = args;
  const contract: ProjectContract = {
    pkgExists: args.contract.pkgExists,
    pkgKeys: { ...args.contract.pkgKeys },
    protectedFiles: { ...args.contract.protectedFiles },
  };
  const violations: ContractViolation[] = [];
  const files: Array<{ path: string; content: string }> = [];

  for (const f of args.files) {
    const rel = normalizeRelPath(f.path);
    if (rel === null) {
      violations.push({
        code: 'path-escapes-project',
        path: f.path,
        targetRole: producer,
        artifactKind,
        message:
          `产出试图写到项目根之外：${f.path}。` +
          `落盘只允许发生在项目工作区内 —— 这条路径已被拒绝，文件未写入。`,
      });
      continue;
    }

    // ── 受保护的验证配置文件：拒绝改写 ──────────────────────────
    if (rel !== PKG && contract.protectedFiles[rel] !== undefined) {
      // 内容没变（等价重写）不构成违规：模型可能只是把读到的内容原样带出来了。
      if (sha256(f.content) === contract.protectedFiles[rel]) {
        files.push({ path: rel, content: f.content });
        continue;
      }
      violations.push({
        code: 'contract-file-overwritten',
        path: rel,
        targetRole: producer,
        artifactKind,
        message:
          `产出试图改写受保护的验证配置文件 ${rel} —— 它是验证基准的一部分，` +
          `改它等于改测量工具本身。该文件保持原样，产出里的这一份已被丢弃。`,
      });
      continue;
    }

    // ── package.json：已声明的顶层键不许删、不许改 ───────────────
    if (rel === PKG) {
      let attempted: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(f.content);
        attempted = isPlainObject(parsed) ? parsed : null;
      } catch {
        attempted = null;
      }

      if (attempted === null) {
        // 没有基准时（空白工作区）必须能创建它；有基准时交出非法 JSON 也算违规。
        // 两种情况都不写盘：一个无法解析的 package.json 会让 A4/A5 一起变成 SKIPPED，
        // 而「悄悄跳过检查」正是这一层要防的事。
        violations.push({
          code: 'contract-file-invalid',
          path: rel,
          targetRole: producer,
          artifactKind,
          message:
            `产出写出的 ${PKG} 不是合法的 JSON 对象` +
            (contract.pkgExists
              ? '，无法与已声明的契约合并（文件未写入，原契约保持不变）'
              : '，无法收编为契约基准（文件未写入）'),
        });
        continue;
      }

      if (!contract.pkgExists) {
        // 空白工作区：允许创建，并当场收编 —— 之后任何角色都不许再改它。
        contract.pkgExists = true;
        contract.pkgKeys = { ...attempted };
        files.push({ path: rel, content: f.content });
        continue;
      }

      const declared = contract.pkgKeys;
      const merged: Record<string, unknown> = {};
      for (const k of Object.keys(declared)) merged[k] = declared[k];
      for (const k of Object.keys(attempted)) if (!(k in merged)) merged[k] = attempted[k];

      for (const k of Object.keys(declared)) {
        const had = k in attempted;
        if (!had) {
          violations.push({
            code: 'contract-key-removed',
            path: rel,
            key: k,
            declared: abbreviate(declared[k]),
            targetRole: producer,
            artifactKind,
            message:
              `产出删掉了项目在 ${PKG} 里声明的键 "${k}"（原值：${abbreviate(declared[k])}）。` +
              `项目契约由项目方声明，产出无权删除它 —— 已保留原值。`,
          });
        } else if (stableStringify(attempted[k]) !== stableStringify(declared[k])) {
          const subs = differingSubKeys({ [k]: declared[k] }, { [k]: attempted[k] });
          const where = subs.length > 0 ? subs.join(', ') : k;
          violations.push({
            code: 'contract-key-changed',
            path: rel,
            key: subs[0] ?? k,
            declared: abbreviate(declared[k]),
            attempted: abbreviate(attempted[k]),
            targetRole: producer,
            artifactKind,
            message:
              `产出改写了项目在 ${PKG} 里声明的键 "${where}"：` +
              `${abbreviate(declared[k])} → ${abbreviate(attempted[k])}。` +
              `已保留项目声明的原值。`,
          });
        }
      }

      files.push({ path: rel, content: `${JSON.stringify(merged, null, 2)}\n` });
      continue;
    }

    files.push({ path: rel, content: f.content });
  }

  return { files, violations, contract };
}
