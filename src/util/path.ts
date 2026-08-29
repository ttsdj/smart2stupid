// 工作目录校验：存在、是目录、可写、realpath 白名单。

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type CheckResult = { ok: true; realpath: string } | { ok: false; error: string };

export function checkWorkdir(p: string, allowed: string[]): CheckResult {
  if (!p || typeof p !== 'string') return { ok: false, error: '路径不能为空' };
  let real: string;
  try {
    real = realpathSync(path.resolve(p));
  } catch {
    return { ok: false, error: '目录不存在' };
  }
  try {
    if (!statSync(real).isDirectory()) return { ok: false, error: '不是目录' };
  } catch {
    return { ok: false, error: '目录不可访问' };
  }
  try {
    accessSync(real, constants.W_OK);
  } catch {
    return { ok: false, error: '目录不可写（.smart2stupid 元数据需要写入权限）' };
  }
  if (allowed.length > 0) {
    const allowedReal = allowed
      .map((a) => {
        try {
          return realpathSync(path.resolve(a));
        } catch {
          return null;
        }
      })
      .filter((a): a is string => a !== null);
    const inside = allowedReal.some((a) => real === a || real.startsWith(a + path.sep));
    if (!inside) return { ok: false, error: '目录不在 server.allowedWorkdirs 白名单内' };
  }
  return { ok: true, realpath: real };
}
