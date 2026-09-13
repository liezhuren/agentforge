# 02 · 锚点协议（Anchor Protocol）

防幻觉的核心。一句话：**任何 LLM 的判断都必须锚定到确定性事实，否则该判断作废。**

---

## 1. 为什么"导包检查 → 编译 → LLM 判目标"这三层不够

用户最初设想的三层顺序是对的，但有四个可被幻觉钻过的洞：

**洞一：包存在 ≠ 符号存在。**
LLM 幻觉最典型的形态不是编造包名，而是 `import { parseZodSchema } from 'zod'` —— `zod` 真实存在，
`parseZodSchema` 却不存在。只查包名会放过这一类。→ 需要 **A2 符号真实性**，直接读依赖的真实 `.d.ts` 类型定义。

**洞二：包名 typo-squatting。**
`lodahs`、`reqeusts`、`expresss` 这类包在 npm 上很多是真实存在的（有些甚至是投毒包）。
"包存在"检查会通过。→ A1 里加 **与 Top-N 知名包的编辑距离检测**，距离 ≤ 2 且非同名 → 告警并要求人工确认。
同时检查 `deprecated` 标记。

**洞三：编译通过 ≠ 能跑。**
类型正确但运行时报错（空指针、错误的中间件顺序、DB 未连接）是常态。→ 需要 **A6 运行时锚**。

**洞四（最致命）：让 LLM 当最终裁判。**
用户原方案"最后由 LLM 检测是否达成目标"是必要的，但不能是终局。LLM 判定会被两件事污染：
(a) 它读到的工件描述本身就是幻觉产物，它会顺着幻觉确认；
(b) 它有附和倾向。
→ 把 LLM 判定降级为**提议**，并要求它给出 `evidenceRefs`；
**每个 evidenceRef 必须是真实存在的 文件+行区间**，由程序逐条核验，核验失败的判定条目直接作废（不是打折，是作废）。
这让"编造证据"从"可能发生"变成"结构性不可能得分"。

---

## 2. 锚点清单

锚点分两层。**A 层零 LLM 调用**，是事实底座；**B 层有 LLM 参与**，但输出必须挂到 A 层事实上。

### A 层 · 事实锚（Fact Anchors）

| ID | 名称 | 实现要点 | 判定输出 |
|---|---|---|---|
| **A1** | 包真实性 | 对 `package.json` 每个依赖：查 registry 是否存在该包、该版本、是否 `deprecated`；与常见包名做编辑距离检测 | `PASS` / `FAIL(missing-pkg)` / `FAIL(version-missing)` / `WARN(deprecated)` / `WARN(typosquat)` |
| **A2** | 符号真实性 | 抽取所有 `import { a, b as c } from 'pkg'`；解析到 `node_modules/pkg` 的真实入口，读 `.d.ts`（或用 TS Compiler API 的 `getExportsOfModule`），校验每个具名导入确实存在 | `FAIL(unknown-export)` 附 符号名 + 包名 |
| **A3** | 导入可解析 | 所有 import/require 目标可解析到真实文件或模块（相对路径、path alias、workspace 包） | `FAIL(unresolved-import)` 附 文件+行 |
| **A4** | 编译/类型 | 真实调用 `tsc --noEmit`（按项目 tsconfig），解析**结构化 diagnostics**（file/line/col/code/message），不让 LLM 看原始日志 | `FAIL(compile)` 附 diagnostics[] |
| **A5** | 测试执行 | 真实运行测试命令，取退出码 + 通过/失败数 + 覆盖率 | `FAIL(tests)` 附 failingCases[] |
| **A6** | 运行时行为 | 按项目声明的 `run` 配置真正启动服务，做 HTTP 探针（health endpoint / 冒烟请求），超时与端口冲突单独归类 | `FAIL(runtime)` 附 探针结果 |
| **A7** | 契约一致性 | 对冻结契约：校验实际 HTTP 响应是否符合 OpenAPI schema；校验生成的 TS 类型与契约 hash 一致 | `FAIL(contract-drift)` 附 偏离路径 |

> A4–A6 是**可执行反馈**，也是参考项目（MetaGPT 等）用过的有效手段。本项目的增量在于：
> 结果被**结构化**成 `AnchorResult`，携带文件+行+错误码，能直接作为工单重新派给正确角色，而不需要 LLM 再"读日志猜原因"。

### B 层 · 语义锚（Semantic Anchors）

| ID | 名称 | 机制 | 防幻觉约束 |
|---|---|---|---|
| **B1** | 目标达成 | LLM 逐条读 `Requirement`，输出 `{reqId, verdict, evidenceRefs[]}` | 每个 `evidenceRef` 形如 `{path, startLine, endLine}`，程序核验文件存在且行区间有效、且该区间的文本确实包含声明的标识符；**核验失败 → 该条 verdict 作废，记为 `INVALID_EVIDENCE`** |
| **B2** | 需求覆盖矩阵 | 需求 → 实现工件 → 测试用例 的映射表 | 映射中的每个引用都必须是真实存在的工件 ID；缺失即暴露，不需要 LLM 判断 |
| **B3** | 对抗审查 | 主理人提异议（见 03 文档） | 异议同样受"证据必须真实存在"约束，由机械裁判核验 |

---

## 3. 锚点链（Anchor Chain）

每个工件在库中带一条链：

```ts
type AnchorLink = {
  anchorId: AnchorId          // 'A1' | ... | 'B3'
  artifactId: ArtifactId
  contentHash: string         // 该工件被检查时的内容 hash
  verdict: 'PASS' | 'FAIL' | 'WARN' | 'SKIPPED' | 'INVALID_EVIDENCE'
  detail?: unknown            // 结构化细节（diagnostics / failingCases / evidenceRefs...）
  at: string                  // ISO 时间
}

type Artifact = {
  id: ArtifactId
  kind: ArtifactKind
  producer: RoleId
  scope?: 'web' | 'api' | 'shared'
  content: unknown
  contentHash: string
  anchorChain: AnchorLink[]
  supersedes?: ArtifactId     // 版本链
}
```

三个作用：

1. **防篡改传播**：锚点结果绑定 `contentHash`。工件被改动后旧锚点自动失效（hash 不匹配 → 视为 `STALE`），
   必须重跑锚点。杜绝"用旧的绿灯照亮新的代码"。
2. **可归因**：`FAIL(unresolved-import)` 直接携带文件+行，可机械地派工单给对应角色，无需 LLM 推断归因。这是 B 层"归因不清"问题的根源性解法。
3. **可回放取证**：`runs/` 记录每次 LLM 调用的 prompt hash 与响应，锚点链指向具体 run，出问题可离线复现。

---

## 4. Gate：阶段门禁

阶段推进必须通过 `Gate`。Gate 不是"锚点全绿才放行"这么简单 —— 那样永远放行不了。

```ts
type GateResult = {
  stage: StageId
  anchors: AnchorRunResult[]        // 本次跑的全部锚点
  hardFailures: AnchorRunResult[]   // 阻断性失败
  objections: Objection[]           // 主理人异议
  arbitration: Arbitration[]        // 裁判对每条异议的裁决
  blocked: boolean
  reason?: 'ANCHOR_HARD_FAIL' | 'VALID_OBJECTION' | 'ROUNDTABLE_PENDING' | 'USER_HOLD'
  ledger: HostLedgerSnapshot        // 主理人账本快照
  nextAction: NextAction            // 机械决定：RETRY_ROLE / ROUNDTABLE / ARBITRATE_HUMAN / ADVANCE / PASS_WITH_DEBT
}
```

**阻断优先级规则**（决定 `blocked=true` 时谁说话）：

- `ANCHOR_HARD_FAIL` 的归因是**机械的**（错误自带文件归属），直接派工单，**不需要主理人参与**。
  主理人的价值体现在 **B 层和 A 层全绿时的语义质疑**，而不是重复编译器已经说过的话。
  这条规则本身就大幅削减了主理人滥报的动机与机会。
- `VALID_OBJECTION` 才轮到主理人阻断。
- 两类同时存在 → 以 `ANCHOR_HARD_FAIL` 为主，主理人异议挂起（不消耗额度，也不阻断）。

---

## 5. 幻觉判定表（给实现者）

| 现象 | 命中锚点 | 输出 |
|---|---|---|
| 引用不存在的包 | A1 | `FAIL(missing-pkg)` |
| 包名非法（大写、空格、非 npm 规则） | A1 | `FAIL(invalid-package-name)` |
| 包名拼写近似知名包 | A1 | `WARN(typosquat)` + 要求人工确认 |
| 引用真实包的不存在符号 | A2 | `FAIL(unknown-export)` |
| import 路径编造 | A3 | `FAIL(unresolved-import)` |
| API 用法编造（类型不匹配） | A4 | `FAIL(compile-error)` |
| 声称"已实现/已通过"但无代码 | B1 | `verdict` 作废 + `INVALID_EVIDENCE` |
| 声称"测试通过"但测试未运行 | A5 | `FAIL(no-tests-ran)` / `SKIPPED` 不可当 PASS |
| 需求遗漏 | B2 | 覆盖矩阵缺项 |
| 契约漂移（手写重复模型 / 未声明端点） | A7 | `WARN(contract-duplication)` / `WARN(undeclared-endpoint)` |
| 主理人编造问题 | 机械裁判 | `REFUTED` + 误报计数 |
| 用旧绿灯掩盖新代码 | hash 校验 | 锚点 `STALE`，强制重跑 |

**核心不变量**：*任何"通过"的结论，都必须能追溯到一个不依赖 LLM 的事实。*

---

## 6. 实现修正记录（P1 编码阶段发现，回写进规格）

### 6.1 A3 的相对导入必须相对**导入文件所在目录**解析

第一版实现把相对导入按**项目根**解析，导致所有真实的同级导入（`./real.ts`）
都被误判成「编造的模块路径」——一个会把诚实代码判成幻觉的**误杀** bug。

修正：`baseDir = dirname(导入文件)`。并且错误信息里带上「已按 X/ 解析」，便于人类判断。

这条 bug 说明了锚点的双向风险：**误报（把真代码判成幻觉）和漏报（放过幻觉）同样有害**。
因此每个锚点都要有「必须放行」的正向测试，不能只测「能抓出问题」。

### 6.2 锚点的权威度必须显式标注

同一个锚点在不同条件下权威度不同，必须让人类看见，否则会把弱结论当强结论用：

| 锚点 | 权威度 | 何时降级 |
|---|---|---|
| A1 | `authoritative` | 离线时降为 `approximate`（远端未核实） |
| A2 | `authoritative`（TS AST 解析 .d.ts） | 无非 `.d.ts` 入口、或走正则降级路径时 → `approximate` |
| A3 | `authoritative` | 存在别名导入未验证时 → `approximate` |
| A4/A5/A6 | `authoritative` | 工具链缺失时 → `none`（SKIPPED） |
| A7 | `authoritative` | — |
| B1 | `approximate`（含 LLM 提议） | 恒为 approximate |

### 6.3 宁可 WARN，不可错判

不确定时一律降级为 `WARN` 而不是 `FAIL`：

- A1 离线 → `WARN(registry-unchecked)`，绝不报 PASS
- A2 遇到 `export *` / `export =` 等无法完全解析的导出 → `WARN(uncertain-export)`，不断言符号不存在
- A2 遇 `default` 导入（CJS 互操作歧义）→ `WARN(no-default-export)`
- A3 别名导入 → `WARN(alias-unresolved)`
- A5 有测试套件但 0 项通过 → `FAIL(no-tests-ran)`（这是"假装测过"，属确定性欺骗，故判 FAIL）

原则：**锚点宁可漏，不可把幻觉当成事实，也不可把事实判成幻觉。**

### 6.4 机械归因是「不打扰主理人」的关键

A3/A4/A5 的失败自带文件归属，编排器据此**直接生成派工单**，不需要 LLM 推断「这该怪谁」。
这条设计砍掉了主理人绝大多数滥报机会 —— 编译器已经说清的问题，没有让它复述的余地。

实测（demo）：一次 A 层扫描把 3 个硬问题分别归因到 `backend`（2 个）与 `UNRESOLVED`（1 个），
后者是「非法包名且无人 import」，正确地无法归因。

### 6.5 命令安全策略：第一版是安全剧场

falsifier 的 command 来自 LLM，是不可信输入。第一版对参数做 `;` `|` `$` 黑名单，
但我们**从不使用 shell**（`spawn` 不传 `shell:true`），这些字符会被原样传给子进程，不具解释力。
那层检查挡不住任何东西，反而误杀了合法用法（`node -e "a; b"`）。

修正后的真实边界是**路径围栏**：二进制允许列表 + 拒绝列表、参数不得逃逸项目根（绝对路径/`..`）、
拒绝独立成 token 的 shell 操作符（`&&` `|` `;`）。并诚实记录已知信任边界：
`node -e` 本身就是任意代码执行，而本项目的工作就是生成并运行代码 ——
真正的隔离边界应由操作系统/容器提供，不是这张列表能消除的。

### 6.6 子进程输出捕获不能走管道

受限环境下无法打开命名管道，`child_process.exec` / 默认 `stdio: 'pipe'` 会直接 `EPERM`。
`execCapture` 把子进程 stdout/stderr 重定向到临时**文件**再读回，
在所有环境下都能拿到完整输出与真实退出码。A4/A5/A6 依赖这一点，且已用真实 HTTP 探针验证。
