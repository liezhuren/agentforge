/**
 * 控制台服务端启动入口。
 *
 *   node packages/server/src/cli.ts                        # 默认端口 7788（占用则自动换）
 *   node packages/server/src/cli.ts --port 8080
 *   node packages/server/src/cli.ts --open                 # 启动后打印可点链接
 *
 * 打开后先点「离线演示」跑一次即可把整套机制看懂 —— 不需要任何 API key。
 * 想接真实模型就在仓库根放一份 agentforge.config.json，然后选「真实 LLM」模式。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Logger } from '../../core/src/index.ts';
import { createForgeServer } from './http.ts';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..'));

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
};

export async function runServerCli(argv: string[]): Promise<number> {
  const get = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const port = Number(get('port') ?? 7788);
  const out = (s: string) => console.log(s);

  const logger = new Logger('server', (r) => {
    if (r.level === 'error' || r.level === 'warn') console.error(`${C.yellow}[${r.level}] ${r.message}${C.reset}`);
  }, 'warn');

  let forge;
  try {
    forge = await createForgeServer({
      root: ROOT,
      ...(Number.isFinite(port) && port > 0 ? { port } : {}),
      logger,
    });
  } catch (e) {
    console.error(`${C.yellow}启动失败：${(e as Error).message}${C.reset}`);
    return 1;
  }

  const staticDir = join(ROOT, 'apps', 'web', 'dist');
  out(`${C.bold}AgentForge 控制台${C.reset}`);
  out(`  ${C.green}${forge.url}${C.reset}`);
  out('');
  out(`  ${C.dim}API：      ${forge.url}/api/state${C.reset}`);
  out(`  ${C.dim}事件流：   ${forge.url}/api/events  (SSE)${C.reset}`);
  if (!existsSync(staticDir)) {
    out('');
    out(`  ${C.yellow}前端尚未构建${C.reset} —— 访问上面的地址会看到构建指引。`);
    out(`  ${C.dim}cd apps/web && npm install && npm run build${C.reset}`);
  }
  out('');
  out(`  ${C.dim}提示：在页面上选「离线演示」即可跑通整套机制，不需要任何 API key。${C.reset}`);
  out(`  ${C.dim}Ctrl+C 停止。${C.reset}`);

  // 保持进程存活直到被信号终止
  await new Promise<void>((res) => {
    const stop = () => {
      void forge.close().then(res);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  runServerCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((e) => {
      console.error((e as Error).stack);
      process.exit(1);
    });
}
