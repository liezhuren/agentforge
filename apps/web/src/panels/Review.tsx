import { useState } from 'react';
import { api, type Arbitration, type FullState, type Objection, type WorkOrder } from '../api.ts';
import { ROLE_LABEL } from '../api.ts';

/**
 * 审查视图：主理人的每条异议都要能看到它**为什么**被这样裁决。
 *
 * 关键要求（docs/03 §7「可观测性」）：裁决理由里必须带**规则编号**
 * （R1/R2/R6/R8/R9/R-contradicts-anchor…），
 * 否则人类无法复查「裁判是否误判」—— 而裁判误判是这个系统里最危险的失效模式之一。
 */

const VERDICT_TONE: Record<Arbitration['verdict'], string> = {
  VALID: 'bad',
  UNFALSIFIABLE: 'warn',
  REFUTED: 'stale',
};

const VERDICT_LABEL: Record<Arbitration['verdict'], string> = {
  VALID: '有效异议',
  UNFALSIFIABLE: '不可证伪',
  REFUTED: '误报',
};

export function Review({ state }: { state: FullState }) {
  const [tab, setTab] = useState<'objections' | 'orders' | 'roundtable' | 'debt'>('objections');

  const tabs = [
    { id: 'objections' as const, label: `异议与裁决 (${state.objections.length})` },
    { id: 'orders' as const, label: `派工单 (${state.workOrders.length})` },
    { id: 'roundtable' as const, label: `圆桌 (${state.roundtables.length})` },
    { id: 'debt' as const, label: `技术债 (${state.debts.length})` },
  ];

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>审查</h2>
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={`chip ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {tab === 'objections' && <Objections state={state} />}
      {tab === 'orders' && <WorkOrders state={state} />}
      {tab === 'roundtable' && <Roundtables state={state} />}
      {tab === 'debt' && <Debts state={state} />}
    </section>
  );
}

function Objections({ state }: { state: FullState }) {
  if (state.objections.length === 0) {
    return (
      <div className="muted small">
        本次 run 主理人没有提出任何异议。
        <br />
        注意：在主理人的评分体系里，「在机械检查全绿时如实表示无异议」是**正确答案**，不受惩罚（R10）——
        所以「无异议」不代表它失职。
      </div>
    );
  }

  return (
    <div className="objections">
      {state.objections.map((o) => {
        const arb = state.arbitrations.find((a) => a.objectionId === o.id);
        return (
          <div key={o.id} className="objection">
            <div className="row">
              <code>{o.id}</code>
              <span className={`pill ${VERDICT_TONE[arb?.verdict ?? 'UNFALSIFIABLE']}`}>
                {arb ? VERDICT_LABEL[arb.verdict] : '未裁决'}
              </span>
              <span className="pill role">归因：{o.targetRole === 'UNRESOLVED' ? '无法归因' : ROLE_LABEL[o.targetRole] ?? o.targetRole}</span>
              <span className="pill">{o.severity}</span>
            </div>
            <div className="claim">{o.claim}</div>

            {arb && (
              <div className={`arb ${VERDICT_TONE[arb.verdict]}`}>
                <div className="row">
                  <span className="rule" title="裁判引用的规则编号 —— 人类据此复查裁判是否误判">
                    {arb.rule}
                  </span>
                  <span className="muted small">
                    额度 {arb.quotaDelta > 0 ? '+' : ''}
                    {arb.quotaDelta}
                  </span>
                </div>
                <div>{arb.reason}</div>
                {arb.falsifierRun && (
                  <div className="falsifier muted small">
                    falsifier：<code>{arb.falsifierRun.command}</code> → 退出码 {arb.falsifierRun.exitCode}，
                    {arb.falsifierRun.matched ? '问题已复现' : '未能复现'}
                  </div>
                )}
                {o.evidence.length > 0 && (
                  <div className="muted small">
                    证据：
                    {o.evidence.map((e, i) => (
                      <code key={i} className="loc">
                        {e.kind === 'file' ? `${e.path}:${e.startLine}-${e.endLine}` : e.kind === 'artifact' ? e.artifactId : `${e.anchorId}/${e.runId}`}
                      </code>
                    ))}
                  </div>
                )}
                {arb.requiresHuman && <div className="warn-title small">→ 这条只能由人来回答，已转入待裁决收件箱</div>}
              </div>
            )}

            <details>
              <summary className="muted small">原始异议数据</summary>
              <pre>{JSON.stringify(o, null, 2)}</pre>
            </details>
          </div>
        );
      })}
    </div>
  );
}

function WorkOrders({ state }: { state: FullState }) {
  if (state.workOrders.length === 0) return <div className="muted small">没有派工单</div>;
  const kindLabel: Record<string, string> = {
    'anchor-fail': '锚点失败（机械归因）',
    'valid-objection': '有效异议',
    'roundtable-action': '圆桌行动项',
    'task-graph': '任务图',
  };
  return (
    <table className="wide">
      <thead>
        <tr>
          <th>工单</th>
          <th>派给</th>
          <th>来源</th>
          <th>目标</th>
          <th>验收条件</th>
        </tr>
      </thead>
      <tbody>
        {state.workOrders.map((w) => (
          <tr key={w.id}>
            <td>
              <code>{w.id}</code>
            </td>
            <td>{ROLE_LABEL[w.to] ?? w.to}</td>
            <td>
              <span className="pill">{kindLabel[w.reason.kind] ?? w.reason.kind}</span>
            </td>
            <td>
              <code className="small">
                {typeof w.target === 'string' ? w.target : `${w.target.newKind}${w.target.scope ? '/' + w.target.scope : ''}`}
              </code>
            </td>
            <td>
              <ul className="tight">
                {w.acceptance.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Roundtables({ state }: { state: FullState }) {
  if (state.roundtables.length === 0) {
    return (
      <div className="muted small">
        没有召集圆桌。触发条件（满足任一）：阻断尝试达 3 次 / 主理人无法归因 / 契约冲突 / 机械归因失灵 / 契约变更无人认领。
      </div>
    );
  }
  const TRIGGER: Record<string, string> = {
    T1: '主理人阻断尝试达上限',
    T2: '主理人无法归因（甩锅）',
    T3: '角色产出互相矛盾',
    T4: '机械归因失灵',
    T5: '契约变更无人认领',
  };
  return (
    <div className="roundtables">
      {state.roundtables.map((r, i) => {
        const res = r.resolution as { attribution?: string; decision?: string; actions?: Array<{ owner: string; action: string; acceptance: string[] }> } | null;
        // 有效性判定只认服务端的 resolutionValid（由 validateResolution 机械裁定）。
        // 前端自己重算「有行动项就算有效」会和真实规则分叉 —— 真实规则还看
        // 机械事实矛盾与否决措辞，两套判断迟早会给出不同答案。
        const valid = r.resolutionValid ?? false;
        const facts = r.facts ?? [];
        return (
          <div key={i} className="roundtable">
            <div className="row">
              <span className="pill role">{r.trigger}</span>
              <b>{TRIGGER[r.trigger] ?? r.trigger}</b>
              <span className="muted small">与会：{r.participants.map((p) => ROLE_LABEL[p] ?? p).join('、')}</span>
              {r.falsifiersRun !== undefined && (
                <span className="muted small">
                  当场执行 falsifier {r.falsifiersRun} 次 · 丢弃发言 {r.discardedStatements ?? 0} 条
                </span>
              )}
            </div>

            {facts.length > 0 && (
              <div className="facts">
                <div className="muted small">
                  机械事实（{facts.filter((f) => f.outcome === 'sustained').length} 条确证 /{' '}
                  {facts.filter((f) => f.outcome === 'refuted').length} 条证伪）—— 这些是**执行结果**，不是措辞：
                </div>
                <ul className="tight">
                  {facts.map((f, j) => (
                    <li key={j}>
                      <span className={`pill ${f.outcome === 'sustained' ? 'bad' : 'muted'}`}>
                        {f.outcome === 'sustained' ? '反驳成立' : '反驳被证伪'}
                      </span>{' '}
                      <b>{ROLE_LABEL[f.role] ?? f.role}</b>
                      {f.outcome === 'sustained' ? ' → 问题在 ' : ' 的主张站不住（指向自己）：'}
                      {f.outcome === 'sustained' && <b>{ROLE_LABEL[f.implicates] ?? f.implicates}</b>}
                      <div className="muted small">
                        {f.claim}
                        <br />
                        <code>{f.command}</code> → 退出码 {f.exitCode}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!res && <div className="muted small">尚未产出决议</div>}
            {res && (
              <div className={`arb ${valid ? 'ok' : 'bad'}`}>
                <div className="row">
                  <span className={`pill ${valid ? 'ok' : 'bad'}`}>{valid ? '决议可执行' : '决议被判无效'}</span>
                  <span className="muted small">归因：{res.attribution}</span>
                </div>
                <div>{res.decision}</div>
                {valid && res.actions && res.actions.length > 0 && (
                  <ul className="tight">
                    {res.actions.map((a, j) => (
                      <li key={j}>
                        <b>{ROLE_LABEL[a.owner] ?? a.owner}</b>：{a.action}
                        <span className="muted small"> · 验收：{a.acceptance.join('；')}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {!valid && (
                  <div className="warn-title small">
                    {r.invalidReason ?? '决议未通过机械校验（没有行动项、或行动项缺少可验证的验收条件）。'}
                    <br />
                    系统不做静默通过：无效决议一律升级真人裁决，机器人无权自行认定「讨论过了就算解决」。
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Debts({ state }: { state: FullState }) {
  const [text, setText] = useState<string | null>(null);
  if (state.debts.length === 0) {
    return <div className="muted small">本次 run 没有技术债。交付状态为「完整交付」。</div>;
  }
  return (
    <div>
      <div className="warn-title">
        带债通过：问题**没有被解决**，只是被明确记录后继续推进。受影响需求的验收状态是 ACCEPTED_WITH_DEBT，而不是 met。
      </div>
      <ul className="list">
        {state.debts.map((d) => (
          <li key={d.debtId}>
            <code>{d.debtId}</code>
            <span className="muted small">受影响需求：{d.requirementIds.join('、') || '（未标定具体需求）'}</span>
          </li>
        ))}
      </ul>
      <button
        className="chip"
        onClick={async () => {
          const r = await api.techDebt();
          setText(r.text ?? r.message ?? '（空）');
        }}
      >
        查看 TECH_DEBT.md
      </button>
      {text && <pre className="debt">{text}</pre>}
    </div>
  );
}
