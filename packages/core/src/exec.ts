import { spawn } from 'node:child_process';
import { open, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandSpec } from './types.ts';

/**
 * 子进程执行与输出捕获。
 *
 * 为什么不用 child_process.exec / 默认 stdio: 'pipe'：
 * 受限环境下无法打开命名管道，管道式 stdio 会直接 EPERM。
 * 这里把子进程的 stdout/stderr 重定向到临时**文件**再读回，
 * 在所有环境下都能拿到完整输出与真实退出码。
 */

export type ExecResult = {
  command: string;
  cmd: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** 命令被安全策略拒绝时的原因。此时 exitCode = -1，未真正执行。 */
  deniedReason?: string;
  spawnError?: string;
};

/**
 * 安全策略：falsifier 的 command 来自 LLM，是**不可信输入**。
 * 直接 spawn 一个 LLM 生成的命令等于把 shell 交给模型，必须设闸。
 *
 * 关键设计判断（第一版曾写错，这里记录为什么改）：
 *   第一版对参数里的 `;` `|` `$` 等字符做黑名单。但因为我们**从不使用 shell**
 *   （spawn 不传 shell:true），这些字符会被原样传给子进程，不具解释力 ——
 *   那层检查是安全剧场，反而误杀了合法用法（如 `node -e "a; b"`）。
 *
 *   真正的风险边界是「逃逸出项目沙箱」，因此策略改为：
 *     1. 不使用 shell（spawn 不传 shell:true）
 *     2. 二进制名必须在允许列表内，且不在明确拒绝列表内
 *     3. 参数不得包含逃逸项目根的绝对路径或 `..` 上跳
 *     4. 参数不得包含破坏性标志
 *     5. 工作目录锁定在项目根
 *
 * 已知信任边界（诚实记录，不做虚假保证）：
 *   `node -e` / `node <script>` 本质上是任意代码执行，而本项目的工作就是
 *   **生成并运行代码**，所以「执行不可信代码」是固有属性，不是本列表能消除的。
 *   本列表挡的是「LLM 生成一条命令去删宿主文件/连外网」这类越界，
 *   真正的隔离边界应由操作系统/容器提供（后续可接 sandbox-exec / 容器执行器）。
 */

export const SAFE_BINARIES = [
  'node',
  'npm',
  'npx',
  'pnpm',
  'tsc',
  'vitest',
  'jest',
  'echo',
];

export const DENIED_BINARIES = [
  'rm',
  'rmdir',
  'del',
  'erase',
  'format',
  'mkfs',
  'shutdown',
  'reboot',
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'ssh',
  'scp',
  'reg',
  'regedit',
  'net',
  'netsh',
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'sh',
  'cscript',
  'wscript',
  'mshta',
  'certutil',
  'bitsadmin',
  'attrib',
  'takeown',
  'icacls',
  'schtasks',
  'diskpart',
  'taskkill',
];

const DENIED_ARG_PATTERNS: RegExp[] = [
  /^-rf$/i,
  /^-fr$/i,
  /^--recursive$/i,
  /^--force$/i,
  /^\/s$/i,
  /^\/f$/i,
  /^--no-preserve-root$/i,
];

export type CommandPolicy = {
  allowBinaries: string[];
  denyBinaries: string[];
  timeoutMs: number;
};

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  allowBinaries: SAFE_BINARIES,
  denyBinaries: DENIED_BINARIES,
  timeoutMs: 120_000,
};

export class CommandDenied extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'CommandDenied';
    this.reason = reason;
  }
}

/** 极简 tokenizer：按空白切分，支持单/双引号包裹。不解释任何 shell 语法。 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0 || has) tokens.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (cur.length > 0 || has) tokens.push(cur);
  return tokens;
}

/** 内联脚本参数：其后一个参数是代码而非路径，不做路径围栏检查。 */
const INLINE_SCRIPT_FLAGS = new Set(['-e', '--eval', '-p', '--print']);

/**
 * 作为**独立 token** 出现的 shell 操作符。
 *
 * 注意精确性：这里做整 token 相等判断，而不是子串匹配。
 * 因为我们不走 shell，`node -e "a; b"` 里的 `;` 会被原样传给 node，是无害且必要的；
 * 但 tokenize 之后单独成项的 `&&` / `|` 只可能来自「想串两条命令」，
 * 那正是我们要拒绝的意图。
 */
const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '&', '>', '>>', '<', '`', '$(']);

/**
 * 校验命令是否符合安全策略。通过则返回可执行的 cmd/args。
 * @param projectRoot 项目根。参数中的绝对路径必须落在其内。
 */
export function validateCommand(
  command: string,
  policy: CommandPolicy = DEFAULT_COMMAND_POLICY,
  projectRoot?: string,
): { cmd: string; args: string[] } {
  const tokens = tokenize(command);
  if (tokens.length === 0) throw new CommandDenied('empty command');

  const raw = tokens[0];
  const base = raw.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const baseNoExt = base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '');

  if (policy.denyBinaries.includes(baseNoExt)) {
    throw new CommandDenied(`binary "${baseNoExt}" is on the deny list`);
  }
  if (!policy.allowBinaries.includes(baseNoExt)) {
    throw new CommandDenied(`binary "${baseNoExt}" is not in the allow list`);
  }

  const args = tokens.slice(1);
  const normalizedRoot = projectRoot ? projectRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const prev = i > 0 ? args[i - 1] : '';

    if (SHELL_OPERATORS.has(a)) {
      throw new CommandDenied(`argument "${a}" is a shell operator; command chaining is not allowed`);
    }

    // 内联脚本内容不当作路径处理
    if (INLINE_SCRIPT_FLAGS.has(prev)) continue;

    for (const p of DENIED_ARG_PATTERNS) {
      if (p.test(a)) throw new CommandDenied(`argument "${a}" is denied by policy`);
    }

    if (looksAbsolute(a)) {
      const norm = a.replace(/\\/g, '/').toLowerCase();
      if (normalizedRoot === null || !norm.startsWith(normalizedRoot)) {
        throw new CommandDenied(`argument "${a}" escapes the project root (absolute path outside workspace)`);
      }
    } else if (hasParentTraversal(a)) {
      throw new CommandDenied(`argument "${a}" escapes the project root (contains .. traversal)`);
    }
  }
  return { cmd: raw, args };
}

function looksAbsolute(a: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(a) || a.startsWith('\\\\') || a.startsWith('//') || a.startsWith('/');
}

function hasParentTraversal(a: string): boolean {
  return a.split(/[\\/]/).some((seg) => seg === '..');
}

const MAX_CAPTURE_BYTES = 512 * 1024;

/**
 * Windows 上的可执行文件解析。
 *
 * 这是一个**真实的平台陷阱**，踩过才知道：
 *   - `spawn('npm', ...)` 直接 ENOENT —— Node 在 Windows 上不做 PATHEXT 扩展名解析，
 *     而 npm 实际是 `npm.cmd`。
 *   - `spawn('npm.cmd', ...)` 同步抛 EINVAL —— Node 自 CVE-2024-27980 起
 *     禁止在没有 shell 的情况下直接生成 `.cmd` / `.bat`。
 *
 * 后果很隐蔽：`npm run typecheck` 这类最标准的配置在 Windows 上**永远跑不起来**，
 * 于是 A4（编译/类型）锚点永远报 SKIPPED。SKIPPED ≠ PASS 保证了它不会变成假绿灯，
 * 但用户会**静默地失去最有价值的一个锚点** —— 报告里只有一行「工具链缺失」。
 *
 * 解析策略：无扩展名时按 PATHEXT 在 PATH 里找 `cmd.cmd` / `cmd.exe` / `cmd.bat`。
 */
const WINDOWS_EXT_CANDIDATES = ['.cmd', '.exe', '.bat', '.com'];

export function resolveExecutable(
  cmd: string,
  platform: string = process.platform,
): { path: string; needsShell: boolean } {
  if (platform !== 'win32') return { path: cmd, needsShell: false };
  if (/[\\/]/.test(cmd) || /\.[A-Za-z0-9]+$/.test(cmd)) {
    // 已经是路径或带扩展名
    const lower = cmd.toLowerCase();
    const needsShell = lower.endsWith('.cmd') || lower.endsWith('.bat');
    return { path: cmd, needsShell };
  }
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of WINDOWS_EXT_CANDIDATES) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) {
        return { path: candidate, needsShell: ext === '.cmd' || ext === '.bat' };
      }
    }
  }
  return { path: cmd, needsShell: false };
}

/**
 * 用 shell 执行时，参数必须自行加引号 ——
 * Node 的 `shell: true` 只是把 `cmd + ' ' + args.join(' ')` 拼成一行交给 cmd.exe，
 * 不会做任何转义。同时必须拒绝含 shell 元字符的参数：
 * 那种情况下「参数」可能变成「第二条命令」。
 *
 * 导出是刻意的：A6 的运行时探针（anchors/fact.ts）也需要启动子进程，
 * 而它在 Windows 上必须走同一条 `resolveExecutable` + 引号处理的路 ——
 * 两处各写一份必然漂移，而漂移的后果是「一个锚点能跑、另一个报 ENOENT」。
 */
const SHELL_UNSAFE_ARG = /["%!^&|<>()\r\n\t]/;

export function quoteForShell(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '')}"`;
}

async function readCapped(path: string): Promise<string> {
  try {
    const buf = await readFile(path);
    if (buf.byteLength <= MAX_CAPTURE_BYTES) return buf.toString('utf8');
    return (
      buf.subarray(0, MAX_CAPTURE_BYTES).toString('utf8') +
      `\n...[truncated at ${MAX_CAPTURE_BYTES} bytes]`
    );
  } catch {
    return '';
  }
}

export type ExecOptions = {
  cwd: string;
  timeoutMs?: number;
  policy?: CommandPolicy;
  /** 允许调用方直接给结构化 cmd/args（例如 profile 里的 typecheck 命令），跳过策略校验。 */
  trusted?: CommandSpec;
  env?: Record<string, string>;
};

/**
 * 把 `(cmd, args)` 转成**可以直接交给 spawn 的三元组**。
 *
 * 抽出来共享的理由：`execCapture`（A4/A5、falsifier）与 A6 的运行时探针
 * 都要启动子进程，而 Windows 的可执行解析 + shell 拼接这两件事
 * 各写一份必然漂移 —— 实测后果就是「A4/A5 能跑、A6 一跑就把进程打死」（docs/07 §L6）。
 *
 * 关于 `shell: true` 与 DEP0190：
 * Node 自 v22 起对「`shell: true` 且传了 args」发出 DEP0190 警告 ——
 * 因为 shell 模式只是把 cmd 与 args 简单拼接，args 并未被转义。
 * 既然语义本来就是「一行命令」，这里**自己拼好整行、args 传空数组**：
 * 行为一致、不触发警告，且拼接与转义完全由我们控制（配合 quoteForShell）。
 */
export function prepareSpawn(cmd: string, args: string[]): { cmd: string; args: string[]; shell: boolean } {
  const resolved = resolveExecutable(cmd);
  if (!resolved.needsShell) return { cmd: resolved.path, args, shell: false };
  return {
    cmd: [quoteForShell(resolved.path), ...args.map(quoteForShell)].join(' '),
    args: [],
    shell: true,
  };
}

export async function execCapture(command: string, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const policy = opts.policy ?? DEFAULT_COMMAND_POLICY;
  const timeoutMs = opts.timeoutMs ?? policy.timeoutMs;

  let cmd: string;
  let args: string[];
  let needsShell = false;

  if (opts.trusted) {
    const resolved = resolveExecutable(opts.trusted.cmd);
    cmd = resolved.path;
    args = opts.trusted.args;
    needsShell = resolved.needsShell;
    if (needsShell) {
      // 受信任的命令来自我们自己的 ProjectProfile（typecheck / test / run），
      // 参数是用户写在配置里的固定值，不是 LLM 生成的。即便如此也要挡住元字符，
      // 因为 shell 拼接不区分「参数」与「第二条命令」。
      for (const a of args) {
        if (SHELL_UNSAFE_ARG.test(a)) {
          return {
            command,
            cmd,
            args,
            exitCode: -1,
            stdout: '',
            stderr: '',
            durationMs: Date.now() - started,
            timedOut: false,
            deniedReason: `参数 ${JSON.stringify(a)} 含 shell 元字符，拒绝在 shell 模式下执行`,
          };
        }
      }
    }
  } else {
    try {
      const v = validateCommand(command, policy, opts.cwd);
      const resolved = resolveExecutable(v.cmd);
      cmd = resolved.path;
      args = v.args;
      needsShell = resolved.needsShell;
      if (needsShell) {
        // 未经信任的路径（LLM 生成的 falsifier）走到 .cmd/.bat 时，
        // 即便二进制在白名单里，也要求参数完全不含 shell 元字符才放行。
        for (const a of args) {
          if (SHELL_UNSAFE_ARG.test(a)) {
            return {
              command,
              cmd,
              args: [],
              exitCode: -1,
              stdout: '',
              stderr: '',
              durationMs: Date.now() - started,
              timedOut: false,
              deniedReason: `LLM 生成的命令解析到批处理脚本 ${cmd}，且参数含 shell 元字符，拒绝执行`,
            };
          }
        }
      }
    } catch (err) {
      const reason = err instanceof CommandDenied ? err.reason : String(err);
      return {
        command,
        cmd: '',
        args: [],
        exitCode: -1,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
        timedOut: false,
        deniedReason: reason,
      };
    }
  }

  // 交给 prepareSpawn 做最后一步转换（拼整行 + args 清空），理由见该函数的说明。
  // 上面的元字符校验必须留在**这里**（它对「受信任」与「不受信任」两条路径的严格程度不同），
  // 但「怎么拼给 spawn」这件事只应有一份实现。
  const prepared = prepareSpawn(cmd, args);
  const spawnCmd = prepared.cmd;
  const spawnArgs = prepared.args;

  const dir = join(tmpdir(), `agentforge-exec-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, 'stdout.txt');
  const errPath = join(dir, 'stderr.txt');
  let outFd: Awaited<ReturnType<typeof open>> | null = null;
  let errFd: Awaited<ReturnType<typeof open>> | null = null;

  try {
    outFd = await open(outPath, 'w');
    errFd = await open(errPath, 'w');

    const result = await new Promise<{
      exitCode: number;
      timedOut: boolean;
      spawnError?: string;
    }>((resolve) => {
      let settled = false;
      let timedOut = false;
      let spawnError: string | undefined;

      const child = spawn(spawnCmd, spawnArgs, {
        cwd: opts.cwd,
        stdio: ['ignore', outFd!.fd, errFd!.fd],
        windowsHide: true,
        // .cmd/.bat 必须经过 shell —— Node 自 CVE-2024-27980 起禁止直接生成批处理。
        // 走 shell 时参数已经过元字符检查与引号包裹（见上）。
        shell: prepared.shell,
        env: { ...process.env, ...(opts.env ?? {}) },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, timeoutMs);

      const done = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, timedOut, spawnError });
      };

      child.on('close', (code) => done(code ?? -1));
      child.on('error', (e: Error & { code?: string }) => {
        spawnError = `${e.code ?? 'SPAWN_ERROR'}: ${e.message}`;
        done(-1);
      });
    });

    await outFd.close();
    outFd = null;
    await errFd.close();
    errFd = null;

    const stdout = await readCapped(outPath);
    const stderr = await readCapped(errPath);

    return {
      command,
      cmd,
      args,
      exitCode: result.exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
    };
  } finally {
    if (outFd) await outFd.close().catch(() => {});
    if (errFd) await errFd.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 判定命令是否可用（例如 tsc 是否存在）。用于锚点决定 SKIPPED 而非 FAIL。 */
export async function probeCommand(
  cmd: string,
  cwd: string,
): Promise<{ available: boolean; version?: string; detail?: string }> {
  // 先做一次可执行文件解析：解析不到就没必要真去 spawn 一次。
  // 这一步同时把 Windows 的 npm/pnpm 这类 .cmd 垫片解析成真实路径。
  const resolved = resolveExecutable(cmd);
  const r = await execCapture('', {
    cwd,
    trusted: { cmd: resolved.path, args: ['--version'] },
    timeoutMs: 20_000,
  });
  if (r.spawnError) return { available: false, detail: r.spawnError };
  if (r.deniedReason) return { available: false, detail: r.deniedReason };
  if (r.exitCode === 0) return { available: true, version: r.stdout.trim().split('\n')[0] };
  return { available: false, detail: `exit ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
}
