/**
 * 调用录制与离线回放。
 *
 * docs/01 §7：**没有回放，就无法判断一次失败是模型问题还是编排问题。**
 *
 * 多智能体系统最难调试的地方在于不确定性：同样的 prompt 这次跑通下次跑不通。
 * 录制把每次调用的（prompt hash + 完整响应）落成 jsonl，
 * 回放时用 `ReplayProvider` 顶掉真实 Provider —— 于是同一次 run 可以：
 *   - 零成本重跑（调参数、改编排逻辑，不用重新花钱）
 *   - 确定性复现（断言「同样的输入必然得到同样的裁决」）
 *   - 取证（出问题时翻出当时的原始响应，而不是猜模型说了什么）
 *
 * 回放匹配用「purpose + prompt hash + attempt」三元组，并且每个键维护一个 FIFO 队列 ——
 * 因为同一个 prompt 在一次 run 里被合法地调用多次是完全正常的
 * （例如两张内容相同的工单），只用 hash 做键会把它们错配。
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, stableStringify } from '../../core/src/hash.ts';
import type { LlmCallRecord, LlmCapabilities, LlmProvider, LlmRequest, LlmResponse } from './types.ts';

export function promptHashOf(req: LlmRequest): string {
  return sha256(
    stableStringify({
      role: req.role,
      purpose: req.purpose,
      messages: req.messages,
      schemaName: req.schemaName,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      model: req.model,
      attempt: req.attempt ?? 0,
    }),
  );
}

export function replayKey(req: LlmRequest): string {
  return `${req.purpose}|${promptHashOf(req)}|${req.attempt ?? 0}`;
}

/** 把调用记录写成 jsonl，一个 run 一个文件。 */
export class JsonlRunRecorder {
  readonly dir: string;
  private runId: string;
  private file: string;
  private pending: LlmCallRecord[] = [];
  private seq = 0;
  private ready = false;

  constructor(dir: string, runId: string) {
    this.dir = dir;
    this.runId = runId;
    this.file = join(dir, `${runId}.jsonl`);
  }

  get path(): string {
    return this.file;
  }

  private async ensure(): Promise<void> {
    if (this.ready) return;
    await mkdir(this.dir, { recursive: true });
    this.ready = true;
  }

  async record(args: {
    request: LlmRequest;
    response: LlmResponse;
    error?: string;
  }): Promise<LlmCallRecord> {
    await this.ensure();
    this.seq++;
    const rec: LlmCallRecord = {
      runId: this.runId,
      seq: this.seq,
      at: new Date().toISOString(),
      provider: args.response.provider,
      model: args.response.model,
      role: args.request.role,
      purpose: args.request.purpose,
      attempt: args.request.attempt ?? 0,
      promptHash: promptHashOf(args.request),
      ...(args.request.temperature !== undefined ? { temperature: args.request.temperature } : {}),
      ...(args.request.maxTokens !== undefined ? { maxTokens: args.request.maxTokens } : {}),
      // 记录下来，才能在事后回答「这次调用到底有没有声明结构化输出契约」
      structured: args.request.schema !== undefined,
      ...(args.request.schemaName !== undefined ? { schemaName: args.request.schemaName } : {}),
      response: {
        text: args.response.text,
        ...(args.response.json !== undefined ? { json: args.response.json } : {}),
        ...(args.response.usage ? { usage: args.response.usage } : {}),
        ...(args.response.parseError ? { parseError: args.response.parseError } : {}),
        ...(args.response.finishReason ? { finishReason: args.response.finishReason } : {}),
      },
      latencyMs: args.response.latencyMs,
    };
    await appendFile(this.file, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  /** 记录一次失败的调用（响应体不存在，但「走没走到模型」这件事本身是重要证据）。 */
  async recordFailure(args: { request: LlmRequest; error: string }): Promise<void> {
    await this.ensure();
    this.seq++;
    const rec: LlmCallRecord = {
      runId: this.runId,
      seq: this.seq,
      at: new Date().toISOString(),
      provider: '(failed)',
      model: args.request.model ?? '(default)',
      role: args.request.role,
      purpose: args.request.purpose,
      attempt: args.request.attempt ?? 0,
      promptHash: promptHashOf(args.request),
      structured: args.request.schema !== undefined,
      ...(args.request.schemaName !== undefined ? { schemaName: args.request.schemaName } : {}),
      response: { text: '', parseError: args.error },
      latencyMs: 0,
    };
    await appendFile(this.file, JSON.stringify(rec) + '\n', 'utf8');
  }
}

export type RecordingProviderOptions = {
  inner: LlmProvider;
  recorder: JsonlRunRecorder;
};

/** 包装任意 Provider，把每次调用落盘。 */
export class RecordingProvider implements LlmProvider {
  readonly name: string;
  private inner: LlmProvider;
  private recorder: JsonlRunRecorder;

  constructor(opts: RecordingProviderOptions) {
    this.inner = opts.inner;
    this.recorder = opts.recorder;
    this.name = opts.inner.name;
  }

  capabilities(): Promise<LlmCapabilities> {
    return this.inner.capabilities();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.inner.complete(req);
      await this.recorder.record({ request: req, response: res });
      return res;
    } catch (e) {
      await this.recorder.recordFailure({ request: req, error: (e as Error).message });
      throw e;
    }
  }
}

export type ReplayMissPolicy = 'throw' | 'fallback';

export type ReplayProviderOptions = {
  records: LlmCallRecord[];
  /** 记录里没有对应条目时的行为。 */
  onMiss?: ReplayMissPolicy;
  /** onMiss='fallback' 时使用的真实 Provider。 */
  fallback?: LlmProvider;
};

export class ReplayMissError extends Error {
  key: string;
  constructor(key: string) {
    super(
      `回放缺少对应的调用记录：${key}\n` +
        `说明这次 run 走到了录制时没走过的分支（改过编排逻辑、或模型输出导致了不同的重试路径）。`,
    );
    this.name = 'ReplayMissError';
    this.key = key;
  }
}

/**
 * 离线回放 Provider。
 * 严格模式下（onMiss='throw'）任何未录制到的调用都会报错 ——
 * 这是刻意的：静默补一次真实调用会让「回放」失去确定性，
 * 而确定性正是回放存在的唯一理由。
 */
export class ReplayProvider implements LlmProvider {
  readonly name = 'replay';
  private queues = new Map<string, LlmCallRecord[]>();
  private onMiss: ReplayMissPolicy;
  private fallback?: LlmProvider;

  constructor(opts: ReplayProviderOptions) {
    for (const r of [...opts.records].sort((a, b) => a.seq - b.seq)) {
      const key = `${r.purpose}|${r.promptHash}|${r.attempt}`;
      const q = this.queues.get(key) ?? [];
      q.push(r);
      this.queues.set(key, q);
    }
    this.onMiss = opts.onMiss ?? 'throw';
    if (opts.fallback) this.fallback = opts.fallback;
  }

  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  async capabilities(): Promise<LlmCapabilities> {
    return { jsonSchema: 'strict', toolCalling: false, streaming: false };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = replayKey(req);
    const q = this.queues.get(key);
    const rec = q?.shift();

    if (!rec) {
      if (this.onMiss === 'fallback' && this.fallback) return this.fallback.complete(req);
      throw new ReplayMissError(key);
    }

    return {
      provider: `replay(${rec.provider})`,
      model: rec.model,
      text: rec.response.text,
      ...(rec.response.json !== undefined ? { json: rec.response.json } : {}),
      ...(rec.response.usage ? { usage: rec.response.usage } : {}),
      latencyMs: 0,
      runId: `replay-${rec.runId}-${rec.seq}`,
      ...(rec.response.parseError ? { parseError: rec.response.parseError } : {}),
      ...(rec.response.finishReason ? { finishReason: rec.response.finishReason } : {}),
    };
  }
}

/** 从 runs/ 目录读一次 run 的全部记录。 */
export async function loadRunRecords(runsDir: string, runId: string): Promise<LlmCallRecord[]> {
  const file = join(runsDir, `${runId}.jsonl`);
  if (!existsSync(file)) throw new Error(`找不到 run 记录：${file}`);
  const raw = await readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LlmCallRecord);
}

/** 列出 runs/ 下所有可回放的 run。 */
export async function listRuns(runsDir: string): Promise<Array<{ runId: string; calls: number; bytes: number }>> {
  if (!existsSync(runsDir)) return [];
  const out: Array<{ runId: string; calls: number; bytes: number }> = [];
  for (const f of await readdir(runsDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = await readFile(join(runsDir, f), 'utf8');
    out.push({
      runId: f.replace(/\.jsonl$/, ''),
      calls: raw.split('\n').filter((l) => l.trim().length > 0).length,
      bytes: Buffer.byteLength(raw, 'utf8'),
    });
  }
  return out.sort((a, b) => a.runId.localeCompare(b.runId));
}
