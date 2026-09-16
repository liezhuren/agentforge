# 05 · 圆桌会议与真人建议书

两条"人类/异常态"通道：圆桌是**异常态的机器协商**，建议书是**人类凌驾一切的手段**。

---

## 1. 圆桌会议

### 1.1 触发条件（满足任一，由机械裁判自动判定，不可被角色否决）

| # | 条件 | 来源 |
|---|---|---|
| T1 | 某阶段主理人阻断尝试 `blockAttempts >= 3` | 用户要求"被打回 3 次以上" |
| T2 | 主理人异议 `targetRole = UNRESOLVED`（无法归因给具体角色） | 用户要求"主理人无法理解该把问题归因给谁时" |
| T3 | 两个角色对同一契约/实现给出**互相矛盾**的产出（同一 `supersedes` 链上有冲突版本） | 新增：接口协议冲突 |
| T4 | 执行类锚点失败且**机械归因完全失灵**（没有任何文件可归属 ⇒ 一张工单都派不出去） | 见下方修正 |
| T5 | 契约变更请求 `impact` 覆盖 ≥ 2 个角色且无人认领 | 新增：冻结合同变更分歧 |

T3/T4/T5 是我在用户给定的 T1/T2 之外补的，它们覆盖了"角色互相甩锅"和"契约变更僵局"这两类真实僵局。

> **T4 的定义被修正过一次，理由是实测代价。**
>
> 它原来写作「机械归因指向**不同角色**（互相甩锅）」，于是「归因分散」就等于「要开会」。
> 12 轮真实运行开了 15 场圆桌，绝大多数是把本可以直接打回的问题拖去开会。
>
> 这个假设站不住：**甩锅同样可以同时打回给双方** ——
> 派工单的机制本来就支持一次派给多个角色（每个角色一张单），根本不需要开会来解决。
>
> 所以现在的次序是硬的：**只要能归因就先派工单返工；一条都归不了因才开会。**
> 返工是确定的、便宜的、有明确验收条件的；开会要产决议、要校验决议，
> 而且大概率得出「都有责任」这种没法执行的东西。
>
> 唯一的保护是：返工如果没改变任何东西（硬失败签名不变），编排层会识别出来并转逃生流程 ——
> 也可能在那时才开圆桌。所以是「先试便宜的，不行再开会」，循环有界。

### 1.2 会议协议

**圆桌是唯一允许自由文本通信的场合**，但产物必须结构化。

参与者：主理人 + 相关角色（由裁判按 `targetRole` / 锚点归属 / 契约 impact 自动邀请）+ 机械主持（非 LLM）+ 可选人类观察者。
**未受邀角色不得发言**（防止无关角色扩大战场）。

议程（机械主持按固定顺序推进）：

```
第 1 轮 · 立场陈述
  每位参与者提交：{ 我的主张, 证据(EvidenceRef[]), 我认为问题属于谁, 我建议怎么做 }
  → 证据核验：引用不存在的文件/工件 → 该发言被丢弃（记发言失败）

第 2 轮 · 交叉质询（仅在第 1 轮未收敛时）
  参与者针对彼此主张提交：{ 针对谁的主张, 我的反驳, 证据, falsifier }
  → 反驳若有可执行 falsifier，裁判**立即执行**，用结果裁决，不听辩论

收敛判定（机械）：所有参与者对"归因"和"下一步行动"一致，且行动项通过验收条件校验
```

**轮数上限 2。** 第 2 轮仍不收敛 → 升级真人裁决。
理由：多智能体辩论的边际收益在第 2 轮后迅速衰减，而成本线性增长；更长的辩论只会让"更能说"的角色获胜，而不是"更对"的角色获胜。

#### 1.2.1 第 2 轮谁质询谁（机械决定）

质询对象由机械主持按两级规则选定，**不由 LLM 决定**：

1. **机械归因指向的角色优先**（`focusTargets` = 异议的 `targetRole` + 锚点 findings 的 `targetRole`）——
   焦点必须跟着证据走。
2. 没有机械归因时（典型的 T2「不知道该怪谁」）→ **轮转配对**：名单里第 i 位质询第 i+1 位（环状）。

第 2 条是踩过坑之后加的：最初实现是「取第一个不等于自己的角色」，
结果第 2 轮退化成**所有人排队质询名单里排第一的那个人**。
圆桌于是变成围攻，而 T2 恰恰是「还不知道该怪谁」的场合 ——
围攻一个可能无辜的人是最坏的结果。轮转配对让一轮下来覆盖多组配对，
把「谁对谁错」真正摊开来检验。

#### 1.2.2 反驳当场执行（falsifier）

第 2 轮的每条反驳都可以携带 `falsifier`。机械主持**立即执行它**，
执行结果分三种去向：

| 结果 | 条件 | 后果 |
|---|---|---|
| `sustained`（反驳成立） | `expect: exit-nonzero` → 命令非零退出；`expect: output-matches` → 输出匹配模式 | 记为一条**机械事实**，`implicates` = 被质询方 |
| `refuted`（反驳被证伪） | 命令复现不出来 | **整条发言被丢弃**，`implicates` = 反驳方自己 |
| `inconclusive`（无法裁决） | 命令被安全策略拒绝 / 起不来 / 超时 | 不裁决、不产生事实、**不惩罚任何一方** |

`inconclusive` 不写成事实，是刻意的：**「执行不了」不是「说错了」**，
把无法裁决记成裁决就是在制造假证据。

被证伪的反驳会从交给 LLM 生成决议的输入中剔除。
理由很直接：一条已被机械证伪的主张若仍出现在决议输入里，
LLM 会把它当成一个平等的主张来「综合考虑」——而机械已经证明它是错的。

#### 1.2.3 机械事实约束决议

有了当场执行的事实之后，`validateResolution` 多一条否决规则：

> **决议不得把责任归给一个机械证据已经证明它没问题的角色。**

- 归因 ∈ {`implicates` 集合} 或 `SHARED` → 允许
- 归因为 `REQUIREMENT_DEFECT` / `CONTRACT_DEFECT` → **拒绝**（机械证据只证明
  「实现与冻结契约不符」，推不出「契约是错的」；而且改需求是**真人保留的权限**，
  机器人无权自行决定）
- 其余情况 → 拒绝并升级真人

**这条规则的确切能力边界（诚实记录）：**

`sustained` 证明的是「反驳方给出的命令在当前工件上复现了」，
它**不**证明「反驳方对责任的判断是对的」。一个技术上真实但方向错误的 falsifier
（例如「两个文件确实不一致」——而不一致的原因在反驳方自己那边）同样会被记为
`sustained`，于是把归因锁在错误的角色上。

`SHARED` 永远可用，这是这套机制留给「方向不明」情形的出口。
但如果连 `SHARED` 都不成立而真正该负责的是反驳方，本机制会给出错误的约束 ——
要彻底解决它需要把「反驳的逻辑方向」也变成可机械核验的，
而那超出了当前设计能诚实承诺的范围。

### 1.3 决议（结构化产物）

```ts
type RoundtableMinute = {
  id: ArtifactId
  trigger: 'T1' | 'T2' | 'T3' | 'T4' | 'T5'
  participants: RoleId[]
  agenda: string[]                       // 争议点，必须具体
  statements: Array<{
    role: RoleId; round: 1 | 2; claim: string; evidence: EvidenceRef[]
    discarded?: string                   // 证据核验失败 / 反驳被证伪 → 该发言作废
    againstRole?: RoleId                 // 第 2 轮针对谁
    falsifier?: Falsifier                // 第 2 轮的反驳可以带一个可执行检查
    falsifierOutcome?: {                 // 当场执行的结果（sustained/refuted/inconclusive）
      command: string; exitCode: number; matched: boolean
      outcome: 'sustained' | 'refuted' | 'inconclusive'; detail?: string
    }
  }>
  resolution: {
    attribution: RoleId | 'SHARED' | 'REQUIREMENT_DEFECT' | 'CONTRACT_DEFECT'
    decision: string
    actions: Array<{ owner: RoleId; action: string; acceptance: string[] }>   // 非空，每条必须有 owner + 可验证验收
    contractChange?: ChangeRequest
  } | null
  escalation?: 'HUMAN'                   // resolution 为 null 或未通过机械校验时必填
  facts?: RoundtableFact[]               // 当场执行的 falsifier 所确证/证伪的事实
  anchorsCited: AnchorId[]               // 本次引用到的锚点结果
}

// 不写成「事实」的是 inconclusive —— 执行不了 ≠ 说错了
type RoundtableFact = {
  statementIndex: number                 // 产生这条事实的发言下标（可回溯）
  role: RoleId; against?: RoleId
  claim: string
  command: string; exitCode: number      // 实际执行的命令与真实退出码（可复核）
  outcome: 'sustained' | 'refuted'
  implicates: RoleId                     // 这条事实指向谁
}
```

`RoundtableFact` 定义在 `core/types.ts` 而不是编排器内部：
它要经 `roundtable.closed` 事件到达前端。
**前端必须直接用事件里的 `resolutionValid`，不要自己重算**「有行动项就算有效」——
真实规则还看机械事实矛盾与否决措辞，两套判断迟早会给出不同答案。

**反"和稀泥"校验（机械执行）**，任一不满足则决议无效，直接升级真人：

- `actions` 非空
- 每条 action 都有明确 `owner`（不能是"大家"）
- 每条 action 的 `acceptance` 可被某个锚点或测试机械验证（不能是"提升质量"）
- `attribution` 必须是枚举内的具体值，禁止"整体架构问题"这类兜底表述
- `decision` 不得包含"综合考虑""都有道理""折中处理"等无行动指向的措辞（词表 + 必须附 actions 双保）
- `attribution` 不得与当场执行的 falsifier 结果矛盾（见 §1.2.3）

这条设计针对的是 LLM 圆桌最典型的失败：**产出漂亮的、四平八稳的、什么都没解决的会议纪要。**

### 1.4 圆桌结束后

- 有决议且**通过机械校验** → 生成 `WorkOrder` 派给各 owner，主理人**该阶段阻断权终止**（它的异议已被讨论过，不得再阻断同一问题）
- 无决议 / 决议未通过校验 → 打包升级真人（第 2 层逃生），若真人不可用 → 带债通过（第 3 层逃生）

两种情况都会通过 `roundtable.closed` 事件把 `resolutionValid`、`invalidReason`、
`facts`（当场执行的 falsifier 结果）推给前端 —— 升级真人时，
**人类必须能看到「决议为什么被判无效」以及「机械证据到底是什么」**，
否则他手里只有一份看起来挺合理的纪要，却不知道为什么系统不认它。

---

## 2. 真人建议书（Directive）

用户的原始诉求："给真人用户建议书的权益"。

### 2.1 优先级

```
USER_DIRECTIVE  >  FROZEN_CONTRACT  >  HOST_OBJECTION  >  ROLE_OPINION
```

建议书是**最高优先级**，但必须是显式的、带类型的、进日志的——**不接受"聊天里随口一说"**。
理由是：随口一说无法被机械校验，也容易被 LLM "重新解释"。显式化是保护用户意图不被稀释的唯一方式。

#### 2.1.1 优先级的边界：人可以定目标，不能定事实

「最高优先级」不等于「可以推翻一切」。它有一条明确的上界：

> **人可以决定「要什么」** —— 目标、取舍、愿意承担什么风险。**这个不可被否决。**
> **人不能决定「事实是什么」** —— 编译过没过、测试跑没跑、服务起没起。**这个可以被否决。**

这条边界不是靠纪律维持的，而是**结构性的**：门禁里的判定次序是
「先跑确定性检查 → 有硬失败就派工单返工」，这一段**在任何建议书被读取之前**就返回了。
所以不管人发什么指令，都**没法**让一个编译不过、测试挂掉的项目被记为「通过」。

但它以前是**隐性**的，带来两个问题，都已修：

1. **静默无效**：人发一条 `override`，它实际只关掉主理人的阻断权。
   如果人的本意是「让它过」，那么**什么都不会发生，也没有任何回复** ——
   静默无效比明确拒绝更糟，因为人会以为自己的决定生效了。
   现在每条建议书都会经过一次机械裁决（`adjudicateDirective`，纯函数），
   把结论如实回给人类：`applied` / `no-effect` / `cannot-override-facts`（附那条挡路的事实 + 诚实的替代方案）。
2. **界面推荐了一个 API 会拒绝的动作**：介入面板把 `let-it-pass` 列为可用动作，
   而 `DIRECTIVE_KINDS` 与服务端的合法值校验都没有它 —— 提交必然 400。见下方 2.2。

### 2.2 类型

```ts
type Directive = {
  id: ArtifactId
  author: 'human'
  kind: 'requirement' | 'constraint' | 'override' | 'resume' | 'hold' | 'let-it-pass'
  text: string
  // 结构化部分（便于机械校验，全部可选）
  targetRefs?: ArtifactId[]         // 针对哪些工件
  constraints?: string[]            // 例：["不得引入 lodash"]
  supersedes?: ArtifactId[]         // 推翻哪些决定
  expiresAtStage?: StageId          // 有效期（可选）
  at: string
  hash: string
  advisory?: DirectiveAdvisory      // 机械裁决：这条指令会不会产生效果
}
```

| kind | 用途 |
|---|---|
| `requirement` | 改/加需求（生成新 `Requirement` 工件，编号续接） |
| `constraint` | 加硬约束（"不许引入某库""必须用 TypeScript strict"）→ 裁判在 Gate 里校验产物是否违反 |
| `override` | 推翻某角色的某个决定（**管不了确定性事实**，见 2.1.1） |
| `resume` | 解除主理人的阻断权，让流水线可继续推进（同样管不了确定性事实） |
| `hold` | 暂停项目等待人工介入（人类也需要"叫停"的权利） |
| `let-it-pass` | **明知有争议仍继续推进**：未解决的问题记为**技术债**，交付状态是「带债」而**不是「完整」** |
| `advisory` | 不是指令类型，是**机械裁决的返回值**：`applied` / `no-effect` / `cannot-override-facts` |

#### `let-it-pass` 的语义

它是「人可以承担风险」这半条原则的落点：

- 系统**照做** —— 不会无视人的决定。
- 但**只记为技术债** —— `TECH_DEBT.md` 里写明搁置了什么，`delivery` 只会是 `with-debt`。
- **永远不记为「通过」** —— 人有权承担风险，系统无权替他把风险说成成功。

两条实现细节值得记：

- **用一次就消耗掉**。它针对的是**当前这场争议**，不是长期开关。
  若做成长期有效，之后任何一次不相关的失败都会被静默转成债 ——
  那会把「带债」这个信号稀释成噪音，而它恰恰是最需要被看见的信号。
- **被接受过的失败集不再重打**。只做「用一次即消耗」时踩过一个坑：
  BUILDING 里被接受掉的失败，在 REVIEW 会被重新检出 → 系统又开始派工单返工 →
  与人刚说的「别再纠缠」直接矛盾，而且白花钱。
  所以会记下那批失败的**硬失败签名**：同一批不再重打，
  但之后出现任何**新的**问题照常处理（这也是为什么记签名而不是记一个「已批准」的布尔量）。

### 2.3 保证

- **不可忽略**：Gate 每次检查最终产物是否与 active directives 冲突，冲突即 `FAIL(directive-violation)`，且此失败**不能被任何机器人角色覆盖**
- **不可重新解释**：裁判比对时用结构化字段（`constraints` / `targetRefs`），LLM 无权判定"用户其实想要的是 X"
- **可追溯**：写入 append-only 的 `decisions.jsonl` 哈希链，带时间戳
- **可撤回**：人类可以再投一份建议书 supersede 之前的（历史永存，不改写）

### 2.3.1 哪些约束会被真正强制校验（实现说明）

**这是一个必须对用户可见的区分**，否则用户会以为所有建议书都在被强制执行 ——
而「以为自己设了约束、实际没生效」比「功能不存在」危险得多（见 `docs/07 §J1`）。

真人写下的 `constraint` 天然分成两类：

| 类别 | 示例 | 行为 |
|---|---|---|
| ✅ **可机械校验** | 「不得引入 lodash」「只允许 leftpad-real」 | 编译成 deny / allow 列表 → **A1 锚点在 Gate 中强制校验**（检查 `package.json` 声明**与**代码导入）→ 违反即 FAIL 并派工单 |
| ⚠️ **只能作为指令** | 「代码风格要简洁」「错误处理要友好」 | **不**强制校验。仍作为上下文传给角色，也仍记入决策日志 |

编译器（`packages/orchestrator/src/directives.ts`）明确返回 `advisory` 列表并给出原因，
控制台把两类**分开显示**（「已被机械强制校验」/「仅作为角色指令（无法机械校验）」）。

**只编译明确写法的模式，不做语义猜测** ——
例如「不要用重型依赖」这种话，机器无法判断哪个包算「重型」。
猜错方向的代价是：要么误 ban 一个必要的包，要么给用户虚假的安全感。

allow 与 deny 的**语义方向相反**，可以同时生效：

- 白名单是**封闭集合**：一旦有任何「只允许 X」，未列出的依赖一律违规
- 黑名单是**排除集合**：列出的不允许，其余不限制

### 2.3.2 人类的三条主要介入路径

1. **建议书编辑器**：随时注入 requirement / constraint / override / resume / hold，带目标工件选择器
2. **待裁决收件箱**：圆桌无决议时收到的争议包，含双方证据、锚点结果、裁判规则引用；人类一键裁决
3. **暂停/继续**：全局 kill switch，人类随时能冻结整个流水线（LLM 系统必须有物理刹车）

---

## 3. 人在环的位置（明确边界）

| 环节 | 谁决定 | 人类能否介入 |
|---|---|---|
| 需求原子化 | PM (LLM) | ✅ 可 override |
| 契约冻结 | PM + 前后端 + 裁判自洽性校验 | ✅ 可 override / constraint |
| A 层锚点 | **程序** | ❌ 不可覆盖（这是事实，不是意见） |
| B 层语义判定 | LLM 提议 + 程序核验证据 | ✅ 可 override |
| 主理人异议 | 主理人提，**裁判裁** | ✅ 可 override |
| 圆桌决议 | 角色协商，**裁判校验合法性** | ✅ 可 override |
| 死锁升级 | 裁判升级 | ✅ **最终裁决权在人** |
| 带债通过 | 编排器（真人不可用时） | ✅ 可事后补裁决 |

不变量：**人类可以在任何一点上推翻机器人，但机器的确定性事实（A 层锚点）不可以被"意见"推翻。**
如果人类认为 A 层锚点本身错了，那要改的是锚点实现（代码），不是靠发建议书绕过——这样才能保证事实底座不被侵蚀。

> **注意这张表里「❌ 不可覆盖」在实现上曾经是隐性的**（见 2.1.1）：
> 结构上确实推不翻（判定次序上那一分支在任何建议书被读取之前就返回了），
> 但人不会收到任何反馈 —— 他会以为自己的决定生效了。
>
> 现在每一次「试图推翻事实」都会被明确回绝，并附上那条挡路的事实与诚实的替代方案：
>
> ```
> outcome: 'cannot-override-facts'
> message: 这条指令无法产生你想要的效果：它只能解除主理人的阻断权，
>          而阶段 BUILDING 卡住的是 3 条确定性事实（见下）——那些检查不看任何人的意见，包括你的。
> blockingFacts: [ { anchorId: 'A5', code: 'tests-failed', message: '…' }, … ]
> alternative:  要「别再纠缠、继续往下走」：用 let-it-pass（记为技术债，交付状态是「带债」而不是「完整」）。
>               要「把它修好」：把问题派给具体角色返工。
> ```
>
> 也就是：**系统不否认人的权力，只是把权力的边界和代价讲清楚。**

---

## 4. 事件流（前端 WebSocket）

编排器向外广播不可变的领域事件，前端只是投影（projection）：

```ts
type ForgeEvent =
  | { t: 'stage.enter'; stage: StageId }
  | { t: 'artifact.published'; artifact: ArtifactMeta }
  | { t: 'anchor.ran'; result: AnchorRunResult }
  | { t: 'objection.raised'; objection: Objection }
  | { t: 'objection.arbitrated'; arbitration: Arbitration }
  | { t: 'ledger.updated'; ledger: HostLedgerSnapshot }
  | { t: 'workorder.created'; order: WorkOrder }
  | { t: 'roundtable.opened'; trigger: RoundtableTrigger; participants: RoleId[] }
  | {
      t: 'roundtable.closed'
      minuteId: ArtifactId
      resolution: RoundtableResolution | null
      resolutionValid: boolean             // 权威判定：前端必须直接用这个值
      invalidReason?: string
      facts: RoundtableFact[]              // 当场执行的 falsifier 结果（必填，见下）
      falsifiersRun: number
      discardedStatements: number
    }
  | { t: 'escalation.human'; bundleId: string }
  | { t: 'debt.recorded'; debtId: ArtifactId; requirementIds: string[] }
  | { t: 'directive.received'; directive: DirectiveRecord }
  | { t: 'run.finished'; stage: StageId; techDebt: number; delivery: RunDelivery }
```

事件驱动 + 不可变事件 = 前端刷新/重连不丢状态，且整个 run 可离线回放（`runs/` 配合 mock provider）。
这是调试多智能体系统最重要也最容易被忽略的能力：**没有回放，就无法判断一次失败是模型问题还是编排问题。**

**`roundtable.closed` 的两条刻意约定：**

1. **`resolutionValid` 是权威判定，前端不得重算。**
   控制台曾经自己写 `actions.length > 0` 来判断决议是否有效；加上机械事实约束后，
   两套判断立刻分叉 —— 后端认为无效（归因与证据矛盾），前端仍显示「决议可执行」。
   前端重算规则不是「冗余保险」，而是**第二个真相来源**，它只会在规则演进时变成错误显示。
2. **`facts` 是必填而非可选。**
   圆桌最有价值的信息就是「这场会到底被机械裁决了什么」；少了它，
   前端只能看到一场措辞漂亮的辩论，看不到背后真正起作用的执行结果。
