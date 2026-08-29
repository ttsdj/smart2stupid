// 静态文件服务 public/：MIME 表 + 路径穿越防护。

import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function serveStatic(publicDir: string, urlPath: string, res: ServerResponse): boolean {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(publicDir, rel));
  // 防穿越：normalize 后必须仍在 publicDir 内
  if (!filePath.startsWith(path.normalize(publicDir + path.sep)) && filePath !== path.normalize(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
  return true;
}
