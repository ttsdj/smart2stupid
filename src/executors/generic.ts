// 通用适配器：纯命令模板 + stdout 文本解析。
// 任何未内建的新 CLI agent 在 config 里加一段配置即可接入（热插拔的落地点）。

import { createInterface } from 'node:readline';
import type { ExecutorConfig } from '../config/schema.js';
import { spawnProcess } from '../util/spawn.js';
import { buildArgs, buildTemplateVars } from './commandBuilder.js';
import { detectBinary } from './detect.js';
import type { CommandPreview, DetectResult, ExecContext, ExecEvent, ExecRequest, ExecutorAdapter } from './types.js';

export class GenericAdapter implements ExecutorAdapter {
  constructor(
    readonly id: string,
    readonly label: string,
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

    const outLines = createInterface({ input: p.child.stdout!, crlfDelay: Infinity });
    for await (const line of outLines) {
      if (line.trim()) yield { type: 'stdout', text: line };
    }
    const errLines = createInterface({ input: p.child.stderr!, crlfDelay: Infinity });
    for await (const line of errLines) {
      if (line.trim()) yield { type: 'stderr', text: line };
    }

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
