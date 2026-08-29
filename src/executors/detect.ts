// 二进制探测：找得到 + --version 拿得到版本号。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveExecutable, resolveSpawnCommand } from '../util/spawn.js';
import type { DetectResult } from './types.js';

const execFileAsync = promisify(execFile);

export async function detectBinary(command: string, installHint?: string | null): Promise<DetectResult> {
  const exe = resolveExecutable(command);
  if (!exe) return { ok: false, installHint: installHint ?? undefined };
  try {
    // .cmd shim 直 spawn 会 EINVAL（Node 20 回归），经 resolveSpawnCommand 拿到真实可执行目标
    const { command: real, argsPrefix } = resolveSpawnCommand(exe);
    const { stdout } = await execFileAsync(real, [...argsPrefix, '--version'], { timeout: 15_000, windowsHide: true });
    const firstLine = stdout.trim().split('\n')[0];
    return { ok: true, version: firstLine || undefined };
  } catch {
    return { ok: true }; // 存在但 --version 拿不到（仍可尝试运行）
  }
}
