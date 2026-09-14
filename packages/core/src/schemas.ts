/**
 * 工件 JSON Schema 定义。
 *
 * 这是「接口即通信」的强制层（docs/04-interface-protocol.md §1）：
 * 任何写入必须通过这里的校验，失败即 SCHEMA_REJECT，工件不入库。
 * 角色之间因此不存在「理解偏差」这种失败模式 —— 只有 schema 校验通过或不通过。
 *
 * 同一份 schema 也用于约束 LLM 的结构化输出（P2 接真模型时直接复用）。
 */

import type { ArtifactKind } from './types.ts';
import { ARTIFACT_KINDS } from './types.ts';
import { validateSchema, formatSchemaErrors, type JsonSchema, type SchemaError } from './schema.ts';

const stringArray: JsonSchema = { type: 'array', items: { type: 'string' } };

const evidenceRef: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path', 'startLine', 'endLine'],
      properties: {
        kind: { const: 'file' },
        path: { type: 'string', minLength: 1 },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        expect: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'artifactId'],
      properties: { kind: { const: 'artifact' }, artifactId: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'anchorId', 'runId'],
      properties: {
        kind: { const: 'anchor' },
        anchorId: {
          type: 'string',
          enum: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'B1', 'B2', 'B3'],
        },
        runId: { type: 'string', minLength: 1 },
      },
    },
  ],
};

export const falsifierSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'command', 'expect'],
      properties: {
        kind: { const: 'executable' },
        command: { type: 'string', minLength: 1 },
        expect: { type: 'string', enum: ['exit-nonzero', 'output-matches'] },
        pattern: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'text'],
      properties: { kind: { const: 'question' }, text: { type: 'string', minLength: 1 } },
    },
  ],
};

export const objectionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'stage',
    'author',
    'targetRole',
    'severity',
    'claim',
    'evidence',
    'falsifier',
    'claimHash',
    'evidenceHash',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', minLength: 1 },
    stage: { type: 'string', minLength: 1 },
    author: { const: 'host' },
    targetRole: {
      type: 'string',
      enum: ['pm', 'frontend', 'backend', 'test', 'host', 'UNRESOLVED'],
    },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
    claim: { type: 'string', minLength: 10 },
    evidence: { type: 'array', minItems: 1, items: evidenceRef },
    falsifier: falsifierSchema,
    proposedFix: { type: 'string' },
    claimHash: { type: 'string', minLength: 8 },
    evidenceHash: { type: 'string', minLength: 8 },
    createdAt: { type: 'string', minLength: 1 },
  },
};

const changeRequestSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'reason', 'evidence', 'impact', 'falsifier', 'status'],
  properties: {
    id: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1 },
    evidence: { type: 'array', minItems: 1, items: evidenceRef },
    impact: { type: 'array', minItems: 1, items: { type: 'string' } },
    falsifier: falsifierSchema,
    status: { type: 'string', enum: ['proposed', 'accepted', 'rejected'] },
  },
};

export const requirementSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'text', 'acceptance', 'priority', 'status', 'origin'],
  properties: {
    id: { type: 'string', pattern: '^R-[0-9]{3,}$' },
    text: { type: 'string', minLength: 5 },
    acceptance: { type: 'array', minItems: 1, items: { type: 'string', minLength: 3 } },
    priority: { type: 'string', enum: ['must', 'should', 'could'] },
    // unverified = 查过了但确认不了（与 open「还没查」刻意分开，见 types.ts 的说明）
    status: { type: 'string', enum: ['open', 'unverified', 'accepted_with_debt', 'met'] },
    origin: { type: 'string', enum: ['user', 'pm', 'directive'] },
  },
};

/** 需求集合以数组形式存储在一个工件里（便于原子发布与 hash 绑定）。 */
export const requirementSetSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: { requirements: { type: 'array', minItems: 1, items: requirementSchema } },
};

export const prdSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'requirementIds', 'milestones', 'nonGoals'],
  properties: {
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 10 },
    requirementIds: { type: 'array', minItems: 1, items: { type: 'string' } },
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'deliverables'],
        properties: { name: { type: 'string' }, deliverables: stringArray },
      },
    },
    nonGoals: stringArray,
  },
};

export const taskGraphSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'owner', 'scope', 'dependsOn', 'requirementIds', 'deliverable', 'acceptance'],
        properties: {
          id: { type: 'string', pattern: '^T-[0-9]{2,}$' },
          title: { type: 'string', minLength: 1 },
          owner: { type: 'string', enum: ['pm', 'frontend', 'backend', 'test'] },
          scope: { type: 'string', enum: ['web', 'api', 'shared'] },
          dependsOn: stringArray,
          requirementIds: { type: 'array', minItems: 1, items: { type: 'string' } },
          deliverable: { type: 'string', enum: [...ARTIFACT_KINDS] },
          acceptance: { type: 'array', minItems: 1, items: { type: 'string', minLength: 3 } },
        },
      },
    },
  },
};

export const contractSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'openapi', 'jsonSchemas', 'generatedTypesPath', 'changeRequests'],
  properties: {
    version: { type: 'integer', minimum: 1 },
    openapi: {
      type: 'object',
      required: ['openapi', 'paths'],
      properties: {
        openapi: { type: 'string' },
        paths: { type: 'object' },
        components: {},
      },
    },
    jsonSchemas: { type: 'object' },
    generatedTypesPath: { type: 'string', minLength: 1 },
    changeRequests: { type: 'array', items: changeRequestSchema },
  },
};

export const codeModuleSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
      },
    },
    note: { type: 'string' },
  },
};

export const testSuiteSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['framework', 'files', 'covers'],
  properties: {
    framework: { type: 'string', minLength: 1 },
    files: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
      },
    },
    covers: stringArray,
  },
};

export const testReportSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'exitCode', 'passed', 'failed', 'failing'],
  properties: {
    command: { type: 'string' },
    exitCode: { type: 'integer' },
    passed: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    failing: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'message'],
        properties: { name: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
};

export const anchoredReviewSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'objections', 'noObjection'],
  properties: {
    stage: { type: 'string', minLength: 1 },
    objections: { type: 'array', items: objectionSchema },
    noObjection: { type: 'boolean' },
  },
};

/**
 * 圆桌第 1/2 轮的一条发言。
 *
 * 存在的理由（真实 LLM 实测发现的缺陷，见 docs/07 §L4）：
 * 编排器调用 LLM 产出圆桌发言时**没有传 schema**，
 * 而 `OpenAiCompatProvider` 在 `!req.schema` 时直接返回裸文本（`json` 为 undefined）。
 * 于是每条发言都变成「(未给出主张) + 无证据」→ 被机械主持全部丢弃 → 圆桌永远无效。
 *
 * MockProvider 把这件事完整地掩盖住了：它不看 schema，直接返回脚本值。
 * **Mock 通过 ≠ 真实通过。**
 */
export const roundtableStatementSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['claim', 'evidence'],
  properties: {
    claim: { type: 'string', minLength: 3 },
    evidence: { type: 'array', minItems: 1, items: evidenceRef },
    suggests: { type: 'string' },
    // 第 2 轮才用得上；第 1 轮带上也无害（多一个字段不算错）
    falsifier: falsifierSchema,
  },
};

/**
 * 圆桌决议。
 *
 * 同样必须显式传给 LLM —— 少了它，`res.json` 为 undefined，
 * 决议恒为 null，圆桌永远「未产出任何决议」，只能一路升级真人。
 *
 * 注意 actions 用 `minItems: 0` 而不是 1，理由见下方 roundtableMinuteSchema 里的说明：
 * **失败必须可记录**。schema 管结构，「决议是否可执行」归 validateResolution 管。
 */
export const roundtableResolutionSchema: JsonSchema = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['attribution', 'decision', 'actions'],
      properties: {
        attribution: { type: 'string', enum: ['pm', 'frontend', 'backend', 'test', 'host', 'SHARED', 'REQUIREMENT_DEFECT', 'CONTRACT_DEFECT'] },
        decision: { type: 'string', minLength: 5 },
        actions: {
          type: 'array',
          minItems: 0,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['owner', 'action', 'acceptance'],
            properties: {
              owner: { type: 'string', enum: ['pm', 'frontend', 'backend', 'test'] },
              action: { type: 'string', minLength: 3 },
              acceptance: { type: 'array', minItems: 1, items: { type: 'string', minLength: 3 } },
            },
          },
        },
        contractChange: changeRequestSchema,
      },
    },
  ],
};

export const roundtableMinuteSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger', 'participants', 'agenda', 'statements', 'resolution', 'anchorsCited'],
  properties: {
    trigger: { type: 'string', enum: ['T1', 'T2', 'T3', 'T4', 'T5'] },
    participants: { type: 'array', minItems: 2, items: { type: 'string' } },
    agenda: { type: 'array', minItems: 1, items: { type: 'string', minLength: 3 } },
    statements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'round', 'claim', 'evidence'],
        properties: {
          role: { type: 'string' },
          round: { type: 'integer', minimum: 1, maximum: 2 },
          claim: { type: 'string', minLength: 3 },
          evidence: { type: 'array', items: evidenceRef },
          discarded: { type: 'string' },
          againstRole: { type: 'string' },
          falsifier: falsifierSchema,
          falsifierOutcome: {
            type: 'object',
            additionalProperties: false,
            required: ['command', 'exitCode', 'matched', 'outcome'],
            properties: {
              command: { type: 'string' },
              exitCode: { type: 'integer' },
              matched: { type: 'boolean' },
              outcome: { type: 'string', enum: ['sustained', 'refuted', 'inconclusive'] },
              detail: { type: 'string' },
            },
          },
        },
      },
    },
    resolution: {
      /*
       * 直接复用 roundtableResolutionSchema —— 决议的 schema 被用在两处：
       *   1. 作为**发给 LLM 的输出契约**（没有它，模型返回的 JSON 根本不会被解析）
       *   2. 作为**工件门禁**（RoundtableMinute 落库时的校验）
       * 两处各写一份必然漂移：契约与门禁不一致时，
       * 会出现「模型按契约产出、却被门禁拒收」这种最难排查的错位。
       *
       * 关于 actions 的 minItems: 0，见 roundtableResolutionSchema 上的说明。
       */
      ...roundtableResolutionSchema,
    },
    escalation: { type: 'string', enum: ['HUMAN'] },
    /**
     * 为产出合法决议尝试了几次（含首次）。
     *
     * 记下来的理由：决议被拒后回喂错误重试是本项目「结构化重试」的又一处应用，
     * 而「这份决意是第几次才合法的」是审计时的重要信息 ——
     * 如果总是 3 次，说明校验器或提示词该改，而不是当成正常。
     */
    resolutionAttempts: { type: 'integer', minimum: 1 },
    anchorsCited: {
      type: 'array',
      items: { type: 'string', enum: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'B1', 'B2', 'B3'] },
    },
    invalidReason: { type: 'string' },
    /*
     * 当场执行的 falsifier 所确证/证伪的事实（docs/05 §1.2）。
     *
     * 注意这里的 outcome 只有 sustained / refuted，**不含 inconclusive** ——
     * inconclusive 不是事实，它只作为 statement.falsifierOutcome 留在发言上。
     * 会议记录不该把「执行不了」记成一条裁决。
     */
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statementIndex', 'role', 'claim', 'command', 'exitCode', 'outcome', 'implicates'],
        properties: {
          statementIndex: { type: 'integer', minimum: 0 },
          role: { type: 'string', enum: ['pm', 'frontend', 'backend', 'test', 'host'] },
          against: { type: 'string', enum: ['pm', 'frontend', 'backend', 'test', 'host'] },
          claim: { type: 'string', minLength: 3 },
          command: { type: 'string', minLength: 1 },
          exitCode: { type: 'integer' },
          outcome: { type: 'string', enum: ['sustained', 'refuted'] },
          implicates: { type: 'string', enum: ['pm', 'frontend', 'backend', 'test', 'host'] },
        },
      },
    },
  },
};

export const directiveSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'text'],
  properties: {
    kind: { type: 'string', enum: ['requirement', 'constraint', 'override', 'resume', 'hold'] },
    text: { type: 'string', minLength: 1 },
    targetRefs: stringArray,
    constraints: stringArray,
    supersedes: stringArray,
    expiresAtStage: { type: 'string' },
  },
};

export const debtRecordSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'summary', 'unresolvedObjectionIds', 'affectedRequirementIds', 'reason', 'at'],
  properties: {
    stage: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 5 },
    unresolvedObjectionIds: stringArray,
    affectedRequirementIds: stringArray,
    reason: { type: 'string', enum: ['human-unavailable', 'roundtable-deadlock', 'user-let-it-pass'] },
    at: { type: 'string', minLength: 1 },
  },
};

/** ArtifactKind → 内容 schema。 */
export const ARTIFACT_CONTENT_SCHEMAS: Record<ArtifactKind, JsonSchema> = {
  Requirement: requirementSetSchema,
  PRD: prdSchema,
  TaskGraph: taskGraphSchema,
  Contract: contractSchema,
  CodeModule: codeModuleSchema,
  TestSuite: testSuiteSchema,
  TestReport: testReportSchema,
  AnchoredReview: anchoredReviewSchema,
  RoundtableMinute: roundtableMinuteSchema,
  Directive: directiveSchema,
  DebtRecord: debtRecordSchema,
};

export type ArtifactValidation =
  | { ok: true }
  | { ok: false; errors: SchemaError[]; message: string };

export function validateArtifactContent(kind: ArtifactKind, content: unknown): ArtifactValidation {
  const schema = ARTIFACT_CONTENT_SCHEMAS[kind];
  if (!schema) {
    return {
      ok: false,
      errors: [{ path: '$', keyword: 'kind', message: `未知工件类型 ${kind}` }],
      message: `未知工件类型 ${kind}`,
    };
  }
  const errors = validateSchema(content, schema, schema);
  if (errors.length === 0) return { ok: true };
  return {
    ok: false,
    errors,
    message: `SCHEMA_REJECT(${kind}):\n${formatSchemaErrors(errors)}`,
  };
}

export { validateSchema, formatSchemaErrors, buildRepairHint } from './schema.ts';
export type { JsonSchema, SchemaError } from './schema.ts';
