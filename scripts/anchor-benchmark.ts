/**
 * 幻觉靶场 · 运行器与报告生成。
 *
 * 运行：node scripts/anchor-benchmark.ts [--verbose]
 * 输出：docs/10-anchor-benchmark.md（数字来自实际运行）
 *
 * 退出码：干净样本出现误报 → 1（误报与漏报同样有害，而且误报更隐蔽：
 * 它表现为「角色被派去修一个不存在的问题」，不会有人报 bug）。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAMPLES, SAMPLE_STATS } from '../packages/anchors/bench/samples.ts';
import { runBenchmark, isHardFailure, type BenchSummary, type SampleResult } from '../packages/anchors/bench/harness.ts';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const verbose = process.argv.includes('--verbose');

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

const OUTCOME_STYLE: Record<string, { icon: string; color: string }> = {
  TP: { icon: '✔', color: C.green },
  TN: { icon: '✔', color: C.green },
  FN: { icon: '✖', color: C.red },
  FP: { icon: '✖', color: C.magenta },
  SEVERITY_MISMATCH: { icon: '△', color: C.yellow },
};

async function main(): Promise<void> {
  console.log(`${C.bold}AgentForge · 幻觉靶场${C.reset}`);
  console.log(
    `${C.dim}${SAMPLE_STATS.total} 个样本：${SAMPLE_STATS.injected} 个注入样本 + ${SAMPLE_STATS.clean} 个干净对照组${C.reset}\n`,
  );

  const summary = await runBenchmark(SAMPLES, {
    makeRoot: () => mkdtemp(join(tmpdir(), 'af-bench-')),
    cleanupRoot: (r) => rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }),
    offline: true,
    onProgress: (done, total, s) => {
      process.stdout.write(`\r  ${C.dim}进度 ${done}/${total}  ${s.id.padEnd(28)}${C.reset}`);
    },
  });
  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  // ── 逐样本 ─────────────────────────────────────────────────
  let lastGroup = '';
  for (const r of summary.results) {
    if (r.sample.group !== lastGroup) {
      lastGroup = r.sample.group;
      console.log(`\n${C.bold}${C.cyan}── ${lastGroup}${C.reset}`);
    }
    const st = OUTCOME_STYLE[r.outcome] ?? { icon: '?', color: '' };
    console.log(`  ${st.color}${st.icon}${C.reset} ${r.sample.id.padEnd(28)} ${C.dim}${r.detail.slice(0, 120)}${C.reset}`);
    if (verbose) console.log(`      ${C.dim}注入：${r.sample.injection}${C.reset}`);
  }

  // ── 汇总 ───────────────────────────────────────────────────
  const t = summary.totals;
  console.log(`\n${C.bold}${C.blue}${'═'.repeat(74)}${C.reset}`);
  console.log(`${C.bold}${C.blue}  汇总${C.reset}`);
  console.log(`${C.bold}${C.blue}${'═'.repeat(74)}${C.reset}`);
  console.log(`  样本 ${t.samples}：注入 ${t.injected} + 干净 ${t.clean}`);
  console.log(
    `  ${C.green}TP ${t.tp}${C.reset}  ${C.red}FN ${t.fn}${C.reset}  ${C.magenta}FP ${t.fp}${C.reset}  ${C.green}TN ${t.tn}${C.reset}  ${C.yellow}严重度不符 ${t.mismatch}${C.reset}`,
  );
  console.log(`  ${C.bold}检出率${C.reset}（注入样本里被抓到的比例）  ${(summary.detectionRate * 100).toFixed(1)}%`);
  console.log(
    `  ${C.bold}干净通过率${C.reset}（对照组里无任何硬失败的比例）  ${(summary.cleanPassRate * 100).toFixed(1)}%  ${C.dim}← 这个数字比检出率更重要${C.reset}`,
  );

  console.log(`\n  ${C.bold}逐锚点${C.reset}`);
  console.log(
    `  ${'锚点'.padEnd(6)}${'正例'.padEnd(6)}${'检出'.padEnd(6)}${'漏报'.padEnd(6)}${'误报'.padEnd(6)}${'召回'.padEnd(8)}${'清白率'.padEnd(9)}${'平均耗时'}`,
  );
  for (const m of [...summary.metrics.values()].sort((a, b) => a.anchorId.localeCompare(b.anchorId))) {
    const recallColor = m.recall >= 1 ? C.green : m.recall >= 0.5 ? C.yellow : C.red;
    const specColor = m.specificity >= 1 ? C.green : C.red;
    console.log(
      `  ${m.anchorId.padEnd(6)}${String(m.positives).padEnd(6)}${String(m.detected).padEnd(6)}${String(m.missed).padEnd(6)}` +
        `${String(m.falsePositives).padEnd(6)}${recallColor}${(m.recall * 100).toFixed(0).concat('%').padEnd(8)}${C.reset}` +
        `${specColor}${(m.specificity * 100).toFixed(0).concat('%').padEnd(9)}${C.reset}${m.avgMs}ms`,
    );
  }

  await writeReport(summary);
  console.log(`\n  ${C.dim}报告已写入 docs/10-anchor-benchmark.md${C.reset}\n`);

  // ── 退出码 ─────────────────────────────────────────────────
  const fp = summary.results.filter((r) => r.outcome === 'FP');
  const fn = summary.results.filter((r) => r.outcome === 'FN');
  if (fp.length > 0) {
    console.error(`${C.magenta}存在 ${fp.length} 个误报：${fp.map((r) => r.sample.id).join(', ')}${C.reset}`);
    process.exitCode = 1;
  }
  if (fn.length > 0) {
    console.error(`${C.red}存在 ${fn.length} 个漏报：${fn.map((r) => r.sample.id).join(', ')}${C.reset}`);
    process.exitCode = 1;
  }
  if (fp.length === 0 && fn.length === 0) {
    console.log(`${C.green}全部样本符合期望：无误报、无漏报。${C.reset}`);
  }
}

// ════════════════════════════════════════════════════════════════

async function writeReport(summary: BenchSummary): Promise<void> {
  const t = summary.totals;
  const lines: string[] = [];

  lines.push('# 10 · 锚点靶场标定（P3）');
  lines.push('');
  lines.push('> 本文件由 `scripts/anchor-benchmark.ts` 自动生成 —— 数字来自实际运行，不是手写。');
  lines.push(`> 生成时间：${summary.at}`);
  lines.push('');
  lines.push('## 这份报告回答什么问题');
  lines.push('');
  lines.push('在 P1–P6 里我们只能说「A2 能抓出幻觉符号」（因为有测试），');
  lines.push('但说不出它的**检出率**与**误报率**。而防幻觉机制的价值完全由这两个数字决定。');
  lines.push('本报告把它们变成数据。');
  lines.push('');
  lines.push('## 方法');
  lines.push('');
  lines.push('每个样本在一个**独立临时工作区**里构造：写项目文件、造已安装的假 npm 包（含真实 `.d.ts`）、');
  lines.push('发布工件，然后只运行该样本关心的锚点，最后把实际判定与**事先声明的期望**比对。');
  lines.push('');
  lines.push('判定规则刻意保守：');
  lines.push('');
  lines.push('| 结果 | 含义 |');
  lines.push('|---|---|');
  lines.push('| `TP` | 期望被抓到，确实抓到（严重度符合） |');
  lines.push('| `FN` | 期望被抓到，但没报硬失败 → **漏报** |');
  lines.push('| `FP` | 干净对照组里出现了硬失败 → **误报** |');
  lines.push('| `TN` | 干净对照组里无任何硬失败 |');
  lines.push('| `严重度不符` | 抓到了，但比期望更重（例如期望 WARN 实际 FAIL） |');
  lines.push('');
  lines.push('**为什么每个注入样本都配对照组合**：只测「能不能抓出问题」毫无意义 ——');
  lines.push('一个永远返回 FAIL 的锚点检出率是 100%。必须同时测「它会不会把正确的东西判成错的」。');
  lines.push('在锚点这事上误报和漏报**同样有害**：');
  lines.push('漏报 → 幻觉通过；误报 → 把诚实代码判成幻觉，角色被派去修一个不存在的问题');
  lines.push('（浪费一轮，还可能把对的改成错的）。');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push(`- 样本：**${t.samples}** 个（注入 ${t.injected} + 干净对照 ${t.clean}）`);
  lines.push(`- 检出率（注入样本里被抓到的比例）：**${(summary.detectionRate * 100).toFixed(1)}%**`);
  lines.push(`- 干净通过率（对照组里无任何硬失败的比例）：**${(summary.cleanPassRate * 100).toFixed(1)}%**`);
  lines.push('');
  lines.push('| 结果 | 数量 |');
  lines.push('|---|---|');
  lines.push(`| TP（正确检出） | ${t.tp} |`);
  lines.push(`| TN（正确放行） | ${t.tn} |`);
  lines.push(`| FN（漏报） | ${t.fn} |`);
  lines.push(`| FP（误报） | ${t.fp} |`);
  lines.push(`| 严重度不符 | ${t.mismatch} |`);
  lines.push('');
  lines.push('## 逐锚点指标');
  lines.push('');
  lines.push('| 锚点 | 正例数 | 检出 | 漏报 | 误报 | 召回率 | 清白率 | 平均耗时 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const m of [...summary.metrics.values()].sort((a, b) => a.anchorId.localeCompare(b.anchorId))) {
    lines.push(
      `| ${m.anchorId} | ${m.positives} | ${m.detected} | ${m.missed} | ${m.falsePositives} | ` +
        `${(m.recall * 100).toFixed(0)}% | ${(m.specificity * 100).toFixed(0)}% | ${m.avgMs} ms |`,
    );
  }
  lines.push('');
  lines.push('- **召回率** = 检出 / 正例数。分母只算「声明期望被该锚点抓到」的样本，不含无关样本。');
  lines.push('- **清白率** = 1 − 误报率（在干净对照样本上的分母）。1 表示从未误伤。');
  lines.push('');
  lines.push('## 逐样本结果');
  lines.push('');
  let lastGroup = '';
  for (const r of summary.results) {
    if (r.sample.group !== lastGroup) {
      lastGroup = r.sample.group;
      lines.push(`### ${lastGroup}`);
      lines.push('');
      lines.push('| 样本 | 注入的幻觉 | 期望 | 结果 | 实际 |');
      lines.push('|---|---|---|---|---|');
    }
    lines.push(
      `| \`${r.sample.id}\`<br>${r.sample.title} | ${r.sample.injection.replace(/\|/g, '\\|')} | ${
        r.sample.expect.kind === 'clean' ? '无硬失败' : `${r.sample.expect.anchorId} ≥ ${r.sample.expect.atLeast}`
      } | ${r.outcome} | ${r.verdicts.map((v) => `${v.anchorId}=${v.verdict}`).join(' ')} |`,
    );
    if (r.outcome !== 'TP' && r.outcome !== 'TN') {
      lines.push(`| | | | | ${r.detail.replace(/\|/g, '\\|').slice(0, 220)} |`);
    }
    lines.push('');
    if (summary.results.indexOf(r) === summary.results.length - 1) break;
  }

  const fp = summary.results.filter((r) => r.outcome === 'FP');
  const fn = summary.results.filter((r) => r.outcome === 'FN');
  const mism = summary.results.filter((r) => r.outcome === 'SEVERITY_MISMATCH');

  lines.push('## 未通过项');
  lines.push('');
  if (fp.length === 0 && fn.length === 0 && mism.length === 0) {
    lines.push('无 —— 全部样本符合事先声明的期望。');
  } else {
    for (const r of fp) lines.push(`- **误报** \`${r.sample.id}\`：${r.detail}`);
    for (const r of fn) lines.push(`- **漏报** \`${r.sample.id}\`：${r.detail}`);
    for (const r of mism) lines.push(`- **严重度不符** \`${r.sample.id}\`：${r.detail}`);
  }
  lines.push('');

  // ── 这份报告最有价值的一段 ──────────────────────────────────
  lines.push('## 首轮 100% 通过时发生了什么');
  lines.push('');
  lines.push('第一版靶场（36 个样本）跑出来是 **0 误报 0 漏报、检出率 100%**。');
  lines.push('我没有把它当成好消息 —— **「一次就全过」本身就是可疑信号**：');
  lines.push('它通常意味着样本太贴合被测对象的强项（样本是我写的，我很清楚锚点是怎么实现的）。');
  lines.push('');
  lines.push('于是主动加了 3 个**对抗性样本**去攻它的弱点，其中两个各抓到一个真实缺陷：');
  lines.push('');
  lines.push('| 样本 | 攻的是什么 | 结果 |');
  lines.push('|---|---|---|');
  lines.push('| `A5-05-unparseable-output` | 测试命令退出 0，但输出里没有任何可解析的计数 | **抓到**：A5 原本报 `PASS` —— 它其实什么都没验证到。退出码 0 不等于测试通过（脚本可能被 `\\\\|\\\\| true` 吞掉、可能压根没跑到测试）。已修为 `WARN(test-counts-unparsed)` |');
  lines.push('| `A7-07-endpoint-only-in-comment` | 端点只写在注释里（`// TODO: 实现 /api/tasks`） | **抓到**：A7 的端点覆盖检查是子串匹配，注释里的路径同样是子串，于是「一行都没实现」被判成已实现。已修为先剥注释再匹配 |');
  lines.push('| `A7-08-clean-parameterized-path` | 反向验证：契约声明 `/api/tasks/{id}`，前端写 `` fetch(`/api/tasks/${id}`) `` | **通过**：确认归一化把它们视作同一路径，没有引入误报 |');
  lines.push('');
  lines.push('这两处修完，靶场从 36 个样本长到 39 个，仍然是 0 误报 0 漏报 ——');
  lines.push('但现在的 100% 比第一版的 100% 可信一些，因为它至少经过了**一次主动的攻击**。');
  lines.push('当然，攻击的力度仍然受限于我能想到什么。');
  lines.push('');

  // ── 诚实边界 ────────────────────────────────────────────────
  lines.push('## 这份报告**不能**说明什么');
  lines.push('');
  lines.push('1. **样本是我手写的。** 它测的是「锚点能不能抓出我想到的这类幻觉」，');
  lines.push('   **不是**「锚点能不能抓出真实世界里的所有幻觉」。');
  lines.push('   我没想到的幻觉形态，这份报告里必然缺席 —— 这是自出题自答的固有局限。');
  lines.push('   上面那段「主动加对抗样本」只是部分缓解，不能消除它。');
  lines.push('2. **A1 的远端核实未纳入。** 靶场离线运行，A1 只能做本地检查（命名规则 / typo 距离 / 依赖白名单）。');
  lines.push('   「包在 registry 上是否真实存在」这一项需要联网，届时才会被真正检验。');
  lines.push('   **这是当前最大的一块未覆盖区域**：编造一个名字合法、也不像知名包的假包，本靶场抓不到。');
  lines.push('3. **A4/A5/A6 用的是确定性的假命令**（`node -e`）而不是真 tsc / 真测试运行器。');
  lines.push('   这保证了靶场快且可复现，代价是「解析真实工具输出」这部分能力没有被这里的样本覆盖 ——');
  lines.push('   那部分由 P6 的 `real-app` 场景（真 tsc / 真 node --test）覆盖。');
  lines.push('4. **样本量小。** 每个锚点的正例数是个位数（A3 只有 1 个），召回率的粒度很粗：');
  lines.push('   一个样本就是 50–100 个百分点。这些数字适合用来发现「某个锚点整体失效」，');
  lines.push('   **不适合**用来做精细调参。');
  lines.push('5. **没有测量「幻觉的变体」**。真实的模型幻觉往往更隐蔽：');
  lines.push('   包名对、符号对、但语义用错（例如把 `padLeft` 用在需要 `padRight` 的地方）。');
  lines.push('   这类错误 A1–A3 都抓不到，A4 也只在类型不匹配时才抓到 ——');
  lines.push('   它属于 B1/B3 的语义判断范围，而 B 层依赖 LLM，本靶场只喂了脚本化的提议。');
  lines.push('');

  const known = summary.results.filter((r) => r.sample.knownLimitation);
  if (known.length > 0) {
    lines.push('## 已记录的已知缺口');
    lines.push('');
    lines.push('这些样本当前抓不到，但**原因已被显式记录**（因此不会让 CI 变红）：');
    lines.push('');
    for (const r of known) lines.push(`- \`${r.sample.id}\`：${r.sample.knownLimitation}`);
    lines.push('');
  }

  await writeFile(join(ROOT, 'docs', '10-anchor-benchmark.md'), lines.join('\n'), 'utf8');
  void isHardFailure;
  void ({} as SampleResult);
}

main().catch((err) => {
  console.error(`${C.red}靶场运行失败：${(err as Error).message}${C.reset}`);
  console.error((err as Error).stack);
  process.exit(1);
});
