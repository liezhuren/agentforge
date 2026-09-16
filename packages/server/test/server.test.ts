import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { silentLogger } from '../../core/src/index.ts';
import { createForgeServer, type ForgeServer } from '../src/index.ts';
import { resolveStaticFile } from '../src/http.ts';
import { deriveVerdict } from '../src/run-manager.ts';

// ════════════════════════════════════════════════════════════════
// 「真·完整」判定：服务端唯一派生处，覆盖两个维度的四个格子
// ════════════════════════════════════════════════════════════════

const summaryWith = (
  delivery: 'complete' | 'with-debt' | 'awaiting-human' | 'held',
  statuses: string[],
): Parameters<typeof deriveVerdict>[0] =>
  ({ delivery, requirementStatuses: statuses.map((s, i) => ({ id: `R-00${i + 1}`, status: s })) }) as never;

test('交付判定：两个维度互相独立，四个格子都如实（这是设计依据）', () => {
  // 实测 10 轮真实运行的 38 条需求判定显示机械层与需求层**互相独立**：
  //   机械❌ 需求✅ —— llm-4 (8/0/0)、llm-6 (2/0/0)
  //   机械✅ 需求❓ —— llm-9 (0/2/0)
  //   机械✅ 需求✅ —— llm-10
  //   机械❌ 需求❓ —— 其余多轮
  // 所以既不能「需求没全 met 就不许叫 complete」（会冤枉 llm-4/6），
  // 也不能「complete 就当成需求通过」（llm-9 就是假绿灯）。

  // ① 机械✅ 需求✅ → 唯一亮「真·完整」的格子
  const a = deriveVerdict(summaryWith('complete', ['met', 'met']));
  assert.equal(a.fullyVerified, true);
  assert.equal(a.requirements, 'verified');
  assert.ok(a.summary.includes('全部验证通过'), a.summary);

  // ② 机械✅ 需求❓ → **不得**是 fullyVerified；措辞必须点明「确认不了 ≠ 没查」
  const b = deriveVerdict(summaryWith('complete', ['met', 'unverified']));
  assert.equal(b.fullyVerified, false, '机械全过但有一条确认不了 ⇒ 不能声称完整');
  assert.equal(b.requirements, 'unverified');
  assert.equal(b.mechanical, 'complete', '机械维度本身是过的，不能一起否定 —— 那是另一个事实');
  assert.ok(b.summary.includes('确认不了'), b.summary);
  assert.ok(b.summary.includes('不是没查'), `必须区分「查过但说不清」与「还没查」：${b.summary}`);

  // ③ 机械❌ 需求✅ → 需求维度必须仍然是 verified（否则会冤枉「需求其实都达成了」）
  const c = deriveVerdict(summaryWith('with-debt', ['met', 'met']));
  assert.equal(c.fullyVerified, false, '带债不能算真·完整');
  assert.equal(c.requirements, 'verified', '需求确实都达成了，这个事实不能因为机械层失败而被抹掉');
  assert.equal(c.mechanical, 'with-debt');

  // ④ 机械❌ 需求❓
  const d = deriveVerdict(summaryWith('with-debt', ['unverified', 'open']));
  assert.equal(d.fullyVerified, false);
  assert.equal(d.requirements, 'unverified', 'unverified 比 open 更值得提示：它是「查了但说不清」');

  // 边界：没有需求、未运行
  assert.equal(deriveVerdict(summaryWith('complete', [])).requirements, 'no-requirements');
  assert.equal(deriveVerdict(null).mechanical, 'unknown');
  assert.equal(deriveVerdict(null).fullyVerified, false);

  // counts 必须与传入一致（界面直接渲染它，不能再聚合一遍）
  const e = deriveVerdict(summaryWith('with-debt', ['met', 'unverified', 'open', 'accepted_with_debt']));
  assert.deepEqual(e.counts, { met: 1, unverified: 1, open: 1, acceptedWithDebt: 1, total: 4 });
});

test('交付判定：/api/state 必须带上服务端派生的 verdict（前端不得自己重算）', async () => {
  await withServer(async (forge, base) => {
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'clean', fresh: true });
    await forge.manager.wait();

    const s = (await getJson(`${base}/api/state`)).body as {
      delivery: string;
      verdict: {
        fullyVerified: boolean;
        mechanical: string;
        requirements: string;
        counts: { met: number; total: number };
        summary: string;
      };
    };

    assert.ok(s.verdict, 'verdict 必须存在 —— 界面的两个维度都读它');
    // clean 场景的 mock 给的是 met，所以两轴都过
    assert.equal(s.verdict.mechanical, 'complete');
    assert.equal(s.verdict.requirements, 'verified');
    assert.equal(s.verdict.fullyVerified, true);
    assert.equal(s.verdict.counts.met, s.verdict.counts.total);
    assert.ok(s.verdict.summary.length > 0, '措辞由服务端统一给，避免各处拼出不同说法');
  });
});

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

async function withServer<T>(
  fn: (s: ForgeServer, base: string) => Promise<T>,
  /** 允许测试指定静态目录 —— 静态行为不该依赖本机是否构建过控制台。 */
  opts: { staticDir?: string } = {},
): Promise<T> {
  const wsRoot = await mkdtemp(join(tmpdir(), 'af-srv-ws-'));
  const forge = await createForgeServer({
    // 用独立的工作区根，避免测试写进仓库的 workspace/
    root: ROOT,
    workspaceRoot: wsRoot,
    logger: silentLogger('srv-test'),
    port: 0,
    ...(opts.staticDir ? { staticDir: opts.staticDir } : {}),
  });
  try {
    return await fn(forge, forge.url);
  } finally {
    // 必须先等 run 落定再删目录：run 是异步跑的，边跑边删会得到 ENOTEMPTY，
    // 而且那是测试自身制造的假失败，不是产品问题。
    await forge.manager.wait().catch(() => {});
    await forge.close();
    await rm(wsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const getJson = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const postJson = async (url: string, body: unknown) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

// ════════════════════════════════════════════════════════════════

test('服务端：健康检查与初始状态', async () => {
  await withServer(async (_forge, base) => {
    const health = await getJson(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const state = await getJson(`${base}/api/state`);
    assert.equal(state.status, 200);
    assert.equal(state.body.status, 'idle');
    const scenarios = state.body.scenarios as Array<{ id: string; title: string }>;
    assert.deepEqual(
      scenarios.map((s) => s.id).sort(),
      ['clean', 'cross-exam', 'deadlock', 'hallucination', 'real-app'],
      '应当列出五个离线演示场景（含真实应用模式）',
    );
    // 每个场景都必须有可读的标题与描述 —— 否则界面上是个空下拉框
    for (const s of scenarios) {
      assert.ok(s.title.length > 0 && (s as { description?: string }).description!.length > 0, JSON.stringify(s));
    }
  });
});

test('服务端：静态资源与 SPA 回退（自带构建产物，不依赖别人跑过 npm run build）', async () => {
  // 期望值：静态行为不该取决于「本机有没有构建过控制台」。
  // 之前这个测试直接读仓库里的 apps/web/dist —— 而那是 .gitignore 的构建产物，
  // 于是**干净检出跑 npm test 会红一个**（作者本地绿、读者第一次打开就红）。
  // 现在自己造一个假 dist，两种行为都断言，任何机器上都确定。
  const parent = await mkdtemp(join(tmpdir(), 'af-static-'));
  const dist = join(parent, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(
    join(dist, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script src="/assets/index-abc.js"></script></body></html>',
    'utf8',
  );
  await writeFile(join(dist, 'assets', 'index-abc.js'), 'console.log("built")', 'utf8');
  // 放在静态目录**外面**的哨兵：任何目录穿越都会把它带出来
  const SENTINEL = 'TOP-SECRET-SENTINEL-9f3a';
  await writeFile(join(parent, 'SECRET.txt'), SENTINEL, 'utf8');

  try {
    await withServer(
      async (_forge, base) => {
        const res = await fetch(`${base}/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('<div id="root">'), '应返回控制台 HTML');
        assert.ok(/assets\/index-.*\.js/.test(html), '应引用构建出的 JS');

        // 静态资源本身要能被取到，且 content-type 正确
        const js = await fetch(`${base}/assets/index-abc.js`);
        assert.equal(js.status, 200);
        assert.ok(js.headers.get('content-type')?.includes('javascript'), 'MIME 要按扩展名给对');

        // 未命中的路径回退到 index.html（前端路由需要）
        const spa = await fetch(`${base}/some/deep/route`);
        assert.equal(spa.status, 200);
        assert.ok((await spa.text()).includes('<div id="root">'));

        // 说明：这里**不做**目录穿越断言。
        // 走 HTTP 测不到那条守卫 —— `path.normalize` 会把结果锚定到根，
        // `..` 在越界检查之前就已被消掉；而且 WHATWG URL 在发请求前也会先规范化掉 `..`。
        // （原版测试正是在这里落空的，两个独立原因同时让它形同虚设。）
        // 真正的验证见下面的 `resolveStaticFile` 单元测试。
      },
      { staticDir: dist },
    );
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('静态文件路径解析：结果永远落在静态目录内（含各类穿越尝试）', () => {
  const dist = join('C:', 'proj', 'apps', 'web', 'dist');
  const inside = (p: string) => p === dist || p.startsWith(dist + sep);

  // ── 正常路径 ────────────────────────────────────────────────
  assert.equal(resolveStaticFile(dist, '/index.html'), join(dist, 'index.html'));
  assert.equal(resolveStaticFile(dist, '/assets/index-abc.js'), join(dist, 'assets', 'index-abc.js'));
  assert.equal(resolveStaticFile(dist, '/'), dist, '根路径解析到目录本身，由调用方回退到 index.html');

  // ── 核心不变量 ──────────────────────────────────────────────
  //
  // 守的是**不变量**而不是某条分支：无论输入多恶意，结果要么是 null，
  // 要么必须落在 staticDir 内。这条性质比「必须返回 null」更准确 ——
  // 实测 `/../SECRET.txt` 会被 normalize 锚定到根、解析成 dist 内的路径，
  // 那是**安全**的结果（没有逃逸），不该被断言成 null。
  //
  // 在这条路径上守卫本身其实不可达（normalize 已经锚定了根，
  // 而 WHATWG URL 还会在发请求前先规范化掉 `..`），所以它属于纵深防御。
  // 这个测试真正的价值是：**将来若有人把 join 改成 resolve、或去掉 strip，
  // 逃逸会立刻变红** —— 那正是最常见的重构方向。
  for (const evil of [
    '/../SECRET.txt',
    '/../../SECRET.txt',
    '/..%2fSECRET.txt',
    '/%2e%2e%2fSECRET.txt',
    '/assets/../../SECRET.txt',
    '/%2e%2e/%2e%2e/SECRET.txt',
    '/....//SECRET.txt',
    '/../dist-evil/x.txt', // 同前缀兄弟目录：`startsWith(staticDir)` 的经典误判场景
    '/%00/index.html',
  ]) {
    const got = resolveStaticFile(dist, evil);
    if (got !== null) {
      assert.ok(inside(got), `${evil} 解析成了静态目录外的路径：${got}`);
    }
  }

  // ── 前缀比较必须算上分隔符 ──────────────────────────────────
  // 原实现是 `abs.startsWith(staticDir)`：`<dist>-evil/x` 也以 `<dist>` 开头，会被误放行。
  // 这里直接对比较逻辑做断言（用绝对路径喂进去，绕过 normalize 的锚定）。
  const sibling = join('C:', 'proj', 'apps', 'web', 'dist-evil', 'x.txt');
  assert.ok(
    !(sibling === dist || sibling.startsWith(dist + sep)),
    '前提校验：dist-evil 必须与 dist 同前缀但不落在 dist 内，否则这个用例没意义',
  );
  assert.ok(sibling.startsWith(dist), '前提校验：sibling 确实满足旧实现的错误判据');
});

test('服务端：没有构建产物时给出构建指引，而不是 404 或崩溃', async () => {
  // 这是使用者第一次接触控制台时**唯一**会看到的页面，所以它本身就该被测。
  const missing = join(tmpdir(), `af-no-dist-${Date.now()}-not-there`);
  await withServer(
    async (_forge, base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200, '缺前端产物是配置状态，不是错误 —— 不该报 404/500');
      const html = await res.text();
      assert.ok(html.includes('尚未构建'), '要明确告诉使用者「前端还没构建」');
      assert.ok(html.includes('npm run build'), '要给出可直接照做的命令，而不是只报错');
      assert.ok(html.includes('/api/state'), '要提示此时 API 仍然可用，别让人以为整个服务坏了');
      assert.ok(!html.includes('<div id="root">'), '此时不该冒充已构建的页面');

      // API 不因此受影响
      const health = await getJson(`${base}/api/health`);
      assert.equal(health.status, 200);
    },
    { staticDir: missing },
  );
});

test('服务端：SSE 事件流首帧推全量状态，随后推增量事件', async () => {
  await withServer(async (_forge, base) => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // 读首帧
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    assert.ok(buf.startsWith('event: state'), `首帧应当是完整状态，实际：${buf.slice(0, 80)}`);
    const firstData = JSON.parse(buf.split('data: ')[1].split('\n')[0]) as { status: string };
    assert.equal(firstData.status, 'idle');

    // 启动一个 run，应当继续从这个连接收到 forge 事件
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'clean', fresh: true });

    const seen = new Set<string>();
    const deadline = Date.now() + 30_000;
    // INTAKE 阶段没有锚点（STAGE_ANCHORS.INTAKE 为空），因此 anchor.ran 要到
    // PLANNING 的 B2 才会出现 —— 目标事件数给足，避免测试自身过早收工。
    while (seen.size < 30 && !seen.has('anchor.ran') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const m = /^event: forge\ndata: (.*)$/m.exec(chunk);
        if (!m) continue;
        try {
          seen.add((JSON.parse(m[1]) as { t: string }).t);
        } catch {
          /* 半帧 */
        }
      }
    }
    ctrl.abort();

    assert.ok(seen.has('run.started'), `应收到 run.started，实际：${[...seen].join(', ')}`);
    assert.ok(seen.has('stage.enter'), `应收到 stage.enter，实际：${[...seen].join(', ')}`);
    assert.ok(seen.has('artifact.published'), `应收到 artifact.published，实际：${[...seen].join(', ')}`);
    assert.ok(seen.has('anchor.ran'), `应收到 anchor.ran，实际：${[...seen].join(', ')}`);
    assert.ok(seen.has('gate.evaluated'), `应收到 gate.evaluated，实际：${[...seen].join(', ')}`);
  });
});

test('服务端：跑通完整离线演示（clean 场景），状态可被前端完整投影', async () => {
  await withServer(async (forge, base) => {
    const started = await postJson(`${base}/api/run`, {
      mode: 'demo',
      scenario: 'clean',
      brief: '做一个任务看板',
      fresh: true,
    });
    assert.equal(started.status, 202);
    const runtime = started.body.runtime as { runId: string; mode: string };
    assert.equal(runtime.mode, 'demo');

    await forge.manager.wait();

    const state = await getJson(`${base}/api/state`);
    const s = state.body as Record<string, unknown>;
    assert.equal(s.status, 'finished');
    assert.equal(s.delivery, 'complete', JSON.stringify(s.traces));

    const traces = s.traces as Array<{ stage: string; hostInvoked: boolean; anchors: unknown[] }>;
    assert.deepEqual(
      traces.map((t) => t.stage),
      ['INTAKE', 'PLANNING', 'CONTRACTING', 'BUILDING', 'REVIEW'],
    );
    // 主理人只在 REVIEW 被唤醒
    assert.deepEqual(
      traces.filter((t) => t.hostInvoked).map((t) => t.stage),
      ['REVIEW'],
    );

    const ledger = s.ledger as { precision: number; falsePositives: number };
    assert.equal(ledger.precision, 1);
    assert.equal(ledger.falsePositives, 0);

    const anchors = s.anchors as Array<{ anchorId: string; verdict: string }>;
    assert.ok(anchors.length >= 8, `应有多个锚点结论，实际 ${anchors.length}`);

    // 工件元信息必须被补全（标题、hash），否则界面上会是空标题
    const arts = s.artifacts as Array<{ id: string; kind: string; title: string }>;
    assert.ok(arts.length > 0);
    assert.ok(
      arts.some((a) => a.title && a.title.length > 0),
      `工件标题不应为空：${JSON.stringify(arts.slice(0, 3))}`,
    );

    const lastGate = s.lastGate as { blocked: boolean; nextAction: { kind: string } };
    assert.equal(lastGate.blocked, false);
    assert.equal(lastGate.nextAction.kind, 'ADVANCE');
  });
});

test('服务端：幻觉场景 —— A 层硬失败时不唤醒主理人，工单归因到后端', async () => {
  await withServer(async (forge, base) => {
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'hallucination', fresh: true });
    await forge.manager.wait();

    const s = (await getJson(`${base}/api/state`)).body as Record<string, unknown>;

    const workOrders = s.workOrders as Array<{ to: string; acceptance: string[] }>;
    const backend = workOrders.filter((w) => w.to === 'backend');
    assert.ok(backend.length > 0, '应生成派给后端的工单');
    assert.ok(
      backend.some((w) => w.acceptance.some((a) => a.includes('A2 锚点'))),
      `工单验收条件应指向 A2 锚点：${JSON.stringify(backend.map((b) => b.acceptance))}`,
    );

    // 主理人提出了那条谎话，并被机械裁判判为误报
    const objections = s.objections as Array<{ id: string; claim: string }>;
    assert.equal(objections.length, 1);
    assert.ok(objections[0].claim.includes('编译失败'));

    const arbs = s.arbitrations as Array<{ verdict: string; rule: string; reason: string }>;
    assert.equal(arbs[0].verdict, 'REFUTED');
    assert.equal(arbs[0].rule, 'R-contradicts-anchor', '应当是被「A4 已 PASS」证伪，而不是 falsifier 未能复现');

    const ledger = s.ledger as { precision: number; falsePositives: number };
    assert.equal(ledger.falsePositives, 1);
    assert.equal(ledger.precision, 0, '一次误报、零次真报 → precision 0%');

    // 修复后仍然完整交付
    assert.equal(s.delivery, 'complete');
  });
});

test('服务端：死锁场景 —— 和稀泥决议被拒 → 带债通过，且 TECH_DEBT.md 可读', async () => {
  await withServer(async (forge, base) => {
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'deadlock', fresh: true });
    await forge.manager.wait();

    const s = (await getJson(`${base}/api/state`)).body as Record<string, unknown>;
    assert.equal(s.delivery, 'with-debt', JSON.stringify(s.traces));

    const rts = s.roundtables as Array<{ trigger: string; resolution: { actions?: unknown[] } | null }>;
    assert.ok(rts.length > 0, '应召集过圆桌');
    assert.equal(rts[0].trigger, 'T2', '无法归因 → T2');
    assert.ok(rts[0].resolution, '应产出候选决议');
    assert.equal((rts[0].resolution!.actions ?? []).length, 0, '和稀泥决议：没有行动项');

    const debts = s.debts as Array<{ debtId: string; requirementIds: string[] }>;
    assert.ok(debts.length > 0);
    assert.ok(debts[0].requirementIds.length > 0, '受影响需求必须被标定');

    const td = await getJson(`${base}/api/tech-debt`);
    assert.equal(td.status, 200);
    const text = td.body.text as string;
    assert.ok(text.includes('未偿技术债'));
    assert.ok(text.includes('不是「已通过」'), '债务文件必须明确否认真实性');
    assert.ok(text.includes('O-9'), '必须记录未解决的异议编号');
  });
});

test('服务端：交叉质询场景 —— 机械事实必须一路投影到前端（不能只留在工件里）', async () => {
  await withServer(async (forge, base) => {
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'cross-exam', fresh: true });
    await forge.manager.wait();

    const s = (await getJson(`${base}/api/state`)).body as Record<string, unknown>;
    // 真人可用 + 决议无效 → 升级真人，run 停在争议阶段。
    // 注意 status 是 'finished'（本次 run 到此为止），「等真人裁决」这件事由 delivery 表达 ——
    // 前端的「待真人裁决」标签就读 delivery，不要误以为 status 会停在 paused。
    assert.equal(s.delivery, 'awaiting-human', JSON.stringify(s.traces));
    assert.equal(s.status, 'finished');
    assert.equal(s.finalStage, 'REVIEW', '必须停在争议阶段，而不是带着矛盾结论往下走');

    const rts = s.roundtables as Array<{
      trigger: string;
      resolutionValid?: boolean;
      invalidReason?: string;
      falsifiersRun?: number;
      facts?: Array<{ role: string; implicates: string; outcome: string; command: string }>;
    }>;
    assert.equal(rts.length, 1, '应召集过一次圆桌');
    assert.equal(rts[0].trigger, 'T2');

    // 关键：当场执行的 falsifier 结果必须出现在状态里。
    // 否则前端只能看到一场措辞漂亮的辩论，看不到「这场会到底被机械裁决了什么」。
    assert.equal(rts[0].falsifiersRun, 1, '应执行过 1 次 falsifier');
    const facts = rts[0].facts ?? [];
    assert.equal(facts.length, 1, JSON.stringify(facts));
    assert.equal(facts[0].outcome, 'sustained');
    assert.equal(facts[0].role, 'backend');
    assert.equal(facts[0].implicates, 'test', '反驳针对 test');
    assert.ok(facts[0].command.includes('tests/tasks.test.ts'), '必须保留实际执行的命令，可复核');

    // 决议与机械证据矛盾 → 判无效，且必须说明理由
    assert.equal(rts[0].resolutionValid, false);
    assert.ok(rts[0].invalidReason?.includes('机械证据'), rts[0].invalidReason);

    const escalations = s.escalations as Array<{ bundleId: string }>;
    assert.ok(escalations.length > 0, '无效决议必须升级真人');
  });
});

test('服务端：真人建议书 —— 写入决策日志并出现在状态里；非法输入被拒', async () => {
  await withServer(async (forge, base) => {
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'clean', fresh: true });
    await forge.manager.wait();

    const ok = await postJson(`${base}/api/directive`, {
      kind: 'constraint',
      text: '不得引入 lodash',
      constraints: ['不得引入 lodash'],
    });
    assert.equal(ok.status, 201);
    assert.equal(typeof ok.body.id, 'string');

    const s = (await getJson(`${base}/api/state`)).body as Record<string, unknown>;
    const directives = s.directives as Array<{ kind: string; text: string }>;
    assert.equal(directives.length, 1);
    assert.equal(directives[0].kind, 'constraint');

    const bad = await postJson(`${base}/api/directive`, { kind: 'nonsense', text: 'x' });
    assert.equal(bad.status, 400);
    assert.ok(String(bad.body.error).includes('kind'));

    const empty = await postJson(`${base}/api/directive`, { kind: 'resume', text: '   ' });
    assert.equal(empty.status, 400);
    assert.ok(String(empty.body.error).includes('不能为空'));
  });
});

test('服务端：let-it-pass 必须被接受（界面一直把它列为可用动作）', async () => {
  // 这是一个**用户能直接撞上**的 bug 的回归测试：
  // 介入面板上写着「可用动作：resume · override · let-it-pass」，
  // 而 DIRECTIVE_KINDS 与服务端的合法值校验都没有它 —— 提交必然 400。
  // 界面推荐了一个 API 会拒绝的动作。
  await withServer(async (forge, base) => {
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'clean', fresh: true });
    await forge.manager.wait();

    const ok = await postJson(`${base}/api/directive`, {
      kind: 'let-it-pass',
      text: '我知道还有问题，先往下走，记成债',
    });
    assert.equal(ok.status, 201, `let-it-pass 必须被接受，实际：${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.kind, 'let-it-pass');
    // 必须带上机械裁决说明（人要知道它意味着什么）
    assert.ok(ok.body.advisory, '必须回一条裁决说明，而不是干巴巴的「已收到」');
  });
});

test('服务端：建议书的裁决说明来自真实状态，而不是一句写死的话', async () => {
  // 「人可以定目标，不能定事实」这条原则必须一路走到 HTTP 响应里 ——
  // 否则人在界面上做完操作只会看到一句「已写入决策日志」，以为决定生效了。
  //
  // 这里只验**管道 + 状态感知**：消息里必须出现真实的阶段名（证明它读了 lastGate），
  // 而各档 outcome 的完整规则由 `adjudicateDirective` 的纯函数测试穷举覆盖。
  //
  // （尝试过在 HTTP 层直接造出「有确定性失败 + 阻断」的终局状态，
  //   但 demo 场景跑完时最后一个 Gate 已经不再有硬失败了 —— 前提不成立，
  //   所以那部分验证放在 e2e 测试里，那里能精确控制工件与脚本。）
  await withServer(async (forge, base) => {
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'hallucination', fresh: true });
    await forge.manager.wait();

    const res = await postJson(`${base}/api/directive`, { kind: 'override', text: '我批准这个项目通过' });
    assert.equal(res.status, 201);
    const adv = res.body.advisory as { outcome: string; message: string } | undefined;
    assert.ok(adv, '必须回一条裁决说明，而不是干巴巴的「已收到」');
    assert.match(adv.message, /阶段 [A-Z]+/, `消息必须基于真实的阶段状态，实际：${adv.message}`);
    assert.ok(
      ['applied', 'no-effect', 'cannot-override-facts'].includes(adv.outcome),
      `outcome 必须是三档之一，实际：${adv.outcome}`,
    );

    // 决策日志里也要留下这条裁决（事后可复查「当时系统是怎么答复人的」）
    const s = (await getJson(`${base}/api/state`)).body as Record<string, unknown>;
    const directives = s.directives as Array<{ kind: string; advisory?: { outcome: string } }>;
    const mine = directives.find((d) => d.kind === 'override');
    assert.ok(mine?.advisory, '状态投影里必须带上裁决说明');
  });
});

test('服务端：并发保护 —— 已有 run 在跑时拒绝新的启动', async () => {
  await withServer(async (forge, base) => {
    const first = await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'clean', fresh: true });
    assert.equal(first.status, 202);

    const second = await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'clean', fresh: true });
    assert.equal(second.status, 409, '不得让两个 run 同时写同一个工件库');
    assert.ok(String(second.body.error).includes('正在执行'));

    await forge.manager.wait();
  });
});

test('服务端：/api/state 与 SSE 首帧的载荷字段必须完全一致', async () => {
  // 这是回归测试。早先版本两处各写一份载荷，SSE 那份漏了 `scenarios`，
  // 结果是「刷新正常、重连白屏」—— 前端 state.scenarios.map() 在收到首帧后抛错。
  // 类型检查抓不到它，因为 FullState 把 scenarios 声明成了必填（类型在说谎）。
  // 唯一可靠的防线是**真的去比对两个出口**。
  await withServer(async (_forge, base) => {
    const rest = (await getJson(`${base}/api/state`)).body;

    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    ctrl.abort();
    const sse = JSON.parse(buf.split('data: ')[1].split('\n')[0]) as Record<string, unknown>;

    const rk = Object.keys(rest).sort();
    const sk = Object.keys(sse).sort();
    assert.deepEqual(sk, rk, `SSE 首帧与 /api/state 的字段集必须一致`);
    assert.ok(Array.isArray(sse.scenarios), 'scenarios 必须存在（前端 Header 直接用它渲染下拉框）');
    assert.ok(Array.isArray(rest.artifacts) && Array.isArray(sse.artifacts));
  });
});

test('服务端：未知接口返回 404 JSON，而不是 HTML 或崩溃', async () => {
  await withServer(async (_forge, base) => {
    const r = await getJson(`${base}/api/nope`);
    assert.equal(r.status, 404);
    assert.ok(String(r.body.error).includes('未知接口'));
  });
});

test('服务端：demo 模式的工件详情可读，且内容确实是 mock 产出的', async () => {
  await withServer(async (forge, base) => {
    await postJson(`${base}/api/run`, { mode: 'demo', scenario: 'clean', fresh: true });
    await forge.manager.wait();

    const s = (await getJson(`${base}/api/state`)).body as Record<string, unknown>;
    const contracts = (s.artifacts as Array<{ id: string; kind: string }>).filter((a) => a.kind === 'Contract');
    assert.equal(contracts.length, 1);

    const detail = await getJson(`${base}/api/artifacts/${contracts[0].id}`);
    assert.equal(detail.status, 200);
    const content = detail.body.content as { frozenHash?: string; openapi?: unknown };
    assert.ok(content.openapi, '契约工件应含 openapi');

    // 冻结后由程序生成的共享类型必须真实存在于磁盘
    const ws = (s.runtime as { workspace: string }).workspace;
    const gen = await readFile(join(ws, 'shared/contract/types.ts'), 'utf8');
    assert.ok(gen.includes('export interface Task'));
    assert.ok(gen.includes('请勿手工编辑'));
  });
});
