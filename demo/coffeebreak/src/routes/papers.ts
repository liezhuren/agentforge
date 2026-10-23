import type { IncomingMessage } from 'node:http';
import type { Paper } from '../shared/contract-types.ts';
import type { Router } from '../http/router.ts';
import { badRequest, forbidden, notFound, unauthorized } from '../http/errors.ts';
import { readJsonBody } from '../http/body.ts';
import { sendJson, sendNoContent } from '../http/respond.ts';
import {
  PAPER_FIELD_NAMES,
  createPaperRecord,
  findPaperById,
  findSession,
  findUserById,
  nowIso,
  store,
} from '../store/store.ts';
import type { PaperFieldName, StoredPaper, StoredUser } from '../store/store.ts';

/** 从 Authorization: Bearer <token> 中取出 token；缺失或格式非法时返回 null。 */
export function getBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(raw.trim());
  if (match === null) return null;
  const token = match[1];
  if (typeof token !== 'string' || token.length === 0) return null;
  return token;
}

/** 解析 Bearer 凭证并返回当前用户；缺失或无效凭证抛 401。 */
export function requireUser(req: IncomingMessage): StoredUser {
  const token = getBearerToken(req);
  if (token === null) {
    throw unauthorized('缺少 Bearer 身份凭证');
  }
  const session = findSession(token);
  const user = session === undefined ? undefined : findUserById(session.userId);
  if (user === undefined) {
    throw unauthorized('身份凭证无效或已过期');
  }
  return user;
}

/** 在 requireUser 基础上校验管理员身份：未登录 401，非管理员 403。 */
export function requireAdmin(req: IncomingMessage): StoredUser {
  const user = requireUser(req);
  if (!user.isAdmin) {
    throw forbidden('仅管理员可上传、编辑或删除论文');
  }
  return user;
}

/** 把内部存储记录投影为契约中的 Paper（18 个论文属性 + id + createdAt）。 */
function toPaper(record: StoredPaper): Paper {
  const paper: Paper = {
    id: record.id,
    createdAt: record.createdAt,
    title: record.title,
    paperType: record.paperType,
    publishedAt: record.publishedAt,
    publication: record.publication,
    conferenceName: record.conferenceName,
    conferenceAddress: record.conferenceAddress,
    venueLevel: record.venueLevel,
    indexCategory: record.indexCategory,
    eiNumber: record.eiNumber,
    doi: record.doi,
    issn: record.issn,
    cnNumber: record.cnNumber,
    affiliation: record.affiliation,
    moeCategory: record.moeCategory,
    schoolRanking: record.schoolRanking,
    publishScope: record.publishScope,
    volumeIssue: record.volumeIssue,
    projectSource: record.projectSource,
  };
  return paper;
}

/** 论文列表：最新的排在最前面。 */
function listPapers(): Paper[] {
  return store.papers
    .slice()
    .reverse()
    .map((record) => toPaper(record));
}

/**
 * 校验并抽取 18 个论文字段。
 * 非字符串值一律 400；title 为空字符串一律 400；requireTitle 为真时缺少 title 也 400。
 */
function parsePaperFields(body: Record<string, unknown>, requireTitle: boolean): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of PAPER_FIELD_NAMES) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw badRequest(`字段 ${field} 必须为字符串`);
    }
    if (field === 'title' && value.trim().length === 0) {
      throw badRequest('字段 title 不能为空');
    }
    fields[field] = value;
  }
  if (requireTitle) {
    const title = fields.title;
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw badRequest('缺少必填字段 title');
    }
  }
  return fields;
}

const registeredRouters = new WeakSet<Router>();

/**
 * 注册论文相关端点（R-003/R-004/R-005/R-006/R-009/R-015/R-017）：
 *   GET    /api/papers       公开，返回 Paper[]
 *   POST   /api/papers       管理员，201 + Paper
 *   GET    /api/papers/:id   公开，200 + Paper / 404
 *   PUT    /api/papers/:id   管理员，200 + Paper / 404
 *   DELETE /api/papers/:id   管理员，204 / 404
 * 重复调用同一 router 时幂等。
 */
export function registerPaperRoutes(router: Router): Router {
  if (registeredRouters.has(router)) return router;
  registeredRouters.add(router);

  router.get('/api/papers', ({ res }) => {
    sendJson(res, 200, listPapers());
  });

  router.post('/api/papers', async ({ req, res }) => {
    // 先认证/鉴权，再做请求体校验：缺凭证必须得到 401，普通用户必须得到 403。
    const admin = requireAdmin(req);
    const body = await readJsonBody(req);
    const fields = parsePaperFields(body, true);
    const record = createPaperRecord(fields, admin.id);
    store.papers.push(record);
    sendJson(res, 201, toPaper(record));
  });

  router.get('/api/papers/:id', ({ params, res }) => {
    const record = findPaperById(params.id ?? '');
    if (record === undefined) {
      throw notFound('论文不存在');
    }
    sendJson(res, 200, toPaper(record));
  });

  router.put('/api/papers/:id', async ({ req, res, params }) => {
    requireAdmin(req);
    const record = findPaperById(params.id ?? '');
    if (record === undefined) {
      throw notFound('论文不存在');
    }
    const body = await readJsonBody(req);
    const fields = parsePaperFields(body, false);
    for (const [field, value] of Object.entries(fields)) {
      record[field as PaperFieldName] = value;
    }
    record.updatedAt = nowIso();
    sendJson(res, 200, toPaper(record));
  });

  router.delete('/api/papers/:id', ({ req, res, params }) => {
    requireAdmin(req);
    const paperId = params.id ?? '';
    const index = store.papers.findIndex((paper) => paper.id === paperId);
    if (index === -1) {
      throw notFound('论文不存在');
    }
    const removed = store.papers.splice(index, 1)[0];
    if (removed !== undefined) {
      // 删除论文时一并清理其评论，避免悬挂数据。
      store.comments = store.comments.filter((comment) => comment.paperId !== removed.id);
    }
    sendNoContent(res);
  });

  return router;
}
