/**
 * 「空交付」闸门：只有规格、没有实现的 run 不许报「完整交付」。
 *
 * ## 真实事故（cb-18，2026-10-24）
 *
 * 用户误把被 shell 截断的 13 字符片段当成诉求传进来（`"(Get-Content"`）。
 *
 * PM 的反应**相当聪明**：它把「输入不完整」写成了两条需求 ——
 *   R-001  澄清被截断的原始诉求（字面量 "(Get-Content"，疑似 PowerShell 命令开头）
 *   R-002  在诉求澄清前冻结实现范围：本次只产出 Requirement，不新增任何源码
 * 然后系统证明这两条「达成」了：5 个门禁全 ADVANCE、0 工单、0 技术债、
 * **`fullyVerified = true`**、需求 2/2 —— 而实际产出只有**一个** `contract-types.ts`。
 *
 * 也就是说：**它把自己的「不作为」写成了需求，然后证明这条需求达成了。**
 *
 * 这不是模型犯错，是**系统缺一问**。所有锚点都在问「产出是否满足我们写的需求」，
 * 没有一个问「这份交付和用户真正要的东西对得上吗」。
 * 这是 `SKIPPED ≠ PASS` 的同族缺陷：「没交付」被当成了「交付」。
 *
 * ## 判据为什么选「零 CodeModule」
 *
 * 机械、无争议，而且正是这个产品存在的意义（产出可运行的系统）。
 * 若某次 run 的目标本来就不是产出代码，应当在**诉求里显式说明**，
 * 而不是靠这条闸门放行一个空项目。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactStore } from '../../core/src/index.ts';
import { blockingGaps } from '../src/gate.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'af-empty-delivery-'));
  const store = new ArtifactStore(dir);
  await store.init();
  await store.put({
    kind: 'Requirement',
    producer: 'pm',
    content: {
      requirements: [
        {
          id: 'R-001',
          text: '澄清被截断的原始诉求',
          acceptance: ['输入被澄清'],
          priority: 'must',
          status: 'open',
          origin: 'user',
        },
      ],
    },
  });
  return { store, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

test('🔴 交付阶段没有任何 CodeModule → 必须是硬失败（cb-18 的空交付）', async () => {
  const f = await fixture();
  try {
    const gaps = blockingGaps('DELIVERED', [], f.store);
    const empty = gaps.filter((g) => g.findings.some((x) => x.code === 'empty-delivery'));
    assert.equal(empty.length, 1, '只有规格没有实现，不许报「完整交付」');
    assert.equal(empty[0]!.verdict, 'FAIL');
    assert.equal(empty[0]!.findings[0]!.severity, 'fail');
    assert.equal(empty[0]!.findings[0]!.targetRole, 'pm', '归因 PM：是它把「不做」写成了需求');
    assert.match(empty[0]!.findings[0]!.message, /不含任何代码工件/);
  } finally {
    await f.cleanup();
  }
});

test('有 CodeModule → 不该报空交付（别误伤正常 run）', async () => {
  const f = await fixture();
  try {
    await f.store.put({
      kind: 'CodeModule',
      producer: 'backend',
      scope: 'api',
      content: { files: [{ path: 'src/api/server.ts', content: 'export const a = 1;\n' }] },
    });
    const gaps = blockingGaps('DELIVERED', [], f.store);
    assert.equal(
      gaps.filter((g) => g.findings.some((x) => x.code === 'empty-delivery')).length,
      0,
      '有实现就不该报空交付',
    );
  } finally {
    await f.cleanup();
  }
});

test('只在 DELIVERED 阶段检查（BUILDING 期间还没有代码是正常的）', async () => {
  const f = await fixture();
  try {
    for (const stage of ['BUILDING', 'REVIEW'] as const) {
      const gaps = blockingGaps(stage, [], f.store);
      assert.equal(
        gaps.filter((g) => g.findings.some((x) => x.code === 'empty-delivery')).length,
        0,
        `${stage} 阶段不该查空交付`,
      );
    }
  } finally {
    await f.cleanup();
  }
});
