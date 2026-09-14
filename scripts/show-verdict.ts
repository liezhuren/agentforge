/**
 * 打印某一轮在控制台标题栏会显示什么（直接调用服务端的 deriveVerdict）。
 *
 * 目的：控制台的表现不应靠肉眼看截图来确认 —— 用与服务端**同一个函数**
 * 算出它，就是所谓「判定唯一真相在服务端」的直接验证。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { deriveVerdict } from '../packages/server/src/run-manager.ts';

const ws = process.argv[2];
if (!ws) {
  console.error('用法: node scripts/show-verdict.ts <工作区>');
  process.exit(1);
}

// 从工件库读需求状态（与 server 的 summary.requirementStatuses 同源）
let statuses: Array<{ id: string; status: string }> = [];
const dir = join(ws, 'artifacts', 'Requirement');
if (existsSync(dir)) {
  const files = readdirSync(dir).sort();
  const last = files[files.length - 1];
  if (last) {
    const a = JSON.parse(readFileSync(join(dir, last), 'utf8')) as {
      content: { requirements: Array<{ id: string; status: string }> };
    };
    statuses = a.content.requirements.map((r) => ({ id: r.id, status: r.status }));
  }
}

let delivery: 'complete' | 'with-debt' | 'awaiting-human' | 'held' | null = null;
const log = join(ws, 'decisions.jsonl');
if (existsSync(log)) {
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  delivery = lines.find((x) => x.kind === 'run.finished')?.payload?.delivery ?? null;
}

const v = deriveVerdict({ delivery, requirementStatuses: statuses } as never);

console.log(`工作区: ${ws}`);
console.log('');
console.log('控制台标题栏会显示：');
console.log(`  [${v.fullyVerified ? '真·完整交付' : v.mechanical === 'complete' ? '机械检查全过' : v.mechanical}]`);
console.log(`  [需求 ${v.counts.met}/${v.counts.total}${v.counts.unverified ? ` · 确认不了 ${v.counts.unverified}` : ''}${v.counts.open ? ` · 未达成 ${v.counts.open}` : ''}]`);
console.log('');
console.log('鼠标悬停提示（服务端统一措辞）：');
console.log(`  ${v.summary}`);
console.log('');
console.log(`fullyVerified = ${v.fullyVerified}`);
console.log(`mechanical    = ${v.mechanical}`);
console.log(`requirements  = ${v.requirements}`);
console.log(`counts        = ${JSON.stringify(v.counts)}`);
