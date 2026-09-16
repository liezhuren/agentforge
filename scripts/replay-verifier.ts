/**
 * 隔离重放语义验证器：对**已有的工作区**只跑 `verify:requirements` 这一步。
 *
 * ## 为什么需要它（token 经济）
 *
 * 一整个 run 要 13–17 次 LLM 调用、约 28 万 tokens。而「改动是否让验证器从
 * uncertain 变成 met」这个问题**只涉及其中一次调用**。
 * 拿整个 run 去验证一个单点改动，等于用 28 万 tokens 回答一个 3 万 tokens 的问题。
 *
 * ## ⚠️ 单个样本不能作为 A/B 依据（实测得出的方法论）
 *
 * 本脚本最初是「跑一次看结果」。实测发现**同样的输入、连续两次调用会给出不同判定**
 * （llm-5：R-001 一次 not-met、一次 uncertain；R-007 一次没出现、一次 met）。
 * 验证器的 temperature 是 0.1，非零就不是确定性的。
 *
 * 所以现在的默认行为是**多次采样**，并报出分布。看单次结果下结论是自欺欺人 ——
 * 那正是这个项目一直在防的事（「可疑的结果先去查工具」）。
 *
 * 用法：
 *   node scripts/replay-verifier.ts <工作区> [--samples 3] [--out result.json]
 *
 * 每次调用都会打印真实 usage（promptTokens/completionTokens），
 * 好让「这次验证花了多少钱」是可核算的，而不是估的。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtifactStore, silentLogger } from '../packages/core/src/index.ts';
import { loadConfigFile, buildLlm } from '../packages/llm/src/index.ts';
import { SemanticVerifier } from '../packages/roles/src/verify.ts';

const argv = process.argv.slice(2);
const ws = argv.find((a) => !a.startsWith('--'));
const samples = Number(argv.includes('--samples') ? argv[argv.indexOf('--samples') + 1] : 3);
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;

if (!ws) {
  console.error('用法: node scripts/replay-verifier.ts <工作区> [--samples N] [--out 结果.json]');
  process.exit(1);
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}

const store = new ArtifactStore(ws);
await store.init();

const reqArt = store.head('Requirement');
if (!reqArt) {
  console.error('该工作区没有 Requirement 工件');
  process.exit(1);
}
const reqs = (reqArt.content as { requirements: Array<{ id: string; text: string }> }).requirements;
const userBrief = `（回放：原始诉求未落盘，以下为需求本身）\n${reqs.map((r) => `${r.id}: ${r.text}`).join('\n')}`;

console.log(`工作区: ${ws}`);
console.log(`需求: ${reqs.map((r) => r.id).join(', ')}`);

const seen = new Set<string>();
for (const kind of ['Requirement', 'PRD', 'TaskGraph', 'Contract', 'CodeModule', 'TestSuite', 'TestReport']) {
  const heads = store.heads(kind as never);
  if (heads.length > 0) seen.add(`${kind}×${heads.length}`);
}
console.log(`工作区里存在的工件: ${[...seen].join(', ')}`);

const config = await loadConfigFile(join(import.meta.dirname, '..', 'agentforge.config.json'));
const built = await buildLlm(config, {
  root: ws,
  runId: `replay-${Date.now()}`,
  record: false,
  // probe: true 用工作区里**上次运行留下的能力缓存**，命中就不发额外请求。
  // 不能写 probe: false —— provider 会假定端点支持严格模式，而 deepseek 的
  // response_format: json_schema 会直接 400（实测报错：This response_format type is unavailable now）。
  probe: true,
  onNotice: () => {},
});

const verifier = new SemanticVerifier({ provider: built.roleProviders.test, logger: silentLogger('replay') });

type Verdict = 'met' | 'not-met' | 'uncertain';
type Sample = {
  n: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  contextChars?: number;
  filesTruncated?: number;
  omitted?: string[];
  verdicts: Array<{ requirementId: string; verdict: Verdict; evidence: number }>;
  failed?: string;
};

const results: Sample[] = [];

for (let n = 1; n <= samples; n++) {
  console.log(`\n──── 样本 ${n}/${samples} ────`);
  const started = Date.now();
  let out;
  try {
    out = await verifier.verify({
      stage: 'REVIEW',
      store,
      profile: {
        name: 'replay',
        language: 'typescript',
        srcDir: 'src',
        tsconfigPath: 'tsconfig.json',
        typecheck: null,
        test: null,
        run: null,
        knownPackages: [],
        dependencyAllowlist: null,
      },
      workOrders: [],
      contractHash: store.frozenContractHash(),
      directives: [],
      userBrief,
    } as never);
  } catch (e) {
    console.log(`  调用失败: ${(e as Error).message}`);
    results.push({ n, latencyMs: Date.now() - started, verdicts: [], failed: (e as Error).message });
    continue;
  }

  const cs = out.contextStats;
  console.log(
    `  耗时 ${Date.now() - started}ms  prompt=${out.llm?.usage?.promptTokens ?? '?'} ` +
      `completion=${out.llm?.usage?.completionTokens ?? '?'}  上下文字符=${cs?.chars ?? '?'}` +
      `${cs && (cs.filesTruncated || cs.omitted.length) ? `  截断文件=${cs.filesTruncated} 省略=${cs.omitted.length}` : ''}`,
  );

  if (!out.proposals) {
    console.log(`  未产出提议: ${out.schemaError ?? '(未知)'}`);
    results.push({ n, latencyMs: Date.now() - started, verdicts: [], failed: out.schemaError });
    continue;
  }

  const vs = (out.proposals as {
    requirementVerdicts: Array<{ requirementId: string; verdict: Verdict; rationale: string; evidenceRefs: unknown[] }>;
  }).requirementVerdicts;

  results.push({
    n,
    latencyMs: Date.now() - started,
    ...(out.llm?.usage ? { promptTokens: out.llm.usage.promptTokens, completionTokens: out.llm.usage.completionTokens } : {}),
    ...(cs ? { contextChars: cs.chars, filesTruncated: cs.filesTruncated, omitted: cs.omitted } : {}),
    verdicts: vs.map((v) => ({ requirementId: v.requirementId, verdict: v.verdict, evidence: (v.evidenceRefs ?? []).length })),
  });

  for (const v of vs) {
    console.log(`  ${v.requirementId} → ${v.verdict}（证据 ${(v.evidenceRefs ?? []).length} 条）`);
  }
}

// ── 分布汇总（单样本不可信，所以看分布）──────────────────────
console.log('\n════════ 采样分布 ════════');
const tally: Record<Verdict, number> = { met: 0, 'not-met': 0, uncertain: 0 };
for (const r of results) for (const v of r.verdicts) tally[v.verdict]++;
const total = tally.met + tally['not-met'] + tally.uncertain;
console.log(`  判定合计 ${total} 条： met ${tally.met} ／ not-met ${tally['not-met']} ／ uncertain ${tally.uncertain}`);
if (total > 0) {
  console.log(`  uncertain 占比 ${Math.round((100 * tally.uncertain) / total)}%`);
}

// 逐条看稳定性：同一个需求在不同样本里是否给出相同判定
if (samples > 1) {
  const byReq = new Map<string, Verdict[]>();
  for (const r of results) for (const v of r.verdicts) {
    const arr = byReq.get(v.requirementId) ?? [];
    arr.push(v.verdict);
    byReq.set(v.requirementId, arr);
  }
  let unstable = 0;
  for (const [id, arr] of byReq) {
    const uniq = [...new Set(arr)];
    if (uniq.length > 1) {
      unstable++;
      console.log(`  ⚠ ${id} 不稳定：${arr.join(' / ')}`);
    }
  }
  console.log(`  稳定需求 ${byReq.size - unstable}/${byReq.size}`);
}

const totalPrompt = results.reduce((n, r) => n + (r.promptTokens ?? 0), 0);
const totalCompletion = results.reduce((n, r) => n + (r.completionTokens ?? 0), 0);
console.log(`\n本次总消耗：prompt ${totalPrompt} + completion ${totalCompletion} = ${totalPrompt + totalCompletion} tokens`);

if (outPath) {
  await writeFile(outPath, JSON.stringify({ workspace: ws, samples: results }, null, 2), 'utf8');
  console.log(`结果已写入 ${outPath}`);
}
