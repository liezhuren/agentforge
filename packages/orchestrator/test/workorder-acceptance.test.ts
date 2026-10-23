/**
 * 工单验收条件的措辞。
 *
 * 这一组测试守的是一个**看起来只是文案**、实际决定收敛与否的机制：
 * 角色返工时唯一能看到的就是 `acceptanceFor()` 生成的这句话。
 *
 * 起因是 cb-8 的实测：`orphan-contract-path` 没有显式 case，落进 `default`，
 * PM 收到的工单是「修复 项目 的 orphan-contract-path 问题，使 A7 锚点 PASS」——
 * 一句不可执行的话。PM 连修两轮**没有改变任何东西**，最后带债通过，
 * 而真实问题只是「有一个 catch-all 端点没被任何任务认领」。
 *
 * 所以规则是：**凡是有专门 code 的失败，就必须有专门的验收条件**。
 * 落到 default 等于默认「修不好也能凑合」，而且那句话本身在告诉模型
 * 「我也不知道该改什么」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acceptanceFor } from '../src/gate.ts';

/** default 分支的措辞特征 —— 出现它说明这个 code 没人管。 */
const DEFAULT_SHAPE = /^修复 .+ 的 [\w-]+ 问题，使 \w+ 锚点 PASS$/;

test('🔴 A7 切片覆盖的四个 code 都有可执行的验收条件（不许落到 default）', () => {
  const cases: Array<{ code: string; data: Record<string, unknown>; mustInclude: string[] }> = [
    { code: 'orphan-contract-path', data: { path: '/api/{any}' }, mustInclude: ['/api/{any}', 'contractPaths'] },
    { code: 'phantom-contract-path', data: { path: '/api/ghost' }, mustInclude: ['/api/ghost', 'contractPaths'] },
    { code: 'orphan-contract-schema', data: { model: 'Paper' }, mustInclude: ['Paper', 'contractSchemas'] },
    { code: 'phantom-contract-schema', data: { model: 'Ghost' }, mustInclude: ['Ghost', 'contractSchemas'] },
    { code: 'contract-non-operation-path', data: { path: 'components' }, mustInclude: ['components', 'paths'] },
  ];

  for (const c of cases) {
    const text = acceptanceFor({ code: c.code, data: c.data }, 'A7');
    assert.ok(!DEFAULT_SHAPE.test(text), `${c.code} 落到了 default 分支 —— 那等于告诉模型「我不知道要改什么」`);
    for (const needle of c.mustInclude) {
      assert.ok(text.toLowerCase().includes(needle.toLowerCase()), `${c.code} 的验收条件必须提到 ${needle}，实际：${text}`);
    }
  }
});

test('🔴 可达性两条的验收条件必须点名「别名不算接线」', () => {
  const unwired = acceptanceFor({ code: 'unwired-handler', file: 'src/api/papers.ts', data: { handler: 'handlePapersRoute' } }, 'A7');
  assert.match(unwired, /handlePapersRoute/);
  assert.match(unwired, /别名/, 'cb-2 里模型就是靠 export 别名假装修好的，必须提前堵住');

  const stub = acceptanceFor({ code: 'endpoint-stub', file: 'src/api/app.ts', data: { snippet: "sendJson(res, 501, 'not implemented')" } }, 'A7');
  assert.match(stub, /src\/api\/app\.ts/, '必须给出文件位置');
  assert.match(stub, /501/);
});

test('已知 code 的验收条件都不该是 default 形状（覆盖回归）', () => {
  /**
   * 这些是真实运行里出现过、且确实需要模型做具体动作的 code。
   * 不要求它们的措辞完美，只要求它们**不是在说「我不知道」**。
   */
  const known = [
    'unimplemented-endpoint',
    'contract-not-frozen',
    'missing-generated-types',
    'contract-duplication',
    'undeclared-endpoint',
    'unwired-handler',
    'endpoint-stub',
    'orphan-contract-path',
    'phantom-contract-path',
    'semantic-verification-missing',
    'requirement-untested',
    'deliverable-missing',
    'tests-failed',
    'compile-error',
    'unresolved-import',
  ];
  for (const code of known) {
    const text = acceptanceFor({ code, file: 'src/x.ts' }, 'A4');
    assert.ok(!DEFAULT_SHAPE.test(text), `${code} 落到了 default —— 角色拿到这句话不知道怎么改`);
  }
});
