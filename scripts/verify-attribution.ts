/**
 * 用 llm-7 的真实工件，对比「修复前/后」的归因结果。
 *
 * 目的：证明「系统为什么老是开圆桌」的根因是归因器哑了 ——
 * 修复后同样的失败会归到具体角色，于是可以**打回**，而不是开会。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ArtifactStore } from '../packages/core/src/index.ts';
import { createAnchorContext, attributeByArtifact, attributeByPath } from '../packages/anchors/src/index.ts';

const ws = process.argv[2];
if (!ws) {
  console.error('用法: node scripts/verify-attribution.ts <工作区>');
  process.exit(1);
}

const store = new ArtifactStore(ws);
await store.init();

const ctx = createAnchorContext({
  projectRoot: ws,
  store,
  profile: {
    name: 'llm',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: null,
    test: null,
    run: null,
    knownPackages: [],
    dependencyAllowlist: null,
  },
  offline: true,
  runPrefix: 'verify',
});

console.log('=== 本轮实际声明的 CodeModule 归属 ===');
for (const a of store.heads('CodeModule')) {
  const files = (a.content as unknown as { files: Array<{ path: string }> }).files ?? [];
  console.log(`  ${a.producer.padEnd(9)} ← ${files.map((f) => f.path).join(', ')}`);
}
for (const a of store.heads('TestSuite')) {
  const files = (a.content as unknown as { files: Array<{ path: string }> }).files ?? [];
  console.log(`  test      ← ${files.map((f) => f.path).join(', ')}`);
}

// 从锚点运行记录里取出真实的失败文件
console.log('\n=== 真实失败项的归因：修复前 vs 修复后 ===');
const anchorDir = join(ws, 'anchors');
if (!existsSync(anchorDir)) {
  console.log('  (没有锚点记录)');
  process.exit(0);
}

const paths = new Set<string>();
for (const f of readdirSync(anchorDir).filter((x) => x.endsWith('.json'))) {
  const r = JSON.parse(readFileSync(join(anchorDir, f), 'utf8')) as {
    anchorId: string;
    verdict: string;
    findings: Array<{ code: string; message: string; targetRole?: string; file?: string }>;
  };
  if (r.verdict !== 'FAIL') continue;
  for (const fd of r.findings) {
    const p = fd.file ?? /([\w./-]+\.ts)/.exec(fd.message)?.[1];
    if (p) paths.add(p.replace(/\\/g, '/'));
  }
}

if (paths.size === 0) {
  console.log('  (没有可解析的失败文件路径)');
}
for (const p of [...paths].sort()) {
  const before = attributeByPath(p);
  const after = attributeByArtifact(ctx, p);
  const mark = before === after ? '  ' : '★ ';
  console.log(`  ${mark}${p.padEnd(26)} 修复前=${before.padEnd(11)} 修复后=${after}`);
}
console.log('\n★ = 归因发生变化：从「没人负责」或「归错人」变成「归到真正的产出方」');
