/**
 * 用**真实的 LLM 产出**验证契约强制层，而不是用构造出来的样本。
 *
 * 为什么要有这个脚本：
 * 单元测试里的「恶意产出」是我自己写的，它证明不了「真实模型交出来的东西会被拦住」。
 * 第 12 轮（llm-12）那份产出的原文就躺在工作区里 ——
 * 直接把它喂给 `enforceProjectContract`，看它会被判成什么。
 *
 * 这比再跑一轮真实 LLM 便宜 6 个数量级（0 token vs 38 万），
 * 而且更确定：真实运行还会受模型随机性影响，这个不会。
 *
 * 运行：node scripts/verify-contract-enforcement.ts workspace/llm-12
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { enforceProjectContract, readProjectContract } from '../packages/core/src/projectcontract.ts';
import type { Artifact, CodeModule } from '../packages/core/src/types.ts';

const ws = process.argv[2];
if (!ws) {
  console.error('用法：node scripts/verify-contract-enforcement.ts <工作区路径>');
  process.exit(1);
}

// 1) 按「运行开始时」的口径取契约快照。
//    注意：llm-12 跑完之后 package.json 已经被篡改过了 ——
//    所以这里要还原成**预置时的样子**（preseed 写的契约），
//    否则就是拿被改过的文件当基准，等于自己骗自己。
const PRESEEDED = {
  name: 'llm-generated',
  version: '1.0.0',
  private: true,
  type: 'module',
  scripts: {
    typecheck: 'tsc --noEmit -p tsconfig.json',
    test: 'node run-tests.mjs',
    start: 'node src/api/server.ts',
  },
  agentforge: {
    healthUrl: 'http://127.0.0.1:8787/health',
    environmentNotes: ['…'],
    protectedFiles: ['run-tests.mjs'],
  },
  devDependencies: { typescript: '^7.0.0', '@types/node': '^26.0.0' },
};

const { contract } = await readProjectContract(ws);
// 用预置契约覆盖（并补上 tsconfig 的存在性）
const baseline = {
  pkgExists: true,
  pkgKeys: PRESEEDED as unknown as Record<string, unknown>,
  protectedFiles: { ...contract.protectedFiles, 'tsconfig.json': 'x' },
};

console.log('基准（预置契约）的顶层键：', Object.keys(baseline.pkgKeys).join(', '));
console.log('受保护文件：', Object.keys(baseline.protectedFiles).join(', '));
console.log('');

const dir = join(ws, 'artifacts', 'CodeModule');
const { readdir } = await import('node:fs/promises');
const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();

let totalViolations = 0;
for (const name of names) {
  const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as Artifact<CodeModule>;
  const files = raw.content?.files ?? [];
  const touchesContract = files.some(
    (f) => f.path === 'package.json' || f.path === 'tsconfig.json' || f.path === 'run-tests.mjs',
  );
  if (!touchesContract) continue;

  const res = enforceProjectContract({
    contract: baseline,
    files,
    producer: 'backend',
    artifactKind: 'CodeModule',
  });

  console.log(`── ${name}`);
  console.log(`   产出文件：${files.map((f) => f.path).join(', ')}`);
  if (res.violations.length === 0) {
    console.log('   ✓ 未发现契约违规');
  } else {
    for (const v of res.violations) {
      console.log(`   ✗ [${v.code}] ${v.path}${v.key ? ` / ${v.key}` : ''} → 归因 ${v.targetRole}`);
    }
    totalViolations += res.violations.length;
    const pkg = res.files.find((f) => f.path === 'package.json');
    if (pkg) {
      const parsed = JSON.parse(pkg.content) as Record<string, unknown>;
      const kept = 'agentforge' in parsed;
      console.log(`   落盘内容是否保留了 agentforge 声明：${kept ? '是 ✓' : '否 ✗'}`);
    }
    if (!res.files.some((f) => f.path === 'tsconfig.json')) {
      console.log('   tsconfig.json 已从产出中剔除 ✓（原文件不受影响）');
    }
  }
  console.log('');
}

console.log(`合计 ${totalViolations} 条契约违规 —— 这些在第 12 轮里全部真实发生过，且当时无人报出。`);
