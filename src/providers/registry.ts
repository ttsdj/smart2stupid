import type { Config, ProviderConfig } from '../config/schema.js';
import { CliAgentProvider } from './cliAgent.js';
import { MockProvider } from './mock.js';
import { OpenaiCompatProvider } from './openaiCompat.js';
import { PlaywrightWebChatProvider } from './playwrightWebChat.js';
import type { SmartProvider } from './types.js';

type ProviderCtor = new (id: string, cfg: never) => SmartProvider;

const TYPE_TO_CLASS: Record<string, ProviderCtor> = {
  'openai-compatible': OpenaiCompatProvider as ProviderCtor,
  'playwright-web-chat': PlaywrightWebChatProvider as ProviderCtor,
  'cli-agent': CliAgentProvider as ProviderCtor,
  mock: MockProvider as ProviderCtor,
};

/** smart 端 provider 注册表：由 config 驱动实例化，未知 type 警告跳过不崩溃。 */
export class ProviderRegistry {
  private providers = new Map<string, SmartProvider>();

  rebuild(cfg: Config): void {
    const next = new Map<string, SmartProvider>();
    for (const [id, pcfg] of Object.entries(cfg.providers)) {
      const Ctor = TYPE_TO_CLASS[(pcfg as ProviderConfig).type];
      if (!Ctor) {
        console.warn(`[providers] 未知 provider 类型 "${(pcfg as ProviderConfig).type}"（id=${id}），已跳过`);
        continue;
      }
      try {
        next.set(id, new Ctor(id, pcfg as never));
      } catch (e) {
        console.warn(`[providers] 初始化 "${id}" 失败，已跳过:`, (e as Error).message);
      }
    }
    this.providers = next;
  }

  get(id: string): SmartProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`provider "${id}" 不存在（可用: ${[...this.providers.keys()].join(', ') || '无'}）`);
    return p;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): { id: string; modelName: string; canStream: boolean }[] {
    return [...this.providers.values()].map((p) => ({ id: p.id, modelName: p.modelName, canStream: p.canStream }));
  }
}
