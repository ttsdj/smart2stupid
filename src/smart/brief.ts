// brief：smart 端与 stupid 端之间的契约。md 给执行 agent 读，json 给机器读，成对生成。

import { extractJson } from './designTree.js';
import type { TaskSession } from '../sessions/store.js';

export interface BriefData {
  schemaVersion: 1;
  taskId: string;
  title: string;
  background: string;
  clarifications: { question: string; answer: string; rationale?: string }[];
  polishedPrompt: string;
  plan: { step: string; verification?: string }[];
  constraints: { must: string[]; forbidden: string[] };
  acceptance: string[];
  createdAt: string;
  editedByUser?: boolean;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 严格解析模型输出的 brief JSON；失败返回错误。 */
export function parseBriefJson(text: string): { brief?: Omit<BriefData, 'taskId' | 'createdAt' | 'schemaVersion'>; error?: string } {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(extractJson(text));
  } catch (e) {
    return { error: `JSON 解析失败: ${(e as Error).message}` };
  }
  if (typeof data.title !== 'string' || !data.title.trim()) return { error: '缺少 title' };
  if (typeof data.polishedPrompt !== 'string' || !data.polishedPrompt.trim()) return { error: '缺少 polishedPrompt' };
  const clarifications = (Array.isArray(data.clarifications) ? data.clarifications : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({ question: str(c.question), answer: str(c.answer), rationale: str(c.rationale) || undefined }))
    .filter((c) => c.question || c.answer);
  const plan = (Array.isArray(data.plan) ? data.plan : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({ step: str(p.step), verification: str(p.verification) || undefined }))
    .filter((p) => p.step);
  if (plan.length === 0) return { error: '缺少 plan 步骤' };
  const constraints = (data.constraints ?? {}) as { must?: unknown; forbidden?: unknown };
  const must = Array.isArray(constraints.must) ? constraints.must.map(str) : [];
  const forbidden = Array.isArray(constraints.forbidden) ? constraints.forbidden.map(str) : [];
  const acceptance = Array.isArray(data.acceptance) ? (data.acceptance as unknown[]).map(str) : [];
  return {
    brief: {
      title: data.title,
      background: str(data.background),
      clarifications,
      polishedPrompt: data.polishedPrompt,
      plan,
      constraints: { must, forbidden },
      acceptance,
    },
  };
}

/** 六节固定结构的 brief.md。 */
export function briefToMarkdown(brief: BriefData): string {
  const lines: string[] = [];
  lines.push(`# Brief: ${brief.title}`, '');
  lines.push('## 1. 需求背景', '', brief.background.trim() || '（无）', '');
  lines.push('## 2. 澄清结论', '');
  if (brief.clarifications.length > 0) {
    lines.push('| # | 决策点 | 结论 | 理由 |', '|---|--------|------|------|');
    brief.clarifications.forEach((c, i) => {
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
      lines.push(`| Q${i + 1} | ${esc(c.question)} | ${esc(c.answer) || '（未决）'} | ${esc(c.rationale ?? '')} |`);
    });
  } else {
    lines.push('（无澄清问答）');
  }
  lines.push('', '## 3. 优化后的提示词', '');
  lines.push('> 以下是本任务的完整指令，请以它为准执行。', '', brief.polishedPrompt.trim(), '');
  lines.push('## 4. 分步计划', '');
  brief.plan.forEach((p, i) => {
    lines.push(`${i + 1}. [ ] ${p.step}${p.verification ? ` （验证：${p.verification}）` : ''}`);
  });
  lines.push('', '## 5. 约束', '');
  if (brief.constraints.must.length > 0) {
    lines.push('必须：');
    brief.constraints.must.forEach((m) => lines.push(`- ${m}`));
  }
  if (brief.constraints.forbidden.length > 0) {
    lines.push('禁止：');
    brief.constraints.forbidden.forEach((f) => lines.push(`- ${f}`));
  }
  if (brief.constraints.must.length === 0 && brief.constraints.forbidden.length === 0) lines.push('- （无）');
  lines.push('', '## 6. 验收标准', '');
  if (brief.acceptance.length > 0) {
    brief.acceptance.forEach((a) => lines.push(`- [ ] ${a}`));
  } else {
    lines.push('- [ ] （无明确验收标准，请执行后汇报实际产出）');
  }
  lines.push('');
  return lines.join('\n');
}

/** brief 生成失败时的兜底：从会话问答手工拼一份，保证链路不断。 */
export function fallbackBriefFromSession(session: TaskSession): Omit<BriefData, 'taskId' | 'createdAt' | 'schemaVersion'> {
  const answered = Object.values(session.tree.nodes).filter((n) => n.status === 'answered' && n.answer);
  const clarifications = answered.map((n) => ({ question: n.question, answer: n.answer ?? '', rationale: '（兜底生成，未经模型润色）' }));
  const polished = [
    session.rootPrompt.trim(),
    '',
    '已澄清的决策：',
    ...clarifications.map((c, i) => `- Q${i + 1} ${c.question} → ${c.answer}`),
  ].join('\n');
  return {
    title: session.rootPrompt.trim().split('\n')[0].slice(0, 50) || '任务',
    background: session.rootPrompt.trim(),
    clarifications,
    polishedPrompt: polished,
    plan: [
      { step: '阅读工作目录，了解现状与已有代码', verification: '能列出目录结构与关键文件' },
      { step: '按上述已澄清决策实现核心功能', verification: '产物文件出现在工作目录中' },
      { step: '自检：对照已澄清决策逐项确认实现符合结论', verification: '输出自检清单' },
    ],
    constraints: {
      must: ['在工作目录内完成全部工作'],
      forbidden: ['不得改动工作目录之外的文件', '不得改动 .smart2stupid 目录'],
    },
    acceptance: [],
  };
}
