import { useState } from 'react';
import { api, useForge, type FullState, type StageId } from './api.ts';
import { Pipeline, StageDetail } from './panels/Pipeline.tsx';
import { Ledger } from './panels/Ledger.tsx';
import { HumanPanel } from './panels/Human.tsx';
import { Review } from './panels/Review.tsx';
import { Artifacts, Events } from './panels/Artifacts.tsx';

export default function App() {
  const { state, events, connected, error, refresh } = useForge();
  const [selectedStage, setSelectedStage] = useState<StageId | null>(null);
  const [tab, setTab] = useState<'stage' | 'review' | 'artifacts' | 'events'>('stage');

  if (!state) {
    return (
      <div className="boot">
        <h1>AgentForge 控制台</h1>
        <p className="muted">正在连接服务端…</p>
        {error && <p className="bad">{error}</p>}
      </div>
    );
  }

  return (
    <div className="app">
      <Header state={state} connected={connected} onDone={refresh} />

      {state.errorMessage && <div className="notice bad">run 失败：{state.errorMessage}</div>}

      <div className="layout">
        <div className="col-left">
          <Pipeline state={state} selectedStage={selectedStage} onSelectStage={setSelectedStage} />
          <Ledger state={state} />
        </div>

        <div className="col-main">
          <nav className="tabs main-tabs">
            <button className={`chip ${tab === 'stage' ? 'on' : ''}`} onClick={() => setTab('stage')}>
              阶段详情
            </button>
            <button className={`chip ${tab === 'review' ? 'on' : ''}`} onClick={() => setTab('review')}>
              审查
            </button>
            <button className={`chip ${tab === 'artifacts' ? 'on' : ''}`} onClick={() => setTab('artifacts')}>
              工件 ({state.artifacts.length})
            </button>
            <button className={`chip ${tab === 'events' ? 'on' : ''}`} onClick={() => setTab('events')}>
              事件流 ({state.eventCount})
            </button>
          </nav>

          {tab === 'stage' && (
            <section className="panel">
              <header className="panel-head">
                <h2>{selectedStage ? '阶段详情' : '概览'}</h2>
                {selectedStage && (
                  <button className="chip" onClick={() => setSelectedStage(null)}>
                    返回概览
                  </button>
                )}
              </header>
              {selectedStage ? (
                <StageDetail state={state} stage={selectedStage} />
              ) : (
                <Overview state={state} onPick={setSelectedStage} />
              )}
            </section>
          )}

          {tab === 'review' && <Review state={state} />}
          {tab === 'artifacts' && <Artifacts state={state} />}
          {tab === 'events' && <Events state={state} events={events} />}
        </div>

        <div className="col-right">
          {/* 人类介入区放在右栏顶部 —— 首屏可达是硬要求，不是排版偏好 */}
          <HumanPanel state={state} onDone={refresh} />
          <Warnings state={state} />
        </div>
      </div>
    </div>
  );
}

function Header({ state, connected, onDone }: { state: FullState; connected: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 防御性默认值：状态可能来自任何一个出口（/api/state 或 SSE 首帧）。
  // 这两处现在共用同一个 fullState()，但客户端仍不该假设字段一定存在 ——
  // 缺字段导致的白屏是「刷新正常、重连挂掉」这类最难查的 bug。
  const scenarios = state.scenarios ?? [];
  const [scenario, setScenario] = useState(scenarios[0]?.id ?? 'clean');
  const [mode, setMode] = useState<'demo' | 'config'>('demo');
  const [brief, setBrief] = useState('做一个任务看板：能创建任务，也能列出全部任务。');

  const running = state.status === 'running';
  const sc = scenarios.find((s) => s.id === scenario);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      await api.start({ mode, scenario, brief, projectName: mode === 'demo' ? 'task-board' : 'agentforge-project' });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <b>AgentForge</b>
        <span className="muted small">五角色 · 机械裁判 · 多层锚点</span>
      </div>

      <div className="status-group">
        <span className={`conn ${connected ? 'ok' : 'bad'}`} title={connected ? 'SSE 已连接' : 'SSE 断开'}>
          ●
        </span>
        <span className={`pill ${
          state.status === 'running' ? 'ok' : state.status === 'error' ? 'bad' : state.status === 'paused' ? 'warn' : ''
        }`}>
          {state.status === 'idle'
            ? '未启动'
            : state.status === 'running'
              ? '运行中'
              : state.status === 'paused'
                ? '已暂停'
                : state.status === 'finished'
                  ? '已结束'
                  : '出错'}
        </span>
        {state.delivery && (
          <span
            className={`pill ${
              state.delivery === 'complete' ? 'ok' : state.delivery === 'with-debt' ? 'warn' : ''
            }`}
            title={
              state.delivery === 'complete'
                ? '全部需求通过验证，无技术债'
                : state.delivery === 'with-debt'
                  ? '问题被记录后继续推进 —— 受影响需求的验收状态是 ACCEPTED_WITH_DEBT，而不是 met'
                  : state.delivery === 'held'
                    ? '被人类暂停'
                    : '等待真人裁决'
            }
          >
            {state.delivery === 'complete'
              ? '完整交付'
              : state.delivery === 'with-debt'
                ? '带债交付'
                : state.delivery === 'held'
                  ? '已暂停'
                  : '待真人裁决'}
          </span>
        )}
        {state.runId && <code className="muted small">{state.runId}</code>}
      </div>

      <div className="controls">
        <div className="row">
          <button className={`chip ${mode === 'demo' ? 'on' : ''}`} onClick={() => setMode('demo')} disabled={running}>
            离线演示
          </button>
          <button
            className={`chip ${mode === 'config' ? 'on' : ''}`}
            onClick={() => setMode('config')}
            disabled={running}
            title="读取仓库根的 agentforge.config.json，走真实 LLM（需要配好 API key）"
          >
            真实 LLM
          </button>
        </div>

        {mode === 'demo' && (
          <select value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={running}>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        )}

        {mode === 'demo' && sc && <div className="muted small scenario-desc">{sc.description}</div>}

        <input
          className="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          disabled={running}
          placeholder="用一句话描述你要做的软件"
        />

        <div className="row">
          <button className="primary" onClick={start} disabled={running || busy}>
            {running ? '运行中…' : busy ? '启动中…' : '启动 run'}
          </button>
          {state.runtime && (
            <code className="muted small" title={state.runtime.workspace}>
              {state.runtime.mode === 'demo' ? '演示' : '真实'} · {state.runtime.workspace.split(/[/\\]/).pop()}
            </code>
          )}
        </div>
        {err && <div className="notice bad small">{err}</div>}
      </div>
    </header>
  );
}

function Overview({ state, onPick }: { state: FullState; onPick: (s: StageId) => void }) {
  const l = state.ledger;
  const allFindings = state.anchors.flatMap((a) => a.findings.map((f) => ({ a, f })));
  const fails = allFindings.filter((x) => x.f.severity === 'fail');

  return (
    <div className="overview">
      <div className="hero">
        <div>
          <div className="muted small">用户需求</div>
          <div className="brief-text">{state.brief ?? '（尚未启动）'}</div>
        </div>
        <div className="hero-stats">
          <Stat label="阶段" value={state.currentStage ? String(state.currentStage) : '—'} />
          <Stat label="锚点发现（硬失败）" value={`${allFindings.length} (${fails.length})`} tone={fails.length > 0 ? 'bad' : 'good'} />
          <Stat label="派工单" value={String(state.workOrders.length)} />
          <Stat
            label="主理人 precision"
            value={l ? `${(l.precision * 100).toFixed(0)}%` : '—'}
            tone={l ? (l.precision >= 0.7 ? 'good' : l.precision >= 0.4 ? 'mid' : 'bad') : undefined}
          />
        </div>
      </div>

      <h3>机器抓出来的问题</h3>
      {fails.length === 0 && <div className="muted small">没有硬失败。注意：SKIPPED（未配置工具链）不算通过。</div>}
      <div className="findings">
        {fails.map(({ a, f }, i) => (
          <div key={i} className="finding fail">
            <span className="pill bad">{a.anchorId}</span>
            {f.targetRole && <span className="pill role">{f.targetRole}</span>}
            {f.file && (
              <code className="loc">
                {f.file}
                {f.line ? `:${f.line}` : ''}
              </code>
            )}
            <span>{f.message}</span>
          </div>
        ))}
      </div>

      <h3>阶段</h3>
      <div className="stage-list">
        {state.traces.length === 0 && <div className="muted small">尚未开始</div>}
        {state.traces.map((t) => (
          <button key={t.stage} className="stage-row" onClick={() => onPick(t.stage)}>
            <b>{t.stage}</b>
            <span className="muted small">
              {t.cycles} 次门禁 · {t.finalAction || '进行中'}
            </span>
            <span className="anchor-row small">
              {t.anchors.map((a) => (
                <span key={a.runId} className={`light tiny ${a.verdict === 'PASS' ? 'ok' : a.verdict === 'FAIL' ? 'bad' : a.verdict === 'WARN' ? 'warn' : 'muted'}`}>
                  {a.anchorId}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Warnings({ state }: { state: FullState }) {
  const probes = state.runtime?.probes ?? [];
  const warnings = state.runtime?.warnings ?? [];
  if (probes.length === 0 && warnings.length === 0) return null;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>模型与告警</h2>
      </header>
      {probes.length > 0 && (
        <>
          <div className="muted small">能力探测（strict → json-mode → prompt-only 三级降级）</div>
          <ul className="list">
            {probes.map((p, i) => (
              <li key={i}>
                <span className={`pill ${p.jsonSchema === 'strict' ? 'ok' : p.jsonSchema === 'json-mode' ? 'warn' : 'muted'}`}>
                  {p.jsonSchema}
                </span>
                <code>
                  {p.provider}/{p.model}
                </code>
                {!p.reachable && <span className="pill bad">不可达</span>}
                {p.evidence.length > 0 && (
                  <details>
                    <summary className="muted small">证据</summary>
                    <ul className="tight">
                      {p.evidence.map((e, j) => (
                        <li key={j} className="muted small">
                          {e}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <div className="muted small">告警</div>
          <ul className="list">
            {warnings.map((w, i) => (
              <li key={i} className="warn-title small">
                {w}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
