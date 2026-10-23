# CoffeeBreak · 面向科研的茶歇系统

> **这份代码不是手写的。** 它由 AgentForge 的 PM / backend / frontend / test 四个 AI 角色
> 协作生成（8 个阶段、11 条确定性锚点把关），共 20 个 TypeScript 源文件。
>
> **它现在能跑，而且有据可查。**

## 一分钟验证

```bash
# ① 启动（零依赖，只要 Node ≥ 24，不需要 npm install）
node src/api/server.ts
#   → [coffeebreak] listening on http://127.0.0.1:8788

# ② 打开浏览器
#   → http://127.0.0.1:8788/

# ③ 跑测试（另一个终端）
node run-tests.mjs
#   → ℹ tests 22  ℹ pass 22  ℹ fail 0

# ④ 端到端验收（需要 ① 还在跑）
node e2e.mjs
#   → 结果：通过 33，失败 0
```

Windows 上直接双击 `start.cmd`。

## 实测结果（`[实测]` 2026-10-24）

| 检查 | 结果 |
|---|---|
| 启动（无 `node_modules`） | ✅ `/health` → `200 {"status":"ok"}` |
| 首页 | ✅ `200`，29,378 字节 HTML |
| 单元/集成测试 | ✅ **22 / 22** |
| 端到端验收（真实 HTTP） | ✅ **33 / 33** |
| 生成方的 A6 运行时探针 | ✅ PASS（readyMs 624） |

`E2E-RESULT.txt` 是上一次完整验收的原始输出。

## 内置账号

| 角色 | 用户名 | 密码 | 权限 |
|---|---|---|---|
| 管理员 | `admin` | `admin123` | 论文的创建 / 编辑 / 删除 |
| 一般用户 | 现场注册任意用户名 | 任意非空 | 浏览 · 评论 · 回复 · 加好友 · 关注 · 设兴趣 · 看推荐 |

> 种子账号定义在 `src/store/store.ts`（`SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`）。
> 非管理员对论文写操作一律 **403**（有测试守着）。

## 演示动线（3 分钟）

1. 首页 → 看到"为你推荐"与论文列表（`GET /api/recommendations` 已按兴趣排序）
2. 用 `admin/admin123` 登录 → 创建一篇论文，**把 18 项属性填满**
3. 论文详情 → 普通用户评论 → 管理员回复（父子结构）
4. 注册普通用户 → 加好友 → 关注 → 设置研究兴趣 → 回首页看推荐顺序变化
5. 用普通用户尝试删论文 → **403**（权限边界）
6. 终端跑 `node run-tests.mjs` → 22/22

## 目录

```
src/
  api/server.ts        入口：解析 PORT + 顶层 listen + 优雅退出
  app.ts               createApp()：路由装配 + 统一错误处理
  http/                router · body 解析 · respond · errors
  routes/              auth · papers · comments · social · recommendations · health · home
                       contract-aliases.ts（契约里的 {id} 模板 → 实际 :id 路由）
  store/store.ts       内存存储 + 种子管理员
  shared/contract-types.ts   由冻结契约自动生成（**不要手改**）
  web/page.ts          单文件 UI（29KB HTML + 内联脚本，无构建步骤）
test/api.test.ts       22 条测试，覆盖 18 条需求
e2e.mjs                33 条端到端验收（真实 HTTP）
```

## 18 项论文属性（任务书要求，一条不少）

`title` · `paperType` · `publishedAt` · `publication` · `conferenceName` ·
`conferenceAddress` · `venueLevel` · `indexCategory` · `eiNumber` · `doi` ·
`issn` · `cnNumber` · `affiliation` · `moeCategory` · `schoolRanking` ·
`publishScope` · `volumeIssue` · `projectSource`

端到端验收里有一条断言：创建后回读，**这 18 个字段必须全部存在**（实测 18/18）。

## 已知缺口（诚实记录）

1. **`GET /api/users/{id}/following` 未实现** —— 契约里声明了，代码里只做了 `/followers`。
   生成方的 A7 锚点在 BUILDING 阶段就报过 `unimplemented-endpoint`，属于已知且有记录的一条。
2. **没有持久化**：数据在内存，重启清空。任务书未要求，演示够用。
3. **UI 是单文件内联脚本**：刻意的 —— 零依赖、克隆即跑，代价是没有组件化。

## 版本与环境

- Node ≥ 24（依赖原生 TypeScript 类型剥离，无需编译步骤）
- 监听端口：默认 `8788`，可用环境变量覆盖：`PORT=9000 node src/api/server.ts`
- 无任何第三方运行时依赖
