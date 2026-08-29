// SSE 连接管理：每个 taskId 一组订阅者，广播 + 30s 心跳 + 关闭清理。

import type { ServerResponse } from 'node:http';

const HEARTBEAT_MS = 30_000;

export class SseHub {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();

  subscribe(taskId: string, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    let set = this.subscribers.get(taskId);
    if (!set) {
      set = new Set<ServerResponse>();
      this.subscribers.set(taskId, set);
      const timer = setInterval(() => {
        const s = this.subscribers.get(taskId);
        if (!s || s.size === 0) {
          clearInterval(timer);
          this.heartbeats.delete(taskId);
          return;
        }
        for (const r of s) r.write(': ping\n\n');
      }, HEARTBEAT_MS);
      this.heartbeats.set(taskId, timer);
    }
    set.add(res);
    res.on('close', () => {
      const s = this.subscribers.get(taskId);
      if (!s) return;
      s.delete(res);
      if (s.size === 0) {
        this.subscribers.delete(taskId);
        const t = this.heartbeats.get(taskId);
        if (t) {
          clearInterval(t);
          this.heartbeats.delete(taskId);
        }
      }
    });
  }

  /** 广播事件（执行事件 / smart 日志事件等任意可 JSON 序列化的对象）。 */
  broadcast(taskId: string, ev: unknown): void {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.subscribers.get(taskId) ?? []) {
      res.write(data);
    }
  }

  /** 主动结束某任务的全部连接。 */
  close(taskId: string): void {
    for (const res of this.subscribers.get(taskId) ?? []) res.end();
    this.subscribers.delete(taskId);
    const t = this.heartbeats.get(taskId);
    if (t) {
      clearInterval(t);
      this.heartbeats.delete(taskId);
    }
  }
}
