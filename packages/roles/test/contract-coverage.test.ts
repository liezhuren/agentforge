/**
 * 契约覆盖校验：契约必须声明任务图要用到的每一条路径。
 *
 * 这是 2026-10-24 那次「成功率低」定位出来的**真正修法**。
 *
 * 失败形状（brief-s1 / agentforge-project 实测）：
 *   - 任务图：`/api/tasks`、`/api/tasks/{id}`（正常）
 *   - 契约：只有 `/health`，数据模型写了 4–7 个
 *   两份工件各自都"合法"，放在一起矛盾 → A7 连报 9 轮 `phantom-contract-path`
 *   → PM 返工重写契约 → 又抽到一次塌缩 → 带债收场。
 *
 * `minProperties: 1` 拦不住这种情况（paths 并不空，它有 /health）。
 * 所以检查必须**跨工件**，而且要放在**生成阶段**——复用现成的「回喂错误 → 重试」，
 * 让 PM 当场补齐，而不是等一整轮 Gate 后被判罚。
 *
 * 这组测试守三件事：
 *   1. 真的能算出「任务图有、契约没有」的路径（并用真实历史工件验证）；
 *   2. 不误伤：覆盖完整时必须是 0 条；
 *   3. 没有任务图时不阻塞（无法交叉校验 ≠ 校验失败）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  contractCoverageErrors,
  contractPathsOf,
  missingContractPaths,
  taskGraphPathsOf,
} from '../src/contractcoverage.ts';

const contract = (paths: string[]) => ({
  version: 1,
  openapi: { openapi: '3.1.0', paths: Object.fromEntries(paths.map((p) => [p, {}])) },
  jsonSchemas: {},
  generatedTypesPath: 'src/shared/contract-types.ts',
  changeRequests: [],
});

const taskGraph = (tasks: Array<{ id: string; contractPaths: string[] }>) => ({
  version: 1,
  tasks: tasks.map((t) => ({
    id: t.id,
    title: t.id,
    owner: 'backend',
    scope: 'api',
    dependsOn: [],
    requirementIds: ['R-001'],
    deliverable: 'CodeModule',
    acceptance: ['ok'],
    contractPaths: t.contractPaths,
  })),
});

test('🔴 任务图声明了 /api/tasks，契约只有 /health → 必须报缺口（brief-s1 的死因）', () => {
  const errs = contractCoverageErrors(
    contract(['/health']),
    taskGraph([{ id: 'T-001', contractPaths: ['/health', '/api/tasks', '/api/tasks/{id}'] }]),
  );
  assert.equal(errs.length, 2, '两条业务路径都缺');
  assert.deepEqual(
    errs.map((e) => JSON.parse(e.message.match(/"(.*?)"/)?.[0] ?? '""')),
    ['/api/tasks', '/api/tasks/{id}'],
  );
  for (const e of errs) {
    assert.equal(e.path, '$.openapi.paths', '错误要指向契约的 paths，便于回喂');
    assert.equal(e.keyword, 'contract-coverage');
    assert.match(e.message, /T-001/, '要点名是哪个任务声明的，模型才知道补什么');
  }
});

test('覆盖完整时必须是 0 条（不误伤成功的 run）', () => {
  const paths = ['/health', '/api/tasks', '/api/tasks/{id}', '/api/stats'];
  const errs = contractCoverageErrors(contract(paths), taskGraph([{ id: 'T-001', contractPaths: paths }]));
  assert.deepEqual(errs, []);
});

test('没有任务图 → 不阻塞（无法交叉校验 ≠ 校验失败）', () => {
  assert.deepEqual(contractCoverageErrors(contract(['/health']), null), []);
  assert.deepEqual(contractCoverageErrors(contract(['/health']), undefined), []);
});

test('同一路径被多个任务声明 → 只报一条，但要点名所有任务', () => {
  const errs = contractCoverageErrors(
    contract([]),
    taskGraph([
      { id: 'T-001', contractPaths: ['/api/tasks'] },
      { id: 'T-003', contractPaths: ['/api/tasks'] },
    ]),
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0]!.message, /T-001\/T-003/);
});

test('非路径字符串（模型名/相对路径）不参与比对', () => {
  const tg = taskGraph([{ id: 'T-001', contractPaths: ['/api/tasks', 'Task', 'src/x.ts'] }]);
  assert.deepEqual(taskGraphPathsOf(tg), ['/api/tasks']);
  assert.equal(contractCoverageErrors(contract(['/api/tasks']), tg).length, 0);
});

test('契约缺 paths 字段时按"全缺"处理（不静默通过）', () => {
  const broken = { version: 1, openapi: { openapi: '3.1.0' }, jsonSchemas: {}, generatedTypesPath: 'x.ts', changeRequests: [] };
  assert.deepEqual(contractPathsOf(broken), []);
  const errs = contractCoverageErrors(broken, taskGraph([{ id: 'T-001', contractPaths: ['/api/tasks'] }]));
  assert.equal(errs.length, 1);
});

test('只查一个方向：契约多声明了没人认领的路径不报错（那是 A7 的事）', () => {
  const errs = contractCoverageErrors(
    contract(['/health', '/api/tasks', '/api/future']),
    taskGraph([{ id: 'T-001', contractPaths: ['/api/tasks'] }]),
  );
  assert.deepEqual(errs, [], '多余的端点未必是错的（可能是下一步要实现的），交给 A7 判');
});

/**
 * 用**真实历史工件**回归：两次失败的 run 必须报出缺口，两次成功的必须是 0 条。
 *
 * ⚠️ 工件已固化在 `test/fixtures/contract-coverage/`，**不读 `workspace/`**。
 * 第一版直接读 `workspace/<run>/artifacts/`，本地绿、CI 红 ——
 * 因为 `workspace/*` 是 gitignore 的运行数据，干净检出里根本没有。
 * 这正是这个仓库 CI 存在的理由（见 `.github/workflows/ci.yml` 开头那段注释）：
 * 「作者本地绿、读者第一次打开就红」这类缺陷只有干净环境才能暴露。
 */
test('用真实历史工件回归：两次失败必须报缺口，两次成功必须 0 条', () => {
  // 相对**测试文件**定位，而不是 cwd —— 否则换个工作目录跑就找不到（CI 上正是如此）
  const dir = join(import.meta.dirname, 'fixtures', 'contract-coverage');
  const read = (w: string, kind: string): unknown =>
    JSON.parse(readFileSync(`${dir}/${w}.${kind}.json`, 'utf8'));

  const cases: Array<[string, number, string]> = [
    ['brief-s1', 2, '契约只有 /health，任务图声明了 2 条业务路径'],
    ['agentforge-project', 1, '同一种塌缩'],
    ['brief-s2', 0, '交付成功的 run 不该报缺口'],
    ['brief-s3', 0, '交付成功的 run 不该报缺口'],
  ];

  for (const [w, expected, why] of cases) {
    const errs = contractCoverageErrors(read(w, 'contract'), read(w, 'taskgraph'));
    assert.equal(errs.length, expected, `${w}：${why}（期望 ${expected} 条，实际 ${errs.length}）`);
  }
});