/**
 * 环境指纹：记忆的**失效机制**。
 *
 * ## 为什么必须有它（这是三条硬约束里的第二条）
 *
 * 记忆里沉淀的「约定」全都是**环境相关**的：
 * 「相对导入要带 `.ts` 扩展名」这条经验只在 `moduleResolution: NodeNext` +
 * `allowImportingTsExtensions` + Node 原生类型剥离这个组合下成立。
 * 换一个项目、换一份 tsconfig、换一个 Node 大版本，它就可能**从对的变成错的**。
 *
 * 而记忆天然趋于陈旧。一条过期约定被盲目注入提示词，会制造出一种
 * 「模型怎么又不行了」的失败 —— **这正是 docs/HANDOFF.md §6.1 那个坑的镜像版本**：
 * 上次是「约定没传达」，这次是「传错了约定」。后者更难查，因为它看起来像是模型退化了。
 *
 * 所以每条记忆都绑定一份**环境指纹**；使用时指纹不一致 → 不进提示词，
 * 并要求重新核验。失效不是「删除」，是「降级为待核验」——经验本身没被否定，
 * 只是它成立的前提变了。
 *
 * ## 指纹要能被「读懂」，而不只是一个 hash
 *
 * 只知道「失效了」没用，得知道**哪里变了**。所以指纹由一组 (键, 值) 构成，
 * `diffEnv()` 能报出变化的键，于是过期原因可以被直接写进报告：
 * 「这条经验失效：tsconfig.compilerOptions.moduleResolution 从 NodeNext 变成了 Bundler」。
 */

import { join } from 'node:path';

import { readJsonOrNull, sha256, stableStringify } from '../../core/src/index.ts';
import type { ProjectProfile } from '../../core/src/index.ts';

/** 指纹的组成项。键是给人看的路径式名字，值是稳定字符串。 */
export type EnvParts = Record<string, string>;

export type EnvFingerprint = {
  envHash: string;
  parts: EnvParts;
};

/**
 * 从「已经收集好的部件」算指纹（纯函数，可测）。
 * 部件按 key 排序后稳定序列化 —— 与收集顺序无关。
 */
export function fingerprintFromParts(parts: EnvParts): EnvFingerprint {
  const sorted: EnvParts = {};
  for (const k of Object.keys(parts).sort()) sorted[k] = parts[k]!;
  return { envHash: sha256(stableStringify(sorted)), parts: sorted };
}

/**
 * 报告两个指纹之间**哪些键变了**。
 *
 * 返回的字符串直接进报告，所以要写成人话。空数组 = 环境未变。
 */
export function diffEnv(a: EnvParts, b: EnvParts): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of [...keys].sort()) {
    const av = a[k];
    const bv = b[k];
    if (av === bv) continue;
    if (av === undefined) out.push(`${k}：新增（${bv}）`);
    else if (bv === undefined) out.push(`${k}：移除（原为 ${av}）`);
    else out.push(`${k}：${clip(av)} → ${clip(bv)}`);
  }
  return out;
}

function clip(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export type CollectEnvOptions = {
  workspace: string;
  profile: ProjectProfile;
  nodeVersion?: string;
  platform?: string;
};

/**
 * 从工作区收集指纹部件。
 *
 * 收集的东西刻意**只包含「会改变约定成立与否」的因素**：
 * tsconfig 的语义选项、锚点要跑的命令、项目自己声明的约定与受保护文件、Node 与平台。
 * 不包含文件内容、时间戳、路径 —— 那些不该让经验失效。
 */
export async function collectEnvParts(opts: CollectEnvOptions): Promise<EnvParts> {
  const { workspace, profile } = opts;
  const parts: EnvParts = {
    'runtime.node': opts.nodeVersion ?? process.versions.node,
    'runtime.platform': opts.platform ?? process.platform,
    'project.srcDir': profile.srcDir,
  };

  // 锚点实际会执行的命令 —— 命令变了，A4/A5/A6 判的东西就变了
  parts['anchor.typecheck'] = profile.typecheck
    ? `${profile.typecheck.cmd} ${profile.typecheck.args.join(' ')}`
    : '(未声明 → A4 SKIPPED)';
  parts['anchor.test'] = profile.test
    ? `${profile.test.cmd} ${profile.test.args.join(' ')}`
    : '(未声明 → A5 SKIPPED)';
  parts['anchor.run'] = profile.run
    ? `${profile.run.cmd} ${profile.run.args.join(' ')} → ${profile.run.healthUrl ?? '(无 healthUrl)'}`
    : '(未声明 → A6 SKIPPED)';

  // 项目自己声明的约定（记忆的最终沉淀位置就是这里，所以它必须进指纹）
  parts['project.environmentNotes'] = stableStringify(profile.environmentNotes ?? []);
  parts['project.protectedFiles'] = stableStringify(profile.protectedFiles ?? []);

  // tsconfig：**只取语义选项**，不取原文。
  // 取原文的话，改个缩进就会让全部经验失效 —— 那不是失效机制，那是噪音。
  const tsconfig = await readJsonOrNull<{ compilerOptions?: unknown; include?: unknown; exclude?: unknown }>(
    join(workspace, profile.tsconfigPath),
  );
  parts['tsconfig.compilerOptions'] = tsconfig?.compilerOptions
    ? stableStringify(tsconfig.compilerOptions)
    : '(缺 tsconfig 或未声明 compilerOptions)';
  parts['tsconfig.include'] = stableStringify(tsconfig?.include ?? null);
  parts['tsconfig.exclude'] = stableStringify(tsconfig?.exclude ?? null);

  return parts;
}

/** 一次性收集并算指纹。 */
export async function computeEnvFingerprint(opts: CollectEnvOptions): Promise<EnvFingerprint> {
  return fingerprintFromParts(await collectEnvParts(opts));
}

/**
 * 从磁盘**独立**收集指纹（不需要 `ProjectProfile`）。
 *
 * 存在的理由：离线摄入历史工作区时（`ingest.ts`），调用方手上只有一个目录，
 * 没有编排器推出来的 profile。而记忆包不该反向依赖编排器
 * （依赖方向必须是 orchestrator → memory，否则记忆就有机会影响判定路径）。
 *
 * 它与 `cli-run.ts` 的 `deriveProfile` 看同一批字段 —— 两处必须保持一致，
 * 所以这里刻意只读 `package.json` / `tsconfig.json` 的**原始字段**，
 * 不做任何推导（推导逻辑只有一处，在编排器里）。
 */
export async function collectEnvPartsFromDisk(
  workspace: string,
  opts: { nodeVersion?: string; platform?: string } = {},
): Promise<EnvParts> {
  const pkg = await readJsonOrNull<{
    scripts?: Record<string, string>;
    agentforge?: { healthUrl?: string; environmentNotes?: string[]; protectedFiles?: string[] };
  }>(join(workspace, 'package.json'));

  const parts: EnvParts = {
    'runtime.node': opts.nodeVersion ?? process.versions.node,
    'runtime.platform': opts.platform ?? process.platform,
    'project.srcDir': 'src',
  };

  const scripts = pkg?.scripts ?? {};
  parts['anchor.typecheck'] = scripts.typecheck ? 'npm run typecheck' : '(未声明 → A4 SKIPPED)';
  parts['anchor.test'] = scripts.test ? 'npm run test' : '(未声明 → A5 SKIPPED)';
  const startScript = scripts.start ? 'start' : scripts.dev ? 'dev' : null;
  const healthUrl = pkg?.agentforge?.healthUrl;
  parts['anchor.run'] =
    startScript && healthUrl
      ? `npm run ${startScript} → ${healthUrl}`
      : startScript
        ? '(有启动脚本但无 healthUrl → A6 SKIPPED)'
        : '(未声明 → A6 SKIPPED)';

  parts['project.environmentNotes'] = stableStringify(pkg?.agentforge?.environmentNotes ?? []);
  parts['project.protectedFiles'] = stableStringify(pkg?.agentforge?.protectedFiles ?? []);

  const tsconfig = await readJsonOrNull<{
    compilerOptions?: unknown;
    include?: unknown;
    exclude?: unknown;
  }>(join(workspace, 'tsconfig.json'));
  parts['tsconfig.compilerOptions'] = tsconfig?.compilerOptions
    ? stableStringify(tsconfig.compilerOptions)
    : '(缺 tsconfig 或未声明 compilerOptions)';
  parts['tsconfig.include'] = stableStringify(tsconfig?.include ?? null);
  parts['tsconfig.exclude'] = stableStringify(tsconfig?.exclude ?? null);

  return parts;
}
