/**
 * 契约摘要：把 Contract 压成**可执行信息**，用于上下文放不下整份契约时。
 *
 * ## 为什么需要它（真实缺陷）
 *
 * `renderContext()` 原本的溢出策略是「装不下就跳过」：
 *
 * ```ts
 * const body = JSON.stringify(a.content, null, 2);
 * if (body.length > budget) continue;   // ← 跳过了，而且不吭声
 * ```
 *
 * 第 14 轮实测：19 条需求的契约 `JSON.stringify` 后有 **6.6 万字符**，
 * 而 `maxContextChars` 默认 **2.4 万** —— 于是**契约从来没有进过任何角色的提示词**。
 * 提示词里只剩一句「【冻结契约 hash】…契约已冻结」，**只有 hash，没有内容**。
 *
 * 后果：后端照自然语言需求自己发明了接口路径，A4 能过（代码自洽），
 * 但 A7 报 **13 个契约端点未实现**。看起来像「模型不会写」，实际是**它没拿到规格**。
 *
 * ## 摘要包含什么（只保留能据此写代码的部分）
 *
 * - 每个端点的方法 + 路径 + 成功状态码
 * - 每个模型的名字与字段类型（复用 `schemaToTs`，所以 `$ref` / 可空 / 数组都能正确表达）
 *
 * 刻意**丢掉**描述、示例、pattern、minLength 这些「解释性」内容 ——
 * 它们对写代码有帮助，但对「接口长什么样」不是必需；而截断时先丢解释性内容是安全的方向。
 *
 * ## 它是确定性的
 *
 * 同样的契约永远得到同样的摘要（键顺序固定），所以可以进 hash、可以回放、可以被测试钉住。
 */

import type { ContractDoc } from './types.ts';
import { schemaToTs, type CodegenCtx } from './contractcodegen.ts';

type JsonSchema = Record<string, unknown>;

/** 任务声明的契约切片。省略 = 未声明（退回「整份契约 / 摘要」的行为）。 */
export type ContractSlice = {
  /** 端点路径（与 `openapi.paths` 的键一致） */
  paths?: string[];
  /** 模型名（与 `jsonSchemas` 的键一致） */
  schemas?: string[];
};

export type ContractDigestOptions = {
  /** 只看这些端点 / 模型（任务声明的切片）。 */
  slice?: ContractSlice;
  /** 最多列多少个端点 / 模型（防止摘要本身又变得过大）。 */
  maxPaths?: number;
  maxSchemas?: number;
};

const DEFAULT_MAX_PATHS = 40;
const DEFAULT_MAX_SCHEMAS = 30;

/** 取某个路径声明的方法与成功状态码（`{ post: { responses: { '201': ... } } }` 这种形态）。 */
function methodsOf(pathSpec: unknown): string[] {
  if (!pathSpec || typeof pathSpec !== 'object') return [];
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  return METHODS.filter((m) => (pathSpec as Record<string, unknown>)[m] !== undefined).map((m) =>
    m.toUpperCase(),
  );
}

/** 尝试从 responses 里找出 2xx 状态码；找不到就返回 null。 */
function successCodeOf(pathSpec: unknown, method: string): string | null {
  if (!pathSpec || typeof pathSpec !== 'object') return null;
  const op = (pathSpec as Record<string, unknown>)[method.toLowerCase()];
  if (!op || typeof op !== 'object') return null;
  const responses = (op as Record<string, unknown>).responses;
  if (!responses || typeof responses !== 'object') return null;
  const codes = Object.keys(responses as Record<string, unknown>).filter((c) => /^2\d\d$/.test(c));
  return codes.length > 0 ? codes.sort()[0]! : null;
}

/** 把单个模型压成一行：`Book { isbn:string, status:BookStatus, ... }`。 */
function schemaLine(name: string, schema: unknown, ctx: CodegenCtx): string {
  const s = (schema ?? {}) as JsonSchema;

  // 枚举 / 联合 / 原始类型：整条都是类型表达式，直接给
  if (Array.isArray(s.enum) || s.const !== undefined || typeof s.type === 'string' || Array.isArray(s.type)) {
    const ts = schemaToTs(s, 0, ctx);
    // 对象型（有 properties）走下面的字段展开
    if (!s.properties) return `${name}: ${ts}`;
  }

  const props = (s.properties ?? {}) as Record<string, unknown>;
  const keys = Object.keys(props);
  if (keys.length === 0) return `${name}: ${schemaToTs(s, 0, ctx)}`;

  const required = new Set((s.required as string[] | undefined) ?? []);
  const fields = keys
    // `schemaToTs` 对嵌套对象会返回多行；摘要要求「一个模型一行」，否则 30 个模型就不是摘要了
    .map((k) => `${k}${required.has(k) ? '' : '?'}:${schemaToTs(props[k], 0, ctx).replace(/\s*\n\s*/g, ' ')}`)
    .join(', ');
  return `${name} { ${fields} }`;
}

/**
 * 生成契约摘要。
 *
 * `slice` 有值时只列它声明的端点与模型（这就是「按任务切分」）；
 * 没有值时列全部（受 maxPaths / maxSchemas 上限约束，超出部分会显式说明）。
 */
export function digestContract(contract: ContractDoc, opts: ContractDigestOptions = {}): string {
  const paths = (contract.openapi?.paths ?? {}) as Record<string, unknown>;
  const schemas = (contract.jsonSchemas ?? {}) as Record<string, unknown>;

  const allNames = Object.keys(schemas);
  const ctx: CodegenCtx = { knownNames: new Set(allNames) };

  const wantPaths = opts.slice?.paths ? new Set(opts.slice.paths) : null;
  const wantSchemas = opts.slice?.schemas ? new Set(opts.slice.schemas) : null;

  const pathKeys = Object.keys(paths).filter((p) => (wantPaths ? wantPaths.has(p) : true));
  const schemaKeys = allNames.filter((n) => (wantSchemas ? wantSchemas.has(n) : true));

  const maxPaths = opts.maxPaths ?? DEFAULT_MAX_PATHS;
  const maxSchemas = opts.maxSchemas ?? DEFAULT_MAX_SCHEMAS;

  const lines: string[] = [];
  const totalPaths = Object.keys(paths).length;
  const totalSchemas = allNames.length;

  if (wantPaths || wantSchemas) {
    lines.push(
      `契约摘要（按任务声明的切片裁剪：端点 ${pathKeys.length}/${totalPaths}，模型 ${schemaKeys.length}/${totalSchemas}）`,
    );
  } else {
    lines.push(`契约摘要（完整内容过长，已压缩为可执行信息：端点 ${totalPaths}，模型 ${totalSchemas}）`);
  }

  lines.push('', '端点：');
  if (pathKeys.length === 0) lines.push('  （无）');
  for (const p of pathKeys.slice(0, maxPaths)) {
    const spec = paths[p];
    const ms = methodsOf(spec);
    if (ms.length === 0) {
      lines.push(`  ${p}`);
      continue;
    }
    const parts = ms.map((m) => {
      const code = successCodeOf(spec, m);
      return code ? `${m} → ${code}` : m;
    });
    lines.push(`  ${p}: ${parts.join(', ')}`);
  }
  if (pathKeys.length > maxPaths) {
    lines.push(`  …另有 ${pathKeys.length - maxPaths} 个端点未列出（摘要长度上限 ${maxPaths}）`);
  }

  lines.push('', '模型：');
  if (schemaKeys.length === 0) lines.push('  （无）');
  for (const n of schemaKeys.slice(0, maxSchemas)) {
    lines.push(`  ${schemaLine(n, schemas[n], ctx)}`);
  }
  if (schemaKeys.length > maxSchemas) {
    lines.push(`  …另有 ${schemaKeys.length - maxSchemas} 个模型未列出（摘要长度上限 ${maxSchemas}）`);
  }

  const gen = contract.generatedTypesPath;
  if (gen) {
    lines.push('', `生成的类型文件（导入它，不要手写同名模型）：${gen}`);
  }

  return lines.join('\n');
}

/**
 * 检查「任务声明的切片」是否覆盖了整个契约。
 *
 * 切分带来一个新的失败模式：**某个端点没有被任何任务认领**，于是永远不会被实现 ——
 * 而且比原来更隐蔽（原来的失败是「装不下」，现在是「没人认领」）。
 * 所以必须有这条检查，它对应 `docs/07 §O2` 记的那次 13 个端点未实现的教训。
 */
export function checkSliceCoverage(
  contract: ContractDoc,
  declared: ContractSlice[],
): {
  /** 契约里有、但没有任何任务认领的端点 */
  orphanPaths: string[];
  /** 契约里没有、但任务认领了的端点（拼写/漂移） */
  phantomPaths: string[];
  orphanSchemas: string[];
  phantomSchemas: string[];
} {
  const contractPaths = new Set(Object.keys(contract.openapi?.paths ?? {}));
  const contractSchemas = new Set(Object.keys(contract.jsonSchemas ?? {}));

  const claimedPaths = new Set<string>();
  const claimedSchemas = new Set<string>();
  for (const s of declared) {
    for (const p of s.paths ?? []) claimedPaths.add(p);
    for (const n of s.schemas ?? []) claimedSchemas.add(n);
  }

  return {
    orphanPaths: [...contractPaths].filter((p) => !claimedPaths.has(p)).sort(),
    phantomPaths: [...claimedPaths].filter((p) => !contractPaths.has(p)).sort(),
    orphanSchemas: [...contractSchemas].filter((n) => !claimedSchemas.has(n)).sort(),
    phantomSchemas: [...claimedSchemas].filter((n) => !contractSchemas.has(n)).sort(),
  };
}
