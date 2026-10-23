/**
 * 决策日志的**落盘顺序**必须与 seq 一致。
 *
 * ## 背景：一个偶发的断链
 *
 * `append()` 先把条目 push 到内存（seq 此时确定），再 `await appendFile()`。
 * 而调用方并不总是 await —— 编排器里有多处 `void this.log?.append(...)`。
 * 两个 append 并发时，各自写文件的完成顺序不受控，于是**文件里的行序可能
 * 与 seq 不一致**：seq 16 先落盘、seq 15 后落盘。
 *
 * `verify()` 按文件行序逐条比对 seq，于是报「序号不连续（期望 15）」——
 * 而日志内容其实一条没丢、一条没改。
 *
 * 实测是**偶发**的：同一个 e2e 用例跑 3 次，1 次失败。
 * 偶发比稳定失败更麻烦：CI 与现场演示会随机翻车，而且一看到「哈希链断了」
 * 第一反应是查「是不是被篡改」—— 方向完全错。
 *
 * 修法：写入串成 Promise 链，保证**落盘顺序 === seq 顺序**。本文件守这条。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DecisionLog } from '../src/decisionlog.ts';

test('🔴 决策日志：并发 append 之后，文件行序必须与 seq 一致、链必须完整', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-dlog-order-'));
  try {
    const log = new DecisionLog(dir);
    await log.init();

    // 关键：**不 await**，一次性放出去 —— 模拟编排器里的 `void log.append(...)`。
    // 条目带一点体积，让写入耗时更接近真实情况（真实 payload 常有几 KB）。
    const N = 200;
    const payload = { blob: 'x'.repeat(500) };
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) pending.push(log.append('stage.entered', payload));
    await Promise.all(pending);

    // 1) 内存里的条目数与顺序
    assert.equal(log.length, N);

    // 2) 文件里的行序必须严格递增 1..N
    const raw = await readFile(join(dir, 'decisions.jsonl'), 'utf8');
    const seqs = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    assert.equal(seqs.length, N, '并发写入不能丢行');
    assert.deepEqual(
      seqs,
      Array.from({ length: N }, (_, i) => i + 1),
      '文件行序必须与 seq 一致 —— 否则 verify() 会误报「哈希链断裂」',
    );

    // 3) 链本身必须完整
    assert.deepEqual(await log.verify(), { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('决策日志：一次写入失败不会让后续 append 全部卡死', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-dlog-fail-'));
  try {
    const log = new DecisionLog(dir);
    await log.init();

    // 先正常写一条，确认基线
    await log.append('run.started', { project: 'x', brief: 'b' });

    // 把目标路径换成一个不可能写入的目录，制造一次失败
    const realPath = (log as unknown as { path: string }).path;
    (log as unknown as { path: string }).path = join(dir, 'no-such-dir', 'decisions.jsonl');

    let threw = false;
    try {
      await log.append('stage.entered', { stage: 'INTAKE' });
    } catch {
      threw = true;
    }
    assert.ok(threw, '写入失败必须抛给调用方，而不是静默吞掉');

    // 恢复路径 → 后续 append 必须还能成功（链不能被一次失败卡死）
    (log as unknown as { path: string }).path = realPath;
    const e = await log.append('stage.entered', { stage: 'PLANNING' });
    assert.ok(e.seq > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
