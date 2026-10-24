// ─────────────────────────────────────────────────────────────
// 本文件由 AgentForge 从冻结契约自动生成，请勿手工编辑。
// 契约指纹: bfaba83be9488c46
//
// 注意：手工修改本文件不会改变契约 —— 下次冻结时会覆盖。
// 要改接口，请走「契约变更请求（ChangeRequest）」流程。
// ─────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok";
}

export type TaskStatus = "todo" | "doing" | "done";

export interface Task {
  id: string;
  title: string;
  status: unknown;
  createdAt: string;
}

export interface CreateTaskRequest {
  title: string;
  status?: unknown;
}

export interface UpdateTaskRequest {
  status: unknown;
}

export interface ErrorResponse {
  error: string;
}

/** 契约声明的全部端点。前端必须引用这里，不得手写字符串字面量。 */
export const API_PATHS = {
  "/health": "/health",
  "/": "/",
  "/api/tasks": "/api/tasks",
  "/api/tasks/{id}": "/api/tasks/{id}",
} as const;

export type ApiPath = (typeof API_PATHS)[keyof typeof API_PATHS];
