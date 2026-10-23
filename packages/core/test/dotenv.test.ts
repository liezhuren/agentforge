/**
 * `.env` 加载器的测试。
 *
 * 这个文件存在的理由：`.env` 是**唯一**允许在本机存明文密钥的地方，
 * 而它是否真的生效、是否会被环境变量覆盖、会不会把值打印出来 ——
 * 每一条错了都会以「我配了但没生效」或「密钥进了终端日志」的形式出现，
 * 而这两种都不会在正常路径上报错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describeDotEnv, loadDotEnv } from '../src/dotenv.ts';

/** 建一个只放 .env 的临时目录。 */
async function withEnvDir(content: string | null): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'af-dotenv-'));
  if (content !== null) await writeFile(join(dir, '.env'), content, 'utf8');
  return { dir, done: async () => { await rm(dir, { recursive: true, force: true }); } };
}

test('.env：基础解析 —— KEY=VALUE、注释、空行、export 前缀、成对引号', async () => {
  const f = await withEnvDir(
    [
      '# 注释行',
      '',
      'A=1',
      'export B=2',
      'C="带 空格"',
      "D='单引号'",
      '  E = 两端空格  ',
    ].join('\n'),
  );
  try {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotEnv({ cwd: f.dir, env });
    assert.equal(r.loaded, 5);
    assert.equal(env['A'], '1');
    assert.equal(env['B'], '2', 'export 前缀必须被剥掉');
    assert.equal(env['C'], '带 空格', '成对双引号需要去掉');
    assert.equal(env['D'], '单引号');
    assert.equal(env['E'], '两端空格', '等号两端的空格不属于值');
    assert.deepEqual(r.skipped, []);
  } finally {
    await f.done();
  }
});

test('🔴 .env：已存在的环境变量**优先**，不被文件覆盖', async () => {
  const f = await withEnvDir('K=from-file\nOTHER=x\n');
  try {
    const env: NodeJS.ProcessEnv = { K: 'from-env' };
    const r = loadDotEnv({ cwd: f.dir, env });
    assert.equal(env['K'], 'from-env', '真实环境必须优先 —— 否则「我在命令行设了为什么不生效」极难查');
    assert.equal(env['OTHER'], 'x');
    assert.deepEqual(r.keptExisting, ['K']);
    assert.equal(r.loaded, 1);
  } finally {
    await f.done();
  }
});

test('.env：格式不对的行会**报出行号**，而不是静默丢掉', async () => {
  const f = await withEnvDir(['GOOD=1', '没有等号的一行', '1BAD=x', '=novalue'].join('\n'));
  try {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotEnv({ cwd: f.dir, env });
    assert.equal(env['GOOD'], '1');
    assert.equal(r.loaded, 1);
    assert.equal(r.skipped.length, 3, '三行不合法都要被记录下来');
    assert.match(r.skipped[0]!, /^2:/, '要带行号');
    assert.ok(env['1BAD'] === undefined, '非法变量名不得注入');
  } finally {
    await f.done();
  }
});

test('.env：带 BOM 时第一个键名仍然可用（否则会静默失效）', async () => {
  const f = await withEnvDir('\uFEFFFIRST=ok\nSECOND=2\n');
  try {
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ cwd: f.dir, env });
    assert.equal(env['FIRST'], 'ok', 'BOM 会被算进键名，必须剥掉');
    assert.equal(env['SECOND'], '2');
  } finally {
    await f.done();
  }
});

test('.env：文件不存在不是错误（用真实环境变量是合法用法）', async () => {
  const f = await withEnvDir(null);
  try {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotEnv({ cwd: f.dir, env });
    assert.equal(r.file, null);
    assert.equal(r.loaded, 0);
    assert.deepEqual(r.skipped, []);
    assert.match(describeDotEnv(r), /未找到/);
  } finally {
    await f.done();
  }
});

test('.env：默认写进 process.env（唯一一处允许改全局的地方），事后可清理', async () => {
  const f = await withEnvDir('AF_DOTENV_PROBE=hello\n');
  try {
    delete process.env['AF_DOTENV_PROBE'];
    const r = loadDotEnv({ cwd: f.dir });
    assert.equal(process.env['AF_DOTENV_PROBE'], 'hello');
    assert.equal(r.loaded, 1);
  } finally {
    delete process.env['AF_DOTENV_PROBE'];
    await f.done();
  }
});

test('🔴 describeDotEnv 只报键名，绝不打印值（密钥不能进终端日志）', async () => {
  const f = await withEnvDir('MY_SECRET=super-secret-value\n');
  try {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotEnv({ cwd: f.dir, env });
    const line = describeDotEnv(r);
    assert.ok(line.includes('MY_SECRET'), '应当报出注入了哪些键');
    assert.ok(!line.includes('super-secret-value'), '绝不能打印值');
  } finally {
    await f.done();
  }
});

test('.env：空值也照常注入（`KEY=` 是合法的「先留位」写法）', async () => {
  const f = await withEnvDir('EMPTY=\n');
  try {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotEnv({ cwd: f.dir, env });
    assert.equal(env['EMPTY'], '');
    assert.equal(r.loaded, 1);
  } finally {
    await f.done();
  }
});
