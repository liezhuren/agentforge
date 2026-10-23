import type {
  FollowerList,
  FriendList,
  FriendRequestCreate,
  FriendRequestItem,
  FriendRequestList,
} from '../shared/contract-types.ts';
import type { Router } from '../http/router.ts';
import { badRequest, forbidden, notFound } from '../http/errors.ts';
import { readJsonBody } from '../http/body.ts';
import { sendJson, sendNoContent } from '../http/respond.ts';
import { createId, findUserById, nowIso } from '../store/store.ts';
import { requireUser } from './papers.ts';

/** 好友请求状态，与契约 FriendRequestItem.status 对齐。 */
type FriendRequestStatus = 'pending' | 'accepted';

interface FriendRequestRecord {
  requestId: string;
  fromUserId: string;
  toUserId: string;
  status: FriendRequestStatus;
  createdAt: string;
}

interface FriendshipRecord {
  userId: string;
  friendId: string;
  createdAt: string;
}

interface FollowRecord {
  followerId: string;
  followeeId: string;
  createdAt: string;
}

/**
 * 进程内单例：好友请求、好友关系、关注关系跨请求共享（R-017）。
 * 这些集合只在本模块内读写，避免依赖 store 内部未在本任务可见的字段定义。
 */
const friendRequests: FriendRequestRecord[] = [];
const friendships: FriendshipRecord[] = [];
const follows: FollowRecord[] = [];

/** 把内部记录投影为契约中的 FriendRequestItem（requestId 而非 id）。 */
function toFriendRequestItem(record: FriendRequestRecord): FriendRequestItem {
  return {
    requestId: record.requestId,
    fromUserId: record.fromUserId,
    toUserId: record.toUserId,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function hasFriend(userId: string, otherId: string): boolean {
  return friendships.some((record) => record.userId === userId && record.friendId === otherId);
}

/** 接受好友请求后写入双向好友关系（重复接受幂等）。 */
function addFriendPair(firstUserId: string, secondUserId: string): void {
  if (firstUserId === secondUserId) return;
  const createdAt = nowIso();
  if (!hasFriend(firstUserId, secondUserId)) {
    friendships.push({ userId: firstUserId, friendId: secondUserId, createdAt });
  }
  if (!hasFriend(secondUserId, firstUserId)) {
    friendships.push({ userId: secondUserId, friendId: firstUserId, createdAt });
  }
}

/** 某用户的好友 userId 列表（FriendList = string[]）。 */
function listFriendIds(userId: string): string[] {
  const ids: string[] = [];
  for (const record of friendships) {
    if (record.userId !== userId) continue;
    if (ids.includes(record.friendId)) continue;
    // 跳过已被清理/不存在的用户，避免残留关系出现在好友列表里。
    if (findUserById(record.friendId) === undefined) continue;
    ids.push(record.friendId);
  }
  return ids;
}

/** 某用户的关注者 userId 列表（FollowerList = string[]）。 */
function listFollowerIds(userId: string): string[] {
  const ids: string[] = [];
  for (const record of follows) {
    if (record.followeeId !== userId) continue;
    if (ids.includes(record.followerId)) continue;
    if (findUserById(record.followerId) === undefined) continue;
    ids.push(record.followerId);
  }
  return ids;
}

/** 读取请求体中的目标 userId：缺失、非字符串或空白串一律 400。 */
function readTargetUserId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`字段 ${field} 必须为非空字符串`);
  }
  return value.trim();
}

const registeredRouters = new WeakSet<Router>();

/**
 * 注册好友与关注相关端点（R-002/R-012/R-013/R-017）：
 *   POST   /api/friends/requests                    需 Bearer，201 + FriendRequestItem
 *   GET    /api/friends/requests                    需 Bearer，200 + FriendRequestList
 *   POST   /api/friends/requests/:requestId/accept  需 Bearer，200 + FriendRequestItem
 *   GET    /api/friends                             需 Bearer，200 + FriendList
 *   POST   /api/follows/:userId                     需 Bearer，204
 *   DELETE /api/follows/:userId                     需 Bearer，204
 *   GET    /api/users/:userId/followers             公开，200 + FollowerList
 * 重复调用同一 router 时幂等。
 */
export function registerSocialRoutes(router: Router): Router {
  if (registeredRouters.has(router)) return router;
  registeredRouters.add(router);

  // 1) 发送好友请求：未认证 401；toUserId 非法 400；目标不存在 404；成功 201。
  router.post('/api/friends/requests', async ({ req, res }) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const input: FriendRequestCreate = { toUserId: readTargetUserId(body.toUserId, 'toUserId') };
    if (input.toUserId === user.id) {
      throw badRequest('不能向自己发送好友请求');
    }
    if (findUserById(input.toUserId) === undefined) {
      throw notFound('目标用户不存在');
    }
    const existing = friendRequests.find(
      (record) =>
        record.fromUserId === user.id && record.toUserId === input.toUserId && record.status === 'pending',
    );
    if (existing !== undefined) {
      // 重复发送同向待处理请求时复用原请求，不堆积重复记录。
      sendJson(res, 201, toFriendRequestItem(existing));
      return;
    }
    const record: FriendRequestRecord = {
      requestId: createId(),
      fromUserId: user.id,
      toUserId: input.toUserId,
      status: 'pending',
      createdAt: nowIso(),
    };
    friendRequests.push(record);
    sendJson(res, 201, toFriendRequestItem(record));
  });

  // 2) 好友请求列表：返回与当前用户相关（收到或发出）的请求。
  router.get('/api/friends/requests', ({ req, res }) => {
    const user = requireUser(req);
    const list: FriendRequestList = friendRequests
      .filter((record) => record.toUserId === user.id || record.fromUserId === user.id)
      .map((record) => toFriendRequestItem(record));
    sendJson(res, 200, list);
  });

  // 3) 接受好友请求：不存在 404；与请求双方无关的用户 403；成功 200 并建立双向好友关系。
  router.post('/api/friends/requests/:requestId/accept', ({ req, res, params }) => {
    const user = requireUser(req);
    const requestId = params.requestId ?? '';
    const record = friendRequests.find((item) => item.requestId === requestId);
    if (record === undefined) {
      throw notFound('好友请求不存在');
    }
    if (record.toUserId !== user.id && record.fromUserId !== user.id) {
      throw forbidden('无权处理他人的好友请求');
    }
    record.status = 'accepted';
    addFriendPair(record.fromUserId, record.toUserId);
    sendJson(res, 200, toFriendRequestItem(record));
  });

  // 4) 好友列表：接受前不含对方，接受后双方互相包含。
  router.get('/api/friends', ({ req, res }) => {
    const user = requireUser(req);
    const list: FriendList = listFriendIds(user.id);
    sendJson(res, 200, list);
  });

  // 5) 关注：未认证 401；关注自己 400；目标不存在 404；成功 204（重复关注幂等）。
  router.post('/api/follows/:userId', ({ req, res, params }) => {
    const user = requireUser(req);
    const targetUserId = params.userId ?? '';
    if (targetUserId === user.id) {
      throw badRequest('不能关注自己');
    }
    if (findUserById(targetUserId) === undefined) {
      throw notFound('目标用户不存在');
    }
    const exists = follows.some(
      (record) => record.followerId === user.id && record.followeeId === targetUserId,
    );
    if (!exists) {
      follows.push({ followerId: user.id, followeeId: targetUserId, createdAt: nowIso() });
    }
    sendNoContent(res);
  });

  // 6) 取消关注：未认证 401；取消关注自己 400；未关注时幂等返回 204。
  router.delete('/api/follows/:userId', ({ req, res, params }) => {
    const user = requireUser(req);
    const targetUserId = params.userId ?? '';
    if (targetUserId === user.id) {
      throw badRequest('不能取消关注自己');
    }
    const index = follows.findIndex(
      (record) => record.followerId === user.id && record.followeeId === targetUserId,
    );
    if (index !== -1) {
      follows.splice(index, 1);
    }
    sendNoContent(res);
  });

  // 7) 关注者列表：公开可读（R-017 要求由独立请求仍能读到关注关系）。
  router.get('/api/users/:userId/followers', ({ res, params }) => {
    const targetUserId = params.userId ?? '';
    const list: FollowerList = listFollowerIds(targetUserId);
    sendJson(res, 200, list);
  });

  return router;
}
