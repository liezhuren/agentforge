/**
 * 检视一次真实 LLM run 的产物。用 Node 而不是 PowerShell 文本 cmdlet，
 * 理由是后者会把 UTF-8 中文读成乱码（见 docs/07 的教训）。
 *
 * 运行：node scripts/inspect-run.ts <工作区>
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ws = process.argv[2];
if (!ws) {
  console.error('用法：node scripts/inspect-run.ts <工作区>');
  process.exit(1);
}

const artifactsDir = join(ws, 'artifacts');
const anchorsDir = join(ws, 'anchors');

const readAll = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    : [];

console.log('═'.repeat(78));
console.log('锚点结果（最后一个 Gate 的每个锚点）');
console.log('═'.repeat(78));
const runs = readAll(anchorsDir) as Array<{
  anchorId: string;
  verdict: string;
  method: string;
  findings: Array<{ code: string; severity: string; message: string; targetRole?: string }>;
}>;

// 同一个锚点会跑很多次，取最后一次
const last = new Map<string, (typeof runs)[number]>();
for (const r of runs) last.set(r.anchorId, r);

for (const [id, r] of [...last].sort()) {
  console.log(`\n${id}  ${r.verdict}   ${r.method}`);
  for (const f of r.findings) {
    console.log(`    [${f.severity}] ${f.code}${f.targetRole ? ` → ${f.targetRole}` : ''}`);
    console.log(`        ${f.message}`);
  }
}

console.log('\n' + '═'.repeat(78));
console.log('工件清单');
console.log('═'.repeat(78));
if (existsSync(artifactsDir)) {
  for (const kind of readdirSync(artifactsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!kind.isDirectory()) continue; // 跳过 .counter.json 这类文件
    const dir = join(artifactsDir, kind.name);
    const n = readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    console.log(`  ${kind.name.padEnd(22)} ${n}`);
  }
}

console.log('\n' + '═'.repeat(78));
console.log('圆桌纪要');
console.log('═'.repeat(78));
for (const dir of ['RoundtableMinute']) {
  for (const m of readAll(join(artifactsDir, dir)) as Array<{ id: string; content: Record<string, unknown> }>) {
    const c = m.content;
    console.log(`\n${m.id}  trigger=${c.trigger}`);
    console.log(`与会：${JSON.stringify(c.participants)}`);
    console.log(`议程：${JSON.stringify(c.agenda, null, 2)}`);
    const sts = (c.statements ?? []) as Array<Record<string, unknown>>;
    console.log(`发言 ${sts.length} 条，丢弃 ${sts.filter((s) => s.discarded).length} 条`);
    for (const s of sts) {
      const flag = s.discarded ? '✖' : '✔';
      console.log(`  ${flag} 第${s.round}轮 ${s.role}${s.againstRole ? ` → ${s.againstRole}` : ''}: ${String(s.claim).slice(0, 90)}`);
      if (s.discarded) console.log(`      丢弃原因：${String(s.discarded).slice(0, 200)}`);
    }
    console.log(`决议：${c.resolution ? JSON.stringify(c.resolution).slice(0, 400) : 'null'}`);
    if (c.invalidReason) console.log(`判无效原因：${c.invalidReason}`);
    if (c.escalation) console.log(`升级：${c.escalation}`);
  }
}

console.log('\n' + '═'.repeat(78));
console.log('产出到磁盘的代码文件');
console.log('═'.repeat(78));
const walk = (dir: string, base = ''): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'artifacts' || e.name === 'anchors' || e.name === 'runs') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
};
for (const f of walk(ws).sort()) console.log(`  ${f}`);
