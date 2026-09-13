/**
 * 成本预算。
 *
 * 多智能体编排的特点是**调用次数多、单次不贵**：一次 run 可能有几十到上百次调用，
 * 而每次都要重跑锚点、可能要重试、还可能有圆桌。没有预算控制，
 * 一次跑飞的成本是「线性增长 + 重试放大」。
 *
 * 这里提供两个层次：
 *   1. `BudgetTracker` —— 记账与判定（纯逻辑，可单测）
 *   2. `BudgetedProvider` —— 包装任意 Provider，在调用前后自动检查与记账
 *
 * 超限行为由 `onExceed` 决定：
 *   - 'stop'：抛 `BudgetExceededError`，由编排器走逃生层（暂停/升级真人）
 *   - 'warn'：只警告一次，继续跑（适合观察期）
 *
 * 刻意**不做**「自动偷偷换成便宜模型」这种降级 —— 那会让「这次 run 用的到底是什么模型」
 * 变得不可追溯，而可追溯性是这个项目的基本要求。
 */

import type { RoleId } from '../../core/src/types.ts';
import type { LlmProvider, LlmRequest, LlmResponse, LlmCapabilities } from './types.ts';

/** 美元 / 百万 token。 */
export type Pricing = { input: number; output: number };

export type BudgetPolicy = {
  totalTokens?: number;
  totalUsd?: number;
  perRoleTokens?: Partial<Record<RoleId, number>>;
  perRoleUsd?: Partial<Record<RoleId, number>>;
  onExceed: 'stop' | 'warn';
};

export type ChargeEntry = {
  role: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  at: string;
};

export type BudgetSnapshot = {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalUsd: number;
  byRole: Record<string, { tokens: number; usd: number; calls: number }>;
  exceeded: boolean;
  exceedReason?: string;
};

export class BudgetExceededError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`LLM 预算超限：${reason}`);
    this.name = 'BudgetExceededError';
    this.reason = reason;
  }
}

export function usdFor(usage: { promptTokens: number; completionTokens: number }, pricing?: Pricing): number {
  if (!pricing) return 0;
  return (usage.promptTokens / 1_000_000) * pricing.input + (usage.completionTokens / 1_000_000) * pricing.output;
}

export class BudgetTracker {
  readonly policy: BudgetPolicy;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalUsd = 0;
  private byRole = new Map<string, { tokens: number; usd: number; calls: number }>();
  readonly ledger: ChargeEntry[] = [];
  private warned = false;

  constructor(policy: BudgetPolicy) {
    this.policy = policy;
  }

  charge(args: {
    role: string;
    model: string;
    usage: { promptTokens: number; completionTokens: number };
    pricing?: Pricing;
  }): ChargeEntry {
    const usd = usdFor(args.usage, args.pricing);
    const tokens = args.usage.promptTokens + args.usage.completionTokens;

    this.totalPromptTokens += args.usage.promptTokens;
    this.totalCompletionTokens += args.usage.completionTokens;
    this.totalUsd += usd;

    const cur = this.byRole.get(args.role) ?? { tokens: 0, usd: 0, calls: 0 };
    this.byRole.set(args.role, { tokens: cur.tokens + tokens, usd: cur.usd + usd, calls: cur.calls + 1 });

    const entry: ChargeEntry = {
      role: args.role,
      model: args.model,
      promptTokens: args.usage.promptTokens,
      completionTokens: args.usage.completionTokens,
      usd,
      at: new Date().toISOString(),
    };
    this.ledger.push(entry);
    return entry;
  }

  /** 调用前的判定。返回 null 表示可以继续。 */
  check(role?: string): string | null {
    const p = this.policy;
    if (p.totalTokens !== undefined && this.totalPromptTokens + this.totalCompletionTokens >= p.totalTokens) {
      return `全局 token 用量 ${this.totalPromptTokens + this.totalCompletionTokens} 已达上限 ${p.totalTokens}`;
    }
    if (p.totalUsd !== undefined && this.totalUsd >= p.totalUsd) {
      return `全局花费 $${this.totalUsd.toFixed(4)} 已达上限 $${p.totalUsd}`;
    }
    if (role) {
      const r = this.byRole.get(role);
      const used = r?.tokens ?? 0;
      const limit = p.perRoleTokens?.[role as RoleId];
      if (limit !== undefined && used >= limit) return `角色 ${role} token 用量 ${used} 已达上限 ${limit}`;
      const usdLimit = p.perRoleUsd?.[role as RoleId];
      if (usdLimit !== undefined && (r?.usd ?? 0) >= usdLimit) {
        return `角色 ${role} 花费 $${(r?.usd ?? 0).toFixed(4)} 已达上限 $${usdLimit}`;
      }
    }
    return null;
  }

  /** 超限且策略为 warn 时只警告一次，避免刷屏。 */
  shouldWarnOnce(): boolean {
    if (this.policy.onExceed !== 'warn' || this.warned) return false;
    this.warned = true;
    return true;
  }

  snapshot(): BudgetSnapshot {
    const reason = this.check() ?? undefined;
    return {
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
      totalUsd: this.totalUsd,
      byRole: Object.fromEntries(this.byRole),
      exceeded: reason !== undefined,
      ...(reason ? { exceedReason: reason } : {}),
    };
  }
}

export type BudgetedProviderOptions = {
  inner: LlmProvider;
  tracker: BudgetTracker;
  /** 该 provider 服务的角色（用于按角色限额）。 */
  role?: RoleId;
  pricing?: Pricing;
  onExceeded?: (reason: string, snapshot: BudgetSnapshot) => void;
};

export class BudgetedProvider implements LlmProvider {
  readonly name: string;
  private inner: LlmProvider;
  private tracker: BudgetTracker;
  private role?: RoleId;
  private pricing?: Pricing;
  private onExceeded?: (reason: string, snapshot: BudgetSnapshot) => void;

  constructor(opts: BudgetedProviderOptions) {
    this.inner = opts.inner;
    this.name = `${opts.inner.name}(budgeted)`;
    this.tracker = opts.tracker;
    this.role = opts.role;
    this.pricing = opts.pricing;
    this.onExceeded = opts.onExceeded;
  }

  capabilities(): Promise<LlmCapabilities> {
    return this.inner.capabilities();
  }

  get snapshot(): BudgetSnapshot {
    return this.tracker.snapshot();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const roleKey = this.role ?? (req.role === 'system' ? undefined : (req.role as RoleId));
    const reason = this.tracker.check(roleKey);
    if (reason) {
      if (this.tracker.policy.onExceed === 'stop') {
        this.onExceeded?.(reason, this.tracker.snapshot());
        throw new BudgetExceededError(reason);
      }
      if (this.tracker.shouldWarnOnce()) {
        this.onExceeded?.(reason, this.tracker.snapshot());
      }
    }

    const res = await this.inner.complete(req);
    this.tracker.charge({
      role: roleKey ?? 'system',
      model: res.model,
      usage: res.usage ?? { promptTokens: 0, completionTokens: 0 },
      ...(this.pricing ? { pricing: this.pricing } : {}),
    });
    return res;
  }
}
