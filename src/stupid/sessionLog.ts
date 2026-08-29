// 执行会话日志：events.jsonl（全量事件）+ stdout.log（正文）+ 启动时从落盘重放。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sessionDir } from '../sessions/store.js';
import type { ExecEvent } from '../executors/types.js';

export class SessionLogger {
  constructor(
    private readonly workdir: string,
    private readonly taskId: string,
  ) {}

  get dir(): string {
    return sessionDir(this.workdir, this.taskId);
  }

  private eventsPath(): string {
    return path.join(this.dir, 'events.jsonl');
  }

  appendEvent(ev: ExecEvent): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n';
    appendFileSync(this.eventsPath(), line, 'utf8');
    if (ev.type === 'stdout') {
      appendFileSync(path.join(this.dir, 'stdout.log'), ev.text + '\n', 'utf8');
    }
  }

  /** 从落盘重放全部历史事件（用于客户端中途订阅）。 */
  replay(): ExecEvent[] {
    try {
      const text = readFileSync(this.eventsPath(), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            const { ts: _ts, ...ev } = JSON.parse(line) as { ts?: string } & ExecEvent;
            return ev;
          } catch {
            return null;
          }
        })
        .filter((ev): ev is ExecEvent => ev !== null);
    } catch {
      return [];
    }
  }
}
