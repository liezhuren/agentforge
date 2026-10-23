import type {
  AuthLoginRequest,
  AuthLoginResponse,
  AuthRegisterRequest,
  AuthRegisterResponse,
  InterestsUpdate,
  MeResponse,
} from '../shared/contract-types.ts';
import type { Router } from '../http/router.ts';
import { badRequest, conflict, unauthorized } from '../http/errors.ts';
import { readJsonBody } from '../http/body.ts';
import { sendJson } from '../http/respond.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import { createId, findUserByUsername, nowIso, store } from '../store/store.ts';
import type { StoredUser } from '../store/store.ts';
import { requireUser } from './papers.ts';

/** 从请求体中提取并校验用户名/密码；缺失、非字符串或空串一律 400。 */
function readCredentials(body: Record<string, unknown>): { username: string; password: string } {
  const rawUsername = body.username;
  const rawPassword = body.password;
  if (typeof rawUsername !== 'string' || rawUsername.trim().length === 0) {
    throw badRequest('字段 username 必须为非空字符串');
  }
  if (typeof rawPassword !== 'string' || rawPassword.length === 0) {
    throw badRequest('字段 password 必须为非空字符串');
  }
  return { username: rawUsername.trim(), password: rawPassword };
}

/** 把用户记录投影为契约中的 MeResponse（不暴露口令散列）。 */
function toMeResponse(user: StoredUser): MeResponse {
  return { userId: user.id, username: user.username, interests: user.interests.slice() };
}

const registeredRouters = new WeakSet<Router>();

/**
 * 注册账号/认证相关端点（R-007/R-008/R-014/R-015/R-017）：
 *   POST /api/auth/register  公开，201 + AuthRegisterResponse（用户名重复 409、缺字段 400）
 *   POST /api/auth/login     公开，200 + AuthLoginResponse（凭据错误 401）
 *   GET  /api/me             需 Bearer，200 + MeResponse（缺/伪凭证 401）
 *   PUT  /api/me/interests   需 Bearer，200 + MeResponse（interests 非字符串数组 400）
 * 重复调用同一 router 时幂等。
 * 管理员凭证来自 store 初始化写入的种子账号（admin/admin123），通过本文件的 login 换取 token。
 */
export function registerAuthRoutes(router: Router): Router {
  if (registeredRouters.has(router)) return router;
  registeredRouters.add(router);

  router.post('/api/auth/register', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const input: AuthRegisterRequest = readCredentials(body);
    if (findUserByUsername(input.username) !== undefined) {
      throw conflict('用户名已被注册');
    }
    const user: StoredUser = {
      id: createId(),
      username: input.username,
      passwordHash: hashPassword(input.password),
      isAdmin: false,
      interests: [],
      createdAt: nowIso(),
    };
    store.users.push(user);
    const payload: AuthRegisterResponse = { userId: user.id, username: user.username };
    sendJson(res, 201, payload);
  });

  router.post('/api/auth/login', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const input: AuthLoginRequest = readCredentials(body);
    const user = findUserByUsername(input.username);
    if (user === undefined || !verifyPassword(input.password, user.passwordHash)) {
      throw unauthorized('用户名或密码错误');
    }
    const token = createId();
    store.sessions.push({ token, userId: user.id, createdAt: nowIso() });
    const payload: AuthLoginResponse = { token, userId: user.id };
    sendJson(res, 200, payload);
  });

  router.get('/api/me', ({ req, res }) => {
    const user = requireUser(req);
    sendJson(res, 200, toMeResponse(user));
  });

  router.put('/api/me/interests', async ({ req, res }) => {
    // 先认证再校验请求体：无凭证时固定得到 401。
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const raw = body.interests;
    if (!Array.isArray(raw)) {
      throw badRequest('字段 interests 必须为字符串数组');
    }
    const interests: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') {
        throw badRequest('字段 interests 必须为字符串数组');
      }
      interests.push(item);
    }
    const update: InterestsUpdate = { interests };
    user.interests = update.interests.slice();
    sendJson(res, 200, toMeResponse(user));
  });

  return router;
}
