import { createHash } from 'node:crypto';

/**
 * 稳定序列化：对象键递归排序。
 * 用途：内容 hash、证据 hash、claim hash、决策日志哈希链。
 * 必须与键顺序无关，否则同内容会算出不同 hash，锚点链会误判 STALE。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = normalize(v);
  }
  return out;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 内容 hash：用于工件锚定。任何字节变化都会改变它。 */
export function contentHash(content: unknown): string {
  return sha256(stableStringify(content));
}

export function shortHash(h: string): string {
  return h.slice(0, 12);
}

/**
 * claim 规范化：去空白、去标点、转小写、折叠空格、去常见虚词。
 * 用途：复读检测（规则 R6）—— 主理人换个说法重复同一异议时应被识别。
 * 注意：这是精确/近似的文本规范化，无法捕获语义级换皮。见 docs/03 §8 开放问题。
 */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/[，。；：！？、,.;:!?"'`（）()\[\]{}<>《》\-—_*/\\|]/g, '')
    .replace(/(请|应该|必须|需要|建议|可能|似乎|存在|这个|那个|一下|进行|的|了|是|在|和|与)/g, '')
    .trim();
}

export function claimHashOf(claim: string): string {
  return sha256(normalizeClaim(claim));
}

export function evidenceHashOf(evidence: unknown): string {
  return sha256(stableStringify(evidence));
}
