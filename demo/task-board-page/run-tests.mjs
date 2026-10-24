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

// 收尾：**不要**在这里强行 exit。
//
// 踩过两次，方向相反：
//   ① 完全不收尾 -> 测试里起了 HTTP server 不 close，进程永不退出，
//      A5 空等 300 秒超时（实测 cb-14）。
//   ② 用固定毫秒数强退（setTimeout(..., 50)）-> 进程在测试开始前就死了，
//      A5 看到 exitCode=0 / passed=0，报 no-tests-ran（实测 deliv-break）。
//   ③ 用 beforeExit 强退 -> node:test **自己也挂在 beforeExit 上**去启动测试，
//      我们的处理器先跑，于是同样在测试开始前就退出，连"发现 N 个测试文件"都被吞掉。
//
// 所以正确做法是**什么都不做**：让 node:test 自己跑完并设置 exitCode。
// 代价是泄漏句柄的套件会跑满 A5 的超时 —— 但那个失败现在有明确的可执行消息
// （test-run-timeout：通常是句柄没关），角色能据此修；而"测试根本没跑"
// 是另一种失败，且更隐蔽。两害相权，选前者。
