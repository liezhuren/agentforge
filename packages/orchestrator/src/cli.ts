/**
 * AgentForge 垂直切片演示（P1）。
 *
 * 用一个「被模型写坏了的项目」现场演示三层机制：
 *   1. A 层锚点如何抓出 5 类幻觉，并给出**机械归因**
 *   2. 机械裁判如何把主理人的异议裁成 VALID / UNFALSIFIABLE / REFUTED 三档
 *   3. 问责账本如何让「滥报」比「真报」更贵，并保证项目不会停死
 *
 * 运行：node packages/orchestrator/src/cli.ts
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ArtifactStore,
  DecisionLog,
  DEFAULT_HOST_POLICY,
  EventBus,
  claimHashOf,
  evidenceHashOf,
  type EvidenceRef,
  type Objection,
  type ProjectProfile,
  type StageId,
} from '../../core/src/index.ts';
import { ALL_ANCHORS, createAnchorContext, runAnchors, attributionOf } from '../../anchors/src/index.ts';
import { HostLedger } from './ledger.ts';
import { MechanicalJudge } from './judge.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DEMO_DIR = join(ROOT, 'workspace', 'demo');

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
};

function h(title: string): void {
  console.log(`\n${C.bold}${C.blue}${'═'.repeat(72)}${C.reset}`);
  console.log(`${C.bold}${C.blue}  ${title}${C.reset}`);
  console.log(`${C.bold}${C.blue}${'═'.repeat(72)}${C.reset}`);
}

function sub(title: string): void {
  console.log(`\n${C.bold}${C.cyan}── ${title}${C.reset}`);
}

const VERDICT_STYLE: Record<string, string> = {
  PASS: C.green,
  FAIL: C.red,
  WARN: C.yellow,
  SKIPPED: C.dim,
  STALE: C.magenta,
  INVALID_EVIDENCE: C.magenta,
};

function colored(v: string): string {
  return `${VERDICT_STYLE[v] ?? ''}${v}${C.reset}`;
}

// ════════════════════════════════════════════════════════════════
// 1. 构造一个「被模型写坏了的项目」
// ════════════════════════════════════════════════════════════════

async function write(rel: string, content: string): Promise<void> {
  const abs = join(DEMO_DIR, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function buildDemoProject(): Promise<void> {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(DEMO_DIR, { recursive: true });

  // 幻觉 1：非法包名（模型编造的包）
  // 幻觉 2：typo-squatting（loadsh vs lodash）
  await write(
    'package.json',
    JSON.stringify(
      {
        name: 'demo-shop',
        version: '1.0.0',
        dependencies: { 'leftpad-real': '^1.0.0', 'Task-Queue': '^2.0.0', loadsh: '^4.17.21' },
      },
      null,
      2,
    ),
  );

  // 真实存在的包与真实导出的符号
  await write(
    'node_modules/leftpad-real/package.json',
    JSON.stringify({ name: 'leftpad-real', version: '1.0.0', types: 'index.d.ts', main: 'index.js' }, null, 2),
  );
  await write(
    'node_modules/leftpad-real/index.d.ts',
    ['export declare function padLeft(s: string, n: number): string;', 'export declare function padRight(s: string, n: number): string;', ''].join('\n'),
  );

  // 幻觉 3：真实包 + 不存在的符号（padRigth）
  // 幻觉 4：编造的模块路径（./task-repository.ts）
  // 幻觉 5：手写契约模型而不引用生成的类型（契约漂移）
  await write(
    'src/api/routes.ts',
    [
      "import { padLeft, padRigth } from 'leftpad-real';",
      "import { TaskRepository } from './task-repository.ts';",
      '',
      'interface Task { id: string; title: string }',
      '',
      "export function listTasks(): Task[] {",
      "  return new TaskRepository().all().map((t) => ({ id: padLeft(t.id, 6), title: padRigth(t.title, 20) }));",
      '}',
      "export const ROUTES = ['/api/tasks'];",
      '',
    ].join('\n'),
  );

  await write(
    'src/web/api.ts',
    [
      'interface Task { id: string; title: string }',
      '',
      "export async function loadTasks(): Promise<Task[]> {",
      "  const res = await fetch('/api/tasks');",
      "  const legacy = await fetch('/api/legacy/tasks');",
      '  return res.json();',
      '',
    ].join('\n'),
  );

  await write(
    'shared/contract/types.ts',
    ['export interface Task { id: string; title: string }', ''].join('\n'),
  );

  await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
}

// ════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`${C.bold}AgentForge · 垂直切片演示${C.reset}`);
  console.log(`${C.dim}演示目标：幻觉拦截 → 机械裁判 → 问责账本，三层机制在真实文件系统上工作${C.reset}`);

  await buildDemoProject();
  console.log(`\n${C.dim}已构造演示项目：${DEMO_DIR}${C.reset}`);

  const store = new ArtifactStore(DEMO_DIR);
  await store.init();
  const bus = new EventBus();
  const log = new DecisionLog(DEMO_DIR);
  await log.init();

  bus.on((e) => {
    if (e.t === 'anchor.ran') {
      console.log(`  ${C.dim}· 事件 anchor.ran → ${e.result.anchorId} ${e.result.verdict}${C.reset}`);
    }
  });

  const profile: ProjectProfile = {
    name: 'demo-shop',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    // 用 node 造出确定性的类型检查结果：A4 PASS，才能演示「主理人说谎被锚点证伪」
    typecheck: { cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
    test: { cmd: process.execPath, args: ['-e', "console.log('# pass 4\\n# fail 0')"] },
    run: null,
    knownPackages: ['lodash', 'express', 'react', 'zod'],
    dependencyAllowlist: null,
  };

  // 工件：契约（已冻结）+ 前后端代码
  await store.put({
    kind: 'Contract',
    producer: 'pm',
    freeze: true,
    content: {
      version: 1,
      openapi: { openapi: '3.1.0', paths: { '/api/tasks': {} } },
      jsonSchemas: { Task: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
      generatedTypesPath: 'shared/contract/types.ts',
      changeRequests: [],
    },
  });
  await store.put({
    kind: 'CodeModule',
    producer: 'backend',
    scope: 'api',
    content: { files: [{ path: 'src/api/routes.ts', content: await readDemo('src/api/routes.ts') }] },
  });
  await store.put({
    kind: 'CodeModule',
    producer: 'frontend',
    scope: 'web',
    content: { files: [{ path: 'src/web/api.ts', content: await readDemo('src/web/api.ts') }] },
  });

  await log.append('run.started', { project: profile.name, offline: true });

  // ══════════════════════════════════════════════════════════════
  h('第 1 步 · 多层锚点：A 层事实锚（零 LLM）');

  const ctx = createAnchorContext({
    projectRoot: DEMO_DIR,
    store,
    profile,
    offline: true,
    runPrefix: 'demo',
  });
  const anchors = await runAnchors(ctx, ALL_ANCHORS);

  for (const r of anchors) {
    const icon = r.verdict === 'PASS' ? '✔' : r.verdict === 'SKIPPED' ? '○' : r.verdict === 'WARN' ? '△' : '✖';
    const a = ALL_ANCHORS.find((x) => x.id === r.anchorId)!;
    console.log(
      `  ${icon} [${r.anchorId}] ${a.title.padEnd(12)} ${colored(r.verdict.padEnd(16))} ${C.dim}${r.method}${C.reset}`,
    );
    for (const f of r.findings) {
      const role = f.targetRole ? `${C.bold}[归因:${f.targetRole}]${C.reset}` : '';
      const sev = f.severity === 'fail' ? `${C.red}fail${C.reset}` : `${C.yellow}warn${C.reset}`;
      console.log(`      ${sev} ${role} ${f.message}`);
    }
  }

  sub('机械归因汇总（可直接据此派工单，无需 LLM 参与）');
  const attr = attributionOf(anchors.filter((r) => r.anchorId.startsWith('A')));
  for (const [role, n] of Object.entries(attr)) {
    console.log(`  ${C.bold}${role}${C.reset}: ${n} 个硬问题`);
  }
  await log.append('anchor.result', { results: anchors.map((r) => ({ id: r.anchorId, verdict: r.verdict, findings: r.findings.length })) });

  // ══════════════════════════════════════════════════════════════
  h('第 2 步 · 主理人提异议（含 1 条真话、1 条假话、1 条不可证伪、1 条甩锅）');

  const stage: StageId = 'REVIEW';
  const ledger = new HostLedger(DEFAULT_HOST_POLICY, stage);
  const judge = new MechanicalJudge({ anchorContext: ctx, ledger });

  const ev = (path: string, startLine: number, endLine: number): EvidenceRef => ({
    kind: 'file',
    path,
    startLine,
    endLine,
  });

  const objections: Objection[] = [
    mkObj('O-1', {
      kind: '真实问题',
      targetRole: 'frontend',
      severity: 'blocker',
      claim: '前端调用了契约中未声明的端点 /api/legacy/tasks，属于契约漂移，必须修复',
      evidence: [ev('src/web/api.ts', 1, 7)],
      falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    }),
    mkObj('O-2', {
      kind: '假话（与已通过的 A4 矛盾）',
      targetRole: 'backend',
      severity: 'blocker',
      claim: '后端代码编译失败，类型检查无法通过，任何下游工作都不该继续',
      evidence: [ev('src/api/routes.ts', 1, 9)],
      // 一个「必然非零退出」的假 falsifier，试图骗过执行层
      falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    }),
    mkObj('O-3', {
      kind: '不可证伪（证据指向不存在的文件）',
      targetRole: 'backend',
      severity: 'blocker',
      claim: '后端在 src/api/hidden-service.ts 里隐藏了未授权的外部调用，必须打回',
      evidence: [ev('src/api/hidden-service.ts', 1, 3)],
      falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    }),
    mkObj('O-4', {
      kind: '甩锅（无法归因）',
      targetRole: 'UNRESOLVED',
      severity: 'blocker',
      claim: '整体架构不合理，前后端职责边界不清，建议推倒重来',
      evidence: [ev('src/api/routes.ts', 1, 3)],
      falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
    }),
  ];

  for (const o of objections) {
    console.log(`\n  ${C.bold}${o.id}${C.reset} ${C.dim}(${(o as Objection & { _label?: string })._label})${C.reset}`);
    console.log(`    归因: ${o.targetRole} · 严重度: ${o.severity}`);
    console.log(`    ${C.dim}主张:${C.reset} ${o.claim}`);
    console.log(`    ${C.dim}证据:${C.reset} ${o.evidence.length} 条 · ${C.dim}falsifier:${C.reset} ${o.falsifier.kind}`);
  }

  // ══════════════════════════════════════════════════════════════
  h('第 3 步 · 机械裁判裁决（本文件不含任何 LLM 调用）');

  const aAnchors = anchors.filter((r) => r.anchorId.startsWith('A'));
  const summary = await judge.arbitrateAll(objections, aAnchors);

  for (const arb of summary.results) {
    const o = objections.find((x) => x.id === arb.objectionId)!;
    const style =
      arb.verdict === 'VALID' ? C.red : arb.verdict === 'REFUTED' ? C.magenta : C.yellow;
    console.log(`\n  ${C.bold}${arb.objectionId}${C.reset} ${style}${C.bold}${arb.verdict}${C.reset} ${C.dim}(${arb.rule})${C.reset}`);
    console.log(`    ${arb.reason}`);
    if (arb.falsifierRun) {
      console.log(
        `    ${C.dim}falsifier 执行: exit=${arb.falsifierRun.exitCode} 期望!=0 → matched=${arb.falsifierRun.matched}${C.reset}`,
      );
    }
    if (arb.requiresHuman) console.log(`    ${C.yellow}→ 已转入待裁决收件箱，等待真人回答${C.reset}`);
    if (arb.verdict === 'REFUTED' && o.claim.includes('编译失败')) {
      console.log(`    ${C.dim}注意：这条异议附加了「必然非零退出」的假 falsifier，执行层本会被骗过；${C.reset}`);
      console.log(`    ${C.dim}      是「A4 已 PASS」这个事实把它证伪了 —— 主理人自己也在锚点约束之下。${C.reset}`);
    }
  }

  await log.append('objection.arbitrated', { summary: summary.results.map((r) => ({ id: r.objectionId, verdict: r.verdict, rule: r.rule })) });

  // ══════════════════════════════════════════════════════════════
  h('第 4 步 · 问责账本：让「滥报」比「真报」更贵');

  const snap = ledger.snapshot();
  console.log(`  ${C.bold}主理人评分${C.reset}`);
  console.log(`    precision        ${precisionBar(snap.precision)} ${(snap.precision * 100).toFixed(0)}%`);
  console.log(`    有效异议 (tp)     ${C.green}${snap.truePositives}${C.reset}`);
  console.log(`    误报     (fp)     ${C.magenta}${snap.falsePositives}${C.reset}   ${C.dim}← 每条扣 2 额度，真报只扣 1${C.reset}`);
  console.log(`    不可证伪          ${C.yellow}${snap.unfalsifiable}${C.reset}   ${C.dim}← 不合格但不说谎，不扣额度${C.reset}`);
  console.log(`    剩余额度          ${snap.quota}`);
  console.log(`    阻断尝试          ${snap.blockAttempts} / ${DEFAULT_HOST_POLICY.stageBlockLimit}`);
  console.log(`    观察期            ${snap.probation ? `${C.red}是${C.reset}` : `${C.green}否${C.reset}`}`);
  console.log(`    阻断权            ${snap.stageBlockingRevoked ? `${C.red}已终止 (R3)${C.reset}` : `${C.green}可用${C.reset}`}`);

  const gate = ledger.canBlock();
  if (!gate.allowed) {
    console.log(`\n  ${C.yellow}当前阻断权状态：${C.reset}${gate.reason}`);
  }

  sub('推进保证：主理人无法让项目停死');
  console.log(`  第 1 层  阻断尝试达 ${DEFAULT_HOST_POLICY.stageBlockLimit} 次 → 强制圆桌，本阶段阻断权终止  ${summary.conveneRoundtable ? `${C.green}[本次已触发]${C.reset}` : `${C.dim}[未触发]${C.reset}`}`);
  console.log(`  第 2 层  圆桌 2 轮无决议 → 升级真人裁决（建议书 override / resume 可强制推进）`);
  console.log(`  第 3 层  真人不可用 → 带债通过：写入 TECH_DEBT.md，受影响需求标记 ACCEPTED_WITH_DEBT，项目继续`);

  // ══════════════════════════════════════════════════════════════
  h('第 5 步 · 决策日志：append-only 哈希链（历史不可改写）');

  const verify = await log.verify();
  console.log(`  记录条数    ${log.length}`);
  console.log(`  链完整性    ${verify.ok ? `${C.green}完整${C.reset}` : `${C.red}断裂于 #${(verify as { brokenAtSeq: number }).brokenAtSeq}${C.reset}`}`);
  console.log(`  日志文件    ${C.dim}${log.path}${C.reset}`);

  if (verify.ok) {
    // 现场篡改一条，证明哈希链确实能发现改写
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(log.path, 'utf8');
    await writeFile(log.path, raw.replace('"demo-shop"', '"tampered"'), 'utf8');
    const log2 = new DecisionLog(DEMO_DIR);
    await log2.init();
    const v2 = await log2.verify();
    console.log(
      `  篡改检测    ${v2.ok ? `${C.red}未能检测（有 bug）${C.reset}` : `${C.green}已检测到改写：seq ${(v2 as { brokenAtSeq: number }).brokenAtSeq} — ${(v2 as { reason: string }).reason}${C.reset}`}`,
    );
    await writeFile(log.path, raw, 'utf8');
  }

  // ══════════════════════════════════════════════════════════════
  h('第 6 步 · 工件锚点链：内容一变，绿灯立刻失效');

  const cm = store.head('CodeModule')!;
  const links = store.freshAnchorsOf(cm.id);
  console.log(`  工件 ${C.bold}${cm.id}${C.reset} 有效锚点结论 ${links.length} 条，全部绑定内容 hash ${C.dim}${cm.contentHash.slice(0, 12)}…${C.reset}`);

  const tampered = store.require(cm.id);
  tampered.contentHash = 'deadbeef'.repeat(8);
  const staled = await store.refreshStaleness();
  console.log(`  模拟有人偷改代码后仍复用旧绿灯 → ${C.magenta}${staled}${C.reset} 条锚点结论被标记 STALE`);
  console.log(`  剩余有效结论 ${store.freshAnchorsOf(cm.id).length} 条 ${C.dim}（STALE 不再算作有效，必须重跑锚点）${C.reset}`);

  h('演示结束');
  console.log(`  工作区保留在 ${C.bold}${DEMO_DIR}${C.reset}，可自行查看工件、锚点记录与决策日志。`);
  console.log(`  ${C.dim}下一步（P1 剩余）：Gate 门禁 + 阶段状态机 + 圆桌会议 + 五角色 mock 闭环。${C.reset}\n`);
}

function precisionBar(p: number): string {
  const width = 24;
  const filled = Math.round(p * width);
  const color = p >= 0.7 ? C.green : p >= 0.4 ? C.yellow : C.red;
  return `${color}${'█'.repeat(filled)}${'░'.repeat(width - filled)}${C.reset}`;
}

async function readDemo(rel: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(DEMO_DIR, rel), 'utf8');
}

type ObjSpec = {
  kind: string;
  targetRole: Objection['targetRole'];
  severity: Objection['severity'];
  claim: string;
  evidence: EvidenceRef[];
  falsifier: Objection['falsifier'];
};

function mkObj(id: string, spec: ObjSpec): Objection {
  return {
    id,
    stage: 'REVIEW',
    author: 'host',
    targetRole: spec.targetRole,
    severity: spec.severity,
    claim: spec.claim,
    evidence: spec.evidence,
    falsifier: spec.falsifier,
    claimHash: claimHashOf(spec.claim),
    evidenceHash: evidenceHashOf(spec.evidence),
    createdAt: new Date().toISOString(),
    ...({ _label: spec.kind } as Record<string, unknown>),
  } as Objection;
}

main().catch((err) => {
  console.error(`\n${C.red}演示失败：${(err as Error).message}${C.reset}`);
  console.error((err as Error).stack);
  process.exit(1);
});
