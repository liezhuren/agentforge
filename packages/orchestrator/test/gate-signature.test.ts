/**
 * Gate 的「失败签名」——它是「修复无效」判定的唯一依据。
 *
 * 这组测试守的是一个**让 REVIEW 无限重试**的真实 bug（2026-10-24）：
 *
 * `gate.ts` 有两条产出路径。A 层（编译/测试/探针/契约/基准）失败那条把签名算对了，
 * 而 **B 层（B1 需求达成 / B2 需求覆盖）失败那条把签名写成了 `null`**。
 * 偏偏 REVIEW 阶段的阻断绝大多数来自 B 层 —— 于是
 * `signature === lastHardFailureSignature` 永远不成立，「修复无效」永远检测不到。
 *
 * cb-15 的实测就是这样：REVIEW seq3 与 seq4 的失败完全同构
 * （B1:evidence-invalid ×15 + B2:deliverable-missing ×2 + B3:objection-evidence-invalid），
 * 本应在 seq4 判无效 → 带债通过，实际一路 RETRY 到 seq5 被环境回收。
 *
 * 教训：**签名只覆盖一半的阻断来源，比没有签名更糟** ——
 * 它会让「有收敛」和「没收敛」看起来一模一样。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockSignature, signatureParts } from '../src/gate.ts';
import type { AnchorRunResult, AnchorFinding } from '../../core/src/types.ts';

/** 造一个最小可用的锚点结果。 */
function anchor(anchorId: string, findings: Array<Partial<AnchorFinding> & { code: string }>): AnchorRunResult {
  return {
    anchorId,
    verdict: findings.some((f) => (f.severity ?? 'fail') === 'fail') ? 'FAIL' : 'PASS',
    findings: findings.map((f) => ({ severity: 'fail', message: 'x', ...f })) as AnchorFinding[],
    method: 'test',
    authority: 'authoritative',
    subjects: [],
    contentHashes: {},
    at: '2026-10-24T00:00:00.000Z',
    durationMs: 0,
  } as unknown as AnchorRunResult;
}

test('🔴 只有 B 层失败、没有 A 层失败时，签名**必须**非空（这就是那个 bug）', () => {
  const b1 = anchor('B1', [{ code: 'evidence-invalid', file: undefined }]);
  const b2 = anchor('B2', [{ code: 'deliverable-missing' }]);
  const sig = blockSignature({ failures: [b1, b2], objectionIds: [], blocked: true });
  assert.notEqual(sig, null, 'B 层阻断也必须有签名，否则「修复无效」永远判不出来');
  assert.ok(sig!.includes('B1:evidence-invalid'));
  assert.ok(sig!.includes('B2:deliverable-missing'));
});

test('🔴 同一批 B 层失败连续两轮 → 签名相同（这才是「修复无效」能触发的前提）', () => {
  const round = () =>
    blockSignature({
      failures: [
        anchor('B1', Array.from({ length: 15 }, () => ({ code: 'evidence-invalid' }))),
        anchor('B2', [{ code: 'deliverable-missing' }, { code: 'deliverable-missing' }]),
        anchor('B3', [{ code: 'objection-evidence-invalid' }]),
      ],
      objectionIds: [],
      blocked: true,
    });
  assert.equal(round(), round(), 'cb-15 的 seq3/seq4 就是这种情况');
});

test('措辞变了、code/文件/行没变 → 签名不变（粒度必须忽略消息正文）', () => {
  const a = blockSignature({
    failures: [anchor('B2', [{ code: 'requirement-untasked', message: '需求 R-016 没有任何任务实现它' }])],
    objectionIds: [],
    blocked: true,
  });
  const b = blockSignature({
    failures: [anchor('B2', [{ code: 'requirement-untasked', message: 'R-016 看起来被漏掉了，请补任务' }])],
    objectionIds: [],
    blocked: true,
  });
  assert.equal(a, b, '把消息算进签名，模型每次换个说法就会被当成「有进展」');
});

test('失败项发生变化 → 签名必须不同（否则会把「还在改」误判成「没进展」）', () => {
  const a = blockSignature({
    failures: [anchor('A4', [{ code: 'compile-error', file: 'src/a.ts', line: 1 }])],
    objectionIds: [],
    blocked: true,
  });
  const b = blockSignature({
    failures: [anchor('A4', [{ code: 'compile-error', file: 'src/a.ts', line: 9 }])],
    objectionIds: [],
    blocked: true,
  });
  assert.notEqual(a, b);
});

test('有效异议也进签名（它是第三种能造成 blocked 的来源）', () => {
  const sig = blockSignature({
    failures: [],
    objectionIds: ['OBJ-001'],
    blocked: true,
  });
  assert.equal(sig, 'objection:OBJ-001');
});

test('未阻断 → null；没有失败也没有异议的「阻断」也必须是 null', () => {
  assert.equal(blockSignature({ failures: [anchor('A1', [{ code: 'x' }])], objectionIds: [], blocked: false }), null);
  assert.equal(blockSignature({ failures: [], objectionIds: [], blocked: true }), null);
});

test('signatureParts 只取 fail 级，warn 不计入（否则噪音会让签名永远在变）', () => {
  const a = anchor('A1', [
    { code: 'warn-only', severity: 'warn' },
    { code: 'real-fail', severity: 'fail', file: 'src/x.ts', line: 3 },
  ] as never);
  const parts = signatureParts([a]);
  assert.deepEqual(parts, ['A1:real-fail:src/x.ts:3']);
});
