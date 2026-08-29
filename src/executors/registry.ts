// executor 注册表：config 驱动实例化。claude/codex/qwen 有专类，
// 其他任何条目自动走 GenericAdapter（纯命令模板）——新 agent 加配置即接入。

import type { Config, ExecutorConfig } from '../config/schema.js';
import { ChatGPTDesktopAdapter } from './chatgptDesktop.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GenericAdapter } from './generic.js';
import { QwenAdapter } from './qwen.js';
import type { DetectResult, ExecContext, ExecutorAdapter } from './types.js';

const BUILTIN: Record<string, new (cfg: ExecutorConfig, ctx: ExecContext) => ExecutorAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  qwen: QwenAdapter,
  'chatgpt-desktop': ChatGPTDesktopAdapter,
};

export class ExecutorRegistry {
  private adapters = new Map<string, ExecutorAdapter>();

  rebuild(cfg: Config): void {
    const ctx: ExecContext = {
      model: cfg.stupid.model,
      allowedTools: cfg.stupid.allowedTools,
      disallowedTools: cfg.stupid.disallowedTools,
      autoApprove: cfg.stupid.autoApprove,
      budgetUsd: cfg.stupid.budgetUsd,
      timeoutMs: cfg.stupid.timeoutMs,
    };
    const next = new Map<string, ExecutorAdapter>();
    for (const [id, ecfg] of Object.entries(cfg.executors)) {
      if (ecfg.enabled === false) continue;
      const Ctor = BUILTIN[id];
      try {
        next.set(
          id,
          Ctor ? new Ctor(ecfg, ctx) : new GenericAdapter(id, `CLI: ${ecfg.command}`, ecfg, ctx),
        );
      } catch (e) {
        console.warn(`[executors] 初始化 "${id}" 失败，已跳过:`, (e as Error).message);
      }
    }
    this.adapters = next;
  }

  get(id: string): ExecutorAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`executor "${id}" 不存在（可用: ${[...this.adapters.keys()].join(', ') || '无'}）`);
    return a;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): { id: string; label: string }[] {
    return [...this.adapters.values()].map((a) => ({ id: a.id, label: a.label }));
  }

  /** 并发探测全部 executor，返回 UI 展示用的状态。 */
  async detectAll(): Promise<{ id: string; label: string; detected: DetectResult }[]> {
    return Promise.all(
      [...this.adapters.values()].map(async (a) => ({ id: a.id, label: a.label, detected: await a.detect() })),
    );
  }
}
