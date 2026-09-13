/**
 * 裸模块解析与导出符号抽取。
 *
 * 这是 A2（符号真实性）的引擎。核心主张：
 *   「包存在」是弱检查；幻觉最常发生在**符号**层
 *   —— `import { parseZodSchema } from 'zod'`，zod 真存在，parseZodSchema 不存在。
 *
 * 两种权威程度：
 *   - ts-ast：用 TypeScript 编译器解析 .d.ts 的 AST 收集导出名。
 *     比正则可靠（能正确处理多行、注释、复杂语法），但不做完整类型解析。
 *   - regex：无 TypeScript 时的降级路径，结果标记为 approximate。
 *
 * 诚实边界：两种方式都只读**声明文件里写了什么**，
 * 不处理条件导出（exports 的 import/require/browser 分支）的全部情形，
 * `export *` 链只跟随一层。因此当解析不确定时，我们会降级为 WARN 而不是 FAIL
 * —— 宁可漏报，不可把幻觉当事实，也不可把事实判成幻觉。
 */

import { join, dirname, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { readJsonOrNull, readTextOrNull, isDir } from '../../core/src/fsutil.ts';

export type PackageJson = {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  deprecated?: string | boolean;
};

export type PackageResolution = {
  pkg: string;
  sub: string | null;
  pkgDir: string | null;
  packageJsonPath: string | null;
  packageJson: PackageJson | null;
  /** 找到的声明文件（.d.ts）或实现入口（.js/.ts）。 */
  entryFile: string | null;
  entryKind: 'types' | 'implementation' | 'none';
  installed: boolean;
  error?: string;
};

const DTS_FALLBACKS = ['.d.ts', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

function withSuffixes(base: string): string[] {
  return [base, ...DTS_FALLBACKS.map((s) => base + s), ...DTS_FALLBACKS.map((s) => join(base, 'index' + s))];
}

/** 从 exports 字段里挑出 types 条件。支持字符串与条件对象。 */
function typesFromExports(exportsField: unknown, sub: string | null): string | null {
  if (exportsField === null || exportsField === undefined) return null;
  const key = sub ?? '.';

  const pick = (node: unknown): string | null => {
    if (typeof node === 'string') return node;
    if (node === null || typeof node !== 'object') return null;
    const obj = node as Record<string, unknown>;
    for (const cond of ['types', 'typings', 'import', 'require', 'default']) {
      if (cond in obj) {
        const r = pick(obj[cond]);
        if (r) return r;
      }
    }
    return null;
  };

  if (typeof exportsField === 'object') {
    const obj = exportsField as Record<string, unknown>;
    const hasSubpathKeys = Object.keys(obj).some((k) => k.startsWith('.'));
    if (hasSubpathKeys) {
      const direct = obj[key] ?? obj[key.replace(/^\.\//, './')];
      if (direct !== undefined) {
        const r = pick(direct);
        if (r) return r;
      }
      return null;
    }
  }
  return pick(exportsField);
}

export async function resolvePackage(
  root: string,
  pkg: string,
  sub: string | null,
): Promise<PackageResolution> {
  const pkgDir = join(root, 'node_modules', pkg);
  const packageJsonPath = join(pkgDir, 'package.json');

  if (!existsSync(pkgDir) || !(await isDir(pkgDir))) {
    return {
      pkg,
      sub,
      pkgDir: null,
      packageJsonPath: null,
      packageJson: null,
      entryFile: null,
      entryKind: 'none',
      installed: false,
      error: `未安装：node_modules/${pkg} 不存在（离线环境无法核实该包是否真实存在于 registry）`,
    };
  }

  const packageJson = await readJsonOrNull<PackageJson>(packageJsonPath);
  if (!packageJson) {
    return {
      pkg,
      sub,
      pkgDir,
      packageJsonPath,
      packageJson: null,
      entryFile: null,
      entryKind: 'none',
      installed: true,
      error: `package.json 无法解析：${packageJsonPath}`,
    };
  }

  // 子路径导入：优先 exports 映射，其次直接找文件
  if (sub) {
    const viaExports = typesFromExports(packageJson.exports, sub);
    if (viaExports) {
      const abs = pathResolve(pkgDir, viaExports);
      const hit = firstExisting(withSuffixes(abs));
      if (hit) return mk(pkg, sub, pkgDir, packageJsonPath, packageJson, hit, viaExports);
    }
    const abs = pathResolve(pkgDir, sub);
    const hit = firstExisting(withSuffixes(abs));
    if (hit) return mk(pkg, sub, pkgDir, packageJsonPath, packageJson, hit, sub);
    return {
      pkg,
      sub,
      pkgDir,
      packageJsonPath,
      packageJson,
      entryFile: null,
      entryKind: 'none',
      installed: true,
      error: `子路径 ${sub} 在包内无法解析`,
    };
  }

  // 主入口：声明文件优先
  const viaExports = typesFromExports(packageJson.exports, null);
  const candidates: Array<{ p: string; kind: 'types' | 'implementation'; via: string }> = [];
  if (viaExports) candidates.push({ p: pathResolve(pkgDir, viaExports), kind: 'types', via: 'exports' });
  if (packageJson.types) candidates.push({ p: pathResolve(pkgDir, packageJson.types), kind: 'types', via: 'types' });
  if (packageJson.typings)
    candidates.push({ p: pathResolve(pkgDir, packageJson.typings), kind: 'types', via: 'typings' });
  if (packageJson.module)
    candidates.push({ p: pathResolve(pkgDir, packageJson.module), kind: 'implementation', via: 'module' });
  if (packageJson.main)
    candidates.push({ p: pathResolve(pkgDir, packageJson.main), kind: 'implementation', via: 'main' });
  candidates.push({ p: join(pkgDir, 'index'), kind: 'implementation', via: 'fallback-index' });

  for (const c of candidates) {
    const hit = firstExisting(withSuffixes(c.p));
    if (hit) return mk(pkg, sub, pkgDir, packageJsonPath, packageJson, hit, c.via, c.kind);
  }

  return {
    pkg,
    sub,
    pkgDir,
    packageJsonPath,
    packageJson,
    entryFile: null,
    entryKind: 'none',
    installed: true,
    error: '无法定位入口文件',
  };
}

function mk(
  pkg: string,
  sub: string | null,
  pkgDir: string,
  packageJsonPath: string,
  packageJson: PackageJson,
  entryFile: string,
  _via: string,
  explicitKind?: 'types' | 'implementation',
): PackageResolution {
  const kind: 'types' | 'implementation' =
    explicitKind ?? (entryFile.endsWith('.d.ts') || entryFile.endsWith('.ts') ? 'types' : 'implementation');
  return { pkg, sub, pkgDir, packageJsonPath, packageJson, entryFile, entryKind: kind, installed: true };
}

// ── 导出符号抽取 ──────────────────────────────────────────────────

export type ExportSet = {
  names: Set<string>;
  /** 存在 `export =` / `export default` 之类开放导出，无法断言「某符号不存在」。 */
  open: boolean;
  /** 跟随过的 re-export 目标。 */
  followedStarFrom: string[];
  method: 'ts-ast' | 'regex';
};

let tsModule: unknown | null | undefined;

/**
 * 尝试加载 TypeScript 编译器。
 * 允许通过 AGENTFORGE_TS_PATH 指定绝对路径（本仓库零依赖，
 * 目标项目自己装 TS 时也能被找到）。
 */
export async function loadTypescript(explicitDir?: string): Promise<unknown | null> {
  if (tsModule !== undefined && !explicitDir) return tsModule;
  const candidates: string[] = [];
  if (explicitDir) candidates.push(join(explicitDir, 'typescript', 'lib', 'typescript.js'));
  if (process.env.AGENTFORGE_TS_PATH) candidates.push(process.env.AGENTFORGE_TS_PATH);
  candidates.push('typescript');

  for (const c of candidates) {
    try {
      const spec = c.includes('/') || c.includes('\\') ? pathToFileURL(c).href : c;
      const mod = (await import(spec)) as { default?: unknown };
      const ts = (mod as { default?: unknown }).default ?? mod;
      if (ts && typeof (ts as { createSourceFile?: unknown }).createSourceFile === 'function') {
        if (!explicitDir) tsModule = ts;
        return ts;
      }
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  if (!explicitDir) tsModule = null;
  return null;
}

/** 用 TypeScript AST 抽取导出名（权威路径）。 */
export function extractExportsWithTs(ts: any, filePath: string, text: string): ExportSet {
  const names = new Set<string>();
  let open = false;
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const isExported = (node: any): boolean => {
    const mods = typeof ts.canHaveModifiers === 'function' ? ts.canHaveModifiers(node) : node.modifiers;
    const mods2 = mods && typeof ts.getModifiers === 'function' ? ts.getModifiers(node) : mods;
    if (!mods2) return false;
    return mods2.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
  };

  const addBindingNames = (name: any): void => {
    if (!name) return;
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern?.(name) || ts.isArrayBindingPattern?.(name)) {
      for (const el of name.elements ?? []) addBindingNames(el.name);
    }
  };

  for (const st of sf.statements) {
    if (ts.isExportDeclaration?.(st)) {
      if (st.exportClause && ts.isNamedExports?.(st.exportClause)) {
        for (const el of st.exportClause.elements) names.add((el.name ?? el.propertyName).text);
      } else if (!st.exportClause) {
        // export * from '...'
        open = true;
      }
      continue;
    }
    if (ts.isExportAssignment?.(st)) {
      open = true;
      continue;
    }
    if (!isExported(st)) continue;

    if (ts.isVariableStatement?.(st)) {
      for (const d of st.declarationList.declarations) addBindingNames(d.name);
    } else if (st.name && ts.isIdentifier(st.name)) {
      names.add(st.name.text);
    }
    if (st.modifiers?.some?.((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword)) names.add('default');
  }

  return { names, open, followedStarFrom: [], method: 'ts-ast' };
}

/** 正则抽取导出名（降级路径）。 */
export function extractExportsWithRegex(text: string): ExportSet {
  const names = new Set<string>();
  let open = false;

  const declRe =
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:function|class|const|let|var|enum|interface|type|namespace|module)\s+([\w$]+)/g;
  for (const m of text.matchAll(declRe)) names.add(m[1]);

  const listRe = /\bexport\s*(?:type\s*)?\{([^}]*)\}/g;
  for (const m of text.matchAll(listRe)) {
    for (const s of m[1].split(',')) {
      const t = s.trim().replace(/^type\s+/, '');
      if (!t) continue;
      const asMatch = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(t);
      if (asMatch) names.add(asMatch[2]);
      else if (/^[\w$]+$/.test(t)) names.add(t);
    }
  }

  if (/\bexport\s+default\b/.test(text)) {
    names.add('default');
    open = true;
  }
  if (/\bexport\s*=/.test(text)) open = true;
  if (/\bexport\s+\*\s+from\b/.test(text) || /\bexport\s+\*\s+as\b/.test(text)) open = true;

  return { names, open, followedStarFrom: [], method: 'regex' };
}

/**
 * 抽取某个入口文件的导出集合。
 * 会跟随一层 `export * from './x'`（包内相对路径）以提升召回。
 */
export async function collectExports(
  entryFile: string,
  ts: unknown | null,
): Promise<ExportSet> {
  const text = await readTextOrNull(entryFile);
  if (text === null) {
    return { names: new Set(), open: true, followedStarFrom: [], method: ts ? 'ts-ast' : 'regex' };
  }

  const base = ts
    ? extractExportsWithTs(ts, entryFile, text)
    : extractExportsWithRegex(text);

  // 跟随 export * from './relative'（一层）
  const starRe = /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(starRe)) {
    const spec = m[1];
    if (!spec.startsWith('.')) {
      base.open = true; // 指向其他包，无法安全断言
      continue;
    }
    const target = firstExisting(withSuffixes(pathResolve(dirname(entryFile), spec)));
    if (!target) {
      base.open = true;
      continue;
    }
    base.followedStarFrom.push(target);
    const subText = await readTextOrNull(target);
    if (subText === null) {
      base.open = true;
      continue;
    }
    const subSet = ts ? extractExportsWithTs(ts, target, subText) : extractExportsWithRegex(subText);
    for (const n of subSet.names) base.names.add(n);
    if (subSet.open) base.open = true;
  }

  return base;
}
