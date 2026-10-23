/**
 * 实时查看一次 run 的进度（只读，0 token）。
 *
 *   node scripts/run-progress.ts <工作区> [--watch 秒]
 *
 * 为什么需要它：一次真实 run 要十几分钟，而 CLI 只在**结束时**打印报告。
 * 中途想知道「跑到哪了、花了多少、在等什么」，只能去翻 decisions.jsonl / runs/*.jsonl ——
 * 那些是给人读的日志格式，不适合当场看。这个脚本把它们投影成一张表。
 *
 * ⚠️ 一个诚实的限制：`runs/*.jsonl` **只存 prompt 的 hash，不存 prompt 本身**
 * （见 packages/memory/src/ingest.ts 的说明），所以这里看不到「角色实际拿到了什么」。
 * 想知道那个，用 `scripts/dump-verifier-context.ts`（它会在本地重建上下文）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Rec = Record<string, any>;

function readJsonl(p: string): Rec[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Rec;
      } catch {
        return null;
      }
    })
    .filter((x): x is Rec => x !== null);
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s 前`;
  return `${Math.floor(m / 60)}h${m % 60}m 前`;
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const rel of ['decisions.jsonl', 'runs', 'artifacts', 'anchors']) {
    const p = join(dir, rel);
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        for (const f of readdirSync(p)) {
          try {
            newest = Math.max(newest, statSync(join(p, f)).mtimeMs);
          } catch {
            /* ignore */
          }
        }
      } else {
        newest = Math.max(newest, st.mtimeMs);
      }
    } catch {
      /* ignore */
    }
  }
  return newest;
}

export function progressOf(ws: string): string[] {
  const out: string[] = [];
  const decisions = readJsonl(join(ws, 'decisions.jsonl'));
  const runFiles = existsSync(join(ws, 'runs'))
    ? readdirSync(join(ws, 'runs')).filter((f) => f.endsWith('.jsonl'))
    : [];
  const recs = runFiles.flatMap((f) => readJsonl(join(ws, 'runs', f))).filter((r) => r['purpose']);

  const age = Date.now() - newestMtime(ws);
  out.push(`状态：${age < 120_000 ? '🟢 进行中' : age < 900_000 ? '🟡 可能卡住' : '⚪ 静止'}（最后一次写盘 ${fmtAge(age)}）`);

  // 当前在做什么
  const last = recs[recs.length - 1];
  if (last) {
    out.push(`当前：${last['role']} · ${last['purpose']}（已完成 ${recs.length} 次调用）`);
  }

  // 成本
  let tok = 0;
  let pt = 0;
  let ct = 0;
  const byRole: Record<string, number> = {};
  for (const r of recs) {
    const u = r['response']?.usage;
    if (!u) continue;
    const t = (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
    tok += t;
    pt += u.promptTokens ?? 0;
    ct += u.completionTokens ?? 0;
    byRole[r['role']] = (byRole[r['role']] ?? 0) + t;
  }
  out.push(
    `成本：${tok.toLocaleString()} tokens（输入 ${pt.toLocaleString()} / 输出 ${ct.toLocaleString()}）` +
      (Object.keys(byRole).length ? `  [${Object.entries(byRole).map(([k, v]) => `${k} ${v}`).join(' / ')}]` : ''),
  );

  /**
   * 输入审计：最近一次调用**到底看到了什么**。
   *
   * 这一行是第 21 轮那次事故的直接产物（`docs/07 §R`）：当时输入恒定 ~10.6k token、
   * 契约与全部代码都被预算挤掉，而这件事在 run 日志里**查不到**，
   * 于是 20 轮里所有归因都落在「模型写得差」上。
   *
   * 现在把「预算 / 已用 / 注入几个 / 丢掉几个」直接印出来 ——
   * 「模型是不是被饿着在写」应该一眼可见，而不是靠复算。
   */
  const withCtx = [...recs].reverse().find((r) => r['context']);
  if (withCtx) {
    const c = withCtx['context'] as {
      budget: number;
      used: number;
      injected: Array<{ id: string; kind: string; card?: true; digest?: true }>;
      omitted: Array<{ id: string; kind: string; chars: number; reason: string }>;
    };
    const pct = c.budget > 0 ? (c.used / c.budget) * 100 : 0;
    out.push(
      `上下文：${c.used.toLocaleString()} / ${c.budget.toLocaleString()} 字符（${pct.toFixed(0)}%）` +
        `  注入 ${c.injected.length} 个·丢弃 ${c.omitted.length} 个` +
        `  [${withCtx['role']} · ${withCtx['purpose']}]`,
    );
    const cards = c.injected.filter((x) => x.card).length;
    const digests = c.injected.filter((x) => x.digest).length;
    if (cards > 0 || digests > 0) out.push(`  其中接口卡 ${cards} 个、契约摘要 ${digests} 个`);
    if (c.omitted.length > 0) {
      const shown = c.omitted.slice(0, 4).map((o) => `${o.id}(${o.chars}·${o.reason})`);
      out.push(`  未注入：${shown.join('、')}${c.omitted.length > 4 ? ` …共 ${c.omitted.length} 个` : ''}`);
    }
  }

  // Gate 序列
  const gates = decisions.filter((d) => d['kind'] === 'gate.evaluated');
  if (gates.length === 0) {
    out.push('Gate：尚无');
  } else {
    out.push('Gate：');
    for (const g of gates) {
      const p = g['payload'] ?? {};
      const anchors = (p.anchors ?? []).map((a: Rec) => `${a.id}:${a.verdict}`).join(' ');
      const bad = (p.anchors ?? []).filter((a: Rec) => a.verdict === 'FAIL').length;
      out.push(
        `  ${String(p.stage).padEnd(12)} seq${String(p.sequence).padEnd(2)} ` +
          `${String(p.nextAction?.kind ?? '?').padEnd(14)} ${bad > 0 ? `✗${bad} ` : ''}${anchors}`,
      );
    }
  }

  // 工件
  const arts: string[] = [];
  const artRoot = join(ws, 'artifacts');
  if (existsSync(artRoot)) {
    for (const kind of readdirSync(artRoot)) {
      const kp = join(artRoot, kind);
      try {
        if (!statSync(kp).isDirectory()) continue;
        const files = readdirSync(kp).filter((f) => f.endsWith('.json'));
        if (files.length) arts.push(`${kind}×${files.length}`);
      } catch {
        /* ignore */
      }
    }
  }
  out.push(`工件：${arts.length ? arts.join(' · ') : '（无）'}`);

  // 最近一轮锚点的失败摘要
  const anchorDir = join(ws, 'anchors');
  if (existsSync(anchorDir)) {
    const files = readdirSync(anchorDir).filter((f) => f.endsWith('.json'));
    const rounds = [...new Set(files.map((f) => f.replace(/-\d+\.json$/, '')))];
    const lastRound = rounds.sort().at(-1);
    if (lastRound) {
      const fails: string[] = [];
      for (const f of files.filter((x) => x.startsWith(lastRound))) {
        try {
          const j = JSON.parse(readFileSync(join(anchorDir, f), 'utf8')) as Rec;
          if (j.verdict === 'FAIL' || j.verdict === 'INVALID_EVIDENCE') {
            const codes = [...new Set((j.findings ?? []).map((x: Rec) => x.code))].join(',');
            fails.push(`${j.anchorId}(${(j.findings ?? []).length}: ${codes})`);
          }
        } catch {
          /* ignore */
        }
      }
      out.push(`最近一轮锚点（${lastRound}）失败：${fails.length ? fails.join(' | ') : '无'}`);
    }
  }

  return out;
}

const ws = process.argv[2];
if (!ws) {
  console.error('用法：node scripts/run-progress.ts <工作区> [--watch 秒]');
  process.exit(1);
}

const watchIdx = process.argv.indexOf('--watch');
const watchSec = watchIdx !== -1 ? Number(process.argv[watchIdx + 1]) : 0;

function tick(): void {
  const now = new Date().toISOString().slice(11, 19);
  console.log(`\n═══ ${ws}  ${now} ═══`);
  for (const line of progressOf(ws)) console.log(line);
}

if (watchSec > 0) {
  tick();
  setInterval(tick, watchSec * 1000);
} else {
  tick();
}
