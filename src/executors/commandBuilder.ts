// 命令模板占位符替换：{model} {workdir} {allowedTools} {disallowedTools} {budget} {promptArg} {autoApproveFlags} {sessionArgs}
// 替换值为空时整项跳过（如 autoApprove 关闭时 --dangerously-skip-permissions 被移除）；
// prompt ≤ 8KB 走 argv（Windows 命令行约 32KB 上限，留余量），超长改 stdin 注入。

import type { ExecContext, ExecRequest, CommandPreview } from './types.js';

const PROMPT_ARG_LIMIT = 8000;

export interface TemplateVars {
  model: string;
  workdir: string;
  allowedTools: string;
  disallowedTools: string[];
  budget: string;
  prompt: string;
  autoApprove: boolean;
  sessionArgs: string[];
}

export function buildTemplateVars(req: ExecRequest, ctx: ExecContext): TemplateVars {
  return {
    model: req.model ?? ctx.model,
    workdir: req.workdir,
    allowedTools: ctx.allowedTools,
    disallowedTools: ctx.disallowedTools,
    budget: String(ctx.budgetUsd),
    prompt: req.prompt,
    autoApprove: ctx.autoApprove,
    sessionArgs: req.session
      ? req.session.resume
        ? ['--resume', req.session.id]
        : ['--session-id', req.session.id, ...(req.session.name ? ['--name', req.session.name] : [])]
      : [],
  };
}

export function buildArgs(
  template: string[],
  autoApproveFlag: string | null | undefined,
  vars: TemplateVars,
): CommandPreview {
  const useStdin = vars.prompt.length > PROMPT_ARG_LIMIT;
  const promptArg = useStdin ? null : vars.prompt;
  const args: string[] = [];
  for (const t of template) {
    switch (t) {
      case '{promptArg}':
        if (promptArg !== null) args.push(promptArg);
        break;
      case '{autoApproveFlags}':
        if (vars.autoApprove && autoApproveFlag) args.push(autoApproveFlag);
        break;
      case '{sessionArgs}':
        args.push(...vars.sessionArgs);
        break;
      case '{model}':
        args.push(vars.model);
        break;
      case '{workdir}':
        args.push(vars.workdir);
        break;
      case '{allowedTools}':
        args.push(vars.allowedTools);
        break;
      case '{disallowedTools}':
        args.push(...vars.disallowedTools);
        break;
      case '{budget}':
        args.push(vars.budget);
        break;
      default:
        args.push(t);
    }
  }
  return { command: '', args, useStdin };
}
