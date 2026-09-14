/**
 * 幻觉靶场 · 骨架。
 *
 * 目的：把「锚点到底好不好」从**断言**变成**数据**。
 * 在此之前我们只能说「A2 能抓出幻觉符号」（因为有测试），
 * 但说不出它的**检出率**与**误报率** —— 而防幻觉机制的价值完全由这两个数字决定。
 *
 * ── 设计要点一：必须有干净对照组 ──
 *
 * 只测「能不能抓出问题」是没有意义的：一个永远返回 FAIL 的锚点检出率是 100%。
 * 所以每个类别都要配**干净样本**，测量「它会不会把正确的东西判成错的」。
 * 在锚点这事上，误报和漏报**同样有害**：
 *   - 漏报 → 幻觉通过（用户拿到坏代码）
 *   - 误报 → 把诚实代码判成幻觉，角色被派去修一个不存在的问题（浪费一轮，还可能把对的改成错的）
 *
 * ── 设计要点二：诚实记录样本的来源 ──
 *
 * 这些样本是**我手写的**，所以它测的是「锚点能不能抓出我想到的这类幻觉」，
 * 而不是「锚点能不能抓出真实世界里的所有幻觉」。
 * 这个区别必须写在报告里 —— 否则就是拿自己出的题证明自己会做。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  AnchorId,
  AnchorVerdict,
  ArtifactKind,
  CodeScope,
  ProjectProfile,
} from '../../core/src/types.ts';
import { ArtifactStore } from '../../core/src/store.ts';
import { createAnchorContext, runAnchors, ANCHOR_INDEX, type SemanticProposals } from '../src/index.ts';
import { silentLogger } from '../../core/src/logger.ts';
// ════════════════════════════════════════════════════════════════
// 样本定义
// ════════════════════════════════════════════════════════════════

export type Expectation =
  | { kind: 'detect'; anchorId: AnchorId; atLeast: 'WARN' | 'FAIL' }
  /**
   * 「必须明确表示未验证」：锚点**不得**报 PASS，且必须给出说明。
   *
   * 这一档是靶场跑起来之后才补上的 —— 一开始我把「工具链缺失」也归进 `detect/WARN`，
   * 于是 A4/A5 被判成漏报。但锚点的行为其实是对的：
   * 它报 `SKIPPED` 并附一条 warn 说明「未验证 ≠ 通过」。
   *
   * 把「诚实跳过」单独作为一档，测的才是那条真正的不变量：
   * **SKIPPED ≠ PASS** —— 而不是「它必须报 FAIL」。
   * 这两件事差别很大：前者是设计原则，后者只是严重度分类。
   */
  | { kind: 'not-pass'; anchorId: AnchorId }
  /** 干净样本：**任何**被检查的锚点都不该报硬失败。 */
  | { kind: 'clean' };

export type BenchContext = {
  root: string;
  store: ArtifactStore;
  /** 写一个项目文件。 */
  file(rel: string, content: string): Promise<void>;
  /** 写 package.json。 */
  pkg(json: Record<string, unknown>): Promise<void>;
  /** 造一个已安装的假 npm 包（含真实 .d.ts —— A2 必须读到它才能判断符号存不存在）。 */
  npm(pkgName: string, opts: { version?: string; dts?: string; js?: string }): Promise<void>;
  /** 发布一个工件。 */
  artifact(spec: { kind: ArtifactKind; producer: string; content: unknown; scope?: CodeScope }): Promise<string>;
};

export type BenchSample = {
  id: string;
  /** 分组：对应锚点领域。 */
  group: string;
  /** 人类可读的标题。 */
  title: string;
  /** 注入的「幻觉」长什么样（人类可读）。干净样本写「无 —— 对照组」。 */
  injection: string;
  /** 只跑这些锚点（跑全套会引入无关噪声）。 */
  anchors: AnchorId[];
  expect: Expectation;
  /**
   * 已知缺口：明确记录「这条样本当前抓不到，原因是什么」。
   *
   * 存在的意义是让「诚实记录未解决项」与「CI 变红」不必二选一：
   * 有了它，你可以把一个已知弱点写进靶场（它仍会出现在报告里、仍计入检出率），
   * 但不会让测试挂掉 —— 前提是你**必须写下原因**。
   * 没有这个字段的样本一旦漏报，测试就会失败。
   */
  knownLimitation?: string;
  /** profile 覆盖（默认给一套确定性命令）。 */
  profile?: Partial<ProjectProfile>;
  /** B 层锚点的输入提议（B1 需要；A 层样本不需要）。 */
  proposals?: SemanticProposals;
  build(ctx: BenchContext): Promise<void>;
};

// ════════════════════════════════════════════════════════════════
// 结果与指标
// ════════════════════════════════════════════════════════════════

export type Outcome = 'TP' | 'FN' | 'FP' | 'TN' | 'SEVERITY_MISMATCH';

export type SampleResult = {
  sample: BenchSample;
  verdicts: Array<{ anchorId: AnchorId; verdict: AnchorVerdict; failCount: number; warnCount: number; firstFinding?: string }>;
  outcome: Outcome;
  detail: string;
  durationMs: number;
};

export type AnchorMetrics = {
  anchorId: AnchorId;
  /** 期望被这个锚点抓到的样本数（阳性样本）。 */
  positives: number;
  detected: number;
  missed: number;
  /** 干净样本里这个锚点报硬失败的次数。 */
  falsePositives: number;
  /** 干净样本总数（分母）。 */
  negatives: number;
  /** 严重度不符：期望 WARN，实际 FAIL（或反之）。 */
  severityMismatch: number;
  recall: number;
  /** 在干净样本上的「清白率」= 1 - 误报率。 */
  specificity: number;
  avgMs: number;
};

export type BenchSummary = {
  results: SampleResult[];
  metrics: Map<AnchorId, AnchorMetrics>;
  totals: { samples: number; clean: number; injected: number; tp: number; fn: number; fp: number; tn: number; mismatch: number };
  /** 无硬失败的干净样本数 / 干净样本总数 —— 最重要的一个数字。 */
  cleanPassRate: number;
  /** 被注入的幻觉里，有硬失败结果的比例。 */
  detectionRate: number;
  at: string;
};

const SEVERITY_RANK: Record<string, number> = { PASS: 0, WARN: 1, FAIL: 2, INVALID_EVIDENCE: 2, STALE: 0, SKIPPED: 0 };

export function isHardFailure(v: AnchorVerdict): boolean {
  return v === 'FAIL' || v === 'INVALID_EVIDENCE';
}

// ════════════════════════════════════════════════════════════════
// 运行器
// ════════════════════════════════════════════════════════════════

export type RunBenchOptions = {
  /** 每个样本的独立工作区由调用方提供（通常用临时目录）。 */
  makeRoot(): Promise<string>;
  cleanupRoot(root: string): Promise<void>;
  offline?: boolean;
  onProgress?: (done: number, total: number, sample: BenchSample) => void;
};

export function defaultProfile(over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: 'bench',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: null,
    test: null,
    run: null,
    knownPackages: ['lodash', 'express', 'react', 'zod', 'axios'],
    dependencyAllowlist: null,
    ...over,
  };
}

function makeContext(root: string, store: ArtifactStore, profile: ProjectProfile): BenchContext {
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  };
  return {
    root,
    store,
    file: write,
    pkg: (json) => write('package.json', JSON.stringify(json, null, 2)),
    npm: async (pkgName, opts) => {
      const dir = join('node_modules', ...pkgName.split('/'));
      await write(
        join(dir, 'package.json'),
        JSON.stringify(
          {
            name: pkgName,
            version: opts.version ?? '1.0.0',
            ...(opts.dts ? { types: 'index.d.ts' } : {}),
            main: 'index.js',
          },
          null,
          2,
        ),
      );
      await write(join(dir, 'index.d.ts'), opts.dts ?? 'export declare const placeholder: string;\n');
      await write(join(dir, 'index.js'), opts.js ?? 'exports.placeholder = "x";\n');
    },
    artifact: async (spec) => {
      const a = await store.put({
        kind: spec.kind,
        producer: spec.producer as never,
        content: spec.content,
        ...(spec.scope ? { scope: spec.scope } : {}),
      });
      return a.id;
    },
  };
}

/**
 * 跑一个样本。
 *
 * 判定规则刻意做得**保守**：只有「期望被 A 抓到，结果 A 没报 FAIL」才算漏报（FN）；
 * 只要有一个锚点报了硬失败，干净样本就算误报（FP）——
 * 因为对使用者来说，无论哪个锚点误报，代价是一样的（都会派出一张不该派的工单）。
 */
export async function runSample(sample: BenchSample, opts: RunBenchOptions): Promise<SampleResult> {
  const root = await opts.makeRoot();
  const started = Date.now();
  try {
    const store = new ArtifactStore(root);
    await store.init();
    const profile = defaultProfile(sample.profile);
    const ctx = makeContext(root, store, profile);

    await sample.build(ctx);

    const anchorCtx = createAnchorContext({
      projectRoot: root,
      store,
      profile,
      logger: silentLogger('bench'),
      offline: opts.offline ?? true,
      proposals: sample.proposals ?? {},
      runPrefix: `bench-${sample.id}`,
    });

    const anchors = sample.anchors.map((id) => ANCHOR_INDEX.get(id)!).filter(Boolean);
    const results = await runAnchors(anchorCtx, anchors);

    const verdicts = results.map((r) => ({
      anchorId: r.anchorId,
      verdict: r.verdict,
      failCount: r.findings.filter((f) => f.severity === 'fail').length,
      warnCount: r.findings.filter((f) => f.severity === 'warn').length,
      firstFinding: r.findings[0]?.message,
    }));

    return {
      sample,
      verdicts,
      ...classify(sample, verdicts, results),
      durationMs: Date.now() - started,
    };
  } finally {
    await opts.cleanupRoot(root);
  }
}

function classify(
  sample: BenchSample,
  verdicts: SampleResult['verdicts'],
  results: Array<{ anchorId: AnchorId; verdict: AnchorVerdict; findings: Array<{ severity: string; message: string }> }>,
): { outcome: Outcome; detail: string } {
  if (sample.expect.kind === 'clean') {
    const offenders = results.filter((r) => isHardFailure(r.verdict));
    if (offenders.length === 0) {
      return { outcome: 'TN', detail: '无硬失败（正确）' };
    }
    return {
      outcome: 'FP',
      detail: `干净样本被误判：${offenders
        .map((o) => `${o.anchorId}(${o.findings.filter((f) => f.severity === 'fail').map((f) => f.message)[0] ?? ''})`)
        .join('; ')
        .slice(0, 300)}`,
    };
  }

  if (sample.expect.kind === 'not-pass') {
    // 必须先取到局部变量：类型收窄**不会传播进回调**（编译器无法证明
    // 在 find 执行期间 sample.expect 没被改过），所以直接在闭包里访问
    // `sample.expect.anchorId` 是过不了类型检查的 —— 而运行时完全正常。
    const wantId = sample.expect.anchorId;
    const actual = results.find((r) => r.anchorId === wantId);
    if (!actual) return { outcome: 'FN', detail: `样本未运行期望的锚点 ${wantId}` };
    // 不变量：不得声称通过，且必须留下说明（否则用户看到的是一个没有理由的绿灯）
    const explains = actual.findings.length > 0;
    if (actual.verdict !== 'PASS' && explains) {
      return {
        outcome: 'TP',
        detail: `${actual.anchorId} → ${actual.verdict}，并说明：${actual.findings[0]?.message.slice(0, 90) ?? ''}`,
      };
    }
    if (actual.verdict === 'PASS') {
      return { outcome: 'FN', detail: `违反了 SKIPPED ≠ PASS：未验证却报了 PASS` };
    }
    return { outcome: 'FN', detail: `报 ${actual.verdict} 但没有给出任何说明 —— 用户看到的是没有理由的结论` };
  }

  const want = sample.expect as { anchorId: AnchorId; atLeast: 'WARN' | 'FAIL' };
  const actual = verdicts.find((v) => v.anchorId === want.anchorId);
  if (!actual) return { outcome: 'FN', detail: `样本未运行期望的锚点 ${want.anchorId}` };

  const got = SEVERITY_RANK[actual.verdict] ?? 0;
  const need = SEVERITY_RANK[want.atLeast] ?? 1;

  if (got < need) {
    return {
      outcome: 'FN',
      detail: `漏报：期望 ${want.anchorId} ≥ ${want.atLeast}，实际 ${actual.verdict}${
        actual.firstFinding ? `（${actual.firstFinding.slice(0, 160)}）` : ''
      }`,
    };
  }
  if (got > need) {
    return { outcome: 'SEVERITY_MISMATCH', detail: `已检出但严重度更高：期望 ≥ ${want.atLeast}，实际 ${actual.verdict}` };
  }
  return { outcome: 'TP', detail: `${actual.anchorId} → ${actual.verdict}（符合期望）` };
}

export async function runBenchmark(samples: BenchSample[], opts: RunBenchOptions): Promise<BenchSummary> {
  const results: SampleResult[] = [];
  let done = 0;
  for (const s of samples) {
    results.push(await runSample(s, opts));
    done++;
    opts.onProgress?.(done, samples.length, s);
  }

  const metrics = new Map<AnchorId, AnchorMetrics>();
  const ensure = (id: AnchorId): AnchorMetrics => {
    let m = metrics.get(id);
    if (!m) {
      m = { anchorId: id, positives: 0, detected: 0, missed: 0, falsePositives: 0, negatives: 0, severityMismatch: 0, recall: 1, specificity: 1, avgMs: 0 };
      metrics.set(id, m);
    }
    return m;
  };

  const times = new Map<AnchorId, number[]>();

  for (const r of results) {
    for (const v of r.verdicts) {
      const m = ensure(v.anchorId);
      if (r.sample.expect.kind === 'clean') {
        m.negatives++;
        if (isHardFailure(v.verdict)) m.falsePositives++;
      } else {
        const targetId = r.sample.expect.kind === 'detect' ? r.sample.expect.anchorId : r.sample.expect.anchorId;
        if (targetId === v.anchorId) {
          m.positives++;
          if (r.outcome === 'TP') m.detected++;
          else if (r.outcome === 'FN') m.missed++;
          else if (r.outcome === 'SEVERITY_MISMATCH') {
            m.detected++;
            m.severityMismatch++;
          }
        }
      }
      const t = times.get(v.anchorId) ?? [];
      t.push(r.durationMs);
      times.set(v.anchorId, t);
    }
  }

  for (const m of metrics.values()) {
    m.recall = m.positives === 0 ? 1 : m.detected / m.positives;
    m.specificity = m.negatives === 0 ? 1 : 1 - m.falsePositives / m.negatives;
    const t = times.get(m.anchorId) ?? [];
    m.avgMs = t.length === 0 ? 0 : Math.round(t.reduce((a, b) => a + b, 0) / t.length);
  }

  const clean = results.filter((r) => r.sample.expect.kind === 'clean');
  const injected = results.filter((r) => r.sample.expect.kind !== 'clean');

  return {
    results,
    metrics,
    totals: {
      samples: results.length,
      clean: clean.length,
      injected: injected.length,
      tp: results.filter((r) => r.outcome === 'TP').length,
      fn: results.filter((r) => r.outcome === 'FN').length,
      fp: results.filter((r) => r.outcome === 'FP').length,
      tn: results.filter((r) => r.outcome === 'TN').length,
      mismatch: results.filter((r) => r.outcome === 'SEVERITY_MISMATCH').length,
    },
    cleanPassRate: clean.length === 0 ? 1 : clean.filter((r) => r.outcome === 'TN').length / clean.length,
    detectionRate:
      injected.length === 0 ? 1 : injected.filter((r) => r.outcome === 'TP' || r.outcome === 'SEVERITY_MISMATCH').length / injected.length,
    at: new Date().toISOString(),
  };
}
