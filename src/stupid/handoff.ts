// handoff prompt：固定头 + brief.md 全文内联 + （可选）上一轮迭代反馈段 + 尾部规则。

import path from 'node:path';
import type { ExecStatus } from '../executors/types.js';
import { sessionDir } from '../sessions/store.js';
import type { FixResult, ReviewResult } from '../smart/review.js';

export interface IterationFeedback {
  index: number;
  status: ExecStatus;
  resultSummary?: string;
  review?: ReviewResult;
  fix?: FixResult;
}

function buildFeedbackSection(fb: IterationFeedback): string {
  const lines: string[] = [`═══════════ 上一轮执行反馈（第 ${fb.index} 轮）开始 ═══════════`];
  lines.push(`- 上一轮执行状态：${fb.status}`);
  if (fb.resultSummary) lines.push(`- 执行结果摘要：${fb.resultSummary}`);
  const problems = fb.review?.items.filter((i) => i.status !== 'pass') ?? [];
  if (problems.length > 0) {
    lines.push('审核问题清单：');
    problems.forEach((i, n) => {
      lines.push(`${n + 1}. [${i.criterion}] — ${i.issue || '未通过/无法验证'}（证据：${i.evidence}）`);
    });
  }
  const fixText = fb.fix?.fixInstructions ?? fb.review?.fixSuggestions.join('\n');
  if (fixText) {
    lines.push('修正指令（最高优先级，先执行修复再重新执行 brief）：');
    lines.push(fixText);
  }
  lines.push('═══════════ 上一轮执行反馈 结束 ═══════════');
  return lines.join('\n');
}

export function buildHandoffPrompt(briefMd: string, workdir: string, taskId: string, fb?: IterationFeedback): string {
  const briefPath = path.join(sessionDir(workdir, taskId), 'brief.md');
  const sections = [
    '你是执行 agent，严格按照下方 brief 完成一个任务。你不是规划者——计划已由上游完成并达成共识，',
    '你的职责是：按计划顺序执行、每步自检、如实汇报，不要擅自扩大范围。',
    '',
    '═══════════ BRIEF 开始 ═══════════',
    briefMd.trim(),
    '═══════════ BRIEF 结束 ═══════════',
  ];
  if (fb) {
    sections.push('', buildFeedbackSection(fb));
  }
  const rules: string[] = ['执行规则：'];
  if (fb) {
    rules.push('0. 先按「修正指令」修复上一轮问题，再按 brief 重新执行，最后逐项重新自检验收。');
  }
  rules.push(
    `1. 工作目录是 ${workdir}，全部产物必须放在其中；brief 完整文件在 ${briefPath}，可直接读取。`,
    '2. 按 brief「分步计划」的顺序执行，每步完成后对照该步的验证方式自检，再进入下一步。',
    '3. 全部完成后，对照 brief「验收标准」逐项自检，并汇报：每项验收是否通过、未通过的原因。',
    '4. 遇到计划中未覆盖的决策，优先按 brief 已澄清的结论推断；确实无法推断的，选最小改动方案并说明。',
    '5. 最后用一句话总结：完成了什么、验收结果如何。',
  );
  sections.push('', ...rules);
  return sections.join('\n');
}
