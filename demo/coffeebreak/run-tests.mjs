import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname);
const SKIP = new Set(['node_modules', '.git', 'artifacts', 'anchors', 'dist', 'shared']);

async function collect(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      await collect(join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.test.ts')) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const files = (await collect(ROOT)).sort();
if (files.length === 0) {
  console.error('未发现任何 *.test.ts —— 这个项目没有可执行的测试');
  process.exit(1);
}
console.log('发现 ' + files.length + ' 个测试文件，单进程内运行');
for (const f of files) await import(pathToFileURL(f).href);
