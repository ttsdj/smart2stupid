import type { OpenaiCompatConfig } from '../config/schema.js';
import type { ChatRequest, ProviderHealth, SmartProvider } from './types.js';

/**
 * OpenAI 兼容端点适配器：一个类覆盖 OpenAI API / OpenRouter / Ollama / vLLM 等，
 * 差异全部收敛到 config 的 baseURL / apiKeyEnv / model 三个字段。
 */
export class OpenaiCompatProvider implements SmartProvider {
  readonly id: string;
  readonly canStream = false;
  readonly modelName: string;
  private readonly cfg: OpenaiCompatConfig;

  constructor(id: string, cfg: OpenaiCompatConfig) {
    this.id = id;
    this.cfg = cfg;
    this.modelName = cfg.model;
  }

  async chat(req: ChatRequest): Promise<string> {
    const { baseURL, model, apiKeyEnv, timeoutMs } = this.cfg;
    const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKeyEnv) {
      const key = process.env[apiKeyEnv];
      if (!key) throw new Error(`环境变量 ${apiKeyEnv} 未设置（provider "${this.id}" 需要 API key）`);
      headers['Authorization'] = `Bearer ${key}`;
    }
    const body = {
      model,
      messages: req.messages,
      temperature: req.temperature,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    };
    req.onLog?.({ stream: 'cmd', text: `POST ${url}  model=${model}  messages=${req.messages.length}  temperature=${req.temperature ?? '默认'}` });
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal ?? AbortSignal.timeout(timeoutMs ?? 120_000),
    });
    req.onLog?.({ stream: 'info', text: `── HTTP ${res.status} ──` });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      req.onLog?.({ stream: 'stderr', text: `HTTP ${res.status}: ${detail}` });
      throw new Error(`provider "${this.id}" 请求失败 HTTP ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`provider "${this.id}" 返回了空回复`);
    }
    req.onLog?.({ stream: 'stdout', text: `回复 ${text.length} 字符` });
    return text;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const reply = await this.chat({
        messages: [{ role: 'user', content: 'ping，只回复 pong 一个词' }],
        temperature: 0,
        maxTokens: 8,
      });
      return { ok: true, detail: `模型 ${this.cfg.model} 响应正常: ${reply.slice(0, 40)}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
