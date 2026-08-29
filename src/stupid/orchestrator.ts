// stupid 端编排器：选 executor → 拼 handoff prompt → run 事件流 → SSE 广播 + 落盘。

import type { Config } from '../config/schema.js';
import type { ExecutorRegistry } from '../executors/registry.js';
import type { CommandPreview, ExecEvent, ExecStatus } from '../executors/types.js';
import type { SseHub } from '../server/sse.js';
import type { SessionStore, TaskSession } from '../sessions/store.js';
import { buildHandoffPrompt, type IterationFeedback } from './handoff.js';
import { SessionLogger } from './sessionLog.js';

export interface RunHandle {
  taskId: string;
  executorId: string;
  model?: string;
  status: ExecStatus;
  startedAt: string;
  events: ExecEvent[];
  abort: AbortController;
  done: Promise<void>;
}

export interface RunFinishedInfo {
  taskId: string;
  status: ExecStatus;
}

export class StupidOrchestrator {
  private readonly runs = new Map<string, RunHandle>();
  /** main.ts 注入；不 await（审核异步进行，不阻塞执行流收尾）。 */
  onRunFinished?: (info: RunFinishedInfo) => void;
  /** 执行事件钩子（CLI 模式打印实时日志用；web 模式走 SSE 无需设置）。 */
  onExecEvent?: (taskId: string, ev: ExecEvent) => void;

  constructor(
    private readonly store: SessionStore,
    private readonly executors: ExecutorRegistry,
    private readonly sse: SseHub,
    private readonly cfg: Config,
  ) {}

  getRun(taskId: string): RunHandle | undefined {
    return this.runs.get(taskId);
  }

  /** dry-run 预览将要执行的完整命令。 */
  preview(taskId: string, executorId?: string, model?: string): CommandPreview {
    const session = this.requireSession(taskId);
    const adapter = this.executors.get(executorId ?? this.cfg.stupid.executor);
    const prompt = this.handoffFor(session);
    return adapter.preview({ prompt, workdir: session.workdir, model });
  }

  private requireSession(taskId: string): TaskSession {
    const s = this.store.get(taskId);
    if (!s) throw new Error(`任务 ${taskId} 不存在`);
    return s;
  }

  private handoffFor(session: TaskSession): string {
    if (!session.briefMd) throw new Error(`任务 ${session.taskId} 还没有 brief，无法执行`);
    // 非首轮执行时带上上一轮反馈（状态/结果摘要/审核问题/修正指令）
    const last = session.iterations?.at(-1);
    let fb: IterationFeedback | undefined;
    if (last && (last.review || last.fix || last.status)) {
      fb = {
        index: last.index,
        status: last.status,
        resultSummary: last.resultSummary,
        review: last.review,
        fix: last.fix,
      };
    }
    return buildHandoffPrompt(session.briefMd, session.workdir, session.taskId, fb);
  }

  async start(taskId: string, opts: { executorId?: string; model?: string } = {}): Promise<RunHandle> {
    if (this.runs.has(taskId)) throw new Error(`任务 ${taskId} 已在执行中`);
    const session = this.requireSession(taskId);
    if (session.phase === 'executing' || session.phase === 'reviewing') {
      throw new Error(`任务 ${taskId} 当前状态（${session.phase}）不能开始执行`);
    }
    const executorId = opts.executorId ?? this.cfg.stupid.executor;
    const adapter = this.executors.get(executorId);

    const detect = await adapter.detect();
    if (!detect.ok) {
      throw new Error(`executor "${executorId}" 未安装${detect.installHint ? `。安装提示: ${detect.installHint}` : ''}`);
    }

    const prompt = this.handoffFor(session);
    const logger = new SessionLogger(session.workdir, session.taskId);
    const abort = new AbortController();

    const handle: RunHandle = {
      taskId,
      executorId,
      model: opts.model,
      status: 'starting',
      startedAt: new Date().toISOString(),
      events: [],
      abort,
      done: Promise.resolve(),
    };

    // 每轮执行 = 一次迭代记录
    session.iterations ??= [];
    session.iterations.push({
      index: session.iterations.length + 1,
      executorId,
      model: opts.model,
      startedAt: handle.startedAt,
      status: 'running',
    });

    session.phase = 'executing';
    session.updatedAt = new Date().toISOString();
    this.store.persist(session);
    this.runs.set(taskId, handle);

    const timeoutMs = opts.model ? this.cfg.stupid.timeoutMs : this.cfg.stupid.timeoutMs;
    const timeout = setTimeout(() => {
      if (handle.status === 'running' || handle.status === 'starting') {
        abort.abort();
      }
    }, timeoutMs);
    // 超时后进程被 abort 杀掉，状态由下面的 status 事件映射为 cancelled；
    // 额外延时后再兜底标记 timeout，防止进程杀不干净挂死。
    const timeoutLabel = setTimeout(() => {
      if (handle.status === 'running' || handle.status === 'starting') {
        handle.status = 'timeout';
        this.broadcast(session, { type: 'status', status: 'timeout', message: '执行超时' }, logger);
      }
    }, timeoutMs + 30_000);

    handle.done = (async () => {
      try {
        for await (const ev of adapter.run({ prompt, workdir: session.workdir, model: opts.model, signal: abort.signal })) {
          handle.events.push(ev);
          if (ev.type === 'status') {
            const terminal: ExecStatus[] = ['completed', 'failed', 'cancelled', 'timeout'];
            if (terminal.includes(ev.status)) handle.status = ev.status;
            else handle.status = ev.status === 'starting' ? 'starting' : 'running';
          }
          this.broadcast(session, ev, logger);
        }
      } catch (e) {
        handle.status = 'failed';
        const ev: ExecEvent = { type: 'status', status: 'failed', message: (e as Error).message };
        handle.events.push(ev);
        this.broadcast(session, ev, logger);
      } finally {
        clearTimeout(timeout);
        clearTimeout(timeoutLabel);
        if (handle.status === 'running' || handle.status === 'starting') {
          handle.status = abort.signal.aborted ? 'cancelled' : 'failed';
        }
        // 迭代记录收尾
        const iter = session.iterations?.at(-1);
        if (iter) {
          iter.status = handle.status;
          iter.endedAt = new Date().toISOString();
          const lastResult = [...handle.events].reverse().find((e) => e.type === 'result' && e.text);
          iter.resultSummary = lastResult && lastResult.type === 'result' ? lastResult.text.slice(0, 2000) : undefined;
        }
        // 审核开启 → reviewing（异步审核）；关闭 → 沿用旧终态映射
        const legacyPhase =
          handle.status === 'completed'
            ? 'completed'
            : handle.status === 'cancelled' || handle.status === 'timeout'
              ? 'cancelled'
              : 'failed';
        const reviewEnabled = this.cfg.smart.review?.enabled !== false;
        session.phase = reviewEnabled ? 'reviewing' : legacyPhase;
        session.updatedAt = new Date().toISOString();
        this.store.persist(session);
        this.runs.delete(taskId);
        if (session.phase === 'reviewing' && this.onRunFinished) {
          Promise.resolve().then(() => this.onRunFinished?.({ taskId, status: handle.status }));
        }
      }
    })();

    return handle;
  }

  private broadcast(session: TaskSession, ev: ExecEvent, logger: SessionLogger): void {
    logger.appendEvent(ev);
    this.sse.broadcast(`exec:${session.taskId}`, ev);
    this.onExecEvent?.(session.taskId, ev);
  }

  cancel(taskId: string): boolean {
    const run = this.runs.get(taskId);
    if (!run) return false;
    run.abort.abort();
    return true;
  }
}
