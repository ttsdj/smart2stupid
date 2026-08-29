export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** smart 端调用日志行（provider 逐行上报，UI 实时显示）。 */
export interface SmartLogLine {
  stream: 'cmd' | 'stdout' | 'stderr' | 'info';
  text: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** 实时日志回调：provider 在调用过程中逐行上报（命令/输出/错误）。 */
  onLog?: (line: SmartLogLine) => void;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

/** smart 端模型供应商统一接口。首版只要求非流式 chat。 */
export interface SmartProvider {
  readonly id: string;
  readonly canStream: boolean;
  /** 当前 provider 使用的模型名（UI 展示用）。 */
  readonly modelName: string;
  chat(req: ChatRequest): Promise<string>;
  health?(): Promise<ProviderHealth>;
}
