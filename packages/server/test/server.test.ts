import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { silentLogger } from '../../core/src/index.ts';
import { createForgeServer, type ForgeServer } from '../src/index.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

async function withServer<T>(fn: (s: ForgeServer, base: string) => Promise<T>): Promise<T> {
  const wsRoot = await mkdtemp(join(tmpdir(), 'af-srv-ws-'));
  const forge = await createForgeServer({
    // 用独立的工作区根，避免测试写进仓库的 workspace/
    root: ROOT,
    workspaceRoot: wsRoot,
    logger: silentLogger('srv-test'),
    port: 0,
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

test('服务端：静态资源与 SPA 回退（前端构建产物）', async () => {
  await withServer(async (_forge, base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<div id="root">'), '应返回控制台 HTML');
    assert.ok(/assets\/index-.*\.js/.test(html), '应引用构建出的 JS');

    // 未命中的路径回退到 index.html（前端路由需要）
    const spa = await fetch(base + '/some/deep/route');
    assert.equal(spa.status, 200);
    assert.ok((await spa.text()).includes('<div id="root">'));

    // 目录穿越必须被挡住
    const evil = await fetch(base + '/../../package.json');
    const text = await evil.text();
    assert.ok(!text.includes('"name": "agentforge"'), '不得泄漏工作区外的文件');
  });
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
