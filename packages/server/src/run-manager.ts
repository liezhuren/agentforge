/**
 * Run 管理器：把「启动一次 run / 投建议书 / 读状态」封装成服务端可调用的接口。
 *
 * 关键设计：**run 是异步跑的，不阻塞请求。**
 * 一次 run 可能持续几分钟到几小时，因此 `start()` 立刻返回 runId，
 * 之后前端通过 SSE 事件流观察进展、通过 `/api/state` 拉快照。
 *
 * 两种模式：
 *   - `demo`：离线演示。用内置 Mock 脚本（含三类预设场景），**不需要任何 API key**。
 *     这是让用户第一次就能把控制台跑起来、把机制看懂的最短路径。
 *   - `config`：真实 LLM。读取 agentforge.config.json，走完整的探测 / 预算 / 录制。
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DecisionLog, EventBus, Logger, silentLogger, type ArtifactId, type ArtifactKind, type DirectiveRecord, type ForgeEvent, type ProjectProfile } from '../../core/src/index.ts';
import { MockProvider } from '../../llm/src/index.ts';
import { buildLlm, loadConfigFile, type ForgeConfig } from '../../llm/src/index.ts';
import { BudgetTracker, type BudgetSnapshot } from '../../llm/src/budget.ts';
import type { ProbeOutcome } from '../../llm/src/probe.ts';
import { createBoundRoleRunners, createRoleRunners } from '../../roles/src/index.ts';
import { SemanticVerifier } from '../../roles/src/verify.ts';
import { Orchestrator, type RunSummary } from '../../orchestrator/src/orchestrator.ts';
import { deriveProfile } from '../../orchestrator/src/cli-run.ts';
import {
  DEMO_PROJECT_NAME,
  DEMO_SCENARIOS,
  DEMO_USER_BRIEF,
  scaffoldDemoProject,
  type DemoScenarioId,
} from '../../orchestrator/src/demo-project.ts';
import { ensureToolchain, realAppProfile, scaffoldRealApp } from '../../orchestrator/src/real-app-project.ts';
import type { DirectiveEnforcementReport } from '../../orchestrator/src/directives.ts';
import { Projection, type RunStatus, type ServerState } from './projection.ts';

export type RunMode = 'demo' | 'config';

export type StartRequest = {
  mode?: RunMode;
  brief?: string;
  projectName?: string;
  /** demo 模式的预设场景。 */
  scenario?: DemoScenarioId;
  /** config 模式使用的配置文件路径。 */
  configPath?: string;
  /** 是否清空工作区后重跑（默认 true，保证演示可复现）。 */
  fresh?: boolean;
};

export type RunRuntime = {
  runId: string;
  mode: RunMode;
  scenario?: DemoScenarioId;
  workspace: string;
  profile: ProjectProfile;
  probes: ProbeOutcome[];
  models: Record<string, string>;
  warnings: string[];
  budget: BudgetSnapshot | null;
  recorderPath: string | null;
};

export type RunManagerOptions = {
  /** 仓库根。 */
  root: string;
  /** 被生成项目的工作区根（每个项目一个子目录）。 */
  workspaceRoot?: string;
  logger?: Logger;
};

/** `/api/state` 返回给前端的完整视图。 */
export type FullState = ServerState & {
  runtime: RunRuntime | null;
  summary: RunSummary | null;
  /** 建议书执行情况：哪些被编译成强制约束、哪些只能作为角色指令。 */
  directiveEnforcement: DirectiveEnforcementReport | null;
  /** 「真·完整」判定。**由服务端派生**，前端只读不算（见下方 deriveVerdict 的说明）。 */
  verdict: DeliveryVerdict;
};

/**
 * 「这次交付到底算不算真的完成了」——**唯一的判定处**。
 *
 * ## 为什么必须派生在服务端
 *
 * 判定规则一旦有两个实现，就会在规则演进时分叉。控制台曾经自己用
 * `actions.length > 0` 判断圆桌决议是否有效，加上机械事实约束后立刻与后端不一致
 * （后端认为无效、前端仍显示「可执行」）—— 同一个教训。
 * **判定的唯一真相在服务端，前端只读不算。**
 *
 * ## 为什么是「两个维度 + 一个派生徽章」而不是单一标签
 *
 * 实测 10 轮真实运行的 38 条需求判定显示：机械层与需求层**互相独立**，
 * 四个格子都真实出现过：
 *
 *   机械❌ 需求✅   —— 机械层失败但需求全达成（llm-4 8/0/0、llm-6 2/0/0）
 *   机械✅ 需求❓   —— 机械层全过但需求确认不了（llm-9 0/2/0）
 *   机械✅ 需求✅   —— 都过（llm-10）
 *   机械❌ 需求❓   —— 都不过（其余多轮）
 *
 * 所以把两轴绑成一个标签一定是错的：
 *   - 要求「complete 必须需求全 met」→ 修好机械✅需求❓ 那一格，
 *     却会把机械❌需求✅ 变成「明明需求都达成了却报带债」；
 *   - 保持现状 → 机械✅需求❓ 那一格继续是假绿灯（控制台会声称
 *     「全部需求通过验证」，而 B1 其实说「确认不了」）。
 *
 * 正确做法：两个维度都如实报，另加这个**只在两轴都过时才亮**的徽章。
 */
export type DeliveryVerdict = {
  /** 两轴都过：机械检查全过 **且** 所有 must 需求都确认达成。 */
  fullyVerified: boolean;
  /** 机械/流程维度：直接来自 delivery，不改语义。 */
  mechanical: 'complete' | 'with-debt' | 'awaiting-human' | 'held' | 'unknown';
  /** 需求维度。 */
  requirements: 'verified' | 'unverified' | 'not-met' | 'no-requirements';
  /** 逐条状态的可读汇总，界面直接渲染，不要自己再聚合一遍。 */
  counts: { met: number; unverified: number; open: number; acceptedWithDebt: number; total: number };
  /** 人类可读的一句话结论（界面直接显示，避免各写一份措辞）。 */
  summary: string;
};

export function deriveVerdict(summary: RunSummary | null): DeliveryVerdict {
  const statuses = summary?.requirementStatuses ?? [];
  const counts = {
    met: statuses.filter((r) => r.status === 'met').length,
    unverified: statuses.filter((r) => r.status === 'unverified').length,
    open: statuses.filter((r) => r.status === 'open').length,
    acceptedWithDebt: statuses.filter((r) => r.status === 'accepted_with_debt').length,
    total: statuses.length,
  };

  const mechanical: DeliveryVerdict['mechanical'] = summary?.delivery ?? 'unknown';

  let requirements: DeliveryVerdict['requirements'];
  if (counts.total === 0) requirements = 'no-requirements';
  else if (counts.unverified > 0) requirements = 'unverified';
  else if (counts.open > 0) requirements = 'not-met';
  else requirements = 'verified';

  const fullyVerified = mechanical === 'complete' && requirements === 'verified';

  // 措辞也放在这里统一给：如果让各处自己拼，同一种状态会出现好几种说法。
  let text: string;
  if (mechanical === 'unknown') text = '尚未运行';
  else if (mechanical === 'awaiting-human') text = '等待真人裁决，本次交付未完成';
  else if (mechanical === 'held') text = '已被人类暂停';
  else if (fullyVerified) text = `全部验证通过：机械检查全过 + ${counts.met}/${counts.total} 条需求确认达成`;
  else if (mechanical === 'complete' && requirements === 'unverified') {
    text = `机械检查全过，但有 ${counts.unverified} 条需求**确认不了**（查过了，不是没查）—— 这不等于需求已达成`;
  } else if (mechanical === 'complete' && requirements === 'not-met') {
    text = `机械检查全过，但有 ${counts.open} 条需求未达成`;
  } else if (mechanical === 'complete' && requirements === 'no-requirements') {
    text = '机械检查全过，但没有需求可供核对达成情况';
  } else {
    text = `带债交付：问题被记录后继续推进（需求确认达成 ${counts.met}/${counts.total}）`;
  }

  return { fullyVerified, mechanical, requirements, counts, summary: text };
}

export type ArtifactMetaView = {
  id: ArtifactId;
  kind: ArtifactKind;
  producer: string;
  version: number;
  title: string;
  hash: string;
  at: string;
  scope?: string;
  anchorCount: number;
  anchors: string[];
};

/** 按 id 在工件库里找文件（工件按 kind 分目录存放）。 */
export async function findArtifactFile(workspace: string, id: string): Promise<string | null> {
  const dir = join(workspace, 'artifacts');
  if (!existsSync(dir)) return null;
  for (const kind of await readdir(dir)) {
    const f = join(dir, kind, `${id}.json`);
    if (existsSync(f)) return f;
  }
  return null;
}

function titleOfArtifact(a: {
  kind: string;
  content?: unknown;
  id: string;
}): string {
  const c = a.content as Record<string, unknown> | undefined;
  if (c && typeof c === 'object') {
    if (typeof c.title === 'string') return c.title;
    if (typeof c.summary === 'string') return String(c.summary).slice(0, 80);
    if (Array.isArray(c.files)) {
      const first = c.files[0] as { path?: string } | undefined;
      return `${c.files.length} 个文件 · ${first?.path ?? ''}`;
    }
    if (Array.isArray(c.requirements)) return `${c.requirements.length} 条需求`;
    if (Array.isArray(c.tasks)) return `${c.tasks.length} 个任务`;
    if (Array.isArray(c.objections)) return `${c.objections.length} 条异议`;
    if (typeof c.kind === 'string') return `建议书(${c.kind})`;
    if (typeof c.decision === 'string') return String(c.decision).slice(0, 60);
  }
  return a.kind;
}

export async function readArtifactMeta(workspace: string, id: string): Promise<ArtifactMetaView | null> {
  const f = await findArtifactFile(workspace, id);
  if (!f) return null;
  try {
    const a = JSON.parse(await readFile(f, 'utf8')) as {
      id: string;
      kind: string;
      producer: string;
      version: number;
      contentHash: string;
      createdAt: string;
      scope?: string;
      content?: unknown;
      anchorChain?: Array<{ anchorId: string; verdict: string }>;
    };
    return {
      id: a.id,
      kind: a.kind as ArtifactKind,
      producer: a.producer,
      version: a.version,
      title: titleOfArtifact(a as never),
      hash: a.contentHash ?? '',
      at: a.createdAt ?? '',
      ...(a.scope ? { scope: a.scope } : {}),
      anchorCount: a.anchorChain?.length ?? 0,
      anchors: (a.anchorChain ?? []).map((l) => `${l.anchorId}:${l.verdict}`),
    };
  } catch {
    return null;
  }
}

export async function listArtifactMetas(workspace: string): Promise<ArtifactMetaView[]> {
  const dir = join(workspace, 'artifacts');
  if (!existsSync(dir)) return [];
  const out: ArtifactMetaView[] = [];
  for (const kind of await readdir(dir)) {
    const kdir = join(dir, kind);
    let files: string[];
    try {
      files = await readdir(kdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const meta = await readArtifactMeta(workspace, f.replace(/\.json$/, ''));
      if (meta) out.push(meta);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export class RunManager {
  readonly root: string;
  readonly workspaceRoot: string;
  private logger: Logger;
  private projection = new Projection();
  private listeners = new Set<(e: ForgeEvent) => void>();
  private orchestrator: Orchestrator | null = null;
  private running: Promise<RunSummary> | null = null;
  private runtime: RunRuntime | null = null;
  private summary: RunSummary | null = null;
  /** 预算必须持有 tracker 而非快照 —— 快照是 build 时刻的，run 跑起来就不再变。 */
  private budgetTracker: BudgetTracker | null = null;

  constructor(opts: RunManagerOptions) {
    this.root = opts.root;
    this.workspaceRoot = opts.workspaceRoot ?? join(opts.root, 'workspace');
    this.logger = opts.logger ?? silentLogger('server');
  }

  onEvent(cb: (e: ForgeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: ForgeEvent): void {
    this.projection.apply(e);

    // 事件里的 artifact.published 只带 id/kind/producer —— 标题、hash、版本要查存储。
    // 这里异步补一次（不阻塞事件派发），否则界面上工件列表会全是空标题。
    if (e.t === 'artifact.published') {
      void this.enrichArtifact(e.id);
    }

    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch (err) {
        this.logger.warn(`事件订阅者抛错：${(err as Error).message}`);
      }
    }
  }

  private async enrichArtifact(id: string): Promise<void> {
    const ws = this.runtime?.workspace;
    if (!ws) return;
    const meta = await readArtifactMeta(ws, id);
    if (meta) this.projection.enrichArtifacts([meta]);
  }

  /** 从工件库读全部工件元信息（供 `/api/state` 的工件浏览器初次加载）。 */
  async artifactMetas(): Promise<ArtifactMetaView[]> {
    const ws = this.runtime?.workspace;
    if (!ws) return [];
    return listArtifactMetas(ws);
  }

  state(): FullState {
    return {
      ...this.projection.snapshot(),
      runtime: this.runtime,
      summary: this.summary,
      // 建议书的执行情况必须暴露给界面：
      // 「哪些约束真的被机械校验、哪些只是作为指令传给角色」——
      // 如果用户看不见这个区分，他会以为所有建议书都在被强制执行。
      directiveEnforcement: this.orchestrator?.directiveEnforcement ?? null,
      // 「真·完整」判定在这里派生一次，前端只读不算。
      // 理由见 deriveVerdict 的说明：判定规则有两个实现就会分叉。
      verdict: deriveVerdict(this.summary),
    };
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  get currentRuntime(): RunRuntime | null {
    return this.runtime;
  }

  /**
   * 启动一次 run。**立刻返回**，不等待 run 结束。
   *
   * 并发保护：已有 run 在跑时拒绝新的启动请求 ——
   * 两个 run 同时写同一个工件库会互相覆盖，而「谁改了谁」在工件系统里无法追溯。
   */
  async start(req: StartRequest = {}): Promise<RunRuntime> {
    if (this.running) throw new Error('已有 run 正在执行。请等待其结束，或先暂停。');

    const mode: RunMode = req.mode ?? 'demo';
    const projectName = req.projectName ?? (mode === 'demo' ? DEMO_PROJECT_NAME : 'agentforge-project');
    const brief = req.brief ?? DEMO_USER_BRIEF;
    const workspace = resolve(join(this.workspaceRoot, projectName));

    if (req.fresh !== false) await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });

    this.projection = new Projection();
    this.summary = null;

    const built = mode === 'demo' ? await this.buildDemo(workspace, req.scenario ?? 'clean') : await this.buildFromConfig(workspace, req.configPath);

    this.runtime = {
      runId: built.runId,
      mode,
      ...(mode === 'demo' ? { scenario: req.scenario ?? 'clean' } : {}),
      workspace,
      profile: built.profile,
      probes: built.probes,
      models: built.models,
      warnings: built.warnings,
      budget: built.budget,
      recorderPath: built.recorderPath,
    };

    // 用一个真实的 EventBus 接到投影上。
    // 早先版本为了避免多引入一个类，手写了一个 `as never` 的假 bus —— 那会在
    // 「编排器调用了 bus 上我没实现的第 5 个方法」时静默出错。用真类型，让编译器/运行时兜住。
    const bus = new EventBus();
    bus.on((e) => this.emit(e));

    const orch = new Orchestrator({
      projectRoot: workspace,
      profile: built.profile,
      userBrief: brief,
      runners: built.runners,
      verifier: built.verifier,
      provider: built.provider,
      humanAvailable: built.humanAvailable,
      offline: true,
      log: new DecisionLog(workspace),
      bus,
      logger: this.logger,
    });
    this.orchestrator = orch;
    this.budgetTracker = built.budgetTracker;

    this.running = orch
      .run()
      .then((summary) => {
        this.summary = summary;
        this.running = null;
        return summary;
      })
      .catch((err: Error) => {
        this.projection.fail(err.message);
        this.emit({ t: 'run.failed', message: err.message });
        this.running = null;
        throw err;
      });

    // 异步跑：不让异常变成 unhandledRejection 而崩掉服务进程
    this.running.catch((err: Error) => this.logger.error(`run 失败：${err.message}`));

    return this.runtime;
  }

  /** 等当前 run 结束（测试与 CLI 用）。 */
  async wait(): Promise<RunSummary | null> {
    if (this.running) await this.running.catch(() => {});
    return this.summary;
  }

  /**
   * 提交真人建议书。
   * 用 hold 类型即等于「暂停」—— 这就是项目里真实的暂停机制（docs/05 §2.2），
   * 编排器会在下一个阶段边界停下，而不是被强行 kill（强行 kill 会留下半写状态）。
   */
  async submitDirective(doc: {
    kind: DirectiveRecord['kind'];
    text: string;
    targetRefs?: string[];
    constraints?: string[];
    supersedes?: string[];
  }): Promise<DirectiveRecord> {
    if (!this.orchestrator) throw new Error('还没有 run，无法提交建议书');
    return this.orchestrator.submitDirective(doc);
  }

  async pause(reason: string): Promise<DirectiveRecord> {
    return this.submitDirective({ kind: 'hold', text: reason });
  }

  // ══════════════════════════════════════════════════════════════

  private async buildDemo(workspace: string, scenario: DemoScenarioId) {
    const sc = DEMO_SCENARIOS[scenario];
    if (!sc) throw new Error(`未知演示场景：${scenario}`);

    // 真实应用场景：装真实工具链，配真 tsc / 真测试 / 真运行时探针。
    // 这一条路径让 A4–A6 从「SKIPPED」变成真实检查 —— 也正是能证明整套系统有用的那条路径。
    const isRealApp = sc.kind === 'real-app';
    const profile = isRealApp ? await scaffoldRealApp(workspace) : await scaffoldDemoProject(workspace);
    let toolchainNote = '';
    if (isRealApp) {
      const tc = await ensureToolchain(workspace, {
        cacheDir: join(this.root, '.npm-cache'),
        onLog: (s) => this.logger.info(s),
      });
      toolchainNote = tc.detail ?? '';
    }

    const provider = new MockProvider({ script: sc.buildScript() });
    const runners = createRoleRunners(provider, { logger: this.logger });
    const verifier = new SemanticVerifier({ provider, logger: this.logger });

    return {
      runId: `demo-${scenario}-${Date.now().toString(36)}`,
      profile,
      runners,
      verifier,
      provider,
      probes: [] as ProbeOutcome[],
      models: Object.fromEntries(
        (['pm', 'frontend', 'backend', 'test', 'host'] as const).map((r) => [r, 'mock']),
      ) as Record<string, string>,
      warnings: [
        isRealApp
          ? `真实应用模式（${sc.title}）—— 模型输出是脚本化的，但 A4/A5/A6 是真检查` +
            `（真 tsc / 真测试 / 真启动服务探针）。${toolchainNote}`
          : `离线演示模式（场景：${sc.title}）—— 使用内置 Mock 脚本，未调用任何真实模型。`,
      ],
      budgetTracker: null,
      recorderPath: null,
      humanAvailable: sc.humanAvailable,
    };
  }

  private async buildFromConfig(workspace: string, configPath?: string) {
    const path = configPath ?? join(this.root, 'agentforge.config.json');
    if (!existsSync(path)) {
      throw new Error(
        `找不到配置文件：${path}\n先运行 node packages/orchestrator/src/cli-run.ts init 生成模板，或改用演示模式（mode: "demo"）。`,
      );
    }
    const config: ForgeConfig = await loadConfigFile(path);
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    const built = await buildLlm(config, {
      root: workspace,
      runId,
      record: true,
      probe: true,
      onNotice: (msg) => this.logger.info(msg),
    });

    const runners = createBoundRoleRunners(built.roleProviders, config.roles, { logger: this.logger });
    const verifier = new SemanticVerifier({ provider: built.roleProviders.test, logger: this.logger });

    // 工作区若已有项目（含 package.json 脚本），按其真实工具链配置锚点；
    // 没有就如实置空，让 A4/A5 报 SKIPPED 而不是伪造通过。
    const derived = await deriveProfile(workspace, 'agentforge-project');

    return {
      runId,
      profile: derived.profile,
      runners,
      verifier,
      provider: built.roleProviders.pm,
      probes: built.probes,
      models: built.roleModels as unknown as Record<string, string>,
      warnings: [...built.warnings, ...derived.notes],
      budgetTracker: built.budget,
      recorderPath: built.recorder?.path ?? null,
      humanAvailable: false,
    };
  }

  /**
   * 预算随 run 进行实时变化，因此**必须**持有 tracker 动态取快照。
   * 早先版本存的是 build 时刻的 snapshot，界面上的成本数字会一直停在初始值。
   */
  budgetNow(): BudgetSnapshot | null {
    return this.budgetTracker ? this.budgetTracker.snapshot() : null;
  }
}

export type { ServerState, RunStatus };
