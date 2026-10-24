/**
 * 原始诉求（brief）的 pre-flight 校验。
 *
 * ── 为什么需要它（实测事故，2026-10-24）──────────────────────────
 *
 * 我给了用户这样一条命令：
 *
 *   node packages/orchestrator/src/cli-run.ts --name cb-18 --brief (Get-Content -Raw brief.txt)
 *
 * PowerShell 没有把 `(...)` 当表达式求值，而是把 `(Get-Content` 当成**字面量**传了进去。
 * 于是这个 run 的「用户诉求」是 13 个字符的命令片段。
 *
 * 更糟的是系统**把这当作合法输入**跑完了 5 个门禁、烧掉 6.2 万 token，
 * 最后报「完整交付」：PM 把「输入不完整」写成了需求
 * （R-001 澄清被截断的诉求、R-002 冻结范围不做任何源码），
 * 然后证明这两条需求达成了 —— 一个**一行业务代码都没有**的项目拿到了 `fullyVerified = true`。
 *
 * 这条教训有两半：
 *   1. 输入端必须做 pre-flight —— 明显被截断的诉求应当在**启动前**被拒绝，
 *      而不是让系统花 6 万 token 去"澄清"它；
 *   2. 交付端必须问「这份交付和诉求对得上吗」—— 见 gate.ts 的 `empty-delivery`。
 *
 * 判据刻意**窄**：只拦「明显是 shell 片段」和「短到无法做需求工程」两类。
 * 放过一个真的是短诉求的输入（比如「做个计算器」）比误拒一个正常诉求轻得多 ——
 * 而误拒会让用户以为工具坏了。
 */

export type BriefCheckResult = { ok: true } | { ok: false; reason: string };

/** PowerShell / bash 里常见的「表达式没被求值，被当成字面量」的开头。 */
const SHELL_FRAGMENT_PREFIX =
  /^[([{$]|^(Get-Content|Get-ChildItem|Get-Item|Get-FileHash|Invoke-WebRequest|Invoke-RestMethod|Set-Location|Set-ItemProperty|Select-String|cat\s|ls\s|type\s)/i;

export function validateBrief(brief: string | undefined | null): BriefCheckResult {
  const text = (brief ?? '').trim();

  if (text.length === 0) {
    return { ok: false, reason: '原始诉求为空 —— 没有诉求就无法做需求工程。' };
  }

  if (text.length < 4) {
    return {
      ok: false,
      reason: `原始诉求只有 ${text.length} 个字符（${JSON.stringify(text)}），短到无法据此拆需求、定验收。`,
    };
  }

  if (SHELL_FRAGMENT_PREFIX.test(text)) {
    return {
      ok: false,
      reason:
        `原始诉求看起来是**被 shell 截断的命令片段**：${JSON.stringify(text.slice(0, 60))}。\n` +
        '常见原因：把长文本直接写在命令行里，例如\n' +
        '  node .../cli-run.ts --brief (Get-Content -Raw brief.txt)   ← PowerShell 把 (Get-Content 当成了字面量\n' +
        '正确做法（先赋值，再传变量）：\n' +
        '  $brief = Get-Content -Raw E:\\path\\brief.txt\n' +
        '  node .../cli-run.ts --brief $brief\n' +
        '或者用控制台（http://127.0.0.1:7788）的 brief 输入框，不会有 shell 转义问题。',
    };
  }

  return { ok: true };
}
