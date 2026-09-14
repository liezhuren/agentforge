/**
 * 隔离重放语义验证器：对**已有的工作区**只跑 `verify:requirements` 这一步。
 *
 * ## 为什么需要它（token 经济）
 *
 * 一整个 run 要 13–17 次 LLM 调用、约 28 万 tokens。而「改动是否让验证器从
 * uncertain 变成 met」这个问题**只涉及其中一次调用**。
 * 拿整个 run 去验证一个单点改动，等于用 28 万 tokens 回答一个 3 万 tokens 的问题。
 *
 * 这个脚本复用已落盘的工件与代码，只发那一次请求。
 *
 * 用法：
 *   $env:DEEPSEEK_API_KEY="..."; node scripts/replay-verifier.ts <工作区>
 */
import { join } from 'node:path';

import { ArtifactStore, silentLogger } from '../packages/core/src/index.ts';
import { MockProvider, loadConfigFile, buildLlm } from '../packages/llm/src/index.ts';
import { SemanticVerifier } from '../packages/roles/src/verify.ts';

const ws = process.argv[2];
if (!ws) {
  console.error('用法: node scripts/replay-verifier.ts <工作区>');
  process.exit(1);
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}

const store = new ArtifactStore(ws);
await store.init();

// 从工件里还原需求与「用户诉求」的大意（诉求不在工件里，用需求文本近似）
const reqArt = store.head('Requirement');
if (!reqArt) {
  console.error('该工作区没有 Requirement 工件');
  process.exit(1);
}
const reqs = (reqArt.content as { requirements: Array<{ id: string; text: string }> }).requirements;
const userBrief = `（回放：原始诉求未落盘，以下为需求本身）\n${reqs.map((r) => `${r.id}: ${r.text}`).join('\n')}`;

console.log(`工作区: ${ws}`);
console.log(`需求: ${reqs.map((r) => r.id).join(', ')}`);

// 让当前读权限矩阵决定「验证器能看到什么」——这正是被验证的变量
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
  // probe: true 用的是 `<工作区>/.agentforge/capabilities.json` 里**上次运行留下的缓存**，
  // 缓存命中不会发起任何网络请求（所以这里不额外花钱）。
  //
  // 不能写 probe: false —— 那会让 provider 假定端点支持严格模式，
  // 而 deepseek 端点的 response_format: json_schema 会直接 400
  // （实测就是这个报错：This response_format type is unavailable now）。
  probe: true,
  onNotice: () => {},
});

const verifier = new SemanticVerifier({ provider: built.roleProviders.test, logger: silentLogger('replay') });

console.log('\n发起 1 次 verify:requirements 调用…');
const started = Date.now();
const out = await verifier.verify({
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

console.log(`耗时 ${Date.now() - started}ms`);
if (!out.proposals) {
  console.log('验证器未产出提议:', JSON.stringify(out).slice(0, 400));
  process.exit(1);
}

console.log('\n=== 本次判定（打印完整理由，不截断）===');
for (const v of (out.proposals as { requirementVerdicts: Array<{ requirementId: string; verdict: string; rationale: string; evidenceRefs: Array<{ path?: string }> }> }).requirementVerdicts) {
  console.log(`\n──────── ${v.requirementId} → ${v.verdict}  （证据 ${(v.evidenceRefs ?? []).length} 条）────────`);
  console.log(v.rationale);
  if (v.evidenceRefs?.length) {
    console.log('  证据引用: ' + v.evidenceRefs.map((e) => e.path ?? JSON.stringify(e)).join(', '));
  }
}
