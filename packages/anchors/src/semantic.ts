/**
 * B 层 · 语义锚（Semantic Anchors）。
 *
 * 本文件**不调用 LLM**。这是刻意的结构约束：
 * LLM 的语义判断以「提议（proposal）」形式由 roles 层产出并经 AnchorContext 注入，
 * B 层只做两件事：
 *   1. 核验提议所引用的证据是否真实存在（文件/行区间/工件/锚点运行记录）
 *   2. 由**程序**根据核验结果给出最终 verdict
 *
 * 因此「LLM 永远是提议、不是裁判」这条不变量在依赖关系上就不可违反 ——
 * 锚点包里根本拿不到 LLM 客户端。
 *
 * 核心防幻觉手段：提议里编造的证据（引用不存在的文件、越界的行号）不会被打折，
 * 而是让该条判定**整条作废**（INVALID_EVIDENCE）。这让「编造证据」无法得分。
 */

import type { AnchorFinding, Artifact, ContractDoc, PrdDoc, Requirement, TaskGraph } from '../../core/src/types.ts';
import { ROUNDTABLE_TRIGGERS } from '../../core/src/types.ts';
import {
  attributeByPath,
  verifyEvidence,
  worstVerdict,
  type Anchor,
  type AnchorContext,
  type AnchorOutcome,
  type RequirementVerdictProposal,
} from './types.ts';

function requirementArtifact(ctx: AnchorContext): Artifact | null {
  return ctx.store.head('Requirement');
}

function requirements(ctx: AnchorContext): Requirement[] {
  const a = requirementArtifact(ctx);
  if (!a) return [];
  return (a.content as { requirements: Requirement[] }).requirements ?? [];
}

function taskGraph(ctx: AnchorContext): TaskGraph | null {
  const a = ctx.store.head('TaskGraph');
  return a ? (a.content as TaskGraph) : null;
}

/** 机械归因：某条需求由谁负责实现（从任务图推断）。 */
function ownerOfRequirement(ctx: AnchorContext, reqId: string): string {
  const tg = taskGraph(ctx);
  const t = tg?.tasks.find((x) => x.requirementIds.includes(reqId));
  return t?.owner ?? 'UNRESOLVED';
}

// ════════════════════════════════════════════════════════════════
// B1 · 目标达成（LLM 提议 + 程序核验证据）
// ════════════════════════════════════════════════════════════════

export const B1: Anchor = {
  id: 'B1',
  title: '目标达成',
  layer: 'B',
  async run(ctx): Promise<AnchorOutcome> {
    const reqs = requirements(ctx);
    const findings: AnchorFinding[] = [];

    if (reqs.length === 0) {
      return {
        verdict: 'SKIPPED',
        findings: [{ code: 'no-requirements', severity: 'warn', message: '尚无需求工件，目标达成无法判定' }],
        method: 'none',
        authority: 'none',
        subjects: [],
        contentHashes: {},
      };
    }

    const proposals = ctx.proposals.requirementVerdicts;
    if (!proposals || proposals.length === 0) {
      return {
        verdict: 'SKIPPED',
        findings: [
          {
            code: 'no-semantic-proposals',
            severity: 'warn',
            message: `有 ${reqs.length} 条需求但没有任何语义判定提议，目标达成未经验证（未验证 ≠ 通过）`,
          },
        ],
        method: 'none',
        authority: 'none',
        subjects: [],
        contentHashes: {},
      };
    }

    const byId = new Map<string, RequirementVerdictProposal>(proposals.map((p) => [p.requirementId, p]));
    const subjects: string[] = [];
    const hashes: Record<string, string> = {};
    const reqArt = requirementArtifact(ctx);
    if (reqArt) {
      subjects.push(reqArt.id);
      hashes[reqArt.id] = reqArt.contentHash;
    }

    let invalidEvidence = false;
    let checkedEvidence = 0;

    for (const req of reqs) {
      const p = byId.get(req.id);
      if (!p) {
        findings.push({
          code: 'requirement-unverified',
          severity: 'fail',
          message: `需求 ${req.id}（${truncate(req.text)}）没有任何语义判定，无法确认是否达成`,
          targetRole: ownerOfRequirement(ctx, req.id),
          data: { requirementId: req.id },
        });
        continue;
      }

      if (p.evidenceRefs.length === 0) {
        invalidEvidence = true;
        findings.push({
          code: 'evidence-missing',
          severity: 'fail',
          message: `需求 ${req.id} 的判定未提供任何证据引用 —— 判定作废（INVALID_EVIDENCE）`,
          targetRole: ownerOfRequirement(ctx, req.id),
          data: { requirementId: req.id, verdict: p.verdict },
        });
        continue;
      }

      const bad: string[] = [];
      for (const ref of p.evidenceRefs) {
        checkedEvidence++;
        const v = await verifyEvidence(ref, ctx);
        if (!v.ok) bad.push(v.reason ?? '未知原因');
      }

      if (bad.length > 0) {
        invalidEvidence = true;
        findings.push({
          code: 'evidence-invalid',
          severity: 'fail',
          message: `需求 ${req.id} 的判定引用了不存在的证据，判定作废（INVALID_EVIDENCE）：${bad.join('；')}`,
          targetRole: ownerOfRequirement(ctx, req.id),
          data: { requirementId: req.id, invalidRefs: bad },
        });
        continue;
      }

      if (p.verdict === 'not-met') {
        findings.push({
          code: 'requirement-not-met',
          severity: 'fail',
          message: `需求 ${req.id}（${truncate(req.text)}）判定为未达成：${truncate(p.rationale)}`,
          targetRole: ownerOfRequirement(ctx, req.id),
          data: { requirementId: req.id, rationale: p.rationale },
        });
      } else if (p.verdict === 'uncertain') {
        findings.push({
          code: 'requirement-uncertain',
          severity: 'warn',
          message: `需求 ${req.id} 判定不确定：${truncate(p.rationale)}`,
          targetRole: ownerOfRequirement(ctx, req.id),
          data: { requirementId: req.id },
        });
      }
    }

    const v = worstVerdict(findings.map((f) => (f.severity === 'fail' ? 'FAIL' : 'WARN')));
    return {
      verdict: invalidEvidence ? 'INVALID_EVIDENCE' : v,
      findings,
      method: 'llm-proposals + deterministic evidence verification',
      authority: 'approximate',
      subjects,
      contentHashes: hashes,
      meta: {
        requirements: reqs.length,
        proposed: proposals.length,
        evidenceChecked: checkedEvidence,
        invalidEvidence,
      },
    };
  },
};

// ════════════════════════════════════════════════════════════════
// B2 · 需求覆盖矩阵（纯机械，不需要任何 LLM）
// ════════════════════════════════════════════════════════════════

export const B2: Anchor = {
  id: 'B2',
  title: '需求覆盖矩阵',
  layer: 'B',
  async run(ctx): Promise<AnchorOutcome> {
    const reqs = requirements(ctx);
    const findings: AnchorFinding[] = [];

    if (reqs.length === 0) {
      return {
        verdict: 'SKIPPED',
        findings: [{ code: 'no-requirements', severity: 'warn', message: '尚无需求工件，覆盖矩阵无法构建' }],
        method: 'none',
        authority: 'none',
        subjects: [],
        contentHashes: {},
      };
    }

    const subjects: string[] = [];
    const hashes: Record<string, string> = {};
    for (const kind of ['Requirement', 'PRD', 'TaskGraph', 'TestSuite'] as const) {
      const a = ctx.store.head(kind);
      if (a) {
        subjects.push(a.id);
        hashes[a.id] = a.contentHash;
      }
    }

    // 需求可验证性预检。
    // 注意：工件 schema 已经强制 acceptance 至少一条，正常路径下 PM 产不出
    // 「无法验收的需求」（会在 SCHEMA_REJECT 处被拦下）。这里保留为**纵深防御**：
    // 若未来放宽 schema、或历史数据/人工注入绕过 store，这道闸仍能独立指出问题。
    for (const r of reqs) {
      if (!r.acceptance || r.acceptance.length === 0) {
        findings.push({
          code: 'requirement-unverifiable',
          severity: 'fail',
          message: `需求 ${r.id} 没有声明验收方式，无法被任何锚点或测试验证`,
          targetRole: 'pm',
          data: { requirementId: r.id },
        });
      }
    }

    const tg = taskGraph(ctx);
    if (!tg) {
      findings.push({
        code: 'no-task-graph',
        severity: 'fail',
        message: '尚无任务图，需求无法被拆解实现',
        targetRole: 'pm',
      });
      return {
        verdict: 'FAIL',
        findings,
        method: 'coverage matrix',
        authority: 'authoritative',
        subjects,
        contentHashes: hashes,
      };
    }

    const prd = ctx.store.head('PRD')?.content as PrdDoc | undefined;
    const suites = ctx.store.heads('TestSuite');
    const coveredByTests = new Set<string>();
    for (const s of suites) {
      for (const c of (s.content as { covers: string[] }).covers ?? []) coveredByTests.add(c);
    }

    /**
     * 实现是否已经开始（存在任何代码工件）。
     *
     * 这个判断很关键，而且是踩过坑才加上的：
     * 「需求未被测试覆盖」「任务声明的产物不存在」这两项，在 PLANNING / CONTRACTING 阶段
     * 必然为真 —— 那时还没有任何代码。若照常判 FAIL，就会在每个阶段开头都抛出
     * 一批「需求未被测试覆盖」，并把工单派给测试角色，让项目在还没写代码时就被打回。
     *
     * 未开始的检查应当如实标为「未验证」（WARN），而不是伪装成「发现了缺陷」（FAIL）——
     * 这与 SKIPPED ≠ PASS 是同一条原则的镜像：**未开始 ≠ 已失败**。
     */
    const implementationStarted = ctx.store.heads('CodeModule').length > 0;
    if (!implementationStarted) {
      findings.push({
        code: 'implementation-not-started',
        severity: 'warn',
        message: '尚无任何代码工件，实现产物与测试覆盖尚未验证（未开始 ≠ 已失败，但也 ≠ 通过）',
      });
    }

    const matrix: Array<Record<string, unknown>> = [];

    for (const r of reqs) {
      const tasks = tg.tasks.filter((t) => t.requirementIds.includes(r.id));
      const inPrd = prd ? prd.requirementIds.includes(r.id) : false;
      const tested = coveredByTests.has(r.id);

      matrix.push({
        requirementId: r.id,
        priority: r.priority,
        inPrd,
        tasks: tasks.map((t) => t.id),
        testCovered: tested,
      });

      if (!inPrd) {
        findings.push({
          code: 'requirement-not-in-prd',
          severity: 'fail',
          message: `需求 ${r.id} 未被 PRD 覆盖 —— 需求在传递过程中丢失`,
          targetRole: 'pm',
          data: { requirementId: r.id },
        });
      }

      if (tasks.length === 0) {
        findings.push({
          code: 'requirement-untasked',
          severity: 'fail',
          message: `需求 ${r.id} 没有任何任务实现它 —— 需求被漏掉了`,
          targetRole: 'pm',
          data: { requirementId: r.id },
        });
        continue;
      }

      // 以下两项只在实现已经开始后才有判定意义（见上面 implementationStarted 的说明）
      if (!implementationStarted) continue;

      if (!tested) {
        findings.push({
          code: 'requirement-untested',
          severity: r.priority === 'must' ? 'fail' : 'warn',
          message: `需求 ${r.id}（优先级 ${r.priority}）没有任何测试用例覆盖`,
          targetRole: 'test',
          data: { requirementId: r.id },
        });
      }

      // 任务声明的产物是否真的交付了
      for (const t of tasks) {
        const delivered = ctx.store.heads(t.deliverable).some((a) => {
          if (t.deliverable === 'CodeModule') return a.scope === t.scope;
          return true;
        });
        if (!delivered) {
          findings.push({
            code: 'deliverable-missing',
            severity: 'fail',
            message: `任务 ${t.id} 声明交付 ${t.deliverable}（scope=${t.scope}），但库中不存在对应工件`,
            targetRole: t.owner,
            data: { taskId: t.id, deliverable: t.deliverable },
          });
        }
      }
    }

    return {
      verdict: findings.some((f) => f.severity === 'fail') ? 'FAIL' : findings.length > 0 ? 'WARN' : 'PASS',
      findings,
      method: 'deterministic coverage matrix (requirement → PRD → task → artifact → test)',
      authority: 'authoritative',
      subjects,
      contentHashes: hashes,
      meta: { matrix },
    };
  },
};

// ════════════════════════════════════════════════════════════════
// B3 · 对抗审查包校验（主理人异议的证据核验）
// ════════════════════════════════════════════════════════════════

export const B3: Anchor = {
  id: 'B3',
  title: '对抗审查',
  layer: 'B',
  async run(ctx): Promise<AnchorOutcome> {
    const reviewArt = ctx.store.head('AnchoredReview');
    const objections = ctx.proposals.objections ?? [];

    if (!reviewArt && objections.length === 0) {
      return {
        verdict: 'SKIPPED',
        findings: [
          {
            code: 'no-review',
            severity: 'warn',
            message: '本阶段尚无主理人审查包，对抗审查未执行（未执行 ≠ 通过）',
          },
        ],
        method: 'none',
        authority: 'none',
        subjects: [],
        contentHashes: {},
      };
    }

    const findings: AnchorFinding[] = [];
    const subjects: string[] = [];
    const hashes: Record<string, string> = {};
    if (reviewArt) {
      subjects.push(reviewArt.id);
      hashes[reviewArt.id] = reviewArt.contentHash;
    }

    let invalid = 0;
    for (const o of objections) {
      if (!o.evidence || o.evidence.length === 0) {
        invalid++;
        findings.push({
          code: 'objection-evidence-missing',
          severity: 'fail',
          message: `异议 ${o.id} 未提供任何证据引用 —— 将被判为不可证伪，不得阻断（R8/R9）`,
          targetRole: 'UNRESOLVED',
          data: { objectionId: o.id },
        });
        continue;
      }
      const bad: string[] = [];
      for (const ref of o.evidence) {
        const v = await verifyEvidence(ref, ctx);
        if (!v.ok) bad.push(v.reason ?? '未知');
      }
      if (bad.length > 0) {
        invalid++;
        findings.push({
          code: 'objection-evidence-invalid',
          severity: 'fail',
          message: `异议 ${o.id} 引用了不存在的证据（${bad.join('；')}）—— 该异议的证据无效`,
          targetRole: 'UNRESOLVED',
          data: { objectionId: o.id, invalidRefs: bad },
        });
      }
    }

    return {
      verdict: invalid > 0 ? 'INVALID_EVIDENCE' : 'PASS',
      findings,
      method: 'deterministic evidence verification over host objections',
      authority: 'authoritative',
      subjects,
      contentHashes: hashes,
      meta: { objections: objections.length, invalid },
    };
  },
};

function truncate(s: string, n = 80): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

export const SEMANTIC_ANCHORS: Anchor[] = [B1, B2, B3];
export { ROUNDTABLE_TRIGGERS, attributeByPath };
export type { ContractDoc };
