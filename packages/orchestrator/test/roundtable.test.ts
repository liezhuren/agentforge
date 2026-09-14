import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  ArtifactStore,
  silentLogger,
  DEFAULT_COMMAND_POLICY,
  type CommandPolicy,
  type ProjectProfile,
  type RoundtableResolution,
  type RoleId,
} from '../../core/src/index.ts';
import { createAnchorContext, type AnchorContext } from '../../anchors/src/index.ts';
import {
  MAX_RESOLUTION_ATTEMPTS,
  RoundtableSession,
  isMechanicallyCheckable,
  validateResolution,
  type RoundtableFact,
  type RoundtableParticipant,
} from '../src/roundtable.ts';

// ════════════════════════════════════════════════════════════════
// 单元：决议与「当场执行的 falsifier」结果的一致性校验
// ════════════════════════════════════════════════════════════════

const goodAction = {
  owner: 'backend' as const,
  action: '修正 /api/tasks 的响应结构',
  acceptance: ['A4 锚点 PASS'],
};

function resolution(over: Partial<RoundtableResolution> = {}): RoundtableResolution {
  return {
    attribution: 'backend',
    decision: '确认问题出在后端端点实现与契约不一致',
    actions: [goodAction],
    ...over,
  };
}

function fact(over: Partial<RoundtableFact> = {}): RoundtableFact {
  return {
    statementIndex: 0,
    role: 'frontend',
    against: 'backend',
    claim: '后端端点没有按契约校验响应',
    command: 'node -e "process.exit(1)"',
    exitCode: 1,
    outcome: 'sustained',
    implicates: 'backend',
    ...over,
  };
}

test('决议校验：归因与「被机械证实的事实」一致时通过', () => {
  assert.deepEqual(validateResolution(resolution({ attribution: 'backend' }), { facts: [fact()] }), { ok: true });
});

test('决议校验：归因指向机械证据已证明其没问题的角色 → 判无效', () => {
  // 这是新增的否决规则：一场有确凿机械证据的会议，
  // 不能得出「各打五十大板」或「归罪于举证方」的结论。
  const check = validateResolution(resolution({ attribution: 'frontend' }), { facts: [fact()] });
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.ok(check.reason.includes('机械证据'), check.reason);
    assert.ok(check.reason.includes('frontend'), check.reason);
    assert.ok(check.reason.includes('backend'), check.reason);
  }
});

test('决议校验：归因为 SHARED 时不与机械事实冲突', () => {
  assert.deepEqual(validateResolution(resolution({ attribution: 'SHARED' }), { facts: [fact()] }), { ok: true });
});

test('决议校验：被证伪的事实不约束归因（否定性证据不该用来锁定归因）', () => {
  // 一条反驳被证伪只说明「这个论点站不住」，不等于「被质询方一定没问题」；
  // 用否定性证据去限制归因会矫枉过正。
  const refuted = fact({ outcome: 'refuted', implicates: 'frontend' });
  assert.deepEqual(validateResolution(resolution({ attribution: 'backend' }), { facts: [refuted] }), { ok: true });
});

test('决议校验：把责任转向「需求/契约缺陷」也是逃逸 → 升级真人', () => {
  // 机械证据证明的是「实现与冻结契约不符」，推不出「契约是错的」。
  // 若允许这条路，任何被 falsifier 逼到墙角的角色都可以改口说「是需求写得不好」；
  // 而改需求是真人保留的权限。
  for (const attribution of ['REQUIREMENT_DEFECT', 'CONTRACT_DEFECT'] as const) {
    const check = validateResolution(resolution({ attribution }), { facts: [fact()] });
    assert.equal(check.ok, false, `${attribution} 不应被接受`);
    if (!check.ok) {
      assert.ok(check.reason.includes('真人保留'), check.reason);
      assert.ok(check.reason.includes(attribution), check.reason);
    }
  }
});

test('决议校验：多条事实分别指向不同角色时，归因必须落在其中之一或 SHARED', () => {
  const facts = [
    fact({ role: 'frontend', against: 'backend', implicates: 'backend' }),
    fact({ role: 'backend', against: 'frontend', implicates: 'frontend' }),
  ];
  assert.deepEqual(validateResolution(resolution({ attribution: 'SHARED' }), { facts }), { ok: true });
  assert.deepEqual(validateResolution(resolution({ attribution: 'backend' }), { facts }), { ok: true });
  assert.equal(validateResolution(resolution({ attribution: 'test' }), { facts }).ok, false);
});

test('验收条件可核验性：真实 LLM 产出的验收条件不得被误杀', () => {
  // 这一组全部来自真实 LLM 的实际输出（docs/07 §L7），不是编出来的例子。
  //
  // 第一条来自一次真实的圆桌决议：模型给出的验收条件本来是可核验的，
  // 却被判「无法被机械验证」→ 整个决议失效 → 升级真人。
  // 根因是模式表的两处缺陷：路径模式要求前导斜杠、中文两侧的 `\b` 静默失效。
  const shouldPass = [
    '同一命令连续执行 3 次，失败用例集合完全相同，并记录 3 次 runId',
    '连续两次列出结果顺序一致',
    'A4 锚点 PASS',
    'B2 验证通过',
    'GET /health 返回 200',
    'npm run test 退出码为 0',
    'src/api/app.ts 中 handleCreate 不再读取 status 参数',
    '测试用例覆盖 R-001 与 R-002',
    '响应体包含 task_id 字段',
    // 真实 LLM 写的第二条被误杀的验收条件（llm-4 run）：
    // 它指名了 A6 —— 锚点编号就是这个项目的验证词汇表，指到它就是可查的。
    '失败前与修复后各保存一份 A6 原始输出日志，日志路径写入提交信息',
  ];
  for (const c of shouldPass) {
    assert.equal(isMechanicallyCheckable(c), true, `应当被判为可核验，却被拒绝：${c}`);
  }

  // 另一方向：这些确实无法机械核验，必须继续拒绝。
  // 「宁可误杀」的取舍只在前一组上放宽，不能把这条规则变成橡皮图章。
  const shouldFail = [
    '提升可维护性',
    '代码风格简洁',
    '加强沟通与协作',
    '整体架构更加合理',
    '综合考虑各方意见后改进实现质量',
  ];
  for (const c of shouldFail) {
    assert.equal(isMechanicallyCheckable(c), false, `应当被判为不可核验，却被放过：${c}`);
  }
});

test('验收条件可核验性：中文两侧的 \\b 不生效（静默失效的规则）', () => {
  // `\b` 是 ASCII 词边界，中文字符属于非词字符 —— 于是 `/\b不存在\b/` 在纯中文句子里恒为 false。
  // 第一版有三条模式都犯了这个错误，它们从来没有生效过。
  // 这条测试把这个事实固定下来，防止有人「顺手」把 \b 加回去。
  assert.equal(/\b不存在\b/.test('这个字段不存在'), false, '中文两侧的 \\b 匹配不上');
  assert.equal(/\b不存在/.test('这个字段不存在'), false, '左侧是中文 ⇒ 没有词边界');
  assert.equal(/\b不存在/.test('a不存在'), true, '左侧是 ASCII 词字符时才有边界');

  // 实际规则必须能认出纯中文输入
  assert.equal(isMechanicallyCheckable('该字段不存在'), true);
  assert.equal(isMechanicallyCheckable('响应状态码 404'), true);
});

test('决议校验：既有的反「和稀泥」规则不受影响', () => {
  const hedging = validateResolution({
    attribution: 'SHARED',
    decision: '综合考虑各方意见',
    actions: [],
  });
  assert.equal(hedging.ok, false);
  if (!hedging.ok) assert.ok(hedging.reason.includes('行动项'), hedging.reason);

  const vagueAcceptance = validateResolution(
    resolution({ actions: [{ owner: 'backend', action: '改进一下实现质量', acceptance: ['提升可维护性'] }] }),
  );
  assert.equal(vagueAcceptance.ok, false);
  if (!vagueAcceptance.ok) assert.ok(vagueAcceptance.reason.includes('无法被机械验证'), vagueAcceptance.reason);

  assert.equal(isMechanicallyCheckable('A4 锚点 PASS'), true);
  assert.equal(isMechanicallyCheckable('提升可维护性'), false);
});

// ════════════════════════════════════════════════════════════════
// 集成：第 2 轮交叉质询当场执行 falsifier
// ════════════════════════════════════════════════════════════════

type Fixture = {
  root: string;
  ctx: AnchorContext;
  cleanup(): Promise<void>;
  session(opts?: { policy?: CommandPolicy; focusTargets?: RoleId[] }): RoundtableSession;
};

const PROFILE: ProjectProfile = {
  name: 'rt',
  language: 'typescript',
  srcDir: 'src',
  tsconfigPath: 'tsconfig.json',
  typecheck: null,
  test: null,
  run: null,
  knownPackages: [],
  dependencyAllowlist: null,
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'af-rt-'));
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  };
  await write('src/api/routes.ts', 'export function listTasks() {\n  return [];\n}\n');
  await write('src/web/client.ts', 'export const load = () => fetch("/api/tasks");\n');

  const store = new ArtifactStore(root);
  await store.init();
  const ctx = createAnchorContext({
    projectRoot: root,
    store,
    profile: PROFILE,
    logger: silentLogger('rt'),
    offline: true,
    runPrefix: 'rt',
  });

  return {
    root,
    ctx,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5 }),
    session: (opts = {}) =>
      new RoundtableSession({
        trigger: 'T2',
        participants: ['pm', 'frontend', 'backend', 'test'],
        agenda: ['前后端职责边界不清'],
        anchorContext: ctx,
        logger: silentLogger('rt-session'),
        commandPolicy: opts.policy ?? DEFAULT_COMMAND_POLICY,
        falsifierTimeoutMs: 30_000,
        focusTargets: opts.focusTargets ?? ['backend'],
      }),
  };
}

/** 每个角色第 1 轮引用真实存在的文件（否则发言会被机械丢弃）。 */
const ev = (path: string) => [{ kind: 'file' as const, path, startLine: 1, endLine: 2 }];
const ROLES: RoleId[] = ['pm', 'frontend', 'backend', 'test'];

/**
 * 桩发言者：第 2 轮只有 `rebutter` 携带一个可执行的 falsifier。
 * `focusTargets: ['backend']` 保证 rebutter 的质询对象是 backend。
 */
function speakers(
  rebutter: RoleId | null,
  falsifierCommand: string,
  expect: 'exit-nonzero' | 'output-matches' = 'exit-nonzero',
): Map<RoleId, RoundtableParticipant> {
  return new Map(
    ROLES.map((role) => [
      role,
      {
        role,
        speak: async (round: 1 | 2, against?: RoleId) => ({
          claim: round === 1 ? `${role} 认为职责边界清楚，问题不在自己这边` : `${role} 反驳 ${against}：问题在对方的实现`,
          evidence: ev(role === 'frontend' || role === 'test' ? 'src/web/client.ts' : 'src/api/routes.ts'),
          ...(round === 2 && role === rebutter ? { falsifier: { kind: 'executable' as const, command: falsifierCommand, expect } } : {}),
        }),
      },
    ]),
  );
}

const CONFIRMING = 'node -e "process.exit(1)"';
const REFUTING = 'node -e "process.exit(0)"';

test('圆桌：第 2 轮质询对象由机械归因决定，而不是与会者数组顺序', async () => {
  const f = await fixture();
  try {
    const seen = new Map<RoleId, RoleId | undefined>();
    const f2 = f.session({ focusTargets: ['backend'] });
    const map = new Map(
      ROLES.map((role) => [
        role,
        {
          role,
          speak: async (round: 1 | 2, against?: RoleId) => {
            if (round === 2) seen.set(role, against);
            return { claim: `${role} 第 ${round} 轮`, evidence: ev('src/api/routes.ts') };
          },
        },
      ]),
    );
    await f2.run(map, async () => resolution());

    assert.equal(seen.get('frontend'), 'backend', '非归因目标应质询归因目标');
    assert.equal(seen.get('pm'), 'backend');
    assert.notEqual(seen.get('backend'), 'backend', '被质询方不该质询自己');
  } finally {
    await f.cleanup();
  }
});

test('圆桌：没有机械归因时（T2 甩锅）改为轮转配对，不围攻同一个人', async () => {
  const f = await fixture();
  try {
    const seen = new Map<RoleId, RoleId | undefined>();
    // focusTargets 为空 —— 这正是 T2「不知道该怪谁」的处境
    const session = f.session({ focusTargets: [] });
    const map = new Map(
      ROLES.map((role) => [
        role,
        {
          role,
          speak: async (round: 1 | 2, against?: RoleId) => {
            if (round === 2) seen.set(role, against);
            return { claim: `${role} 第 ${round} 轮`, evidence: ev('src/api/routes.ts') };
          },
        },
      ]),
    );
    await session.run(map, async () => resolution());

    // 轮转：pm→frontend, frontend→backend, backend→test, test→pm
    assert.equal(seen.get('pm'), 'frontend');
    assert.equal(seen.get('frontend'), 'backend');
    assert.equal(seen.get('backend'), 'test');
    assert.equal(seen.get('test'), 'pm');
    // 关键不变式：一轮下来要覆盖多组配对，而不是所有人围攻一个人
    assert.equal(new Set(seen.values()).size, 4, `质询对象应当分散：${JSON.stringify([...seen])}`);
  } finally {
    await f.cleanup();
  }
});

test('圆桌第 2 轮：可执行的反驳被当场执行，成立时记为机械事实', async () => {
  const f = await fixture();
  try {
    const session = f.session({ focusTargets: ['backend'] });
    const result = await session.run(speakers('frontend', CONFIRMING), async () => resolution({ attribution: 'backend' }));

    assert.equal(result.falsifiersRun, 1, '只有 frontend 携带了 falsifier，应被执行一次');
    const sustained = result.facts.filter((x) => x.outcome === 'sustained');
    assert.equal(sustained.length, 1, JSON.stringify(result.facts));
    assert.equal(sustained[0].role, 'frontend', '提出反驳的是 frontend');
    assert.equal(sustained[0].implicates, 'backend', '反驳针对 backend → 事实指向 backend');
    assert.equal(result.resolutionValid, true, result.invalidReason);
  } finally {
    await f.cleanup();
  }
});

test('圆桌第 2 轮：反驳成立但决议归罪于举证方 → 决议被判无效并升级真人', async () => {
  const f = await fixture();
  try {
    const session = f.session({ focusTargets: ['backend'] });
    // frontend 的反驳被机械证实（指向 backend），但决议把责任归给 frontend
    const result = await session.run(speakers('frontend', CONFIRMING), async () => resolution({ attribution: 'frontend' }));

    assert.equal(result.resolutionValid, false);
    assert.ok(result.invalidReason?.includes('机械证据'), result.invalidReason);
    assert.equal(result.minute.escalation, 'HUMAN', '无效决议必须升级真人');
  } finally {
    await f.cleanup();
  }
});

test('圆桌第 2 轮：反驳被证伪 → 该发言被丢弃，且不进决议输入', async () => {
  const f = await fixture();
  try {
    const session = f.session({ focusTargets: ['backend'] });
    let seenFrontendR2 = 0;
    const result = await session.run(speakers('frontend', REFUTING), async (statements) => {
      seenFrontendR2 = statements.filter((s) => s.round === 2 && s.role === 'frontend').length;
      return resolution({ attribution: 'backend' });
    });

    const refuted = result.facts.filter((x) => x.outcome === 'refuted');
    assert.equal(refuted.length, 1, JSON.stringify(result.facts));
    assert.equal(refuted[0].implicates, 'frontend', '被证伪的是反驳方自己的主张');
    // 关键：一条被机械证伪的反驳不得出现在决议的输入里，
    // 否则 LLM 会把它当成一个平等的主张来「综合考虑」，而机械已经证明它是错的。
    assert.equal(seenFrontendR2, 0, '被证伪的反驳必须从决议输入中剔除');
    assert.ok(result.discardedStatements >= 1);
  } finally {
    await f.cleanup();
  }
});

test('圆桌第 2 轮：falsifier 执行不了 → 不裁决、不产生事实（inconclusive）', async () => {
  const f = await fixture();
  try {
    // node 不在允许列表里 → 被安全策略拒绝。执行不了就不该惩罚任何一方。
    const session = f.session({
      policy: { allowBinaries: ['echo'], denyBinaries: [], timeoutMs: 5_000 },
      focusTargets: ['backend'],
    });
    const result = await session.run(speakers('frontend', CONFIRMING), async () => resolution({ attribution: 'backend' }));

    const frontendR2 = result.minute.statements.find((s) => s.round === 2 && s.role === 'frontend');
    assert.ok(frontendR2, '第 2 轮发言应当存在');
    assert.equal(frontendR2.falsifierOutcome?.outcome, 'inconclusive');
    assert.ok(frontendR2.falsifierOutcome?.detail?.includes('无法执行'), frontendR2.falsifierOutcome?.detail);
    assert.equal(result.facts.length, 0, 'inconclusive 不产生事实');
    assert.equal(frontendR2.discarded, undefined, 'inconclusive 不丢弃发言');
    assert.equal(result.resolutionValid, true, result.invalidReason);
  } finally {
    await f.cleanup();
  }
});

test('圆桌：无证据的发言仍然被丢弃（既有规则不受影响）', async () => {
  const f = await fixture();
  try {
    const session = f.session();
    const map = new Map(
      ROLES.map((role) => [
        role,
        {
          role,
          speak: async () => ({ claim: `${role} 觉得有问题`, evidence: role === 'test' ? [] : ev('src/api/routes.ts') }),
        },
      ]),
    );
    const result = await session.run(map, async () => resolution());

    const testStmt = result.minute.statements.find((s) => s.role === 'test');
    assert.ok(testStmt?.discarded?.includes('未提供任何证据'), testStmt?.discarded);
  } finally {
    await f.cleanup();
  }
});

test('圆桌：引用不存在的文件的发言被丢弃（证据核验是确定性的）', async () => {
  const f = await fixture();
  try {
    const session = f.session();
    const map = new Map(
      ROLES.map((role) => [
        role,
        {
          role,
          speak: async () => ({ claim: `${role} 引用了幻觉文件`, evidence: ev('src/does-not-exist.ts') }),
        },
      ]),
    );
    const result = await session.run(map, async () => resolution());
    assert.equal(result.minute.statements.filter((s) => !s.discarded).length, 0, '所有发言都应因幻觉证据被丢弃');
  } finally {
    await f.cleanup();
  }
});

test('圆桌决议：校验不过时回喂错误重试，而不是直接判死（结构化重试）', async () => {
  // 真实 LLM 实测补上的（docs/07 §L9）。
  // 原本是「一次机会」：一份 10 条验收条件的决议，只要 1 条没被
  // isMechanicallyCheckable 认出，整份决议就作废、项目直接带债 ——
  // 校验器的误杀被放大成了项目的失败。
  const f = await fixture();
  try {
    const session = f.session();
    const hints: Array<string | undefined> = [];
    let call = 0;

    const result = await session.run(speakers(null, CONFIRMING), async (_s, _a, _facts, retryHint) => {
      call++;
      hints.push(retryHint);
      // 第 1 次给一份验收条件不可核验的决议（模拟真实模型的措辞）
      if (call === 1) {
        return resolution({
          actions: [{ owner: 'backend', action: '改进实现质量', acceptance: ['提升可维护性'] }],
        });
      }
      // 第 2 次修正
      return resolution({
        actions: [{ owner: 'backend', action: '修正 /api/tasks 的响应结构', acceptance: ['A4 锚点 PASS'] }],
      });
    });

    assert.equal(call, 2, '校验失败后应当重试一次，而不是直接判死');
    assert.equal(hints[0], undefined, '首次调用不该带重试提示');
    assert.ok(hints[1]?.includes('无法被机械验证'), `重试必须回喂**具体**错误，实际：${hints[1]}`);
    assert.equal(result.resolutionValid, true, result.invalidReason);
    assert.equal(result.resolutionAttempts, 2);
    assert.equal(result.minute.resolutionAttempts, 2, '尝试次数必须留下取证');
  } finally {
    await f.cleanup();
  }
});

test('圆桌决议：重试有上限，改不好仍然升级真人（重试不放宽机械规则）', async () => {
  const f = await fixture();
  try {
    const session = f.session();
    let call = 0;
    const result = await session.run(speakers(null, CONFIRMING), async () => {
      call++;
      return resolution({ actions: [{ owner: 'backend', action: '改进实现质量', acceptance: ['提升可维护性'] }] });
    });

    assert.equal(call, MAX_RESOLUTION_ATTEMPTS, `应当恰好尝试 ${MAX_RESOLUTION_ATTEMPTS} 次后放弃`);
    assert.equal(result.resolutionValid, false, '重试不能把不合法的决议变成合法');
    assert.equal(result.minute.escalation, 'HUMAN', '改不好仍然升级真人');
    assert.ok(result.invalidReason?.includes('无法被机械验证'), result.invalidReason);
  } finally {
    await f.cleanup();
  }
});

test('圆桌决议：首次就合法时不产生任何多余调用', async () => {
  const f = await fixture();
  try {
    const session = f.session();
    let call = 0;
    const result = await session.run(speakers(null, CONFIRMING), async () => {
      call++;
      return resolution();
    });
    assert.equal(call, 1, '一切正常时不该多花一次 LLM 调用');
    assert.equal(result.resolutionAttempts, 1);
    assert.equal(result.resolutionValid, true);
  } finally {
    await f.cleanup();
  }
});

test('圆桌：轮数上限为 2（不会无限辩论）', async () => {
  const f = await fixture();
  try {
    const session = f.session();
    let maxRound = 0;
    const map = new Map(
      ROLES.map((role) => [
        role,
        {
          role,
          speak: async (round: 1 | 2) => {
            maxRound = Math.max(maxRound, round);
            return { claim: `${role} 第 ${round} 轮发言`, evidence: ev('src/api/routes.ts') };
          },
        },
      ]),
    );
    await session.run(map, async () => resolution());
    // 更长的辩论只会让「更能说」的角色获胜，而不是「更对」的角色获胜。
    assert.equal(maxRound, 2);
  } finally {
    await f.cleanup();
  }
});
