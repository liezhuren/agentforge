/**
 * 导入抽取器。
 *
 * A1（包真实性）/ A2（符号真实性）/ A3（导入可解析）都需要知道
 * 「代码里到底 import 了什么」。用正则而不是完整 AST 解析，
 * 是为了让锚点层零依赖可运行；代价是极端写法可能漏检，
 * 因此所有基于它的结论都会带上 method 标记，由人类判断权威程度。
 *
 * 漏检的后果是「少报」，不是「错报」—— 这个方向的偏差是可接受的：
 * 锚点宁可漏，不可把幻觉当成事实。
 */

export type ImportRef = {
  /** 相对项目根的 POSIX 路径。 */
  file: string;
  line: number;
  /** 原始模块说明符。 */
  specifier: string;
  /** 需要核验的具名导入（`as` 之前的名字）。 */
  symbols: string[];
  kind: 'esm' | 'cjs';
  /** 相对路径导入（以 . 或 / 开头）。 */
  isRelative: boolean;
  /** 裸模块导入（包名）。 */
  isBare: boolean;
};

type Pattern = {
  re: RegExp;
  kind: 'esm' | 'cjs';
  pick: (m: RegExpMatchArray) => { specifier: string; symbols: string[] };
};

/** 解析 `{ a, b as c, type d }`，返回需要核验的导出名（as 之前的名字）。 */
export function parseNamedList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^type\s+/, '').trim())
    .map((s) => {
      const asMatch = /^([\w$]+)\s+as\s+[\w$]+$/.exec(s);
      return asMatch ? asMatch[1] : s;
    })
    .filter((s) => /^[\w$]+$/.test(s));
}

const PATTERNS: Pattern[] = [
  // import { a, b } from 'x'   /  import type { a } from 'x'
  {
    re: /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
    kind: 'esm',
    pick: (m) => ({ specifier: m[2], symbols: parseNamedList(m[1]) }),
  },
  // import D, { a } from 'x'
  {
    re: /\bimport\s+(?:type\s+)?[\w$]+\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
    kind: 'esm',
    pick: (m) => ({ specifier: m[2], symbols: parseNamedList(m[1]) }),
  },
  // import * as N from 'x'
  {
    re: /\bimport\s+(?:type\s+)?\*\s+as\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g,
    kind: 'esm',
    pick: (m) => ({ specifier: m[1], symbols: [] }),
  },
  // import D from 'x'
  {
    re: /\bimport\s+(?:type\s+)?[\w$]+\s+from\s*['"]([^'"]+)['"]/g,
    kind: 'esm',
    pick: (m) => ({ specifier: m[1], symbols: ['default'] }),
  },
  // import 'x'
  {
    re: /\bimport\s*['"]([^'"]+)['"]/g,
    kind: 'esm',
    pick: (m) => ({ specifier: m[1], symbols: [] }),
  },
  // export { a } from 'x'  /  export * from 'x'
  {
    re: /\bexport\s+(?:\{[^}]*\}|\*)\s*from\s*['"]([^'"]+)['"]/g,
    kind: 'esm',
    pick: (m) => ({ specifier: m[1], symbols: [] }),
  },
  // const { a, b } = require('x')
  {
    re: /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    kind: 'cjs',
    pick: (m) => ({ specifier: m[2], symbols: parseNamedList(m[1]) }),
  },
  // require('x')
  {
    re: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    kind: 'cjs',
    pick: (m) => ({ specifier: m[1], symbols: [] }),
  },
];

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

export function extractImports(file: string, text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const seen = new Set<string>();

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      const { specifier, symbols } = p.pick(m);
      if (!specifier) continue;
      const line = lineAt(text, m.index);
      const key = `${p.kind}|${line}|${specifier}|${symbols.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        file,
        line,
        specifier,
        symbols,
        kind: p.kind,
        isRelative: specifier.startsWith('.') || specifier.startsWith('/'),
        isBare: !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'),
      });
    }
  }

  return out.sort((a, b) => a.line - b.line);
}

/** 拆出包名与子路径：`@scope/pkg/sub/x` → { pkg: '@scope/pkg', sub: './sub/x' }。 */
export function splitBareSpecifier(specifier: string): { pkg: string; sub: string | null } {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (parts.length < 2) return { pkg: specifier, sub: null };
    const pkg = `${parts[0]}/${parts[1]}`;
    const rest = parts.slice(2).join('/');
    return { pkg, sub: rest.length > 0 ? `./${rest}` : null };
  }
  return { pkg: parts[0], sub: parts.length > 1 ? `./${parts.slice(1).join('/')}` : null };
}
