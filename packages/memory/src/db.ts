/**
 * L1：记忆库（`node:sqlite`）。
 *
 * ## 为什么是 SQLite，而且为什么**没有引入任何依赖**
 *
 * 这个引擎的不变量是「零运行时依赖」（`packages/*` 不需要 `npm install`，
 * CI 里有一条专门断言仓库根不存在 `node_modules`）。
 * 所以记忆库**不能**引第三方驱动。
 *
 * Node 24 自带 `node:sqlite`（`DatabaseSync`），而且本机实测 **FTS5 可用** ——
 * 也就是说「结构化元数据」与「BM25 全文检索」两件事都能在零依赖下做到。
 *
 * ## 这个库存什么：**事实**，不存「结论」
 *
 * 记忆系统里最容易搞错的一件事，是把「LLM 写的经验」和「机械观测到的事实」混在一张表里。
 * 这里刻意把它们分开：
 *
 * - `runs` / `gates` / `findings` / `repairs` —— **纯事实**。每一条都能追溯到
 *   某次运行里某个锚点在某个时刻的原始结论，带内容 hash。写入只由确定性证据触发。
 * - `lessons` —— **结论/建议**。它是从事实里归纳出来的，可以是 LLM 写的，
 *   但永远带 `evidence_json` 指向支撑它的事实行；且**永远不进判定路径**。
 *
 * 分开的理由就是三条硬约束的第一条：**没有出处的记忆是不可核查的规则**。
 * 只要事实层与方法层分表，出处就是外键而不是承诺。
 *
 * ## 出处链（本文件的核心）
 *
 * ```
 * lessons.evidence_json ──► findings.finding_id
 *                              ├─ run_id ──► runs.run_id
 *                              ├─ gate_id ─► gates.gate_id
 *                              ├─ anchor / code / message / data_json
 *                              └─ artifact_refs_json + artifact_hashes_json
 *                                            （锚点检查时的工件内容 hash）
 * ```
 *
 * 最后那一行是「不可篡改」的来源：内容 hash 由锚点在被检查的那一刻写入，
 * 事后改了工件就对不上了。**任何一条记忆都能被追到「谁、哪一轮、依据什么」**。
 */

import { DatabaseSync } from 'node:sqlite';

/** schema 版本。改表结构时 +1，并在这里写清迁移。 */
export const MEMORY_SCHEMA_VERSION = 1;

/**
 * 建表语句。
 *
 * 用 `STRICT` 表：SQLite 会拒绝写入类型不符的值。
 * 这个项目吃过「字段永远为空 / 类型悄悄不匹配」的亏（§6.5），
 * 能让数据库替我们看住的东西就不要靠记性。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- 每个被记忆覆盖的工作区（一个工作区 = 一个被生成的项目）
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_key TEXT PRIMARY KEY,   -- 工作区在记忆库里的稳定标识（默认用绝对路径的 hash）
  path          TEXT NOT NULL,
  env_hash      TEXT NOT NULL,      -- 最近一次观测到的环境指纹
  env_parts     TEXT NOT NULL,      -- 指纹部件 JSON，用于解释「哪里变了」
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL,
  brief        TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  delivery     TEXT,                -- complete / with-debt / held / pending
  final_stage  TEXT,
  cycles       INTEGER,
  env_hash     TEXT,
  source_dir   TEXT                 -- 这次 run 是从哪个目录摄入的（可追溯）
) STRICT;

CREATE TABLE IF NOT EXISTS gates (
  gate_id   TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL,
  stage     TEXT NOT NULL,
  sequence  INTEGER,
  action    TEXT,                   -- ADVANCE / RETRY_ROLE / ROUNDTABLE / ESCALATE_HUMAN / ...
  blocked   INTEGER NOT NULL DEFAULT 0,
  host_invoked INTEGER NOT NULL DEFAULT 0,
  at        TEXT,
  anchors_json TEXT                 -- [{anchor,verdict}] —— 该次 Gate 的锚点结论摘要
) STRICT;

-- 打回原因的最小可核查单元：一条锚点发现
CREATE TABLE IF NOT EXISTS findings (
  finding_id   TEXT PRIMARY KEY,
  -- 归属的**编排 run**（可 JOIN 到 runs.run_id）。老 run 的历史数据可能推不出来 → NULL。
  -- 刻意区分两张「run 身份」（注意：这里是 SQL 注释，别用反引号，会截断外层模板字符串）：
  --   run_id        = 编排 run（run-2026-09-14T15-21-22-819Z），用于「这一轮整体如何」
  --   anchor_round  = 锚点轮次（run-a755a499 / run-5b550ed0-c3），用于「同一批锚点结论」
  -- 它们**不同名**。把两者混为一谈会让 excludeRunId（「不要拿这次 run 自己的历史当经验」）
  -- 静默失效 —— 那是个很难发现的错，因为查询仍然会返回结果。
  run_id       TEXT,
  gate_id      TEXT,
  -- 锚点轮次标识（anchors/ 文件名去掉尾部索引）。**无条件可得**，也是出处的必填项。
  anchor_round TEXT NOT NULL,
  anchor       TEXT NOT NULL,
  code         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  message      TEXT NOT NULL,
  file         TEXT,
  line         INTEGER,
  target_role  TEXT,
  data_json    TEXT,
  -- 机械根因分类的结果（分类器自己的出处也存下来）
  class        TEXT NOT NULL,
  rule_id      TEXT NOT NULL,
  because      TEXT NOT NULL,
  eligible     INTEGER NOT NULL,    -- 0/1：能不能沉淀成记忆
  text_based   INTEGER NOT NULL,    -- 0/1：依据是文本模式（更脆弱）
  self_report  INTEGER NOT NULL,    -- 0/1：引擎自述模式（不独立，不许自动提升）
  -- 分组键：同一类失败在同一锚点上的可读标识，用于统计「是否反复出现」
  signature    TEXT NOT NULL,
  -- 出处：被检查工件在检查那一刻的内容 hash
  artifact_refs_json   TEXT,
  artifact_hashes_json TEXT,
  method       TEXT,                -- 锚点自报的取证方法
  authority    TEXT,                -- authoritative / approximate / none
  at           TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_findings_run      ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_signature ON findings(signature);
CREATE INDEX IF NOT EXISTS idx_findings_class    ON findings(class);

-- 修复策略：角色在返工里实际做了什么（来自 LLM 回放记录里的 repair:* 调用）
CREATE TABLE IF NOT EXISTS repairs (
  repair_id    TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  role         TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  purpose      TEXT NOT NULL,       -- repair:CodeModule:api / repair:TestSuite / ...
  -- 模型在返工里交回来的文字（通常包含它自己的 notes/理由，可从中读出修复策略）。
  -- ⚠️ 回放记录里**只存了 prompt 的 hash，没有存 prompt 本身** ——
  -- 所以「这个角色当时到底被告知了什么」目前无法审计，只能靠 prompt_hash 去比对。
  -- 这对记忆系统是个真实缺口（它最想回答的正是「约定到底传达了没有」）。
  strategy     TEXT,
  prompt_hash  TEXT,
  response_hash TEXT,
  usage_json   TEXT,                -- 真实 token 用量（预算计数器会少算，见 docs/11）
  at           TEXT NOT NULL,
  source       TEXT NOT NULL        -- 记录来源：runs/*.jsonl
) STRICT;

CREATE INDEX IF NOT EXISTS idx_repairs_run ON repairs(run_id);

-- L2：向量索引。**只是索引** —— 载荷永远是上面那些带出处的行。
CREATE TABLE IF NOT EXISTS embeddings (
  ref_kind     TEXT NOT NULL,       -- finding / repair / artifact / lesson
  ref_id       TEXT NOT NULL,
  model        TEXT NOT NULL,       -- provider id，例如 local-hash-v1
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,       -- Float32 小端，写入前已 L2 归一化
  content_hash TEXT NOT NULL,       -- 被嵌入内容的 hash：内容变了就知道该重算
  at           TEXT NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, model)
) STRICT;

-- L3：经验库。**结论层** —— 必须有出处，必须能失效，且永不进判定路径。
CREATE TABLE IF NOT EXISTS lessons (
  lesson_id    TEXT PRIMARY KEY,
  class        TEXT NOT NULL,
  text         TEXT NOT NULL,
  -- proposed / active / refuted / stale
  status       TEXT NOT NULL,
  created_by   TEXT NOT NULL,       -- canonical:<ruleId> / llm:<model> / human:<who>
  created_at   TEXT NOT NULL,
  -- 出处：支撑它的 finding_id 列表（JSON 字符串数组），可为空但空则不得 active
  evidence_json TEXT NOT NULL,
  supporting   INTEGER NOT NULL,    -- 支撑事实条数
  env_hash     TEXT NOT NULL,       -- 成立的前提环境
  env_parts_json TEXT NOT NULL,     -- 便于解释失效原因
  injected_count   INTEGER NOT NULL DEFAULT 0,
  refuted_count    INTEGER NOT NULL DEFAULT 0,
  last_injected_at TEXT,
  promoted_at      TEXT,
  notes        TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status);
CREATE INDEX IF NOT EXISTS idx_lessons_class  ON lessons(class);

-- 经验的生命周期事件 —— 「这条记忆有没有用」的证据全在这里
CREATE TABLE IF NOT EXISTS lesson_events (
  event_id  TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  kind      TEXT NOT NULL,          -- created / promoted / injected / refuted / staled
  run_id    TEXT,
  at        TEXT NOT NULL,
  detail    TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_lesson_events_lesson ON lesson_events(lesson_id);
`;

export type MemoryDb = {
  db: DatabaseSync;
  /** 关闭数据库。幂等。 */
  close: () => void;
  /** 工作区标识（记忆库按工作区分区）。 */
  workspaceKey: string;
};

/**
 * 打开（必要时创建）记忆库。
 *
 * `path` 为 `:memory:` 时建内存库 —— 测试全用它，于是测试不碰磁盘、可并行、可重复。
 */
export function openMemoryDb(path: string, workspaceKey: string): MemoryDb {
  const db = new DatabaseSync(path);
  // WAL 让「边写边读」不用互等；记忆库会在 run 过程中被写、在报告阶段被读。
  // 内存库不支持 WAL（会静默忽略），所以不检查返回值。
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const cur = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!cur) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(MEMORY_SCHEMA_VERSION),
    );
  } else if (Number(cur.value) !== MEMORY_SCHEMA_VERSION) {
    // 刻意不自动迁移：记忆库是**证据**，静默改结构比报错危险得多。
    //
    // ⚠️ 抛错前必须 close()。第一版忘了这一步，测试立刻报
    // `EBUSY: resource busy or locked, unlink '...memory.db'` ——
    // 失败的打开路径把文件句柄泄漏了出去，调用方连清理都做不了。
    // 这类泄漏在正常路径上永远看不到（因为正常路径会被复用/关闭），
    // 只有在「打开失败」这条异常路径上才暴露。
    db.close();
    throw new Error(
      `记忆库 schema 版本不符：库是 v${cur.value}，代码是 v${MEMORY_SCHEMA_VERSION}。` +
        '请重建记忆库（删除 .agentforge/memory.db）或补写迁移 —— 不要静默改结构。',
    );
  }

  return { db, workspaceKey, close: () => db.close() };
}

/** 建表用的 SQL 原文导出 —— 测试据此断言关键约束确实存在。 */
export const MEMORY_SCHEMA_SQL = SCHEMA;

/** Float32Array → SQLite BLOB（小端）。 */
export function vecToBlob(vec: Float32Array): Uint8Array {
  const out = new Uint8Array(vec.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < vec.length; i++) dv.setFloat32(i * 4, vec[i]!, true);
  return out;
}

/**
 * SQLite BLOB → Float32Array。
 *
 * 逐元素读而不是 `new Float32Array(buf.buffer)`：SQLite 返回的 Buffer 可能带
 * 非 4 字节对齐的 `byteOffset`，直接包 Float32Array 会在部分实现上抛
 * RangeError（"start offset ... should be a multiple of 4"）。
 * `DataView` 没有对齐要求，慢一点但不会在别人机器上炸。
 */
export function blobToVec(blob: Uint8Array, dim: number): Float32Array {
  const out = new Float32Array(dim);
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < dim; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/**
 * L2 归一化。归一化后**点积即余弦相似度** —— 检索时省一次开方。
 * 零向量原样返回（不能除 0）。
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

/** 点积（输入需已 L2 归一化才等于余弦相似度）。 */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
