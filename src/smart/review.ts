// 审核/修正的数据模型 + 严格 JSON 解析 + 兜底构造。

import { extractJson } from './designTree.js';

export type ReviewVerdict = 'pass' | 'partial' | 'fail';

export interface ReviewItem {
  /** 验收条目原文（brief.acceptance[i]；无验收标准时用 plan[i].step+verification）。 */
  criterion: string;
  status: 'pass' | 'fail' | 'unknown';
  /** 必须引用审核材料中的具体证据（日志行/文件名/diff 片段）。 */
  evidence: string;
  /** 未通过时的具体问题描述。 */
  issue?: string;
}

export interface ReviewResult {
  schemaVersion: 1;
  verdict: ReviewVerdict;
  items: ReviewItem[];
  /** 1-2 段总结，含执行状态与整体评价。 */
  summary: string;
  /** verdict !== 'pass' 时非空，3 条以内、可执行、最小改动。 */
  fixSuggestions: string[];
  createdAt: string;
}

export interface FixResult {
  schemaVersion: 1;
  /** 修正指令正文，作为下一轮 handoff 的追加段。 */
  fixInstructions: string;
  createdAt: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const VERDICTS: ReviewVerdict[] = ['pass', 'partial', 'fail'];
const ITEM_STATUSES: ReviewItem['status'][] = ['pass', 'fail', 'unknown'];

export function parseReviewJson(text: string): { review?: ReviewResult; error?: string } {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(extractJson(text));
  } catch (e) {
    return { error: `JSON 解析失败: ${(e as Error).message}` };
  }
  if (!VERDICTS.includes(data.verdict as ReviewVerdict)) return { error: `verdict 必须是 pass/partial/fail 之一（收到: ${JSON.stringify(data.verdict)}）` };
  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .map((i) => ({
      criterion: str(i.criterion),
      status: i.status as ReviewItem['status'],
      evidence: str(i.evidence),
      issue: str(i.issue) || undefined,
    }))
    .filter((i) => i.criterion && ITEM_STATUSES.includes(i.status));
  if (items.length === 0) return { error: '缺少有效 items（每项需 criterion + status）' };
  const summary = str(data.summary);
  if (!summary) return { error: '缺少 summary' };
  const fixSuggestions = (Array.isArray(data.fixSuggestions) ? data.fixSuggestions : []).map(str).filter(Boolean);
  return {
    review: {
      schemaVersion: 1,
      verdict: data.verdict as ReviewVerdict,
      items,
      summary,
      fixSuggestions,
      createdAt: new Date().toISOString(),
    },
  };
}

export function parseFixJson(text: string): { fix?: FixResult; error?: string } {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(extractJson(text));
  } catch (e) {
    return { error: `JSON 解析失败: ${(e as Error).message}` };
  }
  const fixInstructions = str(data.fixInstructions).trim();
  if (!fixInstructions) return { error: '缺少 fixInstructions' };
  return {
    fix: {
      schemaVersion: 1,
      fixInstructions,
      createdAt: new Date().toISOString(),
    },
  };
}

/** 修正指令生成失败时的兜底：把审核的修复建议拼成指令，保证迭代闭环不断。 */
export function fallbackFixFromReview(review: ReviewResult): FixResult {
  const problems = review.items
    .filter((i) => i.status !== 'pass')
    .map((i) => `- ${i.criterion}：${i.issue || '未通过/无法验证'}`);
  const lines = [
    '以下是上一轮执行的问题清单，请逐项修复后重新自检验收：',
    ...problems,
    '',
    ...(review.fixSuggestions.length > 0 ? ['修复建议（来自审核）：', ...review.fixSuggestions.map((s) => `- ${s}`)] : []),
  ];
  return { schemaVersion: 1, fixInstructions: lines.join('\n'), createdAt: new Date().toISOString() };
}
