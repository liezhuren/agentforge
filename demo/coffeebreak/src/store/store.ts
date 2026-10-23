import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password.ts';

/** 任务书要求的 18 个论文属性（R-003）。 */
export const PAPER_FIELD_NAMES = [
  'title',
  'paperType',
  'publishedAt',
  'publication',
  'conferenceName',
  'conferenceAddress',
  'venueLevel',
  'indexCategory',
  'eiNumber',
  'doi',
  'issn',
  'cnNumber',
  'affiliation',
  'moeCategory',
  'schoolRanking',
  'publishScope',
  'volumeIssue',
  'projectSource',
] as const;

export type PaperFieldName = (typeof PAPER_FIELD_NAMES)[number];

export type PaperFields = Record<PaperFieldName, string>;

export type StoredPaper = PaperFields & {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  interests: string[];
  createdAt: string;
}

export interface StoredComment {
  id: string;
  paperId: string;
  userId: string;
  parentCommentId: string | null;
  content: string;
  createdAt: string;
}

export type FriendRequestStatus = 'pending' | 'accepted';

export interface StoredFriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  status: FriendRequestStatus;
  createdAt: string;
}

export interface StoredFriendship {
  id: string;
  userAId: string;
  userBId: string;
  createdAt: string;
}

export interface StoredFollow {
  id: string;
  followerId: string;
  followeeId: string;
  createdAt: string;
}

export interface StoredSession {
  token: string;
  userId: string;
  createdAt: string;
}

export interface Store {
  users: StoredUser[];
  papers: StoredPaper[];
  comments: StoredComment[];
  friendRequests: StoredFriendRequest[];
  friendships: StoredFriendship[];
  follows: StoredFollow[];
  sessions: StoredSession[];
}

/** 种子管理员凭证（R-015 的权限判定依赖它；不新增注册接口）。 */
export const SEED_ADMIN_USERNAME = 'admin';
export const SEED_ADMIN_PASSWORD = 'admin123';

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(): string {
  return randomUUID();
}

function createSeedAdmin(): StoredUser {
  return {
    id: createId(),
    username: SEED_ADMIN_USERNAME,
    passwordHash: hashPassword(SEED_ADMIN_PASSWORD),
    isAdmin: true,
    interests: [],
    createdAt: nowIso(),
  };
}

export function createEmptyStore(): Store {
  return {
    users: [createSeedAdmin()],
    papers: [],
    comments: [],
    friendRequests: [],
    friendships: [],
    follows: [],
    sessions: [],
  };
}

/**
 * 进程内共享存储（模块级单例）。
 * 所有路由处理逻辑都引用同一个 store 对象，保证 R-017 的跨请求一致性。
 */
export const store: Store = createEmptyStore();

/** 清空并重新播种数据；保持 store 对象引用不变（测试用）。 */
export function resetStore(): Store {
  const fresh = createEmptyStore();
  store.users = fresh.users;
  store.papers = fresh.papers;
  store.comments = fresh.comments;
  store.friendRequests = fresh.friendRequests;
  store.friendships = fresh.friendships;
  store.follows = fresh.follows;
  store.sessions = fresh.sessions;
  return store;
}

export function findUserById(userId: string): StoredUser | undefined {
  return store.users.find((user) => user.id === userId);
}

export function findUserByUsername(username: string): StoredUser | undefined {
  return store.users.find((user) => user.username === username);
}

export function findSession(token: string): StoredSession | undefined {
  return store.sessions.find((session) => session.token === token);
}

export function findPaperById(paperId: string): StoredPaper | undefined {
  return store.papers.find((paper) => paper.id === paperId);
}

export function findCommentById(commentId: string): StoredComment | undefined {
  return store.comments.find((comment) => comment.id === commentId);
}

/** 用缺省空字符串补全 18 个字段后创建论文记录。 */
export function createPaperRecord(input: Record<string, unknown>, createdBy: string): StoredPaper {
  const timestamp = nowIso();
  const record: StoredPaper = {
    id: createId(),
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
    title: '',
    paperType: '',
    publishedAt: '',
    publication: '',
    conferenceName: '',
    conferenceAddress: '',
    venueLevel: '',
    indexCategory: '',
    eiNumber: '',
    doi: '',
    issn: '',
    cnNumber: '',
    affiliation: '',
    moeCategory: '',
    schoolRanking: '',
    publishScope: '',
    volumeIssue: '',
    projectSource: '',
  };
  for (const field of PAPER_FIELD_NAMES) {
    const value = input[field];
    if (typeof value === 'string') {
      record[field] = value;
    }
  }
  return record;
}
