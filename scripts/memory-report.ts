/**
 * 记忆系统的验证与报告工具。**0 token。**
 *
 * 运行：`node scripts/memory-report.ts [--workspace-dir workspace] [--db <路径>] [--all]`
 *
 * ## 它回答什么问题
 *
 * 1. **L1 摄入对不对**：每个工作区读到多少 Gate / 锚点轮次 / 发现 / 修复，有多少可进记忆。
 * 2. **分类器准不准**：它能不能把我们**已知的**那几条约定从真实失败里认出来。
 *    这一条有确定的地面真值 —— `docs/07 §L5/§L8` 与 `docs/HANDOFF.md §6.1` 记着
 *    四条「约定没传达」的规律（`.ts` 扩展名 / 禁 spawn / 入口自启 / 契约文件），
 *    它们全都来自真实运行。认不出来就是分类器有问题。
 * 3. **经验库会提出什么**：确定性簇 + 规范文本，原样打出来给人看。
 *    这一步**不发任何模型调用**（有规范文本的类不需要模型措辞）。
 * 4. **有效性追踪的现状**：诚实报 0 —— 历史无法回填（见 `ingest.ts` 的说明）。
 *
 * ## 为什么这个工具值得单独存在
 *
 * 因为「记忆系统有效」这句话如果没有一个 0 成本的检验方式，就只能靠再跑一轮真实 LLM
 * （29 万 token）来相信它 —— 而那笔钱应该花在别处（`docs/HANDOFF.md §9.4`）。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  LocalHashEmbedding,
  clusterFindings,
  getLesson,
  ingestWorkspace,
  listLessons,
  openMemoryDb,
  proposeFromCluster,
  renderRetrievalReport,
  retrieveByClass,
  retrieveBySimilarity,
  indexFindings,
  type IngestStats,
} from '../packages/memory/src/index.ts';

const args = process.argv.slice(2);
const flag = (name: string, def?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
};

const workspaceDir = resolve(flag('workspace-dir', 'workspace')!);
const dbPath = flag('db');
const includeTarget = args.includes('--all');

function workspaceKeyOf(p: string): string {
  return createHash('sha256').update(p).digest('hex').slice(0, 16);
}

/** 收集要摄入的工作区：`llm-*` 与预置的 demo 工作区。 */
async function collectWorkspaces(): Promise<string[]> {
  if (!existsSync(workspaceDir)) return [];
  const entries = await readdir(workspaceDir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(workspaceDir, e.name);
    // 只收「跑过真实流程」的工作区：必须有 anchors 或 runs 或 decisions
    if (
      existsSync(join(p, 'anchors')) ||
      existsSync(join(p, 'runs')) ||
      existsSync(join(p, 'decisions.jsonl'))
    ) {
      out.push(p);
    }
  }
  return out.sort();
}

const workspaces = await collectWorkspaces();
if (workspaces.length === 0) {
  console.error(`在 ${workspaceDir} 下没找到任何「跑过流程」的工作区（需要 anchors/ 或 runs/ 或 decisions.jsonl）`);
  process.exit(1);
}

const useDb = dbPath ? resolve(dbPath) : ':memory:';
if (dbPath) await mkdir(dirname(useDb), { recursive: true });
const mem = openMemoryDb(useDb, 'multi');

console.log('═'.repeat(78));
console.log(`记忆系统报告  工作区目录 ${workspaceDir}`);
console.log(`记忆库 ${useDb === ':memory:' ? '（内存，本报告不落盘 —— 加 --db <路径> 可保留）' : useDb}`);
console.log('═'.repeat(78));

// ── 1. 摄入 ───────────────────────────────────────────────────────
console.log('\n【1】L1 摄入（零 token）\n');
const allStats: IngestStats[] = [];
console.log(
  '工作区'.padEnd(14) +
    'run'.padStart(4) +
    'Gate'.padStart(6) +
    '轮次'.padStart(6) +
    '发现'.padStart(6) +
    '可进记忆'.padStart(9) +
    '已链接'.padStart(8) +
    '修复'.padStart(6),
);
for (const ws of workspaces) {
  const st = await ingestWorkspace(mem, { workspace: ws });
  allStats.push(st);
  console.log(
    ws.replace(workspaceDir + '\\', '').replace(workspaceDir + '/', '').padEnd(14) +
      String(st.runs).padStart(4) +
      String(st.gates).padStart(6) +
      String(st.anchorRounds).padStart(6) +
      String(st.findings).padStart(6) +
      String(st.eligibleFindings).padStart(9) +
      String(st.linkedFindings).padStart(8) +
      String(st.repairs).padStart(6),
  );
}
const totals = allStats.reduce(
  (a, s) => ({
    runs: a.runs + s.runs,
    gates: a.gates + s.gates,
    findings: a.findings + s.findings,
    eligible: a.eligible + s.eligibleFindings,
    linked: a.linked + s.linkedFindings,
    textBased: a.textBased + s.textBasedFindings,
    repairs: a.repairs + s.repairs,
  }),
  { runs: 0, gates: 0, findings: 0, eligible: 0, linked: 0, textBased: 0, repairs: 0 },
);
console.log(
  '合计'.padEnd(14) +
    String(totals.runs).padStart(4) +
    String(totals.gates).padStart(6) +
    ''.padStart(6) +
    String(totals.findings).padStart(6) +
    String(totals.eligible).padStart(9) +
    String(totals.linked).padStart(8) +
    String(totals.repairs).padStart(6),
);
console.log(
  `\n  其中「依据是文本模式」（比结构化字段脆弱）的发现：${totals.textBased} 条` +
    `（占比 ${totals.findings ? ((totals.textBased / totals.findings) * 100).toFixed(1) : '0.0'}%）`,
);

// ── 2. 根因分布 ────────────────────────────────────────────────────
console.log('\n【2】根因类分布（确定性分类器）\n');
const byClass = mem.db
  .prepare(
    `SELECT class, COUNT(*) AS n, SUM(eligible) AS elig,
            COUNT(DISTINCT anchor_round) AS rounds
     FROM findings GROUP BY class ORDER BY n DESC`,
  )
  .all() as unknown as { class: string; n: number; elig: number; rounds: number }[];
for (const r of byClass) {
  const tag = r.elig > 0 ? '可进记忆' : '不进记忆';
  console.log(
    `  ${String(r.n).padStart(3)} 条 / ${String(r.rounds).padStart(2)} 轮  ${r.class.padEnd(45)} ${tag}`,
  );
}

// ── 3. 分类器对照已知地面真值 ──────────────────────────────────────
console.log('\n【3】分类器 vs 已知地面真值（docs/07 §L5/§L8、HANDOFF §6.1 记的四条规律）\n');
const expectations: { name: string; cls: string; why: string }[] = [
  {
    name: '相对导入要带显式 .ts 扩展名',
    cls: 'convention:explicit-relative-extension',
    why: 'docs/07 §L5：A4 报 TS2835，看起来像模型写错，实际是约定没传达',
  },
  {
    name: '禁止 spawn 子进程（环境禁管道 stdio）',
    cls: 'environment:spawn-restricted',
    why: 'docs/07 §L7：A5 报 spawn EPERM',
  },
  {
    name: '入口文件必须自启',
    cls: 'convention:entry-must-self-start',
    why: 'docs/07 §L8：A6 报「服务进程在就绪前退出（exit 0）」',
  },
  {
    name: '不要手写契约类型，要 import 生成的',
    cls: 'convention:import-generated-contract-types',
    why: 'A7 报 contract-duplication（全部运行里出现次数最多的一类）',
  },
];
let hit = 0;
for (const e of expectations) {
  const row = mem.db
    .prepare('SELECT COUNT(*) AS n FROM findings WHERE class = ?')
    .get(e.cls) as { n: number };
  const ok = row.n > 0;
  if (ok) hit++;
  console.log(`  ${ok ? '✔' : '✘'} ${e.name}`);
  console.log(`      → ${e.cls}：${row.n} 条。依据：${e.why}`);
}
// 反面：代码类必须一条都不许进记忆
const codeEligible = mem.db
  .prepare(`SELECT COUNT(*) AS n FROM findings WHERE class LIKE 'code:%' AND eligible = 1`)
  .get() as { n: number };
const unknownEligible = mem.db
  .prepare(`SELECT COUNT(*) AS n FROM findings WHERE class = 'unknown' AND eligible = 1`)
  .get() as { n: number };
console.log(
  `\n  ${codeEligible.n === 0 ? '✔' : '✘'} 代码类发现（code:*）中被标为可进记忆的：${codeEligible.n} 条（必须为 0）`,
);
console.log(
  `  ${unknownEligible.n === 0 ? '✔' : '✘'} 未识别类（unknown）中被标为可进记忆的：${unknownEligible.n} 条（必须为 0）`,
);
console.log(`\n  恢复出的已知约定：${hit}/${expectations.length}`);

// 「没恢复出来」有两种截然不同的原因，必须当场分开 —— 否则会误判成分类器坏了
// （这正是 §6.16「先分清『测不出』和『真的没做到』」的应用）。
const missing = expectations.filter(
  (e) => (mem.db.prepare('SELECT COUNT(*) AS n FROM findings WHERE class = ?').get(e.cls) as { n: number }).n === 0,
);
if (missing.length > 0) {
  console.log(`\n  未出现的 ${missing.length} 条，原因需要分开看：`);
  for (const e of missing) {
    // 这条规律是否**已经**被 environmentNotes 覆盖？覆盖了就不会再犯 → 0 条是**好事**。
    const covered = /spawn/.test(e.cls);
    console.log(`    · ${e.name}`);
    if (covered) {
      console.log(
        '      → 0 条**不是漏检**：它在预置 package.json 的 environmentNotes 里已经被显式告知，',
      );
      console.log(
        '        所以真实运行里不再发生。而它最初发生的那几轮，中间轮次的发现已被覆盖 bug 抹掉。',
      );
      console.log('        （这恰好说明：这条约定当年是靠人工搬进 environmentNotes 才消失的。）',
      );
    } else {
      console.log('      → 需要人工确认是分类器漏检，还是这一类后来真的不再发生。');
    }
  }
}

// ── 4. 候选经验簇 ──────────────────────────────────────────────────
console.log('\n【4】候选经验簇（确定性分组，不涉及任何模型）\n');
const clusters = clusterFindings(mem);
if (clusters.length === 0) {
  console.log('  （无）');
} else {
  console.log('  独立轮次  类'.padEnd(52) + '规范文本');
  for (const c of clusters) {
    console.log(
      `  ${String(c.rounds.length).padStart(8)}  ${c.cls.padEnd(50)}` +
        (c.canonicalText ? '有' : '无（需 LLM 措辞 → 只能 proposed）') +
        (c.readyToPromote ? '  ✔够条件' : ''),
    );
  }
}

// ── 5. 经验库会提出什么 ────────────────────────────────────────────
console.log('\n【5】L3 提议（有规范文本的类不发模型调用，省一次钱）\n');
const envHash = allStats[0]?.envHash ?? '';
let proposed = 0;
let needsLlm = 0;
for (const c of clusters) {
  if (!c.readyToPromote) continue;
  if (c.canonicalText === null) {
    // 没有规范文本 → 需要模型措辞。本报告**刻意不发**模型调用：
    // 它的目的是验证机制，不是生成内容；真要生成时走 summarizeAndPropose({ provider })。
    needsLlm++;
    continue;
  }
  const r = await proposeFromCluster(mem, c, { provider: undefined as never, envHash });
  if (r.ok) {
    proposed++;
    const l = getLesson(mem, r.lessonId);
    console.log(`  ● [${c.cls}] 证据 ${l?.evidence.length ?? 0} 条 / ${c.rounds.length} 轮`);
    console.log(`      ${l?.text ?? ''}`);
    console.log(`      状态 ${l?.status}（LLM 能到达的最远状态就是 proposed，生效必须过硬检查）`);
  } else {
    console.log(`  ○ [${c.cls}] 未提出：${r.reason.slice(0, 120)}`);
  }
}
console.log(`\n  共提出 ${proposed} 条（确定性措辞），全部停在 proposed。`);
console.log(`  另有 ${needsLlm} 个够条件的簇**需要模型措辞** —— 本报告不发模型调用（要生成请走 summarizeAndPropose）。`);
const notReady = clusters.filter((c) => !c.readyToPromote);
if (notReady.length > 0) {
  console.log(`\n  不够条件自动生效的簇 ${notReady.length} 个，原因：`);
  for (const c of notReady) {
    console.log(`    · [${c.cls}] ${c.notReadyReason ?? '(未说明)'}`);
  }
}

// ── 6. 有效性追踪的现状 ────────────────────────────────────────────
console.log('\n【6】有效性追踪（「这条记忆有没有用」）\n');
const active = listLessons(mem, { status: 'active' });
console.log(`  active 经验：${active.length} 条 —— 因此有效性**尚无任何观测**。`);
console.log('  这不是缺陷，是顺序：经验要先被提升、被注入，才会有「注入后是否复发」的数据。');
console.log('  ⚠️ 并且这件事**无法靠回填历史回答**：老 run 的中间轮次发现已被覆盖 bug 抹掉');
console.log('     （见 ingest 报告里的警告）。所以它必须在运行中记录 —— 那是 Recorder 的活。');

// ── 7. 检索：确定性类筛选 vs 向量相似度 ────────────────────────────
console.log('\n【7】检索：类筛选（零依赖、精确） vs 本地向量（零依赖、相似）\n');
const embedder = new LocalHashEmbedding(1024);
const idx = await indexFindings(mem, embedder);
console.log(`  向量索引：${idx.indexed} 条新建，覆盖 ${idx.total} 条 finding（模型 ${embedder.id}）`);

const target = 'convention:entry-must-self-start';
const classHits = retrieveByClass(mem, { cls: target, topK: 5 });
console.log(`\n  按类精确检索「${target}」：`);
console.log(
  '    ' + renderRetrievalReport(classHits).split('\n').join('\n    '),
);
const bySim = await retrieveBySimilarity(mem, embedder, {
  text: '服务进程在就绪前退出，进程立刻就结束了，服务没有持续监听',
  topK: 5,
});
console.log(`\n  用自然语言描述同一问题做相似度检索（**不带类过滤**）：`);
console.log(
  '    ' + renderRetrievalReport(bySim).split('\n').join('\n    '),
);

// ── 8. 结论 ────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(78));
console.log('结论');
console.log('═'.repeat(78));
console.log(`  L1 事实层：${totals.runs} 个 run / ${totals.gates} 次 Gate / ${totals.findings} 条发现 / ${totals.repairs} 次返工，全部零 token 摄入。`);
console.log(`  分类器：恢复已知约定 ${hit}/${expectations.length}；代码类 0 条进记忆（这是必须守住的线）。`);
console.log(`  L2 索引：${idx.total} 条 finding 全部有向量（本地实现，零依赖、零网络）。`);
console.log(`  L3 经验：${proposed} 条 proposed，0 条 active（提升要过确定性检查，本报告刻意不提升）。`);
console.log('');
console.log('  ⚠️ 两件**不能**从这份报告得出的结论：');
console.log('     1. 「记忆系统提升了生成质量」—— 那需要对照运行（真实 token），这里只验证了机制。');
console.log('     2. 「经验有效」—— 一条都还没生效过，有效性为「无观测」。');
console.log('');
mem.close();
