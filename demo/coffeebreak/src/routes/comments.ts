import type { Comment, CommentInput } from '../shared/contract-types.ts';
import type { Router } from '../http/router.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { readJsonBody } from '../http/body.ts';
import { sendJson } from '../http/respond.ts';
import { createId, findCommentById, findPaperById, nowIso, store } from '../store/store.ts';
import type { StoredComment } from '../store/store.ts';
import { requireUser } from './papers.ts';

/** 把内部存储记录投影为契约中的 Comment（id/paperId/parentCommentId/userId/content/createdAt）。 */
function toComment(record: StoredComment): Comment {
  return {
    id: record.id,
    paperId: record.paperId,
    parentCommentId: record.parentCommentId,
    userId: record.userId,
    content: record.content,
    createdAt: record.createdAt,
  };
}

/** 某篇论文下的全部评论，按创建先后排列（顶级评论与其回复都出现在同一数组中）。 */
function listComments(paperId: string): Comment[] {
  return store.comments
    .filter((comment) => comment.paperId === paperId)
    .map((comment) => toComment(comment));
}

/**
 * 校验评论请求体：
 * - content 必须为非空字符串（缺失/非字符串/空白串一律 400）；
 * - parentCommentId 可省略或为 null（顶级评论），否则必须为非空字符串（400）。
 */
function parseCommentInput(body: Record<string, unknown>): CommentInput {
  const rawContent = body.content;
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    throw badRequest('字段 content 必须为非空字符串');
  }
  const rawParent = body.parentCommentId;
  if (rawParent === undefined || rawParent === null) {
    const topLevel: CommentInput = { content: rawContent };
    return topLevel;
  }
  if (typeof rawParent !== 'string' || rawParent.length === 0) {
    throw badRequest('字段 parentCommentId 必须为非空字符串或 null');
  }
  const reply: CommentInput = { content: rawContent, parentCommentId: rawParent };
  return reply;
}

const registeredRouters = new WeakSet<Router>();

/**
 * 注册论文评论相关端点（R-010/R-011/R-017）：
 *   GET  /api/papers/:id/comments  公开，200 + Comment[]（论文不存在时返回空数组）
 *   POST /api/papers/:id/comments  需 Bearer，201 + Comment
 *      - 未认证 401；论文不存在 404；content 非非空字符串 400；
 *      - parentCommentId 指向不存在的评论（或不属于该论文）404。
 * 重复调用同一 router 时幂等。
 */
export function registerCommentRoutes(router: Router): Router {
  if (registeredRouters.has(router)) return router;
  registeredRouters.add(router);

  router.get('/api/papers/:id/comments', ({ params, res }) => {
    sendJson(res, 200, listComments(params.id ?? ''));
  });

  router.post('/api/papers/:id/comments', async ({ req, res, params }) => {
    // 认证先于其它校验：无凭证必须得到 401（R-010）。
    const user = requireUser(req);
    const paperId = params.id ?? '';
    if (findPaperById(paperId) === undefined) {
      throw notFound('论文不存在');
    }
    const body = await readJsonBody(req);
    const input = parseCommentInput(body);
    const parentCommentId = input.parentCommentId ?? null;
    if (parentCommentId !== null) {
      const parent = findCommentById(parentCommentId);
      if (parent === undefined) {
        throw notFound('父评论不存在');
      }
      if (parent.paperId !== paperId) {
        throw notFound('父评论不属于该论文');
      }
    }
    const record: StoredComment = {
      id: createId(),
      paperId,
      userId: user.id,
      parentCommentId,
      content: input.content,
      createdAt: nowIso(),
    };
    store.comments.push(record);
    sendJson(res, 201, toComment(record));
  });

  return router;
}
