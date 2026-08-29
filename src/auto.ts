// 全自动 agent 对 agent 闭环：smart 自问自答出 plan → stupid 执行 → smart 审核 →
// 不通过自动生成修正指令重跑，直到 pass 或迭代上限。无人环，无 web UI。

import type { Config } from './config/schema.js';
import type { SessionStore, TaskSession } from './sessions/store.js';
import type { SmartOrchestrator } from './smart/orchestrator.js';
import type { StupidOrchestrator } from './stupid/orchestrator.js';
import { computeFrontier } from './smart/designTree.js';

export interface AutoOptions {
  prompt: string;
  workdir: string;
  providerId?: string;
  executorId?: string;
  model?: string;
  maxIterations?: number;
}

export interface AutoSummary {
  taskId: string;
  finalPhase: string;
  verdict: string | null;
  iterations: number;
  success: boolean;
}

export interface AutoDeps {
  smart: SmartOrchestrator;
  stupid: StupidOrchestrator;
  store: SessionStore;
  cfg: Config;
  /** 里程碑回调：server 模式接到 SSE 全局通道，CLI 模式留空（用 console.log）。 */
  onMilestone?: (ev: AutoMilestone) => void;
}

export type AutoMilestone =
  | { type: 'auto'; event: 'started'; smart: string; stupid: string; workdir: string; maxIterations: number }
  | { type: 'auto'; event: 'task_created'; taskId: string }
  | { type: 'auto'; event: 'phase'; phase: 'plan' | 'exec' | 'review' | 'fix'; iteration?: number }
  | { type: 'auto'; event: 'verdict'; iteration: number; verdict: string | null }
  | { type: 'auto'; event: 'done'; taskId: string; verdict: string | null; iterations: number; success: boolean; finalPhase: string };

const AUTO_ANSWER_FALLBACK = '（自动）采用默认/最小方案，由 smart 端自主决定';

/** smart 自问自答：把前沿问题的推荐答案自动采纳，逐轮演进直到收敛或达到轮次上限。 */
async function selfGrill(smart: SmartOrchestrator, session: TaskSession, log: (s: string) => void, maxRounds: number): Promise<void> {
  while (session.phase === 'clarify') {
    const frontier = computeFrontier(session.tree);
    if (frontier.length === 0) break;
    const answers: Record<string, string> = {};
    for (const n of frontier) {
      answers[n.id] = n.recommended?.trim() || AUTO_ANSWER_FALLBACK;
      log(`  ✍️  自答 ${n.id}: ${answers[n.id].slice(0, 60)}`);
    }
    const r = await smart.submitRound(session.taskId, answers);
    if (r.converged) break;
    if (r.maxRoundsReached || session.round >= maxRounds) {
      log(`  ⚠️  达到追问轮次上限（${maxRounds}），填掉剩余未决决策后收敛`);
      await smart.autoResolveAndConverge(session.taskId, AUTO_ANSWER_FALLBACK);
      break;
    }
  }
}

export async function runAuto(opts: AutoOptions, deps: AutoDeps): Promise<AutoSummary> {
  const { smart, stupid, store, cfg, onMilestone } = deps;
  const maxIterations = opts.maxIterations ?? cfg.smart.maxIterations ?? 3;
  const smartId = opts.providerId ?? cfg.smart.provider;
  const stupidId = opts.executorId ?? cfg.stupid.executor;
  const milestone = (ev: AutoMilestone): void => {
    onMilestone?.(ev);
    // CLI 模式（无回调）仍打印关键节点
    if (!onMilestone) {
      const map: Record<string, string> = {
        plan: '▶ 阶段 1/3：smart 出 plan（自问自答）',
        exec: `▶ 阶段 2/3：第 ${ev.type === 'auto' && ev.event === 'phase' ? ev.iteration : ''} 轮执行`,
        review: '▶ 阶段 3/3：smart 审核结果',
        fix: '🔁 生成修正指令…',
      };
      if (ev.type === 'auto' && ev.event === 'phase') console.log(map[ev.phase] ?? '');
      else if (ev.type === 'auto' && ev.event === 'verdict') console.log(`  📋 审核 verdict = ${ev.verdict}`);
      else if (ev.type === 'auto' && ev.event === 'done') console.log(` 完成。verdict=${ev.verdict ?? '不可用'} · 迭代 ${ev.iterations} 轮`);
    }
  };

  milestone({ type: 'auto', event: 'started', smart: smartId, stupid: stupidId, workdir: opts.workdir, maxIterations });
  milestone({ type: 'auto', event: 'phase', phase: 'plan' });
  const session = await smart.createTask({
    prompt: opts.prompt,
    workdir: opts.workdir,
    providerId: opts.providerId,
    model: opts.model,
  });
  milestone({ type: 'auto', event: 'task_created', taskId: session.taskId });
  await selfGrill(smart, session, (s) => console.log(s), cfg.smart.maxRounds);

  let verdict: string | null = null;
  let iterations = 0;
  for (let i = 1; i <= maxIterations; i++) {
    iterations = i;
    milestone({ type: 'auto', event: 'phase', phase: 'exec', iteration: i });
    const handle = await stupid.start(session.taskId, {
      executorId: opts.executorId,
      model: opts.model ?? cfg.stupid.model,
    });
    await handle.done;

    milestone({ type: 'auto', event: 'phase', phase: 'review', iteration: i });
    await smart.reviewCurrentIteration(session.taskId);

    const iter = store.get(session.taskId)?.iterations?.at(-1);
    if (!iter || iter.reviewStatus !== 'ok' || !iter.review) {
      console.log(`  ⚠️  审核不可用（${iter?.reviewError ?? '未知原因'}），停止迭代`);
      verdict = null;
      milestone({ type: 'auto', event: 'verdict', iteration: i, verdict: null });
      break;
    }
    verdict = iter.review.verdict;
    milestone({ type: 'auto', event: 'verdict', iteration: i, verdict });
    if (verdict === 'pass') {
      console.log('  ✅ 全部验收通过');
      break;
    }
    if (i < maxIterations) {
      milestone({ type: 'auto', event: 'phase', phase: 'fix', iteration: i });
      await smart.generateFix(session.taskId);
    } else {
      console.log(`  🛑 已达迭代上限（${maxIterations}）`);
    }
  }

  const final = store.get(session.taskId);
  const success = verdict === 'pass';
  // 结束标记（对齐 web 语义）：最后一次迭代打 finish 决定
  if (final && final.phase === 'reviewed') {
    const last = final.iterations?.at(-1);
    if (last) {
      last.decision = 'finish';
      last.decidedAt = new Date().toISOString();
    }
    final.phase = last?.status === 'completed' ? 'completed' : last?.status === 'cancelled' || last?.status === 'timeout' ? 'cancelled' : 'failed';
    final.updatedAt = new Date().toISOString();
    store.persist(final);
  }

  milestone({ type: 'auto', event: 'done', taskId: session.taskId, verdict, iterations, success, finalPhase: final?.phase ?? 'unknown' });
  return {
    taskId: session.taskId,
    finalPhase: final?.phase ?? 'unknown',
    verdict,
    iterations,
    success,
  };
}
