/**
 * AgentForge 真实 run CLI。
 *
 * 用法：
 *   node packages/orchestrator/src/cli-run.ts init                  # 生成配置模板
 *   node packages/orchestrator/src/cli-run.ts --brief "做一个..."    # 用真实 LLM 跑一次
 *   node packages/orchestrator/src/cli-run.ts --replay <runId>      # 离线回放某次 run
 *
 * 关于「当前环境没有外网」：本 CLI 完全按真实端点写，不做任何针对当前环境的特殊处理。
 * Provider 层是用**本地假的 OpenAI 兼容服务器**做的端到端测试（真 HTTP、真状态码、真超时），
 * 覆盖了重试、降级、超时、错误体、预算超限等路径 —— 这些恰恰是打真 API 时最难复现、
 * 也最容易在生产上出问题的部分。你只要填好 config 并配好 key，即可打真实端点。
 *
 * 结构上刻意拆出 `runCli(options)`：CLI 也应当能被测试，
 * 「import 即执行 main()」会让它无法在进程内被验证。
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DecisionLog, Logger, readJsonOrNull, type ProjectProfile } from '../../core/src/index.ts';
import {
  CONFIG_FILENAME,
  ReplayProvider,
  buildLlm,
  listRuns,
  loadConfigFile,
  loadRunRecords,
  writeTemplateConfig,
  type ForgeConfig,
} from '../../llm/src/index.ts';
import { createBoundRoleRunners } from '../../roles/src/index.ts';
import { SemanticVerifier } from '../../roles/src/verify.ts';
import { Orchestrator } from './orchestrator.ts';

const DEFAULT_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
};

export type CliIO = {
  argv: string[];
  cwd: string;
  /** 仓库根（用于默认工作区与配置查找）。 */
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    get,
    has: (name: string) => argv.includes(`--${name}`),
    sub: argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined,
  };
}

export async function runCli(io: CliIO): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  const err = io.err ?? ((s: string) => console.error(s));
  const root = io.root ?? DEFAULT_ROOT;
  const { get, has, sub } = parseArgs(io.argv);

  // ── init ────────────────────────────────────────────────────
  if (sub === 'init') {
    const explicit = get('config');
    const path = explicit ? resolve(io.cwd, explicit) : join(io.cwd, CONFIG_FILENAME);
    if (existsSync(path) && !has('force')) {
      err(`${C.yellow}配置已存在：${path}${C.reset}（要覆盖请加 --force）`);
      return 1;
    }
    await writeTemplateConfig(path);
    out(`${C.green}已生成配置模板：${C.reset}${path}`);
    out('');
    out('下一步：');
    out('  1. 填入你的 provider、baseUrl、模型名');
    out('  2. 用环境变量提供 API key（模板里写的是 ${DEEPSEEK_API_KEY} 这种形式）');
    out('  3. 运行：node packages/orchestrator/src/cli-run.ts --brief "你的需求"');
    out('');
    out(`${C.dim}提示：预算默认 totalTokens: 2000000 / onExceed: stop，可按需调整。${C.reset}`);
    out(
      `${C.dim}提示：roles.*.maxTokens 建议**不要设**，或设得足够大。` +
        `推理型模型会先把 max_tokens 花在不可见的推理 token 上，设小了不会报错，` +
        `只会得到「模型什么都没说」（实测：test 角色设 8192 时输出为空，连试 3 次都一样）。${C.reset}`,
    );
    return 0;
  }

  // ── 找配置 ──────────────────────────────────────────────────
  const explicitConfig = get('config');
  const candidates = [
    explicitConfig,
    join(io.cwd, CONFIG_FILENAME),
    join(root, CONFIG_FILENAME),
  ].filter((p): p is string => Boolean(p));

  const configPath = candidates.find((p) => existsSync(p));
  if (!configPath) {
    err(`${C.red}找不到 ${CONFIG_FILENAME}${C.reset}（已查找：${candidates.join('、')}）`);
    err('先运行：node packages/orchestrator/src/cli-run.ts init');
    return 1;
  }

  let config: ForgeConfig;
  try {
    config = await loadConfigFile(configPath);
  } catch (e) {
    err(`${C.red}${(e as Error).message}${C.reset}`);
    return 1;
  }

  const projectName = get('name') ?? 'agentforge-project';
  const workspace = resolve(config.workspace ?? join(root, 'workspace', projectName));
  await mkdir(workspace, { recursive: true });

  const replayRunId = get('replay');
  const runId = replayRunId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  out(`${C.bold}AgentForge${C.reset}  ${C.dim}配置：${configPath}${C.reset}`);
  out(`${C.dim}工作区：${workspace}${C.reset}`);
  out('');

  // ── 组装 LLM（或回放） ──────────────────────────────────────
  let built;
  try {
    built = await buildLlm(config, {
      root: workspace,
      runId,
      record: !replayRunId,
      probe: !replayRunId,
      onNotice: (msg, data) => out(`${C.cyan}[llm]${C.reset} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`),
    });
  } catch (e) {
    err(`${C.red}LLM 初始化失败：${(e as Error).message}${C.reset}`);
    return 1;
  }

  for (const p of built.probes) {
    const icon = p.jsonSchema === 'strict' ? '✔' : p.jsonSchema === 'json-mode' ? '△' : '○';
    const color = p.jsonSchema === 'strict' ? C.green : p.jsonSchema === 'json-mode' ? C.yellow : C.dim;
    out(
      `  ${icon} ${p.provider}/${p.model} → ${color}${p.jsonSchema}${C.reset}` +
        `${p.reachable ? '' : ` ${C.red}(不可达)${C.reset}`}`,
    );
    if (has('verbose')) for (const e of p.evidence) out(`      ${C.dim}${e}${C.reset}`);
  }
  for (const w of built.warnings) out(`  ${C.yellow}警告：${w}${C.reset}`);

  // ── 组装角色运行器 ──────────────────────────────────────────
  let providers = built.roleProviders;
  if (replayRunId) {
    const runsDir = config.runsDir ?? join(workspace, 'runs');
    let records;
    try {
      records = await loadRunRecords(runsDir, replayRunId);
    } catch (e) {
      err(`${C.red}${(e as Error).message}${C.reset}`);
      const avail = await listRuns(runsDir);
      if (avail.length > 0) {
        err('可回放的 run：');
        for (const r of avail) err(`  ${r.runId}  (${r.calls} 次调用, ${(r.bytes / 1024).toFixed(1)} KB)`);
      }
      return 1;
    }
    const replayer = new ReplayProvider({ records });
    // 显式列出五个角色，而不是 `Object.fromEntries(...) as ...`：
    // 后者会产生一个 `{[k: string]: ReplayProvider}`，与 `Record<RoleId, LlmProvider>`
    // 在类型上并不相容（索引签名 vs 必需键），只能靠断言硬压过去 ——
    // 那等于把「角色表漏了一个」这类错误推到运行时。写开了编译器就能替我们看着。
    providers = {
      pm: replayer,
      frontend: replayer,
      backend: replayer,
      test: replayer,
      host: replayer,
    };
    out('');
    out(`${C.cyan}回放模式${C.reset}：使用 ${records.length} 条已录制调用，不会发起任何真实请求。`);
    out('');
  }

  const runners = createBoundRoleRunners(providers, config.roles);
  const verifier = new SemanticVerifier({ provider: providers.test });

  // ── 被生成项目的 profile ────────────────────────────────────
  const { profile, notes } = await deriveProfile(workspace, projectName);
  for (const n of notes) out(`  ${C.yellow}注意：${n}${C.reset}`);

  const brief =
    get('brief') ?? '做一个任务看板：用户可以创建任务、列出全部任务，并支持按状态筛选。';

  const summary = await new Orchestrator({
    projectRoot: workspace,
    profile,
    userBrief: brief,
    runners,
    verifier,
    provider: providers.pm,
    humanAvailable: false,
    offline: true, // 无外网：A1 的远端核实会报 WARN 而不是伪造 PASS
    log: new DecisionLog(workspace),
    // profile 必须在代码落盘后重新推导一次。
    //
    // 启动时工作区是空的，所以 deriveProfile 会得出 typecheck=null / test=null，
    // 于是 A4（编译）与 A5（测试）全程报 SKIPPED —— 而那正是「从零生成一个项目」
    // 这条最需要锚点把关的路径。SKIPPED ≠ PASS 是对的，但「没得查」不该是常态。
    //
    // 角色一旦写出 package.json，下一次 Gate 就会拿到真实的 typecheck/test 命令，
    // A4/A5 变成真检查。这也是 P6 自举验证里那套真实工具链的前提。
    refreshProfile: (base) => deriveProfile(workspace, base.name).then((r) => ({ profile: r.profile, notes: r.notes })),
    // 日志也必须走 CLI 的输出通道，而不是直接写 console ——
    // 否则 CLI 在进程内被调用时（测试、将来被 GUI 调用）会把日志漏到标准输出外面去。
    // 默认只报 warn 以上，`--verbose` 才开 debug：日常运行的输出应当聚焦在报告本身。
    logger: new Logger(
      'run',
      (r) => {
        const line = `${C.dim}[${r.level}] ${r.scope}: ${r.message}${C.reset}`;
        if (r.level === 'error') err(line);
        else out(line);
      },
      has('verbose') ? 'debug' : 'warn',
    ),
  }).run();

  // ── 报告 ────────────────────────────────────────────────────
  out('');
  out(`${C.bold}${C.blue}${'═'.repeat(70)}${C.reset}`);
  out(`${C.bold}${C.blue}  Run 报告${C.reset}`);
  out(`${C.bold}${C.blue}${'═'.repeat(70)}${C.reset}`);
  out('');
  out(`${C.bold}需求：${C.reset}${brief}`);
  out('');

  for (const t of summary.traces) {
    const host = t.hostInvoked ? `${C.cyan}[唤醒主理人]${C.reset}` : `${C.dim}[未唤醒]${C.reset}`;
    out(`  ${t.stage.padEnd(12)} ${t.finalAction.padEnd(26)} ${host}`);
    if (t.blockedReasons.length) out(`      ${C.dim}阻断：${t.blockedReasons.join(', ')}${C.reset}`);
  }

  out('');
  out(
    `  结果：${
      summary.delivery === 'complete'
        ? `${C.green}完整交付${C.reset}`
        : summary.delivery === 'with-debt'
          ? `${C.yellow}带债交付${C.reset}`
          : summary.delivery === 'held'
            ? `${C.cyan}已被人类暂停${C.reset}`
            : `${C.yellow}等待真人裁决${C.reset}`
    }   ${C.dim}最终阶段 ${summary.finalStage}，${summary.totalCycles} 次 Gate${C.reset}`,
  );

  // ── 需求到底确认了没有（与「交付状态」是两件事）────────────────────
  //
  // 这一行存在的理由：`delivery: complete` 表达的是「流程走完 + 机械检查通过」，
  // 它**不**表达「需求达成」。实测出现过「唯一被判 complete 的那轮，
  // 恰好两条需求都判定不了」——把两件事混在一个标签里就是假绿灯。
  // 所以必须把需求状态单独、显式地打出来。
  if (summary.requirementStatuses.length > 0) {
    const by = (s: string) => summary.requirementStatuses.filter((r) => r.status === s).map((r) => r.id);
    const met = by('met');
    const unverified = by('unverified');
    const open = by('open');
    const debt = by('accepted_with_debt');
    const color = unverified.length > 0 || open.length > 0 ? C.yellow : C.green;
    out(
      `  需求验收：${color}确认达成 ${met.length}/${summary.requirementStatuses.length}${C.reset}` +
        (unverified.length ? `  ${C.yellow}确认不了：${unverified.join(', ')}${C.reset}` : '') +
        (open.length ? `  ${C.dim}未达成：${open.join(', ')}${C.reset}` : '') +
        (debt.length ? `  ${C.yellow}带债：${debt.join(', ')}${C.reset}` : ''),
    );
    if (unverified.length > 0) {
      out(
        `  ${C.yellow}注意：这 ${unverified.length} 条需求是「查过了但确认不了」，不是「还没查」。` +
          `交付状态里的「完整」只描述机械检查，不代表需求已达成。${C.reset}`,
      );
    }
  }
  const l = summary.ledger;
  out(
    `  主理人：precision ${(l.precision * 100).toFixed(0)}%  真报 ${l.truePositives}  误报 ${l.falsePositives}  不可证伪 ${l.unfalsifiable}  观察期 ${l.probation ? '是' : '否'}`,
  );
  out(`  工单 ${summary.workOrders.length} 张，技术债 ${summary.debtIds.length} 条`);

  if (built.budget) {
    const b = built.budget.snapshot();
    out(
      `  ${C.bold}成本${C.reset}：${b.totalTokens} tokens（输入 ${b.totalPromptTokens} / 输出 ${b.totalCompletionTokens}），约 $${b.totalUsd.toFixed(4)}`,
    );
    for (const [role, v] of Object.entries(b.byRole)) {
      out(`      ${C.dim}${role.padEnd(9)} ${v.calls} 次调用  ${v.tokens} tokens${C.reset}`);
    }
  }
  if (built.recorder) {
    out(`  ${C.dim}调用记录：${built.recorder.path}${C.reset}`);
    out(`  ${C.dim}离线回放：node packages/orchestrator/src/cli-run.ts --replay ${runId}${C.reset}`);
  }
  if (summary.techDebtRequirements.length > 0) {
    out(`  ${C.yellow}带债需求：${summary.techDebtRequirements.join(', ')}${C.reset}  ${C.dim}见 TECH_DEBT.md${C.reset}`);
  }
  out('');
  return 0;
}

/**
 * 从被生成项目的工作区推导 ProjectProfile。
 *
 * 刻意**不伪造**命令：工作区没有配置 typecheck/test 时，profile 里就是 null，
 * 于是 A4/A5 锚点会报 SKIPPED 而不是 PASS（A4/A5 的实现里明确规定 SKIPPED ≠ PASS）。
 * 宁可让报告里出现一片 SKIPPED，也不要给用户一个假的绿灯。
 */
export async function deriveProfile(
  workspace: string,
  name: string,
): Promise<{ profile: ProjectProfile; notes: string[] }> {
  const notes: string[] = [];
  const pkg = await readJsonOrNull<{
    scripts?: Record<string, string>;
    /**
     * 项目可以选择声明自己的约定，让锚点能真的执行、也让角色不再踩环境的坑。
     * 见 ProjectProfile.environmentNotes —— 环境约束由**项目**声明，不由引擎硬编码。
     */
    agentforge?: { healthUrl?: string; environmentNotes?: string[]; protectedFiles?: string[] };
  }>(join(workspace, 'package.json'));

  let typecheck: ProjectProfile['typecheck'] = null;
  let test: ProjectProfile['test'] = null;
  let run: ProjectProfile['run'] = null;

  if (pkg?.scripts?.typecheck) typecheck = { cmd: 'npm', args: ['run', 'typecheck'] };
  else notes.push('工作区 package.json 没有 typecheck 脚本 → A4（编译/类型）会报 SKIPPED，不会被当作通过');

  if (pkg?.scripts?.test) test = { cmd: 'npm', args: ['run', 'test'] };
  else notes.push('工作区 package.json 没有 test 脚本 → A5（测试执行）会报 SKIPPED，不会被当作通过');

  // ── 运行时（A6）──────────────────────────────────────────────
  //
  // A6 需要**两个**东西：一个能启动服务的命令，和一个能探测的 URL。
  // 第一版把 run 写死成 null，于是 A6 在真实 LLM 路径上永远是 SKIPPED ——
  // 「生成的应用到底跑不跑得起来」从来没被检查过，而 A6 本身早就实现好了（P6 验证过）。
  //
  // 命令可以从 scripts.start / scripts.dev 推出来，但 **healthUrl 推不出来**：
  // 服务监听哪个端口、健康检查路径叫什么，是项目自己的约定。
  // 编一个默认值（比如猜 3000 端口）会让 A6 时而探到别的进程、时而毫无理由地失败 ——
  // 那比诚实地报 SKIPPED 更糟糕。
  //
  // 所以只认**显式声明**：package.json 里的
  //   "agentforge": { "healthUrl": "http://127.0.0.1:8787/health" }
  // 没声明就如实报 SKIPPED，并说明缺的是哪一半。
  const startScript = pkg?.scripts?.start ?? pkg?.scripts?.dev;
  const healthUrl = pkg?.agentforge?.healthUrl;
  if (startScript && healthUrl) {
    run = { cmd: 'npm', args: [pkg?.scripts?.start ? 'start' : 'dev'], healthUrl };
  } else if (startScript) {
    notes.push(
      '工作区有启动脚本但没有声明 healthUrl → A6（运行时探针）会报 SKIPPED。' +
        '要让它真的执行，在 package.json 里加："agentforge": { "healthUrl": "http://127.0.0.1:<port>/health" }',
    );
  } else {
    notes.push('工作区没有 start/dev 脚本 → A6（运行时探针）会报 SKIPPED，不会假定它能跑起来');
  }

  return {
    profile: {
      name,
      language: 'typescript',
      srcDir: 'src',
      tsconfigPath: 'tsconfig.json',
      typecheck,
      test,
      run,
      knownPackages: ['lodash', 'express', 'react', 'zod', 'axios', 'typescript'],
      dependencyAllowlist: null,
      ...(pkg?.agentforge?.environmentNotes?.length
        ? { environmentNotes: pkg.agentforge.environmentNotes }
        : {}),
      // 项目声明的验证基准文件 → 一路带到「产出不得改写它」的强制执行与 A8 锚点，
      // 也带进角色提示词（事前的告知比事后的返工便宜）。
      ...(pkg?.agentforge?.protectedFiles?.length
        ? { protectedFiles: pkg.agentforge.protectedFiles }
        : {}),
    },
    notes,
  };
}

// 仅在作为入口被直接运行时才执行 —— 「import 即执行」会让 CLI 无法在进程内被测试。
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  runCli({ argv: process.argv.slice(2), cwd: process.cwd() })
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((e) => {
      console.error(`\n${C.red}运行失败：${(e as Error).message}${C.reset}`);
      if (process.env.AF_DEBUG) console.error((e as Error).stack);
      process.exit(1);
    });
}
