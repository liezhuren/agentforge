// ─────────────────────────────────────────────────────────────
// 本文件由 AgentForge 从冻结契约自动生成，请勿手工编辑。
// 契约指纹: e9afa78d9108d43d
//
// 注意：手工修改本文件不会改变契约 —— 下次冻结时会覆盖。
// 要改接口，请走「契约变更请求（ChangeRequest）」流程。
// ─────────────────────────────────────────────────────────────

export interface HealthStatus {
  status: "ok";
}

export interface ErrorResponse {
  error: string;
}

export type NoContent = null;

export type HtmlPage = string;

export interface Paper {
  id: string;
  createdAt: string;
  title: string;
  paperType: string;
  publishedAt: string;
  publication: string;
  conferenceName: string;
  conferenceAddress: string;
  venueLevel: string;
  indexCategory: string;
  eiNumber: string;
  doi: string;
  issn: string;
  cnNumber: string;
  affiliation: string;
  moeCategory: string;
  schoolRanking: string;
  publishScope: string;
  volumeIssue: string;
  projectSource: string;
}

export interface PaperInput {
  title: string;
  paperType?: string;
  publishedAt?: string;
  publication?: string;
  conferenceName?: string;
  conferenceAddress?: string;
  venueLevel?: string;
  indexCategory?: string;
  eiNumber?: string;
  doi?: string;
  issn?: string;
  cnNumber?: string;
  affiliation?: string;
  moeCategory?: string;
  schoolRanking?: string;
  publishScope?: string;
  volumeIssue?: string;
  projectSource?: string;
}

export type PaperPatch = {
  title?: string;
  paperType?: string;
  publishedAt?: string;
  publication?: string;
  conferenceName?: string;
  conferenceAddress?: string;
  venueLevel?: string;
  indexCategory?: string;
  eiNumber?: string;
  doi?: string;
  issn?: string;
  cnNumber?: string;
  affiliation?: string;
  moeCategory?: string;
  schoolRanking?: string;
  publishScope?: string;
  volumeIssue?: string;
  projectSource?: string;
};

export type PaperList = unknown[];

export interface AuthRegisterRequest {
  username: string;
  password: string;
}

export interface AuthRegisterResponse {
  userId: string;
  username: string;
}

export interface AuthLoginRequest {
  username: string;
  password: string;
}

export interface AuthLoginResponse {
  token: string;
  userId: string;
}

export interface MeResponse {
  userId: string;
  username: string;
  interests: string[];
}

export interface InterestsUpdate {
  interests: string[];
}

export interface Comment {
  id: string;
  paperId: string;
  parentCommentId: string | null;
  userId: string;
  content: string;
  createdAt: string;
}

export interface CommentInput {
  content: string;
  parentCommentId?: string | null;
}

export type CommentList = unknown[];

export interface FriendRequestCreate {
  toUserId: string;
}

export interface FriendRequestItem {
  requestId: string;
  fromUserId: string;
  toUserId: string;
  status: "pending" | "accepted";
  createdAt: string;
}

export type FriendRequestList = unknown[];

export type FriendList = string[];

export type FollowerList = string[];

export type RecommendationList = unknown[];

/** 契约声明的全部端点。前端必须引用这里，不得手写字符串字面量。 */
export const API_PATHS = {
  "/health": "/health",
  "/": "/",
  "/api/auth/register": "/api/auth/register",
  "/api/auth/login": "/api/auth/login",
  "/api/me": "/api/me",
  "/api/me/interests": "/api/me/interests",
  "/api/papers": "/api/papers",
  "/api/papers/{id}": "/api/papers/{id}",
  "/api/papers/{id}/comments": "/api/papers/{id}/comments",
  "/api/friends/requests": "/api/friends/requests",
  "/api/friends/requests/{requestId}/accept": "/api/friends/requests/{requestId}/accept",
  "/api/friends": "/api/friends",
  "/api/follows/{userId}": "/api/follows/{userId}",
  "/api/users/{userId}/followers": "/api/users/{userId}/followers",
  "/api/recommendations": "/api/recommendations",
} as const;

export type ApiPath = (typeof API_PATHS)[keyof typeof API_PATHS];
