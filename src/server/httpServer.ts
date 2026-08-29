// HTTP 服务器：路由分发 + token 校验 + 错误包装。
// 静态资源走 public/，API 全部挂 /api/*（token 校验）。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.js';
import type { ExecEvent } from '../executors/types.js';
import type { ExecutorRegistry } from '../executors/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SmartOrchestrator } from '../smart/orchestrator.js';
import { computeFrontier } from '../smart/designTree.js';
import { sessionDir, type SessionStore, type TaskSession } from '../sessions/store.js';
import type { StupidOrchestrator } from '../stupid/orchestrator.js';
import { checkWorkdir } from '../util/path.js';
import { serveStatic } from './static.js';
import type { SseHub } from './sse.js';
import { publicDir } from './publicDir.js';
import { runAuto, type AutoMilestone } from '../auto.js';

export interface ServerDeps {
  /** 热重载后指向最新配置的可变引用。 */
  configRef: { value: Config };
  providers: ProviderRegistry;
  executors: ExecutorRegistry;
  smart: SmartOrchestrator;
  stupid: StupidOrchestrator;
  store: SessionStore;
  sse: SseHub;
  token: string;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray) => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** 会话对外视图（不含内部字段与日志）。 */
function sessionView(s: TaskSession, c: Config) {
  const maxIterations = c.smart.maxIterations ?? 3;
  return {
    taskId: s.taskId,
    workdir: s.workdir,
    rootPrompt: s.rootPrompt,
    providerId: s.providerId,
    providerModel: s.providerModel,
    phase: s.phase,
    round: s.round,
    maxRoundsReached: s.phase === 'clarify' && s.round >= c.smart.maxRounds,
    reviewEnabled: c.smart.review?.enabled !== false,
    maxIterations,
    maxIterationsReached: (s.iterations?.length ?? 0) >= maxIterations,
    tree: s.tree,
    frontier: computeFrontier(s.tree).map((n) => n.id),
    brief: s.brief,
    briefMd: s.briefMd,
    iterations: (s.iterations ?? []).map((iter) => ({
      index: iter.index,
      executorId: iter.executorId,
      model: iter.model,
      startedAt: iter.startedAt,
      endedAt: iter.endedAt,
      status: iter.status,
      resultSummary: iter.resultSummary,
      review: iter.review,
      reviewStatus: iter.reviewStatus,
      reviewError: iter.reviewError,
      fix: iter.fix,
      decision: iter.decision,
      decidedAt: iter.decidedAt,
    })),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export async function createHttpServer(deps: ServerDeps) {
  const cfg = () => deps.configRef.value;
  // auto 全局通道状态：里程碑环形缓冲 + 运行中标记
  const autoRing: AutoMilestone[] = [];
  let activeAuto = false;
  const pushMilestone = (ev: AutoMilestone): void => {
    autoRing.push(ev);
    if (autoRing.length > 200) autoRing.shift();
    deps.sse.broadcast('auto', ev);
  };

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/api\/config$/,
      handler: async (_req, res) => {
        const detected = await deps.executors.detectAll();
        const c = cfg();
        sendJson(res, 200, {
          server: { host: c.server.host, port: c.server.port },
          smart: {
            provider: c.smart.provider,
            maxRounds: c.smart.maxRounds,
            temperature: c.smart.temperature,
            maxIterations: c.smart.maxIterations ?? 3,
            reviewEnabled: c.smart.review?.enabled !== false,
          },
          providers: deps.providers.list().map((p) => ({
            ...p,
            type: (c.providers[p.id] as { type?: string } | undefined)?.type ?? 'unknown',
          })),
          executors: detected,
          stupid: {
            executor: c.stupid.executor,
            model: c.stupid.model,
            allowedTools: c.stupid.allowedTools,
            autoApprove: c.stupid.autoApprove,
            budgetUsd: c.stupid.budgetUsd,
          },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/providers\/health$/,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const id = url.searchParams.get('provider') ?? cfg().smart.provider;
        const provider = deps.providers.get(id);
        const health = provider.health ? await provider.health() : { ok: true, detail: '该 provider 无健康检查' };
        sendJson(res, health.ok ? 200 : 502, { provider: id, ...health });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/fs\/check$/,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const p = url.searchParams.get('path') ?? '';
        const result = checkWorkdir(p, cfg().server.allowedWorkdirs);
        sendJson(res, 200, result);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/tasks$/,
      handler: async (_req, res) => {
        sendJson(res, 200, deps.store.list().map((s) => sessionView(s, cfg())));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tasks$/,
      handler: async (req, res) => {
        const body = JSON.parse(await readBody(req)) as { prompt?: string; workdir?: string; providerId?: string; model?: string };
        if (!body.prompt?.trim()) return sendError(res, 400, 'prompt 不能为空');
        if (!body.workdir) return sendError(res, 400, 'workdir 不能为空');
        const checked = checkWorkdir(body.workdir, cfg().server.allowedWorkdirs);
        if (!checked.ok) return sendError(res, 400, `工作目录无效: ${checked.error}`);
        if (!deps.providers.has(body.providerId ?? cfg().smart.provider)) {
          return sendError(res, 400, `provider 不存在`);
        }
        const session = await deps.smart.createTask({
          prompt: body.prompt,
          workdir: checked.realpath,
          providerId: body.providerId,
          model: body.model,
        });
        sendJson(res, 201, sessionView(session, cfg()));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/tasks\/([^/]+)$/,
      handler: async (_req, res, m) => {
        const s = deps.store.get(m[1]);
        if (!s) return sendError(res, 404, '任务不存在');
        sendJson(res, 200, sessionView(s, cfg()));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tasks\/([^/]+)\/round$/,
      handler: async (req, res, m) => {
        const body = JSON.parse(await readBody(req)) as { answers?: Record<string, string> };
        if (!body.answers || typeof body.answers !== 'object') return sendError(res, 400, 'answers 必须是对象');
        const result = await deps.smart.submitRound(m[1], body.answers);
        sendJson(res, 200, {
          ...sessionView(result.session, cfg()),
          converged: result.converged,
          maxRoundsReached: result.maxRoundsReached,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tasks\/([^/]+)\/force-converge$/,
      handler: async (_req, res, m) => {
        const s = await deps.smart.forceConverge(m[1]);
        sendJson(res, 200, sessionView(s, cfg()));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tasks\/([^/]+)\/brief$/,
      handler: async (req, res, m) => {
        const body = JSON.parse(await readBody(req)) as { md?: string };
        if (typeof body.md !== 'string') return sendError(res, 400, 'md 必须是字符串');
        const s = deps.smart.updateBrief(m[1], body.md);
        sendJson(res, 200, sessionView(s, cfg()));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tasks\/([^/]+)\/iterate$/,
      handler: async (req, res, m) => {
        const body = JSON.parse(await readBody(req)) as { executorId?: string; model?: string };
        const s = deps.store.get(m[1]);
        if (!s) return sendError(res, 404, '任务不存在');
        const c = cfg();
        const maxIterations = c.smart.maxIterations ?? 3;
        if (s.phase !== 'reviewed') return sendError(res, 400, `任务不在已审核状态（当前: ${s.phase}）`);
        const last = s.iterations?.at(-1);
        if (!last || last.reviewStatus !== 'ok') return sendError(res, 400, '当前迭代没有可用的审核结果，无法生成修正指令');
        if ((s.iterations?.length ?? 0) >= maxIterations) return sendError(res, 400, `已达迭代上限（${maxIterations} 轮）`);
        const fix = await deps.smart.generateFix(m[1]);
        const nextIndex = (s.iterations?.length ?? 0) + 1;
        const executorId = body.executorId ?? last.executorId ?? c.stupid.executor;
        const handle = await deps.stupid.start(m[1], { executorId, model: body.model ?? last.model });
        sendJson(res, 202, { taskId: m[1], iteration: nextIndex, status: handle.status, fix });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tasks\/([^/]+)\/finish$/,
      handler: async (_req, res, m) => {
        const s = deps.store.get(m[1]);
        if (!s) return sendError(res, 404, '任务不存在');
        if (s.phase !== 'reviewed') return sendError(res, 400, `任务不在已审核状态（当前: ${s.phase}）`);
        const last = s.iterations?.at(-1);
        if (last) {
          last.decision = 'finish';
          last.decidedAt = new Date().toISOString();
        }
        s.phase =
          last?.status === 'completed'
            ? 'completed'
            : last?.status === 'cancelled' || last?.status === 'timeout'
              ? 'cancelled'
              : 'failed';
        s.updatedAt = new Date().toISOString();
        deps.store.persist(s);
        sendJson(res, 200, sessionView(s, cfg()));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tasks\/([^/]+)\/review\/retry$/,
      handler: async (_req, res, m) => {
        const s = deps.store.get(m[1]);
        if (!s) return sendError(res, 404, '任务不存在');
        const last = s.iterations?.at(-1);
        if (!last || last.reviewStatus !== 'unavailable') return sendError(res, 400, '当前迭代不需要重试审核');
        s.phase = 'reviewing';
        s.updatedAt = new Date().toISOString();
        deps.store.persist(s);
        await deps.smart.reviewCurrentIteration(m[1]);
        sendJson(res, 200, sessionView(s, cfg()));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/execute\/preview$/,
      handler: async (req, res) => {
        const body = JSON.parse(await readBody(req)) as { taskId?: string; executorId?: string; model?: string };
        if (!body.taskId) return sendError(res, 400, 'taskId 不能为空');
        const preview = deps.stupid.preview(body.taskId, body.executorId, body.model);
        sendJson(res, 200, preview);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/execute\/start$/,
      handler: async (req, res) => {
        const body = JSON.parse(await readBody(req)) as { taskId?: string; executorId?: string; model?: string };
        if (!body.taskId) return sendError(res, 400, 'taskId 不能为空');
        const handle = await deps.stupid.start(body.taskId, { executorId: body.executorId, model: body.model });
        sendJson(res, 202, { taskId: handle.taskId, executorId: handle.executorId, status: handle.status });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/execute\/cancel$/,
      handler: async (req, res) => {
        const body = JSON.parse(await readBody(req)) as { taskId?: string };
        if (!body.taskId) return sendError(res, 400, 'taskId 不能为空');
        sendJson(res, 200, { cancelled: deps.stupid.cancel(body.taskId) });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/execute\/stream$/,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const taskId = url.searchParams.get('taskId') ?? '';
        const s = deps.store.get(taskId);
        if (!s) return sendError(res, 404, '任务不存在');
        deps.sse.subscribe(`exec:${taskId}`, res);
        // 先重放历史（运行中的内存事件，或已结束的落盘日志）
        const run = deps.stupid.getRun(taskId);
        const history = run ? run.events : replayFromSession(s);
        for (const ev of history) {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
        if (!run) {
          const phaseEvent = s.phase === 'completed' ? 'completed' : s.phase === 'failed' ? 'failed' : s.phase === 'cancelled' ? 'cancelled' : null;
          if (phaseEvent && history.length === 0) {
            res.write(`data: ${JSON.stringify({ type: 'status', status: phaseEvent, message: '历史执行（已结束）' })}\n\n`);
          }
          res.end();
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/tasks\/([^/]+)\/smart-log$/,
      handler: async (_req, res, m) => {
        const s = deps.store.get(m[1]);
        if (!s) return sendError(res, 404, '任务不存在');
        sendJson(res, 200, { events: deps.smart.getLog(m[1]) });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/tasks\/([^/]+)\/smart-stream$/,
      handler: async (req, res, m) => {
        const s = deps.store.get(m[1]);
        if (!s) return sendError(res, 404, '任务不存在');
        deps.sse.subscribe(`smart:${m[1]}`, res);
        for (const ev of deps.smart.getLog(m[1])) {
          res.write(`data: ${JSON.stringify({ type: 'smart_log', ...ev })}\n\n`);
        }
        // 长连接保持（心跳由 SseHub 维护），直到客户端断开
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/auto\/start$/,
      handler: async (req, res) => {
        if (activeAuto) return sendError(res, 409, '已有自动闭环在运行');
        const body = JSON.parse(await readBody(req)) as {
          prompt?: string;
          workdir?: string;
          smart?: string;
          stupid?: string;
          model?: string;
          maxIterations?: number;
        };
        if (!body.prompt?.trim()) return sendError(res, 400, 'prompt 不能为空');
        if (!body.workdir) return sendError(res, 400, 'workdir 不能为空');
        const checked = checkWorkdir(body.workdir, cfg().server.allowedWorkdirs);
        if (!checked.ok) return sendError(res, 400, `工作目录无效: ${checked.error}`);

        activeAuto = true;
        sendJson(res, 202, { status: 'started' });
        // 后台跑闭环，不阻塞响应
        void (async () => {
          try {
            await runAuto(
              {
                prompt: body.prompt!,
                workdir: checked.realpath,
                providerId: body.smart,
                executorId: body.stupid,
                model: body.model,
                maxIterations: body.maxIterations,
              },
              {
                smart: deps.smart,
                stupid: deps.stupid,
                store: deps.store,
                cfg: cfg(),
                onMilestone: pushMilestone,
              },
            );
          } catch (e) {
            console.error('[auto] 后台闭环异常:', e);
            pushMilestone({ type: 'auto', event: 'done', taskId: '', verdict: null, iterations: 0, success: false, finalPhase: 'failed' });
          } finally {
            activeAuto = false;
          }
        })();
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/auto\/stream$/,
      handler: async (req, res) => {
        deps.sse.subscribe('auto', res);
        for (const ev of autoRing) {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      },
    },
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        // token 校验
        const tokenOk =
          url.searchParams.get('token') === deps.token || req.headers['x-auth-token'] === deps.token;
        if (!tokenOk) return sendError(res, 401, 'token 无效（在 URL 中带上 ?token=...）');
        const method = req.method ?? 'GET';
        for (const route of routes) {
          if (route.method !== method) continue;
          const m = route.pattern.exec(url.pathname);
          if (!m) continue;
          await route.handler(req, res, m);
          return;
        }
        return sendError(res, 404, '接口不存在');
      }
      if (!serveStatic(publicDir, url.pathname, res)) {
        sendError(res, 404, 'Not Found');
      }
    } catch (e) {
      if (!res.headersSent) {
        const message = e instanceof Error ? e.message : String(e);
        const status = message.includes('不存在') || message.includes('未安装') ? 400 : 500;
        sendError(res, status, message);
      } else {
        res.end();
      }
    }
  });

  return {
    server,
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg().server.port, cfg().server.host, () => {
          server.removeListener('error', reject);
          const addr = server.address() as AddressInfo;
          resolve({ host: addr.address, port: addr.port });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** 从落盘 events.jsonl 重放历史事件（执行已结束时的订阅）。 */
function replayFromSession(s: TaskSession): ExecEvent[] {
  try {
    const text = readFileSync(path.join(sessionDir(s.workdir, s.taskId), 'events.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const { ts: _ts, ...ev } = JSON.parse(line) as { ts?: string } & ExecEvent;
          return ev;
        } catch {
          return null;
        }
      })
      .filter((ev): ev is ExecEvent => ev !== null);
  } catch {
    return [];
  }
}
