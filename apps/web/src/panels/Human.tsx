import { useState } from 'react';
import { api, type FullState } from '../api.ts';

/** 与 api.ts 的 directive 返回类型保持一致（服务端的机械裁决说明）。 */
type DirectiveAdvisory = {
  outcome: 'applied' | 'no-effect' | 'cannot-override-facts';
  message: string;
  blockingFacts?: Array<{ anchorId: string; code: string; message: string }>;
  alternative?: string;
};

/**
 * 人类介入区 —— **必须首屏可达**。
 *
 * 这是「真人建议书高于一切机器人意见」这条优先级的入口（docs/05 §2.1）。
 * 如果它藏在二级菜单里，实际上就等于没有 —— 人类介入的价值在于「随时」。
 *
 * 五种建议书类型不是凑数：
 *   resume（强制推进）与 hold（物理刹车）是打破死锁与紧急止损的**唯一**手段，
 *   它们是「主理人无法让项目停死」这条不变量的最后一道保险。
 */

const KINDS: Array<{ kind: string; label: string; hint: string; danger?: boolean }> = [
  { kind: 'resume', label: '解除阻断 · 强制推进', hint: '解除主理人的阻断权。注意：它管不了确定性失败（编译/测试/运行时），那些只看事实不看意见。', danger: true },
  { kind: 'hold', label: '暂停流水线', hint: '物理刹车：编排器在下一个阶段边界停下（不会强杀，避免半写状态）。', danger: true },
  { kind: 'override', label: '推翻某个决定', hint: '例如「不要按主理人的意思改，按原契约实现」。' },
  {
    kind: 'let-it-pass',
    label: '明知有问题 · 继续推进',
    hint:
      '你有权承担风险。系统会照做 —— 但未解决的问题会被记为**技术债**，' +
      '交付状态是「带债」而**不是「完整」**。系统不会替你把风险说成成功。',
    danger: true,
  },
  {
    kind: 'constraint',
    label: '追加硬约束',
    hint:
      '能被机械校验的写法：「不得引入 lodash」「只允许 leftpad-real」——' +
      '由 A1 锚点在门禁中强制校验，违反即 FAIL 并派工单。' +
      '其它写法（如「代码风格要简洁」）无法机械校验，只会作为指令传给角色 —— 提交后下面会明确标出是哪一类。',
  },
  { kind: 'requirement', label: '修改/追加需求', hint: '系统会生成新的需求条目并纳入覆盖矩阵。' },
];

export function HumanPanel({ state, onDone }: { state: FullState; onDone: () => void }) {
  const [kind, setKind] = useState('resume');
  const [text, setText] = useState('');
  const [constraints, setConstraints] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [advisory, setAdvisory] = useState<DirectiveAdvisory | null>(null);

  const disabled = !state.runtime;

  async function submit() {
    setBusy(true);
    setMsg(null);
    setAdvisory(null);
    try {
      const rec = await api.directive({
        kind,
        text,
        ...(kind === 'constraint' && constraints.trim()
          ? { constraints: constraints.split('\n').map((s) => s.trim()).filter(Boolean) }
          : {}),
      });
      /**
       * 必须把**机械裁决**显示出来，而不是一律回一句「已写入决策日志」。
       *
       * 以前人发一条 override，实际只关掉主理人的阻断权；如果人的本意是「让它过」，
       * 那么什么都不会发生、也没有任何回复 —— 静默无效比明确拒绝更糟，
       * 因为人会以为自己的决定生效了。
       */
      const adv = rec?.advisory;
      setAdvisory(adv ?? null);
      setMsg({
        ok: adv?.outcome !== 'cannot-override-facts' && adv?.outcome !== 'no-effect',
        text: adv?.message ?? '建议书已写入决策日志（append-only 哈希链，不可忽略、不可重新解释）',
      });
      setText('');
      setConstraints('');
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel human">
      <header className="panel-head">
        <h2>真人介入</h2>
        <span className="muted small">优先级：建议书 &gt; 冻结契约 &gt; 主理人异议 &gt; 角色意见</span>
      </header>

      {disabled && <div className="muted small">先启动一次 run，才能投递建议书。</div>}

      <div className="kind-row">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            className={`chip ${kind === k.kind ? 'on' : ''} ${k.danger ? 'danger' : ''}`}
            onClick={() => setKind(k.kind)}
            title={k.hint}
            disabled={disabled}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="muted small">{KINDS.find((k) => k.kind === kind)?.hint}</div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          kind === 'resume'
            ? '说明为什么应当继续推进（这条会进决策日志）'
            : kind === 'constraint'
              ? '例如：不得引入 lodash'
              : '写清楚你要改变什么'
        }
        rows={3}
        disabled={disabled}
      />
      {kind === 'constraint' && (
        <textarea
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          placeholder="每条约束一行，例如：&#10;不得引入 lodash&#10;必须先冻结契约再写代码"
          rows={2}
          disabled={disabled}
        />
      )}

      <div className="row">
        <button className="primary" onClick={submit} disabled={disabled || busy || text.trim().length === 0}>
          {busy ? '提交中…' : '提交建议书'}
        </button>
        <button
          className="danger"
          disabled={disabled || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.pause('人类从控制台暂停');
              setMsg({ ok: true, text: '已提交 hold 建议书 —— 编排器会在下一个阶段边界停下' });
              onDone();
            } catch (e) {
              setMsg({ ok: false, text: (e as Error).message });
            } finally {
              setBusy(false);
            }
          }}
        >
          立即暂停
        </button>
      </div>

      {msg && <div className={`notice ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}

      {/* 被确定性事实挡住时，把那条事实本身摊开给人看 —— 只说「不行」等于没解释。 */}
      {advisory?.blockingFacts && advisory.blockingFacts.length > 0 && (
        <div className="notice bad">
          <div>
            挡路的 <b>确定性事实</b>（它们不看任何人的意见，包括你的）：
          </div>
          <ul className="list">
            {advisory.blockingFacts.slice(0, 6).map((f, i) => (
              <li key={i}>
                <span className="pill bad">{f.anchorId}</span>
                <code>{f.code}</code>
                <span className="muted small">{f.message}</span>
              </li>
            ))}
          </ul>
          {advisory.alternative && <div className="muted small">{advisory.alternative}</div>}
        </div>
      )}

      {state.directives.length > 0 && (
        <>
          <h3>已生效的建议书（{state.directives.length}）</h3>
          <ul className="list">
            {state.directives.map((d) => (
              <li key={d.id}>
                <span className={`pill ${d.kind === 'hold' ? 'bad' : d.kind === 'resume' ? 'ok' : 'role'}`}>{d.kind}</span>
                <span>{d.text}</span>
                {d.advisory && d.advisory.outcome !== 'applied' && (
                  <span className="muted small">（{d.advisory.outcome === 'cannot-override-facts' ? '未能生效：与确定性事实冲突' : '已收下但不会产生效果'}）</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/*
        建议书的执行情况必须展示出来。
        真人写下的约束天然分两类：能机械校验的（「不得引入 X」）与只能作为指令的
        （「代码风格要简洁」）。把第二类伪装成第一类是危险的 ——
        用户会以为约束正在被执行。见 docs/05 §2.2。
      */}
      {state.directiveEnforcement && (
        <>
          {state.directiveEnforcement.enforced.length > 0 && (
            <>
              <h3>已被机械强制校验（{state.directiveEnforcement.enforced.length}）</h3>
              <ul className="list">
                {state.directiveEnforcement.enforced.map((e, i) => (
                  <li key={i}>
                    <span className="pill ok">强制</span>
                    <span>{e.raw}</span>
                    <span className="muted small">
                      → {e.rule}：{e.values.join('、')}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {state.directiveEnforcement.advisory.length > 0 && (
            <>
              <h3 className="warn-title">仅作为角色指令（无法机械校验）</h3>
              <ul className="list">
                {state.directiveEnforcement.advisory.map((a, i) => (
                  <li key={i}>
                    <span className="pill warn">不强制</span>
                    <span>{a.raw}</span>
                    <span className="muted small">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {state.escalations.length > 0 && (
        <>
          <h3 className="warn-title">待裁决收件箱（{state.escalations.length}）</h3>
          <div className="muted small">
            这些争议机器裁决不了（需要人回答的具体问题），或者圆桌两轮未达成有效决议。
            <br />
            可用动作：<b>resume</b>（强制推进）· <b>override</b>（推翻某角色决定）· <b>let-it-pass</b>（明知有争议仍继续 —— 会记为技术债，而不是「已通过」）。
          </div>
          <ul className="list">
            {state.escalations.map((e) => (
              <li key={e.bundleId}>
                <code>{e.bundleId}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
