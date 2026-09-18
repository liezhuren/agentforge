/**
 * 契约 → TypeScript 类型生成（确定性，不经 LLM）。
 *
 * 为什么必须有这个组件（docs/04-interface-protocol.md §3）：
 * 多智能体代码生成最经典的失败是「前端按假设 A 实现，后端按假设 B 实现，
 * 各自测试通过，集成时全崩」。自由对话式框架几乎无法避免，
 * 因为「约定」存在于对话历史里，无法校验。
 *
 * 本项目的解法是：契约冻结后**由程序生成**共享类型文件，前后端都只能 import 它。
 * 既然生成物来自同一份契约，双方的类型就不可能分叉 ——
 * 分叉会在编译期（A4）就被抓住，而不是等到集成时。
 *
 * A7 锚点会检查这个文件确实存在于磁盘上。用一个不存在或过期的生成物，
 * 等价于没有契约。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ContractDoc } from './types.ts';
import { stableStringify, sha256 } from './hash.ts';
import { normalizeRelPath } from './projectcontract.ts';

type JsonSchema = Record<string, unknown>;

/**
 * 生成上下文：**能解析 `$ref` 需要知道「有哪些具名定义」**。
 *
 * 这个参数是补一个真实缺陷时加的（见下面 `$ref` 分支的注释）：
 * 原来的 `schemaToTs(schema)` 只有两个参数，根本**没有地方**放「定义表」，
 * 所以 `$ref` 从设计上就不可能被解析 —— 这类缺陷不是「忘了写一个分支」，
 * 而是签名里就缺了必要的信息。
 */
export type CodegenCtx = { knownNames: ReadonlySet<string> };

/**
 * 把 `#/$defs/Name` / `#/definitions/Name` 解析成**生成文件里的类型名**。
 *
 * 为什么可以直接返回名字：`generateContractTypes()` 会把 `contract.jsonSchemas`
 * 的每个 key 都emit 成一个具名类型（`interface X` / `type X`），
 * 所以同一个文件里按名字引用即可。
 *
 * ⚠️ **已知局限**：只在 schema **自己内嵌** `$defs` 的情况下返回 null（→ 退化成 `unknown`），
 * 因为那些定义不会被 emit 成具名类型。本项目的契约把定义平铺在 `jsonSchemas` 里，
 * 所以这条路径不会走到；但换一种契约写法就会 —— 那时**必须是响亮的失败，而不是静默降级**。
 */
export function resolveRefName(ref: string, ctx: CodegenCtx): string | null {
  const m = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!m) return null;
  const name = m[1]!;
  return ctx.knownNames.has(name) ? name : null;
}

/** JSON Schema（本项目使用的子集）→ TypeScript 类型表达式。 */
export function schemaToTs(schema: unknown, indent = 0, ctx?: CodegenCtx): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  const s = schema as JsonSchema;

  /**
   * ⚠️ `$ref` 必须**最先**判断，而且这是修一个真实缺陷。
   *
   * 缺陷（第 13 轮真实运行暴露）：PM 交出的契约是**精确**的 ——
   * `Book.status` 写成 `{"$ref":"#/$defs/BookStatus"}`、`borrowerId` 写成
   * `{"type":["string","null"]}`、`history.items` 写成 `{"$ref":"#/$defs/HistoryEntry"}`。
   * 但原来的实现 `switch (s.type)` 遇到 `$ref`（没有 `type`）直接落到 `default`，
   * 于是**全部变成 `Record<string, unknown>`**。
   *
   * 后果是一条完整的连锁反应，而且每一环看起来都像「模型能力不足」：
   *   1. 后端角色按契约类型写代码 → 编译报 TS2322/TS2367（16 个）→ A4 FAIL
   *   2. A4 机械归因给 `backend` → 派返工单
   *   3. 但**根因在引擎的类型生成器里**，角色改不动那份生成物（它来自冻结契约）
   *   4. 角色唯一的出路是**放弃契约类型、自己重新声明模型** → A4 于是 PASS
   *   5. 结果是**契约漂移** —— 正是 A7 想防的那件事 —— 而 A7 只在 CONTRACTING/REVIEW 跑，
   *      且是 WARN 不阻断。于是这一轮拿到了一个**建立在坏契约之上的假绿灯**。
   *
   * 这一条是 §6.1 那条规律的**第五次**出现：约定没传达，失败却长得像能力不足。
   * 区别是这次的「约定」是引擎自己生成的类型。
   */
  if (typeof s.$ref === 'string') {
    const name = ctx ? resolveRefName(s.$ref, ctx) : null;
    // 解析得到 → 用具名类型；解析不到 → `unknown`（**响亮的失败**，而不是伪装成「任意对象」）。
    // 选 `unknown` 而不是 `Record<string, unknown>` 是刻意的：
    // 后者能让下游代码照常编译，于是坏契约会一路安静地传到运行期。
    return name ?? 'unknown';
  }

  /**
   * 联合类型数组：JSON Schema 里 `type: ["string","null"]` 表示「可空」。
   * 同样原先是漏的 —— 数组匹配不上任何 `case`，落到 `default` 变成 `Record<string, unknown>`。
   */
  if (Array.isArray(s.type)) {
    const list = (s.type as unknown[]).map((t) => schemaToTs({ ...s, type: t }, indent, ctx));
    return [...new Set(list)].join(' | ') || 'unknown';
  }

  if (Array.isArray(s.enum)) {
    return (s.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ') || 'never';
  }
  if (s.const !== undefined) return JSON.stringify(s.const);

  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
    const list = ((s.oneOf ?? s.anyOf) as unknown[]).map((x) => schemaToTs(x, indent, ctx));
    return [...new Set(list)].join(' | ') || 'unknown';
  }
  if (Array.isArray(s.allOf)) {
    return ((s.allOf as unknown[]).map((x) => schemaToTs(x, indent, ctx))).join(' & ');
  }

  switch (s.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const inner = schemaToTs(s.items, indent, ctx);
      const needsParens = inner.includes('|') || inner.includes('&');
      return `${needsParens ? `(${inner})` : inner}[]`;
    }
    case 'object':
    default: {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set((s.required as string[] | undefined) ?? []);
      const keys = Object.keys(props);
      if (keys.length === 0) {
        // 没有 properties 的对象 schema：`additionalProperties !== false` 时是「任意键」。
        //
        // 这里原来写成 `keys.length === 0 && s.additionalProperties !== false ? ... : ...`，
        // 而外层已经判断过 `keys.length === 0`，参数里也只可能是 true 或 undefined ——
        // 三元的两个条件**恒为真**，那个 `: '{}'` 分支永远走不到。
        // 结果本身是对的，但那段代码看起来像在「处理边界」，实际是死代码：
        // 下次有人想改这里的语义时，会以为自己有两条分支可调。
        //
        // ⚠️ 走到这里现在**只剩「契约真的没说这是什么」**一种情形了。
        // 以前 `$ref` 与联合类型也会掉进来，于是同一个 `Record<string, unknown>`
        // 同时代表三件完全不同的事（没说 / 引用 / 可空）——
        // 而那正是缺陷能藏住的原因：报告里看不出「契约没说」和「生成器不会解析」的区别。
        return s.additionalProperties === false ? '{}' : 'Record<string, unknown>';
      }
      const pad = '  '.repeat(indent + 1);
      const body = keys
        .map((k) => {
          const opt = required.has(k) ? '' : '?';
          const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
          return `${pad}${safe}${opt}: ${schemaToTs(props[k], indent + 1, ctx)};`;
        })
        .join('\n');
      return `{\n${body}\n${'  '.repeat(indent)}}`;
    }
  }
}

export function generateContractTypes(contract: ContractDoc): string {
  const lines: string[] = [];
  const fp = sha256(stableStringify(contract)).slice(0, 16);

  lines.push('// ─────────────────────────────────────────────────────────────');
  lines.push('// 本文件由 AgentForge 从冻结契约自动生成，请勿手工编辑。');
  lines.push(`// 契约指纹: ${fp}`);
  lines.push('//');
  lines.push('// 注意：手工修改本文件不会改变契约 —— 下次冻结时会覆盖。');
  lines.push('// 要改接口，请走「契约变更请求（ChangeRequest）」流程。');
  lines.push('// ─────────────────────────────────────────────────────────────');
  lines.push('');

  const schemas = contract.jsonSchemas ?? {};
  const names = Object.keys(schemas);
  // 定义表：所有具名 schema 都必须在生成文件里可见，`$ref` 才能解析成类型名。
  const ctx: CodegenCtx = { knownNames: new Set(names) };
  if (names.length === 0) {
    lines.push('// 契约未定义任何数据模型。');
  }
  for (const name of names) {
    const schema = schemas[name] as JsonSchema;
    const isObject = schema && typeof schema === 'object' && (schema.type === 'object' || schema.properties);
    if (isObject && Array.isArray(schema.required) === false && !schema.additionalProperties && !schema.oneOf) {
      lines.push(`export type ${name} = ${schemaToTs(schema, 0, ctx)};`);
    } else if (isObject && !schema.oneOf && !schema.anyOf) {
      lines.push(`export interface ${name} ${schemaToTs(schema, 0, ctx)}`);
    } else {
      lines.push(`export type ${name} = ${schemaToTs(schema, 0, ctx)};`);
    }
    lines.push('');
  }

  // 端点常量：前端不得手写字符串字面量，必须引用这里
  const paths = Object.keys(contract.openapi?.paths ?? {});
  lines.push('/** 契约声明的全部端点。前端必须引用这里，不得手写字符串字面量。 */');
  lines.push('export const API_PATHS = {');
  if (paths.length === 0) {
    lines.push('  // 契约未声明任何端点');
  } else {
    for (const p of paths) {
      lines.push(`  ${JSON.stringify(p)}: ${JSON.stringify(p)},`);
    }
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('export type ApiPath = (typeof API_PATHS)[keyof typeof API_PATHS];');
  lines.push('');

  return lines.join('\n');
}

/** 生成类型文件的落点非法（越出项目根，或指向受保护的验证基准文件）。 */
export class GeneratedTypesPathError extends Error {
  readonly relPath: string;
  constructor(relPath: string, reason: string) {
    super(`契约声明的生成类型路径不可写：${relPath}（${reason}）`);
    this.name = 'GeneratedTypesPathError';
    this.relPath = relPath;
  }
}

/**
 * 把生成物写到契约声明的路径。
 *
 * ⚠️ **这个路径是 PM 角色的 Contract 工件自己声明的**，也就是「产出的内容决定写盘位置」。
 * 因此它和 `materializeFiles` 属于同一个信任边界，必须有同样的守卫 ——
 * 不守的话，PM 只要把 `generatedTypesPath` 写成 `package.json`，
 * 引擎就会拿生成的 TypeScript **覆盖掉项目契约**，
 * 于是 A4/A5/A6 一起变成 SKIPPED 或跑错命令。
 *
 * （这正是 docs/07 §L13 那条教训的应用：修一条路径时，
 *  必须列出「同一件事还有哪些入口」。当年漏掉缓存命中那条 early return，
 *  让「反复跑同一个项目」这个最常规的用法第二次起每次都 400。）
 */
export async function writeContractTypes(
  projectRoot: string,
  contract: ContractDoc,
  opts: { forbiddenPaths?: string[] } = {},
): Promise<{ path: string; bytes: number }> {
  const rel = normalizeRelPath(contract.generatedTypesPath);
  if (rel === null) {
    throw new GeneratedTypesPathError(contract.generatedTypesPath, '路径越出项目工作区或不是合法的相对路径');
  }
  const forbidden = new Set((opts.forbiddenPaths ?? []).map((p) => normalizeRelPath(p)).filter((p): p is string => p !== null));
  if (forbidden.has(rel)) {
    throw new GeneratedTypesPathError(
      contract.generatedTypesPath,
      '它属于受保护的验证基准文件，产出不得改写',
    );
  }

  const abs = join(projectRoot, rel);
  const text = generateContractTypes(contract);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text, 'utf8');
  return { path: rel, bytes: Buffer.byteLength(text, 'utf8') };
}
