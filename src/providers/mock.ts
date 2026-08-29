import type { MockConfig } from '../config/schema.js';
import type { ChatRequest, ProviderHealth, SmartProvider } from './types.js';

const DEFAULT_TREE_REPLY = JSON.stringify({
  nodes: [
    {
      id: 'q1',
      question: '这个任务最终想要达到的目标是什么？请描述成功后的样子。',
      recommended: '一个能跑的最小可用版本，先证明可行性',
      dependsOn: [],
    },
    {
      id: 'q2',
      question: '有哪些硬性约束？（技术栈、平台、时间、范围边界）没有的话答「无」即可。',
      recommended: '无硬性约束',
      dependsOn: [],
    },
    {
      id: 'q3',
      question: '怎样算完成？请给出 2-3 条可验证的验收标准。',
      recommended: '核心流程能跑通，且有基本测试',
      dependsOn: ['q1'],
    },
  ],
});

const DEFAULT_EVOLVE_REPLY = JSON.stringify({ add: [], remove: [], update: [] });

const DEFAULT_REVIEW_REPLY = JSON.stringify({
  verdict: 'partial',
  items: [
    { criterion: 'todo.txt 文件存在', status: 'pass', evidence: '产物文件清单中存在 todo.txt', issue: '' },
    { criterion: 'todo.txt 内容包含「已完成」', status: 'unknown', evidence: '日志摘要中未见写入文件内容的记录', issue: '无法从日志确认内容' },
  ],
  summary: '第一步已完成，第二步无法验证。',
  fixSuggestions: ['检查 todo.txt 内容是否包含「已完成」，若没有则写入后重新自检'],
});

const DEFAULT_FIX_REPLY = JSON.stringify({
  fixInstructions: '检查 todo.txt 内容是否包含「已完成」；若没有，追加写入该行后重新逐项自检验收。',
});

const DEFAULT_BRIEF_REPLY = JSON.stringify({
  title: 'Mock 测试任务',
  background: '这是 mock provider 生成的测试 brief，用于在没有真实 API key 时验证全链路。',
  clarifications: [
    {
      question: '任务目标是什么？',
      answer: '跑通端到端链路',
      rationale: 'mock 场景固定答案',
    },
  ],
  polishedPrompt: '按照 brief 的分步计划执行任务，完成后逐项自检验收标准并汇报。',
  plan: [
    { step: '第一步：阅读工作目录内容，了解现状', verification: '能列出目录中已有文件' },
    { step: '第二步：创建 todo.txt 并写入「已完成」', verification: 'todo.txt 存在且内容正确' },
  ],
  constraints: {
    must: ['在工作目录内完成全部工作'],
    forbidden: ['不得改动工作目录之外的文件', '不得改动 .smart2stupid 目录'],
  },
  acceptance: ['todo.txt 文件存在', 'todo.txt 内容包含「已完成」'],
});

/**
 * Mock provider：按 config.replies 顺序消费固定回复，耗尽后循环最后一条。
 * 用途：无真实 API key 时端到端验证 smart 链路（创建树 → 追问演进 → 生成 brief）。
 */
export class MockProvider implements SmartProvider {
  readonly id: string;
  readonly canStream = false;
  readonly modelName = 'mock';
  private readonly replies: string[];
  private cursor = 0;

  constructor(id: string, cfg: MockConfig) {
    this.id = id;
    this.replies = cfg.replies.length > 0 ? cfg.replies : [DEFAULT_TREE_REPLY];
  }

  async chat(req: ChatRequest): Promise<string> {
    // 按对话目的猜测期望的回复类型，让无配置的 mock 也能走完整条链路
    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
    if (this.replies.length === 1 && this.replies[0] === DEFAULT_TREE_REPLY) {
      // 顺序敏感：修正指令的 system 文案含「验收审核」字样，必须先判「修正指令」；
      // 且两者都必须先于 'brief'（审核的 user 消息含 brief 全文，但派发只看 system）
      if (sys.includes('修正指令')) return DEFAULT_FIX_REPLY;
      if (sys.includes('验收审核')) return DEFAULT_REVIEW_REPLY;
      if (sys.includes('treePatch')) return DEFAULT_EVOLVE_REPLY;
      if (sys.includes('brief')) return DEFAULT_BRIEF_REPLY;
    }
    const reply = this.replies[Math.min(this.cursor, this.replies.length - 1)];
    if (this.cursor < this.replies.length - 1) this.cursor += 1;
    req.onLog?.({ stream: 'info', text: `mock 派发固定回复（${reply.slice(0, 60).replace(/\n/g, ' ')}…）` });
    return reply;
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: 'mock provider，始终可用（仅测试用）' };
  }
}
