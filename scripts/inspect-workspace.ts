/**
 * **独立复核**一个工作区：绕开锚点系统，自己真跑一遍，把原始证据打出来。
 *
 * ## 为什么需要它（这是「验证验证者」的那一步）
 *
 * 语义验证器现在会说 `met` 或 `not-met` 而不是含糊的 `uncertain`。**这只是它敢下结论了，
 * 不代表结论是对的。** 一个愿意说「达成了」的验证器，如果没人复核，就从「说不清」
 * 变成了「自信地说错」—— 那比原来更糟，因为它更难被发现。
 *
 * 所以每一条从 uncertain 翻转过来的判定，都必须在这里被独立验证一次。
 *
 * 它与 `verify-real-app.ts` 的第二段是同一个思路：**不引用任何锚点结论**，
 * 直接对工作区做真编译 / 真测试 / 真启动 + 真 HTTP。
 * 区别是它不生成项目，只复核一个**已存在**的工作区。
 *
 * 这个脚本**不下判断** —— 它把事实摊开，判断由人（或调用它的 agent）来做。
 * 一个自己下判断的复核工具，本身又成了需要被复核的东西。
 *
 * 用法：
 *   node scripts/inspect-workspace.ts workspace/llm-9
 *   node scripts/inspect-workspace.ts workspace/llm-9 --no-server    # 跳过启动服务
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { execCapture, prepareSpawn } from '../packages/core/src/exec.ts';

const argv = process.argv.slice(2);
const ws = argv.find((a) => !a.startsWith('--'));
const skipServer = argv.includes('--no-server');
if (!ws) {
  console.error('用法: node scripts/inspect-workspace.ts <工作区> [--no-server]');
  process.exit(1);
}

const ROOT = (await import('node:path')).resolve(ws);
console.log(`工作区: ${ROOT}\n`);

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
  agentforge?: { healthUrl?: string };
};

// ── 1. 真编译 ──────────────────────────────────────────────────
if (pkg.scripts?.typecheck) {
  const r = await execCapture('', {
    cwd: ROOT,
    trusted: { cmd: 'npm', args: ['run', 'typecheck'] },
    timeoutMs: 180_000,
  });
  console.log(`【编译】npm run typecheck → exit ${r.exitCode}`);
  const out = (r.stdout + r.stderr).trim();
  if (out) console.log(out.split('\n').slice(0, 12).map((l) => `    ${l}`).join('\n'));
  console.log('');
}

// ── 2. 真跑测试 ────────────────────────────────────────────────
if (pkg.scripts?.test) {
  const r = await execCapture('', {
    cwd: ROOT,
    trusted: { cmd: 'npm', args: ['run', 'test'] },
    timeoutMs: 180_000,
  });
  const text = r.stdout + r.stderr;
  console.log(`【测试】npm run test → exit ${r.exitCode}`);
  // node:test 的汇总行（pass/fail）
  const summary = text.split('\n').filter((l) => /^# (pass|fail|tests)\b|^ℹ (pass|fail|tests)\b/.test(l.trim()));
  for (const l of summary) console.log(`    ${l.trim()}`);
  // 测试文件名清单 —— 用来核对「验收条件里说的断言用例是否真的存在」
  try {
    const names = await readdir(ROOT, { recursive: true });
    const tests = names.filter((n) => /\.test\.ts$/.test(n));
    console.log(`    测试文件: ${tests.join(', ') || '(无)'}`);
  } catch {
    /* 忽略 */
  }
  // 失败用例名（如果有）
  const failures = text.split('\n').filter((l) => /^\s*✖|not ok/.test(l));
  if (failures.length) {
    console.log(`    失败用例（前 10 条）:`);
    for (const l of failures.slice(0, 10)) console.log(`      ${l.trim()}`);
  }
  console.log('');
}

// ── 3. 真启动 + 真 HTTP ───────────────────────────────────────
const healthUrl = pkg.agentforge?.healthUrl;
if (!skipServer && pkg.scripts?.start && healthUrl) {
  const origin = new URL(healthUrl).origin;
  const apiBase = `${origin}/api/tasks`;
  console.log(`【运行】npm start → 探针 ${healthUrl} / API ${apiBase}`);

  const { spawn } = await import('node:child_process');
  const { mkdtemp, open } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const logDir = await mkdtemp(join(tmpdir(), 'af-inspect-'));
  const outFd = await open(join(logDir, 'out.log'), 'w');
  const errFd = await open(join(logDir, 'err.log'), 'w');
  // 必须走项目自己的封装（core/src/exec.ts）：
  //   - Windows 上 `spawn('npm')` 直接 ENOENT，`spawn('npm.cmd')` 抛 EINVAL
  //   - `shell: true` 会触发 DEP0190（参数不转义，只拼接）
  //   - stdio 必须重定向到**文件**：本环境禁止管道式 stdio，用 pipe 会 EPERM
  const prepared = prepareSpawn('npm', ['start']);
  const child = spawn(prepared.cmd, prepared.args, {
    cwd: ROOT,
    stdio: ['ignore', outFd.fd, errFd.fd],
    shell: prepared.shell,
    windowsHide: true,
  });

  // spawn 失败是**异步事件**，try/catch 挡不住；不挂监听会让整个进程被未处理事件打死
  let spawnError: Error | null = null;
  child.on('error', (e) => {
    spawnError = e;
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let ready = false;
  void spawnError;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(300);
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(healthUrl);
      ready = res.ok;
      console.log(`    GET ${healthUrl} → ${res.status} ${JSON.stringify(await res.json().catch(() => null))}`);
    } catch {
      /* 还没起来 */
    }
  }

  if (!ready) {
    console.log(`    ✗ 服务未能就绪（exitCode=${child.exitCode}）`);
  } else {
    const post = async (title: string) => {
      const res = await fetch(apiBase, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    };

    const p1 = await post('写周报');
    console.log(`    POST 第 1 次 → ${p1.status} ${JSON.stringify(p1.body)}`);
    const p2 = await post('写周报');
    console.log(`    POST 第 2 次（同 title）→ ${p2.status} ${JSON.stringify(p2.body)}`);
    console.log(`    两次 id 不同？ ${p1.body?.['id'] !== p2.body?.['id'] ? '是' : '**否**'}`);
    console.log(
      `    响应含 id/title/done？ id=${typeof p1.body?.['id']} title=${JSON.stringify(p1.body?.['title'])} done=${JSON.stringify(p1.body?.['done'])}`,
    );

    const g = await fetch(apiBase);
    const gb = (await g.json().catch(() => null)) as unknown;
    console.log(`    GET ${apiBase} → ${g.status} 顶层是数组？ ${Array.isArray(gb) ? '是' : '**否**'} 长度=${Array.isArray(gb) ? gb.length : 'n/a'}`);
    if (Array.isArray(gb)) {
      const found = gb.find((x) => (x as Record<string, unknown>)['id'] === p1.body?.['id']);
      console.log(`    写后读：能找到刚创建的 id？ ${found ? '是' : '**否**'} → ${JSON.stringify(found)}`);
      const shapes = gb.map(
        (x) => `id:${typeof (x as Record<string, unknown>)['id']} title:${typeof (x as Record<string, unknown>)['title']} done:${typeof (x as Record<string, unknown>)['done']}`,
      );
      console.log(`    元素形状: ${[...new Set(shapes)].join(' | ')}`);
    }
  }

  child.kill();
  await outFd.close().catch(() => {});
  await errFd.close().catch(() => {});
  const errText = await readFile(join(logDir, 'err.log'), 'utf8').catch(() => '');
  if (errText.trim()) console.log(`    服务 stderr: ${errText.trim().split('\n').slice(0, 3).join(' / ')}`);
  console.log('');
}

// ── 4. 前端数据层的导出（验收里点名要求的部分）────────────────
const webDir = join(ROOT, 'src', 'web');
if (existsSync(webDir)) {
  const files = await readdir(webDir);
  console.log(`【前端数据层】src/web/ 下的文件: ${files.join(', ')}`);
  for (const f of files.filter((x) => x.endsWith('.ts'))) {
    const text = await readFile(join(webDir, f), 'utf8');
    const exports = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)].map((m) => m[1]);
    console.log(`    ${f} 导出: ${exports.join(', ') || '(无)'}`);
  }
  console.log('');
}
