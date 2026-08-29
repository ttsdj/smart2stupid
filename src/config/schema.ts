// 配置的 TS 类型。config/config.default.json + config/config.local.json 深合并后即 Config。

export interface ServerConfig {
  host: string;
  port: number;
  openBrowser: boolean;
  /** 允许执行的工作目录白名单；空数组 = 任意目录。 */
  allowedWorkdirs: string[];
}

export interface SmartConfig {
  provider: string;
  maxRounds: number;
  temperature: number;
  timeoutMs: number;
  /** 执行迭代轮次上限（含首轮执行）；默认 3。 */
  maxIterations?: number;
  /** 执行结束自动审核开关；缺省视为开启。 */
  review?: { enabled?: boolean };
}

export interface OpenaiCompatConfig {
  type: 'openai-compatible';
  baseURL: string;
  /** 从该环境变量读 API key；留空 = 无鉴权（本地 Ollama 等）。 */
  apiKeyEnv?: string;
  model: string;
  timeoutMs?: number;
}

export interface PlaywrightWebChatConfig {
  type: 'playwright-web-chat';
  url: string;
  headless: boolean;
  /** 持久浏览器 profile 目录（保留登录态）；null = 每次临时 profile。风险自担。 */
  profileDir: string | null;
  inputSelector?: string;
  sendSelector?: string;
  responseSelector?: string;
}

export interface MockConfig {
  type: 'mock';
  /** 按顺序消费的模拟回复；耗尽后循环最后一条。留空则每次回复固定 JSON。 */
  replies: string[];
}

/** CLI agent 当 smart 端：一问一答的无头 CLI（codex / claude -p / qwen 等）。 */
export interface CliAgentConfig {
  type: 'cli-agent';
  command: string;
  /** 命令模板，占位符 {promptArg} {model}；prompt 超 8KB 自动改 stdin 注入。 */
  args: string[];
  model: string;
  env?: Record<string, string>;
  /** spawn 工作目录；缺省 = 项目根目录。 */
  cwd?: string;
  timeoutMs?: number;
  installHint?: string;
}

export type ProviderConfig = OpenaiCompatConfig | PlaywrightWebChatConfig | MockConfig | CliAgentConfig;

export interface StupidConfig {
  executor: string;
  model: string;
  allowedTools: string;
  /** 即使在 bypassPermissions 下也强制生效的细粒度 deny 规则。 */
  disallowedTools: string[];
  autoApprove: boolean;
  budgetUsd: number;
  timeoutMs: number;
}

/** chatgpt-desktop executor 专用配置（Electron CDP 驱动）。 */
export interface ChatgptDesktopConfig {
  /** 显式 exe 路径；缺省走 installPaths/平台默认表。 */
  appPath?: string;
  installPaths?: string[];
  /** CDP 调试端口，默认 9224。 */
  port?: number;
  launchArgs?: string[];
  /** 应用已在运行时的策略：error（默认，报错提示退出）/ killAndRestart / reuse（CDP 已通时静默复用）。 */
  existingApp?: 'error' | 'killAndRestart' | 'reuse';
  /** 任务结束是否关闭 app，默认 true。 */
  closeOnFinish?: boolean;
  /** 等待调试端口就绪上限，默认 30000ms。 */
  launchTimeoutMs?: number;
  selectors?: {
    input?: string;
    send?: string;
    response?: string;
    /** 运行指示器（如停止按钮）：出现→消失 = agent 完成。 */
    runningIndicator?: string | null;
    /** 无指示器时，末条回复稳定 N 秒视为完成，默认 20。 */
    idleStableSeconds?: number;
  };
  timeoutMs?: number;
}

export interface ExecutorConfig {
  enabled: boolean;
  command: string;
  /** 命令模板。占位符 {model} {workdir} {allowedTools} {disallowedTools} {budget} {promptArg} {autoApproveFlags} {sessionArgs}；替换值为空时整项跳过。 */
  args: string[];
  /** autoApprove 开启时追加到 {autoApproveFlags} 的旗标；null = 该 agent 无需此旗标。 */
  autoApproveFlag?: string | null;
  installHint?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** 仅 chatgpt-desktop executor 使用。 */
  chatgpt?: ChatgptDesktopConfig;
}

export interface Config {
  server: ServerConfig;
  smart: SmartConfig;
  providers: Record<string, ProviderConfig>;
  stupid: StupidConfig;
  executors: Record<string, ExecutorConfig>;
}
