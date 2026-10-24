// ─────────────────────────────────────────────────────────────
// 本文件由 AgentForge 从冻结契约自动生成，请勿手工编辑。
// 契约指纹: 3f886f3455b572c1
//
// 注意：手工修改本文件不会改变契约 —— 下次冻结时会覆盖。
// 要改接口，请走「契约变更请求（ChangeRequest）」流程。
// ─────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
}

/** 契约声明的全部端点。前端必须引用这里，不得手写字符串字面量。 */
export const API_PATHS = {
  "/api/tasks": "/api/tasks",
  "/health": "/health",
} as const;

export type ApiPath = (typeof API_PATHS)[keyof typeof API_PATHS];
