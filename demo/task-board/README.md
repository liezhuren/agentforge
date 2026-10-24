# Task Board · AgentForge 的真实交付示例

> **这份代码不是手写的。** 它由 AgentForge 的四个角色（PM / backend / frontend / test）协作产出，
> 走完 8 个阶段、5 个门禁，**11 条锚点全部通过**，`fullyVerified = true`。
>
> 与 `demo/coffeebreak` 的区别：那个是"真实 LLM 生成、但系统没结账"；
> 这个是**系统真的结账了** —— 但它来自引擎自带的 `real-app` 场景，
> **模型输出是脚本化的**，而 `A4 / A5 / A6` 是**真检查**。

## 一分钟验证

```bash
# 启动（零依赖，只要 Node ≥ 24）
node src/api/server.ts
#   → 监听 127.0.0.1:39517（端口写在这个工作区的 package.json 里）

# 另开一个终端
curl http://127.0.0.1:39517/health
#   → {"ok":true}
```

Windows 上：

```powershell
Invoke-RestMethod http://127.0.0.1:39517/health
Invoke-RestMethod http://127.0.0.1:39517/api/tasks
```

## 交付记录（`[实测]` 2026-10-24）

| 项 | 结果 |
|---|---|
| 最终阶段 | **DELIVERED** |
| 机械轴 `delivery` | **complete** |
| 需求轴 `requirements` | **verified**（2/2 达成） |
| `fullyVerified` | **true** |
| 门禁 | 5 轮，全部 `ADVANCE`（INTAKE → PLANNING → CONTRACTING → BUILDING → REVIEW → DELIVERED） |
| 工单 / 技术债 | 0 张 / 0 条 |
| 主理人 precision | 100%（0 有效异议 / 0 误报） |

锚点逐条：

```
A1:WARN  A2:PASS  A3:PASS  A4:PASS  A5:PASS  A6:PASS
A7:PASS  A8:PASS  B1:PASS  B2:PASS  B3:PASS
```

**其中三条是"真检查"**（不是看字符串）：

| 锚点 | 实测证据 |
|---|---|
| **A4 编译** | `tsc --noEmit` → `exitCode 0` |
| **A5 测试** | 真跑测试套件 → `exitCode 0`，**passed 3 / failed 0** |
| **A6 运行时探针** | 真起服务 → `HTTP 200`，`readyMs 323`，`healthUrl http://127.0.0.1:39517/health` |

界面截图：`docs/competition/evidence/console-delivered-real-app.png`
（注意界面自己那行告警：**"模型输出是脚本化的，但 A4/A5/A6 是真检查"** —— 我们不粉饰。）

## 规格（这是 PM 从一句诉求拆出来的）

```
R-001  用户可以创建任务      → POST /api/tasks 返回 201 且带 id
R-002  用户可以列出全部任务  → GET /api/tasks 返回 200 且包含已创建的任务
```

外加一条测试：未知路径返回 404。

> **这不是"功能很弱"，而是"规格很小"**：诉求只有一句"能创建任务，也能列出全部任务"。
> 系统严格按这个规模交付，没有擅自膨胀 —— 这本身就是可验收性的体现。

## 目录

```
src/api/server.ts        HTTP 服务（/health、/api/tasks、404）
src/api/store.ts         内存存储
src/web/client.ts        前端调用封装
shared/contract/types.ts 由冻结契约自动生成（**不要手改**）
tests/tasks.test.ts      3 条测试（R-001 / R-002 / 404）
package.json             含 agentforge.healthUrl（A6 靠它探活）
```

## 这条交付证明了什么 / 没证明什么

**证明了**：
- 引擎能把"一句诉求"变成可验收的需求、契约、实现、测试，**真跑**编译/测试/探针并全部通过；
- 结账链路完整：双轴判定 + `fullyVerified` 徽章 + 0 工单 0 债。

**没证明**：
- **代码不是这次临时由 LLM 生成的**（场景是脚本化的）。真实 LLM 端到端交付仍在验证中；
- 规模小（2 条需求 / 3 条测试），不代表能扛住 18 条需求的项目。
