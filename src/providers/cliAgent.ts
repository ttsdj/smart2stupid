// cli-agent provider：把「能一问一答的 CLI agent」当 smart 端模型供应商。
// 一个类型覆盖 codex（ChatGPT 登录态）/ claude -p / qwen -p 等任何无头 CLI：
// spawn 命令 → stdin/argv 注入拼装好的消息 → 捕获 stdout 作为模型回复。
// 官方 CLI 登录态（如 `codex login` 走 ChatGPT 订阅），无需 API key，无 DOM 自动化。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import type { CliAgentConfig } from '../config/schema.js';
import { resolveExecutable, resolveSpawnCommand, spawnProcess } from '../util/spawn.js';
import type { ChatRequest, ProviderHealth, SmartLogLine, SmartProvider } from './types.js';

const execFileAsync = promisify(execFile);

const PROMPT_ARG_LIMIT = 8000;

/** 拼装 CLI agent 的输入：system 消息前置为「系统指令」，user 消息正文在后。 */
export function buildCliPrompt(messages: { role: string; content: string }[]): string {
  const systems = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const parts: string[] = [];
  if (systems.length > 0) {
    parts.push('以下是系统指令，必须严格遵守：', '---', ...systems, '---');
  }
  parts.push(...users);
  return parts.join('\n\n');
}

/** 命令模板占位符替换（仅 {promptArg} {model}，值为空整项跳过）。 */
function buildArgs(template: string[], vars: { prompt: string; model: string }): { args: string[]; useStdin: boolean } {
  // 多行或超长 prompt 一律走 stdin：Windows 下换行符在 argv 里会被 .cmd 转发截断
  const useStdin = vars.prompt.includes('\n') || vars.prompt.length > PROMPT_ARG_LIMIT;
  const promptArg = useStdin ? null : vars.prompt;
  const args: string[] = [];
  for (const t of template) {
    if (t === '{promptArg}') {
      if (promptArg !== null) args.push(promptArg);
    } else if (t === '{model}') {
      args.push(vars.model);
    } else {
      args.push(t);
    }
  }
  return { args, useStdin };
}

export class CliAgentProvider implements SmartProvider {
  readonly id: string;
  readonly canStream = false;
  readonly modelName: string;
  private readonly cfg: CliAgentConfig;

  constructor(id: string, cfg: CliAgentConfig) {
    this.id = id;
    this.cfg = cfg;
    this.modelName = cfg.model;
  }

  async chat(req: ChatRequest): Promise<string> {
    const promptText = buildCliPrompt(req.messages);
    const { args, useStdin } = buildArgs(this.cfg.args, { prompt: promptText, model: this.cfg.model });
    const log = (stream: SmartLogLine['stream'], text: string) => req.onLog?.({ stream, text });
    const cmdLine = [this.cfg.command, ...args]
      .map((a) => (/\s/.test(a) ? `"${a.slice(0, 120)}${a.length > 120 ? '…' : ''}"` : a))
      .join(' ');
    log('cmd', `${cmdLine}${useStdin ? '（prompt 经 stdin 注入）' : ''}`);
    const timeoutMs = this.cfg.timeoutMs ?? 300_000;
    const p = spawnProcess({
      command: this.cfg.command,
      args,
      cwd: this.cfg.cwd,
      env: this.cfg.env,
      input: useStdin ? promptText : undefined,
      signal: req.signal ?? AbortSignal.timeout(timeoutMs),
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const outLines = createInterface({ input: p.child.stdout!, crlfDelay: Infinity });
    const errLines = createInterface({ input: p.child.stderr!, crlfDelay: Infinity });
    const errDone = (async () => {
      for await (const line of errLines) {
        stderrChunks.push(line);
        if (line.trim()) log('stderr', line);
      }
    })();
    for await (const line of outLines) {
      stdoutChunks.push(line);
      if (line.trim()) log('stdout', line);
    }
    await errDone;

    const { code, signal, spawnError } = await p.done;
    log('info', `── 进程退出 code=${code ?? signal ?? '?'} ──`);
    const stdout = stdoutChunks.join('\n');
    if (spawnError) {
      throw new Error(
        `provider "${this.id}" 无法启动 ${this.cfg.command}: ${spawnError}${this.cfg.installHint ? `\n安装提示: ${this.cfg.installHint}` : ''}`,
      );
    }
    if (code !== 0) {
      const errTail = stderrChunks.join('\n').trim().slice(-500);
      throw new Error(`provider "${this.id}" 退出码 ${code ?? signal}${errTail ? `：${errTail}` : ''}`);
    }
    const text = stdout.trim();
    if (!text) throw new Error(`provider "${this.id}" 返回了空回复`);
    return text;
  }

  async health(): Promise<ProviderHealth> {
    const exe = resolveExecutable(this.cfg.command);
    if (!exe) {
      return { ok: false, detail: `${this.cfg.command} 未安装${this.cfg.installHint ? `。安装提示: ${this.cfg.installHint}` : ''}` };
    }
    try {
      const { command, argsPrefix } = resolveSpawnCommand(exe);
      const { stdout } = await execFileAsync(command, [...argsPrefix, '--version'], { timeout: 15_000, windowsHide: true, env: { ...process.env, ...(this.cfg.env ?? {}) } });
      const firstLine = stdout.trim().split('\n')[0];
      return { ok: true, detail: `已安装（${firstLine || '版本未知'}）· 模型 ${this.cfg.model} · 登录态请自行确认（如 codex login）` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
