/**
 * A 层 · 事实锚（Fact Anchors）。
 *
 * 全部零 LLM 调用。任何一条 A 层 PASS 都必须来自可复现的机械检查。
 * 关键设计：锚点发现问题时同时给出 **机械归因 targetRole**，
 * 使编排器可以直接生成派工单，无需让 LLM 推断「这该怪谁」。
 */

import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  execCapture,
  probeCommand,
  readJsonOrNull,
  readTextOrNull,
  sha256,
  sliceLines,
  walkFiles,
} from '../../core/src/index.ts';
import type { AnchorFinding, Artifact, CodeModule, TestSuiteDoc, ContractDoc } from '../../core/src/types.ts';
import {
  attributeByArtifact,
  attributeByPath,
  editDistance,
  type Anchor,
  type AnchorContext,
  type AnchorOutcome,
} from './types.ts';
import { extractImports, splitBareSpecifier, type ImportRef } from './imports.ts';
import { collectExports, loadTypescript, resolvePackage } from './pkgresolve.ts';
// 与 execCapture 共用同一套「Windows 可执行解析 + shell 引号」逻辑。
// 各写一份必然漂移，而漂移的后果是「一个锚点能跑、另一个报 ENOENT」（见 docs/07 §L6）。
import { prepareSpawn } from '../../core/src/exec.ts';

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** 每个 ctx 内缓存一次导入抽取结果，避免 A1/A2/A3 各扫一遍。 */
const importsCache = new WeakMap<AnchorContext, Promise<ImportRef[]>>();

async function allImports(ctx: AnchorContext): Promise<ImportRef[]> {
  const cached = importsCache.get(ctx);
  if (cached) return cached;
  const p = (async () => {
    const files = (await ctx.sourceFiles()).filter((f) => SOURCE_EXT.some((e) => f.endsWith(e)));
    const out: ImportRef[] = [];
    for (const f of files) {
      const text = await ctx.readFile(f);
      if (text === null) continue;
      out.push(...extractImports(f, text));
    }
    return out;
  })();
  importsCache.set(ctx, p);
  return p;
}

/** 被 A 层检查的代码工件（用于把结论绑定到内容 hash）。 */
function codeArtifacts(ctx: AnchorContext): Artifact[] {
  return [...ctx.store.heads('CodeModule'), ...ctx.store.heads('TestSuite')];
}

function subjectsOf(ctx: AnchorContext): { ids: string[]; hashes: Record<string, string> } {
  const arts = codeArtifacts(ctx);
  return {
    ids: arts.map((a) => a.id),
    hashes: Object.fromEntries(arts.map((a) => [a.id, a.contentHash])),
  };
}

async function sourceTreeHash(ctx: AnchorContext): Promise<string> {
  const files = await ctx.sourceFiles();
  const parts: string[] = [];
  for (const f of files) {
    const t = await ctx.readFile(f);
    parts.push(`${f}:${sha256(t ?? '')}`);
  }
  return sha256(parts.join('\n'));
}

function worst(findings: AnchorFinding[], fallback: AnchorOutcome['verdict'] = 'PASS'): AnchorOutcome['verdict'] {
  if (findings.some((f) => f.severity === 'fail')) return 'FAIL';
  if (findings.some((f) => f.severity === 'warn')) return 'WARN';
  return fallback;
}

// ════════════════════════════════════════════════════════════════
// A1 · 包真实性
// ════════════════════════════════════════════════════════════════

const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export const A1: Anchor = {
  id: 'A1',
  title: '包真实性',
  layer: 'A',
  async run(ctx): Promise<AnchorOutcome> {
    const base = subjectsOf(ctx);
    const findings: AnchorFinding[] = [];
    const pkgPath = join(ctx.projectRoot, 'package.json');
    const pkg = await readJsonOrNull<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(pkgPath);

    if (!pkg) {
      return {
        verdict: 'SKIPPED',
        findings: [
          {
            code: 'no-package-json',
            severity: 'warn',
            message: '项目根没有 package.json，无法检查依赖真实性（未验证 ≠ 通过）',
          },
        ],
        method: 'package-json',
        authority: 'none',
        subjects: base.ids,
        contentHashes: base.hashes,
      };
    }

    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const names = Object.keys(deps);

    /**
     * 顺序很关键，这里踩过一个只有对抗样本才抓得到的坑。
     *
     * 第一版把「黑名单导入检查」放在 `names.length === 0 → return PASS` **之后**，
     * 于是「package.json 里干干净净、代码里却 import 了被禁的包」这种情况
     * 会在提前 return 处被短路掉，检查永远跑不到。
     *
     * 表面上看「没有声明任何依赖 → 没问题」是合理的，但这个前提对**导入**不成立：
     * 依赖可能来自间接依赖或安装在别处，而「不得引入 X」这条用户约束
     * 针对的是**代码里有没有用**，不是**manifest 里有没有写**。
     *
     * 所以：先把与「声明列表」无关的检查全部跑完，再决定要不要提前返回。
     */
    const imports = await allImports(ctx);
    const userOf = new Map<string, string>();
    for (const imp of imports) {
      if (!imp.isBare) continue;
      const { pkg: p } = splitBareSpecifier(imp.specifier);
      if (!userOf.has(p)) userOf.set(p, imp.file);
    }
    const roleOf = (pkgName: string) => {
      const f = userOf.get(pkgName);
      return f ? attributeByArtifact(ctx, f) : 'UNRESOLVED';
    };

    // 注意：`findings` 在 A1.run 开头就已声明（line ~94）。
    // 这里不要再声明一次 —— 同一作用域重复声明是运行期 SyntaxError，
    // 而它只在「真的 import 一次」时才暴露（类型检查抓不到，因为类型剥离前是合法的 JS 语法错误）。
    /**
     * 黑名单要检查**被 import 但没声明**的包。
     *
     * 只查 package.json 会漏掉一类真实情况：代码里 `import x from 'lodash'`，
     * 而 package.json 里根本没写（依赖装在了别处、或是间接依赖）。
     * 对「不得引入 lodash」这条约束来说，这两种情况一样是违规。
     * 白名单不需要这样补，因为「没声明的包」在白名单语义下本来就不是问题。
     */
    for (const denied of ctx.profile.deniedDependencies ?? []) {
      if (names.includes(denied)) continue; // 已在上面的循环里报过
      const imp = imports.find((i) => {
        if (!i.isBare) return false;
        return splitBareSpecifier(i.specifier).pkg === denied;
      });
      if (imp) {
        findings.push({
          code: 'forbidden-dependency',
          severity: 'fail',
          message: `${imp.file}:${imp.line} 导入了被真人建议书明确禁止的包 "${denied}"（它甚至没有声明在 package.json 里）`,
          file: imp.file,
          line: imp.line,
          targetRole: attributeByArtifact(ctx, imp.file),
          data: { name: denied, denied: ctx.profile.deniedDependencies, rule: 'deny' },
        });
      }
    }

    const nodeModulesExists = existsSync(join(ctx.projectRoot, 'node_modules'));

    // 声明列表为空时：只有在「与声明无关的检查」也没发现问题时才可以提前放行。
    // 早先这一句写在黑名单导入检查之前，于是「没声明依赖但代码里 import 了被禁包」
    // 会被静默放行 —— 幻觉靶场的对抗样本 A1-06 就是照这个缝插进来的。
    if (names.length === 0) {
      return {
        verdict: worst(findings, 'PASS'),
        findings,
        method: 'package-json + import-scan',
        authority: 'authoritative',
        subjects: base.ids,
        contentHashes: base.hashes,
        meta: { declared: 0, treeHash: await sourceTreeHash(ctx) },
      };
    }

    for (const name of names) {
      const role = roleOf(name);

      // 1) 用户约束白名单（来自建议书 constraint）。
      //    放在包名合法性之前，这样同一个幻觉包能被同时指出「非法名」与「违反约束」两件事。
      if (ctx.profile.dependencyAllowlist && !ctx.profile.dependencyAllowlist.includes(name)) {
        findings.push({
          code: 'disallowed-dependency',
          severity: 'fail',
          message: `依赖 "${name}" 不在用户约束白名单内（建议书 constraint 生效）`,
          targetRole: role,
          data: { name, allowlist: ctx.profile.dependencyAllowlist, rule: 'allow' },
        });
      }

      // 1b) 用户约束黑名单（「不得引入 X」）。
      //     与白名单的语义方向相反：白名单是封闭集合，黑名单是排除集合，两者可同时生效。
      if (ctx.profile.deniedDependencies?.includes(name)) {
        findings.push({
          code: 'forbidden-dependency',
          severity: 'fail',
          message: `依赖 "${name}" 被真人建议书明确禁止（constraint），但被声明在 package.json 里`,
          targetRole: role,
          data: { name, denied: ctx.profile.deniedDependencies, rule: 'deny' },
        });
      }

      // 2) 包名合法性 —— 确定性最强的幻觉信号（大写、空格、非法字符）
      if (!NPM_NAME_RE.test(name) || name.length > 214) {
        findings.push({
          code: 'invalid-package-name',
          severity: 'fail',
          message: `依赖名 "${name}" 不是合法的 npm 包名（必须小写、无空格、符合 npm 命名规则）—— 极可能是模型编造的包`,
          targetRole: role,
          data: { name, spec: deps[name] },
        });
        continue;
      }

      // 3) typo-squatting：与知名包编辑距离 ≤ 2 且非同名
      for (const known of ctx.profile.knownPackages) {
        if (name === known) continue;
        const a = name.includes('/') ? name.split('/')[1] : name;
        const b = known.includes('/') ? known.split('/')[1] : known;
        if (a.length < 4 || b.length < 4) continue;
        const d = editDistance(a, b);
        if (d > 0 && d <= 2) {
          findings.push({
            code: 'typosquat',
            severity: 'warn',
            message: `依赖 "${name}" 与知名包 "${known}" 名称高度相似（编辑距离 ${d}），可能是拼写错误或投毒包，需人工确认`,
            targetRole: roleOf(name),
            data: { name, known, distance: d },
          });
        }
      }

      // 4) 已声明但本地未安装
      if (nodeModulesExists && !existsSync(join(ctx.projectRoot, 'node_modules', name))) {
        findings.push({
          code: 'not-installed',
          severity: 'warn',
          message: `依赖 "${name}" 已声明但 node_modules 中不存在，无法核实其符号`,
          targetRole: roleOf(name),
          data: { name },
        });
      }
    }

    // 5) registry 远程核实（需要网络；离线时必须 WARN 而非 PASS）
    let remote = 'checked';
    if (ctx.offline) {
      remote = 'skipped-offline';
      findings.push({
        code: 'registry-unchecked',
        severity: 'warn',
        message: `离线模式：未向 registry 核实 ${names.length} 个依赖是否真实存在/是否已废弃。A1 结论为「本地检查通过，远端未验证」`,
      });
    } else {
      const remoteFindings = await checkRegistry(names, deps, roleOf);
      findings.push(...remoteFindings);
      if (remoteFindings.some((f) => f.code === 'registry-unreachable')) remote = 'unreachable';
    }

    return {
      verdict: worst(findings, 'PASS'),
      findings,
      method: 'npm-name-rules + typo-distance + local-install + registry',
      authority: ctx.offline ? 'approximate' : 'authoritative',
      subjects: base.ids,
      contentHashes: base.hashes,
      meta: { declared: names.length, registry: remote, treeHash: await sourceTreeHash(ctx) },
    };
  },
};

async function checkRegistry(
  names: string[],
  deps: Record<string, string>,
  roleOf: (p: string) => ReturnType<typeof attributeByPath>,
): Promise<AnchorFinding[]> {
  const findings: AnchorFinding[] = [];
  let unreachable = false;

  for (const name of names) {
    if (unreachable) break;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status === 404) {
        findings.push({
          code: 'missing-pkg',
          severity: 'fail',
          message: `依赖 "${name}" 在 npm registry 上不存在 —— 这是幻觉包`,
          targetRole: roleOf(name),
          data: { name, spec: deps[name] },
        });
        continue;
      }
      if (!res.ok) {
        unreachable = true;
        break;
      }
      const body = (await res.json()) as { deprecated?: string; versions?: Record<string, unknown> };
      if (body.deprecated) {
        findings.push({
          code: 'deprecated-pkg',
          severity: 'warn',
          message: `依赖 "${name}" 已被标记废弃：${body.deprecated}`,
          targetRole: roleOf(name),
          data: { name },
        });
      }
    } catch (err) {
      unreachable = true;
      findings.push({
        code: 'registry-unreachable',
        severity: 'warn',
        message: `无法访问 npm registry，${names.length} 个依赖的远端真实性未经验证：${(err as Error).message}`,
      });
    }
  }
  return findings;
}

// ════════════════════════════════════════════════════════════════
// A2 · 符号真实性
// ════════════════════════════════════════════════════════════════

export const A2: Anchor = {
  id: 'A2',
  title: '符号真实性',
  layer: 'A',
  async run(ctx): Promise<AnchorOutcome> {
    const base = subjectsOf(ctx);
    const findings: AnchorFinding[] = [];
    const imports = (await allImports(ctx)).filter((i) => i.isBare && i.symbols.length > 0);

    if (imports.length === 0) {
      return {
        verdict: 'PASS',
        findings: [],
        method: 'none-needed',
        authority: 'authoritative',
        subjects: base.ids,
        contentHashes: base.hashes,
        meta: { checked: 0 },
      };
    }

    const ts = await loadTypescript(process.env.AGENTFORGE_TS_DIR);
    const bySpecifier = new Map<string, ImportRef[]>();
    for (const imp of imports) {
      const list = bySpecifier.get(imp.specifier) ?? [];
      list.push(imp);
      bySpecifier.set(imp.specifier, list);
    }

    let checked = 0;
    let authoritative = Boolean(ts);

    for (const [specifier, refs] of bySpecifier) {
      const { pkg, sub } = splitBareSpecifier(specifier);
      const res = await resolvePackage(ctx.projectRoot, pkg, sub);

      if (!res.installed) {
        // 未安装交给 A1 的 not-installed 处理，这里不重复报错
        findings.push({
          code: 'symbol-unverifiable',
          severity: 'warn',
          message: `无法核实 "${specifier}" 的符号：${res.error}`,
          targetRole: attributeByArtifact(ctx, refs[0].file),
          data: { specifier },
        });
        continue;
      }
      if (!res.entryFile) {
        authoritative = false;
        findings.push({
          code: 'entry-unresolved',
          severity: 'warn',
          message: `无法定位 "${specifier}" 的入口文件（${res.error}），其符号未经验证`,
          targetRole: attributeByArtifact(ctx, refs[0].file),
          data: { specifier },
        });
        continue;
      }
      if (res.entryKind === 'implementation') {
        // 没有 .d.ts 时只能扫实现文件的 export 语句，权威性下降
        authoritative = false;
      }

      const exports = await collectExports(res.entryFile, ts);
      if (exports.method === 'regex') authoritative = false;

      for (const ref of refs) {
        for (const sym of ref.symbols) {
          checked++;
          if (exports.names.has(sym)) continue;

          if (sym === 'default') {
            // CJS/ESM 互操作下 default 的存在性有歧义，不判 FAIL
            findings.push({
              code: 'no-default-export',
              severity: 'warn',
              message: `"${specifier}" 的声明中未见 default 导出（可能是 CJS 互操作，需人工确认）`,
              file: ref.file,
              line: ref.line,
              targetRole: attributeByArtifact(ctx, ref.file),
              data: { specifier, symbol: sym },
            });
            continue;
          }

          if (exports.open) {
            findings.push({
              code: 'uncertain-export',
              severity: 'warn',
              message: `"${specifier}" 存在无法完全解析的导出（export * / export =），因此无法断言 "${sym}" 不存在`,
              file: ref.file,
              line: ref.line,
              targetRole: attributeByArtifact(ctx, ref.file),
              data: { specifier, symbol: sym },
            });
            continue;
          }

          findings.push({
            code: 'unknown-export',
            severity: 'fail',
            message: `${ref.file}:${ref.line} 从 "${specifier}" 导入了不存在的符号 "${sym}"（该包真实存在，但未导出此名字）—— 这是幻觉 API`,
            file: ref.file,
            line: ref.line,
            targetRole: attributeByArtifact(ctx, ref.file),
            data: { specifier, symbol: sym, available: [...exports.names].slice(0, 40) },
          });
        }
      }
    }

    return {
      verdict: worst(findings, 'PASS'),
      findings,
      method: ts ? 'ts-ast .d.ts export set' : 'regex export set (降级路径)',
      authority: authoritative ? 'authoritative' : 'approximate',
      subjects: base.ids,
      contentHashes: base.hashes,
      meta: { checked, specifiers: bySpecifier.size, treeHash: await sourceTreeHash(ctx) },
    };
  },
};

// ════════════════════════════════════════════════════════════════
// A3 · 导入可解析
// ════════════════════════════════════════════════════════════════

const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.mjs',
];

export const A3: Anchor = {
  id: 'A3',
  title: '导入可解析',
  layer: 'A',
  async run(ctx): Promise<AnchorOutcome> {
    const base = subjectsOf(ctx);
    const findings: AnchorFinding[] = [];
    const imports = await allImports(ctx);

    const tsconfig = await readJsonOrNull<{ compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }>(
      join(ctx.projectRoot, ctx.profile.tsconfigPath),
    );
    const paths = tsconfig?.compilerOptions?.paths ? Object.keys(tsconfig.compilerOptions.paths) : [];

    // 别名导入（@/ 或 tsconfig paths）解析代价高且易误判，只提示不判 FAIL
    const aliasSeen = new Set<string>();
    let checked = 0;

    for (const imp of imports) {
      const isAlias = imp.specifier.startsWith('@/') || paths.some((p) => matchPathAlias(p, imp.specifier));
      if (isAlias) {
        aliasSeen.add(imp.specifier);
        continue;
      }
      // 裸包导入由 A1/A2 负责，这里只管本地路径
      if (!imp.isRelative) continue;

      const clean = imp.specifier.replace(/[?#].*$/, '');

      // 关键：相对导入必须相对**导入文件所在目录**解析，而不是项目根。
      // （第一版写成相对项目根，把所有真实的同级导入都误判成了编造路径。）
      const baseDir = clean.startsWith('/') ? '' : dirname(imp.file);
      const target = clean.startsWith('/') ? clean.slice(1) : clean;

      const found = RESOLVE_SUFFIXES.some((s) => existsSync(join(ctx.projectRoot, baseDir, target + s)));
      checked++;
      if (!found) {
        findings.push({
          code: 'unresolved-import',
          severity: 'fail',
          message: `${imp.file}:${imp.line} 导入的 "${imp.specifier}" 在磁盘上找不到对应文件（已按 ${baseDir || '.'}/ 解析）—— 这是编造的模块路径`,
          file: imp.file,
          line: imp.line,
          targetRole: attributeByArtifact(ctx, imp.file),
          data: { specifier: imp.specifier, resolvedFrom: baseDir || '.' },
        });
      }
    }

    if (aliasSeen.size > 0) {
      findings.push({
        code: 'alias-unresolved',
        severity: 'warn',
        message: `存在 ${aliasSeen.size} 个别名导入（${[...aliasSeen].slice(0, 5).join(', ')}），未做解析验证（依赖 tsconfig paths 运行时解析，静态检查易误判）`,
      });
    }

    return {
      verdict: worst(findings, 'PASS'),
      findings,
      method: 'file-existence with extension candidates (relative to importing file)',
      authority: aliasSeen.size > 0 ? 'approximate' : 'authoritative',
      subjects: base.ids,
      contentHashes: base.hashes,
      meta: { checked, aliases: aliasSeen.size, treeHash: await sourceTreeHash(ctx) },
    };
  },
};

function matchPathAlias(pattern: string, specifier: string): boolean {
  const p = pattern.replace(/\*$/, '');
  if (pattern.endsWith('/*')) return specifier.startsWith(p);
  return pattern === specifier;
}

// ════════════════════════════════════════════════════════════════
// A4 · 编译 / 类型检查
// ════════════════════════════════════════════════════════════════

const TSC_LINE = /^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const TSC_BARE = /^(?:error\s+)?(TS\d+):\s+(.*)$/;

export const A4: Anchor = {
  id: 'A4',
  title: '编译 / 类型检查',
  layer: 'A',
  async run(ctx): Promise<AnchorOutcome> {
    const base = subjectsOf(ctx);
    const cmd = ctx.profile.typecheck;
    if (!cmd) {
      return {
        verdict: 'SKIPPED',
        findings: [
          {
            code: 'no-typecheck-command',
            severity: 'warn',
            message: '项目 profile 未配置 typecheck 命令，编译正确性未经验证（未验证 ≠ 通过）',
          },
        ],
        method: 'none',
        authority: 'none',
        subjects: base.ids,
        contentHashes: base.hashes,
      };
    }

    const avail = await probeCommand(cmd.cmd, ctx.projectRoot);
    if (!avail.available) {
      return {
        verdict: 'SKIPPED',
        findings: [
          {
            code: 'toolchain-missing',
            severity: 'warn',
            message: `typecheck 工具不可用（${cmd.cmd}）：${avail.detail ?? '未知原因'}。编译正确性未经验证`,
          },
        ],
        method: 'none',
        authority: 'none',
        subjects: base.ids,
        contentHashes: base.hashes,
      };
    }

    const r = await execCapture('', { cwd: ctx.projectRoot, trusted: cmd, timeoutMs: 300_000 });
    const findings: AnchorFinding[] = [];

    for (const line of r.stdout.split(/\r?\n/)) {
      const m = TSC_LINE.exec(line.trim());
      if (!m) continue;
      const [, file, ln, col, sev, code, msg] = m;
      findings.push({
        code: 'compile-error',
        severity: sev === 'error' ? 'fail' : 'warn',
        message: `${file}:${ln}:${col} ${code}: ${msg}`,
        file: file.replace(/\\/g, '/'),
        line: Number(ln),
        col: Number(col),
        targetRole: attributeByArtifact(ctx, file),
        data: { tsCode: code },
      });
    }

    if (findings.length === 0 && r.exitCode !== 0) {
      const bare = TSC_BARE.exec(r.stdout.trim());
      findings.push({
        code: 'compile-error',
        severity: 'fail',
        message: bare ? `${bare[1]}: ${bare[2]}` : `类型检查失败（exit ${r.exitCode}）但输出无法结构化解析：${r.stdout.trim().slice(0, 800)}`,
        targetRole: 'UNRESOLVED',
        data: { exitCode: r.exitCode, raw: r.stdout.slice(0, 2000) },
      });
    }

    const byRole = new Map<string, number>();
    for (const f of findings) {
      const k = f.targetRole ?? 'UNRESOLVED';
      byRole.set(k, (byRole.get(k) ?? 0) + 1);
    }

    return {
      verdict: worst(findings, r.exitCode === 0 ? 'PASS' : 'FAIL'),
      findings,
      method: `structured diagnostics from ${cmd.cmd} ${cmd.args.join(' ')}`,
      authority: 'authoritative',
      subjects: base.ids,
      contentHashes: base.hashes,
      meta: {
        exitCode: r.exitCode,
        command: `${cmd.cmd} ${cmd.args.join(' ')}`,
        errorCount: findings.filter((f) => f.severity === 'fail').length,
        attribution: Object.fromEntries(byRole),
        treeHash: await sourceTreeHash(ctx),
      },
    };
  },
};

// ════════════════════════════════════════════════════════════════
// A5 · 测试执行
// ════════════════════════════════════════════════════════════════

const COUNT_PATTERNS: Array<{ re: RegExp; pick: (m: RegExpMatchArray) => { passed?: number; failed?: number } }> = [
  // node:test 内置 reporter（TAP / spec）
  { re: /^#\s*pass\s+(\d+)/m, pick: (m) => ({ passed: Number(m[1]) }) },
  { re: /^#\s*fail\s+(\d+)/m, pick: (m) => ({ failed: Number(m[1]) }) },
  { re: /^\s*ℹ\s*pass\s+(\d+)/m, pick: (m) => ({ passed: Number(m[1]) }) },
  { re: /^\s*ℹ\s*fail\s+(\d+)/m, pick: (m) => ({ failed: Number(m[1]) }) },
  // vitest / jest 汇总行
  { re: /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/m, pick: (m) => ({ failed: Number(m[1] ?? 0), passed: Number(m[2]) }) },
  { re: /(\d+)\s+passed,\s+(\d+)\s+failed/m, pick: (m) => ({ passed: Number(m[1]), failed: Number(m[2]) }) },
];

export const A5: Anchor = {
  id: 'A5',
  title: '测试执行',
  layer: 'A',
  async run(ctx): Promise<AnchorOutcome> {
    const base = subjectsOf(ctx);
    const cmd = ctx.profile.test;
    if (!cmd) {
      return {
        verdict: 'SKIPPED',
        findings: [
          {
            code: 'no-test-command',
            severity: 'warn',
            message: '项目 profile 未配置 test 命令，测试是否通过未经验证（未验证 ≠ 通过）',
          },
        ],
        method: 'none',
        authority: 'none',
        subjects: base.ids,
        contentHashes: base.hashes,
      };
    }

    const r = await execCapture('', { cwd: ctx.projectRoot, trusted: cmd, timeoutMs: 600_000 });

    if (r.spawnError) {
      return {
        verdict: 'SKIPPED',
        findings: [
          { code: 'test-toolchain-missing', severity: 'warn', message: `测试命令无法启动：${r.spawnError}` },
        ],
        method: 'none',
        authority: 'none',
        subjects: base.ids,
        contentHashes: base.hashes,
      };
    }

    const combined = `${r.stdout}\n${r.stderr}`;
    let passed = 0;
    let failed = 0;
    let parsedCounts = false;
    for (const p of COUNT_PATTERNS) {
      const m = p.re.exec(combined);
      if (m) {
        const v = p.pick(m);
        if (v.passed !== undefined) {
          passed = v.passed;
          parsedCounts = true;
        }
        if (v.failed !== undefined) {
          failed = v.failed;
          parsedCounts = true;
        }
      }
    }

    const findings: AnchorFinding[] = [];
    // 失败用例的**名称 + 报错首行**。
    //
    // 名称来自 node:test 的 `✖ name` 行，报错取其后的第一条实质输出行（跳过堆栈帧）。
    // 这份明细有两个用处：写进 A5 的 finding 让人直接看到失败原因，
    // 以及**固化进 TestReport 工件**（见 orchestrator.publishTestReport）——
    // TestReport schema 要求 failing 带 message，只有真的解析出来才填得进去。
    const failingDetails: Array<{ name: string; message: string }> = [];
    {
      const lines = combined.split('\n');
      for (let i = 0; i < lines.length && failingDetails.length < 30; i++) {
        const m = /^\s*✖\s+(.*)$/.exec(lines[i]);
        if (!m) continue;
        let message = '';
        for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
          const t = lines[k].trim();
          if (t.length === 0) continue;
          if (/^(at\s|✖|✔|ℹ|\.\.\.)/.test(t)) continue; // 堆栈帧 / 下一条结果行
          message = t.slice(0, 300);
          break;
        }
        failingDetails.push({ name: m[1].trim(), message });
      }
    }
    const failingNames = failingDetails.map((f) => f.name);

    if (failed > 0 || r.exitCode !== 0) {
      findings.push({
        code: 'tests-failed',
        severity: 'fail',
        message:
          failed > 0
            ? `测试失败 ${failed} 项：${failingNames.slice(0, 5).join(' | ')}`
            : `测试命令以非零码退出（exit ${r.exitCode}），但未解析出失败计数`,
        targetRole: 'test',
        data: { exitCode: r.exitCode, passed, failed, failing: failingNames },
      });
    }

    // 测试套件声明覆盖了需求，但一条测试都没跑 —— 典型的「假装测过」
    const suites = ctx.store.heads('TestSuite');
    if (r.exitCode === 0 && passed === 0 && suites.length > 0) {
      findings.push({
        code: 'no-tests-ran',
        severity: 'fail',
        message: `存在 ${suites.length} 个测试套件工件，但测试命令报告 0 项通过 —— 测试很可能没有被真正执行`,
        targetRole: 'test',
        data: { suites: suites.map((s: Artifact) => s.id) },
      });
    }

    /**
     * 「命令成功，但什么都没说」也是一种未验证。
     *
     * 这条是幻觉靶场跑出来的（样本 A5-05）：测试命令退出 0，
     * 但输出里没有任何可解析的 pass/fail 计数，也没有 TestSuite 工件 ——
     * 此前的实现会直接报 PASS。**退出码 0 不等于测试通过**：
     * 脚本可能被 `|| true` 吞掉、可能压根没跑到测试、可能输出格式压根没被识别。
     *
     * 与 SKIPPED ≠ PASS 是同一条原则：**没验证到东西，就不能声称验证过。**
     */
    if (r.exitCode === 0 && !parsedCounts && findings.length === 0) {
      findings.push({
        code: 'test-counts-unparsed',
        severity: 'warn',
        message:
          `测试命令成功退出，但输出中解析不出任何测试计数 —— 无法确认测试是否真的运行了。` +
          `未验证 ≠ 通过（原输出尾部：${combined.trim().slice(-160) || '(空)'}）`,
        targetRole: 'test',
        data: { exitCode: r.exitCode, stdoutTail: r.stdout.slice(-400) },
      });
    }

    return {
      verdict: worst(findings, 'PASS'),
      findings,
      method: `structured counts from ${cmd.cmd} ${cmd.args.join(' ')}`,
      authority: 'authoritative',
      subjects: base.ids,
      contentHashes: base.hashes,
      meta: {
        exitCode: r.exitCode,
        command: `${cmd.cmd} ${cmd.args.join(' ')}`,
        passed,
        failed,
        // 供 orchestrator 固化成 TestReport 工件（执行事实必须来自真实运行）
        failing: failingDetails,
        stdoutTail: r.stdout.slice(-1500),
        treeHash: await sourceTreeHash(ctx),
      },
    };
  },
};

// ════════════════════════════════════════════════════════════════
// A6 · 运行时行为
// ════════════════════════════════════════════════════════════════

export const A6: Anchor = {
  id: 'A6',
  title: '运行时行为',
  layer: 'A',
  async run(ctx): Promise<AnchorOutcome> {
    const base = subjectsOf(ctx);
    const run = ctx.profile.run;
    if (!run || !run.healthUrl) {
      return {
        verdict: 'SKIPPED',
        findings: [
          {
            code: 'no-run-command',
            severity: 'warn',
            message: '项目 profile 未配置可探测的 run 命令与 healthUrl，运行时行为未经验证（未验证 ≠ 通过）',
          },
        ],
        method: 'none',
        authority: 'none',
        subjects: base.ids,
        contentHashes: base.hashes,
      };
    }

    const probe = await probeRuntime(ctx, run, run.healthUrl);
    const findings: AnchorFinding[] = [];
    if (!probe.ok) {
      findings.push({
        code: 'runtime-probe-failed',
        severity: 'fail',
        message: probe.message,
        targetRole: attributeByArtifact(ctx, probe.stderrHint ?? 'src/api/'),
        data: { healthUrl: run.healthUrl, stdout: truncate(probe.stdout), stderr: truncate(probe.stderr) },
      });
    }

    return {
      verdict: worst(findings, 'PASS'),
      findings,
      method: `spawn + HTTP probe ${run.healthUrl}`,
      authority: 'authoritative',
      subjects: base.ids,
      contentHashes: base.hashes,
      meta: {
        healthUrl: run.healthUrl,
        httpStatus: probe.status,
        readyMs: probe.readyMs,
        stdoutTail: truncate(probe.stdout, 1200),
        stderrTail: truncate(probe.stderr, 1200),
        treeHash: await sourceTreeHash(ctx),
      },
    };
  },
};

function truncate(s: string, n = 800): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

type RuntimeProbe = {
  ok: boolean;
  message: string;
  status?: number;
  readyMs?: number;
  stdout: string;
  stderr: string;
  stderrHint?: string;
};

/**
 * 真正启动服务并做 HTTP 探针。
 * 注意：这里用 spawn + 文件重定向捕获输出（同一套 exec 策略），
 * 并且**必须**在结束后杀掉子进程，否则测试会挂住。
 *
 * 两个踩过坑的地方（见 docs/07 §L6），都发生在真实 LLM run 里：
 *
 * 1. **必须走 `resolveExecutable`**。Windows 上 `spawn('npm', …)` 直接 ENOENT
 *    （Node 不做 PATHEXT 解析，npm 实际是 `npm.cmd`），
 *    而 `spawn('npm.cmd', …)` 又会因 CVE-2024-27980 同步抛 EINVAL ——
 *    所以要么解析出真实路径 + `shell: true`，要么这个锚点永远跑不起来。
 *    §H1 已经为 `execCapture` 修过同一个问题，这里当时漏了。
 *
 * 2. **必须挂 `'error'` 监听**。spawn 失败是**异步的 `'error'` 事件**，不是同步抛出，
 *    所以 Gate 那层「锚点抛异常不得让整个 Gate 崩溃」的 try/catch **抓不到它**：
 *    实测结果是整个 node 进程被未处理的 error 事件打死，
 *    一次「服务起不来」升级成了「AgentForge 崩了」。
 *
 *    **锚点绝不可以有能力杀死整个 run。** 这就是一个反例。
 */
async function probeRuntime(
  ctx: AnchorContext,
  run: { cmd: string; args: string[]; cwd?: string },
  healthUrl: string,
): Promise<RuntimeProbe> {
  const { spawn } = await import('node:child_process');
  const { open, readFile, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { randomUUID } = await import('node:crypto');

  const dir = join(tmpdir(), `agentforge-runtime-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = await open(outPath, 'w');
  const errFd = await open(errPath, 'w');

  // Windows 上把 `npm` 解析成 `npm.cmd`（并因此需要 shell），否则永远 ENOENT。
  // 复用 execCapture 的同一套逻辑，避免「A4/A5 能跑、A6 崩进程」这类漂移。
  const prepared = prepareSpawn(run.cmd, run.args);

  let child: import('node:child_process').ChildProcess;
  try {
    child = spawn(prepared.cmd, prepared.args, {
      cwd: run.cwd ?? ctx.projectRoot,
      stdio: ['ignore', outFd.fd, errFd.fd],
      windowsHide: true,
      shell: prepared.shell,
    });
  } catch (err) {
    // 同步抛出（例如 EINVAL）也要变成一次报告，而不是异常
    await outFd.close().catch(() => {});
    await errFd.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      message: `服务进程无法启动：${(err as Error).message}`,
      stdout: '',
      stderr: '',
    };
  }

  // spawn 失败是异步事件 —— 不挂这个监听，整个进程会被未处理的 error 打死
  let spawnError: Error | null = null;
  child.on('error', (err) => {
    spawnError = err;
  });

  const started = Date.now();
  const timeoutMs = 25_000;
  let status: number | undefined;
  let ok = false;
  let message = '';

  try {
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 300));
      if (spawnError) {
        message = `服务进程无法启动（${run.cmd}）：${(spawnError as Error).message}`;
        break;
      }
      if (child.exitCode !== null) {
        message = `服务进程在就绪前退出（exit ${child.exitCode}），HTTP 探针未执行`;
        break;
      }
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        const res = await fetch(healthUrl, { signal: ctrl.signal });
        clearTimeout(t);
        status = res.status;
        if (res.ok) {
          ok = true;
          message = `HTTP 探针成功：${healthUrl} → ${res.status}`;
        } else {
          message = `HTTP 探针返回非成功状态：${healthUrl} → ${res.status}`;
        }
        break;
      } catch {
        /* 还没起来，继续轮询 */
      }
    }
    if (!ok && message === '') message = `服务在 ${timeoutMs}ms 内未响应 ${healthUrl}`;
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await outFd.close().catch(() => {});
    await errFd.close().catch(() => {});
  }

  const stdout = await readFile(outPath, 'utf8').catch(() => '');
  const stderr = await readFile(errPath, 'utf8').catch(() => '');
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  return {
    ok,
    message,
    status,
    readyMs: ok ? Date.now() - started : undefined,
    stdout,
    stderr,
  };
}

// ════════════════════════════════════════════════════════════════
// A7 · 契约一致性
// ════════════════════════════════════════════════════════════════

export const A7: Anchor = {
  id: 'A7',
  title: '契约一致性',
  layer: 'A',
  async run(ctx): Promise<AnchorOutcome> {
    const base = subjectsOf(ctx);
    const findings: AnchorFinding[] = [];
    const contractArt = ctx.store.head('Contract');

    if (!contractArt) {
      return {
        verdict: 'SKIPPED',
        findings: [
          { code: 'no-contract', severity: 'warn', message: '尚无契约工件，契约一致性未经验证（未验证 ≠ 通过）' },
        ],
        method: 'none',
        authority: 'none',
        subjects: base.ids,
        contentHashes: base.hashes,
      };
    }

    const contract = contractArt.content as ContractDoc;
    const subjects = [...base.ids, contractArt.id];
    const hashes = { ...base.hashes, [contractArt.id]: contractArt.contentHash };

    // 1) 未冻结的契约不能作为下游依据
    if (!contractArt.frozenHash) {
      findings.push({
        code: 'contract-not-frozen',
        severity: 'fail',
        message: '契约尚未冻结（frozenHash 为空）。未冻结的契约无法保证前后端基于同一版本工作',
        targetRole: 'pm',
        data: { contractId: contractArt.id },
      });
    }

    // 2) 生成的类型文件必须真实存在
    const typesText = await ctx.readFile(contract.generatedTypesPath);
    if (typesText === null) {
      findings.push({
        code: 'missing-generated-types',
        severity: 'fail',
        message: `契约声明的生成类型文件不存在：${contract.generatedTypesPath} —— 前后端将各自手写接口类型，必然产生契约漂移`,
        targetRole: 'pm',
        data: { path: contract.generatedTypesPath },
      });
    }

    // 3) 契约里的每个端点都必须被后端实现
    //
    // 只有在**已经存在后端代码工件**时才做这项检查。CONTRACTING 阶段还没有任何代码，
    // 此时判定「端点未实现」不是发现问题，而是检查用错了时机（第一版就踩了这个坑，
    // 导致契约刚冻结就被判 FAIL）。没有代码时如实标注「实现一致性尚未验证」。
    const openapiPaths = Object.keys(contract.openapi?.paths ?? {});
    const apiModules = ctx.store.heads('CodeModule').filter((m) => m.scope === 'api');
    const webModules = ctx.store.heads('CodeModule').filter((m) => m.scope === 'web');
    const missingEndpoints: string[] = [];

    if (apiModules.length === 0) {
      findings.push({
        code: 'implementation-unverified',
        severity: 'warn',
        message: `尚无后端代码工件，${openapiPaths.length} 个契约端点的实现一致性未经验证（未验证 ≠ 通过）`,
      });
    } else {
      // 必须**先剥掉注释**再找端点。
      //
      // 这条是幻觉靶场跑出来的（样本 A7-07）：原实现直接在文件全文里做子串匹配，
      // 于是一句「// TODO: 实现 /api/tasks」就能让检查通过 ——
      // 端点明明一行都没实现，A7 却认为它已实现。
      // 注释里的路径也是路径子串，这是子串匹配的天然盲点。
      const apiText = stripCodeComments(await concatModules(ctx, apiModules));
      for (const p of openapiPaths) {
        if (!apiText.includes(p)) {
          missingEndpoints.push(p);
          findings.push({
            code: 'unimplemented-endpoint',
            severity: 'fail',
            message: `契约端点 ${p} 在后端代码中找不到任何实现痕迹（已排除注释）`,
            targetRole: 'backend',
            data: { path: p },
          });
        }
      }
    }

    // 4) 前端调用了契约未声明的端点
    const calledPaths = new Set<string>();
    if (webModules.length === 0) {
      findings.push({
        code: 'frontend-unverified',
        severity: 'warn',
        message: '尚无前端代码工件，前端调用与契约的一致性未经验证（未验证 ≠ 通过）',
      });
    } else {
      const webText = stripCodeComments(await concatModules(ctx, webModules));
      for (const m of webText.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/{}:.]*)['"`]/g)) calledPaths.add(m[1]);
      for (const called of calledPaths) {
        const declared = openapiPaths.some((p) => normalizePath(p) === normalizePath(called));
        if (!declared) {
          findings.push({
            code: 'undeclared-endpoint',
            // ⚠️ 从 warn 提升为 fail（理由见下面 contract-duplication 那段的长注释）。
            // 「前端调用了契约未声明的端点」不是风格问题，它意味着**运行期会 404**，
            // 而这正是整套契约机制存在的理由。
            severity: 'fail',
            message: `前端调用了契约中未声明的端点 ${called} —— 契约漂移的典型征兆`,
            targetRole: 'frontend',
            data: { called, declared: openapiPaths },
          });
        }
      }
    }

    // 5) 手写重复类型：契约已有该模型，代码里却又手写了一份 interface/type
    //
    // 判定「有没有引用生成的类型文件」必须足够具体。第一版只检查代码里是否出现
    // 生成文件的 basename（如 "types"）—— 这个字符串在代码里随处可见，
    // 等于白检查。现在要求代码里真的有一条 import 语句，其模块说明符包含
    // 生成路径的末两段（如 "contract/types"）。
    //
    // ── 为什么从 warn 提升为 fail（第 13 轮真实缺陷的直接结果）────────────────
    //
    // 这条检查原本是 warn，而它历史上触发了 **33 次**（全部运行里最多的一类）。
    // 当时的判断是「噪音太大，不阻断」。**但那个判断建立在一个错误的因果上**：
    // 它之所以响个不停，是因为契约生成器不认 `$ref`，把精确类型全降级成了
    // `Record<string, unknown>` —— 角色**没法**用那些类型，只能自己重声明。
    // 也就是说 **33 次噪音是那个缺陷的症状，不是这条检查太严**。
    //
    // 缺陷修好之后，「import 生成的类型」变成一件真的做得到的事，
    // 于是这条检查的两个性质都变了：
    //   1. 它判的是**契约漂移本身**（`docs/04` 里整套契约机制存在的理由），不是风格
    //   2. 被归因的角色**有能力修好它**（把重声明改成 import 即可）——
    //      这一点很关键：不像「生成物错了」那种角色改不动的失败，这条是**收敛**的
    // 所以它现在报 fail。
    //
    // ⚠️ 同时修一个假阳性：生成的类型文件**不存在**时不许报重复。
    // 那种情况下 `importsGenerated` 必然为 false，于是每一处同名声明都会被判重复 ——
    // 而真正的问题是「文件不存在」（上面第 2 项已经报了 fail，且归因给 pm）。
    // 不修的话，提升严重度会把一个 pm 的问题**错误地摊到前后端头上**，
    // 而且要每个模型各报一次（实测一轮能报 12 条）。
    const schemaNames = Object.keys(contract.jsonSchemas ?? {});
    if (typesText !== null && schemaNames.length > 0) {
      const needle = generatedTypesNeedle(contract.generatedTypesPath);
      const importRe = new RegExp(`from\\s+['"\`][^'"\`]*${escapeRe(needle)}['"\`]`);
      for (const m of [...apiModules, ...webModules]) {
        const files = (m.content as CodeModule).files ?? [];
        for (const f of files) {
          if (importRe.test(f.content)) continue;
          for (const name of schemaNames) {
            const dup = new RegExp(`\\b(?:interface|type)\\s+${escapeRe(name)}\\b`).test(f.content);
            if (dup) {
              findings.push({
                code: 'contract-duplication',
                severity: 'fail',
                message: `${f.path} 手写了契约中已定义的模型 "${name}"，却没有 import 生成的类型文件 —— 这是前后端契约漂移的根源。契约已在 ${contract.generatedTypesPath} 生成该模型，请改为 import 它`,
                file: f.path,
                targetRole: m.scope === 'web' ? 'frontend' : 'backend',
                data: { model: name, generatedTypesPath: contract.generatedTypesPath, expectedImportContains: needle },
              });
            }
          }
        }
      }
    }

    return {
      verdict: worst(findings, 'PASS'),
      findings,
      method: 'openapi-path coverage + generated-types existence + duplication heuristic',
      authority: 'authoritative',
      subjects,
      contentHashes: hashes,
      meta: {
        endpoints: openapiPaths.length,
        missing: missingEndpoints.length,
        calledPaths: calledPaths.size,
        contractFrozen: Boolean(contractArt.frozenHash),
        treeHash: await sourceTreeHash(ctx),
      },
    };
  },
};

/**
 * 剥掉代码注释（保持长度不变，用空格替换）。
 *
 * 为什么需要它：A7 的端点覆盖检查是**子串匹配**，
 * 而注释里的路径也是路径子串 —— 一句「// TODO: 实现 /api/tasks」就能让检查通过。
 * 这不是理论问题：幻觉靶场样本 A7-07 就是这么骗过它的。
 *
 * 用一个小状态机而不是正则：正则很难正确处理「字符串里的 //」（例如 URL `https://…`）。
 * 保持长度不变是为了让行号/偏移仍然可用。
 */
export function stripCodeComments(text: string): string {
  const out = text.split('');
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line';
          out[i] = ' ';
        } else if (c === '/' && next === '*') {
          state = 'block';
          out[i] = ' ';
        } else if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') state = 'template';
        break;
      case 'line':
        if (c === '\n') state = 'code';
        else out[i] = ' ';
        break;
      case 'block':
        if (c === '*' && next === '/') {
          out[i] = ' ';
          state = 'code';
        } else if (c !== '\n') {
          out[i] = ' ';
        }
        break;
      case 'single':
        if (c === '\\') i++;
        else if (c === "'") state = 'code';
        break;
      case 'double':
        if (c === '\\') i++;
        else if (c === '"') state = 'code';
        break;
      case 'template':
        if (c === '\\') i++;
        else if (c === '`') state = 'code';
        break;
    }
  }
  return out.join('');
}

async function concatModules(ctx: AnchorContext, mods: Artifact[]): Promise<string> {
  const parts: string[] = [];
  for (const m of mods) {
    for (const f of (m.content as CodeModule).files ?? []) parts.push(f.content);
  }
  return parts.join('\n');
}

function normalizePath(p: string): string {
  return p
    .replace(/\{[^}]+\}/g, '{}')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{}')
    .replace(/\/+$/, '');
}

function basenameNoExt(p: string): string {
  const b = p.replace(/\\/g, '/').split('/').pop() ?? p;
  return b.replace(/\.(ts|tsx|js|mjs)$/, '');
}

/**
 * 生成类型文件的「可识别导入片段」：末两段路径去掉扩展名。
 * `shared/contract/types.ts` → `contract/types`。
 * 这比只认 basename（`types`）具体得多 —— 后者在代码里到处都是，等于没检查。
 */
function generatedTypesNeedle(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const tail = parts.slice(-2).map((s) => s.replace(/\.(ts|tsx|js|mjs)$/, ''));
  return tail.join('/');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ════════════════════════════════════════════════════════════════
// A8 · 验证基准未被产出篡改
// ════════════════════════════════════════════════════════════════

/**
 * A8 检查的是**验证基准本身有没有被动过**，而不是被生成代码的质量。
 *
 * 为什么它必须是锚点、而且是 FAIL 级别的锚点（docs/HANDOFF.md §8.1）：
 *
 * 第 12 轮真实运行里，后端角色交出的 CodeModule 附了一份自己写的 `package.json`：
 * 删掉 `agentforge.healthUrl`（A6 于是静默 SKIPPED）、删掉 `environmentNotes`、
 * 把 `scripts.test` 换成在本环境跑不通的命令，并且用 `tsconfig.json` 的
 * `exclude` 把测试目录排除出类型检查。
 *
 * 这些动作**不产生任何一条「代码有 bug」的失败**：A6 报的是 SKIPPED，
 * A4/A5 报的是「环境没配好」。于是从工单上看，它长得像「环境问题」或「模型能力不足」，
 * 而真实原因是：**被验证者修改了验证基准**。
 *
 * 这条锚点的存在意义就是让那个区别在系统里是可见的：
 * 基准被动过 ⇒ 直接 FAIL，并且按 `targetRole` 机械归因到那个角色头上，派工单返工。
 *
 * 它**不看盘上的文件内容**：文件已经被编排器按契约规整过了（原值被保留），
 * 所以「现在文件是好的」。A8 报的是「产出尝试改过它」——
 * 一次没生效的篡改尝试依旧是篡改尝试，而且下一次的向量未必在保护范围内。
 * 把它降级成 warn 就等于重演「静默通过」那类假绿灯。
 */
export const A8: Anchor = {
  id: 'A8',
  title: '验证基准未被篡改',
  layer: 'A',
  appliesTo(ctx) {
    // 拿不到契约状态，或本次运行确实没有任何基准（空白工作区且没有受保护文件）：
    // 如实报「不适用」而不是造一个 PASS。理由同 A4/A5/A6 的 SKIPPED。
    if (!ctx.contract) return false;
    return ctx.contract.hasBaseline || ctx.contract.violations.length > 0;
  },
  async run(ctx): Promise<AnchorOutcome> {
    const state = ctx.contract;
    if (!state) {
      return {
        verdict: 'SKIPPED',
        findings: [
          {
            code: 'contract-not-tracked',
            severity: 'warn',
            message: '本次运行未固化项目契约，无法核实验证基准是否被动过（未验证 ≠ 通过）',
          },
        ],
        method: 'none',
        authority: 'none',
        subjects: [],
        contentHashes: {},
      };
    }

    const findings: AnchorFinding[] = state.violations.map((v) => ({
      code: v.code,
      severity: 'fail' as const,
      message: v.message,
      file: v.path,
      targetRole: v.targetRole,
      data: {
        ...(v.key ? { key: v.key } : {}),
        ...(v.declared ? { declared: v.declared } : {}),
        ...(v.attempted ? { attempted: v.attempted } : {}),
        artifactKind: v.artifactKind,
      },
    }));

    const base = subjectsOf(ctx);
    return {
      verdict: findings.length > 0 ? 'FAIL' : 'PASS',
      findings,
      method: 'deterministic project-contract comparison（产出 vs 运行开始时的基准）',
      authority: 'authoritative',
      subjects: base.ids,
      contentHashes: base.hashes,
      meta: {
        declaredPkgKeys: state.declaredPkgKeys,
        protectedFiles: state.protectedFiles,
        violations: state.violations.length,
      },
    };
  },
};

// ════════════════════════════════════════════════════════════════

export const FACT_ANCHORS: Anchor[] = [A1, A2, A3, A4, A5, A6, A7, A8];
export { sliceLines, walkFiles, readTextOrNull };
export type { TestSuiteDoc };
