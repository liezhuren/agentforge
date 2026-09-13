/**
 * AgentForge 端到端演示（P1 完整闭环 + P5 圆桌交叉质询）。
 *
 * 四个场景，全部离线、零成本、可复现：
 *   A. 干净项目       → 一次通过到 DELIVERED
 *   B. 幻觉 + 说谎    → 机械归因派工单；主理人的假话被锚点证伪
 *   C. 甩锅 + 和稀泥  → T2 圆桌；决议被机械校验拒绝；真人不可用 → 带债通过
 *   D. 交叉质询       → 第 2 轮的反驳**当场执行**；与机械事实矛盾的决议被拒 → 升级真人
 *
 * 运行：node packages/orchestrator/src/cli-e2e.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DecisionLog, silentLogger, readTextOrNull, type ProjectProfile } from '../../core/src/index.ts';
import { MockProvider } from '../../llm/src/index.ts';
import { createRoleRunners } from '../../roles/src/index.ts';
import { SemanticVerifier } from '../../roles/src/verify.ts';
import { Orchestrator, type RunSummary } from './orchestrator.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DEMO_ROOT = join(ROOT, 'workspace', 'demo-e2e');

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
  console.log(`\n${C.bold}${C.blue}${'═'.repeat(74)}${C.reset}`);
  console.log(`${C.bold}${C.blue}  ${title}${C.reset}`);
  console.log(`${C.bold}${C.blue}${'═'.repeat(74)}${C.reset}`);
}
function sub(t: string): void {
  console.log(`\n${C.bold}${C.cyan}── ${t}${C.reset}`);
}

// ════════════════════════════════════════════════════════════════

const API_OK = [
  "import { padLeft } from 'leftpad-real';",
  "import type { Task } from '../../shared/contract/types';",
  '',
  'const store: Task[] = [];',
  '',
  'export function listTasks(): Task[] {',
  '  return store;',
  '}',
  '',
  'export function createTask(title: string): Task {',
  '  const t: Task = { id: padLeft(String(store.length + 1), 4), title };',
  '  store.push(t);',
  '  return t;',
  '}',
  '',
  "export const ROUTES = ['/api/tasks'];",
  '',
].join('\n');

const API_HALLUCINATED = API_OK.replace(
  "import { padLeft } from 'leftpad-real';",
  "import { padLeft, padRigth } from 'leftpad-real';",
).replace('padLeft(String(store.length + 1), 4)', 'padRigth(String(store.length + 1), 4)');

const WEB_OK = [
  "import type { Task } from '../../shared/contract/types';",
  '',
  'export async function loadTasks(): Promise<Task[]> {',
  "  const res = await fetch('/api/tasks');",
  '  return res.json();',
  '}',
  '',
].join('\n');

/**
 * 一条**真的有鉴别力**的可执行反驳（场景 D）：
 * 检查测试文件是否 import 了被测模块。
 *
 * 刻意不用 `node -e "process.exit(1)"` 那种「保证失败」的命令 ——
 * 它同样能跑出 sustained，但那是同义反复，什么都没检验。
 * 这条命令在反面情形下会给 0：占位测试 → 1（反驳成立），
 * 真的 import 了被测模块的测试 → 0（反驳被证伪）。
 *
 * 也不用「测试文件里有没有 R-001 字样」来判定 —— 占位测试的注释里
 * 恰好写着 R-001，那种检查会被注释骗过去（A7 锚点踩过同一个坑）。
 */
const HOLLOW_TEST_FALSIFIER =
  "node -e \"const fs=require('fs');const t=fs.readFileSync('tests/tasks.test.ts','utf8');" +
  "process.exit(/import[^;]*api\\/routes/.test(t)?0:1)\"";

async function scaffold(root: string): Promise<ProjectProfile> {
  const w = async (rel: string, content: string) => {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  };
  await w('package.json', JSON.stringify({ name: 'demo-e2e', version: '1.0.0', dependencies: { 'leftpad-real': '^1.0.0' } }, null, 2));
  await w('node_modules/leftpad-real/package.json', JSON.stringify({ name: 'leftpad-real', version: '1.0.0', types: 'index.d.ts', main: 'index.js' }, null, 2));
  await w('node_modules/leftpad-real/index.d.ts', 'export declare function padLeft(s: string, n: number): string;\n');

  return {
    name: 'demo-e2e',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: { cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
    test: { cmd: process.execPath, args: ['-e', "console.log('# pass 4\\n# fail 0')"] },
    run: null,
    knownPackages: ['lodash', 'express'],
    dependencyAllowlist: null,
  };
}

function baseScript(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'produce:Requirement': {
      requirements: [
        { id: 'R-001', text: '用户可以创建任务', acceptance: ['POST /api/tasks 返回 201'], priority: 'must', status: 'open', origin: 'user' },
        { id: 'R-002', text: '用户可以列出全部任务', acceptance: ['GET /api/tasks 返回 200'], priority: 'must', status: 'open', origin: 'user' },
      ],
    },
    'produce:PRD': {
      title: '任务看板 PRD',
      summary: '提供任务的创建与查询能力，覆盖两条 must 级需求。',
      requirementIds: ['R-001', 'R-002'],
      milestones: [{ name: 'M1', deliverables: ['REST API', '前端数据层'] }],
      nonGoals: ['不做多租户'],
    },
    'produce:TaskGraph': {
      tasks: [
        { id: 'T-01', title: '实现任务 REST API', owner: 'backend', scope: 'api', dependsOn: [], requirementIds: ['R-001', 'R-002'], deliverable: 'CodeModule', acceptance: ['A4 锚点 PASS', 'A7 锚点 PASS'] },
        { id: 'T-02', title: '实现前端数据层', owner: 'frontend', scope: 'web', dependsOn: [], requirementIds: ['R-001', 'R-002'], deliverable: 'CodeModule', acceptance: ['A4 锚点 PASS'] },
      ],
    },
    'produce:Contract': {
      version: 1,
      openapi: { openapi: '3.1.0', paths: { '/api/tasks': {} } },
      jsonSchemas: { Task: { type: 'object', required: ['id', 'title'], properties: { id: { type: 'string' }, title: { type: 'string' } } } },
      generatedTypesPath: 'shared/contract/types.ts',
      changeRequests: [],
    },
    'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_OK }] },
    'produce:CodeModule:web': { files: [{ path: 'src/web/client.ts', content: WEB_OK }] },
    'produce:TestSuite': {
      framework: 'node:test',
      files: [{ path: 'tests/tasks.test.ts', content: "import { test } from 'node:test';\ntest('t', () => {});\n" }],
      covers: ['R-001', 'R-002'],
    },
    'produce:AnchoredReview': { stage: 'REVIEW', objections: [], noObjection: true },
    'verify:requirements': {
      requirementVerdicts: [
        { requirementId: 'R-001', verdict: 'met', rationale: 'createTask 已实现', evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 10, endLine: 14, expect: 'createTask' }] },
        { requirementId: 'R-002', verdict: 'met', rationale: 'listTasks 已实现', evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8, expect: 'listTasks' }] },
      ],
    },
    ...over,
  };
}

async function runScenario(name: string, script: Record<string, unknown>, humanAvailable = false): Promise<RunSummary> {
  const root = join(DEMO_ROOT, name);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const profile = await scaffold(root);
  const provider = new MockProvider({ script });
  const orch = new Orchestrator({
    projectRoot: root,
    profile,
    userBrief: '做一个任务看板：能创建任务，也能列出全部任务。',
    runners: createRoleRunners(provider),
    verifier: new SemanticVerifier({ provider, logger: silentLogger('v') }),
    provider,
    offline: true,
    humanAvailable,
    log: new DecisionLog(root),
    logger: silentLogger('run'),
  });
  return orch.run();
}

// ════════════════════════════════════════════════════════════════

function printTrace(s: RunSummary): void {
  sub('阶段轨迹');
  for (const t of s.traces) {
    const host = t.hostInvoked ? `${C.magenta}[唤醒主理人]${C.reset}` : `${C.dim}[未唤醒主理人]${C.reset}`;
    console.log(`  ${C.bold}${t.stage.padEnd(12)}${C.reset} ${t.finalAction.padEnd(24)} ${host}`);
    if (t.blockedReasons.length > 0) {
      console.log(`      ${C.dim}阻断：${t.blockedReasons.join(', ')}${C.reset}`);
    }
  }
}

function printWorkOrders(s: RunSummary): void {
  if (s.workOrders.length === 0) return;
  sub(`派工单（${s.workOrders.length} 张，机械归因生成，无需 LLM 参与归因）`);
  for (const o of s.workOrders) {
    const kind = o.reason.kind === 'anchor-fail' ? `${C.red}锚点失败${C.reset}` : o.reason.kind === 'valid-objection' ? `${C.yellow}有效异议${C.reset}` : `${C.cyan}圆桌行动项${C.reset}`;
    console.log(`  ${C.bold}${o.id}${C.reset} → ${C.bold}${o.to}${C.reset} (${kind}) 目标 ${JSON.stringify(o.target)}`);
    for (const a of o.acceptance) console.log(`      ${C.dim}验收：${a}${C.reset}`);
  }
}

function printLedger(s: RunSummary): void {
  sub('主理人问责账本');
  const l = s.ledger;
  const bar = (p: number) => {
    const f = Math.round(p * 20);
    const color = p >= 0.7 ? C.green : p >= 0.4 ? C.yellow : C.red;
    return `${color}${'█'.repeat(f)}${'░'.repeat(20 - f)}${C.reset} ${(p * 100).toFixed(0)}%`;
  };
  console.log(`  precision        ${bar(l.precision)}`);
  console.log(`  有效异议 ${C.green}${l.truePositives}${C.reset}   误报 ${C.magenta}${l.falsePositives}${C.reset}   不可证伪 ${C.yellow}${l.unfalsifiable}${C.reset}`);
  console.log(`  累计阻断尝试 ${l.globalBlockAttempts}   观察期 ${l.probation ? `${C.red}是${C.reset}` : `${C.green}否${C.reset}`}`);
}

/**
 * 打印圆桌**当场执行**出来的机械事实。
 *
 * 这些信息值得单独打印：它是圆桌里唯一不是「说法」的东西 ——
 * 一条命令 + 一个真实退出码。没有它，一场圆桌在输出里只剩辩论文字。
 */
function printRoundtableFacts(workspace: string): void {
  const dir = join(workspace, 'artifacts', 'RoundtableMinute');
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return;

  sub('圆桌纪要（含当场执行的 falsifier 结果）');
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
      content: {
        trigger: string;
        statements: Array<{
          role: string;
          round: number;
          claim: string;
          discarded?: string;
          againstRole?: string;
          falsifierOutcome?: { command: string; exitCode: number; outcome: string };
        }>;
        facts?: Array<{ role: string; implicates: string; outcome: string; command: string; exitCode: number }>;
        resolution: { attribution?: string; decision?: string } | null;
        escalation?: string;
        invalidReason?: string;
      };
    };
    const c = doc.content;
    console.log(`  ${C.bold}${c.trigger}${C.reset} ${C.dim}（${c.statements.filter((s) => !s.discarded).length}/${c.statements.length} 条发言有效）${C.reset}`);

    for (const s of c.statements) {
      const exec = s.falsifierOutcome;
      if (!exec) continue;
      const color = exec.outcome === 'sustained' ? C.green : exec.outcome === 'refuted' ? C.red : C.yellow;
      console.log(`  ${C.bold}第 ${s.round} 轮 · ${s.role}${C.reset} → 质询 ${s.againstRole ?? '?'}`);
      console.log(`      ${C.dim}命令：${exec.command}${C.reset}`);
      console.log(`      退出码 ${C.bold}${exec.exitCode}${C.reset} → ${color}${exec.outcome}${C.reset}`);
    }

    for (const fact of c.facts ?? []) {
      const color = fact.outcome === 'sustained' ? C.green : C.red;
      console.log(
        `      ${color}机械事实（${fact.outcome}）${C.reset}：${fact.role} → 指向 ${C.bold}${fact.implicates}${C.reset}`,
      );
    }

    if (c.resolution) {
      console.log(`  ${C.dim}决议归因：${c.resolution.attribution} — ${c.resolution.decision}${C.reset}`);
    }
    if (c.escalation === 'HUMAN') {
      console.log(`  ${C.red}决议被判无效 → 升级真人${C.reset}`);
      if (c.invalidReason) console.log(`      ${C.dim}${c.invalidReason}${C.reset}`);
    }
  }
}

function printOutcome(s: RunSummary): void {
  const label =
    s.delivery === 'complete'
      ? `${C.green}完整交付${C.reset}`
      : s.delivery === 'with-debt'
        ? `${C.yellow}带债交付（问题被记录，未被掩盖）${C.reset}`
        : s.delivery === 'held'
          ? `${C.cyan}已被人类暂停${C.reset}`
          : `${C.yellow}等待真人裁决${C.reset}`;
  console.log(`\n  ${C.bold}结果：${C.reset}${label}  ${C.dim}最终阶段 ${s.finalStage}，共 ${s.totalCycles} 次 Gate${C.reset}`);
  if (s.debtIds.length > 0) {
    console.log(`  ${C.dim}技术债 ${s.debtIds.length} 条，受影响需求 ${s.techDebtRequirements.join(', ') || '无'}${C.reset}`);
  }
}

// ════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`${C.bold}AgentForge · 端到端闭环演示${C.reset}`);
  console.log(`${C.dim}全部离线运行：MockProvider 精确注入幻觉，验证确定性编排内核${C.reset}`);

  // ── 场景 A ──────────────────────────────────────────────────
  h('场景 A · 干净项目：应当一次通过');
  const a = await runScenario('A-clean', baseScript());
  printTrace(a);
  printLedger(a);
  printOutcome(a);
  console.log(`  ${C.dim}契约生成的共享类型文件：${a.delivery === 'complete' ? '已写出' : '未写出'}（A7 锚点会检查它真实存在）${C.reset}`);

  // ── 场景 B ──────────────────────────────────────────────────
  h('场景 B · 幻觉 + 主理人说谎');
  console.log(`${C.dim}注入：后端导入了 leftpad-real 中并不存在的符号 padRigth（幻觉 API）`);
  console.log(`主理人：谎称「编译失败」并附一个必然非零退出的假 falsifier${C.reset}`);

  let reviewCalls = 0;
  const b = await runScenario('B-hallucination', baseScript({
    'produce:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_HALLUCINATED }] },
    'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_OK }] },
    'produce:AnchoredReview': () => {
      reviewCalls++;
      if (reviewCalls > 1) return { stage: 'REVIEW', objections: [], noObjection: true };
      return {
        stage: 'REVIEW',
        noObjection: false,
        objections: [
          {
            id: 'O-1',
            stage: 'REVIEW',
            author: 'host',
            targetRole: 'backend',
            severity: 'blocker',
            claim: '后端代码编译失败，类型检查无法通过，任何下游工作都不该继续',
            evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 10 }],
            // 必然非零退出 —— 执行层本会被骗过
            falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
            claimHash: 'c1c1c1c1c1c1c1c1',
            evidenceHash: 'e1e1e1e1e1e1e1e1',
            createdAt: new Date().toISOString(),
          },
        ],
      };
    },
  }));
  printTrace(b);
  printWorkOrders(b);
  printLedger(b);
  printOutcome(b);
  console.log(
    `\n  ${C.dim}关键点：A2 锚点抓出幻觉符号并**机械归因**给 backend（第 1 张工单）；\n` +
      `  主理人的假话虽然配了「必然非零退出」的假 falsifier，仍被「A4 已 PASS」这个事实证伪 ——\n` +
      `  它骗得过执行层，骗不过事实底座。${C.reset}`,
  );

  // ── 场景 C ──────────────────────────────────────────────────
  h('场景 C · 主理人甩锅 + 圆桌和稀泥 + 真人不可用');
  console.log(`${C.dim}主理人给出无法归因的异议 → T2 圆桌；圆桌产出无行动项的决议 → 机械校验拒绝；`);
  console.log(`真人不可用 → 第 3 层逃生：带债通过${C.reset}`);

  const c = await runScenario(
    'C-deadlock',
    baseScript({
      'produce:AnchoredReview': {
        stage: 'REVIEW',
        noObjection: false,
        objections: [
          {
            id: 'O-9',
            stage: 'REVIEW',
            author: 'host',
            targetRole: 'UNRESOLVED',
            severity: 'blocker',
            claim: '整体架构不合理，前后端职责边界不清，建议推倒重来',
            evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 4 }],
            falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
            claimHash: 'c9c9c9c9c9c9c9c9',
            evidenceHash: 'e9e9e9e9e9e9e9e9',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      'roundtable:pm': { claim: '需求没有歧义，边界在契约里已写明', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }] },
      'roundtable:frontend': { claim: '前端只通过契约类型交互', evidence: [{ kind: 'file', path: 'src/web/client.ts', startLine: 1, endLine: 2 }] },
      'roundtable:backend': { claim: '后端严格按契约实现端点', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8 }] },
      'roundtable:test': { claim: '测试覆盖两条 must 需求', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }] },
      // 和稀泥：没有行动项
      'roundtable:resolution': { attribution: 'SHARED', decision: '综合考虑各方意见，大家都有道理，后续加强沟通', actions: [] },
      // 主理人反复提同一异议 → 触发复读/额度耗尽路径
      'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_OK }] },
    }),
    false,
  );
  printTrace(c);
  printLedger(c);
  printOutcome(c);

  const debt = await readTextOrNull(join(DEMO_ROOT, 'C-deadlock', 'TECH_DEBT.md'));
  if (debt) {
    sub('TECH_DEBT.md（只展示前 18 行）');
    for (const line of debt.split('\n').slice(0, 18)) console.log(`  ${C.dim}${line}${C.reset}`);
  }

  // ── 场景 D ──────────────────────────────────────────────────
  h('场景 D · 交叉质询：反驳当场执行，决议被机械证据否决');
  console.log(`${C.dim}第 2 轮的交叉质询不是「再吵一轮」，而是用**可执行的反驳**终结争议：`);
  console.log(`backend 对 test 提出一个真的会失败的反驳，机械主持当场运行它。${C.reset}`);

  const d = await runScenario(
    'D-cross-exam',
    baseScript({
      'produce:AnchoredReview': {
        stage: 'REVIEW',
        noObjection: false,
        // 与场景 C 相同：无法归因 → T2 圆桌（与会者全员到场）
        objections: [
          {
            id: 'O-9',
            stage: 'REVIEW',
            author: 'host',
            targetRole: 'UNRESOLVED',
            severity: 'blocker',
            claim: '整体架构不合理，前后端职责边界不清，建议推倒重来',
            evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 4 }],
            falsifier: { kind: 'executable', command: 'node -e "process.exit(1)"', expect: 'exit-nonzero' },
            claimHash: 'c9c9c9c9c9c9c9c9',
            evidenceHash: 'e9e9e9e9e9e9e9e9',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      'roundtable:pm': { claim: '需求没有歧义，边界在契约里已写明', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 1, endLine: 2 }] },
      'roundtable:frontend': { claim: '前端只通过契约类型交互', evidence: [{ kind: 'file', path: 'src/web/client.ts', startLine: 1, endLine: 2 }] },
      'roundtable:test': { claim: '测试覆盖两条 must 需求', evidence: [{ kind: 'file', path: 'tests/tasks.test.ts', startLine: 1, endLine: 2 }] },
      // 第 1 轮只陈述立场；第 2 轮携带一个**真的会失败**的可执行反驳。
      // 轮转配对下 backend 的质询对象是 test（有效发言顺序 pm→frontend→backend→test）。
      'roundtable:backend': (req: { messages: Array<{ role: string; content: string }> }) => {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        if (!user.includes('第 2 轮')) {
          return { claim: '后端严格按契约实现端点', evidence: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8 }] };
        }
        return {
          claim: '所谓「已被测试验证」是空的：测试从未 import 被测模块，它不可能覆盖任何需求',
          evidence: [{ kind: 'file', path: 'tests/tasks.test.ts', startLine: 1, endLine: 2 }],
          falsifier: { kind: 'executable', command: HOLLOW_TEST_FALSIFIER, expect: 'exit-nonzero' },
        };
      },
      // 决议习惯性地把责任推给 pm —— 与刚被执行的机械证据（指向 test）矛盾
      'roundtable:resolution': {
        attribution: 'pm',
        decision: '需求描述过于笼统，验收点不明确，导致测试无法落地，责任在需求侧',
        actions: [{ owner: 'pm', action: '重写 R-001 / R-002 的验收条件，给出可观测的判定点', acceptance: ['A7 锚点 PASS'] }],
      },
      'repair:CodeModule:api': { files: [{ path: 'src/api/routes.ts', content: API_OK }] },
    }),
    // 真人可用 → 决议无效时升级真人（第 2 层逃生），而不是带债通过
    true,
  );
  printTrace(d);
  printRoundtableFacts(join(DEMO_ROOT, 'D-cross-exam'));
  printOutcome(d);
  console.log(
    `\n  ${C.dim}关键点：反驳不是一个「说法」，而是一条被当场执行的命令 —— ` +
      `退出码 1 就是「反驳成立」的全部依据。\n` +
      `  随后产出的决议看起来合理（「需求写得不够清楚」是 LLM 最爱的归因），` +
      `但它与刚被执行的机械证据矛盾，\n  于是被判无效并升级真人。` +
      `LLM 圆桌最容易翻车的地方不是吵不起来，而是吵完之后无视证据地产出一份漂亮纪要。${C.reset}`,
  );

  h('演示结束');
  console.log(`  四个场景的工作区都保留在 ${C.bold}${DEMO_ROOT}${C.reset}：`);
  console.log(`  ${C.dim}工件在 artifacts/，锚点运行记录在 anchors/，决策日志在 decisions.jsonl${C.reset}`);
  console.log(`  ${C.dim}下一个阶段：用真实 LLM 重跑 P6 与真实多角色辩论，并据此标定经验参数（见 docs/06-roadmap.md）。${C.reset}\n`);
}

main().catch((err) => {
  console.error(`${C.red}演示失败：${(err as Error).message}${C.reset}`);
  console.error((err as Error).stack);
  process.exit(1);
});
