// Codex CLI 适配器（codex exec --json → JSONL 事件流）。
// 已查证：--json 输出 JSONL（turn_update / agent_message 等 method），
// --full-auto = 永不弹审批 + workspace-write 沙箱的官方快捷组合。

import { createInterface } from 'node:readline';
import type { ExecutorConfig } from '../config/schema.js';
import { spawnProcess } from '../util/spawn.js';
import { buildArgs, buildTemplateVars } from './commandBuilder.js';
import { detectBinary } from './detect.js';
import type { CommandPreview, DetectResult, ExecContext, ExecEvent, ExecRequest, ExecutorAdapter } from './types.js';

/** 解析一行 codex JSONL 事件为 0..n 个 ExecEvent（防御式：形状漂移时不崩溃）。 */
export function parseCodexJsonlLine(line: string): ExecEvent[] {
  const t = line.trim();
  if (!t) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(t);
  } catch {
    return [{ type: 'stdout', text: line }]; // 非 JSON 行按纯文本回显
  }
  const method = obj.method;
  const params = (obj.params ?? {}) as Record<string, unknown>;
  if (method === 'agent_message' && typeof params.delta === 'string' && params.delta) {
    return [{ type: 'stdout', text: params.delta }];
  }
  if (method === 'turn_update' && typeof params.status === 'string') {
    const status = params.status.toLowerCase();
    if (status.includes('complete') || status === 'success') {
      return [{ type: 'status', status: 'completed' }];
    }
    if (status.includes('error') || status.includes('fail')) {
      return [{ type: 'status', status: 'failed', message: String(params.status) }];
    }
    if (status.includes('abort') || status.includes('cancel')) {
      return [{ type: 'status', status: 'cancelled', message: String(params.status) }];
    }
    return [{ type: 'meta', data: { kind: 'turn_update', status: params.status, id: params.id } }];
  }
  // 工具调用可能出现在多种字段名下，防御式提取
  const toolInput = obj.tool_input ?? obj.toolInput ?? params.input;
  const toolName = obj.tool ?? obj.tool_name ?? obj.toolName ?? params.name ?? params.tool;
  if (typeof toolName === 'string' && toolName) {
    return [{ type: 'tool_use', tool: toolName, input: toolInput }];
  }
  return [{ type: 'meta', data: obj }];
}

export class CodexAdapter implements ExecutorAdapter {
  readonly id = 'codex';
  readonly label = 'Codex CLI';

  constructor(
    private readonly cfg: ExecutorConfig,
    private readonly ctx: ExecContext,
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
        for (const ev of parseCodexJsonlLine(line)) yield ev;
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
