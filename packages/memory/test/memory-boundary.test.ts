/**
 * 边界测试：**经验库不进判定路径。**
 *
 * ## 为什么这条边界比「写得对」更重要
 *
 * 记忆系统的三条硬约束（出处 / 失效 / LLM 不得写规则）管的都是「怎么把经验写对」。
 * 但即使全都做对，只要经验能被判定方读到，LLM 写的文字就**间接参与了「什么算通过」**——
 * 那正是 A8 守的那条线（被验证者不得改验证基准）绕了个弯被破掉。
 *
 * 所以边界是：**经验能改变的只有「下一轮生成时角色被告知了什么」，永远不是「判定的标准」。**
 *
 * ## 为什么不写成注释就够了
 *
 * 因为这个项目的原话是：**「一个『看起来在检查』的清单，如果没被检查，它就只是措辞」**（§6.9）。
 * 一条只写在注释里的边界，会在某次「顺手把 memoryNotes 也传给验证器吧，它能帮忙判断」的
 * 改动里静默消失 —— 而那种改动看起来完全无害，甚至像是改进。
 *
 * 所以这里用**两种互不依赖的检查**：
 *
 * 1. **静态**：扫判定路径下所有源文件，确认没有任何一处 `import` 记忆包。
 * 2. **动态**：真的构造一个「带着经验」的验证器上下文，
 *    断言渲染出来的消息里**一个字**的经验文本都没有。
 *    静态检查挡不住「经 RoleContext 透传」这条路径（那不需要 import），
 *    而这条路径恰恰是最可能被无意打开的 —— 因为 `SemanticVerifier` 与
 *    `LlmRoleRunner` 收的是**同一个** `RoleContext` 对象。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { buildVerifierContext } from '../../roles/src/verify.ts';
import { ArtifactStore } from '../../core/src/store.ts';
import type { ProjectProfile } from '../../core/src/index.ts';
import type { RoleContext } from '../../roles/src/types.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

// ════════════════════════════════════════════════════════════════
// 检查一（静态）：判定路径不许 import 记忆包
// ════════════════════════════════════════════════════════════════

/** 判定路径：这些目录/文件决定「什么算通过」。 */
const JUDGMENT_PATHS = [
  'packages/anchors/src',
  'packages/orchestrator/src/gate.ts',
  'packages/orchestrator/src/judge.ts',
  'packages/orchestrator/src/ledger.ts',
  'packages/orchestrator/src/escape.ts',
  'packages/orchestrator/src/roundtable.ts',
  'packages/orchestrator/src/orchestrator.ts',
  'packages/roles/src/verify.ts',
  'packages/core/src/projectcontract.ts',
  'packages/core/src/schemas.ts',
];

async function collectTs(p: string, out: string[] = []): Promise<string[]> {
  const abs = resolve(ROOT, p);
  if (!existsSync(abs)) return out;
  const st = await readdir(abs, { withFileTypes: true }).catch(() => []);
  if (st.length === 0) {
    out.push(abs);
    return out;
  }
  for (const e of st) {
    const child = join(abs, e.name);
    if (e.isDirectory()) await collectTs(relative(ROOT, child), out);
    else if (e.name.endsWith('.ts')) out.push(child);
  }
  return out;
}

test('🔴 边界（静态）：判定路径里没有任何一处 import 记忆包', async () => {
  const offenders: string[] = [];
  for (const p of JUDGMENT_PATHS) {
    for (const file of await collectTs(p)) {
      const src = await readFile(file, 'utf8');
      // 匹配 import/export ... from '...memory/src...' 以及动态 import('...memory...')
      if (/(?:from|import)\s*\(?\s*['"][^'"]*packages\/memory\/[^'"]*['"]/.test(src)) {
        offenders.push(relative(ROOT, file));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '判定路径不得依赖记忆包。经验是「告诉生成方该怎么做」的，' +
      '一旦判定方也读它，LLM 写的文字就间接参与了判定 —— 那正是 A8 守的线被绕开。',
  );
});

test('🔴 边界（静态）：编排器通过**回调**取经验，而不是 import 记忆包', async () => {
  const src = await readFile(resolve(ROOT, 'packages/orchestrator/src/orchestrator.ts'), 'utf8');
  // 反向依赖：接线方 → 编排器。这样「编排器有没有用到记忆」是 import 图上的确定事实。
  assert.match(src, /memoryNotesFor\?/, '编排器应当只接受一个注入的回调');
  // 只看**真的 import**，不看注释里提到路径 ——
  // 这条测试自己就被这个区别坑过一次：注释里写了 `packages/memory/...`，
  // 于是一个「不许出现该字符串」的断言在代码完全正确时失败。
  // （也正因如此，「可疑的结果先怀疑工具」这条规律在这里又应验了一次。）
  const imports = src.match(/(?:from|import)\s*\(?\s*['"][^'"]*packages\/memory\/[^'"]*['"]/g) ?? [];
  assert.deepEqual(
    imports,
    [],
    '编排器一旦 import 记忆包，边界就只剩「记得别用」这种纪律 —— 而纪律在这里靠不住',
  );
});

// ════════════════════════════════════════════════════════════════
// 检查二（动态）：验证器上下文里不许出现经验文本
// ════════════════════════════════════════════════════════════════

const LESSON_TEXT =
  '相对导入必须带显式文件扩展名（如 ./app.ts）——这是记忆系统注入的一条约定，绝对不该出现在验证器上下文里。';

function makeCtxWithMemory(): RoleContext {
  const profile: ProjectProfile = {
    name: 'boundary-fixture',
    language: 'typescript',
    srcDir: 'src',
    tsconfigPath: 'tsconfig.json',
    typecheck: null,
    test: null,
    run: null,
    knownPackages: [],
    dependencyAllowlist: null,
  };
  return {
    stage: 'REVIEW',
    // 用临时工件库：这个测试只关心「经验文本有没有漏进上下文」，不关心工件内容
    store: new ArtifactStore(join(ROOT, 'workspace', '.tmp-boundary-artifacts')),
    profile,
    workOrders: [],
    contractHash: null,
    userBrief: '边界测试用的诉求',
    directives: [],
    memoryNotes: [LESSON_TEXT],
    memoryLessonIds: ['L-boundary-1'],
  };
}

test('🔴 边界（动态）：语义验证器的上下文里**不含**任何经验文本', async () => {
  const ctx = makeCtxWithMemory();
  const built = buildVerifierContext(ctx);
  const all = built.messages.map((m) => m.content).join('\n');

  assert.ok(all.length > 0, '验证器上下文不该是空的（否则这个断言是空转的）');
  assert.ok(
    !all.includes(LESSON_TEXT),
    '经验文本漏进了验证器上下文。这条路径不需要 import 记忆包（RoleContext 透传即可），' +
      '所以静态检查挡不住它 —— 验证器与 LlmRoleRunner 收的是同一个 RoleContext 对象。',
  );
  // 更宽的检查：连「经验」这个词都不该出现，防止将来换个字段名又漏进来
  assert.ok(
    !/历次真实运行总结的经验/.test(all),
    '验证器上下文里出现了经验的标注块',
  );
  // 也不该出现经验 id
  assert.ok(!all.includes('L-boundary-1'), '经验 id 漏进了验证器上下文');
});

test('边界（动态）：即使 RoleContext 带着经验，验证器也照常工作（不因新字段而崩）', async () => {
  const ctx = makeCtxWithMemory();
  const built = buildVerifierContext(ctx);
  assert.ok(Array.isArray(built.messages));
  assert.ok(built.messages.length >= 1);
});

test('边界（注入白名单）：PM 与主理人不在经验注入名单里', async () => {
  const { MEMORY_INJECTION_ROLES } = await import('../src/inject.ts');
  assert.ok(!MEMORY_INJECTION_ROLES.includes('pm'), 'PM 的产出（Requirement/Contract）就是判定基准');
  assert.ok(!MEMORY_INJECTION_ROLES.includes('host'), '主理人是对抗审查方，给它经验会把审查变成对清单');
  assert.deepEqual([...MEMORY_INJECTION_ROLES].sort(), ['backend', 'frontend', 'test']);
});

/**
 * 这条测的是**真正决定提示词内容**的那段代码（`renderConventions`），
 * 而不是 `MEMORY_INJECTION_ROLES` 这个常量。
 *
 * 为什么必须两条都测：常量只表达意图，`renderConventions` 里的 `memoryRoles`
 * 才是真正生效的白名单。两者可以不一致 —— 而不一致时，凭单一常量做的断言会**照常通过**，
 * 经验就会悄悄进到 PM 的提示词里。这个坑本项目踩过同款（§6.9）。
 */
test('🔴 边界（提示词）：经验进得了生成角色的 prompt，进不了 PM / 主理人的 prompt', async () => {
  const { renderConventions } = await import('../../roles/src/runner.ts');
  const ctx = makeCtxWithMemory();

  for (const role of ['frontend', 'backend', 'test'] as const) {
    const rendered = renderConventions(ctx, role);
    assert.ok(rendered.includes(LESSON_TEXT), `${role} 应当收到经验（它是写代码/写测试的角色）`);
  }
  for (const role of ['pm', 'host'] as const) {
    const rendered = renderConventions(ctx, role);
    assert.ok(
      !rendered.includes(LESSON_TEXT),
      `${role} 不该收到经验：PM 的产出就是判定基准，主理人是对抗审查方`,
    );
    // 更宽的检查：连「系统自己归纳的」这个标注都不许出现
    assert.ok(!/系统自己归纳的/.test(rendered), `${role} 的 prompt 里出现了经验标注块`);
  }
});

test('边界（提示词）：没有经验时 renderConventions 的输出与「加记忆之前」一致', async () => {
  const { renderConventions } = await import('../../roles/src/runner.ts');
  const ctx = makeCtxWithMemory();
  delete ctx.memoryNotes;
  delete ctx.memoryLessonIds;
  const rendered = renderConventions(ctx, 'backend');
  // 省略 memoryNotes = 完全没有记忆，行为必须逐字节不变（否则「加记忆」就不是可选项了）
  assert.ok(!/经验/.test(rendered));
  assert.ok(!/系统自己归纳的/.test(rendered));
  // 而项目自己声明的 environmentNotes 必须照旧进提示词
  assert.match(rendered, /项目约定/);
});

test.after(async () => {
  await rm(join(ROOT, 'workspace', '.tmp-boundary-artifacts'), { recursive: true, force: true });
});
