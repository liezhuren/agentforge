import { useEffect, useState } from 'react';
import { api, ROLE_LABEL, type FullState } from '../api.ts';

const KIND_LABEL: Record<string, string> = {
  Requirement: '需求',
  PRD: 'PRD',
  TaskGraph: '任务图',
  Contract: '契约（已冻结）',
  CodeModule: '代码模块',
  TestSuite: '测试套件',
  TestReport: '测试报告',
  AnchoredReview: '主理人审查包',
  RoundtableMinute: '圆桌纪要',
  Directive: '真人建议书',
  DebtRecord: '技术债记录',
};

export function Artifacts({ state }: { state: FullState }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    void api
      .artifact(selected)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setDetail({ error: e.message }));
    return () => {
      alive = false;
    };
  }, [selected]);

  const kinds = [...new Set(state.artifacts.map((a) => a.kind))];
  const shown = filter === 'all' ? state.artifacts : state.artifacts.filter((a) => a.kind === filter);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>工件</h2>
        <span className="muted small">
          角色之间没有对话通道，只有这些类型化工件 —— schema 校验失败就等于通信失败
        </span>
      </header>

      <div className="kind-row">
        <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
          全部 ({state.artifacts.length})
        </button>
        {kinds.map((k) => (
          <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
            {KIND_LABEL[k] ?? k} ({state.artifacts.filter((a) => a.kind === k).length})
          </button>
        ))}
      </div>

      <div className="artifacts-layout">
        <table className="wide artifacts">
          <thead>
            <tr>
              <th>ID</th>
              <th>类型</th>
              <th>产出者</th>
              <th>版本</th>
              <th>内容</th>
              <th>锚点</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="muted small">
                  还没有工件。先启动一次 run。
                </td>
              </tr>
            )}
            {shown.map((a) => (
              <tr key={a.id} className={selected === a.id ? 'selected' : ''} onClick={() => setSelected(a.id)}>
                <td>
                  <code>{a.id}</code>
                </td>
                <td>{KIND_LABEL[a.kind] ?? a.kind}</td>
                <td>{ROLE_LABEL[a.producer] ?? a.producer}</td>
                <td>v{a.version}</td>
                <td className="title-cell">{a.title || '—'}</td>
                <td>
                  {a.anchors?.length > 0 ? (
                    <span className="muted small">{a.anchors.join(' ')}</span>
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {selected && (
          <div className="artifact-detail">
            <div className="row">
              <b>{selected}</b>
              <button className="chip" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>
            <pre>{JSON.stringify(detail, null, 2)}</pre>
          </div>
        )}
      </div>
    </section>
  );
}

export function Events({ state, events }: { state: FullState; events: Array<{ t: string; [k: string]: unknown }> }) {
  const shown = events.length > 0 ? events : state.recentEvents;
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>事件流</h2>
        <span className="muted small">
          前端只是投影，不持有真相：刷新或重连都不会丢状态（共 {state.eventCount} 条事件）
        </span>
      </header>
      <div className="events">
        {shown.length === 0 && <div className="muted small">还没有事件</div>}
        {[...shown].reverse().map((e, i) => (
          <div key={i} className={`event ev-${e.t.split('.')[0]}`}>
            <code className="ev-name">{e.t}</code>
            <span className="ev-body">{summarizeEvent(e)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function summarizeEvent(e: { t: string; [k: string]: unknown }): string {
  switch (e.t) {
    case 'run.started':
      return `需求：${String(e.brief)}`;
    case 'stage.enter':
      return String(e.stage);
    case 'artifact.published':
      return `${String(e.id)} (${String(e.kind)}) by ${ROLE_LABEL[String(e.producer)] ?? e.producer}`;
    case 'anchor.ran': {
      const r = e.result as { anchorId: string; verdict: string; findings: unknown[]; method: string };
      return `${r.anchorId} → ${r.verdict}（${r.findings.length} 条发现，方法：${r.method}）`;
    }
    case 'objection.arbitrated': {
      const a = e.arbitration as { objectionId: string; verdict: string; rule: string; reason: string };
      return `${a.objectionId} → ${a.verdict} [${a.rule}] ${a.reason}`;
    }
    case 'ledger.updated': {
      const l = e.ledger as { precision: number; truePositives: number; falsePositives: number; probation: boolean };
      return `precision ${(l.precision * 100).toFixed(0)}% · tp ${l.truePositives} · fp ${l.falsePositives} · 观察期 ${l.probation ? '是' : '否'}`;
    }
    case 'gate.evaluated': {
      const r = e.result as { stage: string; blocked: boolean; reason?: string; hostInvoked: boolean; nextAction: { kind: string } };
      return `${r.stage} ${r.blocked ? `阻断(${r.reason})` : '放行'} · 主理人${r.hostInvoked ? '已唤醒' : '未唤醒'} → ${r.nextAction.kind}`;
    }
    case 'roundtable.closed': {
      const r = e.resolution as { actions?: unknown[] } | null;
      return r ? `决议${Array.isArray(r.actions) && r.actions.length > 0 ? '可执行' : '被判无效（和稀泥）'}` : '未产出决议';
    }
    case 'escalation.human':
      return `升级真人：${String(e.bundleId)}`;
    case 'debt.recorded':
      return `${String(e.debtId)} · 受影响需求 ${(e.requirementIds as string[]).join('、') || '无'}`;
    case 'directive.received': {
      const d = e.directive as { kind: string; text: string };
      return `[${d.kind}] ${d.text}`;
    }
    case 'run.finished':
      return `最终阶段 ${String(e.stage)} · 交付 ${String(e.delivery)} · 技术债 ${String(e.techDebt)}`;
    case 'workorder.created': {
      const w = e.order as { id: string; to: string; reason: { kind: string } };
      return `${w.id} → ${ROLE_LABEL[w.to] ?? w.to}（${w.reason.kind}）`;
    }
    default:
      return JSON.stringify(e).slice(0, 160);
  }
}
