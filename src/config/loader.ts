import { readFileSync, existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { Config } from './schema.js';

export const CONFIG_DIR = path.resolve(process.cwd(), 'config');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深合并：override 覆盖 base，对象递归合并，其余直接替换。 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  return override;
}

/** 把字符串值里的 ${VAR} 展开为环境变量。 */
function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
    return out;
  }
  return value;
}

/** 轻量手写校验：结构不合法时抛出带路径的错误。 */
export function validate(raw: unknown): Config {
  const fail = (msg: string): never => {
    throw new Error(`config 校验失败: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('顶层必须是对象');
  const c = raw as unknown as Config;

  if (!isPlainObject(c.server)) fail('server 必须是对象');
  if (typeof c.server.host !== 'string') fail('server.host 必须是字符串');
  if (typeof c.server.port !== 'number' || c.server.port < 1 || c.server.port > 65535) fail('server.port 必须是 1-65535 的整数');
  if (!Array.isArray(c.server.allowedWorkdirs)) fail('server.allowedWorkdirs 必须是数组');

  if (!isPlainObject(c.smart)) fail('smart 必须是对象');
  if (typeof c.smart.provider !== 'string') fail('smart.provider 必须是字符串');
  if (typeof c.smart.maxRounds !== 'number' || c.smart.maxRounds < 1) fail('smart.maxRounds 必须是 >=1 的整数');
  if (c.smart.maxIterations !== undefined && (typeof c.smart.maxIterations !== 'number' || c.smart.maxIterations < 1)) fail('smart.maxIterations 必须是 >=1 的整数');
  if (c.smart.review !== undefined) {
    if (!isPlainObject(c.smart.review)) fail('smart.review 必须是对象');
    if (c.smart.review.enabled !== undefined && typeof c.smart.review.enabled !== 'boolean') fail('smart.review.enabled 必须是布尔值');
  }

  if (!isPlainObject(c.providers)) fail('providers 必须是对象');
  for (const [id, p] of Object.entries(c.providers)) {
    const view = p as { type?: unknown; command?: unknown; args?: unknown; model?: unknown };
    if (!isPlainObject(p) || typeof view.type !== 'string') fail(`providers.${id}.type 必须是字符串`);
    if (view.type === 'cli-agent') {
      if (typeof view.command !== 'string') fail(`providers.${id}.command 必须是字符串`);
      if (!Array.isArray(view.args) || view.args.some((a) => typeof a !== 'string')) fail(`providers.${id}.args 必须是字符串数组`);
      if (typeof view.model !== 'string') fail(`providers.${id}.model 必须是字符串`);
    }
  }

  if (!isPlainObject(c.stupid)) fail('stupid 必须是对象');
  if (typeof c.stupid.executor !== 'string') fail('stupid.executor 必须是字符串');
  if (typeof c.stupid.model !== 'string') fail('stupid.model 必须是字符串');
  if (typeof c.stupid.allowedTools !== 'string') fail('stupid.allowedTools 必须是字符串');
  if (!Array.isArray(c.stupid.disallowedTools) || c.stupid.disallowedTools.some((rule) => typeof rule !== 'string' || !rule.trim())) {
    fail('stupid.disallowedTools 必须是非空字符串数组');
  }

  if (!isPlainObject(c.executors)) fail('executors 必须是对象');
  for (const [id, e] of Object.entries(c.executors)) {
    if (!isPlainObject(e)) fail(`executors.${id} 必须是对象`);
    // chatgpt 子配置的条目（GUI 驱动）不要求命令模板
    const hasChatgpt = isPlainObject(e.chatgpt);
    if (!hasChatgpt) {
      if (typeof e.command !== 'string') fail(`executors.${id}.command 必须是字符串`);
      if (!Array.isArray(e.args) || e.args.some((a) => typeof a !== 'string')) fail(`executors.${id}.args 必须是字符串数组`);
    }
    if (hasChatgpt) {
      const g = e.chatgpt as { port?: unknown };
      if (g.port !== undefined && (typeof g.port !== 'number' || g.port < 1 || g.port > 65535)) fail(`executors.${id}.chatgpt.port 必须是 1-65535 的整数`);
    }
  }
  return c;
}

/** 加载 default+local 两层配置并校验。 */
export function loadConfig(): Config {
  const defPath = path.join(CONFIG_DIR, 'config.default.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(defPath, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取 ${defPath}: ${(e as Error).message}`);
  }
  const localPath = path.join(CONFIG_DIR, 'config.local.json');
  if (existsSync(localPath)) {
    let local: unknown;
    try {
      local = JSON.parse(readFileSync(localPath, 'utf8'));
    } catch (e) {
      throw new Error(`无法解析 ${localPath}: ${(e as Error).message}`);
    }
    raw = deepMerge(raw, local);
  }
  return validate(expandEnv(raw));
}

/** 监听 config 目录，300ms debounce 后回调新配置；解析失败沿用旧配置。 */
export function watchConfig(onChange: (cfg: Config) => void): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  return fsWatch(CONFIG_DIR, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        onChange(loadConfig());
      } catch (e) {
        console.warn('[config] 热重载失败，沿用旧配置:', (e as Error).message);
      }
    }, 300);
  });
}
