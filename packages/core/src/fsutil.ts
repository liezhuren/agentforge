import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DEFAULT_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  '.turbo',
]);

export type WalkOptions = {
  /** 只收集这些扩展名（含点）。省略则收集全部文件。 */
  extensions?: string[];
  skipDirs?: Set<string>;
  maxFiles?: number;
};

/** 递归列出目录下所有文件，返回相对于 root 的 POSIX 风格路径。 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const skip = opts.skipDirs ?? DEFAULT_SKIP;
  const max = opts.maxFiles ?? 20_000;
  const out: string[] = [];

  async function rec(dir: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        await rec(abs);
      } else if (e.isFile()) {
        if (opts.extensions && !opts.extensions.some((x) => e.name.endsWith(x))) continue;
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  }

  await rec(root);
  return out.sort();
}

export async function readTextOrNull(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export function exists(p: string): boolean {
  return existsSync(p);
}

/** 读取 JSON 文件，失败返回 null（锚点不应因文件缺失而抛异常）。 */
export async function readJsonOrNull<T = unknown>(abs: string): Promise<T | null> {
  const t = await readTextOrNull(abs);
  if (t === null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

/** 按 1 起算的行号取出一段文本。越界时截断到可用范围。 */
export function sliceLines(text: string, startLine: number, endLine: number): string {
  const lines = text.split(/\r?\n/);
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, endLine);
  if (s > lines.length) return '';
  return lines.slice(s - 1, e).join('\n');
}
