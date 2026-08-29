// smart 端编排器：create(建树) → 轮次循环(回答→演进) → converge(生成 brief) → 用户确认。

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ChatMessage, SmartLogLine } from '../providers/types.js';
import { sessionDir, type SessionStore, type TaskSession } from '../sessions/store.js';
import { briefToMarkdown, fallbackBriefFromSession, parseBriefJson, type BriefData } from './brief.js';
import {
  applyAnswers,
  applyTreePatch,
  buildTree,
  computeFrontier,
  fallbackTree,
  parsePatchJson,
  parseTreeJson,
  type TreeNode,
} from './designTree.js';
import {
  briefSystem,
  briefUser,
  buildTreeRetryUser,
  buildTreeSystem,
  buildTreeUser,
  evolveSystem,
  evolveUser,
  fixSystem,
  fixUser,
  reviewSystem,
  reviewUser,
} from './promptTemplates.js';
import { collectReviewContext } from './reviewContext.js';
import { fallbackFixFromReview, parseFixJson, parseReviewJson, type FixResult, type ReviewResult } from './review.js';

export interface CreateTaskInput {
  prompt: string;
  workdir: string;
  providerId?: string;
  model?: string;
}

export interface RoundResult {
  session: TaskSession;
  frontier: TreeNode[];
  /** 前沿空已空 → 已自动收敛生成 brief，进入 review 阶段。 */
  converged: boolean;
  /** 达到 maxRounds，可强制收敛。 */
  maxRoundsReached: boolean;
}

/** smart 调用日志事件（含阶段，供 UI 实时展示与重放）。 */
export interface SmartLogEvent extends SmartLogLine {
  ts: string;
  phase: 'build_tree' | 'evolve' | 'brief' | 'review' | 'fix';
}

const PHASE_LABEL: Record<SmartLogEvent['phase'], string> = {
  build_tree: '建树',
  evolve: '追问演进',
  brief: '生成 brief',
  review: '验收审核',
  fix: '修正指令',
};

const LOG_RING_LIMIT = 500;

export class SmartOrchestrator {
  private readonly logRing = new Map<string, SmartLogEvent[]>();
  /** main.ts 注入：把日志事件广播到 SSE。 */
  private readonly onActivity?: (taskId: string, ev: SmartLogEvent) => void;

  constructor(
    private readonly store: SessionStore,
    private readonly providers: ProviderRegistry,
    private readonly cfg: Config,
    onActivity?: (taskId: string, ev: SmartLogEvent) => void,
  ) {
    this.onActivity = onActivity;
  }

  private providerFor(session: TaskSession) {
    return this.providers.get(session.providerId);
  }

  /** 记录并落盘一条 smart 日志事件（内存环 + smartlog.jsonl 追加）。 */
  private emitLog(session: TaskSession, phase: SmartLogEvent['phase'], line: SmartLogLine): void {
    const ev: SmartLogEvent = { ts: new Date().toISOString(), phase, stream: line.stream, text: line.text };
    const ring = this.logRing.get(session.taskId) ?? [];
    ring.push(ev);
    if (ring.length > LOG_RING_LIMIT) ring.shift();
    this.logRing.set(session.taskId, ring);
    this.onActivity?.(session.taskId, ev);
    try {
      const dir = sessionDir(session.workdir, session.taskId);
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, 'smartlog.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
    } catch {
      // 落盘失败不影响流程（如 workdir 已删除）
    }
  }

  /** 某任务的调用日志：内存环优先，为空时从 smartlog.jsonl 惰性读盘（重启恢复）。 */
  getLog(taskId: string): SmartLogEvent[] {
    const ring = this.logRing.get(taskId);
    if (ring && ring.length > 0) return ring;
    const s = this.store.get(taskId);
    if (!s) return ring ?? [];
    try {
      const text = readFileSync(path.join(sessionDir(s.workdir, s.taskId), 'smartlog.jsonl'), 'utf8');
      const events = text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as SmartLogEvent;
          } catch {
            return null;
          }
        })
        .filter((ev): ev is SmartLogEvent => ev !== null);
      this.logRing.set(taskId, events.slice(-LOG_RING_LIMIT));
      return this.logRing.get(taskId) ?? [];
    } catch {
      return ring ?? [];
    }
  }

  private chat(session: TaskSession, messages: ChatMessage[], phase: SmartLogEvent['phase']): Promise<string> {
    this.emitLog(session, phase, {
      stream: 'info',
      text: `═══ ${PHASE_LABEL[phase]}：调用 provider "${session.providerId}" ═══`,
    });
    return this.providerFor(session).chat({
      messages,
      temperature: this.cfg.smart.temperature,
      signal: AbortSignal.timeout(this.cfg.smart.timeoutMs),
      onLog: (line) => this.emitLog(session, phase, line),
    });
  }

  /** 建树：调用 provider 生成初始设计树，1 次重试后降级 fallback。 */
  private async buildInitialTree(session: TaskSession): Promise<void> {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildTreeSystem() },
      { role: 'user', content: buildTreeUser(session.rootPrompt) },
    ];
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await this.chat(session, messages, 'build_tree');
        const r = parseTreeJson(text);
        if (r.tree) {
          session.tree = r.tree;
          return;
        }
        lastError = r.error ?? '未知错误';
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: buildTreeRetryUser(lastError) });
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    console.warn(`[smart] 建树失败（${lastError}），降级为兜底问题集`);
    session.tree = fallbackTree();
  }

  /** 树演进：让模型输出 treePatch 并应用；失败时树保持不变，不影响流程。 */
  private async evolveTree(session: TaskSession, roundIndex: number, qa: { id: string; answer: string }[]): Promise<void> {
    try {
      const text = await this.chat(
        session,
        [
          { role: 'system', content: evolveSystem() },
          { role: 'user', content: evolveUser(JSON.stringify(session.tree), session.rootPrompt, roundIndex, qa) },
        ],
        'evolve',
      );
      const patch = parsePatchJson(text);
      if (!patch) {
        console.warn('[smart] treePatch 解析失败，树保持不变');
        return;
      }
      const errors = applyTreePatch(session.tree, patch);
      if (errors.length > 0) console.warn('[smart] treePatch 部分失败:', errors.join('; '));
    } catch (e) {
      console.warn('[smart] 树演进失败，沿用原树:', (e as Error).message);
    }
  }

  private async converge(session: TaskSession): Promise<void> {
    let brief: BriefData | undefined;
    try {
      const text = await this.chat(
        session,
        [
          { role: 'system', content: briefSystem() },
          { role: 'user', content: briefUser(session.rootPrompt, JSON.stringify(session.tree)) },
        ],
        'brief',
      );
      const r = parseBriefJson(text);
      if (r.brief) {
        brief = {
          schemaVersion: 1,
          taskId: session.taskId,
          createdAt: new Date().toISOString(),
          ...r.brief,
        };
      } else {
        console.warn(`[smart] brief JSON 解析失败（${r.error}），降级兜底生成`);
      }
    } catch (e) {
      console.warn('[smart] brief 生成调用失败，降级兜底生成:', (e as Error).message);
    }
    if (!brief) {
      brief = {
        schemaVersion: 1,
        taskId: session.taskId,
        createdAt: new Date().toISOString(),
        ...fallbackBriefFromSession(session),
      };
    }
    session.brief = brief;
    session.briefMd = briefToMarkdown(brief);
    session.phase = 'review';
    session.updatedAt = new Date().toISOString();
  }

  async createTask(input: CreateTaskInput): Promise<TaskSession> {
    const providerId = input.providerId ?? this.cfg.smart.provider;
    const provider = this.providers.get(providerId);
    const now = new Date().toISOString();
    const session: TaskSession = {
      taskId: `task-${now.slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`,
      workdir: input.workdir,
      rootPrompt: input.prompt.trim(),
      providerId,
      providerModel: provider.modelName,
      phase: 'clarify',
      tree: buildTree([]),
      round: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.buildInitialTree(session);
    this.markFrontierAsked(session);
    this.store.create(session);
    return session;
  }

  /** 把当前前沿标为已问（渲染轮次时调用）。 */
  markFrontierAsked(session: TaskSession): void {
    for (const n of computeFrontier(session.tree)) {
      if (n.status === 'pending') n.status = 'asked';
    }
    session.updatedAt = new Date().toISOString();
  }

  /** 提交一轮答案（可部分留空）。前沿空则自动收敛；否则演进树进入下一轮。 */
  async submitRound(taskId: string, answers: Record<string, string>): Promise<RoundResult> {
    const s = this.store.get(taskId);
    if (!s) throw new Error(`任务 ${taskId} 不存在`);
    if (s.phase !== 'clarify') throw new Error(`任务 ${taskId} 不在追问阶段（当前: ${s.phase}）`);

    const qa = applyAnswers(s.tree, answers, s.round + 1);
    s.round += 1;
    const maxRoundsReached = s.round >= this.cfg.smart.maxRounds;
    let frontier = computeFrontier(s.tree);
    let converged = false;

    if (frontier.length === 0) {
      await this.converge(s);
      converged = true;
    } else if (!maxRoundsReached) {
      await this.evolveTree(s, s.round, qa);
      frontier = computeFrontier(s.tree);
      if (frontier.length === 0) {
        await this.converge(s);
        converged = true;
      }
    }
    if (!converged) this.markFrontierAsked(s);
    this.store.persist(s);
    return { session: s, frontier: computeFrontier(s.tree), converged, maxRoundsReached };
  }

  /** 达到轮次上限或用户想直接收敛时调用。 */
  async forceConverge(taskId: string): Promise<TaskSession> {
    const s = this.store.get(taskId);
    if (!s) throw new Error(`任务 ${taskId} 不存在`);
    await this.converge(s);
    this.store.persist(s);
    return s;
  }

  /** 自动模式专用：把剩余所有未决节点用推荐/兜底答案填掉再收敛，确保 brief 无「未决」项。 */
  async autoResolveAndConverge(taskId: string, fallbackAnswer: string): Promise<TaskSession> {
    const s = this.store.get(taskId);
    if (!s) throw new Error(`任务 ${taskId} 不存在`);
    const qa: { id: string; answer: string }[] = [];
    for (const n of Object.values(s.tree.nodes)) {
      if (n.status !== 'answered') {
        const a = n.recommended?.trim() || fallbackAnswer;
        n.answer = a;
        n.status = 'answered';
        qa.push({ id: n.id, answer: a });
      }
    }
    if (qa.length > 0) s.tree.rounds.push({ index: s.round + 1, qa });
    await this.converge(s);
    this.store.persist(s);
    return s;
  }

  /** 用户编辑 brief.md 后保存（以用户编辑为准）。 */
  updateBrief(taskId: string, md: string): TaskSession {
    const s = this.store.get(taskId);
    if (!s) throw new Error(`任务 ${taskId} 不存在`);
    s.briefMd = md;
    s.updatedAt = new Date().toISOString();
    if (s.brief) s.brief.editedByUser = true;
    this.store.persist(s);
    return s;
  }

  /**
   * 审核当前迭代（执行结束后自动触发）：采集材料 → provider 调用 → 解析 → 写 iterations[last]。
   * 全链路 try/catch：失败写 reviewStatus='unavailable'，绝不抛（审核失败不能崩服务）。
   */
  async reviewCurrentIteration(taskId: string): Promise<void> {
    const s = this.store.get(taskId);
    if (!s || s.phase !== 'reviewing') return;
    const iter = s.iterations?.at(-1);
    if (!iter) {
      s.phase = 'reviewed';
      this.store.persist(s);
      return;
    }
    let review: ReviewResult | undefined;
    try {
      const ctx = await collectReviewContext(s.workdir, s.taskId, iter.status);
      const text = await this.chat(
        s,
        [
          { role: 'system', content: reviewSystem() },
          { role: 'user', content: reviewUser(s.briefMd ?? '', iter.status, ctx) },
        ],
        'review',
      );
      const r = parseReviewJson(text);
      if (r.review) review = r.review;
      else console.warn(`[smart] 审核 JSON 解析失败（${r.error}），降级为不可用`);
    } catch (e) {
      console.warn('[smart] 审核调用失败:', (e as Error).message);
    }
    if (review) {
      iter.review = review;
      iter.reviewStatus = 'ok';
    } else {
      iter.reviewStatus = 'unavailable';
      iter.reviewError = '审核模型调用或解析失败（详见服务端日志）';
    }
    s.phase = 'reviewed';
    s.updatedAt = new Date().toISOString();
    this.store.persist(s);
  }

  /** 生成修正指令并挂到当前迭代。要求 phase='reviewed' 且审核可用。 */
  async generateFix(taskId: string): Promise<FixResult> {
    const s = this.store.get(taskId);
    if (!s) throw new Error(`任务 ${taskId} 不存在`);
    if (s.phase !== 'reviewed') throw new Error(`任务 ${taskId} 不在已审核状态（当前: ${s.phase}）`);
    const iter = s.iterations?.at(-1);
    if (!iter || iter.reviewStatus !== 'ok' || !iter.review) throw new Error('当前迭代没有可用的审核结果，无法生成修正指令');
    let fix: FixResult | undefined;
    try {
      const text = await this.chat(
        s,
        [
          { role: 'system', content: fixSystem() },
          { role: 'user', content: fixUser(s.briefMd ?? '', JSON.stringify(iter.review)) },
        ],
        'fix',
      );
      const r = parseFixJson(text);
      if (r.fix) fix = r.fix;
      else console.warn(`[smart] 修正指令解析失败（${r.error}），降级用审核建议拼装`);
    } catch (e) {
      console.warn('[smart] 修正指令生成失败，降级用审核建议拼装:', (e as Error).message);
    }
    if (!fix) fix = fallbackFixFromReview(iter.review);
    iter.fix = fix;
    iter.decision = 'reiterate';
    iter.decidedAt = new Date().toISOString();
    s.updatedAt = iter.decidedAt;
    this.store.persist(s);
    return fix;
  }
}
