/**
 * 模块接口卡：把「别人写的代码」压成**接口**，而不是把全文塞进上下文。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 这个项目的核心设计是「把复杂任务切分成小任务，降低单个模型面对的上下文压力，
 * 且模型之间的信息传递只传接口」。但代码这一侧一直没有遵守这条规矩：
 * `READ_PERMISSIONS` 直接把 `CodeModule`（**完整源码**）开放给前后端与测试角色。
 *
 * 而预算装不下全文，于是真实行为变成「随机看不见任何人」——
 * 第 20 轮的后果就是 `app.ts` 的作者不知道 `papers.ts` 导出了 `handlePapersRoute`，
 * 28/39 条测试挂在 501 上（`docs/07 §P`）。
 *
 * 也就是说：两个极端都不对。
 *   - 给全文 → 违反切分原则，而且装不下就变成「随机看不见」
 *   - 不给   → 不可能接线
 *
 * 接口卡是第三条路：只给**导出符号的签名**（路径 + 名字 + 参数类型 + 返回类型），
 * 不给实现。实测 11 个模块的全部导出签名 ≈ 5 千字符，
 * 而它们的全文是 20 万字符 —— 相差 40 倍。
 *
 * 这也正是用户定的规则在代码层的落地：**传接口，不传实现**。
 *
 * ⚠️ 它是**确定性**的（纯文本抽取，零 LLM 调用），所以可以进 A 层事实锚的范畴。
 * 抽取宁可漏（认不出的声明就不列）也不能编造 —— 编出来的签名比没有更危险。
 */

const SKIP_EXPORT_RE = /^\s*export\s+(?:default\b|\*|\{)/;
const FUNC_RE = /^export\s+(?:declare\s+)?(?:async\s+)?function\b/;
const NAMED_TYPE_RE = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum)\b/;
const VAR_RE = /^export\s+(?:declare\s+)?(?:const|let|var)\b/;
const TYPE_ALIAS_RE = /^export\s+(?:declare\s+)?type\b/;

/** 括号配平（用来把跨行的函数签名拼回一行）。 */
function parenBalance(s: string): number {
  let n = 0;
  for (const c of s) {
    if (c === '(' || c === '[' || c === '<') n++;
    else if (c === ')' || c === ']' || c === '>') n--;
  }
  return n;
}

/** 找到「声明结束/函数体开始」的位置：函数取 `{`，变量取 `=`。 */
function signatureEnd(decl: string): number {
  const eq = decl.indexOf('=');
  const brace = decl.indexOf('{');
  if (VAR_RE.test(decl)) {
    if (eq >= 0) return eq;
    return decl.length;
  }
  if (FUNC_RE.test(decl) || NAMED_TYPE_RE.test(decl)) {
    // 函数体 `{` 出现在参数表闭合之后；接口/类的 `{` 就是声明体本身。
    // 两种情况都截在第一个 `{` —— 前提是这个 `{` 不在括号里（泛型/对象类型参数）。
    let depth = 0;
    for (let i = 0; i < decl.length; i++) {
      const c = decl[i]!;
      if (c === '(' || c === '[' || c === '<') depth++;
      else if (c === ')' || c === ']' || c === '>') depth--;
      else if (c === '{' && depth <= 0) return i;
    }
    return decl.length;
  }
  // `type X = ...`：整行都要（它是纯声明，没有函数体）
  if (TYPE_ALIAS_RE.test(decl)) return brace >= 0 && eq < 0 ? brace : decl.length;
  return decl.length;
}

/**
 * 抽取一个文件里所有**导出声明的签名**。
 *
 * 只认导出的函数 / 类 / 接口 / 枚举 / 类型别名 / 顶层常量。
 * 不认再导出（`export {x}`、`export * from`、`export default`）——
 * 它们本身不含实现信息，列出来只会占地方。
 */
export function extractExportedSignatures(content: string, maxLines = 60): string[] {
  const out: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const raw = lines[i]!;
    if (!/^\s*export\s/.test(raw)) continue;
    if (SKIP_EXPORT_RE.test(raw)) continue;

    let decl = raw.trim();
    // 跨行签名：一直拼到括号配平（最多再拼 12 行，防止病理输入把整文件读进来）
    let extra = 0;
    while (parenBalance(decl) > 0 && i + 1 < lines.length && extra < 12) {
      decl += ` ${lines[++i]!.trim()}`;
      extra++;
    }

    const end = signatureEnd(decl);
    decl = decl.slice(0, end).trimEnd().replace(/[,;]\s*$/, '');
    if (decl.length === 0 || decl === 'export') continue;
    if (!out.includes(decl)) out.push(decl);
    if (out.length >= maxLines) break;
  }
  return out;
}

export type ModuleFile = { path: string; content: string };

/**
 * 把一批代码工件渲染成「模块接口卡」文本。
 *
 * 输出形状刻意做成**可被模型直接照抄去接线**的样子：
 * 文件路径单独一行，签名一行一条。它不解释、不总结、不加形容词 ——
 * 任何一句话的解释都在消耗预算，而这里有价值的只有名字和类型。
 */
export function renderModuleCards(
  modules: Array<{ id: string; version: number; files: ModuleFile[] }>,
  opts: { maxLinesPerFile?: number; maxTotalChars?: number } = {},
): string {
  const maxLinesPerFile = opts.maxLinesPerFile ?? 60;
  const maxTotalChars = opts.maxTotalChars ?? 60_000;
  const chunks: string[] = [];

  for (const m of modules) {
    const lines: string[] = [];
    for (const f of m.files) {
      const sigs = extractExportedSignatures(f.content, maxLinesPerFile);
      if (sigs.length === 0) continue;
      lines.push(`@@ ${f.path}`);
      for (const s of sigs) lines.push(s);
    }
    if (lines.length === 0) continue;
    chunks.push(`@@@ 模块 ${m.id} v${m.version}\n${lines.join('\n')}`);
  }

  let text = chunks.join('\n\n');
  if (text.length > maxTotalChars) text = `${text.slice(0, maxTotalChars)}\n…（接口卡超出 ${maxTotalChars} 字符，已截断）`;
  return text;
}
