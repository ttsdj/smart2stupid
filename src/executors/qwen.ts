// Qwen Code CLI 适配器：官方宣称与 Claude Code 旗标对齐（-p / stream-json 同构），
// 直接复用 Claude 适配器的模板与事件解析，仅换 id/label。旗标漂移时改 config 模板即可。

import type { ExecutorConfig } from '../config/schema.js';
import { ClaudeAdapter } from './claude.js';
import type { ExecContext } from './types.js';

export class QwenAdapter extends ClaudeAdapter {
  override readonly id = 'qwen';
  override readonly label = 'Qwen Code CLI';

  constructor(cfg: ExecutorConfig, ctx: ExecContext) {
    super(cfg, ctx);
  }
}
