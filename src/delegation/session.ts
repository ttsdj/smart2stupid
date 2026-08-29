import { randomUUID } from 'node:crypto';

export interface SessionSelection {
  id: string;
  resume: boolean;
}

/**
 * 只有收到 Claude stream-json 的 init 事件后，会话才算真实存在。
 * 首轮或 init 前失败的轮次必须使用新 UUID，不能 resume 一个仅写进本地状态的 ID。
 */
export function selectClaudeSession(
  currentId: string | undefined,
  established: boolean | undefined,
  requestNew: boolean,
  createId: () => string = randomUUID,
): SessionSelection {
  if (currentId && established === true && !requestNew) return { id: currentId, resume: true };
  return { id: createId(), resume: false };
}
