// public/ 目录定位：支持 tsx 直跑（src 下）与 tsc 编译产物（dist 下）两种布局。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const publicDir: string = (() => {
  // 从 src/ 运行（tsx）：../public；从 dist/ 运行：../public（dist 与 public 同层）
  const candidates = [
    path.resolve(require.main?.filename ? path.dirname(require.main.filename) : process.cwd(), '../public'),
    path.resolve(process.cwd(), 'public'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'index.html'))) return c;
  }
  return candidates[0];
})();
