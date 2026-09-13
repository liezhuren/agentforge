/**
 * 零依赖测试入口。
 *
 * 为什么不用 `node --test <dir>`：该模式会为每个测试文件 spawn 子进程并走管道 stdio，
 * 在受限环境下直接 EPERM（见 packages/core/src/exec.ts 的说明）。
 * 这里改为在**单个进程内**动态导入全部 *.test.ts —— node:test 的 test() 在被直接运行时
 * 会就地调度并输出结果，退出码同样反映失败，因此不需要任何外部测试框架。
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SCAN_ROOTS = ['packages', 'apps', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'workspace', 'runs', 'dist', '.probe', '.git']);

async function collect(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collect(join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.test.ts')) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const files: string[] = [];
for (const r of SCAN_ROOTS) await collect(join(ROOT, r), files);
files.sort();

// 可选过滤：`node scripts/run-tests.ts roundtable` 只跑路径含该子串的测试文件。
// 调试时需要它 —— 全量跑一次 30 秒，改一行代码等 30 秒太慢。
const filter = process.argv[2];
const selected = filter ? files.filter((f) => f.replace(/\\/g, '/').includes(filter)) : files;

if (selected.length === 0) {
  console.error(filter ? `没有匹配 "${filter}" 的测试文件` : '未发现任何 *.test.ts');
  process.exit(1);
}

console.log(
  `发现 ${files.length} 个测试文件，单进程内运行 ${selected.length} 个` +
    `${filter ? `（过滤：${filter}）` : ''}：\n`,
);
for (const f of selected) {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  console.log(`── ${rel}`);
  await import(pathToFileURL(f).href);
}
