/**
 * 「会扮演五个角色」的假 OpenAI 兼容端点行为（测试共享，非测试文件本身）。
 *
 * 路由依据有两个，缺一不可：
 *   1. `response_format.json_schema.name` —— 严格模式下等于 roles 层传的 schemaName
 *      （也就是工件类型）。它存在本身就证明了 Provider 确实把 schemaName 传了出去。
 *   2. **内容特征**。降级到 json-mode / prompt-only 后请求里不再有 json_schema，
 *      于是调用方**确实失去了唯一的形状信号**。第一版只按 schemaName 路由，
 *      结果「降级」用例全线失败 —— 那不是产品 bug，而是降级路径的真实属性。
 *      真实网关同样要面对这个问题，所以这里补一条内容路由作为对照实现。
 */

import type { FakeBehavior } from '../../llm/test/fake-server.ts';

export const API_CODE = [
  "import { padLeft } from 'leftpad-real';",
  "import type { Task } from '../../shared/contract/types';",
  '',
  'const store: Task[] = [];',
  '',
  'export function listTasks(): Task[] {',
  '  return store;',
  '}',
  '',
  'export function createTask(title: string): Task {',
  '  const t: Task = { id: padLeft(String(store.length + 1), 4), title };',
  '  store.push(t);',
  '  return t;',
  '}',
  '',
  "export const ROUTES = ['/api/tasks'];",
  '',
].join('\n');

export const WEB_CODE = [
  "import type { Task } from '../../shared/contract/types';",
  '',
  'export async function loadTasks(): Promise<Task[]> {',
  "  const res = await fetch('/api/tasks');",
  '  return res.json();',
  '}',
  '',
].join('\n');

export const PAYLOADS: Record<string, unknown> = {
  Requirement: {
    requirements: [
      {
        id: 'R-001',
        text: '用户可以创建任务',
        acceptance: ['POST /api/tasks 返回 201'],
        priority: 'must',
        status: 'open',
        origin: 'user',
      },
      {
        id: 'R-002',
        text: '用户可以列出全部任务',
        acceptance: ['GET /api/tasks 返回 200'],
        priority: 'must',
        status: 'open',
        origin: 'user',
      },
    ],
  },
  PRD: {
    title: '任务看板 PRD',
    summary: '提供任务的创建与查询能力，覆盖两条 must 级需求。',
    requirementIds: ['R-001', 'R-002'],
    milestones: [{ name: 'M1', deliverables: ['REST API', '前端数据层'] }],
    nonGoals: ['不做多租户'],
  },
  TaskGraph: {
    tasks: [
      {
        id: 'T-01',
        title: '实现任务 REST API',
        owner: 'backend',
        scope: 'api',
        dependsOn: [],
        requirementIds: ['R-001', 'R-002'],
        deliverable: 'CodeModule',
        acceptance: ['A4 锚点 PASS', 'A7 锚点 PASS'],
      },
      {
        id: 'T-02',
        title: '实现前端数据层',
        owner: 'frontend',
        scope: 'web',
        dependsOn: [],
        requirementIds: ['R-001', 'R-002'],
        deliverable: 'CodeModule',
        acceptance: ['A4 锚点 PASS'],
      },
    ],
  },
  Contract: {
    version: 1,
    openapi: { openapi: '3.1.0', paths: { '/api/tasks': {} } },
    jsonSchemas: {
      Task: {
        type: 'object',
        required: ['id', 'title'],
        properties: { id: { type: 'string' }, title: { type: 'string' } },
      },
    },
    generatedTypesPath: 'shared/contract/types.ts',
    changeRequests: [],
  },
  TestSuite: {
    framework: 'node:test',
    files: [{ path: 'tests/tasks.test.ts', content: "import { test } from 'node:test';\ntest('t', () => {});\n" }],
    covers: ['R-001', 'R-002'],
  },
  AnchoredReview: { stage: 'REVIEW', objections: [], noObjection: true },
  RequirementVerdicts: {
    requirementVerdicts: [
      {
        requirementId: 'R-001',
        verdict: 'met',
        rationale: 'createTask 已实现',
        evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 10, endLine: 14, expect: 'createTask' }],
      },
      {
        requirementId: 'R-002',
        verdict: 'met',
        rationale: 'listTasks 已实现',
        evidenceRefs: [{ kind: 'file', path: 'src/api/routes.ts', startLine: 6, endLine: 8, expect: 'listTasks' }],
      },
    ],
  },
  Probe: { ok: true, note: 'probe', tag: 'x' },
};

/** 内容路由：降级路径下请求里没有 json_schema，只能靠指令文本里的稳定特征串辨认。 */
export function routeByContent(text: string): string | undefined {
  if (text.includes('目标达成验证者')) return 'RequirementVerdicts';
  if (text.includes('输出 Requirement 集合工件')) return 'Requirement';
  if (text.includes('产出 PRD')) return 'PRD';
  if (text.includes('产出任务图')) return 'TaskGraph';
  if (text.includes('前后端共同遵守的接口契约')) return 'Contract';
  if (text.includes('输出 CodeModule 工件')) return 'CodeModule';
  if (text.includes('输出 TestSuite 工件')) return 'TestSuite';
  if (text.includes('输出 AnchoredReview 工件')) return 'AnchoredReview';
  return undefined;
}

/** 每次响应固定 300+120=420 tokens，便于断言预算账目。 */
export const TOKENS_PER_CALL = 420;

export const rolePlayer = (): FakeBehavior => ({ body }) => {
  const rf = body.response_format as { json_schema?: { name?: string } } | undefined;
  const text = JSON.stringify(body.messages ?? []);
  const name = rf?.json_schema?.name ?? routeByContent(text);
  const model = String(body.model ?? 'fake');

  let payload: unknown;
  if (name === 'CodeModule') {
    // 指令里写的是「范围 web」；JSON.stringify 会把中文转义，所以两种形式都要认
    const isWeb = text.includes('范围 web') || text.includes('\\u8303\\u56f4 web');
    payload = {
      files: [
        { path: isWeb ? 'src/web/client.ts' : 'src/api/routes.ts', content: isWeb ? WEB_CODE : API_CODE },
      ],
    };
  } else if (name && PAYLOADS[name]) {
    payload = PAYLOADS[name];
  } else {
    payload = { ok: true };
  }

  return {
    body: {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 300, completion_tokens: 120, total_tokens: TOKENS_PER_CALL },
    },
  };
};
