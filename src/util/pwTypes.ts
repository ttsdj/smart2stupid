// playwright 最小类型接口：playwright 是可选依赖（createRequire 懒加载），
// 这里只声明浏览器自动化与 CDP 适配器用到的极小子集，避免静态类型依赖。

export interface PwLocator {
  first(): PwLocator;
  last(): PwLocator;
  waitFor(opts: { state: string; timeout: number }): Promise<void>;
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  count(): Promise<number>;
  innerText(): Promise<string>;
}

export interface PwPage {
  url(): string;
  locator(selector: string): PwLocator;
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForFunction(fn: unknown, arg: unknown, opts?: { timeout: number }): Promise<unknown>;
}

export interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

export interface PwBrowser {
  contexts(): PwContext[];
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
}

export interface PwChromium {
  launch(opts: { headless: boolean }): Promise<PwBrowser>;
  launchPersistentContext(dir: string, opts: { headless: boolean }): Promise<PwContext>;
  connectOverCDP(url: string): Promise<PwBrowser>;
}

export interface PwModule {
  chromium: PwChromium;
}
