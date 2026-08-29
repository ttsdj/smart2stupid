// 跨平台 spawn：Windows 语义的二进制解析、.cmd shim 解析、stdin 注入、进程树强杀、超时与取消。

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 解析 npm 风格的 .cmd shim：内容形如 `"%dp0%\node_modules\...\bin\x.exe" %*` 时，
 * 返回被包装的 exe 绝对路径。Node 20 直接 spawn .cmd 会 EINVAL（安全修复回归），
 * 直跑 exe 是首选方案（退出码/stdout/进程树全部干净）。
 */
export function resolveCmdShimTarget(cmdPath: string): string | null {
  try {
    const content = readFileSync(cmdPath, 'utf8');
    const m = content.match(/%dp0%\\(.+?\.exe)"?\s*%[*]/i);
    if (!m) return null;
    const target = path.join(path.dirname(cmdPath), m[1]);
    return existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

/** 供 spawnProcess 使用：.cmd/.bat → 解析 shim 指向 exe；无 shim → cmd /c call 包装。 */
export function resolveSpawnCommand(command: string): { command: string; argsPrefix: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const target = resolveCmdShimTarget(command);
    if (target) return { command: target, argsPrefix: [] };
    return { command: process.env.ComSpec ?? 'cmd.exe', argsPrefix: ['/c', 'call', command] };
  }
  return { command, argsPrefix: [] };
}

/**
 * 按 PATH + PATHEXT 解析可执行文件完整路径。
 * Node 的 spawn 不经 shell，Windows 上必须先拿到 claude.cmd / qwen.exe 这类完整路径。
 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command.includes('/') || command.includes('\\')) {
    const abs = path.resolve(command);
    return existsSync(abs) ? abs : null;
  }
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
    for (const dir of pathDirs) {
      const base = path.join(dir, command);
      for (const ext of exts) {
        const p = base + ext;
        if (existsSync(p)) return p;
      }
      if (existsSync(base)) return base;
    }
  } else {
    for (const dir of pathDirs) {
      const p = path.join(dir, command);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export interface SpawnResult {
  child: ChildProcess;
  /** 等待进程退出。 */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>;
  /** 杀整个进程树（Windows: taskkill /T /F）。 */
  killTree(): void;
}

export interface SpawnOpts {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** stdin 内容；undefined = 立即关闭 stdin。 */
  input?: string;
  signal?: AbortSignal;
  /** GUI 类进程可传 'ignore' 避免管道无人消费。 */
  stdio?: 'ignore';
}

export function spawnProcess(opts: SpawnOpts): SpawnResult {
  // env 用合并后的完整环境做二进制解析（config 里 executor.env={} 不能遮蔽 PATH）
  const env = { ...process.env, ...(opts.env ?? {}) };
  const resolved = resolveExecutable(opts.command, env) ?? opts.command;
  const { command, argsPrefix } = resolveSpawnCommand(resolved);
  const child = spawn(command, [...argsPrefix, ...opts.args], {
    cwd: opts.cwd,
    env,
    windowsHide: true,
    detached: false,
    stdio: opts.stdio === 'ignore' ? 'ignore' : ['pipe', 'pipe', 'pipe'],
  });

  if (child.stdin) {
    child.stdin.on('error', () => undefined); // EPIPE 静默
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  }

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>((resolve) => {
    child.on('error', (err) => resolve({ code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const killTree = (): void => {
    if (child.pid === undefined) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) killTree();
    else opts.signal.addEventListener('abort', killTree, { once: true });
  }

  return { child, done, killTree };
}
