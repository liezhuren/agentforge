/**
 * 事件 → 状态的投影（projection）。
 *
 * 设计依据 docs/05 §4：**前端只是投影，不持有真相。**
 * 服务端把 `ForgeEvent` 序列化给前端，前端据此重建视图；
 * 服务端自己也用同一个投影来回答 `/api/state`，
 * 于是「前端看到的」与「服务端认为的」不可能不一致 —— 它们跑的是同一套规则。
 *
 * 这么做还有一个实际好处：投影是**纯函数式的**（吃事件、吐状态），
 * 因此它可以离线重放任意一次 run 的事件流来复现当时的界面。
 */

import type {
  Arbitration,
  AnchorRunResult,
  ArtifactId,
  ArtifactKind,
  DirectiveRecord,
  ForgeEvent,
  GateResult,
  HostLedgerSnapshot,
  Objection,
  RoleId,
  RoundtableFact,
  RunDelivery,
  StageId,
  WorkOrder,
} from '../../core/src/types.ts';

export type RunStatus = 'idle' | 'running' | 'paused' | 'finished' | 'error';

export type StageTraceView = {
  stage: StageId;
  cycles: number;
  blockedReasons: string[];
  nextActions: string[];
  hostInvoked: boolean;
  finalAction: string;
  /** 该阶段跑过的锚点（按锚点 ID 归并，只保留最新一次）。 */
  anchors: AnchorRunResult[];
};

export type ServerState = {
  status: RunStatus;
  runId: string | null;
  brief: string | null;
  projectName: string | null;
  delivery: RunDelivery | null;
  finalStage: StageId | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;

  traces: StageTraceView[];
  currentStage: StageId | null;
  ledger: HostLedgerSnapshot | null;
  /** 最新一次 Gate 的完整结果（含 hardFailures / nextAction / 归因）。 */
  lastGate: GateResult | null;

  artifacts: Array<{ id: ArtifactId; kind: ArtifactKind; producer: string; version: number; title: string; hash: string; at: string }>;
  anchors: AnchorRunResult[];
  workOrders: WorkOrder[];
  objections: Objection[];
  arbitrations: Arbitration[];
  roundtables: Array<{
    trigger: string;
    participants: RoleId[];
    resolution: unknown;
    minuteId: ArtifactId | null;
    /** 决议是否通过机械校验（false ⇒ 已升级真人）。 */
    resolutionValid?: boolean;
    invalidReason?: string;
    /** 当场执行的 falsifier 所确证/证伪的事实 —— 圆桌最有价值的信息。 */
    facts?: RoundtableFact[];
    falsifiersRun?: number;
    discardedStatements?: number;
  }>;
  directives: DirectiveRecord[];
  escalations: Array<{ bundleId: string }>;
  debts: Array<{ debtId: ArtifactId; requirementIds: string[] }>;

  /** 最近的事件（有上限），供「事件流」视图与回放使用。 */
  recentEvents: ForgeEvent[];
  eventCount: number;
};

export function emptyState(): ServerState {
  return {
    status: 'idle',
    runId: null,
    brief: null,
    projectName: null,
    delivery: null,
    finalStage: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    traces: [],
    currentStage: null,
    ledger: null,
    lastGate: null,
    artifacts: [],
    anchors: [],
    workOrders: [],
    objections: [],
    arbitrations: [],
    roundtables: [],
    directives: [],
    escalations: [],
    debts: [],
    recentEvents: [],
    eventCount: 0,
  };
}

const MAX_RECENT_EVENTS = 400;

export class Projection {
  private s: ServerState = emptyState();
  private anchorIndex = new Map<string, AnchorRunResult>();

  apply(e: ForgeEvent): void {
    this.s.eventCount++;
    this.s.recentEvents.push(e);
    if (this.s.recentEvents.length > MAX_RECENT_EVENTS) {
      this.s.recentEvents.splice(0, this.s.recentEvents.length - MAX_RECENT_EVENTS);
    }

    switch (e.t) {
      case 'run.started':
        this.s = { ...emptyState(), status: 'running', runId: e.runId, brief: e.brief, projectName: e.projectName, startedAt: new Date().toISOString() };
        this.anchorIndex.clear();
        this.s.recentEvents.push(e);
        this.s.eventCount = 1;
        break;

      case 'stage.enter':
        this.s.currentStage = e.stage;
        if (!this.s.traces.some((t) => t.stage === e.stage)) {
          this.s.traces.push({
            stage: e.stage,
            cycles: 0,
            blockedReasons: [],
            nextActions: [],
            hostInvoked: false,
            finalAction: '',
            anchors: [],
          });
        }
        break;

      case 'artifact.published':
        if (!this.s.artifacts.some((a) => a.id === e.id)) {
          this.s.artifacts.push({
            id: e.id,
            kind: e.kind,
            producer: e.producer,
            version: 1,
            title: '',
            hash: '',
            at: new Date().toISOString(),
          });
        }
        break;

      case 'anchor.ran': {
        this.anchorIndex.set(e.result.anchorId, e.result);
        this.s.anchors = [...this.anchorIndex.values()];
        const trace = this.s.traces[this.s.traces.length - 1];
        if (trace) {
          trace.anchors = trace.anchors.filter((a) => a.anchorId !== e.result.anchorId).concat(e.result);
        }
        break;
      }

      case 'objection.raised':
        this.s.objections.push(e.objection);
        break;

      case 'objection.arbitrated':
        this.s.arbitrations.push(e.arbitration);
        break;

      case 'ledger.updated':
        this.s.ledger = e.ledger;
        break;

      case 'workorder.created':
        if (!this.s.workOrders.some((w) => w.id === e.order.id)) this.s.workOrders.push(e.order);
        break;

      case 'roundtable.opened':
        this.s.roundtables.push({
          trigger: e.trigger,
          participants: e.participants,
          resolution: null,
          minuteId: null,
        });
        break;

      case 'roundtable.closed': {
        const rt = [...this.s.roundtables].reverse().find((r) => r.minuteId === null);
        if (rt) {
          rt.resolution = e.resolution;
          rt.minuteId = e.minuteId;
          rt.resolutionValid = e.resolutionValid;
          if (e.invalidReason) rt.invalidReason = e.invalidReason;
          rt.facts = e.facts;
          rt.falsifiersRun = e.falsifiersRun;
          rt.discardedStatements = e.discardedStatements;
        }
        break;
      }

      case 'escalation.human':
        this.s.escalations.push({ bundleId: e.bundleId });
        this.s.status = 'paused';
        break;

      case 'debt.recorded':
        this.s.debts.push({ debtId: e.debtId, requirementIds: e.requirementIds });
        break;

      case 'directive.received':
        this.s.directives.push(e.directive);
        if (e.directive.kind === 'hold') this.s.status = 'paused';
        break;

      case 'gate.evaluated': {
        this.s.lastGate = e.result;
        this.s.ledger = e.result.ledger;
        const trace = this.s.traces[this.s.traces.length - 1];
        if (trace) {
          trace.cycles++;
          if (e.result.reason) trace.blockedReasons.push(e.result.reason);
          trace.nextActions.push(describeAction(e.result.nextAction));
          trace.hostInvoked = trace.hostInvoked || e.result.hostInvoked;
          trace.finalAction = describeAction(e.result.nextAction);
        }
        break;
      }

      case 'run.paused':
        this.s.status = 'paused';
        break;

      case 'run.resumed':
        this.s.status = 'running';
        break;

      case 'run.failed':
        this.s.status = 'error';
        this.s.errorMessage = e.message;
        break;

      case 'run.finished':
        this.s.status = 'finished';
        this.s.finalStage = e.stage;
        this.s.delivery = e.delivery;
        this.s.currentStage = e.stage;
        this.s.finishedAt = new Date().toISOString();
        break;
    }
  }

  /** 由服务端在 run 抛异常时直接置位（异常不经过事件总线）。 */
  fail(message: string): void {
    this.s.status = 'error';
    this.s.errorMessage = message;
  }

  setStatus(status: RunStatus): void {
    this.s.status = status;
  }

  /** 补全工件的展示信息（投影只从事件拿到 id/kind/producer，标题与 hash 要查存储）。 */
  enrichArtifacts(items: Array<{ id: ArtifactId; kind: ArtifactKind; producer: string; version: number; title: string; hash: string; at: string }>): void {
    const byId = new Map(items.map((i) => [i.id, i]));
    this.s.artifacts = this.s.artifacts.map((a) => byId.get(a.id) ?? a);
  }

  snapshot(): ServerState {
    // 返回深拷贝，避免调用方意外改动内部状态
    return JSON.parse(JSON.stringify(this.s)) as ServerState;
  }
}

export function describeAction(a: GateResult['nextAction']): string {
  switch (a.kind) {
    case 'RETRY_ROLE':
      return `RETRY_ROLE(${a.target},${a.orders.length}张工单)`;
    case 'ROUNDTABLE':
      return `ROUNDTABLE(${a.trigger})`;
    case 'ADVANCE':
      return `ADVANCE(${a.to})`;
    case 'ARBITRATE_HUMAN':
      return 'ARBITRATE_HUMAN';
    case 'PASS_WITH_DEBT':
      return 'PASS_WITH_DEBT';
    case 'HOLD':
      return 'HOLD';
  }
}
