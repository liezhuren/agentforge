import type { AnchorRunResult, FullState, StageId } from '../api.ts';
import { STAGE_LABEL, STAGE_ORDER, VERDICT_COLOR, describeNextAction } from '../api.ts';

const ANCHOR_TITLE: Record<string, string> = {
  A1: '包真实性',
  A2: '符号真实性',
  A3: '导入可解析',
  A4: '编译/类型',
  A5: '测试执行',
  A6: '运行时行为',
  A7: '契约一致性',
  B1: '目标达成',
  B2: '需求覆盖',
  B3: '对抗审查',
};

export function AnchorLight({ a }: { a: AnchorRunResult }) {
  const fails = a.findings.filter((f) => f.severity === 'fail');
  const warns = a.findings.filter((f) => f.severity === 'warn');
  const title = [
    `${a.anchorId} ${ANCHOR_TITLE[a.anchorId] ?? ''} → ${a.verdict}`,
    `方法：${a.method}`,
    `权威度：${a.authority}`,
    `${a.durationMs}ms`,
    ...a.findings.map((f) => `  ${f.severity === 'fail' ? '✖' : '△'} ${f.message}`),
  ].join('\n');

  return (
    <span className={`light ${VERDICT_COLOR[a.verdict]}`} title={title}>
      <b>{a.anchorId}</b>
      <i>{a.verdict}</i>
      {fails.length > 0 && <em>{fails.length}</em>}
      {fails.length === 0 && warns.length > 0 && <em className="warnCount">{warns.length}</em>}
    </span>
  );
}

export function Pipeline({
  state,
  onSelectStage,
  selectedStage,
}: {
  state: FullState;
  selectedStage: StageId | null;
  onSelectStage: (s: StageId) => void;
}) {
  const current = state.currentStage;
  const currentIdx = current ? STAGE_ORDER.indexOf(current) : -1;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>流水线</h2>
        <span className="muted small">
          {state.lastGate?.aLayerHealthy === false ? 'A 层有硬失败 · 未唤醒主理人' : '主理人只在「审查」阶段被唤醒'}
        </span>
      </header>

      <div className="pipeline">
        {STAGE_ORDER.map((stage, i) => {
          const trace = state.traces.find((t) => t.stage === stage);
          const active = stage === current;
          // 只有真的走到头的 run 才把后面所有阶段标成已完成。
          // 仅凭 status === 'finished' 会把 awaiting-human / held 也画成全线走通，
          // 而这两类恰恰是**没走完**的：一个在等真人裁决，一个被真人按停。
          // with-debt 不走这条排除 —— 它的确逐阶段推进到了交付，只是带着债。
          const stoppedEarly = state.delivery === 'awaiting-human' || state.delivery === 'held';
          const done = currentIdx > i || (state.status === 'finished' && !stoppedEarly);
          return (
            <button
              key={stage}
              className={`stage ${active ? 'active' : ''} ${done ? 'done' : ''} ${selectedStage === stage ? 'selected' : ''}`}
              onClick={() => onSelectStage(stage)}
            >
              <div className="stage-name">{STAGE_LABEL[stage]}</div>
              <div className="stage-sub muted small">
                {trace ? (
                  <>
                    {trace.cycles} 次门禁
                    {trace.hostInvoked && <span className="tag host">主理人</span>}
                  </>
                ) : (
                  '—'
                )}
              </div>
              {trace && trace.blockedReasons.length > 0 && (
                <div className="stage-blocked small">
                  阻断 {trace.blockedReasons.length} 次
                </div>
              )}
            </button>
          );
        })}
      </div>

      {state.lastGate && (
        <div className="gate-summary">
          <div className="row">
            <span className="muted small">最近一次门禁</span>
            <b>{STAGE_LABEL[state.lastGate.stage]}</b>
            <span className={`pill ${state.lastGate.blocked ? 'bad' : 'ok'}`}>
              {state.lastGate.blocked ? `阻断 · ${state.lastGate.reason ?? ''}` : '放行'}
            </span>
            <span className="muted small">→ {describeNextAction(state.lastGate.nextAction)}</span>
          </div>
          {state.lastGate.hardFailures.length > 0 && (
            <div className="hard-failures">
              <div className="muted small">
                A 层硬失败 {state.lastGate.hardFailures.length} 个 —— 已机械归因并直接派工单，**没有**打扰主理人：
              </div>
              {state.lastGate.hardFailures.flatMap((h) =>
                h.findings
                  .filter((f) => f.severity === 'fail')
                  .map((f, idx) => (
                    <div key={`${h.anchorId}-${idx}`} className="finding">
                      <span className="pill bad">{h.anchorId}</span>
                      <span className="pill role">{f.targetRole ?? 'UNRESOLVED'}</span>
                      <span>{f.message}</span>
                    </div>
                  )),
              )}
            </div>
          )}
        </div>
      )}

      <div className="anchors">
        <div className="muted small">锚点红绿灯（悬停看方法与证据）</div>
        <div className="anchor-row">
          {state.anchors.length === 0 && <span className="muted small">尚未运行锚点</span>}
          {state.anchors.map((a) => (
            <AnchorLight key={a.runId} a={a} />
          ))}
        </div>
      </div>
    </section>
  );
}

export function StageDetail({ state, stage }: { state: FullState; stage: StageId }) {
  const trace = state.traces.find((t) => t.stage === stage);
  if (!trace) return <div className="muted small">该阶段尚未执行</div>;

  return (
    <div className="stage-detail">
      <div className="row">
        <b>{STAGE_LABEL[stage]}</b>
        <span className="muted small">{trace.cycles} 次门禁</span>
        {trace.hostInvoked && <span className="tag host">唤醒过主理人</span>}
        {trace.finalAction && <span className="muted small">最终：{trace.finalAction}</span>}
      </div>

      {trace.anchors.length > 0 && (
        <>
          <div className="muted small">本阶段锚点</div>
          <div className="anchor-row">
            {trace.anchors.map((a) => (
              <AnchorLight key={a.runId} a={a} />
            ))}
          </div>
        </>
      )}

      {trace.blockedReasons.length > 0 && (
        <>
          <div className="muted small">阻断原因</div>
          <ul className="tight">
            {[...new Set(trace.blockedReasons)].map((r) => (
              <li key={r}>
                <code>{r}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {trace.nextActions.length > 0 && (
        <>
          <div className="muted small">每次门禁的裁决</div>
          <ol className="tight">
            {trace.nextActions.map((a, i) => (
              <li key={i}>
                <code>{a}</code>
              </li>
            ))}
          </ol>
        </>
      )}

      <AnchorFindings state={state} stage={stage} />
    </div>
  );
}

function AnchorFindings({ state, stage }: { state: FullState; stage: StageId }) {
  const trace = state.traces.find((t) => t.stage === stage);
  const all = trace?.anchors.flatMap((a) => a.findings.map((f) => ({ a, f }))) ?? [];
  if (all.length === 0) return null;
  return (
    <>
      <div className="muted small">锚点发现（{all.length}）</div>
      <div className="findings">
        {all.map(({ a, f }, i) => (
          <div key={i} className={`finding ${f.severity}`}>
            <span className={`pill ${f.severity === 'fail' ? 'bad' : 'warn'}`}>{a.anchorId}</span>
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
    </>
  );
}
