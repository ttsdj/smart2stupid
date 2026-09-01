import type { ExecStatus, TokenUsage } from '../executors/types.js';

export type DelegationPhase =
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'reviewed'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface DelegationIteration {
  index: number;
  status: ExecStatus | 'blocked';
  startedAt: string;
  endedAt?: string;
  handoffPath: string;
  claudeSessionId?: string;
  changesPath?: string;
  resultSummary?: string;
  executorUsage?: TokenUsage;
  review?: {
    verdict: 'pass' | 'partial' | 'fail';
    path: string;
    recordedAt: string;
  };
}

export interface DelegationState {
  schemaVersion: 1;
  taskId: string;
  workdir: string;
  title: string;
  phase: DelegationPhase;
  briefPath: string;
  claudeSessionId: string;
  /** 收到 Claude 的 init 事件后才为 true；避免恢复一个从未创建成功的 UUID。 */
  sessionEstablished?: boolean;
  model: string;
  maxIterations: number;
  extraIterations: number;
  newSessionNext: boolean;
  iterations: DelegationIteration[];
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotEntry {
  size: number;
  mtimeMs: number;
  sha256?: string;
}

export interface WorkspaceSnapshot {
  createdAt: string;
  files: Record<string, SnapshotEntry>;
}

export interface WorkspaceChanges {
  createdAt: string;
  created: string[];
  modified: string[];
  deleted: string[];
  gitStatus?: string;
  gitDiffStat?: string;
}
