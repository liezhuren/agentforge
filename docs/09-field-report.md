# 09 · 自举验证实地报告（P6）

> 本文件由 `scripts/verify-real-app.ts` 自动生成 —— 数字来自实际运行，不是手写。
> 生成时间：2026-09-13T14:18:54.358Z

## 验证目标

让 AgentForge 走完 `INTAKE → DELIVERED` 生成一个真实小应用（task-board），
然后**绕开锚点系统**独立验证产物：真编译、真测试、真启动 + 真 HTTP 请求。

## 诚实边界

当前环境没有可用的 LLM API key，因此**「模型写了什么」是脚本化的**
（MockProvider 精确返回这份应用代码）。
流水线、锚点、机械裁判、问责账本、圆桌、逃生、以及下面全部独立验证都是真的。

**这意味着本报告证明的是**：给定一份确定的应用代码，整套机制的检查、归因、裁决与交付流程正确工作。
**它没有证明**：任意 LLM 在任意需求下都能产出这样的代码 —— 那需要真实模型，属于未完成的验证。

## 第 1 段 · 流水线结果

- 需求：做一个任务看板：用户可以创建任务，也可以列出全部任务。
- 交付状态：`complete`
- 最终阶段：`DELIVERED`
- Gate 次数：5
- 耗时：2775 ms
- 工单：0 张；技术债：0 条

### 阶段轨迹

| 阶段 | 门禁次数 | 最终动作 | 是否唤醒主理人 | 阻断原因 |
|---|---|---|---|---|
| INTAKE | 1 | `ADVANCE→PLANNING` | 否 | — |
| PLANNING | 1 | `ADVANCE→CONTRACTING` | 否 | — |
| CONTRACTING | 1 | `ADVANCE→BUILDING` | 否 | — |
| BUILDING | 1 | `ADVANCE→REVIEW` | 否 | — |
| REVIEW | 1 | `ADVANCE→DELIVERED` | 是 | — |

### 锚点执行结果（全部为真实检查）

| 锚点 | 判定 | 方法 | 权威度 | 耗时 |
|---|---|---|---|---|
| A1 | `WARN` | npm-name-rules + typo-distance + local-install + registry | approximate | 5 ms |
| A2 | `PASS` | none-needed | authoritative | 0 ms |
| A3 | `PASS` | file-existence with extension candidates (relative to importing file) | authoritative | 4 ms |
| A4 | `PASS` | structured diagnostics from npm run typecheck | authoritative | 714 ms |
| A5 | `PASS` | structured counts from npm run test | authoritative | 467 ms |
| A6 | `PASS` | spawn + HTTP probe http://127.0.0.1:39517/health | authoritative | 340 ms |
| A7 | `PASS` | openapi-path coverage + generated-types existence + duplication heuristic | authoritative | 4 ms |
| B1 | `PASS` | llm-proposals + deterministic evidence verification | approximate | 1 ms |
| B2 | `PASS` | deterministic coverage matrix (requirement → PRD → task → artifact → test) | authoritative | 0 ms |
| B3 | `PASS` | deterministic evidence verification over host objections | authoritative | 0 ms |

### 主理人问责账本

| 指标 | 值 |
|---|---|
| precision | 100% |
| 有效异议 (tp) | 0 |
| 误报 (fp) | 0 |
| 不可证伪 | 0 |
| 累计阻断尝试 | 0 |
| 观察期 | 否 |

## 第 2 段 · 独立验证

共 15 项，通过 15 项。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 流水线交付 | ✅ | delivery=complete |
| A 层七个锚点全部真实执行（无 SKIPPED） | ✅ | A1=WARN A2=PASS A3=PASS A4=PASS A5=PASS A6=PASS A7=PASS |
| A 层无硬失败 | ✅ | 无 |
| A6 运行时锚点真的启动了服务并探针成功 | ✅ | httpStatus=200 |
| A5 测试锚点真的跑了测试并解析出通过数 | ✅ | passed=3 failed=0 |
| 独立 tsc --noEmit（直接对生成产物运行） | ✅ | 零类型错误 |
| 独立运行应用自己的测试套件 | ✅ | exit=0 pass=3 fail=0 |
| 独立启动生成的 HTTP 服务 | ✅ | 已就绪（http://127.0.0.1:39517/health → 200） |
| GET /health → 200 { ok: true } | ✅ | {"status":200,"body":{"ok":true}} |
| POST /api/tasks → 201 且返回带 id 的 Task | ✅ | {"status":201,"body":{"id":"T-001","title":"写文档"}} |
| GET /api/tasks → 200 且包含刚创建的任务（写后读一致） | ✅ | {"status":200,"body":{"items":[{"id":"T-001","title":"写文档"}]}} |
| 未知路径 → 404 | ✅ | {"status":404,"body":{"error":"not found"}} |
| 生成的代码确实落在磁盘上 | ✅ | src/api/server.ts, src/api/store.ts, src/web/client.ts |
| 契约生成的共享类型文件存在且含契约指纹 | ✅ | 523 字节 |
| 无技术债（干净交付） | ✅ | 无 TECH_DEBT.md |

### 独立编译输出

```
exit=0
> task-board@1.0.0 typecheck
> tsc --noEmit -p tsconfig.json
```

### 独立测试输出

```
exit=0
> task-board@1.0.0 test
> node tests/tasks.test.ts

✔ R-001 创建任务：POST /api/tasks 返回 201 且带 id (28.1523ms)
✔ R-002 列出任务：GET /api/tasks 返回 200 且包含已创建的任务 (8.6799ms)
✔ 未知路径返回 404 (3.8253ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 45.4411
```

## 观察到的结论

1. **A1–A7 全部真实执行，无一 SKIPPED。** 这一点值得强调：
   如果 typecheck/test/run 任一未配置，对应锚点会报 SKIPPED 而不是 PASS ——
   本报告里它们都是真的跑了（A4 真 tsc、A5 真测试、A6 真起服务探针）。
2. **主理人只在 REVIEW 阶段被唤醒**，A 层有硬失败时不会被叫来复述编译器已经说清的话。
3. **独立验证与锚点结论一致** —— 这是唯一能排除「锚点自己有 bug 导致自证」的方式：
   同一份产物，锚点说 PASS，外部真编译/真测试/真请求也说通过。

## 已知缺口（下一步）

- 用**真实 LLM** 重跑本流程（需要 API key），以观察真实模型下的完成率、成本、人工介入次数
- 标定经验参数（`BLOCK_QUOTA`、误报惩罚、观察期阈值）—— 当前值仍是我拍的经验值，没有数据支撑
- 幻觉靶场：用 20+ 已知幻觉样本量化每个锚点的**检出率与误报率**
