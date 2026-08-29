import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecEvent } from '../executors/types.js';
import type { DelegationState } from './types.js';

export function metadataDir(workdir: string): string {
  return path.join(workdir, '.smart2stupid');
}

export function delegationDir(workdir: string, taskId: string): string {
  return path.join(metadataDir(workdir), 'sessions', taskId);
}

export function statePath(workdir: string, taskId: string): string {
  return path.join(delegationDir(workdir, taskId), 'delegate-state.json');
}

export function activePath(workdir: string): string {
  return path.join(metadataDir(workdir), 'active.json');
}

export function controlPath(workdir: string, taskId: string): string {
  return path.join(delegationDir(workdir, taskId), 'control.json');
}

export function eventsPath(workdir: string, taskId: string): string {
  return path.join(delegationDir(workdir, taskId), 'delegate-events.jsonl');
}

export function saveState(state: DelegationState): void {
  const dir = delegationDir(state.workdir, state.taskId);
  mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath(state.workdir, state.taskId), JSON.stringify(state, null, 2), 'utf8');
  mkdirSync(metadataDir(state.workdir), { recursive: true });
  writeFileSync(activePath(state.workdir), JSON.stringify({
    schemaVersion: 1,
    taskId: state.taskId,
    statePath: statePath(state.workdir, state.taskId),
    updatedAt: state.updatedAt,
  }, null, 2), 'utf8');
}

export function loadState(workdir: string, taskId: string): DelegationState {
  return JSON.parse(readFileSync(statePath(workdir, taskId), 'utf8')) as DelegationState;
}

export function appendEvent(workdir: string, taskId: string, iteration: number, event: ExecEvent): void {
  const file = eventsPath(workdir, taskId);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), iteration, ...event }) + '\n', 'utf8');
}

export function readControl(workdir: string, taskId: string): { stop?: boolean } {
  const file = controlPath(workdir, taskId);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { stop?: boolean };
  } catch {
    return {};
  }
}
