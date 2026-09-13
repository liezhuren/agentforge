/**
 * JSON Schema → OpenAI 严格模式（strict: true）兼容转换。
 *
 * 为什么必须有这个文件：OpenAI 的结构化输出 `strict: true` **只支持 JSON Schema 的一个子集**，
 * 而且要求非常具体：
 *   - 每个 object 都必须显式 `additionalProperties: false`
 *   - 每个 object 的**所有** property 都必须出现在 `required` 里
 *     （想表达「可选」只能用 nullable 类型，不能省略 required）
 *   - 不支持 `oneOf` / `not` / `allOf`（支持 `anyOf`）
 *   - 数值/长度类约束（minimum / minLength / maxItems …）不在支持列表内
 *
 * 我们自己定义的工件 schema（core/src/schemas.ts）大量使用 `oneOf`（证据引用、falsifier 的联合类型）
 * 与可选字段 —— 直接丢给 `strict: true` 会被端点以 400 拒绝。
 *
 * 因此这里做一次**有记录的**转换：所有改动都写进 changes，
 * 由 capability probe 决定「能不能用转换后的严格模式」，并把证据展示给人类。
 *
 * 重要：转换只会**放宽**服务端约束（可选变 nullable、去掉长度限制），
 * 不会放宽客户端约束 —— 响应回来后仍然要过 core 的 `validateSchema`（原始 schema）。
 * 也就是说：**服务端宽松 + 客户端严格 + 结构化重试** 三者配合，
 * 既拿到了严格模式的稳定性，又没有丢掉任何校验强度。
 */

import type { JsonSchema } from '../../core/src/schemas.ts';

export type StrictifyResult = {
  schema: JsonSchema;
  /** 做过的每一处改动（人类可审计）。 */
  changes: string[];
  /** 是否发生了「有损」转换（去掉约束 / oneOf 降级为 anyOf）。 */
  lossy: boolean;
};

/** 严格模式不支持、且不影响结构的关键字，直接剔除。 */
const DROPPED_KEYWORDS = new Set([
  'not',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'pattern',
  'default',
  'examples',
]);

export function toStrictJsonSchema(input: JsonSchema): StrictifyResult {
  const changes: string[] = [];
  let lossy = false;

  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (node === null || typeof node !== 'object') return node;

    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(src)) {
      if (DROPPED_KEYWORDS.has(k)) {
        changes.push(`${path}.${k}：严格模式不支持，已剔除（服务端不再约束，客户端仍会校验）`);
        lossy = true;
        continue;
      }
      if (k === 'oneOf') {
        // oneOf → anyOf：严格模式不支持 oneOf。语义变弱（不再要求「恰好一项」），
        // 但我们的本地校验器仍然按原始 schema 用 oneOf 校验，所以强度不丢。
        out.anyOf = (v as unknown[]).map((x, i) => walk(x, `${path}.anyOf[${i}]`));
        changes.push(`${path}.oneOf → anyOf：严格模式不支持 oneOf（本地校验仍按 oneOf 执行）`);
        lossy = true;
        continue;
      }
      if (k === 'allOf') {
        out.anyOf = (v as unknown[]).map((x, i) => walk(x, `${path}.anyOf[${i}]`));
        changes.push(`${path}.allOf → anyOf：严格模式不支持 allOf（语义由本地校验保证）`);
        lossy = true;
        continue;
      }
      out[k] = walk(v, `${path}.${k}`);
    }

    // object 节点：补齐 additionalProperties 与 required
    const isObjectLike =
      out.type === 'object' ||
      (out.properties !== undefined && typeof out.properties === 'object');
    if (isObjectLike && out.properties && typeof out.properties === 'object') {
      const props = out.properties as Record<string, unknown>;
      const requiredArr = Array.isArray(out.required) ? (out.required as string[]) : [];
      const requiredSet = new Set(requiredArr);
      const keys = Object.keys(props);

      for (const key of keys) {
        if (requiredSet.has(key)) continue;
        // 可选字段必须变成「required + nullable」，这是严格模式的硬性要求
        props[key] = makeNullable(props[key], `${path}.properties.${key}`, changes);
        requiredSet.add(key);
        changes.push(`${path}.properties.${key}：可选字段 → required + nullable（严格模式要求所有属性都必填）`);
      }
      out.required = [...requiredSet];

      if (out.additionalProperties !== false) {
        out.additionalProperties = false;
        changes.push(`${path}.additionalProperties → false（严格模式要求显式声明）`);
      }
    }

    return out;
  };

  const schema = walk(input, '$') as JsonSchema;
  return { schema, changes, lossy };
}

/** 让一个子 schema 接受 null。 */
function makeNullable(sub: unknown, path: string, changes: string[]): unknown {
  if (sub === null || typeof sub !== 'object') return sub;
  const s = sub as Record<string, unknown>;

  if (typeof s.type === 'string') {
    return { ...s, type: s.type === 'null' ? 'null' : [s.type, 'null'] };
  }
  if (Array.isArray(s.type)) {
    return s.type.includes('null') ? s : { ...s, type: [...s.type, 'null'] };
  }
  if (Array.isArray(s.anyOf)) {
    return { ...s, anyOf: [...s.anyOf, { type: 'null' }] };
  }
  // $ref 或无法判断形状：用 anyOf 包一层
  if (s.$ref) {
    changes.push(`${path}：$ref 字段用 anyOf 包裹以接受 null`);
    return { anyOf: [s, { type: 'null' }] };
  }
  return s;
}

/**
 * 判断某个 schema 是否**本来就已经**符合严格模式。
 * 已符合时不必转换，避免无谓地丢掉约束。
 */
export function isStrictCompatible(schema: JsonSchema): boolean {
  const res = toStrictJsonSchema(schema);
  return res.changes.length === 0;
}
