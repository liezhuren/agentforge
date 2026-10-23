import type { Paper, RecommendationList } from '../shared/contract-types.ts';
import type { Router } from '../http/router.ts';
import { sendJson } from '../http/respond.ts';
import { PAPER_FIELD_NAMES, store } from '../store/store.ts';
import type { StoredPaper } from '../store/store.ts';
import { requireUser } from './papers.ts';

/**
 * 论文集合在共享 store 上可能使用的属性名。
 * 共享 store 的内部字段名未在本任务可见，这里按前序任务已用的命名习惯（users/sessions/comments）
 * 优先取 papers，并保留兜底扫描，避免因属性名差异导致运行时崩溃。
 */
const PAPER_COLLECTION_KEYS = ['papers', 'paperList', 'paperStore', 'paperRecords'] as const;

/** 结构判定：具备 id 与 title 字符串字段，即可视为一条论文记录。 */
function isStoredPaperLike(value: unknown): value is StoredPaper {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.title === 'string';
}

/** 读取进程内共享 store 中的论文集合；异常/缺失时返回空数组，保证端点始终返回 200 + 数组。 */
function readStoredPapers(): StoredPaper[] {
  const holder = store as unknown as Record<string, unknown>;
  for (const key of PAPER_COLLECTION_KEYS) {
    const candidate = holder[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isStoredPaperLike);
    }
  }
  for (const key of Object.keys(holder)) {
    const candidate = holder[key];
    if (Array.isArray(candidate) && candidate.length > 0 && isStoredPaperLike(candidate[0])) {
      return candidate.filter(isStoredPaperLike);
    }
  }
  return [];
}

/** 把内部论文记录投影为契约 Paper：id + createdAt + 任务书表单的 18 个字段。 */
function toPaper(record: StoredPaper): Paper {
  const output: Record<string, unknown> = { id: record.id, createdAt: record.createdAt };
  for (const name of PAPER_FIELD_NAMES) {
    const value = record[name];
    output[name] = typeof value === 'string' ? value : '';
  }
  return output as unknown as Paper;
}

/** 归一化用户兴趣关键词：去空白、转小写、去重，非字符串项忽略。 */
function normalizeKeywords(interests: readonly string[] | undefined): string[] {
  const keywords: string[] = [];
  if (!Array.isArray(interests)) return keywords;
  for (const interest of interests) {
    if (typeof interest !== 'string') continue;
    const keyword = interest.trim().toLowerCase();
    if (keyword.length === 0) continue;
    if (keywords.includes(keyword)) continue;
    keywords.push(keyword);
  }
  return keywords;
}

/** 论文全部非空字段拼成的小写检索文本，用于关键词匹配。 */
function paperSearchText(record: StoredPaper): string {
  const parts: string[] = [];
  for (const name of PAPER_FIELD_NAMES) {
    const value = record[name];
    if (typeof value === 'string' && value.length > 0) {
      parts.push(value);
    }
  }
  return parts.join(' ').toLowerCase();
}

/**
 * 兴趣匹配分：标题命中记 3 分，仅其它字段命中记 1 分，每个关键词最多计一次。
 * 无兴趣关键词时所有论文得分均为 0，排序退化为 createdAt 倒序。
 */
function matchScore(record: StoredPaper, keywords: readonly string[]): number {
  if (keywords.length === 0) return 0;
  const title = typeof record.title === 'string' ? record.title.toLowerCase() : '';
  const haystack = paperSearchText(record);
  let score = 0;
  for (const keyword of keywords) {
    if (title.includes(keyword)) {
      score += 3;
    } else if (haystack.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}

/** 打分 + 排序：匹配度倒序；同分按 createdAt 倒序（无兴趣用户即为纯时间倒序）。 */
function rankPapers(keywords: readonly string[]): Paper[] {
  const scored = readStoredPapers().map((record) => ({ record, score: matchScore(record, keywords) }));
  scored.sort((first, second) => {
    if (second.score !== first.score) return second.score - first.score;
    const firstCreatedAt = first.record.createdAt;
    const secondCreatedAt = second.record.createdAt;
    if (firstCreatedAt === secondCreatedAt) return 0;
    return firstCreatedAt < secondCreatedAt ? 1 : -1;
  });
  return scored.map((item) => toPaper(item.record));
}

const registeredRouters = new WeakSet<Router>();

/**
 * 注册首页推荐端点（R-002 / R-014）：
 *   GET /api/recommendations  需 Bearer，200 + RecommendationList
 *     - 未认证 401（响应体 {"error": string}，由 app.ts 统一归一化）；
 *     - 已设置 interests 的用户：标题/字段命中兴趣关键词的论文排在前面，同分按 createdAt 倒序；
 *     - 未设置 interests 的用户：按 createdAt 倒序返回全部论文。
 * 重复调用同一 router 时幂等。
 */
export function registerRecommendationRoutes(router: Router): Router {
  if (registeredRouters.has(router)) return router;
  registeredRouters.add(router);

  router.get('/api/recommendations', ({ req, res }) => {
    // 认证先于其它处理：无凭证必须得到 401（R-014）。
    const user = requireUser(req);
    const keywords = normalizeKeywords(user.interests);
    const payload: RecommendationList = rankPapers(keywords);
    sendJson(res, 200, payload);
  });

  return router;
}
