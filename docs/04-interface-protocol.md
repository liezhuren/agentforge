# 04 · 接口协议（角色通信 = 工件，不是对话）

用户的核心要求：**不同角色之间的通信常规只有接口。**
本文把它变成可强制执行的规则，而不是一句口号。

---

## 1. 规则

> **跨角色传递信息的唯一常规通道，是发布/订阅类型化工件（Typed Artifact）。**

角色之间**不直接对话**。所有跨角色输入 = 读取对方已发布的工件。

三条强制手段：

1. **schema 门禁**：任何写入必须通过该 `ArtifactKind` 的 JSON Schema 校验。
   校验失败 = `SCHEMA_REJECT`，工件不入库，写入者收到结构化错误（哪个字段、为什么）。
   **通信失败是显式的，不是"理解偏差"。** 这是与参考项目最本质的区别。
2. **写权限矩阵**：角色只能写自己负责的工件类型（见下表）。越权写入被拒绝。
3. **契约冻结**：契约一旦冻结即 hash 锁定，下游全部基于同一 hash 工作；
   任何一方想改必须走**变更请求**（Change Request）上圆桌。

### 通信通道枚举

```ts
type MessageChannel =
  | 'ARTIFACT'      // 默认：发布/订阅类型化工件
  | 'WORKORDER'     // 派工单：请求某角色产出/修复某工件
  | 'ROUNDTABLE'    // 唯一允许自由文本的场合，且产物仍须结构化
  | 'DIRECTIVE'     // 真人用户单向注入，优先级最高
```

**默认只允许 ARTIFACT 与 WORKORDER。** ROUNDTABLE 是异常态，DIRECTIVE 来自人类。

---

## 2. 工件类型与写权限矩阵

| ArtifactKind | 生产者 | 主要消费者 | 可冻结 |
|---|---|---|---|
| `Requirement` | PM（原子化用户需求，R-001…） | 全体 | ✗ |
| `PRD` | PM | 全体 | ✗ |
| `TaskGraph` | PM | 全体 | ✗ |
| `Contract` | PM（前后端联署） | 前端/后端/测试 | ✅ |
| `CodeModule` | 前端(`scope=web`) / 后端(`scope=api`) | 测试/主理人 | ✗ |
| `TestSuite` | 测试（可含前端组件测试建议） | — | ✗ |
| `TestReport` | 测试 | 主理人/裁判 | ✗ |
| `AnchoredReview` | 主理人 | 裁判/人类 | ✗ |
| `RoundtableMinute` | 圆桌主持（机械） | 全体 | ✗ |
| `Directive` | **真人用户** | 全体 | ✗ |
| `DebtRecord` | 编排器（带债通过时） | 人类 | ✗ |
| `DecisionLog` | 编排器 | 人类 | ✗ |

写权限是硬校验。**主理人不能写代码或需求**，PM 不能改代码，前端不能改后端契约——各自越界即被拒。

---

## 3. 契约冻结（Frozen Contract）

多智能体代码生成最经典的失败：**前端按假设 A 实现，后端按假设 B 实现，各自"测试通过"，集成时全崩。**
自由对话式框架几乎无法避免这个，因为"约定"存在于对话历史里，无法校验。

### 机制

```ts
type Contract = {
  id: ArtifactId
  version: number
  hash: string                      // 冻结后锁定
  frozen: boolean
  openapi?: unknown                 // API 契约
  jsonSchemas: Record<string, unknown>   // 数据模型
  generatedTypesRef: string         // 由契约生成的 TS 类型文件路径
  changeRequests: ChangeRequest[]   // 冻结后的变更请求
}
```

流程：

1. `CONTRACTING` 阶段：PM 起草，前端与后端各自提交**联署意见**（结构化，不是聊天）
2. 机械裁判校验契约**自洽性**（无悬空引用、必填字段有类型、路径不冲突）
3. 冻结：写入 `hash`，生成 TS 类型到 `shared/contract/`，前端与后端**只能 import 这个生成物**，不得手写接口类型
4. `BUILDING` 阶段：A7 锚点校验实现与冻结契约一致
5. 要改契约 → `ChangeRequest{reason, evidence, impact: RoleId[], falsifier}` → 上圆桌 → 通过则解冻、升版、重生成类型、**所有受影响的锚点标记 STALE 并强制重跑**

第 5 条很重要：契约变更会导致下游工件全部失效，系统必须**自动重跑**而不是信任旧的绿灯。
这就是 `03` 文档里 hash 绑定锚点链的用途。

---

## 4. 派工单（WorkOrder）

跨角色"请求"不通过对话，通过工单。工单是机械裁判和锚点自动生成的，也可以是角色发起。

```ts
type WorkOrder = {
  id: WorkOrderId
  to: RoleId
  reason:
    | { kind: 'anchor-fail'; anchorId: AnchorId; detail: unknown }   // 锚点失败自动派发
    | { kind: 'valid-objection'; objectionId: ObjectionId }
    | { kind: 'roundtable-action'; minuteId: ArtifactId; actionIndex: number }
  target: ArtifactId | { newKind: ArtifactKind; scope?: 'web' | 'api' }
  acceptance: string[]           // 验收条件，必须可被锚点或测试验证
  contractHash?: string          // 绑定的契约版本
  status: 'open' | 'in-progress' | 'done' | 'rejected'
}
```

**`acceptance` 必须可机械验证**（能被某个锚点或某个测试检查），否则工单不合法。
这防止"修一下让它更好"这类无法验收的工单。

`reason.kind = 'anchor-fail'` 是关键：A3/A4/A5 的失败自带文件+行归属，
编排器可以**直接生成工单派给正确角色，完全不需要 LLM 参与归因**。
这从根源上消除了"该把问题归因给谁"这类争议的大多数场景——
只有真正模糊的语义问题才会落到主理人手上并可能升级圆桌。

---

## 5. 工件存储与版本

```
workspace/<projectId>/
├─ artifacts/
│  ├─ Requirement/<id>.json
│  ├─ PRD/<id>.json
│  ├─ Contract/<id>.v3.json
│  ├─ CodeModule/<id>.json          # 含文件内容或指向 src/ 的引用
│  ├─ AnchoredReview/<id>.json
│  └─ ...
├─ src/                             # 真实代码（被锚点直接检查的目标）
├─ shared/contract/                 # 由 Contract 生成的 TS 类型（只读）
├─ TECH_DEBT.md                     # 带债通过记录
└─ decisions.jsonl                  # 决策日志（append-only）
```

- 工件**不可变**：修改产出新版本并用 `supersedes` 链接，保留版本链。便于追责与回放。
- `decisions.jsonl` 是 append-only 的，每条含 hash 与前一条 hash（**哈希链**），
  篡改历史会被立刻发现。人类的建议书也写在这里。
- `artifacts/` 用 JSON 文件而非数据库：便于 git diff、人类直接阅读、离线回放。规模大了再引入索引。

---

## 6. 为什么这套设计能压住幻觉

| 幻觉形态 | 接口协议如何拦截 |
|---|---|
| 前端"以为"后端返回 `{data: []}`，实际是 `{items: []}` | 双方都只能 import 契约生成的类型 → 编译期报错（A4） |
| 角色在消息里"承诺"了某个字段但没实现 | 承诺必须落成契约或工单的 `acceptance`，由锚点验证 |
| 自由对话中被忽略的约定 | 没有自由对话，只有工件；工件的每个字段都被 schema 约束 |
| 契约悄悄被改，下游不知情 | hash 锁定 + STALE 自动重跑 |
| 角色互相附和形成幻觉闭环 | 通道里没有"附和"这种消息类型；结论只能由锚点产生 |

**不变量**：*角色之间不存在"未记录的共识"。* 任何共识要么在工件的 schema 里，要么在决策日志里，要么不存在。
