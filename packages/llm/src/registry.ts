/**
 * 模型注册表与配置层 —— 「给用户找他期望的 LLM 的权利」的落地点。
 *
 * 用户只需要写一份 `agentforge.config.json`：
 *   - 声明若干 provider（OpenAI 兼容端点 / Ollama）
 *   - 给每个角色绑定 {provider, model, temperature, ...}
 * 不需要改一行代码。五个角色可以用五个不同的模型 ——
 * 这在本项目里是有实际意义的组合：
 *   - PM / 主理人用最强的模型（契约质量与找茬质量直接决定后续一切）
 *   - 前后端用性价比高的模型（代码量大、锚点会兜底）
 *   - 测试用长上下文模型（要读全部代码）
 *
 * 另外支持 `${ENV_VAR}` 形式引用环境变量，避免把 key 写进配置文件。
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RoleId } from '../../core/src/types.ts';
import { ROLE_IDS } from '../../core/src/types.ts';
import { BudgetedProvider, BudgetTracker, type BudgetPolicy } from './budget.ts';
import { JsonlRunRecorder, RecordingProvider } from './recorder.ts';
import { FileCapabilityCache, probeJsonSchemaMode, type ProbeOutcome } from './probe.ts';
import { OllamaProvider, type OllamaConfig } from './ollama.ts';
import { OpenAiCompatProvider, type OpenAiCompatConfig } from './openai.ts';
import type { LlmProvider } from './types.ts';

export const CONFIG_FILENAME = 'agentforge.config.json';

export type OpenAiProviderSpec = Omit<OpenAiCompatConfig, 'name' | 'fetchImpl' | 'onRetry'> & {
  kind: 'openai-compat';
};
export type OllamaProviderSpec = Omit<OllamaConfig, 'name' | 'fetchImpl'> & { kind: 'ollama' };
export type ProviderSpec = OpenAiProviderSpec | OllamaProviderSpec;

export type RoleBinding = {
  provider: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
};

export type ForgeConfig = {
  version: 1;
  defaultProvider?: string;
  providers: Record<string, ProviderSpec>;
  roles: Partial<Record<RoleId, RoleBinding>>;
  budget?: BudgetPolicy;
  probe?: { enabled?: boolean; useCache?: boolean };
  /** 工作区根目录（被生成项目的位置）。省略时用 <cwd>/workspace/<name>。 */
  workspace?: string;
  /** run 记录目录。默认 <workspace>/runs。 */
  runsDir?: string;
};

export class ConfigError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`配置有 ${problems.length} 处问题：\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * LLM 初始化期的致命错误。
 *
 * 存在的理由：能力探测发现 providers 全都不可用（key 错、baseUrl 错、模型名错、网络不通）时，
 * 继续跑下去只会得到一连串「产出失败 → 带债通过」，用户看到的是「带债交付」，
 * 而真正的原因（key 写错了）被彻底埋起来。
 * 所以这种情况必须**立刻失败并说清原因**。
 */
export class LlmSetupError extends Error {
  causes: Array<{ provider: string; kind: string; message: string }>;
  constructor(causes: LlmSetupError['causes']) {
    super(
      `所有 LLM provider 都不可用，无法开始运行：\n` +
        causes.map((c) => `  - ${c.provider}（${c.kind}）：${c.message}`).join('\n') +
        `\n\n这不是代码问题，是配置问题。请检查 API key / baseUrl / 模型名 / 网络。`,
    );
    this.name = 'LlmSetupError';
    this.causes = causes;
  }
}

/** 把 `${ENV_VAR}` 展开为环境变量值。缺失时记录问题而不是静默留空串。 */
export function expandEnv(value: string, problems: string[], label: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      problems.push(`${label} 引用了环境变量 ${name}，但它没有被设置`);
      return '';
    }
    return v;
  });
}

export function parseConfig(raw: unknown): ForgeConfig {
  const problems: string[] = [];
  if (raw === null || typeof raw !== 'object') throw new ConfigError(['配置根必须是一个 JSON 对象']);
  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) problems.push(`version 必须是 1，实际为 ${JSON.stringify(obj.version)}`);

  const rawProviders = obj.providers;
  if (rawProviders === null || typeof rawProviders !== 'object' || Array.isArray(rawProviders)) {
    throw new ConfigError(['providers 必须是一个对象，形如 { "deepseek": { "kind": "openai-compat", ... } }']);
  }

  const providers: Record<string, ProviderSpec> = {};
  for (const [name, spec] of Object.entries(rawProviders as Record<string, unknown>)) {
    if (spec === null || typeof spec !== 'object') {
      problems.push(`providers.${name} 必须是对象`);
      continue;
    }
    const s = spec as Record<string, unknown>;

    // 刻意**不在第一个问题处 continue**：配置校验的价值就在于一次把所有问题列清楚，
    // 否则用户会陷入「改一个、再报一个」的往返。
    const kind = s.kind;
    const kindOk = kind === 'openai-compat' || kind === 'ollama';
    if (!kindOk) {
      problems.push(`providers.${name}.kind 必须是 "openai-compat" 或 "ollama"，实际为 ${JSON.stringify(kind)}`);
    }
    if (typeof s.baseUrl !== 'string' || s.baseUrl.length === 0) {
      problems.push(`providers.${name}.baseUrl 必填`);
    }
    if (typeof s.defaultModel !== 'string' || s.defaultModel.length === 0) {
      problems.push(`providers.${name}.defaultModel 必填`);
    }
    if (typeof s.apiKey === 'string') {
      s.apiKey = expandEnv(s.apiKey, problems, `providers.${name}.apiKey`);
    }
    if (!kindOk) continue; // 形状都不对，不纳入可用集合

    providers[name] = { ...s, kind } as ProviderSpec;
  }

  const providerNames = Object.keys(providers);
  if (providerNames.length === 0) problems.push('至少需要配置一个 provider');

  let defaultProvider = typeof obj.defaultProvider === 'string' ? obj.defaultProvider : undefined;
  if (defaultProvider && !providers[defaultProvider]) {
    problems.push(`defaultProvider "${defaultProvider}" 未在 providers 中定义`);
    defaultProvider = undefined;
  }

  const roles: Partial<Record<RoleId, RoleBinding>> = {};
  const rawRoles = obj.roles;
  if (rawRoles !== undefined) {
    if (rawRoles === null || typeof rawRoles !== 'object' || Array.isArray(rawRoles)) {
      problems.push('roles 必须是一个对象');
    } else {
      for (const [role, b] of Object.entries(rawRoles as Record<string, unknown>)) {
        if (!ROLE_IDS.includes(role as RoleId)) {
          problems.push(`roles.${role} 不是有效角色（可用：${ROLE_IDS.join(', ')}）`);
          continue;
        }
        if (b === null || typeof b !== 'object') {
          problems.push(`roles.${role} 必须是对象`);
          continue;
        }
        const bb = b as Record<string, unknown>;
        if (typeof bb.provider !== 'string' || !providers[bb.provider]) {
          problems.push(`roles.${role}.provider 必须引用已定义的 provider，实际为 ${JSON.stringify(bb.provider)}`);
          continue;
        }
        roles[role as RoleId] = {
          provider: bb.provider,
          ...(typeof bb.model === 'string' ? { model: bb.model } : {}),
          ...(typeof bb.temperature === 'number' ? { temperature: bb.temperature } : {}),
          ...(typeof bb.maxTokens === 'number' ? { maxTokens: bb.maxTokens } : {}),
          ...(typeof bb.reasoningEffort === 'string'
            ? { reasoningEffort: bb.reasoningEffort as RoleBinding['reasoningEffort'] }
            : {}),
        };
      }
    }
  }

  // 每个角色都必须能解析到一个 provider
  for (const role of ROLE_IDS) {
    if (roles[role]) continue;
    const fallback = defaultProvider ?? providerNames[0];
    if (!fallback) problems.push(`角色 ${role} 没有可用 provider`);
    else roles[role] = { provider: fallback };
  }

  if (obj.budget !== undefined) {
    const b = obj.budget as Record<string, unknown>;
    if (b === null || typeof b !== 'object') problems.push('budget 必须是对象');
    else if (b.onExceed !== 'stop' && b.onExceed !== 'warn') {
      problems.push('budget.onExceed 必须是 "stop" 或 "warn"');
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    version: 1,
    ...(defaultProvider ? { defaultProvider } : {}),
    providers,
    roles,
    ...(obj.budget ? { budget: obj.budget as BudgetPolicy } : {}),
    ...(obj.probe ? { probe: obj.probe as { enabled?: boolean; useCache?: boolean } } : {}),
    ...(typeof obj.workspace === 'string' ? { workspace: obj.workspace } : {}),
    ...(typeof obj.runsDir === 'string' ? { runsDir: obj.runsDir } : {}),
  };
}

/**
 * 读取配置文件。
 *
 * 注意这里**必须剥掉 UTF-8 BOM**：Windows 上用 PowerShell 的 `Out-File` / `Set-Content -Encoding utf8`、
 * 记事本、以及不少编辑器保存的 JSON 都会带 BOM（`EF BB BF`），
 * 而 `JSON.parse` 遇到开头的 `\uFEFF` 会直接报
 * 「Unexpected token '', "..." is not valid JSON」——
 * 报错信息完全看不出真正原因是 BOM，用户极难自查。
 * 这不是理论问题：本项目的测试环境第一次用 PowerShell 写配置就踩到了。
 */
export async function loadConfigFile(path: string): Promise<ForgeConfig> {
  if (!existsSync(path)) throw new ConfigError([`找不到配置文件：${path}`]);
  let raw: unknown;
  try {
    const text = stripBom(await readFile(path, 'utf8'));
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`配置文件不是合法 JSON：${(e as Error).message}`]);
  }
  return parseConfig(raw);
}

/** 剥掉 UTF-8 BOM。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function findConfigFile(from: string): string | null {
  const p = join(from, CONFIG_FILENAME);
  return existsSync(p) ? p : null;
}

// ════════════════════════════════════════════════════════════════
// 构建
// ════════════════════════════════════════════════════════════════

export type BuildLlmOptions = {
  /** 工作区根目录（配置解析结果、能力缓存、run 记录都落在这里）。 */
  root: string;
  /** run 标识；提供时会录制调用。 */
  runId?: string;
  /** 是否录制 LLM 调用。默认在提供 runId 时开启。 */
  record?: boolean;
  /** 是否做能力探测。默认开启。 */
  probe?: boolean;
  /** 控制台/日志回调。 */
  onNotice?: (msg: string, data?: unknown) => void;
};

export type BuiltLlm = {
  config: ForgeConfig;
  /** 未包装的原始 provider。 */
  raw: Map<string, LlmProvider>;
  /** 每个角色解析后的 provider（已含预算与录制包装）。 */
  roleProviders: Record<RoleId, LlmProvider>;
  /** 每个角色实际使用的模型名（便于在 UI 上展示「这次 run 用的是哪个模型」）。 */
  roleModels: Record<RoleId, string>;
  probes: ProbeOutcome[];
  budget: BudgetTracker | null;
  warnings: string[];
  recorder: JsonlRunRecorder | null;
};

export function makeProvider(name: string, spec: ProviderSpec): LlmProvider {
  if (spec.kind === 'ollama') {
    const { kind: _k, ...rest } = spec;
    return new OllamaProvider({ name, ...rest });
  }
  const { kind: _k, ...rest } = spec;
  return new OpenAiCompatProvider({ name, ...rest });
}

/**
 * 按配置构建整套 LLM。
 *
 * 顺序很讲究：
 *   原始 provider → 能力探测（写回 jsonMode）→ 预算包装 → 录制包装
 * 探测必须在预算包装**之前**，否则探测的 token 会被算进角色预算；
 * 录制必须在最外层，这样记录下来的 usage 才是真实发生的用量。
 */
export async function buildLlm(config: ForgeConfig, opts: BuildLlmOptions): Promise<BuiltLlm> {
  const warnings: string[] = [];
  const raw = new Map<string, LlmProvider>();
  for (const [name, spec] of Object.entries(config.providers)) {
    raw.set(name, makeProvider(name, spec));
  }

  // ── 能力探测：每个实际被用到的 (provider, model) 组合探一次 ──
  const probes: ProbeOutcome[] = [];
  const probeEnabled = opts.probe !== false && config.probe?.enabled !== false;
  if (probeEnabled) {
    const cache = config.probe?.useCache === false ? undefined : new FileCapabilityCache(opts.root);
    const seen = new Set<string>();
    for (const role of ROLE_IDS) {
      const b = config.roles[role]!;
      const p = raw.get(b.provider);
      if (!(p instanceof OpenAiCompatProvider)) continue;
      const model = b.model ?? p.config.defaultModel;
      const key = `${b.provider}|${model}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const outcome = await probeJsonSchemaMode(p, {
        ...(cache ? { cache } : {}),
        ...(opts.onNotice ? { logger: opts.onNotice } : {}),
      });
      // 探测的是 defaultModel；如果角色指定了别的 model，要把结论应用到那个 model 上
      if (model !== p.config.defaultModel) {
        outcome.model = model;
        outcome.evidence.push(
          `注意：探测实际使用的是 provider 的 defaultModel(${p.config.defaultModel})。` +
            `角色 ${role} 绑定的是 ${model}，两者能力可能不同 —— 如需精确探测请把 model 设为 defaultModel 或单独配置一个 provider。`,
        );
      }
      probes.push(outcome);
      if (!outcome.reachable) {
        warnings.push(
          outcome.fatal
            ? `provider "${b.provider}"（${outcome.fatal.kind}）：${outcome.fatal.message}`
            : `provider "${b.provider}" 不可达（角色 ${role} 会失败）。证据：${outcome.evidence[0] ?? '-'}`,
        );
      } else if (!outcome.conclusive) {
        warnings.push(
          `provider "${b.provider}" 的能力探测无结论（角色 ${role}）：${outcome.evidence[outcome.evidence.length - 1] ?? '-'}`,
        );
      }
    }

    // 全都不可用 → 立刻失败，而不是跑出一堆「产出失败 → 带债通过」把真实原因埋掉
    const fatalProbes = probes.filter((p) => p.fatal);
    if (probes.length > 0 && fatalProbes.length === probes.length) {
      throw new LlmSetupError(
        fatalProbes.map((p) => ({
          provider: p.provider,
          kind: p.fatal!.kind,
          message: p.fatal!.message,
        })),
      );
    }
  } else {
    warnings.push('能力探测已关闭：本次假定所有端点都支持严格结构化输出。若端点实际不支持，会遇到 400 错误。');
  }

  // ── 预算 ────────────────────────────────────────────────────
  const budget = config.budget ? new BudgetTracker(config.budget) : null;

  // ── 录制 ────────────────────────────────────────────────────
  const shouldRecord = opts.record ?? opts.runId !== undefined;
  const recorder =
    shouldRecord && opts.runId
      ? new JsonlRunRecorder(config.runsDir ?? join(opts.root, 'runs'), opts.runId)
      : null;

  // ── 按角色组装 ──────────────────────────────────────────────
  const roleProviders = {} as Record<RoleId, LlmProvider>;
  const roleModels = {} as Record<RoleId, string>;

  for (const role of ROLE_IDS) {
    const b = config.roles[role]!;
    const base = raw.get(b.provider)!;
    const spec = config.providers[b.provider];

    let p: LlmProvider = base;
    if (budget) {
      p = new BudgetedProvider({
        inner: p,
        tracker: budget,
        role,
        ...(spec.kind === 'openai-compat' && spec.pricing ? { pricing: spec.pricing } : {}),
        onExceeded: (reason, snap) =>
          opts.onNotice?.(`预算超限（${role}）：${reason}`, { totalTokens: snap.totalTokens, totalUsd: snap.totalUsd }),
      });
    }
    if (recorder) p = new RecordingProvider({ inner: p, recorder });

    roleProviders[role] = p;
    roleModels[role] = b.model ?? (spec as { defaultModel: string }).defaultModel;
  }

  return { config, raw, roleProviders, roleModels, probes, budget, warnings, recorder };
}

/** 一份可直接写给用户的配置模板。 */
export function templateConfig(): ForgeConfig & Record<string, unknown> {
  return {
    version: 1,
    defaultProvider: 'deepseek',
    providers: {
      deepseek: {
        kind: 'openai-compat',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '${DEEPSEEK_API_KEY}',
        defaultModel: 'deepseek-chat',
        jsonMode: 'auto',
        pricing: { input: 0.27, output: 1.1 },
      },
      ollama: {
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        defaultModel: 'qwen2.5:14b',
      },
    },
    roles: {
      // 审查类的角色值得用最强的模型：主理人的找茬质量与 PM 的契约质量决定后续一切
      pm: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.3 },
      host: { provider: 'deepseek', model: 'deepseek-reasoner', temperature: 0.1 },
      // 实现类角色代码量大，用性价比高的模型，锚点会兜底
      frontend: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2 },
      backend: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2 },
      // 测试要读全部代码，上下文最大。
      //
      // 刻意**不设 maxTokens** —— 这是踩过坑之后的决定（docs/07 §L1）：
      // 推理型模型会先把 max_tokens 花在不可见的推理 token 上，
      // 设小了不会报错，只会得到「模型什么都没说」。
      // 实测 test 角色设 8192 时，输出被推理吃光、可见内容为零，连试 3 次都一样。
      // 不设则用服务端默认值，留足余量。
      test: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2 },
    },
    budget: { totalTokens: 2_000_000, onExceed: 'stop' },
    probe: { enabled: true, useCache: true },
  };
}

export async function writeTemplateConfig(path: string): Promise<void> {
  await writeFile(path, JSON.stringify(templateConfig(), null, 2) + '\n', 'utf8');
}
