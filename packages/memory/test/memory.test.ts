/**
 * 记忆系统核心测试。
 *
 * 每个测试存在的理由都写在它自己的注释里 —— 因为「为什么需要这个检查」比
 * 「这个检查怎么写的」更容易在半年后被忘掉，而忘了理由的检查会被当成累赘删掉。
 *
 * 测试夹具全部建在 `workspace/.tmp-*` 下（`workspace/*` 与 `.tmp-*` 都被 gitignore）：
 * **测试绝不能依赖 `workspace/llm-*`** —— 那些是 gitignore 的真实运行数据，
 * 在干净检出上不存在。这个坑本项目踩过一次（`npm test` 依赖过 `apps/web/dist`），
 * 代价是「作者本地绿、读者第一次打开就红」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { AnchorFinding, AnchorLink } from '../../core/src/index.ts';
import {
  MEMORY_ELIGIBLE_CLASSES,
  MEMORY_SCHEMA_VERSION,
  LocalHashEmbedding,
  blobToVec,
  canonicalLessonText,
  classifyFinding,
  clusterFindings,
  collectEnvPartsFromDisk,
  diffEnv,
  efficacyOf,
  expireStaleLessons,
  fingerprintFromParts,
  getLesson,
  indexFindings,
  ingestWorkspace,
  injectableLessons,
  isMemoryEligible,
  listLessons,
  l2Normalize,
  dot,
  openMemoryDb,
  promoteLesson,
  proposeLesson,
  recordInjection,
  recordRefutations,
  retrieveByClass,
  retrieveBySimilarity,
  buildMemoryInjection,
  roleAcceptsMemory,
  vecToBlob,
  MEMORY_INJECTION_ROLES,
  type RootCauseClass,
  type MemoryDb,
} from '../src/index.ts';

// ════════════════════════════════════════════════════════════════
// 夹具
// ════════════════════════════════════════════════════════════════

const TMP_ROOT = resolve('workspace', '.tmp-memory-tests');
let seq = 0;

/**
 * 跑之前先清干净。
 *
 * 这条不是洁癖：夹具目录名由递增的 `seq` 决定，于是**跨测试运行是确定的**
 * （这次的第 4 个夹具和上次的第 4 个同名）。上次失败留下的文件会让这次
 * 在完全无关的地方假失败 —— `schema4/memory.db` 里残留的「版本 8」就是这么
 * 让 schema 测试报了一个看起来像代码 bug 的错误。
 * **测试的起点必须是确定的，否则失败信息会指向错误的地方。**
 */
test.before(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

async function makeMem(): Promise<MemoryDb> {
  return openMemoryDb(':memory:', `ws-${++seq}`);
}

type Fixture = {
  dir: string;
  cleanup: () => Promise<void>;
};

/**
 * 造一个「跑过一轮」的工作区。
 *
 * `gateAnchors` 决定 Gate 的锚点结论集合 —— 锚点轮次与 Gate 的链接靠**集合相等**，
 * 所以夹具必须把两边都写对，否则测的就不是链接逻辑而是夹具。
 */
async function makeWorkspace(opts: {
  gateAnchors?: { id: string; verdict: string }[][];
  anchors?: AnchorLink[];
  repair?: boolean;
  tsconfigExtra?: string;
} = {}): Promise<Fixture> {
  const dir = join(TMP_ROOT, `ws${++seq}`);
  await mkdir(join(dir, 'anchors'), { recursive: true });
  await mkdir(join(dir, 'runs'), { recursive: true });

  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        type: 'module',
        scripts: {
          typecheck: 'tsc --noEmit -p tsconfig.json',
          test: 'node run-tests.mjs',
          start: 'node src/api/server.ts',
        },
        agentforge: {
          healthUrl: 'http://127.0.0.1:8787/health',
          environmentNotes: ['相对导入必须带显式 `.ts` 扩展名。'],
          protectedFiles: ['run-tests.mjs'],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(dir, 'tsconfig.json'),
    `{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "allowImportingTsExtensions": true }${opts.tsconfigExtra ?? ''} }`,
    'utf8',
  );

  const runId = `run-FIX${seq}`;
  const gateAnchors = opts.gateAnchors ?? [[], [{ id: 'A4', verdict: 'FAIL' }, { id: 'A6', verdict: 'FAIL' }]];
  const decisions = [
    { seq: 1, at: '2026-01-01T00:00:00.000Z', kind: 'run.started', payload: { project: 'fixture', brief: '做一个东西' } },
    ...gateAnchors.map((a, i) => ({
      seq: 2 + i,
      at: `2026-01-01T00:0${i + 1}:00.000Z`,
      kind: 'gate.evaluated',
      payload: {
        stage: i === 0 ? 'BUILDING' : 'REVIEW',
        sequence: 1,
        blocked: false,
        hostInvoked: false,
        nextAction: { kind: 'ADVANCE' },
        anchors: a,
      },
    })),
    {
      seq: 2 + gateAnchors.length,
      at: '2026-01-01T00:09:00.000Z',
      kind: 'run.finished',
      payload: { finalStage: 'DELIVERED', delivery: 'complete', cycles: 2 },
    },
  ];
  await writeFile(join(dir, 'decisions.jsonl'), decisions.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');

  const runRecs = [
    { runId, seq: 1, at: '2026-01-01T00:00:10.000Z', role: 'backend', purpose: 'produce:CodeModule:api', attempt: 0, response: { text: '{}' } },
  ];
  if (opts.repair !== false) {
    runRecs.push({
      runId,
      seq: 2,
      at: '2026-01-01T00:02:00.000Z',
      role: 'backend',
      purpose: 'repair:CodeModule:api',
      attempt: 0,
      promptHash: 'abc',
      response: { text: '{"files":[],"notes":"把相对导入补上 .ts 扩展名"}', usage: { promptTokens: 10, completionTokens: 5 } },
    } as (typeof runRecs)[number]);
  }
  await writeFile(join(dir, 'runs', `${runId}.jsonl`), runRecs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  for (const [i, link] of (opts.anchors ?? defaultAnchors(runId)).entries()) {
    // ⚠️ 同一个**轮次**里放多个锚点结论：轮次标识是文件名去掉尾部索引，
    // 所以这里必须共用同一个 `-c1` 前缀，只用最后一段编号区分文件。
    // （第一版写成了 `-c${i+1}-001`，于是每个锚点各自成了一个轮次 ——
    // 那样测的就不是「一轮里有多个锚点」而是别的东西，测试假失败。）
    await writeFile(
      join(dir, 'anchors', `${runId}-c1-${String(i + 1).padStart(3, '0')}.json`),
      JSON.stringify(link, null, 2),
      'utf8',
    );
  }

  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

function defaultAnchors(runId: string): AnchorLink[] {
  // 两次锚点结论，合起来正好等于第二个 Gate 的 {A4:FAIL, A6:FAIL}
  return [
    anchor(`${runId}-c1`, 'A4', [
      {
        code: 'compile-error',
        severity: 'fail',
        message: "src/api/app.ts:11:8 TS2835: Relative import paths need explicit file extensions",
        file: 'src/api/app.ts',
        line: 11,
        targetRole: 'backend',
        data: { tsCode: 'TS2835' },
      },
    ]),
    anchor(`${runId}-c1`, 'A6', [
      {
        code: 'runtime-probe-failed',
        severity: 'fail',
        message: '服务进程在就绪前退出（exit 0），HTTP 探针未执行',
        targetRole: 'backend',
        data: { healthUrl: 'http://127.0.0.1:8787/health', stdout: '', stderr: '' },
      },
    ]),
  ];
}

function anchor(roundId: string, anchorId: AnchorLink['anchorId'], findings: AnchorFinding[]): AnchorLink {
  return {
    anchorId,
    runId: roundId,
    contentHashes: { 'CodeModule-T-01-api': 'deadbeef'.repeat(8) },
    verdict: findings.some((f) => f.severity === 'fail') ? 'FAIL' : 'PASS',
    findings,
    method: 'fixture',
    authority: 'authoritative',
    at: '2026-01-01T00:01:30.000Z',
    durationMs: 5,
  };
}

/** 直接往库里塞一条 finding（用于 provenance / lessons 的单元测试）。 */
function insertFinding(
  mem: MemoryDb,
  opts: {
    id: string;
    cls: string;
    at: string;
    hashes?: boolean;
    ruleId?: string;
    eligible?: boolean;
    selfReport?: boolean;
    round?: string;
    /** 归属的编排 run。省略时留 NULL（= 归不出来，宁可空着也不编）。 */
    runId?: string | null;
  },
): void {
  // 默认资格**由类决定**（与分类器一致），否则测试夹具会比真实数据宽松，
  // 测出来的就是夹具的行为而不是系统的行为。
  const eligible = opts.eligible ?? isMemoryEligible(opts.cls as RootCauseClass);
  mem.db
    .prepare(
      `INSERT OR REPLACE INTO findings
       (finding_id, run_id, gate_id, anchor_round, anchor, code, severity, message, file, line,
        target_role, data_json, class, rule_id, because, eligible, text_based, self_report, signature,
        artifact_refs_json, artifact_hashes_json, method, authority, at)
       VALUES (?, ?, NULL, ?, 'A4', 'compile-error', 'fail', 'm', NULL, NULL,
               'backend', NULL, ?, ?, 'because', ?, 0, ?, ?, '{}', ?, 'm', 'authoritative', ?)`,
    )
    .run(
      opts.id,
      opts.runId ?? null,
      opts.round ?? 'round-1',
      opts.cls,
      opts.ruleId ?? 'A4.TS2835',
      eligible ? 1 : 0,
      opts.selfReport ? 1 : 0,
      `A4|compile-error|${opts.cls}`,
      opts.hashes === false ? '{}' : JSON.stringify({ 'CodeModule-T-01-api': 'aa'.repeat(32) }),
      opts.at,
    );
}

// ════════════════════════════════════════════════════════════════
// 1. 机械根因分类
// ════════════════════════════════════════════════════════════════

test('分类器：TS2835 归为「约定没传达」而不是代码错误', () => {
  const c = classifyFinding('A4', {
    code: 'compile-error',
    severity: 'fail',
    message: 'x TS2835',
    data: { tsCode: 'TS2835' },
  });
  assert.equal(c.cls, 'convention:explicit-relative-extension');
  assert.equal(c.eligible, true);
  assert.equal(c.ruleId, 'A4.TS2835');
});

test('分类器：其它类型错误归为代码问题，且不进记忆', () => {
  const c = classifyFinding('A4', {
    code: 'compile-error',
    severity: 'fail',
    message: 'x TS2322',
    data: { tsCode: 'TS2322' },
  });
  assert.equal(c.cls, 'code:type-error');
  assert.equal(c.eligible, false);
});

test('分类器区分 A6 的三种退出形态（exit 0 = 约定，非零 = 代码，路径被拆坏 = 环境）', () => {
  const exit0 = classifyFinding('A6', {
    code: 'runtime-probe-failed',
    severity: 'fail',
    message: '服务进程在就绪前退出（exit 0），HTTP 探针未执行',
  });
  assert.equal(exit0.cls, 'convention:entry-must-self-start');

  const exit1 = classifyFinding('A6', {
    code: 'runtime-probe-failed',
    severity: 'fail',
    message: '服务进程在就绪前退出（exit 1），HTTP 探针未执行',
    data: { stderr: 'TypeError: undefined is not a function' },
  });
  assert.equal(exit1.cls, 'code:entry-crashes');
  assert.equal(exit1.eligible, false);

  const mangled = classifyFinding('A6', {
    code: 'runtime-probe-failed',
    severity: 'fail',
    message: '服务进程在就绪前退出（exit 1），HTTP 探针未执行',
    data: { stderr: "'C:\\Program' is not recognized as an internal or external command" },
  });
  assert.equal(mangled.cls, 'environment:command-path-mangling');
  assert.equal(mangled.eligible, true);
  // 这条规则依据的是**文本模式**，比结构化字段脆弱 —— 必须被标出来
  assert.equal(mangled.textBased, true);
});

test('分类器：未知形态归 unknown 且**不进记忆**（失败关闭）', () => {
  const c = classifyFinding('A2', { code: 'something-new', severity: 'warn', message: '没见过' });
  assert.equal(c.cls, 'unknown');
  assert.equal(c.eligible, false);
  assert.equal(c.ruleId, 'none');
});

test('分类器：把「引擎/人类产出的工件」当成任务交付物 → 约定类；真正的交付物缺失 → 代码类', () => {
  // 这条规则是**从新一轮真实数据里长出来的**：第一版只认 TestReport，
  // 结果同一轮里 B2 报的 AnchoredReview / Directive 全都没被认出来，
  // 掉进了 code:deliverable-missing（不进记忆）—— 这一类就永远不会被浮出来。
  const mk = (deliverable: string) => ({
    code: 'deliverable-missing',
    severity: 'fail' as const,
    message: `任务 T-09 声明交付 ${deliverable}（scope=shared），但库中不存在对应工件`,
    data: { taskId: 'T-09', deliverable },
  });

  for (const d of ['TestReport', 'AnchoredReview', 'Directive', 'RoundtableMinute', 'DebtRecord']) {
    const c = classifyFinding('B2', mk(d));
    assert.equal(c.cls, 'convention:engine-published-artifact', `${d} 应当归为「不是任务能交付的东西」`);
    assert.equal(c.eligible, true, `${d} 这一类需要被沉淀下来（它是任务图与引擎机制的错配）`);
    assert.equal(c.textBased, true, '它依据的是交付物名称而不是结构化错误码，必须标出来');
  }

  // 反面：CodeModule / TestSuite 是角色**真正**要交的东西，缺了就是没干活 —— 不许当成约定
  for (const d of ['CodeModule', 'TestSuite']) {
    const c = classifyFinding('B2', mk(d));
    assert.equal(c.cls, 'code:deliverable-missing');
    assert.equal(c.eligible, false, `${d} 缺失是产出问题，绝不能被总结成「约定」`);
  }
});

test('分类器：编译错误里出现 Record<string,unknown> → 识别为**引擎降级**，而不是角色的代码问题', () => {
  // 第 13 轮真实运行的错误原文
  const c = classifyFinding('A4', {
    code: 'compile-error',
    severity: 'fail',
    message: "src/book-store.ts:81:7 TS2322: Type 'string' is not assignable to type 'Record<string, unknown>'.",
    file: 'src/book-store.ts',
    data: { tsCode: 'TS2322' },
  });
  assert.equal(c.cls, 'contract:codegen-degraded-types');
  assert.equal(c.ruleId, 'A4.degraded-contract-types');
  assert.equal(c.textBased, true);

  // 🔴 关键：这一类**不进记忆**。
  // 它不是「告诉角色该怎么做」的约定（角色改不动冻结契约生成的类型），
  // 而是「引擎自己坏了」的信号 —— 把它当经验注入提示词只会让角色去将就坏契约。
  assert.equal(
    c.eligible,
    false,
    '引擎缺陷信号不得进记忆：那样等于教角色去适应坏契约，而不是让引擎去修',
  );

  // 而不含该标记的普通类型错误仍然是代码类
  const plain = classifyFinding('A4', {
    code: 'compile-error',
    severity: 'fail',
    message: "src/x.ts:1:1 TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
    data: { tsCode: 'TS2345' },
  });
  assert.equal(plain.cls, 'code:type-error');
});

test('分类器：相同输入永远得到相同结论（确定性）', () => {
  const f: AnchorFinding = { code: 'compile-error', severity: 'fail', message: 'm', data: { tsCode: 'TS2835' } };
  const a = classifyFinding('A4', f);
  const b = classifyFinding('A4', f);
  assert.deepEqual(a, b);
});

test('🔴 底线：可进记忆的类里**不能有任何** code/role/state/verify 类', () => {
  // 这是整个记忆系统的道德底线。如果「模型真的写错了」也能被总结成经验喂回提示词，
  // 记忆系统就变成一台生产借口的机器：流水线越来越绿、产出越来越差。
  // 这里用**结构断言**而不是逐条枚举 —— 新增一个根因类时默认结果必须是「不许进记忆」。
  const banned = ['code:', 'role:', 'state:', 'verify:', 'unknown'];
  for (const cls of MEMORY_ELIGIBLE_CLASSES) {
    for (const prefix of banned) {
      assert.ok(
        !cls.startsWith(prefix) && cls !== prefix,
        `${cls} 不允许出现在可进记忆的类里（命中禁用前缀 ${prefix}）`,
      );
    }
  }
  assert.equal(isMemoryEligible('code:type-error'), false);
  assert.equal(isMemoryEligible('code:test-assertion-failure'), false);
  assert.equal(isMemoryEligible('role:invalid-citation'), false);
  assert.equal(isMemoryEligible('unknown'), false);
});

test('分类器：引擎自述型的发现被标为 selfReport（它的「独立轮次」是假的）', () => {
  const a1 = classifyFinding('A1', { code: 'registry-unchecked', severity: 'warn', message: '离线模式' });
  assert.equal(a1.selfReport, true);
  const a6 = classifyFinding('A6', { code: 'no-run-command', severity: 'warn', message: '未配置 run' });
  assert.equal(a6.selfReport, true);
  // 反例：真正的产出缺陷不是自述
  const a4 = classifyFinding('A4', { code: 'compile-error', severity: 'fail', message: 'm', data: { tsCode: 'TS2835' } });
  assert.equal(a4.selfReport, false);
});

test('规范文本只覆盖措辞与上下文无关的类（其余必须由 LLM 提议）', () => {
  assert.ok(canonicalLessonText('convention:explicit-relative-extension'));
  assert.ok(canonicalLessonText('convention:entry-must-self-start'));
  // 需要结合项目上下文措辞的类 → 没有规范文本，只能 proposed
  assert.equal(canonicalLessonText('baseline:tampered'), null);
  assert.equal(canonicalLessonText('convention:engine-published-artifact'), null);
});

// ════════════════════════════════════════════════════════════════
// 2. 环境指纹（失效机制）
// ════════════════════════════════════════════════════════════════

test('指纹与收集顺序无关', () => {
  const a = fingerprintFromParts({ 'runtime.node': '24', 'project.srcDir': 'src' });
  const b = fingerprintFromParts({ 'project.srcDir': 'src', 'runtime.node': '24' });
  assert.equal(a.envHash, b.envHash);
});

test('diffEnv 说清「哪里变了」，而不是只给一个不同的 hash', () => {
  const d = diffEnv(
    { 'tsconfig.compilerOptions': '{"moduleResolution":"NodeNext"}' },
    { 'tsconfig.compilerOptions': '{"moduleResolution":"Bundler"}' },
  );
  assert.equal(d.length, 1);
  assert.match(d[0]!, /tsconfig\.compilerOptions/);
  assert.match(d[0]!, /NodeNext/);
  assert.match(d[0]!, /Bundler/);
});

test('指纹对 tsconfig 的**语义**变化敏感，对格式变化不敏感', async () => {
  const f1 = await makeWorkspace();
  const f2 = await makeWorkspace({ tsconfigExtra: '   ' }); // 只是多一个空白
  const f3 = await makeWorkspace();
  try {
    const a = await collectEnvPartsFromDisk(f1.dir);
    const b = await collectEnvPartsFromDisk(f2.dir);
    assert.equal(fingerprintFromParts(a).envHash, fingerprintFromParts(b).envHash, '格式差异不该让经验失效');

    // 改掉语义选项 → 必须变
    await writeFile(
      join(f3.dir, 'tsconfig.json'),
      `{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "Bundler", "allowImportingTsExtensions": true } }`,
      'utf8',
    );
    const c = await collectEnvPartsFromDisk(f3.dir);
    assert.notEqual(fingerprintFromParts(a).envHash, fingerprintFromParts(c).envHash, '语义变化必须让经验失效');
  } finally {
    await f1.cleanup();
    await f2.cleanup();
    await f3.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════
// 3. 库与向量
// ════════════════════════════════════════════════════════════════

test('向量 BLOB 往返无失真，且非 4 字节对齐时也能读', () => {
  const v = new Float32Array([1.5, -2.25, 0, 3.75]);
  const blob = vecToBlob(v);
  assert.deepEqual([...blobToVec(blob, 4)], [...v]);

  // 故意错开 1 字节：SQLite 返回的 Buffer 可能带非 4 字节对齐的 byteOffset，
  // 直接 new Float32Array(buf.buffer) 会在部分实现上抛 RangeError。
  const offset = new Uint8Array(blob.length + 1);
  offset.set(blob, 1);
  assert.deepEqual([...blobToVec(offset.subarray(1), 4)], [...v]);
});

test('归一化后点积等于余弦相似度', () => {
  const a = l2Normalize(new Float32Array([3, 4]));
  const b = l2Normalize(new Float32Array([3, 4]));
  assert.ok(Math.abs(dot(a, b) - 1) < 1e-6);
  const c = l2Normalize(new Float32Array([-4, 3]));
  assert.ok(Math.abs(dot(a, c)) < 1e-6);
  // 零向量不能除 0
  assert.deepEqual([...l2Normalize(new Float32Array([0, 0]))], [0, 0]);
});

test('schema 版本不符时**报错而不是静默改结构**（记忆库是证据）', async () => {
  // 用真实文件库验证：内存库每次都是全新的，命中不了「已存在的旧版本」这条路径。
  const dir = join(TMP_ROOT, `schema${++seq}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'memory.db');
  try {
    const a = openMemoryDb(file, 'w');
    a.db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(MEMORY_SCHEMA_VERSION + 7));
    a.close();

    assert.throws(
      () => openMemoryDb(file, 'w'),
      /schema 版本不符/,
      '记忆库是证据 —— 结构不一致时必须拒绝打开，而不是静默按新结构解读旧数据',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 4. 摄入（L1）
// ════════════════════════════════════════════════════════════════

test('摄入：把 Gate / 锚点轮次 / 发现 / 修复策略全部读出来', async () => {
  const f = await makeWorkspace();
  const mem = await makeMem();
  try {
    const s = await ingestWorkspace(mem, { workspace: f.dir });
    assert.equal(s.runs, 1);
    assert.equal(s.gates, 2);
    assert.equal(s.anchorRounds, 1);
    assert.equal(s.findings, 2);
    assert.equal(s.repairs, 1);
    assert.equal(s.eligibleFindings, 2);
    assert.deepEqual(s.byClass, {
      'convention:explicit-relative-extension': 1,
      'convention:entry-must-self-start': 1,
    });

    const repair = mem.db.prepare('SELECT * FROM repairs').get() as { purpose: string; strategy: string };
    assert.equal(repair.purpose, 'repair:CodeModule:api');
    assert.match(repair.strategy, /\.ts 扩展名/);
  } finally {
    await f.cleanup();
    mem.close();
  }
});

test('摄入：按「锚点 id + 结论」集合相等链接 Gate，链接不上就留空（不猜）', async () => {
  const f = await makeWorkspace();
  const mem = await makeMem();
  try {
    const s = await ingestWorkspace(mem, { workspace: f.dir });
    assert.equal(s.linkedFindings, 2, '集合相等时应全部链接');
    assert.equal(s.unlinkedFindings, 0);
    const rows = mem.db.prepare('SELECT gate_id FROM findings').all() as { gate_id: string | null }[];
    for (const r of rows) assert.match(r.gate_id!, /#3$/); // 第 2 个 gate 的 seq = 3
  } finally {
    await f.cleanup();
    mem.close();
  }
});

test('摄入：两个 Gate 结论完全相同时**留空并警告**，不随便挑一个', async () => {
  const same = [{ id: 'A4', verdict: 'FAIL' }, { id: 'A6', verdict: 'FAIL' }];
  const f = await makeWorkspace({ gateAnchors: [same, same] });
  const mem = await makeMem();
  try {
    const s = await ingestWorkspace(mem, { workspace: f.dir });
    assert.equal(s.unlinkedFindings, 2);
    assert.ok(
      s.warnings.some((w) => w.includes('与多个 Gate 完全相同')),
      '必须明确报告「无法唯一确定归属」，而不是静默留空',
    );
  } finally {
    await f.cleanup();
    mem.close();
  }
});

test('摄入是幂等的：同一个工作区摄入两次，行数完全一样', async () => {
  const f = await makeWorkspace();
  const mem = await makeMem();
  try {
    await ingestWorkspace(mem, { workspace: f.dir });
    const before = countAll(mem);
    const s2 = await ingestWorkspace(mem, { workspace: f.dir });
    assert.deepEqual(countAll(mem), before, '重复摄入不得产生重复行');
    assert.equal(s2.findings, 2);
  } finally {
    await f.cleanup();
    mem.close();
  }
});

function countAll(mem: MemoryDb): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ['runs', 'gates', 'findings', 'repairs', 'lessons', 'embeddings', 'workspaces']) {
    out[t] = (mem.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 5. 出处（约束①）
// ════════════════════════════════════════════════════════════════

test('出处：未知类 / 缺工件 hash 的发现被判定为「出处不完整」', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-ok', cls: 'convention:explicit-relative-extension', at: '2026-01-01T00:00:00.000Z' });
    insertFinding(mem, { id: 'F-unknown', cls: 'unknown', at: '2026-01-01T00:00:01.000Z' });
    insertFinding(mem, { id: 'F-nohash', cls: 'convention:explicit-relative-extension', at: '2026-01-01T00:00:02.000Z', hashes: false });

    const r = retrieveByClass(mem, { cls: 'convention:explicit-relative-extension', topK: 10 });
    assert.deepEqual(r.hits.map((h) => h.refId), ['F-ok'], '只有出处完整的能返回');
    assert.equal(r.droppedNoProvenance, 1);
    assert.match(r.droppedSamples[0]!.problems.join(), /hash/);
  } finally {
    mem.close();
  }
});

test('出处：检索结果**永远**带得出「谁、哪一轮、依据什么」', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-1', cls: 'convention:entry-must-self-start', at: '2026-01-01T00:00:00.000Z' });
    const r = retrieveByClass(mem, { cls: 'convention:entry-must-self-start' });
    const p = r.hits[0]!.provenance;
    assert.equal(p.findingId, 'F-1');
    assert.ok(p.anchorRound);
    assert.equal(p.anchor, 'A4');
    assert.equal(p.ruleId, 'A4.TS2835');
    assert.ok(Object.keys(p.artifactHashes).length > 0);
    assert.deepEqual(p.problems, []);
  } finally {
    mem.close();
  }
});

// ════════════════════════════════════════════════════════════════
// 6. 经验库（L3）
// ════════════════════════════════════════════════════════════════

const CONV = 'convention:explicit-relative-extension' as RootCauseClass;

test('经验：不可进记忆的类**无法**被提出', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-code', cls: 'code:type-error', at: '2026-01-01T00:00:00.000Z' });
    const r = proposeLesson(mem, {
      cls: 'code:type-error',
      evidence: ['F-code'],
      createdBy: 'llm:x',
      envHash: 'e1',
    });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /不允许进记忆/);
    assert.equal(listLessons(mem).length, 0);
  } finally {
    mem.close();
  }
});

test('经验：没有证据就无法成立（出处是地基，不是装饰）', async () => {
  const mem = await makeMem();
  try {
    const r = proposeLesson(mem, { cls: CONV, evidence: [], createdBy: 'llm:x', envHash: 'e1' });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /没有证据/);
  } finally {
    mem.close();
  }
});

test('经验：证据的根因类与经验声明的类必须一致（不许拿 A 类事实论证 B 类经验）', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-1', cls: 'convention:entry-must-self-start', at: '2026-01-01T00:00:00.000Z' });
    const r = proposeLesson(mem, { cls: CONV, evidence: ['F-1'], createdBy: 'llm:x', envHash: 'e1' });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /不一致/);
  } finally {
    mem.close();
  }
});

test('经验：证据出处不完整时不能被当作论据', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-nohash', cls: CONV, at: '2026-01-01T00:00:00.000Z', hashes: false });
    const r = proposeLesson(mem, { cls: CONV, evidence: ['F-nohash'], createdBy: 'llm:x', envHash: 'e1' });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /出处不完整/);
  } finally {
    mem.close();
  }
});

test('🔴 约束③：LLM 写入**只能**到达 proposed，没有 API 能让它直接 active', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-1', cls: CONV, at: '2026-01-01T00:00:00.000Z' });
    insertFinding(mem, { id: 'F-2', cls: CONV, at: '2026-01-01T00:00:01.000Z', round: 'round-2' });
    // 即使证据条数已经够自动提升，proposeLesson 的产物也必须是 proposed。
    const r = proposeLesson(mem, { cls: CONV, evidence: ['F-1', 'F-2'], createdBy: 'llm:deepseek', envHash: 'e1' });
    assert.equal(r.ok, true);
    const l = getLesson(mem, r.ok ? r.lessonId : '');
    assert.equal(l!.status, 'proposed', 'LLM 的产出必须停在 proposed');
    assert.equal(l!.createdBy, 'llm:deepseek');
    // 而且要生效必须显式调用 promoteLesson（另一个函数、另一组确定性检查）
    const p = promoteLesson(mem, l!.lessonId, { by: 'auto', currentEnvHash: 'e1' });
    assert.equal(p.ok, true);
    assert.equal(getLesson(mem, l!.lessonId)!.status, 'active');
  } finally {
    mem.close();
  }
});

test('经验：独立证据不足时机器不许提升，人类可以豁免', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-1', cls: CONV, at: '2026-01-01T00:00:00.000Z' });
    const r = proposeLesson(mem, { cls: CONV, evidence: ['F-1'], createdBy: 'llm:x', envHash: 'e1' });
    const id = r.ok ? r.lessonId : '';

    const auto = promoteLesson(mem, id, { by: 'auto', currentEnvHash: 'e1' });
    assert.equal(auto.ok, false);
    assert.match(auto.ok === false ? auto.reason : '', /少于自动生效所需/);

    const human = promoteLesson(mem, id, { by: 'human:liezhuren', currentEnvHash: 'e1' });
    assert.equal(human.ok, true);
    assert.match(human.ok ? human.reason : '', /人类豁免/);
  } finally {
    mem.close();
  }
});

test('经验：全部证据都是「引擎自述」时机器不许自动提升（条数是假的）', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, {
      id: 'F-sr1', cls: 'environment:offline-registry', at: '2026-01-01T00:00:00.000Z', selfReport: true, round: 'r1',
    });
    insertFinding(mem, {
      id: 'F-sr2', cls: 'environment:offline-registry', at: '2026-01-01T00:00:01.000Z', selfReport: true, round: 'r2',
    });
    const r = proposeLesson(mem, {
      cls: 'environment:offline-registry',
      evidence: ['F-sr1', 'F-sr2'],
      text: '不要引入第三方依赖。',
      createdBy: 'llm:x',
      envHash: 'e1',
    });
    assert.equal(r.ok, true);
    const auto = promoteLesson(mem, r.ok ? r.lessonId : '', { by: 'auto', currentEnvHash: 'e1' });
    assert.equal(auto.ok, false);
    assert.match(auto.ok === false ? auto.reason : '', /自述模式/);
  } finally {
    mem.close();
  }
});

test('经验：环境指纹不一致时不许提升，并被降级为 stale', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-1', cls: CONV, at: '2026-01-01T00:00:00.000Z' });
    const r = proposeLesson(mem, { cls: CONV, evidence: ['F-1'], createdBy: 'canonical:x', envHash: 'e-old' });
    const id = r.ok ? r.lessonId : '';
    const p = promoteLesson(mem, id, { by: 'human:h', currentEnvHash: 'e-new' });
    assert.equal(p.ok, false);
    assert.match(p.ok === false ? p.reason : '', /环境指纹不一致/);
  } finally {
    mem.close();
  }
});

test('失效：环境指纹变了 → active 经验降级为 stale，且**不进提示词**', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-1', cls: CONV, at: '2026-01-01T00:00:00.000Z' });
    insertFinding(mem, { id: 'F-2', cls: CONV, at: '2026-01-01T00:00:01.000Z', round: 'round-2' });
    const r = proposeLesson(mem, { cls: CONV, evidence: ['F-1', 'F-2'], createdBy: 'canonical:x', envHash: 'e1' });
    const id = r.ok ? r.lessonId : '';
    promoteLesson(mem, id, { by: 'auto', currentEnvHash: 'e1' });

    const got = injectableLessons(mem, { currentEnvHash: 'e1' });
    assert.equal(got.lessons.length, 1, '指纹一致时应可注入');

    const expired = expireStaleLessons(mem, 'e2');
    assert.equal(expired.length, 1);
    assert.equal(getLesson(mem, id)!.status, 'stale');
    assert.equal(injectableLessons(mem, { currentEnvHash: 'e2' }).lessons.length, 0, '失效后不得再进提示词');
  } finally {
    mem.close();
  }
});

test('失效：证据在注入前复核时已不可用 → 降级为 stale，而不是静默跳过', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'F-1', cls: CONV, at: '2026-01-01T00:00:00.000Z' });
    const r = proposeLesson(mem, { cls: CONV, evidence: ['F-1'], createdBy: 'canonical:x', envHash: 'e1' });
    const id = r.ok ? r.lessonId : '';
    promoteLesson(mem, id, { by: 'human:h', currentEnvHash: 'e1' });

    // 证据被删（模拟库被裁剪 / 工作区被清）
    mem.db.prepare('DELETE FROM findings WHERE finding_id = ?').run('F-1');

    const got = injectableLessons(mem, { currentEnvHash: 'e1' });
    assert.equal(got.lessons.length, 0);
    assert.equal(got.rejected.length, 1);
    assert.equal(getLesson(mem, id)!.status, 'stale', '「静默无效比明确拒绝更糟」—— 必须降级留痕');
  } finally {
    mem.close();
  }
});

// ════════════════════════════════════════════════════════════════
// 7. 有效性追踪
// ════════════════════════════════════════════════════════════════

async function activeLesson(mem: MemoryDb, envHash = 'e1'): Promise<string> {
  insertFinding(mem, { id: 'E-1', cls: CONV, at: '2026-01-01T00:00:00.000Z' });
  insertFinding(mem, { id: 'E-2', cls: CONV, at: '2026-01-01T00:00:01.000Z', round: 'round-2' });
  const r = proposeLesson(mem, { cls: CONV, evidence: ['E-1', 'E-2'], createdBy: 'canonical:x', envHash });
  const id = r.ok ? r.lessonId : '';
  promoteLesson(mem, id, { by: 'auto', currentEnvHash: envHash });
  return id;
}

test('有效性：从未注入过 → unproven（而不是「有效」）', async () => {
  const mem = await makeMem();
  try {
    const id = await activeLesson(mem);
    const e = efficacyOf(mem, id);
    assert.equal(e!.verdict, 'unproven');
    assert.equal(e!.injectedCount, 0);
  } finally {
    mem.close();
  }
});

test('有效性：注入之后**早于注入**的同类失败不算反证', async () => {
  const mem = await makeMem();
  try {
    const id = await activeLesson(mem);
    // 库里已经有 2 条同类失败，但它们都在注入之前 —— 不能算成这条经验的反证，
    // 否则一条经验一注入就会**立刻自我否决**。
    recordInjection(mem, [id], { runId: 'r1', at: '2026-06-01T00:00:00.000Z' });
    const e = efficacyOf(mem, id);
    assert.equal(e!.refutedCount, 0, '早于注入的失败不能算反证');

    // 而且此时**没有任何后续观测**，所以只能是 unproven。
    // 这一点值得显式断言：如果把「没观测到复发」也算成好消息，
    // 就等于把「什么都没测」当成「测过了且通过」—— 那正是 SKIPPED ≠ PASS 那条不变量。
    assert.equal(e!.exposures, 0);
    assert.equal(e!.verdict, 'unproven');
    assert.match(e!.explanation, /还没有任何后续轮次/);
  } finally {
    mem.close();
  }
});

test('有效性：注入之后同类失败再现 → counter-evidence，达到阈值自动停用', async () => {
  const mem = await makeMem();
  try {
    const id = await activeLesson(mem);
    recordInjection(mem, [id], { runId: 'r1', at: '2026-06-01T00:00:00.000Z' });
    insertFinding(mem, { id: 'E-3', cls: CONV, at: '2026-06-02T00:00:00.000Z', round: 'round-3' });
    let e = efficacyOf(mem, id);
    assert.equal(e!.refutedCount, 1);
    assert.equal(e!.verdict, 'counter-evidence');

    // 阈值 2：只有 1 次反证时不降级
    const r1 = recordRefutations(mem, { threshold: 2 });
    assert.equal(r1[0]!.demoted, false);
    assert.equal(getLesson(mem, id)!.status, 'active');

    insertFinding(mem, { id: 'E-4', cls: CONV, at: '2026-06-03T00:00:00.000Z', round: 'round-4' });
    const r2 = recordRefutations(mem, { threshold: 2 });
    assert.equal(r2[0]!.demoted, true);
    assert.equal(getLesson(mem, id)!.status, 'refuted', '两次反证后必须停用');
    assert.equal(injectableLessons(mem, { currentEnvHash: 'e1' }).lessons.length, 0);
  } finally {
    mem.close();
  }
});

test('有效性：时间戳**恰好相同**时不算反证（边界必须被钉住，否则改 > 为 >= 也无人发现）', async () => {
  const mem = await makeMem();
  try {
    const id = await activeLesson(mem);
    const T = '2026-06-01T12:00:00.000Z';
    recordInjection(mem, [id], { runId: 'r1', at: T });

    // 与注入**同一毫秒**的同类失败：无法判断它是「注入之后才犯的」还是「注入时就已经在跑」的。
    insertFinding(mem, { id: 'T-1', cls: CONV, at: T, round: 'round-tie' });
    assert.equal(
      efficacyOf(mem, id)!.refutedCount,
      0,
      '同一瞬间的失败不能当成反证 —— 反证是「停用一条经验」的依据，宁可不判',
    );

    // 晚 1 毫秒就算证据：它确实发生在注入之后
    insertFinding(mem, { id: 'T-2', cls: CONV, at: '2026-06-01T12:00:00.001Z', round: 'round-after' });
    assert.equal(efficacyOf(mem, id)!.refutedCount, 1);
    assert.equal(efficacyOf(mem, id)!.verdict, 'counter-evidence');
  } finally {
    mem.close();
  }
});

test('有效性：结论措辞保守 —— 「无反证」不叫「有效」', async () => {
  const mem = await makeMem();
  try {
    const id = await activeLesson(mem);
    recordInjection(mem, [id], { runId: 'r1', at: '2026-06-01T00:00:00.000Z' });
    insertFinding(mem, { id: 'E-9', cls: 'code:type-error', at: '2026-06-05T00:00:00.000Z', round: 'round-9' });
    const e = efficacyOf(mem, id)!;
    assert.equal(e.verdict, 'no-counter-evidence');
    // 「模型说得更肯定了」不是成果（§6.15 的同类）：没有对照实验，
    // 能诚实说的只有「尚无反证」，绝不能说「有效」。
    assert.match(e.explanation, /不等于它有效/);
    assert.match(e.explanation, /没有对照实验/);
  } finally {
    mem.close();
  }
});

// ════════════════════════════════════════════════════════════════
// 8. 检索（L2）
// ════════════════════════════════════════════════════════════════

test('检索：先筛后排 —— 被排除的 run 与超出 topK 的都不返回', async () => {
  const mem = await makeMem();
  try {
    for (let i = 0; i < 6; i++) {
      insertFinding(mem, {
        id: `R-${i}`,
        cls: CONV,
        at: `2026-01-0${i + 1}T00:00:00.000Z`,
        round: `round-${i}`,
      });
    }
    mem.db.prepare(`UPDATE findings SET run_id = 'run-A' WHERE finding_id IN ('R-0','R-1')`).run();
    mem.db.prepare(`UPDATE findings SET run_id = 'run-B' WHERE finding_id IN ('R-2','R-3')`).run();

    const all = retrieveByClass(mem, { cls: CONV, topK: 10 });
    assert.equal(all.candidates, 6);
    assert.equal(all.hits.length, 6);

    const noA = retrieveByClass(mem, { cls: CONV, topK: 10, excludeRunId: 'run-A' });
    assert.equal(noA.hits.length, 4);
    assert.ok(!noA.hits.some((h) => h.refId === 'R-0'));

    const top2 = retrieveByClass(mem, { cls: CONV, topK: 2 });
    assert.equal(top2.hits.length, 2);
    assert.equal(top2.candidates, 6, 'topK 只裁结果，不该让 candidates 变小 —— 否则「筛掉了多少」就被隐藏了');
  } finally {
    mem.close();
  }
});

test('检索：相似度命中也带完整出处；索引覆盖率是实测值', async () => {
  const f = await makeWorkspace();
  const mem = await makeMem();
  try {
    await ingestWorkspace(mem, { workspace: f.dir });
    const embedder = new LocalHashEmbedding(256);
    const idx = await indexFindings(mem, embedder);
    assert.equal(idx.indexed, 2);
    assert.equal(idx.total, 2);

    const r = await retrieveBySimilarity(mem, embedder, {
      text: '服务进程在就绪前退出（exit 0），HTTP 探针未执行',
      topK: 3,
    });
    assert.ok(r.hits.length > 0);
    assert.equal(r.hits[0]!.row.code, 'runtime-probe-failed', '同一句话应排第一');
    assert.ok(r.hits[0]!.score! > 0.9);
    for (const h of r.hits) {
      assert.ok(h.provenance.anchorRound, '相似度命中同样必须带出处');
      assert.deepEqual(h.provenance.problems, []);
    }
  } finally {
    await f.cleanup();
    mem.close();
  }
});

test('检索：本地向量能分辨「同一症状族」，但不能分辨根因 —— 所以类过滤才是主路径', async () => {
  const f = await makeWorkspace();
  const mem = await makeMem();
  try {
    await ingestWorkspace(mem, { workspace: f.dir });
    const embedder = new LocalHashEmbedding(512);
    await indexFindings(mem, embedder);

    // 查询是「服务起不来」，A6 的两条应当明显高于 A4 的编译错误
    const r = await retrieveBySimilarity(mem, embedder, { text: '服务起不来，进程退出', topK: 2 });
    const codes = r.hits.map((h) => h.row.code);
    assert.ok(codes.includes('runtime-probe-failed'));

    // 而**根因**的区分只能靠确定性类过滤：exit 0（约定）与 exit 1（代码）的
    // 措辞几乎一样，相似度分不开，但类分得开。
    const conv = retrieveByClass(mem, { cls: 'convention:entry-must-self-start' });
    assert.equal(conv.hits.length, 1);
    assert.equal(conv.hits[0]!.provenance.ruleId, 'A6.exit0');
  } finally {
    await f.cleanup();
    mem.close();
  }
});

// ════════════════════════════════════════════════════════════════
// 9. 聚类
// ════════════════════════════════════════════════════════════════

test('聚类：按（类, 签名）确定性分组，够不够条件说清原因', async () => {
  const mem = await makeMem();
  try {
    insertFinding(mem, { id: 'C-1', cls: CONV, at: '2026-01-01T00:00:00.000Z', round: 'r1' });
    insertFinding(mem, { id: 'C-2', cls: CONV, at: '2026-01-02T00:00:00.000Z', round: 'r2' });
    insertFinding(mem, { id: 'C-3', cls: 'code:type-error', at: '2026-01-03T00:00:00.000Z', round: 'r3' });
    insertFinding(mem, {
      id: 'C-4', cls: 'environment:offline-registry', at: '2026-01-04T00:00:00.000Z', round: 'r4', selfReport: true,
    });
    insertFinding(mem, {
      id: 'C-5', cls: 'environment:offline-registry', at: '2026-01-05T00:00:00.000Z', round: 'r5', selfReport: true,
    });

    const clusters = clusterFindings(mem);
    const conv = clusters.find((c) => c.cls === CONV)!;
    assert.equal(conv.rounds.length, 2);
    assert.equal(conv.readyToPromote, true);
    assert.ok(conv.canonicalText, '这一类的措辞是确定的，不该让模型写');

    assert.ok(!clusters.some((c) => c.cls === 'code:type-error'), '代码类根本不该出现在候选里');

    const sr = clusters.find((c) => c.cls === 'environment:offline-registry')!;
    assert.equal(sr.selfReport, true);
    assert.equal(sr.readyToPromote, false, '自述型簇的「轮次数」等于工作区数，不许自动生效');
    assert.match(sr.notReadyReason!, /自述模式/);
  } finally {
    mem.close();
  }
});

// ════════════════════════════════════════════════════════════════
// 10. 注入边界：谁能收到经验
// ════════════════════════════════════════════════════════════════

test('🔴 注入白名单：PM 与主理人**收不到**经验（它们的产出本身就是判定基准）', () => {
  assert.deepEqual([...MEMORY_INJECTION_ROLES], ['frontend', 'backend', 'test']);
  assert.equal(roleAcceptsMemory('pm'), false);
  assert.equal(roleAcceptsMemory('host'), false);
  assert.equal(roleAcceptsMemory('frontend'), true);
  assert.equal(roleAcceptsMemory('backend'), true);
  assert.equal(roleAcceptsMemory('test'), true);
});

test('注入：给 PM 构造注入时返回空并说明原因（不是静默为空）', async () => {
  const mem = await makeMem();
  try {
    const inj = buildMemoryInjection(mem, { role: 'pm', currentEnvHash: 'e1' });
    assert.equal(inj.count, 0);
    assert.equal(inj.block, '');
    assert.equal(inj.rejected.length, 1);
    assert.match(inj.rejected[0]!.reason, /白名单/);
  } finally {
    mem.close();
  }
});

test('注入：写入注入记录（这是「经验有没有用」唯一的数据来源）', async () => {
  const mem = await makeMem();
  try {
    const id = await activeLesson(mem);
    const inj = buildMemoryInjection(mem, {
      role: 'backend',
      currentEnvHash: 'e1',
      runId: 'run-X',
      now: '2026-07-01T00:00:00.000Z',
    });
    assert.equal(inj.count, 1);
    assert.equal(inj.lessonIds[0], id);
    assert.match(inj.block, /经验/);
    assert.equal(getLesson(mem, id)!.injectedCount, 1);
    assert.equal(getLesson(mem, id)!.lastInjectedAt, '2026-07-01T00:00:00.000Z');
    // 不记注入 → 这条经验会永远停在 unproven，也就永远无法证明它该不该留
    const e = efficacyOf(mem, id)!;
    assert.equal(e.injectedCount, 1);
  } finally {
    mem.close();
  }
});

test('注入：内容里带得出处（可审计「这一轮它到底被告知了什么」的前半段）', async () => {
  const mem = await makeMem();
  try {
    await activeLesson(mem);
    const inj = buildMemoryInjection(mem, { role: 'backend', currentEnvHash: 'e1', record: false });
    assert.equal(inj.provenance.length, 1);
    assert.equal(inj.provenance[0]!.evidence.length, 2);
    assert.match(inj.provenance[0]!.evidence[0]!.why, /A4/);
  } finally {
    mem.close();
  }
});

test.after(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});
