/**
 * 为「真实 LLM 运行」预置一个带真实工具链的空工作区。
 *
 * 为什么这件事必须由**引擎**做，而不是靠调用方记得跑脚本
 * （2026-10-24 实测教训）：
 *
 * 控制台（`apps/web` + `packages/server`）可以选「真实 LLM」并直接启动 run ——
 * 但它只会 `mkdir` 一个空目录。于是 `deriveProfile` 从空工作区推导出
 * `typecheck: null` / `test: null` / `run: null`，**A4/A5/A6 全部 SKIPPED**。
 * 也就是说：从 GUI 起的 run 会悄悄放弃「能不能编译 / 测试过没过 / 服务能不能起来」
 * 这三条最硬的检查，而界面上只显示一行小字警告。
 *
 * 我自己也犯过一次同样的错（忘了先跑预置脚本，那一轮几乎什么都没验证）。
 * 所以「预置」不该是调用方的义务 —— 它必须是运行的一部分。
 *
 * 刻意**不放任何应用代码**：代码必须由 LLM 生成，否则这次运行说明不了任何问题。
 */

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

import { ensureToolchain } from './real-app-project.ts';

/** 从 `start` 起找一个没被占用的端口（A6 的探针要连它）。 */
export async function findFreePort(start = 8787, tries = 40): Promise<number> {
  for (let port = start; port < start + tries; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  return start; // 找不到就返回起点，让 A6 去如实报失败
}

export type SeedLlmWorkspaceOptions = {
  /** 健康检查端口。省略则自动挑一个空闲端口。 */
  port?: number;
  /** 安装工具链时的日志回调（npm install 会打印东西）。 */
  onLog?: (line: string) => void;
};

export type SeedLlmWorkspaceResult = {
  port: number;
  toolchain: { installed: boolean; detail?: string };
};

/** 写 package.json（含 scripts 与 agentforge 约定）、tsconfig.json、run-tests.mjs，并安装工具链。 */
export async function seedLlmWorkspace(
  root: string,
  opts: SeedLlmWorkspaceOptions = {},
): Promise<SeedLlmWorkspaceResult> {
  const port = opts.port ?? (await findFreePort());

  const w = async (rel: string, content: string): Promise<void> => {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  };

  await mkdir(root, { recursive: true });

  await w(
    'package.json',
    `${JSON.stringify(
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
        agentforge: {
          healthUrl: `http://127.0.0.1:${port}/health`,
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
          // 验证基准文件：产出不得改写它们。
          // package.json 与 tsconfig.json 是引擎认定的通用基准，不必列；
          // 这里列的是**本项目特有**的验证基础设施 —— 换一个项目可能是
          // vitest.config.ts / jest.config.js / Makefile，所以由项目自己声明。
          // 不列的话，角色可以用一份 `process.exit(0)` 的测试运行器让 A5 拿到假绿灯。
          protectedFiles: ['run-tests.mjs'],
        },
        devDependencies: { typescript: '^7.0.0', '@types/node': '^26.0.0' },
      },
      null,
      2,
    )}\n`,
  );

  await w(
    'tsconfig.json',
    `${JSON.stringify(
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
    )}\n`,
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
   *
   * ⚠️ 末尾必须显式退出：测试里起了 HTTP server 而不 close 时，进程不会自然结束，
   * A5 会一路等到超时（实测 cb-14 就这样空等了 10 分钟）。
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

// 测试可能留下未关闭的句柄（HTTP server / 定时器）。给它一点收尾时间，然后强退：
// 不放这一行的话，A5 会等满整个超时——那不是"测试失败"，是测试跑完了却不退出。
setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
`,
  );

  const toolchain = await ensureToolchain(root, {
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
  });
  return { port, toolchain };
}
