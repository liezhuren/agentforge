/**
 * 为「真实 LLM 运行」预置一个带真实工具链的空工作区。
 *
 * 为什么需要它：
 * `deriveProfile` 从 `<workspace>/package.json` 的 scripts 推导 A4/A5 的命令。
 * 工作区从零开始时是空的 ⇒ typecheck/test 都是 null ⇒ A4/A5 全程 SKIPPED。
 * 而「真实 LLM 从零写代码」恰恰是最需要锚点把关的路径 —— 没得查等于没把关。
 *
 * 所以先放好**工具链契约**（package.json 脚本 + tsconfig + 测试运行器 + typescript），
 * 让 LLM 去写 `src/` 与 `tests/`，然后 A4/A5 真的去编译和运行它写的东西。
 *
 * 刻意**不放任何应用代码** —— 代码必须由 LLM 生成，否则这次运行说明不了任何问题。
 *
 * 运行：node scripts/preseed-llm-workspace.ts [工作区路径]
 */

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { ensureToolchain } from '../packages/orchestrator/src/real-app-project.ts';

const root = process.argv[2];
if (!root) {
  console.error('用法：node scripts/preseed-llm-workspace.ts <工作区路径>');
  process.exit(1);
}

const w = async (rel: string, content: string) => {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content, 'utf8');
};

await mkdir(root, { recursive: true });

await w(
  'package.json',
  JSON.stringify(
    {
      name: 'llm-generated',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        // 真实命令，不是造出来的结果
        typecheck: 'tsc --noEmit -p tsconfig.json',
        test: 'node run-tests.mjs',
        start: 'node src/api/server.ts',
      },
      // 显式声明健康检查地址，让 A6（运行时探针）能真的执行。
      // 不声明的话 A6 只能报 SKIPPED —— 引擎刻意不猜端口（猜错会探到别的进程）。
      agentforge: {
        healthUrl: 'http://127.0.0.1:8787/health',
        // 环境约束：由**项目**声明，引擎会原样注入每个角色的提示词。
        // 这两条都是真实 LLM run 里用血换来的（docs/07 §L5 / §L8）：
        // 模型写的代码本身没问题，是环境的限制没被传达，结果锚点判 FAIL、
        // 归因到某个角色头上 —— 看起来像「模型能力不足」，实际是约定缺失。
        environmentNotes: [
          '相对导入必须带显式 `.ts` 扩展名（本项目的代码由 Node 原生类型剥离直接运行）。',
          '禁止在测试或应用代码中 spawn 子进程（执行 npm/node 等外部命令）。' +
            '当前运行环境禁止管道式 stdio，spawn 会直接 EPERM 失败 —— ' +
            '测试应当直接 import 被测模块并对返回值做断言，不要通过命令行间接验证。',
        ],
      },
      devDependencies: { typescript: '^7.0.0', '@types/node': '^26.0.0' },
    },
    null,
    2,
  ) + '\n',
);

await w(
  'tsconfig.json',
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        // 与引擎同一套约定：Node 原生类型剥离要求 import 带 .ts 扩展名
        allowImportingTsExtensions: true,
        noEmit: true,
        strict: true,
        erasableSyntaxOnly: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        types: ['node'],
      },
      // 明确排除工具链目录，否则 tsc 会去编译 node_modules
      exclude: ['node_modules'],
    },
    null,
    2,
  ) + '\n',
);

/**
 * 测试运行器：在工作区内收集 `*.test.ts` 并在**单进程**内运行。
 *
 * 为什么不用 `node --test`：该模式会为每个测试文件 spawn 子进程并走管道 stdio，
 * 在受限环境下直接 EPERM（引擎自己的 `scripts/run-tests.ts` 出于同一原因这么写）。
 *
 * 一个都没找到时**退出码为 1**，这是刻意的：
 * 「这个项目有测试」是一句可被检验的承诺，找不到测试就是没兑现，
 * 不能报「0 个测试通过」让 A5 拿到一个漂亮的绿灯。
 */
await w(
  'run-tests.mjs',
  `import { readdir } from 'node:fs/promises';
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
`,
);

const tc = await ensureToolchain(root, { onLog: (s) => console.log(s) });
console.log(tc.installed ? `工具链已安装：${root}` : `工具链就绪（${tc.detail}）`);
console.log(`工作区已预置（只含工具链契约，不含任何应用代码）：${root}`);
