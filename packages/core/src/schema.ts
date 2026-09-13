/**
 * 极简 JSON Schema 校验器（零依赖）。
 *
 * 为什么自己写：本项目承诺「工件 schema 门禁」是通信的强制手段
 * （docs/04-interface-protocol.md §1），又要求零依赖可直接运行。
 * 只需要 JSON Schema 的一个确定子集，自己实现比引依赖更可控，
 * 且错误信息可以精确到 JSON 路径与关键字，便于回喂给 LLM 做结构化重试。
 *
 * 支持的子集：type / properties / required / additionalProperties /
 * items / enum / const / oneOf / anyOf / allOf / not /
 * minimum / maximum / minLength / maxLength / minItems / maxItems /
 * pattern / $ref（指向 #/$defs/*）
 */

export type JsonSchema = Record<string, unknown>;

export type SchemaError = {
  path: string;
  keyword: string;
  message: string;
};

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  if (expected === 'object') return actual === 'object';
  return actual === expected;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur && typeof cur === 'object' ? (cur as JsonSchema) : null;
}

export function validateSchema(
  value: unknown,
  schema: JsonSchema,
  root?: JsonSchema,
  path = '$',
): SchemaError[] {
  const top = root ?? schema;
  const errors: SchemaError[] = [];

  if (schema.$ref) {
    const target = resolveRef(String(schema.$ref), top);
    if (!target) {
      errors.push({ path, keyword: '$ref', message: `无法解析引用 ${String(schema.$ref)}` });
      return errors;
    }
    return validateSchema(value, target, top, path);
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push({
      path,
      keyword: 'const',
      message: `值必须等于 ${JSON.stringify(schema.const)}`,
    });
  }

  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!ok) {
      errors.push({
        path,
        keyword: 'enum',
        message: `值必须是 ${schema.enum.map((e) => JSON.stringify(e)).join(' | ')} 之一，实际为 ${JSON.stringify(value)}`,
      });
      return errors;
    }
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [String(schema.type)];
    if (!allowed.some((t) => typeMatches(value, t))) {
      errors.push({
        path,
        keyword: 'type',
        message: `类型必须是 ${allowed.join(' | ')}，实际为 ${typeOf(value)}`,
      });
      return errors; // 类型不符时后续关键字没有意义
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as JsonSchema[]) errors.push(...validateSchema(value, sub, top, path));
  }

  if (Array.isArray(schema.anyOf)) {
    const anyOk = (schema.anyOf as JsonSchema[]).some((sub) => validateSchema(value, sub, top, path).length === 0);
    if (!anyOk) errors.push({ path, keyword: 'anyOf', message: '不满足 anyOf 中任何一项' });
  }

  if (Array.isArray(schema.oneOf)) {
    const passes = (schema.oneOf as JsonSchema[]).filter((sub) => validateSchema(value, sub, top, path).length === 0);
    if (passes.length === 0) errors.push({ path, keyword: 'oneOf', message: '不满足 oneOf 中任何一项' });
    else if (passes.length > 1) {
      errors.push({ path, keyword: 'oneOf', message: `同时满足 oneOf 中 ${passes.length} 项，必须恰好满足一项` });
    }
  }

  if (schema.not && typeof schema.not === 'object') {
    if (validateSchema(value, schema.not as JsonSchema, top, path).length === 0) {
      errors.push({ path, keyword: 'not', message: '不允许匹配 not 所描述的结构' });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, keyword: 'minLength', message: `长度至少 ${schema.minLength}，实际 ${value.length}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path, keyword: 'maxLength', message: `长度至多 ${schema.maxLength}，实际 ${value.length}` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push({
        path,
        keyword: 'pattern',
        message: `不匹配模式 /${schema.pattern}/，实际为 ${JSON.stringify(value.slice(0, 80))}`,
      });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, keyword: 'minimum', message: `不得小于 ${schema.minimum}，实际 ${value}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, keyword: 'maximum', message: `不得大于 ${schema.maximum}，实际 ${value}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path, keyword: 'minItems', message: `元素至少 ${schema.minItems} 个，实际 ${value.length}` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path, keyword: 'maxItems', message: `元素至多 ${schema.maxItems} 个，实际 ${value.length}` });
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => {
        errors.push(...validateSchema(item, schema.items as JsonSchema, top, `${path}[${i}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) {
          errors.push({ path, keyword: 'required', message: `缺少必填字段 "${key}"` });
        }
      }
    }

    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        errors.push(...validateSchema(obj[key], sub, top, `${path}.${key}`));
      }
    }

    if (schema.additionalProperties === false) {
      const extra = Object.keys(obj).filter((k) => !(k in props));
      for (const k of extra) {
        errors.push({
          path,
          keyword: 'additionalProperties',
          message: `不允许的额外字段 "${k}"（允许的字段：${Object.keys(props).join(', ')}）`,
        });
      }
    }
  }

  return errors;
}

export function formatSchemaErrors(errors: SchemaError[]): string {
  if (errors.length === 0) return '';
  return errors.map((e) => `  - ${e.path} [${e.keyword}] ${e.message}`).join('\n');
}

/**
 * 把校验错误渲染成适合回喂给 LLM 的修正指令。
 * 这是「结构化重试」的核心：不是盲目重试，而是把具体错在哪告诉模型。
 */
export function buildRepairHint(errors: SchemaError[]): string {
  return [
    '你上一次的输出未通过 schema 校验，请修正以下问题后重新输出完整 JSON：',
    formatSchemaErrors(errors),
  ].join('\n');
}
