/**
 * 记忆系统（三层）。
 *
 * | 层 | 存什么 | 技术 | 依赖 |
 * |---|---|---|---|
 * | L1 | 事实：工件、打回原因、修复策略、时间戳 | `node:sqlite`（Node 内置） | **零** |
 * | L2 | 索引：历史证据的向量 + FTS5 全文 | 内置 `LocalHashEmbedding`；fastembed 可选 | **零**（fastembed 按需装） |
 * | L3 | 结论：经验库（教训） | 确定性规则表 + 可选 LLM 措辞 | **零** |
 *
 * ## 三条硬约束怎么被代码强制（而不是靠纪律）
 *
 * | 约束 | 落点 | 违反时会怎样 |
 * |---|---|---|
 * | ① 每条记忆必须有出处 | `provenance.ts` 的 `verifyProvenance()`；`fetch` 默认 `requireProvenance: true` | 出处不完整的命中被**丢弃并计数**（不是降权） |
 * | ② 必须有失效机制 | `env.ts` 的环境指纹 + `expireStaleLessons()` | 指纹不符的经验降级为 `stale`，不进提示词 |
 * | ③ LLM 不能写规则 | `lessons.ts` 的状态机：LLM 只能落 `proposed` | 没有 API 能让 LLM 直接把经验置为 `active` |
 *
 * 外加一条最强的边界：**经验库不进判定路径**（锚点/裁判/Gate/验证器永不读本包），
 * 由 `memory-boundary.test.ts` 扫 import 图来守。
 *
 * ## 用法
 *
 * ```ts
 * import { openMemoryDb, ingestWorkspace, LocalHashEmbedding } from '../memory/src/index.ts';
 *
 * const mem = openMemoryDb('.agentforge/memory.db', workspaceKey);
 * const stats = await ingestWorkspace(mem, { workspace });   // L1，零 token
 * const found = retrieveByClass(mem, { cls: 'convention:entry-must-self-start' });
 * ```
 */

export * from './rootcause.ts';
export * from './env.ts';
export * from './db.ts';
export * from './ingest.ts';
export * from './provenance.ts';
export * from './embed.ts';
export * from './retrieve.ts';
export * from './lessons.ts';
export * from './summarize.ts';
export * from './recorder.ts';
export * from './inject.ts';

/** 记忆库在项目里的默认位置（与 `protectedFiles` 同一层，但**不受** A8 保护）。 */
export const MEMORY_DB_RELATIVE_PATH = '.agentforge/memory.db';
