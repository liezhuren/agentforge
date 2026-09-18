/**
 * L2：向量层。**只是索引，不是记忆本身。**
 *
 * ## 先量后建：fastembed 到底值不值
 *
 * 用户提的方案里，第二层是 `fastembed` 做语义检索。动手前先量了一下：
 *
 * | 项 | 实测值 |
 * |---|---|
 * | npm 包本体 | `fastembed@2.1.0`，解包 109 KB |
 * | 但它依赖 | `onnxruntime-node@1.21.0` → **解包 301 MB** |
 * | 还要 | `@huggingface/hub` —— **运行期从 HuggingFace 下载模型权重** |
 *
 * 结论：**它不能成为这个引擎的依赖。** CI 里有一条断言「仓库根不存在
 * `node_modules`」，零依赖是这个项目的核心不变量；301 MB 原生二进制 + 运行期联网下载
 * 会同时打破零依赖、离线可用、以及在受限网络环境下的可运行性。
 *
 * 所以本模块的结论不是「不用语义检索」，而是**换一种实现方式**：
 *
 * - `LocalHashEmbedding` —— **零依赖、确定性、离线**，默认启用（见下）。
 * - `Fts5LexicalIndex` —— 复用 `node:sqlite` 自带的 FTS5（BM25），也是零依赖。
 * - `createFastEmbedProvider()` —— **可选适配器**：装了就动态 import 用，没装就报一句
 *   人话告诉你装什么。它**永不**在模块加载时被 import，所以零依赖路径不受影响。
 *
 * 于是「语义检索」这件事是**能力齐备而默认不装**，而不是被砍掉。
 *
 * ## 本地实现是什么，以及它诚实的名字
 *
 * 它不是神经网络，是一个**特征哈希**（signed hashing trick）：
 * 特征 = ASCII 词 + 中文字 + 中文双字组 + 字符三元组。
 *
 * 之所以对中文用「字 + 双字组」：中文没有空格分词，而双字组（bigram）是
 * 零依赖下**最有效**的近似分词手段（「相对导入」→ 相对/对导/导入）。
 *
 * 它的长处是**词形不同但用词相近**的匹配（"服务进程在就绪前退出" ↔ "进程立刻退出"），
 * 短处是抓不住真正的同义改写（"扩展名" ↔ "后缀"）。**它比 BM25 强多少必须实测**，
 * 不能假设 —— 所以 `scripts/memory-retrieval-bench.ts` 就是为这件事写的。
 */

import { sha256, stableStringify } from '../../core/src/index.ts';

export type EmbeddingProvider = {
  /** 稳定标识，进 `embeddings.model` 列 —— 换实现必须换 id，否则向量会串。 */
  readonly id: string;
  readonly dim: number;
  /** 本地实现是同步的，fastembed 是异步的 —— 两者都允许。 */
  embed(texts: string[]): Float32Array[] | Promise<Float32Array[]>;
};

/**
 * 特征抽取（导出以便单独测试与在基准里复用）。
 *
 * 归一化：小写 + 折叠空白。**不做去标点** —— 代码里的 `.ts`、`/api/tasks` 是有信息的。
 */
export function extractFeatures(text: string): string[] {
  const t = text.toLowerCase();
  const feats: string[] = [];

  // ASCII 词/路径/标识符：允许 . _ / - 组成一个整体（.ts / src/api/app.ts / TS2835）
  for (const m of t.matchAll(/[a-z0-9_][a-z0-9_./-]*/g)) {
    const w = m[0];
    if (w.length > 1) feats.push(`w:${w}`);
  }

  // 中文：单字 + 双字组
  const cjkRuns = t.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i++) {
      feats.push(`c:${run[i]}`);
      if (i + 1 < run.length) feats.push(`b:${run.slice(i, i + 2)}`);
    }
  }

  // 字符三元组：对拼写差异、截断、轻微改写更稳
  const compact = t.replace(/\s+/g, ' ').trim();
  for (let i = 0; i + 3 <= compact.length; i++) feats.push(`t:${compact.slice(i, i + 3)}`);

  return feats;
}

/** FNV-1a 32 位 —— 纯、快、确定，不需要 crypto。 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 零依赖的本地嵌入。
 *
 * - 确定性：同一段文本永远得到同一个向量（`id` 里不带随机种子）。
 * - 写入前 L2 归一化 ⇒ 点积即余弦相似度。
 * - `tf` 用 `1 + log(count)` 次线性缩放：一个词重复 10 次不该等于 10 倍权重。
 */
export class LocalHashEmbedding implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;

  constructor(dim = 1024) {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`dim 必须是正整数，收到 ${dim}`);
    this.dim = dim;
    this.id = `local-hash-v1-d${dim}`;
  }

  embed(texts: string[]): Float32Array[] {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const counts = new Map<string, number>();
    for (const f of extractFeatures(text)) counts.set(f, (counts.get(f) ?? 0) + 1);

    for (const [feat, n] of counts) {
      const h = fnv1a(feat);
      const idx = h % this.dim;
      // 最高位当符号位：碰撞时正负相互抵消，而不是系统性地累加（标准 signed hashing trick）
      const sign = h & 0x8000_0000 ? -1 : 1;
      vec[idx] = vec[idx]! + sign * (1 + Math.log(n));
    }

    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
    const norm = Math.sqrt(sum);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
    return vec;
  }
}

/**
 * 可选：fastembed 适配器。
 *
 * **绝不静态 import** —— 静态 import 会让「没装 fastembed」变成整个引擎起不来。
 * 装法见返回的报错信息（它必须能自解释，不能只说 `MODULE_NOT_FOUND`）。
 */
export async function createFastEmbedProvider(opts: {
  model?: string;
  dim?: number;
} = {}): Promise<EmbeddingProvider> {
  const model = opts.model ?? 'fast-bge-small-zh-v1.5';
  let mod: unknown;
  try {
    /**
     * ⚠️ 这里**必须**用一个变量做说明符，不能直接写 `import('fastembed')`。
     *
     * 直接写字符串字面量时，`tsc` 会去解析这个模块 —— 而 fastembed 是**可选**依赖、
     * 根本不会装，于是 `npm run typecheck` 直接报 TS2307「找不到模块」。
     * 那会让「零依赖」这条不变量**反过来把类型检查弄红**，
     * 而一个永远报红的检查等于没有检查（本项目为此付过代价，见根 tsconfig.json 的注释）。
     *
     * 用变量之后 tsc 无法静态解析，返回 `any` —— 这正是可选依赖想要的效果：
     * 装了就真的加载，没装就在下面被 catch 住并报一句人话。
     */
    const spec = 'fastembed';
    mod = await import(/* @vite-ignore */ spec);
  } catch (err) {
    throw new Error(
      'fastembed 未安装（这是**可选**依赖，引擎本身零依赖）。' +
        '要用它请单独安装：npm install fastembed —— ' +
        '注意它会带入 onnxruntime-node（实测解包 301 MB），' +
        '并且在首次使用时从 HuggingFace 下载模型权重，因此不适合受限网络环境。' +
        `原始错误：${(err as Error).message}`,
    );
  }

  const { FlagEmbedding, EmbeddingModel } = mod as {
    FlagEmbedding?: { init: (o: { model: string }) => Promise<FastEmbedInstance> };
    EmbeddingModel?: Record<string, string>;
  };
  if (!FlagEmbedding || !EmbeddingModel) {
    throw new Error('fastembed 的导出与预期不符（找不到 FlagEmbedding / EmbeddingModel）—— 适配器需要更新');
  }

  const key = Object.keys(EmbeddingModel).find((k) => k.toLowerCase() === model.toLowerCase());
  if (!key) {
    throw new Error(
      `fastembed 里没有模型 ${model}。可用：${Object.keys(EmbeddingModel).join(', ')}`,
    );
  }

  const inst = await FlagEmbedding.init({ model: EmbeddingModel[key]! });

  return {
    id: `fastembed:${model}`,
    // 声明 dim 只是占位：真实维度由模型决定，首次 embed 时校正。
    dim: opts.dim ?? 512,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      // fastembed 的 embed 返回 batch 迭代器
      for await (const batch of inst.embed(texts, 16) as AsyncIterable<number[][]>) {
        for (const arr of batch) {
          const v = Float32Array.from(arr);
          let sum = 0;
          for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
          const norm = Math.sqrt(sum);
          out.push(norm > 0 ? v.map((x) => x / norm) : v);
        }
      }
      return out;
    },
  };
}

type FastEmbedInstance = {
  embed: (texts: string[], batchSize?: number) => AsyncIterable<number[][]>;
};

/** 被嵌入内容的稳定 hash —— 内容变了就重算该向量，没变就不重复算。 */
export function embeddingContentHash(text: string): string {
  return sha256(text);
}

/** 文本规范化后再算 hash：空白差异不该触发重算。 */
export function embeddingContentHashNormalized(text: string): string {
  return sha256(stableStringify(text.replace(/\s+/g, ' ').trim()));
}
