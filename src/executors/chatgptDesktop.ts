// ChatGPT 桌面版适配器（Electron CDP + Playwright，易碎，风险自担）：
// 以 --remote-debugging-port 启动桌面 app → connectOverCDP 驱动内置 Chromium →
// 定位 composer 输入 brief → 发送 → 轮询完成信号 → 提取回复。
// 全部 selector 配置化抗 DOM 漂移；connectOverCDP 直连内置 Chromium，无需 install chromium。

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ExecutorConfig } from '../config/schema.js';
import { spawnProcess, type SpawnResult } from '../util/spawn.js';
import type { PwBrowser, PwModule, PwPage } from '../util/pwTypes.js';
import type { CommandPreview, DetectResult, ExecContext, ExecEvent, ExecRequest, ExecutorAdapter } from './types.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const DEFAULT_INSTALL_HINT = 'winget install --id 9PLM9XGG6VKS -s msstore';
const DEFAULT_PORT = 9224;
const CFG_BASE = 'config.executors.chatgpt-desktop.chatgpt';

const DEFAULT_SELECTORS = {
  input: "div[contenteditable='true'], #prompt-textarea, textarea",
  send: "button[data-testid='send-button'], button[aria-label*='Send']",
  response: "[data-message-author-role='assistant']",
  runningIndicator: "button[data-testid='stop-button'], button[aria-label*='Stop']",
  idleStableSeconds: 20,
};

/** 展开 %VAR% 环境变量（Windows 风格）。 */
function expandEnvVars(p: string): string {
  return p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => process.env[name] ?? '');
}

function defaultInstallPaths(): string[] {
  if (process.platform === 'win32') {
    return [
      '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\chatgpt.exe', // MSIX 执行别名
      '%LOCALAPPDATA%\\Programs\\ChatGPT\\ChatGPT.exe',
      'C:\\Program Files\\ChatGPT\\ChatGPT.exe',
      'C:\\Program Files\\WindowsApps\\ChatGPT\\ChatGPT.exe',
    ];
  }
  return ['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'];
}

/** 探测 app 进程是否在运行。 */
async function isAppRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH'], { timeout: 10_000, windowsHide: true });
      return stdout.toLowerCase().includes('chatgpt.exe');
    }
    const { stdout } = await execFileAsync('pgrep', ['-f', 'ChatGPT'], { timeout: 10_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** CDP 端点是否已就绪。 */
async function cdpReady(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export class ChatGPTDesktopAdapter implements ExecutorAdapter {
  readonly id = 'chatgpt-desktop';
  readonly label = 'ChatGPT 桌面版 (CDP)';

  constructor(
    private readonly cfg: ExecutorConfig,
    private readonly ctx: ExecContext,
  ) {}

  private get c() {
    return this.cfg.chatgpt ?? {};
  }

  private get port() {
    return this.c.port ?? DEFAULT_PORT;
  }

  private findAppPath(): string | null {
    const candidates = [
      ...(this.c.appPath ? [this.c.appPath] : []),
      ...(this.c.installPaths ?? []),
      ...defaultInstallPaths(),
    ];
    for (const p of candidates) {
      const full = expandEnvVars(p);
      if (full && existsSync(full)) return full;
    }
    return null;
  }

  async detect(): Promise<DetectResult> {
    const appPath = this.findAppPath();
    if (!appPath) {
      return { ok: false, installHint: this.cfg.installHint ?? DEFAULT_INSTALL_HINT };
    }
    return {
      ok: true,
      note: '使用前请先在应用内打开目标项目文件夹（适配器无法代为切换）；执行时应用会以调试端口重启。',
    };
  }

  preview(req: ExecRequest): CommandPreview {
    return {
      command: this.findAppPath() ?? 'chatgpt',
      args: [`--remote-debugging-port=${this.port}`, ...(this.c.launchArgs ?? [])],
      useStdin: false,
    };
  }

  private loadPlaywright(): PwModule {
    try {
      return require('playwright') as PwModule;
    } catch (e) {
      throw new Error(
        `executor "${this.id}" 需要 playwright：npm i -D playwright（connectOverCDP 直连 app 内置 Chromium，无需 npx playwright install chromium）。原始错误: ${(e as Error).message}`,
      );
    }
  }

  private fail(msg: string): { type: 'status'; status: 'failed'; message: string } {
    return { type: 'status', status: 'failed', message: msg };
  }

  async *run(req: ExecRequest): AsyncIterable<ExecEvent> {
    yield { type: 'status', status: 'starting' };
    const sel = { ...DEFAULT_SELECTORS, ...(this.c.selectors ?? {}) };
    const appPath = this.findAppPath();
    if (!appPath) {
      yield this.fail(
        `未找到 ChatGPT 桌面版。请先安装：${this.cfg.installHint ?? DEFAULT_INSTALL_HINT}（或配置 ${CFG_BASE}.appPath 指向实际 exe）`,
      );
      return;
    }

    let spawned: SpawnResult | undefined;
    let spawnedByUs = false;
    let browser: PwBrowser | undefined;
    const cleanup = (): void => {
      if (spawnedByUs && spawned && this.c.closeOnFinish !== false) spawned.killTree();
    };
    const onAbort = (): void => cleanup();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // 1. 已运行探测：CDP 已通 → 直接复用；进程在但 CDP 不通 → 按策略处理
      if (await cdpReady(this.port)) {
        yield { type: 'meta', data: { kind: 'chatgpt', stage: 'cdp-reuse', port: this.port } };
      } else if (await isAppRunning()) {
        const strategy = this.c.existingApp ?? 'error';
        if (strategy === 'killAndRestart') {
          yield { type: 'meta', data: { kind: 'chatgpt', stage: 'killing-existing' } };
          if (process.platform === 'win32') {
            await execFileAsync('taskkill', ['/IM', 'ChatGPT.exe', '/F'], { timeout: 15_000, windowsHide: true }).catch(() => undefined);
          } else {
            await execFileAsync('pkill', ['-f', 'ChatGPT'], { timeout: 15_000 }).catch(() => undefined);
          }
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          yield this.fail(
            `ChatGPT 桌面版已在运行且未开启调试端口。请退出应用后重试，或将 ${CFG_BASE}.existingApp 设为 "killAndRestart"。`,
          );
          return;
        }
      }

      // 2. 启动（带调试端口）
      if (!(await cdpReady(this.port))) {
        yield { type: 'meta', data: { kind: 'chatgpt', stage: 'launching', port: this.port } };
        spawned = spawnProcess({
          command: appPath,
          args: [`--remote-debugging-port=${this.port}`, ...(this.c.launchArgs ?? [])],
          stdio: 'ignore',
          env: this.cfg.env,
        });
        spawnedByUs = true;
      }

      // 3. 就绪轮询
      const launchTimeoutMs = this.c.launchTimeoutMs ?? 30_000;
      const deadline = Date.now() + launchTimeoutMs;
      while (!(await cdpReady(this.port))) {
        if (req.signal?.aborted) {
          cleanup();
          yield { type: 'status', status: 'cancelled', message: '用户取消' };
          return;
        }
        if (Date.now() > deadline) {
          cleanup();
          yield this.fail(`等待调试端口超时（127.0.0.1:${this.port}）：应用未按预期启动，请检查 ${CFG_BASE}.port 与 ${CFG_BASE}.launchArgs`);
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // 4. connectOverCDP
      const pw = this.loadPlaywright();
      browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
      yield { type: 'meta', data: { kind: 'chatgpt', stage: 'cdp-connected' } };
      const pages = browser.contexts().flatMap((c) => c.pages());
      const page: PwPage | undefined =
        pages.find((p) => {
          const u = p.url().toLowerCase();
          return u.includes('chatgpt') || u.includes('codex');
        }) ?? pages[0];
      if (!page) {
        cleanup();
        yield this.fail('未找到可用的页面窗口（应用可能没有打开任何窗口）');
        return;
      }

      // 5. 定位 composer
      let input;
      try {
        input = page.locator(sel.input!).first();
        await input.waitFor({ state: 'visible', timeout: 30_000 });
      } catch {
        cleanup();
        yield this.fail(`未找到输入框（selector: ${sel.input}）：DOM 可能已更新，请检查 ${CFG_BASE}.selectors.input`);
        return;
      }
      yield { type: 'meta', data: { kind: 'chatgpt', stage: 'composer-found' } };

      // 6. 输入并发送
      const prompt = `工作目录声明：${req.workdir}。若当前应用打开的工程不是该目录，请停止并在应用中切换后重试（或由用户确认继续）。\n\n${req.prompt}`;
      if (prompt.length > 30_000) {
        yield { type: 'meta', data: { kind: 'chatgpt', stage: 'warn', message: 'prompt 超过 30k 字符，contenteditable 输入可能变慢' } };
      }
      await input.fill(prompt);
      await page.locator(sel.send!).first().click();
      yield { type: 'status', status: 'running' };
      yield { type: 'meta', data: { kind: 'chatgpt', stage: 'prompt-sent', chars: prompt.length } };

      // 7. 完成检测：runningIndicator 出现→消失；否则回复 stable N 秒
      const overallTimeout = this.ctx.timeoutMs;
      const startAt = Date.now();
      const responses = page.locator(sel.response!);
      let sawRunning = false;
      let lastText = '';
      let stableSince = 0;
      const idleStableMs = (sel.idleStableSeconds ?? 20) * 1000;
      while (true) {
        if (req.signal?.aborted) {
          cleanup();
          yield { type: 'status', status: 'cancelled', message: '用户取消' };
          return;
        }
        if (Date.now() - startAt > overallTimeout) {
          cleanup();
          yield this.fail(`等待 agent 回复超时（${overallTimeout}ms）：请检查 ${CFG_BASE}.selectors.runningIndicator 或调大 timeoutMs`);
          return;
        }
        let indicatorCount = 0;
        try {
          indicatorCount = sel.runningIndicator ? await page.locator(sel.runningIndicator).count() : 0;
        } catch {
          // selector 失效时忽略 indicator 检测
        }
        if (indicatorCount > 0) sawRunning = true;
        const count = await responses.count().catch(() => 0);
        let currentText = '';
        if (count > 0) {
          currentText = (await responses.last().innerText().catch(() => '')) ?? '';
        }
        if (sawRunning && indicatorCount === 0 && count > 0) break; // 运行过且已停止
        if (currentText && currentText === lastText) {
          if (stableSince === 0) stableSince = Date.now();
          if (Date.now() - stableSince >= idleStableMs) break; // 稳定 N 秒
        } else {
          stableSince = 0;
          lastText = currentText;
        }
        if (count === 0 && Date.now() - startAt > 5 * 60_000) {
          cleanup();
          yield this.fail(`未检测到任何回复（5 分钟）：请检查 ${CFG_BASE}.selectors.response`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      // 8. 提取回复
      const reply = await responses.last().innerText().catch(() => '');
      if (!reply?.trim()) {
        cleanup();
        yield this.fail('回复提取为空（站点 DOM 可能已变化，请检查 selector 配置）');
        return;
      }
      yield { type: 'stdout', text: reply };
      yield { type: 'result', text: reply };
      yield { type: 'status', status: 'completed', exitCode: 0 };
    } catch (e) {
      cleanup();
      yield this.fail(`chatgpt-desktop 驱动异常: ${(e as Error).message}`);
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      try {
        await browser?.close().catch(() => undefined); // 断开 CDP（不关 app）
      } catch {
        // 忽略
      }
      cleanup();
    }
  }
}
