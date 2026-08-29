import { createRequire } from 'node:module';
import type { PlaywrightWebChatConfig } from '../config/schema.js';
import type { PwBrowser, PwContext, PwModule } from '../util/pwTypes.js';
import type { ChatRequest, ProviderHealth, SmartProvider } from './types.js';

const require = createRequire(import.meta.url);

/**
 * 网页版聊天自动化适配器（易碎，风险自担）：
 * - 依赖目标站点的 DOM 结构（selector 可在 config 里覆盖）；
 * - 可能违反目标站点 ToS，账号有风控风险；
 * - 默认 headless + 独立临时 profile，不携带你的登录态。
 * playwright 依赖懒加载：未启用本适配器时完全不需要安装。
 */
export class PlaywrightWebChatProvider implements SmartProvider {
  readonly id: string;
  readonly canStream = false;
  readonly modelName: string;
  private readonly cfg: PlaywrightWebChatConfig;

  constructor(id: string, cfg: PlaywrightWebChatConfig) {
    this.id = id;
    this.cfg = cfg;
    this.modelName = `web:${cfg.url.replace(/^https?:\/\//, '').split('/')[0]}`;
  }

  private loadPlaywright(): PwModule {
    try {
      return require('playwright') as PwModule;
    } catch (e) {
      throw new Error(
        `provider "${this.id}" 需要 playwright：npm i -D playwright && npx playwright install chromium（原始错误: ${(e as Error).message}）`,
      );
    }
  }

  async chat(req: ChatRequest): Promise<string> {
    const pw = this.loadPlaywright();
    const inputSelector = this.cfg.inputSelector ?? 'textarea, [contenteditable="true"]';
    const sendSelector = this.cfg.sendSelector ?? 'button[type="submit"]';
    const responseSelector = this.cfg.responseSelector ?? '[data-message-author-role="assistant"]';

    let context: PwContext;
    let browser: PwBrowser | undefined;
    if (this.cfg.profileDir) {
      context = await pw.chromium.launchPersistentContext(this.cfg.profileDir, { headless: this.cfg.headless });
    } else {
      browser = await pw.chromium.launch({ headless: this.cfg.headless });
      context = await browser.newContext();
    }

    try {
      const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
      await page.goto(this.cfg.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      const userText = req.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n\n');
      const input = page.locator(inputSelector).first();
      await input.waitFor({ state: 'visible', timeout: 30_000 });
      await input.click();
      await input.fill(userText);
      await page.locator(sendSelector).first().click();

      const responses = page.locator(responseSelector);
      const before = await responses.count();
      await page.waitForFunction(
        (arg: { sel: string; n: number }) => document.querySelectorAll(arg.sel).length > arg.n,
        { sel: responseSelector, n: before },
        { timeout: 120_000 },
      );
      const text = await responses.last().innerText();
      if (!text.trim()) throw new Error('网页回复为空（站点 DOM 可能已变化，请检查 selector 配置）');
      return text;
    } finally {
      await context.close().catch(() => undefined);
      if (browser) await browser.close?.().catch(() => undefined);
    }
  }

  async health(): Promise<ProviderHealth> {
    return {
      ok: false,
      detail: '浏览器自动化 provider 不做连通性探测（慢且易碎）；请直接创建任务验证。',
    };
  }
}
