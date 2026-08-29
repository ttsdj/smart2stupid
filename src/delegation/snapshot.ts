import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SnapshotEntry, WorkspaceChanges, WorkspaceSnapshot } from './types.js';

const EXCLUDED_DIRS = new Set([
  '.git', '.smart2stupid', 'node_modules', 'dist', 'out', 'build', 'target', '.next', '.venv', 'venv', '__pycache__',
]);
const HASH_LIMIT = 20 * 1024 * 1024;

function walk(root: string, current: string, out: Record<string, SnapshotEntry>): void {
  let names: string[];
  try {
    names = readdirSync(current);
  } catch {
    return;
  }
  for (const name of names) {
    if (EXCLUDED_DIRS.has(name)) continue;
    const absolute = path.join(current, name);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(root, absolute, out);
      continue;
    }
    if (!stat.isFile()) continue;
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const entry: SnapshotEntry = { size: stat.size, mtimeMs: stat.mtimeMs };
    if (stat.size <= HASH_LIMIT) {
      try {
        entry.sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      } catch {
        // 文件可能在扫描时被另一个进程替换；mtime/size 仍可作为退化基线。
      }
    }
    out[relative] = entry;
  }
}

export function captureSnapshot(workdir: string): WorkspaceSnapshot {
  const files: Record<string, SnapshotEntry> = {};
  walk(workdir, workdir, files);
  return { createdAt: new Date().toISOString(), files };
}

function changed(a: SnapshotEntry, b: SnapshotEntry): boolean {
  if (a.sha256 && b.sha256) return a.sha256 !== b.sha256;
  return a.size !== b.size || a.mtimeMs !== b.mtimeMs;
}

function gitOutput(workdir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: workdir, encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim() || undefined;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === 'string' && stdout.trim() ? stdout.trim() : undefined;
  }
}

export function compareSnapshots(workdir: string, before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChanges {
  const beforeNames = new Set(Object.keys(before.files));
  const afterNames = new Set(Object.keys(after.files));
  const created = [...afterNames].filter((name) => !beforeNames.has(name)).sort();
  const deleted = [...beforeNames].filter((name) => !afterNames.has(name)).sort();
  const modified = [...afterNames]
    .filter((name) => beforeNames.has(name) && changed(before.files[name], after.files[name]))
    .sort();
  return {
    createdAt: new Date().toISOString(),
    created,
    modified,
    deleted,
    gitStatus: gitOutput(workdir, ['status', '--short']),
    gitDiffStat: gitOutput(workdir, ['diff', '--stat']),
  };
}
