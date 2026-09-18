/**
 * 运行中记录器的测试。
 *
 * 这个文件存在的核心理由：**记录器是「这条记忆有没有用」唯一的数据来源。**
 * 历史无法回填（老 run 的中间轮次发现被覆盖 bug 抹掉了），
 * 所以如果记录器写错、写漏、或者写出的主键与事后摄入不一致，
 * 有效性追踪就会永久停在「无观测」—— 而那种失败**不会以错误的形式出现**，
 * 它只是让系统安静地永远证明不了自己有用。这类「静默失效」必须靠测试挡。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { EventBus } from '../../core/src/index.ts';
import type { AnchorRunResult, GateResult, ForgeEvent } from '../../core/src/index.ts';
import { MemoryRecorder, workspaceKeyOf } from '../src/recorder.ts';
import { ingestWorkspace, findingIdOf } from '../src/ingest.ts';
import { openMemoryDb, type MemoryDb } from '../src/db.ts';

function mem(): MemoryDb {
  return openMemoryDb(':memory:', 'rec-ws');
}

function anchorResult(runId: string, findings: AnchorRunResult['findings']): AnchorRunResult {
  return {
    anchorId: 'A4',
    runId,
    subjects: ['CodeModule-T-01-api'],
    contentHashes: { 'CodeModule-T-01-api': 'a'.repeat(64) },
    verdict: findings.length > 0 ? 'FAIL' : 'PASS',
    findings,
    method: 'real tsc diagnostics',
    authority: 'authoritative',
    at: '2026-02-01T10:00:00.000Z',
    durationMs: 12,
  };
}

const TS2835 = {
  code: 'compile-error',
  severity: 'fail' as const,
  message: 'src/app.ts:1:1 TS2835: relative import needs extension',
  file: 'src/app.ts',
  line: 1,
  targetRole: 'backend' as const,
  data: { tsCode: 'TS2835' },
};

test('记录器：run/anchor/gate 事件走完，发现被写入并**确定地**归属到那个 Gate', async () => {
  const m = mem();
  try {
    const bus = new EventBus();
    const rec = new MemoryRecorder(m);
    rec.attach(bus);

    bus.emit({ t: 'run.started', runId: 'run-ORG-1', brief: '做一个东西', projectName: 'p' } as ForgeEvent);
    bus.emit({ t: 'stage.enter', stage: 'BUILDING' } as ForgeEvent);
    bus.emit({ t: 'anchor.ran', result: anchorResult('run-ORG-1-c1', [TS2835]) } as ForgeEvent);
    bus.emit({
      t: 'gate.evaluated',
      result: {
        stage: 'BUILDING',
        sequence: 1,
        blocked: false,
        hostInvoked: false,
        nextAction: { kind: 'RETRY_ROLE' },
      } as unknown as GateResult,
    } as ForgeEvent);

    const s = rec.snapshot();
    assert.equal(s.runs, 1);
    assert.equal(s.gates, 1);
    assert.equal(s.anchorResults, 1);
    assert.equal(s.findings, 1);
    assert.equal(s.eligibleFindings, 1);

    const row = m.db
      .prepare('SELECT * FROM findings')
      .get() as { finding_id: string; run_id: string; gate_id: string; anchor_round: string; class: string };
    assert.equal(row.class, 'convention:explicit-relative-extension');
    // run_id 是**编排 run**，anchor_round 是**锚点轮次** —— 两者不同名是刻意的
    assert.equal(row.run_id, 'run-ORG-1');
    assert.equal(row.anchor_round, 'run-ORG-1-c1');
    assert.match(row.gate_id, /^run-ORG-1#1-BUILDING$/);

    // 归属是**确定的**（事件按发生顺序到达），不需要事后靠集合相等去反推
    const g = m.db.prepare('SELECT * FROM gates').get() as { action: string; run_id: string };
    assert.equal(g.action, 'RETRY_ROLE');
    assert.equal(g.run_id, 'run-ORG-1');
  } finally {
    m.close();
  }
});

test('记录器：锚点结论在 Gate 之前到达时先缓冲，不会漏记（也不会提前落库）', async () => {
  const m = mem();
  try {
    const bus = new EventBus();
    const rec = new MemoryRecorder(m);
    rec.attach(bus);

    bus.emit({ t: 'run.started', runId: 'run-ORG-2', brief: 'b', projectName: 'p' } as ForgeEvent);
    bus.emit({ t: 'anchor.ran', result: anchorResult('run-ORG-2-c1', [TS2835]) } as ForgeEvent);
    // Gate 还没到 → 不该有 findings（因为 gate_id 还不确定）
    assert.equal((m.db.prepare('SELECT COUNT(*) AS n FROM findings').get() as { n: number }).n, 0);

    bus.emit({
      t: 'gate.evaluated',
      result: { stage: 'REVIEW', sequence: 1, nextAction: { kind: 'ADVANCE' } } as unknown as GateResult,
    } as ForgeEvent);
    assert.equal((m.db.prepare('SELECT COUNT(*) AS n FROM findings').get() as { n: number }).n, 1);
  } finally {
    m.close();
  }
});

test('记录器：run 被中断（有锚点结论但从没等到 Gate）时 finalize 会落库并留空归属', async () => {
  const m = mem();
  try {
    const bus = new EventBus();
    const rec = new MemoryRecorder(m);
    rec.attach(bus);
    bus.emit({ t: 'run.started', runId: 'run-ORG-3', brief: 'b', projectName: 'p' } as ForgeEvent);
    bus.emit({ t: 'anchor.ran', result: anchorResult('run-ORG-3-c1', [TS2835]) } as ForgeEvent);

    const s = await rec.finalize(join(resolve('workspace'), '.tmp-nonexistent'));
    assert.equal(s.findings, 1);
    assert.equal(s.unassignedFindings, 1, '必须如实报告「有 1 条没能归属」，而不是静默丢掉');

    const row = m.db.prepare('SELECT gate_id FROM findings').get() as { gate_id: string | null };
    assert.equal(row.gate_id, null, '归不出来就留空 —— 编一个进去会给审计提供假线索');
  } finally {
    m.close();
  }
});

test('🔴 记录器与事后摄入写出**同一个** finding_id（否则同一次运行会产生两份事实）', async () => {
  const m = mem();
  try {
    const bus = new EventBus();
    const rec = new MemoryRecorder(m);
    rec.attach(bus);
    bus.emit({ t: 'run.started', runId: 'run-ORG-4', brief: 'b', projectName: 'p' } as ForgeEvent);
    bus.emit({ t: 'anchor.ran', result: anchorResult('run-ORG-4-c1', [TS2835]) } as ForgeEvent);
    bus.emit({
      t: 'gate.evaluated',
      result: { stage: 'BUILDING', sequence: 1, nextAction: { kind: 'ADVANCE' } } as unknown as GateResult,
    } as ForgeEvent);

    const recorded = m.db.prepare('SELECT finding_id FROM findings').all() as { finding_id: string }[];
    assert.equal(recorded.length, 1);
    // 两边共用 `findingIdOf`，所以重复记录会走 INSERT OR REPLACE 而不是产生第二行
    assert.equal(recorded[0]!.finding_id, findingIdOf('run-ORG-4-c1', 'A4', 0));
  } finally {
    m.close();
  }
});

test('记录器：订阅者出错不影响总线（记录失败不该让 run 崩掉）', async () => {
  const m = mem();
  try {
    const bus = new EventBus();
    const rec = new MemoryRecorder(m);
    rec.attach(bus);

    // 先制造一个会让写入失败的场景：没有 run.started 就直接发 gate.evaluated
    bus.emit({ t: 'gate.evaluated', result: { stage: 'X' } as unknown as GateResult } as ForgeEvent);

    // 总线本身仍然可用（记录器抛错被它 try/catch 吞掉）
    let seen = 0;
    bus.on(() => { seen++; });
    bus.emit({ t: 'run.started', runId: 'run-ORG-5', brief: 'b', projectName: 'p' } as ForgeEvent);
    assert.equal(seen, 1);
    assert.equal(rec.snapshot().runs, 1);
  } finally {
    m.close();
  }
});

test('记录器：detach 之后不再记录（不会在 run 结束后继续往库里写）', async () => {
  const m = mem();
  try {
    const bus = new EventBus();
    const rec = new MemoryRecorder(m);
    const detach = rec.attach(bus);
    detach();
    bus.emit({ t: 'run.started', runId: 'run-ORG-6', brief: 'b', projectName: 'p' } as ForgeEvent);
    assert.equal(rec.snapshot().runs, 0);
  } finally {
    m.close();
  }
});

test('workspaceKeyOf 稳定且区分不同路径', () => {
  const a = workspaceKeyOf('E:/x/y');
  assert.equal(a, workspaceKeyOf('E:/x/y'));
  assert.notEqual(a, workspaceKeyOf('E:/x/z'));
  assert.equal(a.length, 16);
});

test('记录与摄入对同一段历史给出**一致**的分类结论', async () => {
  // 两条路径（事件流 / 磁盘）必须产生同样的根因类，否则同一件事实在库里会有两种解释。
  const m = mem();
  const dir = join(resolve('workspace'), '.tmp-rec-ingest');
  const { mkdir, writeFile } = await import('node:fs/promises');
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'anchors'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }), 'utf8');
    await writeFile(
      join(dir, 'anchors', 'run-X-c1-001.json'),
      JSON.stringify(anchorResult('run-X-c1', [TS2835])),
      'utf8',
    );
    await ingestWorkspace(m, { workspace: dir });

    const bus = new EventBus();
    const rec = new MemoryRecorder(m);
    rec.attach(bus);
    bus.emit({ t: 'run.started', runId: 'run-Y', brief: 'b', projectName: 'p' } as ForgeEvent);
    bus.emit({ t: 'anchor.ran', result: anchorResult('run-Y-c1', [TS2835]) } as ForgeEvent);
    bus.emit({
      t: 'gate.evaluated',
      result: { stage: 'BUILDING', sequence: 1, nextAction: { kind: 'ADVANCE' } } as unknown as GateResult,
    } as ForgeEvent);

    const classes = m.db
      .prepare('SELECT DISTINCT class FROM findings ORDER BY class')
      .all() as { class: string }[];
    assert.deepEqual(classes.map((c) => c.class), ['convention:explicit-relative-extension']);
  } finally {
    m.close();
    await rm(dir, { recursive: true, force: true });
  }
});
