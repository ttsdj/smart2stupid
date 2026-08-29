// smart2stupid 命令行入口：全自动 agent 对 agent 闭环，无 web UI。
// 用法：
//   npm run auto -- --prompt "帮我做X" --workdir D:\path [--smart claude-cli] [--stupid codex] [--model ...] [--max-iterations 3]
//   或直接： npm run auto -- "帮我做X" --workdir D:\path

import { loadConfig } from './config/loader.js';
import { ExecutorRegistry } from './executors/registry.js';
import type { ExecEvent } from './executors/types.js';
import { ProviderRegistry } from './providers/registry.js';
import { SessionStore } from './sessions/store.js';
import { SmartOrchestrator, type SmartLogEvent } from './smart/orchestrator.js';
import { StupidOrchestrator } from './stupid/orchestrator.js';
import { SseHub } from './server/sse.js';
import { runAuto } from './auto.js';

function parseArgs(argv: string[]): { prompt: string; workdir: string; opts: Record<string, string | undefined> } {
  const opts: Record<string, string | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i += 1;
      } else {
        opts[key] = 'true';
      }
    } else {
      positionals.push(a);
    }
  }
  return { prompt: opts.prompt ?? positionals[0] ?? '', workdir: opts.workdir ?? '', opts };
}

const PHASE_LABEL: Record<string, string> = { build_tree: '建树', evolve: '追问演进', brief: '生成brief', review: '审核', fix: '修正' };

function printSmartLog(ev: SmartLogEvent): void {
  const ts = ev.ts.slice(11, 19);
  const phase = PHASE_LABEL[ev.phase] ?? ev.phase;
  const prefix = { cmd: '  $', stdout: '    ', stderr: '  ✗', info: '  ·' }[ev.stream] ?? '  ·';
  const lines = ev.text.split('\n');
  for (const line of lines) {
    if (line.trim()) console.log(`[smart|${phase}|${ts}]${prefix} ${line}`);
  }
}

function printExecEvent(taskId: string, ev: ExecEvent): void {
  if (ev.type === 'status') {
    const label = { starting: '启动', running: '运行中', completed: '完成', failed: '失败', cancelled: '取消', timeout: '超时' }[ev.status] ?? ev.status;
    console.log(`[stupid|${label}]${ev.message ? ' ' + ev.message : ''}${ev.exitCode !== undefined ? ` (exit ${ev.exitCode})` : ''}`);
  } else if (ev.type === 'stdout') {
    const lines = String(ev.text).split('\n');
    for (const l of lines) if (l.trim()) console.log(`[stupid|out] ${l}`);
  } else if (ev.type === 'stderr') {
    console.log(`[stupid|err] ${ev.text}`);
  } else if (ev.type === 'tool_use') {
    console.log(`[stupid|tool] ${ev.tool}`);
  } else if (ev.type === 'tool_result') {
    console.log(`[stupid|tool-result] ${typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content)}`);
  } else if (ev.type === 'result') {
    console.log(`[stupid|result] ${String(ev.text).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const { prompt, workdir, opts } = parseArgs(process.argv.slice(2));
  if (!prompt) {
    console.error('用法：npm run auto -- --prompt "任务描述" --workdir D:\\path [--smart claude-cli] [--stupid codex] [--max-iterations 3]');
    process.exit(2);
  }
  if (!workdir) {
    console.error('缺少 --workdir（执行 agent 的工作目录）');
    process.exit(2);
  }

  const cfg = loadConfig();
  const store = new SessionStore(process.cwd());
  store.restore();
  const sse = new SseHub(); // CLI 模式无订阅者，仅满足构造参数
  const providers = new ProviderRegistry();
  const executors = new ExecutorRegistry();
  providers.rebuild(cfg);
  executors.rebuild(cfg);

  const smart = new SmartOrchestrator(store, providers, cfg, (_taskId, ev) => printSmartLog(ev));
  const stupid = new StupidOrchestrator(store, executors, sse, cfg);
  stupid.onExecEvent = (_taskId, ev) => printExecEvent(_taskId, ev);

  const summary = await runAuto(
    {
      prompt,
      workdir,
      providerId: opts.smart,
      executorId: opts.stupid,
      model: opts.model,
      maxIterations: opts['max-iterations'] ? Number(opts['max-iterations']) : undefined,
    },
    { smart, stupid, store, cfg },
  );

  process.exit(summary.success ? 0 : 1);
}

main().catch((e) => {
  console.error('[auto] 失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
