export type ExecStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export type ExecEvent =
  | { type: 'status'; status: ExecStatus; exitCode?: number; message?: string }
  | { type: 'stdout'; text: string; partial?: boolean }
  | { type: 'stderr'; text: string }
  | { type: 'tool_use'; tool: string; input?: unknown; partial?: boolean }
  | { type: 'tool_result'; toolUseId?: string; content: unknown; isError?: boolean }
  | { type: 'result'; text: string }
  | { type: 'meta'; data: unknown };

export interface ExecRequest {
  /** handoff prompt（含内联 brief 全文）。 */
  prompt: string;
  workdir: string;
  model?: string;
  /** Claude Code 持久会话；首轮使用 session-id，后续使用 resume。 */
  session?: { id: string; resume?: boolean; name?: string };
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DetectResult {
  ok: boolean;
  version?: string;
  installHint?: string;
  /** 已安装时的使用提示（UI 状态区展示）。 */
  note?: string;
}

/** 从 stupid 配置合并出来的执行上下文，喂给命令模板。 */
export interface ExecContext {
  model: string;
  allowedTools: string;
  disallowedTools: string[];
  autoApprove: boolean;
  budgetUsd: number;
  timeoutMs: number;
}

export interface CommandPreview {
  command: string;
  args: string[];
  /** prompt 超长时改经 stdin 注入（args 中无 prompt）。 */
  useStdin: boolean;
}

/** stupid 端执行器统一接口。新增 CLI agent = 实现此接口 + registry 注册一行。 */
export interface ExecutorAdapter {
  readonly id: string;
  readonly label: string;
  detect(): Promise<DetectResult>;
  /** dry-run 预览将要执行的命令（UI 展示用）。 */
  preview(req: ExecRequest): CommandPreview;
  run(req: ExecRequest): AsyncIterable<ExecEvent>;
}
