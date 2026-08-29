// 会话存储：内存 Map 为运行期权威，JSON 落盘到 <workdir>/.smart2stupid/ 下，
// 项目根目录 .smart2stupid/index.json 维护 taskId → workdir 索引用于启动恢复。

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ExecStatus } from '../executors/types.js';
import type { BriefData } from '../smart/brief.js';
import type { DesignTree } from '../smart/designTree.js';
import type { FixResult, ReviewResult } from '../smart/review.js';

export type SessionPhase =
  | 'clarify'
  | 'review'
  | 'executing'
  | 'reviewing' // 执行已结束，自动审核进行中
  | 'reviewed' // 审核完成（含「审核不可用」），等待用户决定
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 一次执行 = 一轮迭代；每轮挂执行记录 + 审核 + 修正指令。 */
export interface IterationRecord {
  /** 从 1 开始。 */
  index: number;
  executorId: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  /** 本轮执行终态。 */
  status: ExecStatus;
  /** 最后一个 result 事件文本，截断 2KB。 */
  resultSummary?: string;
  /** 自动审核结果；reviewStatus='unavailable' 时可能缺失。 */
  review?: ReviewResult;
  /** 'ok' = 审核成功；'unavailable' = provider 挂/解析降级。 */
  reviewStatus?: 'ok' | 'unavailable';
  reviewError?: string;
  /** 用户点「生成修正指令并重跑」后写入。 */
  fix?: FixResult;
  /** 用户在 reviewed 状态的动作。 */
  decision?: 'reiterate' | 'finish';
  decidedAt?: string;
}

export interface TaskSession {
  taskId: string;
  workdir: string;
  rootPrompt: string;
  providerId: string;
  providerModel?: string;
  phase: SessionPhase;
  tree: DesignTree;
  /** 已进行的追问轮数。 */
  round: number;
  brief?: BriefData;
  /** brief.md 当前内容（模型生成或被用户编辑后的）。 */
  briefMd?: string;
  /** 执行迭代记录（v2 起；旧会话缺省为空数组）。 */
  iterations?: IterationRecord[];
  createdAt: string;
  updatedAt: string;
}

const S2S_DIR = '.smart2stupid';

export function metaDir(workdir: string): string {
  return path.join(workdir, S2S_DIR);
}

export function briefsDir(workdir: string): string {
  return path.join(metaDir(workdir), 'briefs');
}

export function sessionDir(workdir: string, taskId: string): string {
  return path.join(metaDir(workdir), 'sessions', taskId);
}

function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9-]/g, '');
}

export class SessionStore {
  private sessions = new Map<string, TaskSession>();
  private readonly indexPath: string;

  constructor(private readonly projectRoot: string) {
    this.indexPath = path.join(projectRoot, S2S_DIR, 'index.json');
  }

  /** 启动恢复：读索引 → 逐个加载 session 目录里的 state.json。 */
  restore(): void {
    try {
      const index = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, { workdir: string }>;
      for (const [taskId, entry] of Object.entries(index)) {
        try {
          const statePath = path.join(sessionDir(entry.workdir, taskId), 'state.json');
          const s = JSON.parse(readFileSync(statePath, 'utf8')) as TaskSession;
          if (!s.taskId || !s.workdir) continue;
          s.iterations ??= []; // 旧会话兼容（审核功能上线前的任务无 iterations）
          this.sessions.set(taskId, s);
        } catch {
          // 单条损坏不影响其余恢复
        }
      }
    } catch {
      // 无索引文件 = 首次启动
    }
  }

  get(taskId: string): TaskSession | undefined {
    return this.sessions.get(taskId);
  }

  list(): TaskSession[] {
    return [...this.sessions.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  create(session: TaskSession): void {
    this.sessions.set(session.taskId, session);
    this.persist(session);
  }

  /** 落盘：state.json（会话+树）+ brief 文件 + 索引。 */
  persist(session: TaskSession): void {
    const dir = sessionDir(session.workdir, session.taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(session, null, 2), 'utf8');
    writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(session.tree, null, 2), 'utf8');
    if (session.briefMd) writeFileSync(path.join(dir, 'brief.md'), session.briefMd, 'utf8');
    if (session.brief) {
      const bdir = briefsDir(session.workdir);
      mkdirSync(path.join(bdir, sanitizeTaskId(session.taskId)), { recursive: true });
      writeFileSync(path.join(bdir, sanitizeTaskId(session.taskId), 'brief.json'), JSON.stringify(session.brief, null, 2), 'utf8');
      if (session.briefMd) writeFileSync(path.join(bdir, sanitizeTaskId(session.taskId), 'brief.md'), session.briefMd, 'utf8');
    }
    // 索引
    const index: Record<string, { workdir: string; updatedAt: string }> = {};
    try {
      Object.assign(index, JSON.parse(readFileSync(this.indexPath, 'utf8')));
    } catch {
      // 忽略
    }
    index[session.taskId] = { workdir: session.workdir, updatedAt: session.updatedAt };
    mkdirSync(path.dirname(this.indexPath), { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  remove(taskId: string): void {
    this.sessions.delete(taskId);
    try {
      const index = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, unknown>;
      delete index[taskId];
      writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
    } catch {
      // 忽略
    }
  }

  /** 清理某工作目录下的 .smart2stupid 元数据（危险操作，UI 不暴露）。 */
  purgeWorkdir(workdir: string): void {
    rmSync(metaDir(workdir), { recursive: true, force: true });
  }
}
