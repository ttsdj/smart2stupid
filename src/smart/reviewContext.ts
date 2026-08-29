// 审核材料采集：执行日志摘要 + 产物文件清单 + git diff，带预算截断。
// 零依赖（readdirSync + execFile git + readFileSync），全部 try/catch 降级，绝不抛。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ExecStatus } from '../executors/types.js';
import { sessionDir } from '../sessions/store.js';

const execFileAsync = promisify(execFile);

export interface ReviewContext {
  status: ExecStatus;
  logSummary: string;
  fileList: string;
  gitDiff?: string;
  gitInfo: string;
  /** 是否发生过截断。 */
  truncated: boolean;
}

export interface CollectOptions {
  totalBudget?: number;
  maxDepth?: number;
  maxFiles?: number;
  stdoutTailLines?: number;
}

const SKIP_DIRS = new Set(['.smart2stupid', '.git', 'node_modules']);

/** 保留头尾、中间省略的截断。 */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 20) / 2);
  const tail = max - head - 20;
  return s.slice(0, head) + '\n…(截断)…\n' + s.slice(-tail);
}

interface LogEvent {
  type: string;
  status?: string;
  text?: string;
  tool?: string;
  input?: unknown;
  message?: string;
}

/** 读 events.jsonl 解析全部事件（损坏行跳过）。 */
function readEvents(workdir: string, taskId: string): LogEvent[] {
  try {
    const text = readFileSync(path.join(sessionDir(workdir, taskId), 'events.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LogEvent;
        } catch {
          return null;
        }
      })
      .filter((ev): ev is LogEvent => ev !== null);
  } catch {
    return [];
  }
}

function summarizeLog(events: LogEvent[], stdoutTailLines: number): string {
  const lines: string[] = [];
  const stdoutLines = events.filter((e) => e.type === 'stdout').map((e) => String(e.text ?? '').slice(0, 300));
  const toolCounts = new Map<string, number>();
  const toolRecent: string[] = [];
  for (const e of events) {
    if (e.type !== 'tool_use' || !e.tool) continue;
    toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1);
    toolRecent.push(`${e.tool}: ${(JSON.stringify(e.input ?? null) ?? '').slice(0, 200)}`);
  }
  if (stdoutLines.length > 0) {
    lines.push(`stdout 尾部 ${Math.min(stdoutLines.length, stdoutTailLines)} 行：`);
    lines.push(...stdoutLines.slice(-stdoutTailLines));
  } else {
    lines.push('stdout：（无输出）');
  }
  if (toolCounts.size > 0) {
    const summary = [...toolCounts.entries()].map(([t, n]) => `${t}×${n}`).join('、');
    lines.push(`工具调用汇总：${summary}`);
    lines.push('最近工具调用：');
    lines.push(...toolRecent.slice(-10));
  }
  const lastResult = events.filter((e) => e.type === 'result' && e.text).at(-1);
  if (lastResult) lines.push(`最终结果：${String(lastResult.text).slice(0, 2000)}`);
  const lastStatus = events.filter((e) => e.type === 'status').at(-1);
  if (lastStatus) lines.push(`最后状态：${lastStatus.status ?? ''}${lastStatus.message ? `（${lastStatus.message.slice(0, 300)}）` : ''}`);
  return lines.join('\n');
}

function listFiles(workdir: string, maxDepth: number, maxFiles: number): string {
  const out: { rel: string; size: number; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(path.join(dir, ent.name), depth + 1);
        continue;
      }
      if (!ent.isFile()) continue; // 跳过 symlink 等
      const full = path.join(dir, ent.name);
      try {
        const st = statSync(full);
        out.push({ rel: path.relative(workdir, full), size: st.size, mtime: st.mtimeMs });
      } catch {
        // 文件消失等竞态，跳过
      }
    }
  };
  walk(workdir, 0);
  out.sort((a, b) => b.mtime - a.mtime); // 新产物优先
  const lines = out.map((f) => {
    const t = new Date(f.mtime).toISOString().replace('T', ' ').slice(0, 19);
    return `${f.rel}\t${f.size}B\t${t}`;
  });
  return lines.length > 0 ? lines.join('\n') : '（工作目录为空或无产物文件）';
}

async function gitInfo(workdir: string): Promise<{ gitDiff?: string; gitInfo: string }> {
  try {
    const { stdout: diffStat } = await execFileAsync('git', ['-C', workdir, 'diff', '--stat'], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
    let porcelain = '';
    try {
      const r = await execFileAsync('git', ['-C', workdir, 'status', '--porcelain', '-uall'], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
      porcelain = r.stdout;
    } catch {
      // 状态查询失败不致命
    }
    const parts: string[] = [];
    if (diffStat.trim()) parts.push(`diff --stat：\n${diffStat.trim().split('\n').slice(0, 100).join('\n')}`);
    if (porcelain.trim()) parts.push(`status --porcelain：\n${porcelain.trim().split('\n').slice(0, 100).join('\n')}`);
    if (parts.length === 0) return { gitInfo: 'git 仓库（无未提交变更）' };
    return { gitDiff: parts.join('\n\n'), gitInfo: 'git 仓库' };
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 128) return { gitInfo: '非 git 仓库' };
    return { gitInfo: '非 git 仓库（git 不可用）' };
  }
}

export async function collectReviewContext(workdir: string, taskId: string, status: ExecStatus, opts: CollectOptions = {}): Promise<ReviewContext> {
  const budget = opts.totalBudget ?? 10_000;
  const stdoutTail = opts.stdoutTailLines ?? 300;
  let truncated = false;

  const events = readEvents(workdir, taskId);
  const logSummary = summarizeLog(events, stdoutTail);
  const fileList = listFiles(workdir, opts.maxDepth ?? 3, opts.maxFiles ?? 300);
  const git = await gitInfo(workdir);

  // 子预算：log 4k / fileList 3k / gitDiff 2k / 其余 1k
  let log = logSummary;
  let files = fileList;
  let diff = git.gitDiff;
  const limit = (s: string, max: number): string => {
    if (s.length > max) {
      truncated = true;
      return truncateMiddle(s, max);
    }
    return s;
  };
  log = limit(log, 4000);
  files = limit(files, 3000);
  if (diff) diff = limit(diff, 2000);
  if (log.length + files.length + (diff?.length ?? 0) > budget) {
    truncated = true;
    log = limit(log, Math.min(log.length, 3500));
    files = limit(files, Math.min(files.length, 2500));
  }
  return { status, logSummary: log, fileList: files, gitDiff: diff, gitInfo: git.gitInfo, truncated };
}
