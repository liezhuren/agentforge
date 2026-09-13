import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ArtifactStore,
  DecisionLog,
  PermissionDenied,
  SchemaReject,
  claimHashOf,
  contentHash,
  execCapture,
  stableStringify,
  validateArtifactContent,
  validateSchema,
  formatSchemaErrors,
  type JsonSchema,
} from '../src/index.ts';

// ════════════════════════════════════════════════════════════════
// hash：稳定序列化必须与键顺序无关，否则锚点链会误判 STALE
// ════════════════════════════════════════════════════════════════

test('stableStringify 与键顺序无关', () => {
  const a = { b: 1, a: { d: [1, 2], c: 'x' } };
  const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(contentHash(a), contentHash(b));
});

test('contentHash 对内容变化敏感', () => {
  assert.notEqual(contentHash({ x: 1 }), contentHash({ x: 2 }));
});

test('claimHash 忽略标点与虚词，捕获换皮复读', () => {
  const a = '后端接口 /api/tasks 的返回类型与契约不一致。';
  const b = '后端接口 /api/tasks 的返回类型和契约不一致';
  assert.equal(claimHashOf(a), claimHashOf(b));
});

// ════════════════════════════════════════════════════════════════
// schema 校验器
// ════════════════════════════════════════════════════════════════

test('schema：类型、必填、额外字段', () => {
  const s: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'n'],
    properties: { name: { type: 'string', minLength: 2 }, n: { type: 'integer', minimum: 3 } },
  };
  assert.equal(validateSchema({ name: 'ab', n: 3 }, s, s).length, 0);

  const errs = validateSchema({ n: 1, extra: true }, s, s);
  const keywords = errs.map((e) => e.keyword).sort();
  assert.deepEqual(keywords, ['additionalProperties', 'minimum', 'required']);
  assert.ok(formatSchemaErrors(errs).includes('name'));
});

test('schema：oneOf 必须恰好命中一项', () => {
  const s: JsonSchema = { oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] };
  const errs = validateSchema('hi', s, s);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].keyword, 'oneOf');
  assert.ok(errs[0].message.includes('恰好满足一项'));
});

test('schema：$ref 解析', () => {
  const s: JsonSchema = {
    $defs: { positive: { type: 'integer', minimum: 1 } },
    type: 'object',
    properties: { v: { $ref: '#/$defs/positive' } },
  };
  assert.equal(validateSchema({ v: 5 }, s, s).length, 0);
  assert.equal(validateSchema({ v: 0 }, s, s).length, 1);
});

test('schema：工件内容校验给出可回喂给模型的错误', () => {
  const bad = validateArtifactContent('Requirement', {
    requirements: [{ id: 'BAD', text: 'x', acceptance: [], priority: 'must', status: 'open', origin: 'user' }],
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.message.startsWith('SCHEMA_REJECT(Requirement)'));
    assert.ok(bad.message.includes('R-'));
    assert.ok(bad.message.includes('acceptance'));
  }

  const good = validateArtifactContent('Requirement', {
    requirements: [
      {
        id: 'R-001',
        text: '用户可创建任务',
        acceptance: ['POST /api/tasks 返回 201 且持久化'],
        priority: 'must',
        status: 'open',
        origin: 'user',
      },
    ],
  });
  assert.equal(good.ok, true);
});

// ════════════════════════════════════════════════════════════════
// 工件存储：权限、schema 门禁、版本链、不可变、锚点失效
// ════════════════════════════════════════════════════════════════

async function freshStore(): Promise<{ store: ArtifactStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'af-store-'));
  const store = new ArtifactStore(dir);
  await store.init();
  return { store, dir };
}

const reqSet = (text: string) => ({
  requirements: [
    { id: 'R-001', text, acceptance: ['可被 HTTP 探针验证'], priority: 'must', status: 'open', origin: 'user' },
  ],
});

test('store：写权限矩阵强制（主理人不能写代码）', async () => {
  const { store, dir } = await freshStore();
  try {
    await assert.rejects(
      () => store.put({ kind: 'CodeModule', producer: 'host', content: { files: [{ path: 'a.ts', content: '' }] } }),
      (e: Error) => e instanceof PermissionDenied && e.message.includes('写权限拒绝'),
    );
    await assert.rejects(
      () => store.put({ kind: 'Requirement', producer: 'frontend', content: reqSet('越权') }),
      PermissionDenied,
    );
    await assert.rejects(
      () => store.put({ kind: 'Directive', producer: 'pm', content: { kind: 'hold', text: 'x' } }),
      PermissionDenied,
      '建议书只有真人能投',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store：schema 门禁拒绝不入库', async () => {
  const { store, dir } = await freshStore();
  try {
    await assert.rejects(
      () => store.put({ kind: 'Requirement', producer: 'pm', content: { requirements: [] } }),
      (e: Error) => e instanceof SchemaReject && e.message.includes('minItems'),
    );
    assert.equal(store.all('Requirement').length, 0, '被拒的工件不得入库');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store：不可变 + 版本链 + 幂等', async () => {
  const { store, dir } = await freshStore();
  try {
    const v1 = await store.put({ kind: 'PRD', producer: 'pm', content: prd('v1') });
    const v1again = await store.put({ kind: 'PRD', producer: 'pm', content: prd('v1') });
    assert.equal(v1.id, v1again.id, '同内容重复写入应幂等返回既有版本');

    const v2 = await store.put({ kind: 'PRD', producer: 'pm', content: prd('v2') });
    assert.equal(v2.version, 2);
    assert.equal(v2.supersedes, v1.id);
    assert.equal(store.all('PRD').length, 2, '旧版本必须保留（历史不可改写）');
    assert.equal(store.heads('PRD').length, 1);
    assert.equal(store.head('PRD')!.id, v2.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store：锚点结果绑定内容 hash，内容变更后旧绿灯失效', async () => {
  const { store, dir } = await freshStore();
  try {
    const v1 = await store.put({ kind: 'PRD', producer: 'pm', content: prd('v1') });
    await store.recordAnchorResult({
      anchorId: 'B1',
      runId: 'run-1',
      subjects: [v1.id],
      contentHashes: { [v1.id]: v1.contentHash },
      verdict: 'PASS',
      findings: [],
      method: 'llm+evidence-verifier',
      authority: 'approximate',
      at: new Date().toISOString(),
      durationMs: 1,
    });
    assert.equal(store.freshAnchorsOf(v1.id).length, 1);

    // 直接篡改磁盘上的内容 hash，模拟「用旧绿灯照亮新代码」
    const tampered = store.require(v1.id);
    tampered.contentHash = contentHash(prd('被偷偷改过'));
    const n = await store.refreshStaleness();
    assert.equal(n, 1);
    assert.equal(store.freshAnchorsOf(v1.id).length, 0, 'STALE 结论不得再算作有效');

    const chain = store.require(v1.id).anchorChain;
    assert.equal(chain[0].verdict, 'STALE');
    assert.ok(chain[0].findings[0].message.includes('必须重跑'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store：冻结契约 hash 可被下游取用', async () => {
  const { store, dir } = await freshStore();
  try {
    assert.equal(store.frozenContractHash(), null);
    const c = await store.put({
      kind: 'Contract',
      producer: 'pm',
      freeze: true,
      content: {
        version: 1,
        openapi: { openapi: '3.1.0', paths: { '/api/tasks': {} } },
        jsonSchemas: { Task: { type: 'object' } },
        generatedTypesPath: 'shared/contract/types.ts',
        changeRequests: [],
      },
    });
    assert.equal(store.frozenContractHash(), c.contentHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store：unfreezable 类型不得冻结', async () => {
  const { store, dir } = await freshStore();
  try {
    await assert.rejects(() => store.put({ kind: 'PRD', producer: 'pm', content: prd('x'), freeze: true }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 决策日志：append-only 哈希链
// ════════════════════════════════════════════════════════════════

test('decisionlog：哈希链完整性与篡改检测', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-log-'));
  try {
    const log = new DecisionLog(dir);
    await log.init();
    await log.append('run.started', { project: 'demo' });
    await log.append('stage.entered', { stage: 'INTAKE' });
    await log.append('directive.received', { kind: 'resume' });
    assert.equal(log.length, 3);
    assert.deepEqual(await log.verify(), { ok: true });

    // 篡改中间一条记录的 payload
    const path = join(dir, 'decisions.jsonl');
    const lines = (await import('node:fs/promises')).readFile;
    const raw = await lines(path, 'utf8');
    const broken = raw.replace('"INTAKE"', '"PLANNING"');
    await writeFile(path, broken, 'utf8');

    const log2 = new DecisionLog(dir);
    await log2.init();
    const v = await log2.verify();
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.brokenAtSeq, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 子进程执行：真实退出码捕获 + 命令安全闸
// ════════════════════════════════════════════════════════════════

test('exec：捕获真实 stdout/stderr/退出码（不依赖管道）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-exec-'));
  try {
    const r = await execCapture('node -e "console.log(1+1); console.error(\'boom\')"', { cwd: dir });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '2');
    assert.equal(r.stderr.trim(), 'boom');

    const fail = await execCapture('node -e "process.exit(7)"', { cwd: dir });
    assert.equal(fail.exitCode, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exec：LLM 生成的 falsifier 命令被安全策略拦下', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-exec-'));
  try {
    const denied = [
      'rm -rf /',
      'curl http://evil.example',
      'powershell -Command Remove-Item -Recurse',
      'node -e "x" && rm -rf .',
      'node -e "a" | cmd /c del',
      'foo --version',
      'node ../outside/evil.js',
      'node E:\\Windows\\System32\\evil.js',
    ];
    for (const cmd of denied) {
      const r = await execCapture(cmd, { cwd: dir });
      assert.ok(r.deniedReason, `命令应被拒绝：${cmd}（实际 exit=${r.exitCode}）`);
      assert.equal(r.exitCode, -1);
    }

    // 合法用法不得被误杀 —— 第一版策略就是因为这个原因被推翻重写
    const ok = await execCapture('node --version', { cwd: dir });
    assert.equal(ok.deniedReason, undefined);
    assert.equal(ok.exitCode, 0);

    const inline = await execCapture('node -e "const a=[1,2]; console.log(a.length)"', { cwd: dir });
    assert.equal(inline.deniedReason, undefined, '内联脚本里的分号不得被误判');
    assert.equal(inline.stdout.trim(), '2');

    const rel = await execCapture('node ./sub/ok.js', { cwd: dir });
    assert.equal(rel.deniedReason, undefined, '项目内的相对路径应放行');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function prd(tag: string) {
  return {
    title: `PRD ${tag}`,
    summary: `这是 ${tag} 版本的产品需求文档摘要内容`,
    requirementIds: ['R-001'],
    milestones: [{ name: 'M1', deliverables: ['API'] }],
    nonGoals: ['不做多租户'],
  };
}
