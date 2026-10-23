/**
 * 极小的 `.env` 加载器（**零依赖**）。
 *
 * ## 为什么它必须存在，而且必须这么小
 *
 * 项目的配置里写的是 `"apiKey": "${DEEPSEEK_API_KEY}"`，由 `expandEnv()` 在解析配置时
 * 从 `process.env` 展开（见 `packages/llm/src/registry.ts`）。
 * 也就是说 —— **`.env` 文件原本是不被读取的**：放一个 `.env` 进去不会有任何效果，
 * 只会在报错信息里看到「它没有被设置」。所以「配 env 文件」这件事，
 * 必须先有加载器，否则那个文件只是装饰。
 *
 * 为什么不用 `dotenv` 包：整个引擎的卖点是**零运行时依赖**（`packages/*` 不需要
 * `npm install`，Node 原生类型剥离直接跑，CI 里还有一条断言仓库根不存在 `node_modules`）。
 * 为一个「读 KEY=VALUE 文本」的需求引入依赖，会破坏这个不变量 ——
 * 而这个不变量本身是要在实际场景里经受考验的，破一次就再也立不回来。
 *
 * ## 它刻意不做的事（每一条都是取舍）
 *
 * - **不覆盖已经存在的环境变量。** 真实环境优先于文件 —— 这样 CI、临时覆盖
 *   （`$env:X=...; node ...`）和「在容器里注入」的行为都符合直觉。
 *   反过来（文件覆盖环境）会造成「我明明在命令行设了，为什么不生效」这类极难查的问题。
 * - **不做变量展开**（`A=${B}` 里的 `${B}` 原样保留）。展开会让「值里本来就有 `${`」
 *   的场合出错，而 secrets 里出现 `${` 并不罕见。
 * - **不解析多行值**。`.env` 里放 PEM 私钥这种用法本项目用不到（凭据类文件已被 gitignore）。
 * - **不递归进入子目录**，只读一个文件。路径由调用方决定。
 *
 * ## 安全约定
 *
 * `.env` **必须**在 `.gitignore` 里（已加）。本文件只负责读，不负责「别把密钥提交上去」——
 * 后者只能靠 gitignore + 提交前检查，不能靠记性。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 合法变量名（与 shell / `expandEnv` 的 `\$\{([A-Za-z_][A-Za-z0-9_]*)\}` 保持一致）。 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type DotEnvResult = {
  /** 实际注入到 process.env 的键数。 */
  loaded: number;
  /** 读到并解析成功的键名（不含被环境变量挡住的）。 */
  keys: string[];
  /** 因为「环境里已经有值」而没有被覆盖的键名。 */
  keptExisting: string[];
  /** 格式不合法、被跳过的行（`行号: 原因`），用于提示而不是静默丢弃。 */
  skipped: string[];
  /** 实际读取的文件绝对路径；没找到文件时为 null。 */
  file: string | null;
};

/**
 * 读取并注入 `.env`。
 *
 * 默认从 `process.cwd()` 找 `.env`。找不到文件不是错误 —— 返回 `file: null` 即可，
 * 因为「用真实环境变量」是完全合法的用法（CI 就是）。
 */
export function loadDotEnv(
  opts: { cwd?: string; file?: string; env?: NodeJS.ProcessEnv } = {},
): DotEnvResult {
  const env = opts.env ?? process.env;
  const file = resolve(opts.cwd ?? process.cwd(), opts.file ?? '.env');

  const out: DotEnvResult = { loaded: 0, keys: [], keptExisting: [], skipped: [], file: null };
  if (!existsSync(file)) return out;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    out.skipped.push(`读取失败：${(err as Error).message}`);
    return out;
  }
  out.file = file;

  // UTF-8 BOM 会让第一个键名变成 `\uFEFFKEY`，从而静默失效（本项目踩过 BOM 的坑）。

  // ⚠️ 关于 UTF-8 BOM：这里**刻意不写**显式的「剥 BOM」代码。
  //
  // 实测（Node 24）：`readFileSync(f,'utf8')` **不会**剥 BOM，首字符就是 U+FEFF。
  // 但下面那行 `raw.trim()` 会把它去掉 —— 因为按 ES 规范，`U+FEFF`（ZWNBSP）
  // 就属于 `WhiteSpace`，`String.prototype.trim()` 必须去掉它。
  //
  // 我最初写了 `if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);`，
  // 而变异测试显示：把它删掉之后**没有任何测试会失败**。原因就是 trim 已经覆盖。
  // 那种「看起来在处理边界、实际永远走不到」的代码，本项目明确反对
  // （见 `contractcodegen.ts` 里对一处恒真三元的批评）—— 它会让后来的人以为
  // 这里有两条分支可调。所以删掉，改成由测试守住这个行为
  // （`dotenv.test.ts` 的「带 BOM 时第一个键名仍然可用」）。
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const line = raw.trim();

    if (line === '' || line.startsWith('#')) continue;

    // 允许 `export KEY=VALUE`（从 shell 脚本里抄过来很常见）
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;

    const eq = body.indexOf('=');
    if (eq <= 0) {
      out.skipped.push(`${lineNo}: 不是 KEY=VALUE 形式`);
      continue;
    }

    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();

    if (!KEY_RE.test(key)) {
      out.skipped.push(`${lineNo}: 变量名不合法（${key}）`);
      continue;
    }

    // 去掉成对的包裹引号。只去一层，不处理转义 —— 见文件头的取舍说明。
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value[value.length - 1] === q) {
        value = value.slice(1, -1);
      }
    }

    if (env[key] !== undefined) {
      // 真实环境优先。记下来是为了能回答「我设了 .env 为什么没生效」。
      out.keptExisting.push(key);
      continue;
    }

    env[key] = value;
    out.keys.push(key);
    out.loaded++;
  }

  return out;
}

/** 把加载结果压成一行可打印的说明（给 CLI 用；**绝不打印值**）。 */
export function describeDotEnv(r: DotEnvResult): string {
  if (r.file === null) return '.env：未找到（使用当前环境变量）';
  const parts = ['.env：' + r.file];
  parts.push(`注入 ${r.loaded} 个变量${r.keys.length ? `（${r.keys.join(', ')}）` : ''}`);
  if (r.keptExisting.length) {
    parts.push(`保留已有值 ${r.keptExisting.length} 个（${r.keptExisting.join(', ')}）`);
  }
  if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 行：${r.skipped.join('；')}`);
  return parts.join('；');
}
