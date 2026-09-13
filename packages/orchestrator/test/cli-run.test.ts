import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { CONFIG_FILENAME } from '../../llm/src/index.ts';
import { FakeOpenAiServer } from '../../llm/test/fake-server.ts';
import { runCli, deriveProfile } from '../src/cli-run.ts';
import { rolePlayer } from './role-player.ts';

// ════════════════════════════════════════════════════════════════

async function write(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

function collector() {
  const lines: string[] = [];
  return { lines, fn: (s: string) => lines.push(s) };
}

// ════════════════════════════════════════════════════════════════

test('CLI init：生成可解析的模板，且不覆盖已有配置（除非 --force）', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'af-cli-init-'));
  try {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    const o = collector();
    const code = await runCli({ argv: ['init'], cwd, root: cwd, out: o.fn });
    assert.equal(code, 0);
    const path = join(cwd, CONFIG_FILENAME);
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes('"version": 1'));
    assert.ok(o.lines.some((l) => l.includes('已生成配置模板')));

    // 再次 init 应当拒绝覆盖
    const errs: string[] = [];
    const code2 = await runCli({ argv: ['init'], cwd, root: cwd, out: o.fn, err: (s) => errs.push(s) });
    assert.equal(code2, 1);
    assert.ok(errs.some((l) => l.includes('配置已存在')));
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CLI：找不到配置时给出可执行的下一步，而不是抛异常', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'af-cli-nocfg-'));
  try {
    const errs: string[] = [];
    const code = await runCli({ argv: [], cwd, root: cwd, out: () => {}, err: (s) => errs.push(s) });
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.includes('找不到')));
    assert.ok(errs.some((l) => l.includes('cli-run.ts init')), '必须告诉用户下一步怎么做');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CLI：配置有问题时一次性列出全部问题', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'af-cli-badcfg-'));
  try {
    await write(
      cwd,
      CONFIG_FILENAME,
      JSON.stringify({ version: 1, providers: { a: { kind: 'bogus' } }, roles: { pm: { provider: 'nope' } } }),
    );
    const errs: string[] = [];
    const code = await runCli({ argv: [], cwd, root: cwd, out: () => {}, err: (s) => errs.push(s) });
    assert.equal(code, 1);
    const all = errs.join('\n');
    // 「一次把所有问题列清楚」是这个校验器的核心价值：改一个报一个是糟糕的体验
    assert.ok(all.includes('kind'), all);
    assert.ok(all.includes('baseUrl'), all);
    assert.ok(all.includes('defaultModel'), all);
    assert.ok(all.includes('pm.provider'), all);
    assert.ok(all.includes('角色 frontend 没有可用 provider'), all);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CLI：真实 HTTP provider 驱动完整 run，并打印阶段轨迹、账本与成本', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'af-cli-run-'));
  const server = await new FakeOpenAiServer(rolePlayer()).start();
  try {
    const workspace = join(cwd, 'ws');
    await mkdir(workspace, { recursive: true });
    // 工作区脚手架：有依赖、有 scripts（这样 A4/A5 才不会 SKIP）
    //
    // 注意 test 脚本必须输出可解析的测试计数 —— A5 有一条判据是
    // 「声明了测试套件却 0 项通过 → 判 FAIL（假装测过）」，
    // 而 `node -e "0"` 正好会命中它。这不是枷锁，是 A5 正常工作：
    // 它拒绝对「声称有测试但一条都没跑」的情况放行。
    await write(
      workspace,
      'package.json',
      JSON.stringify({
        name: 'cli-ws',
        version: '1.0.0',
        dependencies: { 'leftpad-real': '^1.0.0' },
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          test: 'node -e "console.log(\'# pass 4\\n# fail 0\')"',
        },
      }),
    );
    await write(
      workspace,
      'node_modules/leftpad-real/package.json',
      JSON.stringify({ name: 'leftpad-real', version: '1.0.0', types: 'index.d.ts', main: 'index.js' }),
    );
    await write(workspace, 'node_modules/leftpad-real/index.d.ts', 'export declare function padLeft(s: string, n: number): string;\n');

    await write(
      cwd,
      CONFIG_FILENAME,
      JSON.stringify({
        version: 1,
        providers: { fake: { kind: 'openai-compat', baseUrl: server.baseUrl, defaultModel: 'role-player', jsonMode: 'auto', backoffMs: 1 } },
        roles: {
          pm: { provider: 'fake', model: 'pm-model' },
          frontend: { provider: 'fake', model: 'fe-model' },
          backend: { provider: 'fake', model: 'be-model' },
          test: { provider: 'fake', model: 'test-model' },
          host: { provider: 'fake', model: 'host-model' },
        },
        budget: { totalTokens: 10_000_000, onExceed: 'stop' },
        probe: { enabled: true, useCache: false },
        workspace,
      }),
    );

    const o = collector();
    const errs: string[] = [];
    const code = await runCli({
      argv: ['--brief', '做一个任务看板：能创建任务，也能列出全部任务。'],
      cwd,
      root: cwd,
      out: o.fn,
      err: (s) => errs.push(s),
    });
    const text = o.lines.join('\n');

    assert.equal(code, 0, `stderr: ${errs.join('\n')}`);
    assert.ok(text.includes('Run 报告'));
    assert.ok(text.includes('完整交付'), text);
    assert.ok(text.includes('ADVANCE→DELIVERED'));
    assert.ok(text.includes('精度'.padEnd(0)) || text.includes('precision'), text);
    assert.ok(/成本/.test(text) && /tokens/.test(text), '应打印 token 成本');
    assert.ok(text.includes('离线回放'), '应告诉用户怎么回放');

    // 产物真的落盘了
    const gen = await readFile(join(workspace, 'shared/contract/types.ts'), 'utf8');
    assert.ok(gen.includes('export interface Task'));

    // 调用记录可供回放
    const recPath = text.match(/调用记录：(.+)/)?.[1]?.trim() ?? '';
    assert.ok(recPath.length > 0);
    const jsonl = await readFile(recPath.replace(/\u001b\[\d+m/g, ''), 'utf8');
    assert.ok(jsonl.split('\n').filter((l) => l.trim()).length > 3);
  } finally {
    await server.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CLI：--replay 用已录制调用离线复现，且不发起任何真实请求', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'af-cli-replay-'));
  const server = await new FakeOpenAiServer(rolePlayer()).start();
  let workspace = '';
  let runId = '';
  try {
    workspace = join(cwd, 'ws');
    await mkdir(workspace, { recursive: true });
    await write(
      workspace,
      'package.json',
      JSON.stringify({ name: 'ws', version: '1.0.0', dependencies: { 'leftpad-real': '^1.0.0' }, scripts: {} }),
    );
    await write(
      workspace,
      'node_modules/leftpad-real/package.json',
      JSON.stringify({ name: 'leftpad-real', version: '1.0.0', types: 'index.d.ts', main: 'index.js' }),
    );
    await write(workspace, 'node_modules/leftpad-real/index.d.ts', 'export declare function padLeft(s: string, n: number): string;\n');
    await write(
      cwd,
      CONFIG_FILENAME,
      JSON.stringify({
        version: 1,
        providers: { fake: { kind: 'openai-compat', baseUrl: server.baseUrl, defaultModel: 'role-player', jsonMode: 'auto', backoffMs: 1 } },
        roles: { pm: { provider: 'fake', model: 'm' } },
        probe: { enabled: false },
        workspace,
      }),
    );

    // 首次真实运行（固定 runId 以便回放）
    const first = collector();
    await runCli({ argv: ['--brief', 'x', '--name', 'ws'], cwd, root: cwd, out: first.fn, err: () => {} });

    // 从 runs 目录取出唯一的 runId
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(workspace, 'runs'));
    runId = files.find((f) => f.endsWith('.jsonl'))!.replace(/\.jsonl$/, '');
    assert.ok(runId.length > 0);

    const callsBefore = server.callCount;

    // 回放：把 server 换成一个必然 500 的端点，若回放真的不联网就完全不受影响
    const o = collector();
    const code = await runCli({ argv: ['--replay', runId, '--brief', 'x', '--name', 'ws'], cwd, root: cwd, out: o.fn, err: () => {} });
    assert.equal(code, 0, o.lines.join('\n'));
    assert.ok(o.lines.join('\n').includes('回放模式'));
    assert.ok(o.lines.join('\n').includes('不会发起任何真实请求'));
    assert.equal(server.callCount, callsBefore, '回放期间不得有任何真实请求');
  } finally {
    await server.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CLI deriveProfile：没有 typecheck/test 脚本时如实置空，并明确提示会 SKIPPED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-prof-'));
  try {
    const bare = await deriveProfile(dir, 'x');
    assert.equal(bare.profile.typecheck, null);
    assert.equal(bare.profile.test, null);
    assert.equal(bare.profile.run, null);
    assert.equal(bare.notes.length, 3);
    assert.ok(bare.notes.every((n) => n.includes('SKIPPED')));

    await write(dir, 'package.json', JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }));
    const full = await deriveProfile(dir, 'x');
    assert.deepEqual(full.profile.typecheck, { cmd: 'npm', args: ['run', 'typecheck'] });
    assert.deepEqual(full.profile.test, { cmd: 'npm', args: ['run', 'test'] });
    // 没有 start 脚本 → A6 诚实报 SKIPPED（不假定它能跑起来）
    assert.equal(full.profile.run, null);
    assert.equal(full.notes.length, 1);
    assert.ok(full.notes[0].includes('start/dev'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI deriveProfile：只有声明了 healthUrl 才会配置 A6 的运行时探针（绝不猜端口）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-prof-run-'));
  try {
    // 有启动脚本但没声明 healthUrl → 依然 SKIPPED，并说清缺的是哪一半
    await write(dir, 'package.json', JSON.stringify({ scripts: { start: 'node src/api/server.ts' } }));
    const noUrl = await deriveProfile(dir, 'x');
    assert.equal(noUrl.profile.run, null, '猜一个默认端口只会让 A6 时而探到别的进程');
    assert.ok(noUrl.notes.some((n) => n.includes('healthUrl')), JSON.stringify(noUrl.notes));

    // 显式声明 → A6 真的有东西可查
    await write(
      dir,
      'package.json',
      JSON.stringify({
        scripts: { start: 'node src/api/server.ts' },
        agentforge: { healthUrl: 'http://127.0.0.1:8787/health' },
      }),
    );
    const full = await deriveProfile(dir, 'x');
    assert.deepEqual(full.profile.run, {
      cmd: 'npm',
      args: ['start'],
      healthUrl: 'http://127.0.0.1:8787/health',
    });

    // dev 脚本是后备
    await write(
      dir,
      'package.json',
      JSON.stringify({ scripts: { dev: 'node src/api/server.ts' }, agentforge: { healthUrl: 'http://127.0.0.1:8787/health' } }),
    );
    const viaDev = await deriveProfile(dir, 'x');
    assert.deepEqual(viaDev.profile.run?.args, ['dev']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI deriveProfile：环境约束由项目声明并被带进 profile（不硬编码沙箱特性）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-prof-env-'));
  try {
    // 没声明 → 不带（引擎不替项目编造约束）
    await write(dir, 'package.json', JSON.stringify({ scripts: {} }));
    assert.equal((await deriveProfile(dir, 'x')).profile.environmentNotes, undefined);

    // 声明了 → 原样带上，供角色提示词注入
    const notes = [
      '相对导入必须带显式 `.ts` 扩展名。',
      '禁止在测试中 spawn 子进程（受限环境会 EPERM）。',
    ];
    await write(dir, 'package.json', JSON.stringify({ scripts: {}, agentforge: { environmentNotes: notes } }));
    assert.deepEqual((await deriveProfile(dir, 'x')).profile.environmentNotes, notes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
