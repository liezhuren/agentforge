import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  ArtifactStore,
  DEFAULT_HOST_POLICY,
  claimHashOf,
  evidenceHashOf,
  type EvidenceRef,
  type Falsifier,
  type HostPolicy,
  type Objection,
  type ProjectProfile,
} from '../../core/src/index.ts';
import { ANCHOR_INDEX, A_LAYER_IDS, createAnchorContext, runAnchors, type AnchorContext } from '../../anchors/src/index.ts';
import { HostLedger } from '../src/ledger.ts';
import { MechanicalJudge, checkContradiction, A_LAYER_DOMAINS } from '../src/judge.ts';

// ════════════════════════════════════════════════════════════════

type Fixture = {
  root: string;
  store: ArtifactStore;
  profile: ProjectProfile;
  ctx: AnchorContext;
  cleanup(): Promise<void>;
};

async function write(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'af-judge-'));
  await write(root, 'src/api/index.ts', ['export function handler() {', '  return 200;', '}', ''].join('\n'));
  await write(root, 'src/web/app.ts', ['export const app = 1;', ''].join('\n'));

  const store = new ArtifactStore(root);
  await store.init();

  // typecheck/test 都用 node 造出确定性结果，从而让 A4/A5 得到真实的 PASS/FAIL
  const profile: ProjectProfile = {
    name: 'judge-fixture',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: { cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
    test: { cmd: process.execPath, args: ['-e', "console.log('# pass 2\\n# fail 0')"] },
    run: null,
    knownPackages: ['lodash'],
    dependencyAllowlist: null,
  };

  const ctx = createAnchorContext({ projectRoot: root, store, profile, offline: true, runPrefix: 'j' });
  return {
    root,
    store,
    profile,
    ctx,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function objection(over: Partial<Objection> = {}): Objection {
  const evidence: EvidenceRef[] = over.evidence ?? [
    { kind: 'file', path: 'src/api/index.ts', startLine: 1, endLine: 3 },
  ];
  const claim = over.claim ?? '后端接口 /api/tasks 没有实现，与契约声明不一致';
  const falsifier: Falsifier = over.falsifier ?? CONFIRMING;
  return {
    id: over.id ?? `O-${Math.random().toString(36).slice(2, 8)}`,
    stage: over.stage ?? 'REVIEW',
    author: 'host',
    targetRole: over.targetRole ?? 'backend',
    severity: over.severity ?? 'blocker',
    claim,
    evidence,
    falsifier,
    claimHash: over.claimHash ?? claimHashOf(claim),
    evidenceHash: over.evidenceHash ?? evidenceHashOf(evidence),
    createdAt: new Date().toISOString(),
    ...(over.proposedFix ? { proposedFix: over.proposedFix } : {}),
  };
}

async function setup(policy: Partial<HostPolicy> = {}) {
  const f = await makeFixture();
  const ledger = new HostLedger({ ...DEFAULT_HOST_POLICY, ...policy });
  const judge = new MechanicalJudge({ anchorContext: f.ctx, ledger });
  return { f, ledger, judge };
}

const A_PASS = async (f: Fixture) =>
  runAnchors(f.ctx, [ANCHOR_INDEX.get('A4')!, ANCHOR_INDEX.get('A5')!]);

/** 必然非零退出：falsifier 会「确认」问题存在 → VALID */
const CONFIRMING: Falsifier = {
  kind: 'executable',
  command: 'node -e "process.exit(1)"',
  expect: 'exit-nonzero',
};
/** 必然零退出：falsifier 无法复现问题 → REFUTED */
const REFUTING: Falsifier = {
  kind: 'executable',
  command: 'node -e "process.exit(0)"',
  expect: 'exit-nonzero',
};

// ════════════════════════════════════════════════════════════════
// 三档裁决
// ════════════════════════════════════════════════════════════════

test('VALID：证据真实 + falsifier 确认问题存在 → 阻断生效，扣 1 额度', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({ claim: '后端 handler 的返回码与契约声明的 200 不一致，请核查' });
    const s = await judge.arbitrateAll([o], anchors);

    assert.equal(s.valid, 1);
    assert.equal(s.results[0].verdict, 'VALID');
    assert.equal(s.results[0].rule, 'falsifier-confirmed');
    assert.equal(ledger.snapshot().quota, 2, 'R1：真报扣 1');
    assert.equal(ledger.snapshot().blockAttempts, 1);
    assert.equal(ledger.precision(), 1);
  } finally {
    await f.cleanup();
  }
});

test('REFUTED：falsifier 未能复现 → 误报，扣 2 额度（代价是真报的两倍）', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({
      claim: '后端 handler 的返回码与契约声明的 200 不一致，请核查',
      falsifier: REFUTING,
    });
    const s = await judge.arbitrateAll([o], anchors);

    assert.equal(s.refuted, 1);
    assert.equal(s.results[0].rule, 'falsifier-refuted');
    assert.equal(ledger.snapshot().quota, 1, '3 - 2 = 1');
    assert.equal(ledger.precision(), 0);
    assert.ok(s.results[0].reason.includes('两倍'));
  } finally {
    await f.cleanup();
  }
});

test('REFUTED：断言与已 PASS 的 A4 锚点直接矛盾 → 即便假 falsifier 也无法骗过', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    // A4 已 PASS（真实跑了类型检查且零错误）。主理人却声称「编译失败」，
    // 并附上一个必然非零退出的 falsifier 想骗过执行层。
    const o = objection({
      claim: '前端代码编译失败，类型检查无法通过，必须打回',
      falsifier: CONFIRMING,
    });
    const s = await judge.arbitrateAll([o], anchors);

    assert.equal(s.results[0].verdict, 'REFUTED');
    assert.equal(s.results[0].rule, 'R-contradicts-anchor');
    assert.ok(s.results[0].reason.includes('A4'));
    assert.equal(ledger.snapshot().quota, 1);
  } finally {
    await f.cleanup();
  }
});

test('UNFALSIFIABLE：证据指向不存在的文件 → 不阻断、不计误报', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({
      evidence: [{ kind: 'file', path: 'src/api/ghost.ts', startLine: 1, endLine: 2 }],
    });
    const s = await judge.arbitrateAll([o], anchors);

    assert.equal(s.results[0].rule, 'evidence-invalid');
    assert.equal(ledger.snapshot().falsePositives, 0, '证据不合格不是撒谎，不计误报');
    assert.equal(ledger.snapshot().quota, 3, '不扣额度');
  } finally {
    await f.cleanup();
  }
});

test('UNFALSIFIABLE：question 型 falsifier → 不阻断但请求人类裁决', async () => {
  const { f, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({
      claim: '这个错误处理策略在并发场景下是否符合用户预期，需要人来判断',
      falsifier: { kind: 'question', text: '并发写入时用户期望的是拒绝还是排队？' },
    });
    const s = await judge.arbitrateAll([o], anchors);
    assert.equal(s.results[0].verdict, 'UNFALSIFIABLE');
    assert.equal(s.results[0].requiresHuman, true);
    assert.equal(s.requiresHuman, 1);
  } finally {
    await f.cleanup();
  }
});

test('UNFALSIFIABLE：falsifier 命令被安全策略拒绝 → 不计误报（是系统的限制，不是异议的错）', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({
      claim: '后端 handler 的返回码与契约声明的 200 不一致，请核查',
      falsifier: { kind: 'executable', command: 'rm -rf /', expect: 'exit-nonzero' },
    });
    const s = await judge.arbitrateAll([o], anchors);
    assert.equal(s.results[0].rule, 'falsifier-denied');
    assert.equal(ledger.snapshot().falsePositives, 0);
  } finally {
    await f.cleanup();
  }
});

test('UNFALSIFIABLE：falsifier 无法启动 → 不阻断、不计误报', async () => {
  const f = await makeFixture();
  const ledger = new HostLedger({ ...DEFAULT_HOST_POLICY });
  // 用自定义命令策略把「策略放行、但二进制根本不存在」这条路径单独隔离出来。
  // 早先版本用 `tsc` / `vitest` 试图触发 spawn 失败，但它们在**这台机器上真的存在**
  // （PATH 里有 harness 的 node_modules/.bin），于是命令跑起来并以非零码退出，
  // 反而「合法地」满足了 expect: exit-nonzero —— 把不可执行误判成了问题已确认。
  // 这类测试不能依赖「目标机器上恰好没装某工具」。
  const judge = new MechanicalJudge({
    anchorContext: f.ctx,
    ledger,
    commandPolicy: {
      allowBinaries: ['definitely-not-installed-bin'],
      denyBinaries: [],
      timeoutMs: 5_000,
    },
  });
  try {
    const anchors = await A_PASS(f);
    const o = objection({
      claim: '后端 handler 的返回码与契约声明的 200 不一致，请核查',
      falsifier: {
        kind: 'executable',
        command: 'definitely-not-installed-bin --check',
        expect: 'exit-nonzero',
      },
    });
    const s = await judge.arbitrateAll([o], anchors);
    assert.equal(s.results[0].verdict, 'UNFALSIFIABLE');
    assert.equal(s.results[0].rule, 'falsifier-spawn-error', s.results[0].reason);
    assert.equal(ledger.snapshot().falsePositives, 0, '跑不起来不是撒谎');
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// R3 / R4 / R6 / R8 / R9 / R10
// ════════════════════════════════════════════════════════════════

test('R3：有效阻断尝试达 3 次 → 本阶段阻断权终止 + 触发圆桌', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    // 用**有效**异议三次，模拟「主理人三次都拦对了」，
    // 这正是 T1 圆桌最有意义的场景：它是对的，但争议需要各方一起解决。
    const mk = (i: number) =>
      objection({
        id: `O-${i}`,
        claim: `第 ${i} 个问题：后端 handler 的返回码与契约声明不一致，请核查`,
        falsifier: CONFIRMING,
      });

    const s = await judge.arbitrateAll([mk(1), mk(2), mk(3)], anchors);
    assert.equal(s.valid, 3);
    assert.equal(s.conveneRoundtable, true, 'R3 必须触发圆桌');
    assert.equal(ledger.stageBlockingRevoked, true);
    assert.equal(ledger.snapshot().quota, 0, '3 次真报各扣 1');
    assert.equal(ledger.precision(), 1, '三次都对，precision 应为 1 —— 这才是「高精度找茬」');

    const gate = ledger.canBlock();
    assert.equal(gate.allowed, false);
    assert.ok(gate.reason?.includes('R3'));
  } finally {
    await f.cleanup();
  }
});

test('设计交互：累计误报进入观察期后，异议不再消耗阻断额度，因而也不会触发 T1 圆桌', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const bogus = (i: number) =>
      objection({
        id: `O-${i}`,
        claim: `第 ${i} 个问题：后端 handler 的返回码与契约声明不一致，请核查`,
        falsifier: REFUTING,
      });

    const s = await judge.arbitrateAll([bogus(1), bogus(2), bogus(3)], anchors);

    // 第 2 次误报即进入观察期；第 3 次已无阻断资格，因此不消耗额度、R3 不触发。
    assert.equal(ledger.probation, true);
    assert.equal(ledger.stageBlockAttempts, 2, '被守门挡下的异议不计入阻断尝试');
    assert.equal(s.conveneRoundtable, false, '观察期下已无死锁风险，无需圆桌');

    // 关键：这不影响推进保证 —— 观察期本身就意味着主理人已经无法阻断项目。
    assert.equal(ledger.canBlock().allowed, false);
    // 而「无法归因」这条通道不受观察期影响，T2 仍然可用（见 preGuard 的判定顺序）。
    const t2 = await judge.arbitrateAll(
      [objection({ targetRole: 'UNRESOLVED', claim: '整体职责边界不清，需要重新设计' })],
      anchors,
    );
    assert.equal(t2.results[0].rule, 'R9-unattributed', 'T2 通道不受观察期影响');
  } finally {
    await f.cleanup();
  }
});

test('R3 之后：再提异议一律不阻断，但不再追加误报', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const mk = (i: number) =>
      objection({
        id: `O-${i}`,
        claim: `第 ${i} 个问题：后端 handler 的返回码与契约声明不一致，请核查`,
        falsifier: REFUTING,
      });
    await judge.arbitrateAll([mk(1), mk(2), mk(3)], anchors);
    const fpAfterThree = ledger.snapshot().falsePositives;

    const s4 = await judge.arbitrateAll([mk(4)], anchors);
    assert.equal(s4.results[0].rule, 'ledger-guard');
    assert.equal(ledger.snapshot().falsePositives, fpAfterThree, '已被剥夺阻断权后的异议不应再记误报');
    assert.equal(s4.blockedByGuard, 1);
  } finally {
    await f.cleanup();
  }
});

test('R4：累计误报达 2 次 → 进入观察期，只能提建议不能阻断', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const bogus = (i: number) =>
      objection({
        id: `O-${i}`,
        claim: `第 ${i} 个问题：后端 handler 的返回码与契约声明不一致，请核查`,
        falsifier: REFUTING,
      });

    await judge.arbitrateAll([bogus(1)], anchors);
    assert.equal(ledger.probation, false, '一次误报还不至于');

    await judge.arbitrateAll([bogus(2)], anchors);
    assert.equal(ledger.probation, true, '累计 2 次误报 → 观察期');
    assert.equal(ledger.canBlock().allowed, false);
    assert.ok(ledger.canBlock().reason?.includes('观察期'));
  } finally {
    await f.cleanup();
  }
});

test('R5：观察期可通过连续 A 层健康阶段自动解除', async () => {
  const { f, ledger, judge } = await setup({ probationClearStages: 2 });
  try {
    const anchors = await A_PASS(f);
    const bogus = (i: number) =>
      objection({
        id: `O-${i}`,
        claim: `第 ${i} 个问题：后端 handler 的返回码与契约声明不一致，请核查`,
        falsifier: REFUTING,
      });
    await judge.arbitrateAll([bogus(1), bogus(2)], anchors);
    assert.equal(ledger.probation, true);

    ledger.beginStage('BUILDING');
    assert.equal(ledger.endStage({ aLayerHealthy: true }).clearedProbation, false, '一个阶段还不够');
    ledger.beginStage('REVIEW');
    assert.equal(ledger.endStage({ aLayerHealthy: true }).clearedProbation, true, '连续两阶段健康 → 解除');
    assert.equal(ledger.canBlock().allowed, true, '给复出路，不是永久惩罚');
  } finally {
    await f.cleanup();
  }
});

test('R5：A 层有硬失败时观察期进度清零（不能靠放水混过去）', async () => {
  const { f, ledger, judge } = await setup({ probationClearStages: 2 });
  try {
    const anchors = await A_PASS(f);
    const bogus = (i: number) =>
      objection({
        id: `O-${i}`,
        claim: `第 ${i} 个问题：后端 handler 的返回码与契约声明不一致，请核查`,
        falsifier: REFUTING,
      });
    await judge.arbitrateAll([bogus(1), bogus(2)], anchors);

    ledger.beginStage('BUILDING');
    ledger.endStage({ aLayerHealthy: true });
    ledger.beginStage('REVIEW');
    ledger.endStage({ aLayerHealthy: false }); // 这一阶段有硬失败
    ledger.beginStage('ROUNDTABLE');
    assert.equal(ledger.endStage({ aLayerHealthy: true }).clearedProbation, false, '进度必须清零重来');
  } finally {
    await f.cleanup();
  }
});

test('R6：复读同一异议 → 直接判误报', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({
      id: 'O-repeat',
      claim: '后端 handler 的返回码与契约声明不一致，请核查',
      falsifier: REFUTING,
    });
    const first = await judge.arbitrateAll([o], anchors);
    assert.equal(first.results[0].rule, 'falsifier-refuted');

    const again = await judge.arbitrateAll([{ ...o, id: 'O-repeat-2' }], anchors);
    assert.equal(again.results[0].verdict, 'REFUTED');
    assert.equal(again.results[0].rule, 'R6-repeat');
    assert.equal(ledger.snapshot().falsePositives, 2);
  } finally {
    await f.cleanup();
  }
});

test('R8：severity != blocker 一律不阻断、不计误报（堵「用 minor 意见磨死项目」）', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({ severity: 'minor', falsifier: CONFIRMING });
    const s = await judge.arbitrateAll([o], anchors);
    assert.equal(s.results[0].rule, 'R8-severity');
    assert.equal(ledger.snapshot().quota, 3);
    assert.equal(ledger.snapshot().blockAttempts, 0);
  } finally {
    await f.cleanup();
  }
});

test('R9：归因不清（UNRESOLVED）不阻断，且触发圆桌（触发条件 T2）', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({
      targetRole: 'UNRESOLVED',
      claim: '整体架构存在问题，后端与前端的职责边界不清晰，需要重新设计',
      falsifier: CONFIRMING,
    });
    const s = await judge.arbitrateAll([o], anchors);
    assert.equal(s.results[0].rule, 'R9-unattributed');
    assert.equal(s.blockedByGuard, 1);
    assert.equal(ledger.stageBlockAttempts, 0, 'R9 不消耗阻断额度');
    assert.equal(ledger.canBlock().allowed, true, 'R9 本身不剥夺后续阻断权');
  } finally {
    await f.cleanup();
  }
});

test('R7：连续每阶段都用满额度 → 全局观察期', async () => {
  const { f, ledger, judge } = await setup({ globalBudgetPerStage: 3, stageBlockLimit: 3 });
  try {
    const anchors = await A_PASS(f);
    const mk = (stage: string, i: number) =>
      objection({
        id: `O-${stage}-${i}`,
        stage: stage as Objection['stage'],
        claim: `阶段 ${stage} 第 ${i} 个问题：后端 handler 的返回码与契约声明不一致`,
        falsifier: CONFIRMING,
      });

    await judge.arbitrateAll([mk('REVIEW', 1), mk('REVIEW', 2), mk('REVIEW', 3)], anchors);
    assert.equal(ledger.stageBlockAttempts, 3);

    ledger.beginStage('BUILDING');
    await judge.arbitrateAll([mk('BUILDING', 1), mk('BUILDING', 2), mk('BUILDING', 3)], anchors);
    assert.equal(ledger.globalBlockAttempts, 6);

    const r = ledger.beginStage('REVIEW');
    assert.equal(r.globalProbation, true, '每阶段都卡满 → 全局观察期');
    assert.equal(ledger.probation, true);
    assert.ok(ledger.canBlock().reason?.includes('R7'));
  } finally {
    await f.cleanup();
  }
});

test('R7：只在个别阶段卡满时不得触发全局观察期（预算随阶段数增长）', async () => {
  const { f, ledger, judge } = await setup({ globalBudgetPerStage: 3, stageBlockLimit: 3 });
  try {
    const anchors = await A_PASS(f);
    const one = (stage: string) =>
      objection({
        id: `O-${stage}`,
        stage: stage as Objection['stage'],
        claim: `阶段 ${stage} 的问题：后端 handler 的返回码与契约声明不一致`,
        falsifier: CONFIRMING,
      });

    await judge.arbitrateAll([one('REVIEW')], anchors); // 只用 1 次
    ledger.beginStage('BUILDING');
    assert.equal(ledger.beginStage('REVIEW').globalProbation, false);
    assert.equal(ledger.probation, false, '节制使用阻断权不应被惩罚');
  } finally {
    await f.cleanup();
  }
});

test('R7：只卡满一个阶段时不得触发（避免「一个阶段卡满就全局观察期」的过敏）', async () => {
  const { f, ledger, judge } = await setup({ globalBudgetPerStage: 3, stageBlockLimit: 3 });
  try {
    const anchors = await A_PASS(f);
    const mk = (i: number) =>
      objection({
        id: `O-${i}`,
        claim: `第 ${i} 个问题：后端 handler 的返回码与契约声明不一致`,
        falsifier: CONFIRMING,
      });
    await judge.arbitrateAll([mk(1), mk(2), mk(3)], anchors);

    // 只完成了 1 个阶段，「连续」不成立
    assert.equal(ledger.beginStage('BUILDING').globalProbation, false);
  } finally {
    await f.cleanup();
  }
});

test('R10：显式输出无异议是正确行为，不受惩罚', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    const s = await judge.arbitrateAll([], anchors);
    assert.equal(s.results.length, 0);
    ledger.recordNoObjection();
    assert.equal(ledger.snapshot().quota, 3);
    assert.equal(ledger.precision(), 1, '未提异议不得被惩罚');
    assert.equal(ledger.snapshot().falsePositives, 0);
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 矛盾检测器本身
// ════════════════════════════════════════════════════════════════

test('矛盾检测：锚点未运行时不启用（未验证的领域没有权威）', async () => {
  const f = await makeFixture();
  try {
    const o = objection({ claim: '前端代码编译失败，类型检查无法通过' });
    assert.equal(checkContradiction(o, []).contradicted, false);
  } finally {
    await f.cleanup();
  }
});

test('矛盾检测：锚点 SKIPPED 时不启用', async () => {
  const { f } = await setup();
  try {
    const anchors = await A_PASS(f);
    const skipped = anchors.map((a) => ({ ...a, verdict: 'SKIPPED' as const }));
    assert.equal(checkContradiction(objection({ claim: '前端代码编译失败' }), skipped).contradicted, false);
  } finally {
    await f.cleanup();
  }
});

test('矛盾检测：非 blocker 不启用', async () => {
  const { f } = await setup();
  try {
    const anchors = await A_PASS(f);
    const o = objection({ severity: 'major', claim: '前端代码编译失败，类型检查无法通过' });
    assert.equal(checkContradiction(o, anchors).contradicted, false);
  } finally {
    await f.cleanup();
  }
});

test('矛盾检测：命中领域关键词 + 锚点 PASS → 判矛盾并指明是哪个锚点', async () => {
  const { f } = await setup();
  try {
    const anchors = await A_PASS(f);
    const cases: Array<[string, string]> = [
      ['前端代码编译失败，类型检查无法通过', 'A4'],
      ['单元测试全部失败，测试根本没有通过', 'A5'],
    ];
    for (const [claim, expected] of cases) {
      const c = checkContradiction(objection({ claim }), anchors);
      assert.equal(c.contradicted, true, claim);
      assert.equal(c.anchorId, expected);
    }
  } finally {
    await f.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 矛盾检测表本身：每个锚点都要在表里（否则它的 PASS 换不来任何否决权）
// ════════════════════════════════════════════════════════════════

/**
 * 这条测试守的是一个「清单完整性」问题，而不是某个关键词。
 *
 * 实测发现表里只有 A1/A2/A3/A4/A5/A7 —— **A6 与 A8 不在**。
 * 后果不是「漏了一个检查」，而是：主理人声称「服务根本起不来」而 A6 明明 PASS 时，
 * 走不到那条「零成本、必然成立」的机械证伪路径，只能退回 falsifier 兜底
 * （要真起一次子进程才能判）。本来是白送的判定，变成了要花钱的判定。
 *
 * 这类「硬编码清单不完整」在本项目里出现过多次（归因目录表 docs/07 §L10、
 * DecisionKind docs/07 §N5），所以这里用一条测试把它钉住：
 * **凡是会产出 PASS 的 A 层锚点，都必须在矛盾检测表里有位置。**
 */
test('矛盾检测表：每个 A 层锚点都有领域条目（清单完整性）', () => {
  const covered = new Set(A_LAYER_DOMAINS.map((d) => d.anchorId));
  for (const id of A_LAYER_IDS) {
    assert.ok(covered.has(id), `${id} 不在 A_LAYER_DOMAINS 里 —— 它的 PASS 无法否决任何异议`);
  }
  // 锚点清单本身也钉一下：新增 A 层锚点时必须同步考虑是否要进这张表
  // （A6/A8 就是漏掉的实例）。
  assert.deepEqual(A_LAYER_IDS, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
});

test('矛盾检测：A6 已 PASS 时，「服务起不来」是可机械证伪的假话', async () => {
  const { f } = await setup();
  try {
    // A6 的真正 PASS 需要真起一次服务（P6 自举验证里覆盖了那条真实路径）。
    // 这里只需要它「已 PASS」这个事实，所以直接构造结果 —— 本测试验的是关键词映射，
    // 不是探针本身。
    const base = (id: 'A4' | 'A5' | 'A6' | 'A8', verdict: 'PASS' | 'SKIPPED') => ({
      anchorId: id,
      runId: `run-test-${id}`,
      subjects: [],
      contentHashes: {},
      verdict,
      findings: [],
      method: 'test-fixture',
      authority: 'authoritative' as const,
      at: new Date().toISOString(),
      durationMs: 0,
    });

    const withA6 = [base('A6', 'PASS')];
    const claim = '服务进程根本起不来，健康检查连不上';
    const c = checkContradiction(objection({ claim }), withA6);
    assert.equal(c.contradicted, true, claim);
    assert.equal(c.anchorId, 'A6');

    // 保守行为必须保持：A6 未 PASS 时这条异议不受影响
    assert.equal(
      checkContradiction(objection({ claim }), [base('A6', 'SKIPPED')]).contradicted,
      false,
      'A6 没 PASS 时它没有权威，不得据此判主理人撒谎',
    );
  } finally {
    await f.cleanup();
  }
});

test('矛盾检测：A8 已 PASS 时，「产出改掉了 package.json 的声明」是可机械证伪的假话', async () => {
  const { f } = await setup();
  try {
    const a8 = {
      anchorId: 'A8' as const,
      runId: 'run-test-A8',
      subjects: [],
      contentHashes: {},
      verdict: 'PASS' as const,
      findings: [],
      method: 'test-fixture',
      authority: 'authoritative' as const,
      at: new Date().toISOString(),
      durationMs: 0,
    };

    const c = checkContradiction(objection({ claim: '产出把 package.json 里的 agentforge 声明删掉了' }), [a8]);
    assert.equal(c.contradicted, true);
    assert.equal(c.anchorId, 'A8');

    // 反向保护：A8 只管「基准有没有被动」，不管「命令存不存在」。
    // 这类断言必须**不**被判成矛盾，否则会误伤诚实的异议（误报代价是真报的两倍）。
    assert.equal(
      checkContradiction(objection({ claim: 'package.json 里的测试命令在这个环境跑不起来' }), [a8]).contradicted,
      false,
      'A8 不检查命令是否存在，超出它权威范围的断言不得被证伪',
    );
  } finally {
    await f.cleanup();
  }
});

test('账本：snapshot 的 precision 可复算（UI 展示的数字必须自洽）', async () => {
  const { f, ledger, judge } = await setup();
  try {
    const anchors = await A_PASS(f);
    await judge.arbitrateAll(
      [
        objection({ id: 'V1', claim: '第一个真问题：返回码与契约不一致，请核查', falsifier: CONFIRMING }),
        objection({ id: 'F1', claim: '第二个假问题：返回码与契约不一致，请核查', falsifier: REFUTING }),
      ],
      anchors,
    );
    const snap = ledger.snapshot();
    assert.equal(snap.truePositives, 1);
    assert.equal(snap.falsePositives, 1);
    assert.equal(snap.precision, 0.5);
    assert.equal(snap.precision, snap.truePositives / (snap.truePositives + snap.falsePositives));
  } finally {
    await f.cleanup();
  }
});
