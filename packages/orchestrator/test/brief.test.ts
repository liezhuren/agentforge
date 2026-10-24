/**
 * 原始诉求（brief）的 pre-flight 校验。
 *
 * 起因是一次真实事故（cb-18，2026-10-24）：我给了用户一条命令
 *   node .../cli-run.ts --brief (Get-Content -Raw brief.txt)
 * PowerShell 没把括号当表达式求值，于是 brief 变成了字面量 `(Get-Content`（13 字符）。
 *
 * 更严重的是系统**接受了它**：跑完 5 个门禁、烧掉 6.2 万 token，
 * PM 把「输入不完整」写成了两条需求（澄清截断的诉求 / 冻结范围不做任何源码），
 * 然后证明这两条"达成"，最终报 `fullyVerified = true` —— 而一行业务代码都没有。
 *
 * 所以输入端必须有闸门：明显被截断的输入应当在**启动前**被拒绝，
 * 而不是让系统花几万 token 去"澄清"它。
 *
 * 判据刻意**窄**：只拦「明显是 shell 片段」和「短到无法做需求工程」两类。
 * 宁可放过一个很短的正常诉求（「做个计算器」），也不要误拒一个正常输入 ——
 * 误拒会让用户以为工具坏了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateBrief } from '../src/brief.ts';

test('🔴 PowerShell 把 (Get-Content …) 当字面量传进来 → 必须拒绝（cb-18 的真实输入）', () => {
  const r = validateBrief('(Get-Content');
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /命令片段/);
  // 必须告诉用户怎么改，否则他只会再试一次同样的写法
  assert.match(r.ok === false ? r.reason : '', /先赋值/);
  assert.match(r.ok === false ? r.reason : '', /7788/, '要给出不受 shell 转义影响的替代路径');
});

test('其他常见 shell 片段也要拦（不是只硬编码一个用例）', () => {
  for (const bad of ['Get-Content -Raw x.txt', '$brief = "x"', '[System.IO.File]', '{ "a": 1 }', 'cat brief.txt']) {
    assert.equal(validateBrief(bad).ok, false, `应拒绝：${bad}`);
  }
});

test('空诉求 / 极短诉求 → 拒绝（无法据此拆需求、定验收）', () => {
  assert.equal(validateBrief('').ok, false);
  assert.equal(validateBrief('   ').ok, false);
  assert.equal(validateBrief('好').ok, false);
});

test('正常诉求必须放过 —— 包括很短的（误拒比漏放更糟）', () => {
  for (const good of [
    '做个计算器',
    '做一个任务看板：用户可以创建任务、列出全部任务，并支持按状态筛选。',
    'Build a TODO app with a REST API.',
    '专业课程设计II 题目3：面向科研的"茶歇"系统',
  ]) {
    assert.equal(validateBrief(good).ok, true, `应放行：${good}`);
  }
});
