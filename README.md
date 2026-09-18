# AgentForge · 多智能体软件开发

一个本地运行的多智能体开发系统。给一句话需求，五个 LLM 角色协作开发出一个完整项目，
一个**不含任何 LLM 的机械裁判**决定它是否通过。

**不给「AI 说它做好了」，给可核查的结论** —— 每一个「通过」都必须能追溯到一个不依赖 LLM 的事实：
真的编译过、真的跑过测试、真的启动过服务并收到 HTTP 响应。

只要 **Node ≥ 24**，不需要 `npm install`。

---

## 功能

- **五角色协作** —— 产品经理 / 前端 / 后端 / 测试 / 主理人，围绕**类型化工件**而不是对话协作
- **机械裁判** —— 非 LLM。异议成立与否由确定性规则判定，LLM 的语义判断只能作为「提议」
- **11 个确定性锚点** —— 依赖真实存在？符号真被导出？真的编译过？真的跑过测试？真的起过服务？契约一致？
- **三层逃生** —— 打回返工 → 圆桌会议 → 真人裁决 → 带债通过。**任何角色都无法让项目停死**
- **三层记忆** —— 历次真实运行的失败被机械归因、索引、归纳成经验，自动供给后续生成角色（见下）
- **可换的 LLM 层** —— 每个角色独立绑定 provider 与模型（OpenAI 兼容 / Ollama），自动探测结构化输出能力
- **React 控制台** —— 锚点红绿灯、主理人账本、真人介入区（六类建议书）、工件浏览器、事件流

### 记忆系统：把一个反复出现的坑变成一条自动传达的约定

这个项目最贵的一类失败是**「约定没传达，失败却长得像模型能力不足」**：
A4 报 TS2835（相对导入缺扩展名）、A5 报 spawn EPERM、A6 报「服务在就绪前退出（exit 0）」——
锚点判得都对，但根因是**没人告诉模型这个项目的规则**。

过去每发现一条这样的约定，都要人工读日志、归纳、再写进项目声明，**每条约定花一整轮（29 万 token）去撞**。
记忆系统把这条闭环自动化，同时守住三条硬约束：

| 层 | 存什么 | 技术 | 依赖 |
|---|---|---|---|
| **L1 事实** | 工件、打回原因、修复策略、时间戳 | `node:sqlite`（Node 内置） | **零** |
| **L2 索引** | 历史证据的向量 + 全文检索 | 内置特征哈希 / FTS5；`fastembed` 可选 | **零** |
| **L3 经验** | 从事实归纳出的「教训」 | 确定性规则表 + 可选 LLM 措辞 | **零** |

三条硬约束不是口号，是代码里的闸门：

1. **每条记忆必须有出处** —— 任何一条经验都能回答「谁、哪一轮、依据什么」。
   出处不完整的记忆**被丢弃并计数**（不是降权 —— 降权意味着它偶尔还会被用上）。
2. **必须有失效机制** —— 每条经验绑定一份**环境指纹**（tsconfig 语义选项、锚点要跑的命令、Node 版本……）。
   指纹一变，经验降级为 `stale`、不再进提示词，并报出**具体哪个键变了**。
3. **LLM 不能写规则** —— LLM 产出的文字**只能**落在 `proposed`；要生效必须过一组确定性检查
   （证据存在且出处完整、类允许进记忆、环境指纹一致、独立证据条数达标）。
   **没有任何 API 能让 LLM 把一条经验直接置为生效。**

还有一条更强的边界：**经验库不进判定路径**。锚点、机械裁判、Gate、语义验证器永远不读它——
经验能改变的只有「下一轮生成时角色被告知了什么」，永远不是「判定的标准」。
这条由 `packages/memory/test/memory-boundary.test.ts` 扫真实上下文来守（静态查 import 图 + 动态查渲染结果）。

反过来，**代码类的失败绝不允许进记忆**：如果「模型真的写错了」也被总结成经验喂回提示词，
记忆系统就变成一台生产借口的机器 —— 流水线越来越绿、产出越来越差。这条是白名单强制的，默认不许。

```bash
node scripts/memory-report.ts        # 用 13 个真实运行工作区验证记忆系统（0 token）
```

---

## 使用

### 离线演示（推荐先看这个）

不需要 API key，几秒钟把整套机制跑一遍。四个场景分别是：干净项目、幻觉+说谎、甩锅+和稀泥、交叉质询。

```bash
git clone https://github.com/liezhuren/agentforge && cd agentforge

node scripts/run-tests.ts                      # 全部测试（354 个，约 55 秒）
node packages/orchestrator/src/cli-e2e.ts      # 端到端闭环演示（四个场景，全离线）
node scripts/anchor-benchmark.ts               # 幻觉靶场：42 样本，出 docs/10
node scripts/verify-real-app.ts                # 生成一个真实小应用，再绕开锚点系统独立复核
```

### 控制台

```bash
cd apps/web && npm install && npm run build && cd ../..
node packages/server/src/cli.ts                # http://127.0.0.1:7788
```

打开后先点「离线演示」。控制台是**独立工程**（React + Vite）—— 这是刻意的：
引擎保持零依赖是真实优势，不该为了它把引擎牺牲掉。

### 跑一次真实的

```bash
$env:DEEPSEEK_API_KEY="<key>"

node scripts/preseed-llm-workspace.ts workspace/demo   # 建一个带真工具链的空工作区
node packages/orchestrator/src/cli-run.ts --name demo --brief "做一个任务看板：可以创建任务、列出全部任务"

node scripts/inspect-run.ts workspace/demo             # 锚点结论 + 圆桌纪要 + 落盘文件
node scripts/show-verdict.ts workspace/demo            # 控制台会显示什么（两轴判定）
```

> - **不要复用已有工作区重跑**：工件库只增，会在半截状态上继续。
> - 一次真实运行约 **29 万 token / 12 分钟**（12–64 次 LLM 调用，平均 21 次）。
>   只想验证单点改动时不要跑整轮 —— 用 `scripts/replay-verifier.ts`，约 6 万。
> - 想看「验证器到底收到了什么」或「独立复核某个判定」，有 **0 token** 的工具：
>   `scripts/dump-verifier-context.ts` / `scripts/inspect-workspace.ts`。

### 接你自己的 LLM

`agentforge.config.json` 里每个角色可以独立绑定 provider 与模型：

```jsonc
"roles": {
  "pm":       { "provider": "deepseek", "model": "deepseek-chat",     "temperature": 0.3 },
  "host":     { "provider": "deepseek", "model": "deepseek-reasoner", "temperature": 0.1 },
  "frontend": { "provider": "ollama",   "model": "qwen2.5:14b" },
  "backend":  { "provider": "ollama",   "model": "qwen2.5:14b" },
  "test":     { "provider": "deepseek", "model": "deepseek-chat",     "maxTokens": 8192 }
}
```

组合是有讲究的：**契约质量与找茬质量决定后续一切**，所以 PM 与主理人值得用最强的模型；
前后端代码量大、A 层锚点会兜底，可以用便宜甚至本地的模型。
支持 `${ENV_VAR}` 引用环境变量，不必把 key 写进文件。
首次使用某个模型时会自动探测它的结构化输出能力（strict → json-mode → prompt-only 三级降级）——
因为「模型能不能可靠地吐 JSON」这件事**不能猜**。

---

## 输出内容

锚点结论带着**方法与权威度**：

```
A1  WARN   npm-name-rules + typo-distance + local-install + registry
    [warn] registry-unchecked  离线模式：未向 registry 核实 2 个依赖是否真实存在/是否已废弃
A2  PASS   none-needed
A3  PASS   file-existence with extension candidates (relative to importing file)
A4  PASS   structured diagnostics from npm run typecheck
A5  PASS   structured counts from npm run test
A6  PASS   spawn + HTTP probe http://127.0.0.1:8787/health
A7  WARN   openapi-path coverage + generated-types existence + duplication heuristic
    [warn] contract-duplication → backend
        src/shared/contract-types.ts 手写了契约中已定义的模型 "Task"，却没有 import 生成的类型文件
        （这条实际重复报了 12 次 —— 4 个模型 × 3 个入口文件，此处只留一行）
```

注意 A1 报的是 **WARN 而不是 PASS** —— 离线时它没向远端 registry 核实过，
所以它如实说「本地检查通过，远端未验证」。**`SKIPPED ≠ PASS`，`WARN` 也不等于 PASS。**

最终交付判定是**两个独立的维度**，不是一句话：

```
$ node scripts/show-verdict.ts workspace/llm-10

控制台标题栏会显示：
  [真·完整交付]
  [需求 2/2]

鼠标悬停提示（服务端统一措辞）：
  全部验证通过：机械检查全过 + 2/2 条需求确认达成
```

几项会单独说明的内容：

- **两个维度必须分开报。** 「机械检查通过」和「需求真的达成」是独立的两件事，
  四个格子（机械✅需求✅ / 机械✅需求❓ / 机械❌需求✅ / 机械❌需求❓）在真实运行里都出现过。
  绑成一个标签就会造出假绿灯：曾经有一轮九锚全过、而两条需求一条都没确认，系统却显示「完整交付」。
- **归因是机械的。** 每个失败自带文件归属，直接生成派工单，不需要 LLM 再推断「这该怪谁」。
  归因器坏掉时系统会一直开会而不是打回 —— 这是被真实数据修掉的（12 轮开了 15 场圆桌，多数没必要）。
- **`WARN` 不阻断，这是已知缺口。** 上面 A7 那条是**真的**契约漂移（模型把手写的类型文件
  冒充成契约生成物），但它只警告、不阻断，于是「真·完整交付」徽章与它并存。
- **主理人只能提异议，没有最终裁判权。** 它的评分函数是 precision（找茬精度）而不是数量；
  误报扣的额度是真报的两倍；「检查全绿时如实说没有异议」是正确答案、不受惩罚。

---

## 声明你自己的项目契约

项目方在 `package.json` 里声明自己的约定，引擎原样注入每个角色的提示词 ——
因为**模型必须知道、但从代码里看不出来的**规矩，不告诉它就会失败，而且看起来像「模型能力不足」。

```jsonc
{
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node run-tests.mjs",
    "start": "node src/api/server.ts"
  },
  "agentforge": {
    "healthUrl": "http://127.0.0.1:8787/health",   // 不声明 → 运行时探针报 SKIPPED（引擎刻意不猜端口）
    "environmentNotes": [
      "相对导入必须带显式 .ts 扩展名（本项目由 Node 原生类型剥离直接运行）。",
      "禁止在测试或应用代码中 spawn 子进程：本环境禁止管道式 stdio，会直接 EPERM。"
    ],
    "protectedFiles": ["run-tests.mjs"]            // 验证基准文件，产出不得改写
  }
}
```

**契约（`package.json` 里已声明的键 + 上表的受保护文件）是验证基准，产出不能改它。**
这一条是被真实事故换来的：有一轮生成代码附带了一份自己写的 `package.json`，
删掉了项目声明的健康检查地址 —— 于是「真起服务、真发 HTTP」那个锚点**静默变成了「跳过」**，
而那次运行照常走到了交付。现在这类篡改由 **A8 锚点**报 FAIL 并派工单。

---

## 判定口径与已知边界

**事实从哪来**：锚点真的调用 `tsc`、真的跑测试命令、真的启动服务并发 HTTP 请求。
LLM 只产出「提议」，证据由程序逐条核验（文件是否存在、行号是否越界、行区间内容是否与声称相符）——
**核验失败该条判定整条作废**，不是打折。所以编造证据无法得分。

**需要区分两件事**：事实有出处，但**适用范围里有我的判断**。以下是明确属于后者、或它算不了的部分：

| 项目 | 说明 |
|---|---|
| **`WARN` 不阻断** | 上面 A7 的契约漂移就是实例：真的抓到了，但只警告 |
| **需求判定的权威度是「近似」** | 能被机械判定的东西早就变成锚点了，剩下的必然是判断题。值得参考，不是判决书 |
| **需求判定的复核对人做** | 复核过的 6 条判定全部正确，但**没有自动化** —— 每次翻转都靠人去真跑一遍 |
| **样本构成单一** | 12 轮真实运行跑的是**同一种项目**（一个任务看板、2 条需求、纯 Node、内存存储、零第三方依赖） |
| **主理人从未开火** | 12 轮里阻断尝试 **0 次**，问责账本那套规则（额度、误报代价、观察期）**从未被真实数据触发过** |
| **账本参数是猜的** | `BLOCK_QUOTA=3`、误报代价 2、观察期阈值 2。因为上一条，现在还**没法标定** |
| **A1 不核实远端 registry** | 离线时只做本地检查。名字合法、也不像知名包的假包，在这个前提下抓不到 |
| **没有「可恢复的 run」** | run 走到「升级真人」就终止，不能带着人的答复继续 |
| **不判断「完美」** | 它判断的是「需求是否达成 + 代码是否自洽」。代码好不好看、架构合不合理，不在覆盖范围 |

### 测试规模：做过真实性测试，但样本远不到「能下结论」的量

**已经做的是小样本真实验证，不是全量测试。**

| 做过的 | 规模 | 可信度 |
|---|---|---|
| 单元 + 集成测试 | **285 个全绿**，多处做过变异测试（改坏源码确认测试会红） | 高 |
| 幻觉靶场 | **42 样本**（28 注入 + 14 干净对照），0 误报 0 漏报 | 中高（样本手写，自出题自答） |
| 真实 LLM 端到端 | **12 轮**，逐轮人工审读 + 关键判定逐条独立复核 | 中 |

**全量测试没做，主要卡在成本。** 一轮真实运行约 **29 万 token / 12 分钟**，12 轮合计 **349 万 token**。
而且这 12 轮是**诊断性**的、不是统计性的 —— 每轮基本都在发现一个缺陷，花完就该修、修完才值得跑下一轮。
**所以它们测的是「哪里有洞」，不是「它在多大范围内可靠」。**

要回答后者需要**矩阵式重复采样**：多种项目类型 × 多种需求规模 × 每格重复若干次
（模型的输出是非确定性的 —— 实测同一条 prompt 连续两次会给出不同判定，单次结果不能作数）。
粗算 4–6 种项目 × 2–3 次 ≈ 10–18 轮 ≈ **300–500 万 token**。**这笔钱还没花**，所以上面每条结论的置信区间都很宽。

> 一个让人稍微信心高一点的趋势：几个最烧钱的低效环节已经修掉了
> （REVIEW 阶段 81% 的 LLM 调用原先是被白白丢弃的、重复开圆桌、定向返工），
> 所以后续每一轮的信息量在变高、成本在变低。

---

## 开发者备忘

<details>
<summary>架构、规模、验证命令、不变量、文档索引（展开）</summary>

### 架构

```
packages/core/          领域模型、schema、工件存储、事件、决策日志、子进程执行、项目契约
packages/llm/           Provider 层：能力探测、降级、预算、离线回放
packages/anchors/       A1–A8 事实锚 + B1–B3 语义锚 + 证据核验器；bench/ 幻觉靶场
packages/orchestrator/  问责账本、机械裁判、Gate、状态机、圆桌、逃生 + 三个 CLI
packages/roles/         五角色 prompt、读写权限矩阵、LLM 运行器、语义验证器
packages/server/        HTTP API + SSE + 静态资源
apps/web/               React 控制台（独立工程）
```

**依赖方向是单向的，而且它是设计的一部分**：`packages/anchors` **拿不到 LLM 客户端**
（`AnchorContext` 里没有 provider 字段）。所以「LLM 永远不是最终裁判」在依赖关系上就无法违反，
不靠纪律。`packages/orchestrator/src/judge.ts` 里也不含任何 LLM 调用。

### 规模

94 个 TS/TSX 文件 · 29,871 行 · 285 个测试 · **0 个运行时依赖** ·
11 个锚点 · 5 个角色 · 8 个阶段 · 5 类圆桌触发条件 · 6 类真人建议书

### 验证（改动后必跑）

```bash
node scripts/run-tests.ts              # 285 个测试（单进程，约 40 秒）
node scripts/anchor-benchmark.ts       # 42 样本：检出 100% / 干净通过 100% / 0 误报 0 漏报
node scripts/verify-real-app.ts        # P6 自举 + 绕开锚点系统的独立复核
node packages/orchestrator/src/cli-e2e.ts   # 四个离线场景（含「和稀泥决议被拒」）
npm run typecheck                      # 引擎 + 脚本（需 npm install）
```

**纪律：加测试之后把它改坏一次**，确认测试真的会红。本项目多处测试做过这种变异验证 ——
否则很容易得到一个永远为真的断言。CI 在干净的 Ubuntu 机器上跑测试、靶场与类型检查。

### 关键不变量（改代码时不可违反）

1. **LLM 永远不是最终裁决者** —— 每个 PASS 必须能追溯到一个不依赖 LLM 的事实
2. `SKIPPED ≠ PASS` —— 不许把未知当作已知
3. 锚点绑定内容 hash，内容一变锚点即失效
4. 人类可以推翻任何机器人，但**不能推翻确定性事实**
5. 主理人无法让项目停死
6. **`orchestrator` 中不出现任何 LLM 调用**
7. **锚点绝不可以有能力杀死整个 run**（同步异常与异步事件都要挡住）
8. **被验证者不得修改验证基准** —— 违反由 A8 报 FAIL 并机械归因派工单
9. **人可以定目标，不能定事实** —— 人可以让有问题的项目继续推进（记为技术债，
   交付状态是「带债」而不是「通过」），但不能让编译不过的项目被记为通过

### 文档

| 文档 | 内容 |
|---|---|
| [`docs/01`](docs/01-architecture.md) | 总体架构、阶段状态机、全局不变量 |
| [`docs/02`](docs/02-anchor-protocol.md) | 锚点协议：11 个检查、幻觉判定表、A8 与验证基准的边界 |
| [`docs/03`](docs/03-host-accountability.md) | 主理人问责账本 R1–R10 与推进保证 |
| [`docs/04`](docs/04-interface-protocol.md) | 接口即通信、读写权限矩阵、契约冻结 |
| [`docs/05`](docs/05-roundtable-and-directive.md) | 圆桌会议 T1–T5 与真人建议书 |
| [`docs/08`](docs/08-llm-layer.md) | LLM Provider 层：能力探测、降级、预算、离线回放 |
| [`docs/09`](docs/09-field-report.md) · [`docs/10`](docs/10-anchor-benchmark.md) | P6 实地报告 / 靶场标定报告（脚本自动生成） |
| [`docs/11`](docs/11-project-log.md) | **开发日志**：阶段进展、12 轮实测数据、已知问题、工程决策 |

</details>

---

## 声明

[MIT](LICENSE)。

本项目是个人学习与研究项目，**未在生产环境验证过**。它证明的是「机制可以把 AI 的产出
追溯到可核查的事实」，不是「可以放心拿它去开发关键系统」。
当前的能力边界见上面的「判定口径与已知边界」。
