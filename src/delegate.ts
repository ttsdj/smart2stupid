// 当前 Codex 对话使用的 Claude 委派入口：无 HTTP、持久 Claude session、脱敏事件落盘。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config/loader.js';
import { captureSnapshot, compareSnapshots } from './delegation/snapshot.js';
import { redactEvent, redactText } from './delegation/redact.js';
import { selectClaudeSession } from './delegation/session.js';
import {
  appendEvent,
  controlPath,
  delegationDir,
  loadState,
  readControl,
  saveState,
} from './delegation/store.js';
import type { DelegationPhase, DelegationState } from './delegation/types.js';
import { ExecutorRegistry } from './executors/registry.js';
import type { ExecEvent, ExecStatus } from './executors/types.js';

interface ParsedArgs {
  command: 'run' | 'review' | 'status';
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0];
  const command: ParsedArgs['command'] = first === 'review' || first === 'status' || first === 'run' ? first : 'run';
  const args = first === command ? argv.slice(1) : argv;
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index++;
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function stringOpt(options: Record<string, string | boolean>, key: string, required = false): string | undefined {
  const value = options[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (required) throw new Error(`缺少 --${key}`);
  return undefined;
}

function safeTaskId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) throw new Error('task-id 只允许字母、数字和连字符');
  return safe;
}

function newTaskId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `task-${stamp}-${randomBytes(4).toString('hex')}`;
}

function readRequired(file: string, label: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`无法读取${label} ${file}: ${(error as Error).message}`);
  }
}

function titleFromBrief(brief: string): string {
  const heading = brief.match(/^#\s+(?:Brief:\s*)?(.+)$/m)?.[1]?.trim();
  return (heading || brief.trim().split('\n')[0] || 'smart2stupid 任务').slice(0, 100);
}

function buildExternalHandoff(brief: string, workdir: string, taskId: string, feedback?: string): string {
  const sections = [
    '你是本任务唯一的实施者 Claude Code。上游 Codex 只负责需求、计划和验收，不会在执行途中指导你。',
    '严格按 brief 工作，不得改变需求、扩大范围或把产品决策当作技术细节自行决定。',
    '',
    '═══════════ BRIEF 开始 ═══════════',
    brief.trim(),
    '═══════════ BRIEF 结束 ═══════════',
  ];
  if (feedback?.trim()) {
    sections.push('', '═══════════ CODEX 审核与修正要求 开始 ═══════════', feedback.trim(), '═══════════ CODEX 审核与修正要求 结束 ═══════════');
  }
  sections.push(
    '',
    '执行规则：',
    `1. 工作目录严格限定为 ${workdir}；不得修改其中的 .smart2stupid 元数据。`,
    '2. 按计划实施、运行允许的构建和测试，并如实汇报工具失败与未验证项。',
    '3. 普通技术实现细节选择与 brief 一致的最小方案；不得改变功能、范围、数据风险或验收标准。',
    '4. 若缺少产品决策、需要越权/联网/危险操作，或当前权限不足以继续：停止执行，最后单独输出 `SMART2STUPID_BLOCKED: <原因与需要的决定>`。',
    '5. 正常完成时逐项报告验收证据，并以 `SMART2STUPID_STATUS: completed` 结束。',
    `6. 任务编号：${taskId}。`,
    '7. 你拥有完成任务所需的自动执行权限，但递归删除、批量删除与同类清理命令由运行时 deny 规则强制禁止；不要尝试绕过或改写这些规则。若任务确实需要此类删除，停止并输出 SMART2STUPID_BLOCKED。',
  );
  return sections.join('\n');
}

function eventLine(event: ExecEvent): string | undefined {
  if (event.type === 'status') return `[claude|${event.status}]${event.message ? ` ${event.message}` : ''}`;
  if (event.type === 'tool_use' && !event.partial) return `[claude|tool] ${event.tool}${event.input ? ` ${JSON.stringify(event.input)}` : ''}`;
  if (event.type === 'tool_result' && event.isError) return `[claude|tool-error] ${typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}`;
  if (event.type === 'stderr') return `[claude|stderr] ${event.text}`;
  if (event.type === 'result') return `[claude|result] ${event.text}`;
  return undefined;
}

function phaseFromStatus(status: ExecStatus | 'blocked'): DelegationPhase {
  if (status === 'completed') return 'awaiting_review';
  if (status === 'blocked') return 'blocked';
  if (status === 'cancelled' || status === 'timeout') return 'cancelled';
  return 'failed';
}

async function run(options: Record<string, string | boolean>): Promise<number> {
  const workdir = path.resolve(stringOpt(options, 'workdir', true)!);
  if (!existsSync(workdir)) throw new Error(`工作目录不存在: ${workdir}`);
  const requestedTaskId = stringOpt(options, 'task-id');
  const taskId = requestedTaskId ? safeTaskId(requestedTaskId) : newTaskId();
  const existing = requestedTaskId && existsSync(path.join(delegationDir(workdir, taskId), 'delegate-state.json'))
    ? loadState(workdir, taskId)
    : undefined;
  const cfg = loadConfig();
  const maxIterations = Number(stringOpt(options, 'max-iterations') ?? cfg.smart.maxIterations ?? 3);
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new Error('--max-iterations 必须是正整数');

  let brief: string;
  let state: DelegationState;
  if (existing) {
    state = existing;
    if (state.phase === 'running' || state.phase === 'queued') throw new Error(`任务当前为 ${state.phase}，不能重复启动`);
    if (state.phase === 'awaiting_review') throw new Error('上一轮尚未由 Codex 记录审核，不能开始下一轮');
    if (state.phase === 'completed') throw new Error('任务已经验收通过；如需新需求，请创建新任务');
    if (state.phase === 'cancelled' && options['restart-cancelled'] !== true) throw new Error('任务已取消；只有用户明确要求后才能使用 --restart-cancelled 重启');
    brief = readRequired(state.briefPath, 'brief');
  } else {
    const briefFile = path.resolve(stringOpt(options, 'brief-file', true)!);
    brief = readRequired(briefFile, 'brief');
    const dir = delegationDir(workdir, taskId);
    mkdirSync(dir, { recursive: true });
    const briefPath = path.join(dir, 'brief.md');
    writeFileSync(briefPath, brief, 'utf8');
    const now = new Date().toISOString();
    state = {
      schemaVersion: 1,
      taskId,
      workdir,
      title: titleFromBrief(brief),
      phase: 'queued',
      briefPath,
      claudeSessionId: '',
      sessionEstablished: false,
      model: stringOpt(options, 'model') ?? cfg.stupid.model,
      maxIterations,
      extraIterations: 0,
      newSessionNext: false,
      iterations: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  const iteration = state.iterations.length + 1;
  if (iteration > state.maxIterations + state.extraIterations) {
    throw new Error(`已达到自动修正上限 ${state.maxIterations + state.extraIterations} 轮；请在执行面板点击“追加一轮”后重试`);
  }
  const requestNewSession = options['new-session'] === true || state.newSessionNext;
  const selectedSession = selectClaudeSession(
    state.claudeSessionId,
    state.sessionEstablished,
    requestNewSession,
  );
  state.claudeSessionId = selectedSession.id;
  if (!selectedSession.resume) state.sessionEstablished = false;
  state.newSessionNext = false;
  const feedbackFile = stringOpt(options, 'feedback-file');
  const feedback = feedbackFile ? readRequired(path.resolve(feedbackFile), '修正指令') : undefined;
  const actualPrompt = buildExternalHandoff(brief, workdir, taskId, feedback);
  const handoffPath = path.join(delegationDir(workdir, taskId), `handoff-${iteration}.md`);
  writeFileSync(handoffPath, redactText(actualPrompt), 'utf8');
  const before = captureSnapshot(workdir);
  const baselinePath = path.join(delegationDir(workdir, taskId), `baseline-${iteration}.json`);
  writeFileSync(baselinePath, JSON.stringify(before, null, 2), 'utf8');

  state.phase = 'queued';
  state.iterations.push({
    index: iteration,
    status: 'starting',
    startedAt: new Date().toISOString(),
    handoffPath,
    claudeSessionId: selectedSession.id,
  });
  saveState(state);
  appendEvent(workdir, taskId, iteration, { type: 'meta', data: { kind: 'handoff', handoffPath, baselinePath } });

  const registry = new ExecutorRegistry();
  registry.rebuild(cfg);
  const executorId = stringOpt(options, 'executor') ?? 'claude';
  const adapter = registry.get(executorId);
  const detected = await adapter.detect();
  if (!detected.ok) throw new Error(`${executorId} executor 不可用${detected.installHint ? `：${detected.installHint}` : ''}`);

  const abort = new AbortController();
  let stoppedByUser = false;
  writeFileSync(controlPath(workdir, taskId), JSON.stringify({ stop: false }, null, 2), 'utf8');
  const controlTimer = setInterval(() => {
    if (readControl(workdir, taskId).stop) {
      stoppedByUser = true;
      abort.abort();
    }
  }, 400);
  const timeoutTimer = setTimeout(() => abort.abort(), cfg.stupid.timeoutMs);
  state.phase = 'running';
  saveState(state);

  let terminal: ExecStatus = 'failed';
  let result = '';
  try {
    for await (const rawEvent of adapter.run({
      prompt: actualPrompt,
      workdir,
      model: state.model,
      session: {
        id: state.claudeSessionId,
        resume: selectedSession.resume,
        name: `smart2stupid-${taskId}`,
      },
      signal: abort.signal,
    })) {
      const event = redactEvent(rawEvent);
      appendEvent(workdir, taskId, iteration, event);
      const line = eventLine(event);
      if (line) console.log(line);
      if (event.type === 'result') result = event.text;
      const meta = event.type === 'meta' && event.data && typeof event.data === 'object'
        ? event.data as Record<string, unknown>
        : undefined;
      if (meta?.kind === 'init') {
        const actualSessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined;
        if (actualSessionId) state.claudeSessionId = actualSessionId;
        state.sessionEstablished = true;
        saveState(state);
      }
      if (event.type === 'status' && ['completed', 'failed', 'cancelled', 'timeout'].includes(event.status)) terminal = event.status;
    }
  } finally {
    clearInterval(controlTimer);
    clearTimeout(timeoutTimer);
  }

  let finalStatus: ExecStatus | 'blocked' = stoppedByUser ? 'cancelled' : terminal;
  if (/SMART2STUPID_BLOCKED\s*:/i.test(result)) finalStatus = 'blocked';
  const after = captureSnapshot(workdir);
  const changes = compareSnapshots(workdir, before, after);
  const changesPath = path.join(delegationDir(workdir, taskId), `changes-${iteration}.json`);
  writeFileSync(changesPath, JSON.stringify(changes, null, 2), 'utf8');
  const record = state.iterations.at(-1)!;
  record.status = finalStatus;
  record.endedAt = new Date().toISOString();
  record.changesPath = changesPath;
  record.resultSummary = redactText(result).slice(0, 4000) || undefined;
  if (!state.sessionEstablished) state.newSessionNext = true;
  state.phase = phaseFromStatus(finalStatus);
  saveState(state);
  appendEvent(workdir, taskId, iteration, { type: 'meta', data: { kind: 'changes', changesPath, changes } });

  console.log(`SMART2STUPID_RESULT=${JSON.stringify({ taskId, iteration, phase: state.phase, executorId, claudeSessionId: state.claudeSessionId, statePath: path.join(delegationDir(workdir, taskId), 'delegate-state.json') })}`);
  if (finalStatus === 'failed') return 1;
  if (finalStatus === 'cancelled' || finalStatus === 'timeout') return 130;
  return 0;
}

function review(options: Record<string, string | boolean>): number {
  const workdir = path.resolve(stringOpt(options, 'workdir', true)!);
  const taskId = safeTaskId(stringOpt(options, 'task-id', true)!);
  const verdict = stringOpt(options, 'verdict', true);
  if (verdict !== 'pass' && verdict !== 'partial' && verdict !== 'fail') throw new Error('--verdict 必须是 pass、partial 或 fail');
  const reviewFile = path.resolve(stringOpt(options, 'review-file', true)!);
  const reviewText = redactText(readRequired(reviewFile, '审核记录'));
  const state = loadState(workdir, taskId);
  const iteration = state.iterations.at(-1);
  if (!iteration) throw new Error('任务尚无执行轮次');
  const target = path.join(delegationDir(workdir, taskId), `review-${iteration.index}.md`);
  writeFileSync(target, reviewText, 'utf8');
  iteration.review = { verdict, path: target, recordedAt: new Date().toISOString() };
  state.phase = verdict === 'pass' ? 'completed' : 'reviewed';
  saveState(state);
  appendEvent(workdir, taskId, iteration.index, { type: 'meta', data: { kind: 'review', verdict, reviewPath: target } });
  console.log(`SMART2STUPID_REVIEW=${JSON.stringify({ taskId, iteration: iteration.index, verdict, phase: state.phase })}`);
  return 0;
}

function status(options: Record<string, string | boolean>): number {
  const workdir = path.resolve(stringOpt(options, 'workdir', true)!);
  const taskId = safeTaskId(stringOpt(options, 'task-id', true)!);
  console.log(JSON.stringify(loadState(workdir, taskId), null, 2));
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const code = parsed.command === 'run'
    ? await run(parsed.options)
    : parsed.command === 'review'
      ? review(parsed.options)
      : status(parsed.options);
  process.exitCode = code;
}

main().catch((error) => {
  console.error(`[delegate] ${redactText(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
