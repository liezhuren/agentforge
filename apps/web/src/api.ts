/**
 * API 客户端与状态订阅。
 *
 * 设计参见 docs/05 §4：**前端只是投影，不持有真相。**
 *   - 全量快照走 `/api/state`
 *   - 增量走 `/api/events`（SSE）
 *
 * 这里刻意**不在前端重复实现一遍投影逻辑**：收到事件后按去抖重新拉一次 `/api/state`。
 * 理由是「服务端看到的」与「前端显示的」必须永远一致 ——
 * 如果前端自己再实现一套事件归并，两套规则迟早会漂移，
 * 而那种 bug 表现为「界面显示的状态和实际不符」，极难排查。
 * 事件流的原始数据仍然保留（`events`），供「事件流」视图与取证使用。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── 与服务端共享的类型（结构等价；前端不 import 引擎代码，避免把 Node 依赖带进浏览器） ──

export type RoleId = 'pm' | 'frontend' | 'backend' | 'test' | 'host';
export type StageId =
  | 'INTAKE'
  | 'PLANNING'
  | 'CONTRACTING'
  | 'BUILDING'
  | 'REVIEW'
  | 'ROUNDTABLE'
  | 'ARBITRATION'
  | 'DELIVERED';

export type AnchorVerdict = 'PASS' | 'FAIL' | 'WARN' | 'SKIPPED' | 'STALE' | 'INVALID_EVIDENCE';

export type AnchorFinding = {
  code: string;
  severity: 'fail' | 'warn';
  message: string;
  file?: string;
  line?: number;
  targetRole?: RoleId | 'UNRESOLVED';
  data?: Record<string, unknown>;
};

export type AnchorRunResult = {
  anchorId: string;
  runId: string;
  verdict: AnchorVerdict;
  findings: AnchorFinding[];
  method: string;
  authority: 'authoritative' | 'approximate' | 'none';
  at: string;
  durationMs: number;
  meta?: Record<string, unknown>;
};

export type HostLedgerSnapshot = {
  stage: StageId;
  quota: number;
  blockAttempts: number;
  truePositives: number;
  falsePositives: number;
  unfalsifiable: number;
  probation: boolean;
  probationClearStages: number;
  globalBlockAttempts: number;
  precision: number;
  stageBlockingRevoked: boolean;
};

export type EvidenceRef =
  | { kind: 'file'; path: string; startLine: number; endLine: number; expect?: string }
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'anchor'; anchorId: string; runId: string };

export type Objection = {
  id: string;
  stage: StageId;
  targetRole: RoleId | 'UNRESOLVED';
  severity: 'blocker' | 'major' | 'minor';
  claim: string;
  evidence: EvidenceRef[];
  falsifier: { kind: 'executable'; command: string; expect: string; pattern?: string } | { kind: 'question'; text: string };
  proposedFix?: string;
};

export type Arbitration = {
  objectionId: string;
  verdict: 'VALID' | 'UNFALSIFIABLE' | 'REFUTED';
  rule: string;
  reason: string;
  quotaDelta: number;
  truePositive: boolean;
  falsePositive: boolean;
  evidenceChecks: Array<{ ok: boolean; reason?: string }>;
  falsifierRun?: { command: string; exitCode: number; matched: boolean; stdout?: string; stderr?: string };
  requiresHuman?: boolean;
};

export type WorkOrder = {
  id: string;
  stage: StageId;
  to: RoleId;
  reason: { kind: string; [k: string]: unknown };
  target: string | { newKind: string; scope?: string };
  acceptance: string[];
  status: string;
};

export type StageTraceView = {
  stage: StageId;
  cycles: number;
  blockedReasons: string[];
  nextActions: string[];
  hostInvoked: boolean;
  finalAction: string;
  anchors: AnchorRunResult[];
};

export type ForgeEvent = { t: string; [k: string]: unknown };

export type BudgetSnapshot = {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalUsd: number;
  byRole: Record<string, { tokens: number; usd: number; calls: number }>;
};

export type RunRuntime = {
  runId: string;
  mode: 'demo' | 'config';
  scenario?: string;
  workspace: string;
  probes: Array<{ provider: string; model: string; jsonSchema: string; reachable: boolean; evidence: string[] }>;
  models: Record<string, string>;
  warnings: string[];
  recorderPath: string | null;
};

export type Summary = {
  runId: string;
  finalStage: StageId;
  totalCycles: number;
  ledger: HostLedgerSnapshot;
  debtIds: string[];
  workOrders: WorkOrder[];
  delivery: 'complete' | 'with-debt' | 'awaiting-human' | 'held';
  techDebtRequirements: string[];
  traces: StageTraceView[];
};

export type ArtifactRow = {
  id: string;
  kind: string;
  producer: string;
  version: number;
  title: string;
  hash: string;
  at: string;
  scope?: string;
  anchorCount: number;
  /** 形如 `A2:PASS`，由服务端从工件的锚点链里读出。 */
  anchors: string[];
};

export type RoundtableFact = {
  statementIndex: number;
  role: RoleId;
  against?: RoleId;
  claim: string;
  command: string;
  exitCode: number;
  outcome: 'sustained' | 'refuted';
  implicates: RoleId;
};

export type FullState = {
  status: 'idle' | 'running' | 'paused' | 'finished' | 'error';
  runId: string | null;
  brief: string | null;
  projectName: string | null;
  delivery: Summary['delivery'] | null;
  finalStage: StageId | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  traces: StageTraceView[];
  currentStage: StageId | null;
  ledger: HostLedgerSnapshot | null;
  artifacts: ArtifactRow[];
  lastGate: {
    stage: StageId;
    hardFailures: AnchorRunResult[];
    blocked: boolean;
    reason?: string;
    hostInvoked: boolean;
    aLayerHealthy: boolean;
    nextAction: { kind: string; [k: string]: unknown };
  } | null;
  anchors: AnchorRunResult[];
  workOrders: WorkOrder[];
  objections: Objection[];
  arbitrations: Arbitration[];
  roundtables: Array<{
    trigger: string;
    participants: RoleId[];
    resolution: unknown;
    minuteId: string | null;
    /** 决议是否通过机械校验。前端**必须直接用这个字段**，不要自己重算。 */
    resolutionValid?: boolean;
    invalidReason?: string;
    /** 当场执行的 falsifier 所确证/证伪的事实。 */
    facts?: RoundtableFact[];
    falsifiersRun?: number;
    discardedStatements?: number;
  }>;
  directives: Array<{ id: string; kind: string; text: string; constraints?: string[]; at: string }>;
  escalations: Array<{ bundleId: string }>;
  debts: Array<{ debtId: string; requirementIds: string[] }>;
  recentEvents: ForgeEvent[];
  eventCount: number;
  budget: BudgetSnapshot | null;
  runtime: RunRuntime | null;
  summary: Summary | null;
  /**
   * 离线演示场景。
   * 服务端的 `/api/state` 与 SSE 首帧共用同一个 `fullState()` 构造点，
   * 所以两处都会有它；但客户端仍然按「可能缺失」处理 —— 缺字段导致的白屏
   * 是「刷新正常、重连挂掉」这类最难查的故障（见 docs/07 §H6）。
   */
  scenarios?: Array<{ id: string; title: string; description: string; humanAvailable: boolean }>;
  /**
   * 建议书执行情况。
   * `enforced` 是被编译成机械校验规则的（违反即 FAIL），
   * `advisory` 是**无法**机械校验、只能作为指令传给角色的。
   * 这个区分必须展示给用户 —— 否则他会以为所有建议书都在被强制执行。
   */
  directiveEnforcement?: {
    enforced: Array<{ directiveId: string; raw: string; rule: string; values: string[] }>;
    advisory: Array<{ directiveId: string; raw: string; reason: string }>;
  } | null;
};

// ── HTTP ───────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  start: (req: Record<string, unknown>) => post<{ accepted: boolean }>('/api/run', req),
  directive: (req: Record<string, unknown>) => post<{ id: string }>('/api/directive', req),
  pause: (reason: string) => post<{ id: string }>('/api/pause', { reason }),
  artifact: async (id: string) => {
    const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`找不到工件 ${id}`);
    return (await res.json()) as unknown;
  },
  techDebt: async () => {
    const res = await fetch('/api/tech-debt');
    return (await res.json()) as { text: string | null; message?: string };
  },
};

// ── 状态订阅 ───────────────────────────────────────────────────────

export type ForgeConnection = {
  state: FullState | null;
  /** 原始事件流（用于「事件流」视图与取证；不用于状态归并）。 */
  events: ForgeEvent[];
  connected: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useForge(): ForgeConnection {
  const [state, setState] = useState<FullState | null>(null);
  const [events, setEvents] = useState<ForgeEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState((await res.json()) as FullState);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();

    const es = new EventSource('/api/events');
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));

    es.addEventListener('state', (e) => {
      try {
        setState(JSON.parse((e as MessageEvent).data) as FullState);
      } catch {
        /* 忽略坏帧 */
      }
    });

    es.addEventListener('forge', (e) => {
      let ev: ForgeEvent;
      try {
        ev = JSON.parse((e as MessageEvent).data) as ForgeEvent;
      } catch {
        return;
      }
      setEvents((prev) => [...prev.slice(-499), ev]);
      // 去抖后重新拉全量状态：不在前端重复实现投影逻辑（见文件头说明）
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void refresh(), 120);
    });

    // 兜底轮询：SSE 断了也能继续更新（本地工具，成本可忽略）
    const poll = window.setInterval(() => void refresh(), 4000);

    return () => {
      es.close();
      window.clearInterval(poll);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [refresh]);

  return useMemo(() => ({ state, events, connected, error, refresh }), [state, events, connected, error, refresh]);
}

// ── 展示辅助 ───────────────────────────────────────────────────────

export const ROLE_LABEL: Record<string, string> = {
  pm: '产品经理',
  frontend: '前端',
  backend: '后端',
  test: '测试',
  host: '主理人',
  orchestrator: '编排器',
  human: '真人用户',
};

export const STAGE_LABEL: Record<string, string> = {
  INTAKE: '需求录入',
  PLANNING: '规划',
  CONTRACTING: '契约',
  BUILDING: '实现',
  REVIEW: '审查',
  ROUNDTABLE: '圆桌',
  ARBITRATION: '真人裁决',
  DELIVERED: '交付',
};

export const STAGE_ORDER: StageId[] = ['INTAKE', 'PLANNING', 'CONTRACTING', 'BUILDING', 'REVIEW', 'DELIVERED'];

export const VERDICT_COLOR: Record<AnchorVerdict, string> = {
  PASS: 'ok',
  FAIL: 'bad',
  WARN: 'warn',
  SKIPPED: 'muted',
  STALE: 'stale',
  INVALID_EVIDENCE: 'stale',
};

export function describeNextAction(a: { kind: string; [k: string]: unknown }): string {
  switch (a.kind) {
    case 'RETRY_ROLE':
      return `打回 ${ROLE_LABEL[String(a.target)] ?? a.target}（${(a.orders as string[])?.length ?? 0} 张工单）`;
    case 'ROUNDTABLE':
      return `召集圆桌（${a.trigger}）`;
    case 'ADVANCE':
      return `推进到 ${STAGE_LABEL[String(a.to)] ?? a.to}`;
    case 'ARBITRATE_HUMAN':
      return '升级真人裁决';
    case 'PASS_WITH_DEBT':
      return '带债通过';
    case 'HOLD':
      return '已暂停';
    default:
      return a.kind;
  }
}
