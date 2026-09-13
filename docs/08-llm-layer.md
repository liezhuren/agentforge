# 08 · LLM Provider 层

用户诉求：**「给用户找他期望的 LLM 的权利」**。
本文说明这份权利是怎么落地的，以及接真实端点时会撞上哪些坑。

---

## 1. 一句话设计

用户写一份 `agentforge.config.json`，声明若干 provider，再给**每个角色**绑定 `{provider, model, temperature, ...}`。

```jsonc
{
  "version": 1,
  "providers": {
    "deepseek": {
      "kind": "openai-compat",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "${DEEPSEEK_API_KEY}",        // 支持环境变量，避免把 key 写进文件
      "defaultModel": "deepseek-chat",
      "jsonMode": "auto",                      // auto = 首次使用时自动探测
      "pricing": { "input": 0.27, "output": 1.1 }   // 美元 / 百万 token
    },
    "ollama": {
      "kind": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "defaultModel": "qwen2.5:14b"
    }
  },
  "roles": {
    "pm":       { "provider": "deepseek", "model": "deepseek-chat",     "temperature": 0.3 },
    "host":     { "provider": "deepseek", "model": "deepseek-reasoner", "temperature": 0.1 },
    "frontend": { "provider": "deepseek", "model": "deepseek-chat",     "temperature": 0.2 },
    "backend":  { "provider": "deepseek", "model": "deepseek-chat",     "temperature": 0.2 },
    "test":     { "provider": "deepseek", "model": "deepseek-chat",     "maxTokens": 8192 }
  },
  "budget": { "totalTokens": 2000000, "onExceed": "stop" }
}
```

**五个角色可以用五个不同的模型**，这不是炫技，而是有实际意义的组合：

| 角色 | 建议 | 理由 |
|---|---|---|
| PM | 最强模型 | 契约质量决定后续一切的成败 |
| 主理人 | 推理模型 | 找茬质量直接决定审查是否有价值 |
| 前后端 | 性价比模型 | 代码量大；A 层锚点会兜底 |
| 测试 | 长上下文模型 | 要读全部代码与契约 |

命令行：

```bash
node packages/orchestrator/src/cli-run.ts init                    # 生成配置模板
node packages/orchestrator/src/cli-run.ts --brief "要做什么"        # 真实 run
node packages/orchestrator/src/cli-run.ts --replay <runId>        # 离线回放
node packages/orchestrator/src/cli-run.ts --verbose               # 打印探测证据与逐次调用
```

---

## 2. 两个 Provider

| Provider | 端点 | 结构化输出 |
|---|---|---|
| `OpenAiCompatProvider` | `POST {baseUrl}/chat/completions` | `response_format: json_schema / json_object / 无` |
| `OllamaProvider` | `POST {baseUrl}/api/chat` | 原生 `format` 字段直接吃 JSON Schema |

覆盖范围：OpenAI / DeepSeek / Moonshot / 通义 / 智谱 / OpenRouter / vLLM / LM Studio / llama.cpp server
（都实现了 OpenAI 兼容协议），以及本地 Ollama。

Ollama 单独写而不是复用兼容层，是因为原生 `format` 的强约束能力会丢：
本地小模型的自由文本格式遵从度最差，而它最需要强约束。

---

## 3. 结构化输出：三级降级 + 兼容转换

这是接真实端点时**必然**会撞上的部分。

### 3.1 OpenAI 严格模式的硬性要求

`response_format: { type: 'json_schema', strict: true }` 只支持 JSON Schema 的一个子集：

- 每个 object 必须显式 `additionalProperties: false`
- 每个 object 的**所有** property 都必须出现在 `required` 里
  （表达「可选」只能用 nullable 类型，不能省略 `required`）
- 不支持 `oneOf` / `not` / `allOf`（只支持 `anyOf`）
- 数值/长度类约束（`minimum` / `minLength` / `maxItems` …）不在支持列表内

而我们自己的工件 schema（`packages/core/src/schemas.ts`）**大量使用 `oneOf`**
（证据引用、falsifier 的联合类型）与可选字段 —— 直接丢给 `strict: true` 会被端点 400 拒绝。

### 3.2 转换器：`toStrictJsonSchema`

`packages/llm/src/strictschema.ts` 做一次**有记录的**转换：

| 输入 | 输出 | 记录 |
|---|---|---|
| 可选字段 | `required` + `type: [T, 'null']` | ✅ |
| `oneOf` | `anyOf` | ✅ |
| `allOf` | `anyOf` | ✅ |
| `minLength` / `minimum` / `pattern` / `not` / `format` … | 剔除 | ✅ |

**关键：转换只放宽服务端约束，客户端强度一点不丢。**
响应回来后仍然要过 `core` 的 `validateSchema`（**原始** schema）。
也就是：服务端宽松 + 客户端严格 + 结构化重试，三者配合 ——
既拿到严格模式带来的稳定性，又没有拿掉任何校验。

每一处改动都写进 `changes`，人类可审计。

### 3.3 能力探测：不猜，去测

`packages/llm/src/probe.ts` 在第一次使用某个 `(provider, model)` 时真发一次探测请求，
逐级降级并记录证据：

```
strict（转换后的 schema）→ json-mode → prompt-only
```

探测用的 schema（`PROBE_SCHEMA`）刻意包含严格模式最易出问题的两个特征：
一个可选字段（`note` 不在 `required` 里）和一个 `oneOf` 联合类型（`tag`）——
用真实工件 schema 去探太笨重，用这个最小样本就能暴露端点真实能力。

结果缓存到 `<workspace>/.agentforge/capabilities.json`，避免每次 run 都重探。
**只缓存 `conclusive && !fatal` 的结果**：缓存「无结论」会让 evidence 里那句
「请稍后重试」永远不会生效；缓存「致命」则意味着一次网络抖动就把这个
`(provider, model)` 永久判死，用户除了手删缓存文件没有出路。
（判定原则与 §3.3 的致命分类一致：**不确定的事不要写进事实底座。**）

**探测结果必须写回 Provider**（`setJsonMode` / `setStrictSchemaMode`），
否则会出现「探测成功、真实调用 400」的错位 —— 这是踩过的坑，见 `docs/07`。

`probe-only` 之外的两种失败被严格区分 —— **这是本层最容易出错、也最危险的地方**：

| 情况 | 分类 | 判定 | 理由 |
|---|---|---|---|
| 端点连不上（ECONNREFUSED / DNS / 超时 / 证书） | `unreachable` | **致命，不降级** | 这是**配置或网络**问题，必须立刻告诉用户 |
| 401 / 403 | `auth` | **致命，不降级** | API key 错了 |
| 404 | `base-url` | **致命，不降级** | baseUrl 路径错（最常见：漏写或多写 `/v1`） |
| 400 提到模型不存在 | `model` | **致命，不降级** | 模型名错 |
| 429 | `rate-limited` | `conclusive: false` | 限流下**得不出能力结论**，但也不是能力问题 |
| 400 提到 `response_format` / `json_schema` | `capability` | 降级 | 端点确实不支持该功能 |
| **请求成功但输出不是合法 JSON** | `output-format` | 降级（`conclusive: false`） | 格式遵从度问题，正是降级链要处理的 |
| **请求成功但输出为空/被截断** | `token-budget` | 降级（`conclusive: false`） | `max_tokens` 太小，见下方「推理型模型」 |
| 其它 400 | `unknown` | 降级但留证 | 说不清，先降级 |

**判定原则：能通过「改配置」解决的问题，就不该被降级掩盖。**

这条原则是踩坑换来的。第一版只区分了「连不上」与「其它」，
结果 401（key 错误）被当成「端点不支持严格模式」，连降两级后报
`prompt-only` + `reachable: true` —— 用户看到「一切正常，只是结构化输出弱一点」，
实际每次调用都会 401 失败。用真实 DeepSeek 端点实测时才抓到（见 `docs/07 §G9`）。

后两类（`output-format` / `token-budget`）是第二次用真实端点实测补上的。
第一次实现时，它们**没有 HTTP 状态码**（因为请求成功了），于是落进了
「没有状态码 ⇒ 网络层错误 ⇒ `unreachable`」那条兜底分支 ——
而 `unreachable` 是致命的，结果是：一个格式遵从度的小毛病，
被升级成了「所有 provider 都不可用，请检查 API key / baseUrl / 网络」，
整个流水线拒绝启动（见 `docs/07 §L1`）。

> **必须区分「请求失败」与「请求成功但输出不合用」。**
> 前者可能是配置问题；后者一定是格式/预算问题，而后者正是降级链存在的理由。

#### 推理型模型与 token 预算

`deepseek-flash` 这类推理型模型会**先把 `max_tokens` 花在不可见的推理 token 上**。
实测（`json-mode`、同一请求连打 5 次）：

| `max_tokens` | 结果 |
|---|---|
| 64 | 3/5 失败：`finish_reason=length`、`completion_tokens=64`、**可见文本长度为 0** |
| 256 | 5/5 成功 |

这对本层有两个直接影响：

1. **探测自己的 `maxTokens` 必须留足余量**（现为 512，并有回归锁测试）。
   探测的预算不足会被误读成被测对象的能力不足 ——
   当被测对象与测试工具共享一个资源（token 预算）时，这种情况必然发生。
2. **空输出必须被解释成「预算耗尽」而不是「JSON 解析失败」。**
   `parseError` 现在会明说「token 预算已耗尽但没产出任何可见内容，
   推理型模型会先把预算花在推理上，请提高 maxTokens 或改用非推理模型」。
   即使调用方没要结构化输出，空响应也会留下 `parseError`（原本静默返回空串）。

**给用户的实际建议**：接推理型模型时，`config.roles[role].maxTokens`
要么不设（让服务端用默认值），要么设得足够大。设小了不会报错，
只会得到「模型什么都没说」。

若**所有** provider 都致命，`buildLlm` 抛 `LlmSetupError` 立刻退出：
否则会跑出一连串「产出失败 → 带债交付」，把真正的原因（key 写错了）彻底埋掉。

### 3.4 JSON 修复（prompt-only 降级路径的兜底）

不是所有端点都支持结构化输出。降级到 prompt-only 后模型会返回带 Markdown 围栏、
前后解释文字的文本。`extractJson` 的修复链：

1. 直接 `JSON.parse`
2. 去掉 Markdown 代码围栏
3. 提取第一个**括号平衡**的 `{...}` / `[...]`（会跳过字符串字面量里的括号）
4. 去尾随逗号 / 中文引号

**修复必须可追溯**：修复痕迹写进 `LlmResponse.parseError`，
下游与人类有权知道「这条结论来自一段被修复过的文本」。

---

## 4. 重试策略

| 状态 | 重试？ | 理由 |
|---|---|---|
| 408 / 409 / 425 / 429 / 5xx | ✅ 指数退避，尊重 `Retry-After` | 临时性故障 |
| 其他 4xx（400 / 401 / 403 / 404） | ❌ | 请求本身有问题（模型名错了、key 错了、不支持该格式）；重试只会烧钱并**掩盖真正的错误** |
| 超时 | ✅ | 按可重试处理 |
| 200 但响应体里带 `error` | ❌ 直接当失败 | 有些网关把错误塞在 200 里 |
| 200 但不是合法 JSON | ❌ | 网关返回了 HTML 错误页之类 |

---

## 5. 成本预算

多智能体编排的特点是**调用次数多、单次不贵**：一次 run 几十到上百次调用，
还要重试、还要圆桌。没有预算控制，跑飞的成本是「线性增长 + 重试放大」。

- `BudgetTracker`：记账与判定（纯逻辑，可单测）
- `BudgetedProvider`：包装任意 Provider，调用前检查、调用后记账
- `onExceed: 'stop'` → 抛 `BudgetExceededError`，编排器走逃生层
- `onExceed: 'warn'` → 只警告一次，继续跑

**刻意不做「自动偷偷换成便宜模型」**：那会让「这次 run 用的到底是什么模型」变得不可追溯，
而可追溯性是本项目的基本要求。

**探测流量不计入角色预算**（刻意的）：探测是「了解端点能力」的基础设施动作，
不是某个角色的工作量；算进角色限额会让「探测几个模型」直接吃掉角色的额度。

---

## 6. 离线回放

`docs/01 §7`：**没有回放，就无法判断一次失败是模型问题还是编排问题。**

- `JsonlRunRecorder`：每次调用写一行 `runs/<runId>.jsonl`（prompt hash + 完整响应 + usage）
- `ReplayProvider`：用录制记录顶掉真实 Provider
- 匹配键是 `purpose | promptHash | attempt`，每个键维护一个 **FIFO 队列** ——
  因为同一个 prompt 在一次 run 里被合法调用多次是完全正常的（例如两张内容相同的工单），
  只用 hash 做键会把它们错配。

回放的价值（已由测试验证）：

- 零成本重跑：调编排参数、改逻辑，不用重新花钱
- **确定性复现**：测试断言「回放出的阶段轨迹与原始 run 完全一致」
- 取证：出问题时翻出当时的原始响应，而不是猜模型说了什么

严格模式下（`onMiss: 'throw'`）遇到未录制的调用会报错 ——
这是刻意的：静默补一次真实调用会让「回放」失去确定性，而确定性正是回放存在的唯一理由。

---

## 7. 验证方式（实测记录）

### 7.1 主要验证手段：本地假的 OpenAI 兼容服务器

`packages/llm/test/fake-server.ts` 是一个**真 HTTP 服务器**（`node:http`，真 socket、真状态码、真超时）。
Provider 层用它做端到端验证。

这不是「退而求其次」——对这块代码它**更强**：

| | 打真 API | 本地假端点 |
|---|---|---|
| 测 429 重试 | 做不到 | ✅ |
| 测「端点拒绝 json_schema」 | 做不到 | ✅ |
| 测超时 | 做不到 | ✅ |
| 测「200 里塞 error」 | 做不到 | ✅ |
| 测「连接被重置」 | 做不到 | ✅ |
| 确定性 | ❌ | ✅ |
| 花钱 | ✅ 花 | ❌ 不花 |
| 复现 | 难 | ✅ |

### 7.2 真实端点验证：鉴权与降级分类

真实端点不可替代的部分是**鉴权与错误分类**。已用真 DeepSeek 端点验证过：

```
$ node packages/orchestrator/src/cli-run.ts --config <指向 api.deepseek.com，key 故意写错>
[llm] 能力探测结果：deepseek/deepseek-chat → strict
      {"reachable":false,
       "evidence":["严格模式探测失败（auth）：LLM 端点返回 401：Authentication Fails ...",
                   "致命问题（auth）：请检查 API key ... **不做降级** —— 降级只会掩盖真正的原因"]}
LLM 初始化失败：所有 LLM provider 都不可用，无法开始运行：
  - deepseek（auth）：LLM 端点返回 401：...
这不是代码问题，是配置问题。请检查 API key / baseUrl / 模型名 / 网络。
exit code = 1
```

**这正是发现 `docs/07 §G9` 那个 bug 的方式**：
修复前同样的情况会报 `prompt-only` + `reachable: true`，
用户看不出自己的 key 是错的；修复后立刻停下并说清原因。

### 7.3 关于网络可用性（一次错误的教训）

项目早期用 PowerShell 的 `Invoke-WebRequest -Method HEAD` 探测连通性，
得到超时失败，我据此断定「完全没有外网」并写进了文档。
后来用 Node `fetch` 重测：**npm registry 与多家 LLM 端点都是通的**，
`npm install react vite` 也实际成功（react 19.3.0 / vite 8.3.0）。

完整的错误链条与教训见 `docs/07 §G10`。这里只留一条操作建议：
**判断连通性不要用 `-Method HEAD`；下影响架构的结论前至少用两种独立方式验证。**

---

## 8. 实现修正记录

见 `docs/07-implementation-notes.md` 的 G 节（P2 阶段发现的 7 处问题）。
其中最重要的两条：

- **探测结论必须写回 Provider**，否则「探测成功、真实调用 400」
- **预算超限是受控路径，不是崩溃**：它曾经从 `refreshReview` 逃逸出来直接崩掉整个 run
