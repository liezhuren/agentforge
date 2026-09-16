/**
 * 把语义验证器**实际收到的上下文**转储出来并统计 —— **不花一分 token**。
 *
 * ## 为什么需要它
 *
 * 「验证器收到的上下文」这一层以前是完全不可见的：它由 `verify()` 内部临时拼出来，
 * 发出去就没了。于是没人知道它到底看到了多少代码 —— 而正是这一层
 * **悄悄丢掉了 34% 的内容**（12 轮真实运行实测：57 个工件里 30 个被截断，
 * 上下文平均只显示了 66%，最差的两轮只有 44% / 48%）。
 *
 * 有了它就能做到「先量再改」：改动前后各跑一次，看内容完整率与体积变化，
 * 完全不用调模型。真正的 LLM 调用只留给最后一步 —— 确认判定是否变好。
 *
 * 用法：
 *   node scripts/dump-verifier-context.ts workspace/llm-5
 *   node scripts/dump-verifier-context.ts --all          # 12 轮全量对比
 *   node scripts/dump-verifier-context.ts workspace/llm-5 --write ctx.md
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtifactStore, silentLogger } from '../packages/core/src/index.ts';
import { buildVerifierContext, VERIFIER_CONTEXT_BUDGETS } from '../packages/roles/src/verify.ts';

/** 旧实现的规模：每个工件 `JSON.stringify(content, null, 2).slice(0, 8000)`。 */
function legacyShownChars(store: ArtifactStore): { shown: number; total: number; truncated: number } {
  const KINDS = [
    'Requirement',
    'PRD',
    'TaskGraph',
    'Contract',
    'CodeModule',
    'TestSuite',
    'TestReport',
    'Directive',
  ] as const;
  let shown = 0;
  let total = 0;
  let truncated = 0;
  for (const kind of KINDS) {
    for (const a of store.heads(kind)) {
      const len = JSON.stringify(a.content, null, 2).length;
      total += len;
      shown += Math.min(len, 8000);
      if (len > 8000) truncated++;
    }
  }
  return { shown, total, truncated };
}

async function inspect(ws: string, writeTo?: string) {
  const store = new ArtifactStore(ws);
  await store.init();
  const reqArt = store.head('Requirement');
  if (!reqArt) return null;

  const reqs = (reqArt.content as { requirements: Array<{ id: string; text: string }> }).requirements;
  const ctx = buildVerifierContext({
    stage: 'REVIEW',
    store,
    profile: {
      name: 'dump',
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
    userBrief: `（回放：原始诉求未落盘，以下为需求本身）\n${reqs.map((r) => `${r.id}: ${r.text}`).join('\n')}`,
  } as never);

  if (writeTo) {
    await writeFile(
      writeTo,
      ctx.messages.map((m) => `═══ ${m.role} ═══\n${m.content}`).join('\n\n'),
      'utf8',
    );
  }

  const legacy = legacyShownChars(store);
  return { ws, stats: ctx.stats, legacy, reqs: reqs.length, store };
}

const args = process.argv.slice(2);
const wantWrite = args.includes('--write') ? args[args.indexOf('--write') + 1] : undefined;
const targets = args.includes('--all')
  ? Array.from({ length: 12 }, (_, i) => `workspace/llm-${i + 1}`)
  : args.filter((a) => !a.startsWith('--') && a !== wantWrite);

if (targets.length === 0) {
  console.error('用法: node scripts/dump-verifier-context.ts <工作区…> | --all [--write <输出文件>]');
  process.exit(1);
}

console.log(`预算：每文件 ${VERIFIER_CONTEXT_BUDGETS.perFile} 字符 ／ 每结构化工件 ${VERIFIER_CONTEXT_BUDGETS.perStructuredArtifact} ／ 总 ${VERIFIER_CONTEXT_BUDGETS.total}\n`);
console.log(
  '轮次      工件  文件  截断文件  截断工件  省略  上下文字符   旧实现显示  内容完整率对比',
);
console.log('─'.repeat(96));

let sumNew = 0;
let sumOld = 0;
let sumTotal = 0;
for (const ws of targets) {
  const r = await inspect(ws, wantWrite && targets.length === 1 ? wantWrite : undefined);
  if (!r) {
    console.log(`${ws.padEnd(16)} (无 Requirement 工件)`);
    continue;
  }
  // 内容完整率：新实现显示了多少「原始内容」，旧实现显示了多少
  const newPct = 100;
  const oldPct = r.legacy.total > 0 ? Math.round((100 * r.legacy.shown) / r.legacy.total) : 100;
  console.log(
    `${r.ws.padEnd(16)} ${String(r.stats.artifacts).padStart(4)}  ${String(r.stats.files).padStart(4)}  ` +
      `${String(r.stats.filesTruncated).padStart(8)}  ${String(r.stats.artifactsTruncated).padStart(8)}  ` +
      `${String(r.stats.omitted.length).padStart(4)}  ${String(r.stats.chars).padStart(10)}  ` +
      `${String(r.legacy.shown).padStart(10)}  ${String(oldPct).padStart(3)}% → ${newPct}%`,
  );
  sumNew += r.stats.chars;
  sumOld += r.legacy.shown;
  sumTotal += r.legacy.total;
  if (r.stats.omitted.length) console.log(`                  ⚠ 整块省略: ${r.stats.omitted.join(', ')}`);
  if (r.stats.filesTruncated) console.log(`                  ⚠ 被截断的文件数: ${r.stats.filesTruncated}/${r.stats.files}`);
}

if (sumOld > 0) {
  console.log('─'.repeat(96));
  console.log(
    `合计：旧实现显示 ${sumOld} 字符（占可显示内容的 ${Math.round((100 * sumOld) / sumTotal)}%）` +
      ` → 新实现 ${sumNew} 字符`,
  );
  console.log(
    `      体积变化 ${sumNew > sumOld ? '+' : ''}${Math.round((100 * (sumNew - sumOld)) / sumOld)}%；` +
      `但显示的内容从 ${Math.round((100 * sumOld) / sumTotal)}% 提升到接近 100%`,
  );
}
