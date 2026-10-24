# Task Board (with web page) — 第一个**真实 LLM 完整交付**

> 不是脚本化场景，不是预置代码：这份产物由 deepseek 在 7 个门禁里现写，
> 并且**系统自己判定为「真·完整交付」**。
>
> 判据来自 `scripts/show-verdict.ts`（服务端唯一的双轴判定处），不是我的描述。

## 交付结论（原样抄自 `evidence/brief-s3/verdict.txt`）

```
[真·完整交付]
[需求 14/14]

全部验证通过：机械检查全过 + 14/14 条需求确认达成

fullyVerified = true
mechanical    = complete
requirements  = verified
counts = {"met":14,"unverified":0,"open":0,"acceptedWithDebt":0,"total":14}
```

- 7 次 Gate，最终阶段 **DELIVERED**
- 技术债 **0** 条，主理人 precision **100%**（真报 0 / 误报 0 / 不可证伪 0）
- 成本：310,625 tokens（4 个角色共 12 次调用）

## 门禁轨迹（`evidence/brief-s3/gates.txt`）

```
INTAKE       ADVANCE
PLANNING     ADVANCE
CONTRACTING  ADVANCE
BUILDING     seq1  RETRY_ROLE   A4:FAIL A5:PASS A7:FAIL      ← 编译与契约没过，打回
BUILDING     seq2  ADVANCE      A4:PASS A5:PASS A7:PASS A8:PASS B2:PASS
REVIEW       seq1  RETRY_ROLE   A6:FAIL（其余全 PASS）        ← 服务没起来，打回
REVIEW       seq2  ADVANCE → DELIVERED
```

**两次打回都发生了，而且都被修好了** —— 这是它可信的地方：不是一次就过，是能收敛。

## 真检查的数字（不是"看字符串"）

| 锚点 | 实测 |
|---|---|
| **A4 编译** | `tsc --noEmit` → exitCode **0** |
| **A5 测试** | 30 条测试，**passed 30 / failed 0** |
| **A6 探针** | `HTTP 200`，readyMs **632**，`[task-board] 服务已启动：http://127.0.0.1:8792` |
| **A7 契约** | PASS（端点全部实现、无漂移） |

## 我手动复核过的行为（不只看它自己的报告）

干净实例、逐条打：

```
GET    /health                          -> 200 {"status":"ok"}
GET    /api/tasks                       -> 200 []
POST   /api/tasks {"title":"写周报"}     -> 201 带 id/title/status/createdAt
POST   /api/tasks {}                    -> 400          ← 缺 title
GET    /api/tasks?status=doing          -> 200 命中该条  ← 过滤生效
PATCH  /api/tasks/nope  {"status":"done"} -> 404        ← 符合 R-007
DELETE /api/tasks/nope                  -> 404          ← 符合 R-008
GET    /                                -> 200，7,618 字节 HTML
                                          含 <input>、含 fetch('/api/tasks')
```

> 我第一次手测 PATCH 时只传了 `title` → 得到 400，一度以为违反规格。
> 按 R-007 的形状（带 `status`）重测就是 404。**是我测错了，不是它做错了** ——
> 这条记下来当方法论：验证别人的规格，要用规格自己写的形状。

## 怎么跑

```bash
node src/api/server.ts     # → http://127.0.0.1:8792/
node run-tests.mjs         # → 30 passed / 0 failed
```

浏览器打开 <http://127.0.0.1:8792/> 就是一个可用的任务看板（列表/新建/改状态/删除）。

## 文件

```
src/api/server.ts          HTTP 入口（顶层 listen）
src/tasks/routes.ts        集合路由（GET 列表/过滤、POST 创建）
src/tasks/item-routes.ts   单资源路由（PATCH/DELETE，含 404 分支）
src/tasks/store.ts         内存存储（状态的唯一事实来源）
src/web/page.ts            单文件 HTML 页面（列表/新建/改状态/删除）
src/shared/contract-types.ts  由冻结契约生成（**不要手改**）
test/*.test.ts             6 个测试文件，30 条用例
```

## 诚实边界

- **一次成功不等于稳定**：同一批平行跑的另外三轮（最小命题、6 需求纯后端、22 需求的茶歇）
  在这次交付时都还没结束。成功率要等它们跑完才知道。
- 语义层（B1）判「需求达成」用的是**静态证据 + 测试报告**，它验证的是"有实现的痕迹"，
  不是"每个边界行为都对"。我手测补了这一层。
- 这次前端只有一个 HTML 页面（诉求就是这么写的），不代表能产出复杂 UI。
