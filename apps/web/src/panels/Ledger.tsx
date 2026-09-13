import type { FullState } from '../api.ts';

/**
 * 主理人问责账本。
 *
 * 这一屏不是「运维指标」，而是整套反奖励黑客机制的**可观测面**：
 * precision 必须和 tp/fp/观察期一起展示，否则一个「很少提异议」的主理人
 * 会被误读成「很准」。见 docs/03 §7。
 */
export function Ledger({ state }: { state: FullState }) {
  const l = state.ledger;
  const b = state.budget;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>主理人账本</h2>
        <span className="muted small">目标是「高精度找茬」，不是「多找茬」</span>
      </header>

      {!l && <div className="muted small">还没有账本数据</div>}

      {l && (
        <>
          <div className="precision">
            <div className="precision-bar" title={`precision = tp / (tp + fp) = ${l.truePositives} / (${l.truePositives} + ${l.falsePositives})`}>
              <div
                className="precision-fill"
                style={{ width: `${Math.round(l.precision * 100)}%` }}
                data-level={l.precision >= 0.7 ? 'good' : l.precision >= 0.4 ? 'mid' : 'bad'}
              />
            </div>
            <div className="precision-text">
              <b>{(l.precision * 100).toFixed(0)}%</b>
              <span className="muted small">
                precision = {l.truePositives} / ({l.truePositives} + {l.falsePositives})
              </span>
            </div>
          </div>

          <div className="grid-3">
            <Metric label="有效异议" value={l.truePositives} tone="good" hint="扣 1 额度（R1）" />
            <Metric label="误报" value={l.falsePositives} tone="bad" hint="扣 2 额度（R2）—— 误报代价是真报的两倍" />
            <Metric label="不可证伪" value={l.unfalsifiable} tone="warn" hint="不合格但不说谎：不阻断、不计误报" />
          </div>

          <div className="kv">
            <KV k="剩余额度" v={String(l.quota)} hint={`每阶段初始 ${l.quota + l.truePositives + l.falsePositives * 2 >= 3 ? 3 : '?'} 点`} />
            <KV k="本阶段阻断尝试" v={`${l.blockAttempts} / 3`} hint="达 3 次即强制圆桌并终止本阶段阻断权（R3）" />
            <KV k="累计阻断尝试" v={String(l.globalBlockAttempts)} hint="连续每阶段都卡满 → 全局观察期（R7）" />
            <KV
              k="观察期"
              v={l.probation ? '是' : '否'}
              tone={l.probation ? 'bad' : 'good'}
              hint={`只能提建议不能阻断；连续 2 个阶段 A 层健康可自动解除（R4/R5）· 当前进度 ${l.probationClearStages}/2`}
            />
            <KV
              k="本阶段阻断权"
              v={l.stageBlockingRevoked ? '已终止' : '可用'}
              tone={l.stageBlockingRevoked ? 'bad' : 'good'}
              hint="R3：阻断尝试达上限后本阶段不得再阻断"
            />
          </div>
        </>
      )}

      {b && (
        <>
          <h3>成本</h3>
          <div className="kv">
            <KV k="总 tokens" v={b.totalTokens.toLocaleString()} hint={`输入 ${b.totalPromptTokens.toLocaleString()} / 输出 ${b.totalCompletionTokens.toLocaleString()}`} />
            <KV k="估算花费" v={`$${b.totalUsd.toFixed(4)}`} hint="按配置里的 pricing 计算；探测流量不计入角色预算" />
          </div>
          {Object.keys(b.byRole).length > 0 && (
            <table className="mini">
              <thead>
                <tr>
                  <th>角色</th>
                  <th>调用</th>
                  <th>tokens</th>
                  <th>$</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(b.byRole).map(([role, v]) => (
                  <tr key={role}>
                    <td>{role}</td>
                    <td>{v.calls}</td>
                    <td>{v.tokens.toLocaleString()}</td>
                    <td>{v.usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {state.runtime && Object.keys(state.runtime.models).length > 0 && (
        <>
          <h3>本次 run 用的模型</h3>
          <table className="mini">
            <tbody>
              {Object.entries(state.runtime.models).map(([role, model]) => (
                <tr key={role}>
                  <td>{role}</td>
                  <td>
                    <code>{model}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone, hint }: { label: string; value: number; tone: string; hint?: string }) {
  return (
    <div className={`metric ${tone}`} title={hint}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function KV({ k, v, tone, hint }: { k: string; v: string; tone?: string; hint?: string }) {
  return (
    <div className="kv-row" title={hint}>
      <span className="kv-k">{k}</span>
      <span className={`kv-v ${tone ?? ''}`}>{v}</span>
    </div>
  );
}
