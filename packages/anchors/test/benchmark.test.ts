import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SAMPLES, SAMPLE_STATS } from '../bench/samples.ts';
import { runBenchmark, type BenchSummary } from '../bench/harness.ts';

/**
 * 把幻觉靶场锁进 `npm test`。
 *
 * 断言的两条不变量，按重要性排序：
 *
 *   1. **干净对照样本不得出现任何硬失败**（0 误报）
 *      这条最硬 —— 误报比漏报更隐蔽：它表现为「角色被派去修一个不存在的问题」，
 *      没人会为此报 bug，但它在持续消耗轮次和钱。
 *
 *   2. **注入样本必须被抓到**，除非该样本用 `knownLimitation` 明确记录了原因。
 *      这样「诚实记录已知缺口」与「CI 变红」不必二选一，
 *      但代价是：想放过一个漏报，你必须写下为什么。
 *
 * 刻意**不**断言「检出率 100%」这种数字型断言 —— 那会变成
 * 「锚点必须通过我自己出的题」，是自证。断言的是可解释的不变量。
 */
let cached: BenchSummary | null = null;

async function bench(): Promise<BenchSummary> {
  if (cached) return cached;
  cached = await runBenchmark(SAMPLES, {
    makeRoot: () => mkdtemp(join(tmpdir(), 'af-bench-test-')),
    cleanupRoot: (r) => rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }),
    offline: true,
  });
  return cached;
}

test('幻觉靶场：干净对照样本必须零误报（这是最硬的不变量）', async () => {
  const s = await bench();
  assert.ok(SAMPLE_STATS.clean >= 8, `对照组太少（${SAMPLE_STATS.clean} 个），测不出误报率`);

  const fps = s.results.filter((r) => r.outcome === 'FP');
  assert.deepEqual(
    fps.map((r) => `${r.sample.id}: ${r.detail}`),
    [],
    '干净样本被误判成有问题 —— 误报会把角色派去修一个不存在的问题',
  );
  assert.equal(s.cleanPassRate, 1, `干净通过率 ${s.cleanPassRate}`);
});

test('幻觉靶场：注入样本必须被检出（已知缺口须显式记录原因）', async () => {
  const s = await bench();
  const unexplained = s.results.filter((r) => r.outcome === 'FN' && !r.sample.knownLimitation);
  assert.deepEqual(
    unexplained.map((r) => `${r.sample.id}: ${r.detail}`),
    [],
    '这些漏报没有 knownLimitation 说明 —— 要么修锚点，要么写清楚为什么暂时不修',
  );
  assert.ok(SAMPLE_STATS.injected >= 15, `注入样本太少（${SAMPLE_STATS.injected} 个）`);
});

test('幻觉靶场：关键锚点各自的召回率不是 0（防止某个锚点整体失效）', async () => {
  const s = await bench();
  // 这七个锚点是防幻觉的主干。任何一个整体失效都应当立刻被发现。
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A7', 'B1', 'B2'] as const) {
    const m = s.metrics.get(id);
    assert.ok(m, `靶场里没有覆盖锚点 ${id}`);
    assert.ok(m!.positives > 0, `锚点 ${id} 没有正例样本，无法判断它是否有效`);
    assert.ok(
      m!.recall > 0,
      `锚点 ${id} 一个正例都没抓到（漏报 ${m!.missed}/${m!.positives}）—— 它可能整体失效了`,
    );
  }
});

test('幻觉靶场：覆盖了 SKIPPED ≠ PASS 这条不变量', async () => {
  const s = await bench();
  const notPass = s.results.filter((r) => r.sample.expect.kind === 'not-pass');
  assert.ok(notPass.length >= 2, '至少要有「工具链缺失」与「未配置测试命令」两条未验证样本');
  for (const r of notPass) {
    assert.notEqual(r.outcome, 'FN', `${r.sample.id}：${r.detail}`);
  }
});

test('幻觉靶场：A7 的端点覆盖检查不能被注释骗过', async () => {
  const s = await bench();
  const r = s.results.find((x) => x.sample.id === 'A7-07-endpoint-only-in-comment');
  assert.ok(r, '缺少「端点只出现在注释里」这条样本');
  // 这条样本是靶场自己跑出来的真实弱点：子串匹配会被注释里的路径骗过。
  assert.equal(r!.outcome, 'TP', `注释里的端点路径不该让 A7 认为它已实现：${r!.detail}`);
});

test('幻觉靶场：A5 在「命令成功但没解析出任何计数」时不得声称通过', async () => {
  const s = await bench();
  const r = s.results.find((x) => x.sample.id === 'A5-05-unparseable-output');
  assert.ok(r, '缺少「测试输出不可解析」这条样本');
  assert.equal(r!.outcome, 'TP', `退出码 0 不等于测试通过：${r!.detail}`);
});
