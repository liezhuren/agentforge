/**
 * 工件存储（文件型，不可变，带版本链与锚点链）。
 *
 * 设计要点（docs/04-interface-protocol.md §5）：
 *  - 工件不可变：修改产出新版本并用 supersedes 链接，保留完整版本链便于追责与回放。
 *  - 写权限矩阵强制：越权写入抛 PermissionDenied。
 *  - schema 门禁：校验失败抛 SchemaReject，工件不入库。「通信失败是显式的」。
 *  - 锚点结果绑定内容 hash：内容变更后旧锚点立即 STALE，必须重跑。
 *  - 用 JSON 文件而非数据库：可 git diff、人类可读、离线回放。
 */

import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  ActorId,
  AnchorLink,
  AnchorRunResult,
  Artifact,
  ArtifactId,
  ArtifactKind,
  ArtifactMeta,
  CodeScope,
  RunId,
} from './types.ts';
import { ARTIFACT_KINDS, FREEZABLE_KINDS, SINGLETON_KINDS, WRITE_PERMISSIONS } from './types.ts';
import { contentHash, sha256, stableStringify } from './hash.ts';
import { validateArtifactContent } from './schemas.ts';

export class PermissionDenied extends Error {
  code = 'PERMISSION_DENIED';
  constructor(kind: ArtifactKind, producer: ActorId) {
    const allowed = WRITE_PERMISSIONS[kind].join(', ');
    super(`写权限拒绝：${producer} 不得写入 ${kind}（允许：${allowed}）`);
    this.name = 'PermissionDenied';
  }
}

export class SchemaReject extends Error {
  code = 'SCHEMA_REJECT';
  detail: string;
  constructor(message: string) {
    super(message);
    this.name = 'SchemaReject';
    this.detail = message;
  }
}

export class FrozenViolation extends Error {
  code = 'FROZEN_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'FrozenViolation';
  }
}

export type PutSpec = {
  kind: ArtifactKind;
  producer: ActorId;
  content: unknown;
  scope?: CodeScope;
  /** 显式声明本版本取代哪个工件。省略时自动接到该逻辑工件的当前版本之后。 */
  supersedes?: ArtifactId;
  /** 逻辑工件标识。省略时按 kind 自动分配新序号。 */
  logicalId?: string;
  /** 发布即冻结（用于 Contract）。 */
  freeze?: boolean;
};

type Counter = Record<string, number>;

export class ArtifactStore {
  readonly root: string;
  private counter: Counter = {};
  private cache: Map<ArtifactId, Artifact> = new Map();
  private anchorRuns: Map<RunId, AnchorRunResult> = new Map();

  constructor(workspaceRoot: string) {
    this.root = workspaceRoot;
  }

  private get artifactsDir() {
    return join(this.root, 'artifacts');
  }
  private get anchorRunsDir() {
    return join(this.root, 'anchors');
  }

  async init(): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true });
    await mkdir(this.anchorRunsDir, { recursive: true });
    const counterPath = join(this.artifactsDir, '.counter.json');
    if (existsSync(counterPath)) {
      this.counter = JSON.parse(await readFile(counterPath, 'utf8')) as Counter;
    }
    await this.reload();
  }

  /** 从磁盘重建内存索引。用于回放与崩溃恢复。 */
  async reload(): Promise<void> {
    this.cache.clear();
    this.anchorRuns.clear();
    for (const kind of ARTIFACT_KINDS) {
      const dir = join(this.artifactsDir, kind);
      if (!existsSync(dir)) continue;
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.json')) continue;
        const a = JSON.parse(await readFile(join(dir, f), 'utf8')) as Artifact;
        this.cache.set(a.id, a);
      }
    }
    const runDir = this.anchorRunsDir;
    if (existsSync(runDir)) {
      for (const f of await readdir(runDir)) {
        if (!f.endsWith('.json')) continue;
        const r = JSON.parse(await readFile(join(runDir, f), 'utf8')) as AnchorRunResult;
        this.anchorRuns.set(r.runId, r);
      }
    }
  }

  // ── 写入 ──────────────────────────────────────────────────────

  async put(spec: PutSpec): Promise<Artifact> {
    const allowed = WRITE_PERMISSIONS[spec.kind];
    if (!allowed.includes(spec.producer)) throw new PermissionDenied(spec.kind, spec.producer);

    const validation = validateArtifactContent(spec.kind, spec.content);
    if (!validation.ok) throw new SchemaReject(validation.message);

    const hash = contentHash(spec.content);

    // 内容寻址去重：内容完全相同的同类工件在系统语义上不可区分，直接复用。
    const twin = this.heads(spec.kind).find((a) => a.contentHash === hash);
    if (twin) return twin;

    const logicalId = spec.logicalId ?? this.resolveLogicalId(spec.kind);

    // 版本链
    const chain = spec.supersedes ? [spec.supersedes] : this.tailOf(logicalId);
    const prevIds = chain
      .map((id) => this.cache.get(id))
      .filter((a): a is Artifact => Boolean(a));
    const version = prevIds.length > 0 ? Math.max(...prevIds.map((p) => p.version)) + 1 : 1;

    const id: ArtifactId = version === 1 ? logicalId : `${logicalId}@v${version}`;
    const artifact: Artifact = {
      id,
      kind: spec.kind,
      producer: spec.producer,
      version,
      content: spec.content,
      contentHash: hash,
      anchorChain: [],
      createdAt: new Date().toISOString(),
      ...(spec.scope ? { scope: spec.scope } : {}),
      ...(spec.supersedes ? { supersedes: spec.supersedes } : prevIds.length > 0 ? { supersedes: prevIds[0].id } : {}),
    };

    if (spec.freeze) {
      if (!FREEZABLE_KINDS.includes(spec.kind)) {
        throw new FrozenViolation(`${spec.kind} 不是可冻结的工件类型`);
      }
      artifact.frozenHash = hash;
    }

    await this.persist(artifact);
    this.cache.set(id, artifact);
    return artifact;
  }

  /** 冻结一个已存在的工件（docs/04 §3 契约冻结）。 */
  async freeze(id: ArtifactId): Promise<Artifact> {
    const a = this.require(id);
    if (!FREEZABLE_KINDS.includes(a.kind)) throw new FrozenViolation(`${a.kind} 不可冻结`);
    a.frozenHash = a.contentHash;
    await this.persist(a);
    return a;
  }

  /** 冻结契约的当前 hash，供下游绑定。 */
  frozenContractHash(): string | null {
    for (const a of this.heads('Contract')) {
      if (a.frozenHash) return a.frozenHash;
    }
    return null;
  }

  /**
   * 把受影响需求标记为 ACCEPTED_WITH_DEBT（第三层死锁逃生的记账动作）。
   *
   * 这是写权限矩阵里**唯一一处受控例外**（orchestrator 可写 Requirement）。
   * 为把例外收窄到最小，这里做严格自检：除 `status` 之外的任何字段发生变化都抛错。
   * 也就是说编排器只能改「这条需求是否带债」，不能改需求本身的文字或验收方式。
   */
  async markRequirementsDebt(requirementIds: string[]): Promise<Artifact | null> {
    const head = this.head('Requirement');
    if (!head) return null;

    const ids = new Set(requirementIds);
    const oldContent = head.content as { requirements: Array<Record<string, unknown>> };
    const newRequirements = oldContent.requirements.map((r) => {
      if (!ids.has(String(r.id))) return r;
      return { ...r, status: 'accepted_with_debt' };
    });

    // 自检：除 status 外不得有任何变化
    for (let i = 0; i < oldContent.requirements.length; i++) {
      const before = { ...oldContent.requirements[i] };
      const after = { ...newRequirements[i] };
      const beforeStatus = before.status;
      delete before.status;
      delete after.status;
      if (stableStringify(before) !== stableStringify(after)) {
        throw new Error(
          `markRequirementsDebt 只允许修改 status 字段；需求 ${String(oldContent.requirements[i].id)} 的其它字段被改动了`,
        );
      }
      void beforeStatus;
    }

    const changed = newRequirements.some(
      (r, i) => r.status !== oldContent.requirements[i].status,
    );
    if (!changed) return head;

    return this.put({
      kind: 'Requirement',
      producer: 'orchestrator',
      logicalId: baseLogicalId(head.id),
      content: { requirements: newRequirements },
      supersedes: head.id,
    });
  }

  // ── 读取 ──────────────────────────────────────────────────────

  get(id: ArtifactId): Artifact | null {
    return this.cache.get(id) ?? null;
  }

  require(id: ArtifactId): Artifact {
    const a = this.cache.get(id);
    if (!a) throw new Error(`工件不存在：${id}`);
    return a;
  }

  all(kind?: ArtifactKind): Artifact[] {
    const list = [...this.cache.values()];
    const filtered = kind ? list.filter((a) => a.kind === kind) : list;
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 版本链的头部：没有被任何其他工件 supersede 的版本。 */
  heads(kind?: ArtifactKind): Artifact[] {
    const supersededBy = new Set<string>();
    for (const a of this.cache.values()) if (a.supersedes) supersededBy.add(a.supersedes);
    return this.all(kind).filter((a) => !supersededBy.has(a.id));
  }

  head(kind: ArtifactKind): Artifact | null {
    return this.heads(kind)[0] ?? null;
  }

  meta(a: Artifact): ArtifactMeta {
    const { content: _content, ...rest } = a;
    return { ...rest, title: titleOf(a) };
  }

  list(filter?: { kind?: ArtifactKind; producer?: ActorId; scope?: CodeScope }): ArtifactMeta[] {
    return this.all(filter?.kind)
      .filter((a) => (filter?.producer ? a.producer === filter.producer : true))
      .filter((a) => (filter?.scope ? a.scope === filter.scope : true))
      .map((a) => this.meta(a));
  }

  // ── 锚点链 ────────────────────────────────────────────────────

  async recordAnchorResult(result: AnchorRunResult): Promise<void> {
    this.anchorRuns.set(result.runId, result);
    await writeFile(
      join(this.anchorRunsDir, `${result.runId}.json`),
      JSON.stringify(result, null, 2),
      'utf8',
    );

    const link: AnchorLink = {
      anchorId: result.anchorId,
      runId: result.runId,
      contentHashes: result.contentHashes,
      verdict: result.verdict,
      findings: result.findings,
      method: result.method,
      authority: result.authority,
      at: result.at,
      durationMs: result.durationMs,
      ...(result.meta ? { meta: result.meta } : {}),
    };

    for (const id of result.subjects) {
      const a = this.cache.get(id);
      if (!a) continue;
      // 同一锚点的旧结论被新结论取代，避免链无限增长
      a.anchorChain = a.anchorChain.filter((l) => l.anchorId !== link.anchorId).concat(link);
      await this.persist(a);
    }
  }

  getAnchorRun(runId: RunId): AnchorRunResult | null {
    return this.anchorRuns.get(runId) ?? null;
  }

  /** 最新一次某锚点的结论（用于证据核验与 Gate 判定）。 */
  latestAnchorRun(anchorId: string): AnchorRunResult | null {
    const runs = [...this.anchorRuns.values()]
      .filter((r) => r.anchorId === anchorId)
      .sort((a, b) => a.at.localeCompare(b.at));
    return runs[runs.length - 1] ?? null;
  }

  /**
   * 把内容 hash 已变化的工件的锚点结论标记为 STALE。
   * 这是「不许用旧的绿灯照亮新的代码」的实现。
   */
  async refreshStaleness(): Promise<number> {
    let changed = 0;
    for (const a of this.cache.values()) {
      for (const link of a.anchorChain) {
        const recorded = link.contentHashes[a.id];
        if (recorded && recorded !== a.contentHash && link.verdict !== 'STALE') {
          link.verdict = 'STALE';
          link.findings = [
            {
              code: 'stale-anchor',
              severity: 'warn',
              message: `工件内容已变更（${recorded.slice(0, 8)} → ${a.contentHash.slice(0, 8)}），本锚点结论失效，必须重跑`,
            },
          ];
          changed++;
          await this.persist(a);
        }
      }
    }
    return changed;
  }

  /** 该工件当前有效的锚点结论（STALE 的视为无结论）。 */
  freshAnchorsOf(id: ArtifactId): AnchorLink[] {
    const a = this.cache.get(id);
    if (!a) return [];
    return a.anchorChain.filter((l) => l.verdict !== 'STALE' && l.contentHashes[id] === a.contentHash);
  }

  // ── 内部 ──────────────────────────────────────────────────────

  /**
   * 决定这次写入归属哪个「逻辑工件」。
   *
   * 单例类工件（需求集/PRD/任务图/契约）每个项目只有一个逻辑工件，新内容产生新版本。
   * 多例类工件（代码模块/测试套件）每次写入默认是新的逻辑工件，
   * 需要接续版本时必须显式传 logicalId —— 否则「改一个模块」会被误当成「新增一个模块」。
   */
  private resolveLogicalId(kind: ArtifactKind): string {
    if (SINGLETON_KINDS.includes(kind)) {
      const h = this.head(kind);
      if (h) return baseLogicalId(h.id);
    }
    return this.nextLogicalId(kind);
  }

  private nextLogicalId(kind: ArtifactKind): string {
    const next = (this.counter[kind] ?? 0) + 1;
    this.counter[kind] = next;
    void writeFile(join(this.artifactsDir, '.counter.json'), JSON.stringify(this.counter, null, 2), 'utf8');
    return `${kind}-${String(next).padStart(3, '0')}`;
  }

  private tailOf(logicalId: string): ArtifactId[] {
    const versions = [...this.cache.values()]
      .filter((a) => a.id === logicalId || a.id.startsWith(`${logicalId}@v`))
      .sort((a, b) => b.version - a.version);
    return versions.length > 0 ? [versions[0].id] : [];
  }

  private async persist(a: Artifact): Promise<void> {
    const dir = join(this.artifactsDir, a.kind);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${a.id}.json`), JSON.stringify(a, null, 2), 'utf8');
  }

  async destroy(): Promise<void> {
    this.cache.clear();
    this.anchorRuns.clear();
    await rm(this.artifactsDir, { recursive: true, force: true });
    await rm(this.anchorRunsDir, { recursive: true, force: true });
  }
}

/** 去掉版本后缀，得到逻辑工件标识。`PRD-001@v2` → `PRD-001`。 */
export function baseLogicalId(id: ArtifactId): string {
  const i = id.indexOf('@v');
  return i === -1 ? id : id.slice(0, i);
}

function titleOf(a: Artifact): string {  const c = a.content as Record<string, unknown> | null;
  if (c && typeof c === 'object') {
    if (typeof c.title === 'string') return c.title;
    if (typeof c.summary === 'string') return String(c.summary).slice(0, 60);
    if (Array.isArray(c.files) && c.files.length > 0) {
      const first = c.files[0] as { path?: string };
      return `${c.files.length} 个文件 · ${first.path ?? ''}`;
    }
    if (Array.isArray(c.requirements)) return `${c.requirements.length} 条需求`;
    if (Array.isArray(c.tasks)) return `${c.tasks.length} 个任务`;
    if (typeof c.kind === 'string') return `建议书(${c.kind})`;
  }
  return a.kind;
}

/** 把角色产出的文件落到磁盘。锚点直接检查这些真实文件，而不是工件里的字符串。 */
export async function materializeFiles(
  projectRoot: string,
  files: Array<{ path: string; content: string }>,
): Promise<string[]> {
  const written: string[] = [];
  for (const f of files) {
    const abs = join(projectRoot, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, 'utf8');
    written.push(f.path);
  }
  return written;
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export { sha256 };
