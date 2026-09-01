// Claude Code CLI 适配器（-p 无头模式，--output-format stream-json 结构化事件流）。
// 也是 qwen 适配器的基类（二者 CLI 旗标同构）。

import { createInterface } from 'node:readline';
import type { ExecutorConfig } from '../config/schema.js';
import { spawnProcess, type SpawnResult } from '../util/spawn.js';
import { buildArgs, buildTemplateVars } from './commandBuilder.js';
import { detectBinary } from './detect.js';
import type { CommandPreview, DetectResult, ExecContext, ExecEvent, ExecRequest, ExecutorAdapter } from './types.js';

/** 解析一行 stream-json 事件为 0..n 个 ExecEvent。 */
export function parseStreamJsonLine(line: string): ExecEvent[] {
  const t = line.trim();
  if (!t) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(t);
  } catch {
    return [];
  }
  const type = obj.type;
  if (type === 'assistant') {
    const message = obj.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content)
      ? (message.content as { type: string; text?: string; name?: string; input?: unknown; partial?: boolean }[])
      : [];
    const finalTexts = blocks.filter((b) => b.type === 'text' && !b.partial && b.text);
    const partialTexts = blocks.filter((b) => b.type === 'text' && b.partial && b.text);
    const out: ExecEvent[] = [];
    // 同一条消息里 final 与 partial 并存时只用 final，避免重复回显
    for (const b of (finalTexts.length > 0 ? finalTexts : partialTexts)) {
      out.push({ type: 'stdout', text: b.text! });
    }
    for (const b of blocks) {
      if (b.type === 'tool_use') out.push({ type: 'tool_use', tool: b.name ?? 'tool', input: b.input });
    }
    return out;
  }
  if (type === 'user') {
    const message = obj.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content)
      ? (message.content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[])
      : [];
    return blocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({
        type: 'tool_result' as const,
        toolUseId: b.tool_use_id,
        content: b.content,
        isError: b.is_error,
      }));
  }
  if (type === 'stream_event') {
    const ev = obj.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } };
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      return [{ type: 'stdout', text: ev.delta.text, partial: true }];
    }
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      return [{ type: 'tool_use', tool: ev.content_block.name ?? 'tool', partial: true }];
    }
    return [];
  }
  if (type === 'tool_use') {
    return [{ type: 'tool_use', tool: (obj.name as string) ?? 'tool', input: obj.input }];
  }
  if (type === 'result') {
    const out: ExecEvent[] = [];
    if (typeof obj.result === 'string' && obj.result) out.push({ type: 'result', text: obj.result });
    const rawModelUsage = obj.modelUsage && typeof obj.modelUsage === 'object'
      ? obj.modelUsage as Record<string, Record<string, unknown>>
      : undefined;
    const numberValue = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const models = rawModelUsage
      ? Object.entries(rawModelUsage).map(([model, usage]) => ({
          model,
          inputTokens: numberValue(usage.inputTokens),
          outputTokens: numberValue(usage.outputTokens),
          cacheReadInputTokens: numberValue(usage.cacheReadInputTokens),
          cacheCreationInputTokens: numberValue(usage.cacheCreationInputTokens),
          costUsd: typeof usage.costUSD === 'number' ? usage.costUSD : undefined,
        }))
      : [];
    const rawUsage = obj.usage && typeof obj.usage === 'object'
      ? obj.usage as Record<string, unknown>
      : undefined;
    if (rawUsage || models.length > 0) {
      const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'): number =>
        models.reduce((total, usage) => total + usage[key], 0);
      const inputTokens = models.length > 0 ? sum('inputTokens') : numberValue(rawUsage?.input_tokens);
      const outputTokens = models.length > 0 ? sum('outputTokens') : numberValue(rawUsage?.output_tokens);
      const cacheReadInputTokens = models.length > 0 ? sum('cacheReadInputTokens') : numberValue(rawUsage?.cache_read_input_tokens);
      const cacheCreationInputTokens = models.length > 0 ? sum('cacheCreationInputTokens') : numberValue(rawUsage?.cache_creation_input_tokens);
      out.push({
        type: 'usage',
        usage: {
          provider: 'claude',
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
          totalTokens: inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens,
          costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
          models: models.length > 0 ? models : undefined,
        },
      });
    }
    const errors = Array.isArray(obj.errors)
      ? obj.errors.filter((error): error is string => typeof error === 'string' && error.length > 0)
      : [];
    for (const error of errors) out.push({ type: 'stderr', text: error });
    if (obj.is_error) {
      const message = errors.join('\n') || (typeof obj.result === 'string' ? obj.result : undefined);
      out.push({ type: 'status', status: 'failed', message });
    }
    return out;
  }
  if (type === 'system' && obj.subtype === 'init') {
    return [{ type: 'meta', data: { kind: 'init', model: obj.model, sessionId: obj.session_id } }];
  }
  return [];
}

export class ClaudeAdapter implements ExecutorAdapter {
  readonly id: string = 'claude';
  readonly label: string = 'Claude Code CLI';

  constructor(
    protected readonly cfg: ExecutorConfig,
    protected readonly ctx: ExecContext,
  ) {}

  detect(): Promise<DetectResult> {
    return detectBinary(this.cfg.command, this.cfg.installHint);
  }

  preview(req: ExecRequest): CommandPreview {
    const { args, useStdin } = buildArgs(this.cfg.args, this.cfg.autoApproveFlag, buildTemplateVars(req, this.ctx));
    return { command: this.cfg.command, args, useStdin };
  }

  async *run(req: ExecRequest): AsyncIterable<ExecEvent> {
    yield { type: 'status', status: 'starting' };
    const { args, useStdin } = this.preview(req);
    const p = spawnProcess({
      command: this.cfg.command,
      args,
      cwd: req.workdir,
      env: this.cfg.env,
      input: useStdin ? req.prompt : undefined,
      signal: req.signal,
    });
    yield { type: 'status', status: 'running' };

    // stderr 与 stdout 并行消费（避免管道写满卡死进程），事件经缓冲队列由主循环统一 yield
    const errLines = createInterface({ input: p.child.stderr!, crlfDelay: Infinity });
    const stderrQueue: ExecEvent[] = [];
    const errDone = (async () => {
      for await (const line of errLines) {
        if (line.trim()) stderrQueue.push({ type: 'stderr', text: line });
      }
    })();
    const drain = function* (): Generator<ExecEvent> {
      while (stderrQueue.length > 0) yield stderrQueue.shift()!;
    };
    try {
      const outLines = createInterface({ input: p.child.stdout!, crlfDelay: Infinity });
      for await (const line of outLines) {
        for (const ev of parseStreamJsonLine(line)) yield ev;
        yield* drain();
      }
    } finally {
      await errDone;
    }
    yield* drain();

    const { code, signal, spawnError } = await p.done;
    if (spawnError) {
      yield { type: 'status', status: 'failed', message: `无法启动 ${this.cfg.command}: ${spawnError}${this.cfg.installHint ? `\n安装提示: ${this.cfg.installHint}` : ''}` };
      return;
    }
    if (req.signal?.aborted) {
      yield { type: 'status', status: 'cancelled', message: '用户取消' };
      return;
    }
    if (code === 0) {
      yield { type: 'status', status: 'completed', exitCode: 0 };
    } else {
      yield { type: 'status', status: 'failed', exitCode: code ?? undefined, message: `退出码 ${code ?? signal ?? '未知'}` };
    }
  }
}
