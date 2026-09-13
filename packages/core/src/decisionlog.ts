/**
 * 决策日志：append-only + 哈希链。
 *
 * 不变量（docs/01-architecture.md §6 第 9 条）：历史只增不改。
 * 每条记录含前一条的 hash，任何对历史的篡改都会在 verify() 时暴露。
 *
 * 人类的建议书、主理人的异议与裁决、带债记录、契约变更，全部写在这里 ——
 * 「角色之间不存在未记录的共识」这条不变量靠它落地。
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, stableStringify } from './hash.ts';

export type DecisionKind =
  | 'run.started'
  | 'stage.entered'
  | 'artifact.published'
  | 'artifact.frozen'
  | 'anchor.result'
  | 'objection.raised'
  | 'objection.arbitrated'
  | 'ledger.updated'
  | 'workorder.created'
  | 'roundtable.closed'
  | 'escalation.human'
  | 'debt.recorded'
  | 'directive.received'
  | 'gate.evaluated'
  | 'run.finished';

export type DecisionEntry = {
  seq: number;
  at: string;
  kind: DecisionKind;
  payload: unknown;
  prevHash: string;
  hash: string;
};

export const GENESIS_HASH = '0'.repeat(64);

function entryHash(prevHash: string, body: { seq: number; at: string; kind: string; payload: unknown }): string {
  return sha256(prevHash + stableStringify(body));
}

export class DecisionLog {
  readonly path: string;
  private entries: DecisionEntry[] = [];

  constructor(workspaceRoot: string) {
    this.path = join(workspaceRoot, 'decisions.jsonl');
  }

  async init(): Promise<void> {
    await mkdir(join(this.path, '..'), { recursive: true });
    if (existsSync(this.path)) {
      const raw = await readFile(this.path, 'utf8');
      this.entries = raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as DecisionEntry);
    } else {
      await writeFile(this.path, '', 'utf8');
    }
  }

  get length(): number {
    return this.entries.length;
  }

  get lastHash(): string {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1].hash : GENESIS_HASH;
  }

  async append(kind: DecisionKind, payload: unknown): Promise<DecisionEntry> {
    const seq = this.entries.length + 1;
    const at = new Date().toISOString();
    const prevHash = this.lastHash;
    const body = { seq, at, kind, payload };
    const entry: DecisionEntry = { ...body, prevHash, hash: entryHash(prevHash, body) };
    this.entries.push(entry);
    await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  all(): readonly DecisionEntry[] {
    return this.entries;
  }

  /** 校验哈希链完整性。返回第一处断裂的位置。 */
  async verify(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number; reason: string }> {
    const raw = existsSync(this.path) ? await readFile(this.path, 'utf8') : '';
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    let prev = GENESIS_HASH;
    for (let i = 0; i < lines.length; i++) {
      const e = JSON.parse(lines[i]) as DecisionEntry;
      if (e.seq !== i + 1) return { ok: false, brokenAtSeq: e.seq, reason: `序号不连续（期望 ${i + 1}）` };
      if (e.prevHash !== prev) return { ok: false, brokenAtSeq: e.seq, reason: 'prevHash 与上一条不匹配' };
      const expect = entryHash(prev, { seq: e.seq, at: e.at, kind: e.kind, payload: e.payload });
      if (expect !== e.hash) return { ok: false, brokenAtSeq: e.seq, reason: '记录内容被篡改（hash 不匹配）' };
      prev = e.hash;
    }
    return { ok: true };
  }

  find(kind: DecisionKind): DecisionEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }
}
