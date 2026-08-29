// smart2stupid 入口：加载配置 → 建注册表 → 恢复会话 → 起 HTTP → 打开浏览器。

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, watchConfig } from './config/loader.js';
import { ExecutorRegistry } from './executors/registry.js';
import { ProviderRegistry } from './providers/registry.js';
import { createHttpServer } from './server/httpServer.js';
import { SseHub } from './server/sse.js';
import { SessionStore } from './sessions/store.js';
import { SmartOrchestrator } from './smart/orchestrator.js';
import { StupidOrchestrator } from './stupid/orchestrator.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const configRef = { value: cfg };
  const token = randomBytes(24).toString('hex');

  const sse = new SseHub();
  const store = new SessionStore(process.cwd());
  store.restore();
  const providers = new ProviderRegistry();
  const executors = new ExecutorRegistry();
  providers.rebuild(cfg);
  executors.rebuild(cfg);

  const smart = new SmartOrchestrator(store, providers, configRef.value, (taskId, ev) => {
    sse.broadcast(`smart:${taskId}`, { type: 'smart_log', ...ev });
  });
  const stupid = new StupidOrchestrator(store, executors, sse, configRef.value);
  // 执行结束 → 自动审核（异步，不阻塞执行流收尾）
  stupid.onRunFinished = ({ taskId }) => {
    void smart.reviewCurrentIteration(taskId).catch((e) => console.error('[smart] 审核异常:', e));
  };

  const { listen, close } = await createHttpServer({
    configRef,
    providers,
    executors,
    smart,
    stupid,
    store,
    sse,
    token,
  });

  const { host, port } = await listen().catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(`[main] 端口 ${cfg.server.port} 已被占用（可能有残留的 smart2stupid 进程）。\n        释放端口后重试，或改 config/server.port。`);
      process.exit(1);
    }
    throw e;
  });
  const baseUrl = `http://${host}:${port}/?token=${token}`;
  console.log('======================================================');
  console.log('  smart2stupid 已启动');
  console.log(`  访问地址: ${baseUrl}`);
  console.log(`  smart 默认 provider: ${cfg.smart.provider}（${providers.get(cfg.smart.provider)?.modelName ?? '?'}）`);
  console.log(`  stupid 默认 executor: ${cfg.stupid.executor}（模型 ${cfg.stupid.model}）`);
  console.log('  工作目录元数据写入目标目录下的 .smart2stupid/');
  console.log('======================================================');

  // M6: 配置热重载——正在运行的任务持旧实例引用，新任务用新实例
  watchConfig((newCfg) => {
    console.log('[config] 检测到配置变化，热重载中...');
    configRef.value = newCfg;
    providers.rebuild(newCfg);
    executors.rebuild(newCfg);
  });

  if (cfg.server.openBrowser) {
    spawn('cmd', ['/c', 'start', '', baseUrl], { windowsHide: true, stdio: 'ignore' });
  }

  const shutdown = (): void => {
    console.log('\n正在关闭...');
    close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[main] 启动失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
