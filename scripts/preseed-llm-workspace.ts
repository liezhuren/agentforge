/**
 * 为「真实 LLM 运行」预置一个带真实工具链的空工作区。
 *
 * 这只是 `packages/orchestrator/src/llm-workspace.ts` 的命令行包装 ——
 * 真正的实现在那个模块里，因为**控制台也需要它**：从 GUI 起的真实 LLM run
 * 同样必须预置工具链，否则 A4/A5/A6 全部 SKIPPED（引擎不猜端口、不伪造通过）。
 *
 * 运行：node scripts/preseed-llm-workspace.ts <工作区路径> [端口，省略则自动挑空闲端口]
 */

import { seedLlmWorkspace } from '../packages/orchestrator/src/llm-workspace.ts';

const root = process.argv[2];
const portArg = process.argv[3];
if (!root) {
  console.error('用法：node scripts/preseed-llm-workspace.ts <工作区路径> [端口]');
  process.exit(1);
}

const port = portArg === undefined ? undefined : Number(portArg);
if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
  console.error(`端口不合法：${portArg}`);
  process.exit(1);
}

const r = await seedLlmWorkspace(root, {
  ...(port !== undefined ? { port } : {}),
  onLog: (s) => console.log(s),
});
console.log(r.toolchain.installed ? `工具链已安装：${root}` : `工具链就绪（${r.toolchain.detail}）`);
console.log(`健康检查地址：http://127.0.0.1:${r.port}/health`);
console.log(`工作区已预置（只含工具链契约，不含任何应用代码）：${root}`);
