/**
 * 「自己的校验清单也必须被校验」。
 *
 * 背景（一处真实踩到的坑）：
 * 引擎是零依赖 + Node 原生类型剥离直接运行的，**没有编译期类型检查**。
 * 于是「`log.append('某个联合类型里没有的 kind')`」不会报错，只会静默写进日志。
 * 审计时实测发现 3 个已经在用的 kind 根本不在 `DecisionKind` 里：
 * `profile.refreshed` / `requirement.status.synced` / `testreport.published`。
 *
 * 这件事本身就值得一个测试，理由是它和本项目要解决的问题同构：
 * **一个「看起来在检查」的清单，如果没有机制保证它跟现实一致，它就只是措辞。**
 * 决策日志是「所有关键结论必须留痕」这条不变量的载体 ——
 * 它的清单漂了，那条不变量就跟着漂。
 *
 * 这条测试零依赖、零成本、纯字符串扫描，所以没有任何理由不跑它。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { DECISION_KINDS } from '../src/decisionlog.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const SRC_DIRS = ['packages', 'apps', 'scripts'];

async function collectTs(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      await collectTs(join(dir, e.name), out);
    } else if (e.isFile() && /\.tsx?$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

test('决策日志：全部源码里用到的 kind 都必须在 DECISION_KINDS 里（漏一个就失败）', async () => {
  const files: string[] = [];
  for (const d of SRC_DIRS) await collectTs(join(REPO, d), files);
  assert.ok(files.length > 50, `应当扫描到大量源码文件，实际 ${files.length} —— 扫描器是不是坏了？`);

  const known = new Set<string>(DECISION_KINDS);
  const unknown: Array<{ file: string; kind: string }> = [];
  let seen = 0;

  for (const file of files) {
    // 测试文件自己也允许查询 kind，但**写**日志的调用都会被检查
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/\.append\(\s*'([a-zA-Z][a-zA-Z0-9._-]*)'/g)) {
      const kind = m[1]!;
      seen++;
      if (!known.has(kind)) unknown.push({ file: file.slice(REPO.length + 1), kind });
    }
  }

  assert.ok(seen > 10, `应当扫描到多处 append 调用，实际 ${seen} —— 正则是不是失效了？`);
  assert.deepEqual(
    unknown,
    [],
    `以下调用用了 DECISION_KINDS 里没有的 kind（零依赖下不会报错，只会静默写进日志）：\n` +
      unknown.map((u) => `  - ${u.kind}  @ ${u.file}`).join('\n'),
  );
});

test('决策日志：DECISION_KINDS 本身没有重复项（重复会让「清单」失去意义）', () => {
  assert.equal(new Set(DECISION_KINDS).size, DECISION_KINDS.length, 'DECISION_KINDS 里有重复项');
});
