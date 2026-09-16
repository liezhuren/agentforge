/**
 * 验证器上下文的构造规则。
 *
 * ## 为什么这些测试重要（一次真实测量）
 *
 * 12 轮真实运行的工件里，旧实现（每个工件 `JSON.stringify(content, null, 2).slice(0, 8000)`）
 * **截断了 57 个工件中的 30 个**，上下文平均只显示了 **66%** 的内容，
 * 最差的两轮只有 44% / 48%。而验证者的工作恰恰是「在代码里找需求被实现的证据」——
 * 把它要看的代码切掉一半，然后怪它说「确认不了」，是拿错了工具去回答问题。
 *
 * 这些测试守的是三条规则：
 *   1. **按文件给预算**（而不是按整个文档切）—— 实测 150 个文件里只有 8 个超过 8000 字符，
 *      所以按文件切能保住 142 个完整，按文档切只保住 47%。
 *   2. **代码带真实行号**（验证者必须引用行号区间；JSON 转义会把整个文件压成一行，没法数行）。
 *   3. **截断必须说出来** —— 静默截断等于让模型以为「没看到的部分不存在」，
 *      那正是「未验证 ≠ 通过」这条不变量在提示词层面的对应物。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { ArtifactStore, silentLogger } from '../../core/src/index.ts';
import { buildVerifierContext, numberLines, VERIFIER_CONTEXT_BUDGETS } from '../src/verify.ts';

async function fixture(): Promise<{
  root: string;
  store: ArtifactStore;
  ctx(): Parameters<typeof buildVerifierContext>[0];
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'af-vctx-'));
  const store = new ArtifactStore(root);
  await store.init();
  // 需求工件是必须的（没有它验证器直接返回）
  await store.put({
    kind: 'Requirement',
    producer: 'pm',
    content: {
      requirements: [
        { id: 'R-001', text: '用户可以创建任务', acceptance: ['POST /api/tasks 返回 201'], priority: 'must', status: 'open', origin: 'user' },
      ],
    },
  });
  const ctx = () =>
    ({
      stage: 'REVIEW',
      store,
      profile: { name: 't', language: 'typescript', srcDir: 'src', tsconfigPath: 'tsconfig.json', typecheck: null, test: null, run: null, knownPackages: [], dependencyAllowlist: null },
      workOrders: [],
      contractHash: null,
      directives: [],
      userBrief: '做一个任务看板',
      logger: silentLogger('vctx'),
    }) as never;
  return { root, store, ctx, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 造一个多文件 TestSuite：每个文件都不大，但**总和**远超旧的 8000 字符总闸门。 */
async function putTestSuite(store: ArtifactStore, files: Array<{ path: string; content: string }>) {
  return store.put({ kind: 'TestSuite', producer: 'test', content: { framework: 'node:test', files, covers: ['R-001'] } });
}

test('上下文：按**文件**给预算 —— 总长超 8000 但每个文件都小 ⇒ 一个字都不截断', async () => {
  // 这正是旧实现的回归用例：旧代码对整个文档 slice(0, 8000)，
  // 于是一个 6 文件、总计 2 万字符的 TestSuite 会被从中间切断，
  // 而每个文件其实都远小于上限。
  const f = await fixture();
  try {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `tests/file-${i + 1}.test.ts`,
      content: Array.from({ length: 80 }, (_, l) => `// 文件 ${i + 1} 第 ${l + 1} 行：一些测试代码内容 filler`).join('\n'),
    }));
    const total = files.reduce((n, x) => n + x.content.length, 0);
    assert.ok(total > 8000, `前提：总长必须超过旧的 8000 总闸门（实际 ${total}）`);
    for (const x of files) {
      assert.ok(x.content.length < VERIFIER_CONTEXT_BUDGETS.perFile, `前提：单文件必须小于 perFile（${x.content.length}）`);
    }

    await putTestSuite(f.store, files);
    const { messages, stats } = buildVerifierContext(f.ctx());
    const text = messages.map((m) => m.content).join('\n');

    assert.equal(stats.filesTruncated, 0, '每个文件都小于 perFile 预算，不该有任何截断');
    for (const x of files) {
      assert.ok(text.includes(x.path), `文件 ${x.path} 必须完整出现在上下文里`);
      assert.ok(text.includes(`// 文件 ${x.path.match(/\d+/)![0]} 第 80 行`), `${x.path} 的最后一行也必须可见`);
    }
    assert.equal(stats.files, 6);
  } finally {
    await f.cleanup();
  }
});

test('上下文：代码带**真实行号**，且行号与原文对得上', async () => {
  const f = await fixture();
  try {
    const content = ['const a = 1;', 'const b = 2;', 'export const c = a + b;'].join('\n');
    await putTestSuite(f.store, [{ path: 'tests/x.test.ts', content }]);
    const { messages } = buildVerifierContext(f.ctx());
    const text = messages.map((m) => m.content).join('\n');

    // 行号是 1-based，且内容逐行对应
    assert.ok(/\b1\| const a = 1;/.test(text), `第 1 行应带行号 1：\n${text}`);
    assert.ok(/\b2\| const b = 2;/.test(text), '第 2 行应带行号 2');
    assert.ok(/\b3\| export const c = a \+ b;/.test(text), '第 3 行应带行号 3');
    // 必须是真换行，不是 JSON 转义出来的字面 `\n`
    assert.ok(!text.includes('\\nconst b'), '代码不能被 JSON 转义成单行 —— 那样没法数行号');
  } finally {
    await f.cleanup();
  }
});

test('numberLines：补齐宽度但绝不改动内容', () => {
  assert.equal(numberLines('a\nb', 1), '1| a\n2| b');
  // 行数跨到两位数时右侧对齐，内容一字不动
  const ten = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  const out = numberLines(ten, 1);
  assert.ok(out.split('\n')[0]!.startsWith(' 1| line0'), out.split('\n')[0]);
  assert.ok(out.split('\n')[9]!.startsWith('10| line9'), out.split('\n')[9]);
  // 从任意起始行开始（用于将来渲染片段）
  assert.equal(numberLines('x', 42), '42| x');
});

test('上下文：文件确实超预算时必须**说出**截断，而不是静默切断', async () => {
  const f = await fixture();
  try {
    const cap = VERIFIER_CONTEXT_BUDGETS.perFile;
    const lines = Array.from({ length: 4000 }, (_, i) => `// 第 ${i + 1} 行填充内容 filler filler filler`);
    const content = lines.join('\n');
    assert.ok(content.length > cap, `前提：内容必须超过 perFile（${content.length} vs ${cap}）`);

    await putTestSuite(f.store, [{ path: 'tests/huge.test.ts', content }]);
    const { messages, stats } = buildVerifierContext(f.ctx());
    const text = messages.map((m) => m.content).join('\n');

    assert.equal(stats.filesTruncated, 1, '应当被记为一次截断');
    assert.match(text, /另有 \d+ 行（共 4000 行）未显示/, '必须说明还有多少行没显示');
    assert.match(text, /不要据此判 met/, '必须明确警告：没看到的部分不能拿来判达成');
  } finally {
    await f.cleanup();
  }
});

test('上下文：整块省略时必须在 stats 里列出省了谁（安全阀不能是静默的）', async () => {
  const f = await fixture();
  try {
    // 用很多大文件把总预算撑爆
    const big = Array.from({ length: 300 }, (_, i) => `// 行 ${i} 填充填充填充填充填充填充填充填充填充填充`).join('\n');
    const files = Array.from({ length: 30 }, (_, i) => ({ path: `tests/big-${i}.ts`, content: big }));
    await putTestSuite(f.store, files);

    const { stats } = buildVerifierContext(f.ctx());
    assert.ok(stats.omitted.length > 0, '超过总预算时必须省略后面的工件');
    assert.ok(
      stats.omitted.every((id) => typeof id === 'string' && id.length > 0),
      '省略清单里必须是被省略工件的真实 id',
    );
  } finally {
    await f.cleanup();
  }
});

test('上下文：结构化工件（需求/契约）仍然按 JSON 渲染，且保留原有内容', async () => {
  const f = await fixture();
  try {
    const { messages, stats } = buildVerifierContext(f.ctx());
    const text = messages.map((m) => m.content).join('\n');
    assert.ok(text.includes('R-001'), '需求工件必须进上下文');
    assert.ok(text.includes('POST /api/tasks 返回 201'), '验收条件必须能看到');
    assert.equal(stats.artifacts, 1);
    assert.equal(stats.chars, messages.reduce((n, m) => n + m.content.length, 0), 'chars 必须与消息总长一致');
  } finally {
    await f.cleanup();
  }
});

test('上下文：机械检查事实必须进上下文（否则验证者只能对运行时验收项报「确认不了」）', async () => {
  const f = await fixture();
  try {
    await f.store.recordAnchorResult({
      anchorId: 'A5',
      runId: 'run-x-001',
      subjects: [],
      contentHashes: {},
      verdict: 'PASS',
      findings: [],
      method: 'test',
      authority: 'authoritative',
      at: new Date().toISOString(),
      durationMs: 1,
      meta: { passed: 7, failed: 0, exitCode: 0, command: 'npm run test' },
    } as never);

    const { messages } = buildVerifierContext(f.ctx());
    const text = messages.map((m) => m.content).join('\n');
    assert.match(text, /A5 \[PASS\]/, '锚点结论必须出现');
    assert.ok(text.includes('passed=7'), `退出码/通过数必须可见：\n${text.slice(0, 400)}`);
    assert.match(text, /机械检查通过 \*\*不等于\*\* 需求达成/, '必须同时警告「机械通过 ≠ 需求达成」');
  } finally {
    await f.cleanup();
  }
});
