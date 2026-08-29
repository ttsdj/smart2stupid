// 设计树：grilling 追问模式的数据结构与纯函数。
// 关键分工：模型负责树的生成与演进（treePatch），服务端负责 frontier 计算的确定性。

export interface TreeNode {
  id: string;
  question: string;
  recommended?: string;
  status: 'pending' | 'asked' | 'answered';
  answer?: string;
  /** 前置决策 id：全部 answered 后本节点才能进入 frontier。 */
  dependsOn: string[];
}

/** 模型输出用的节点输入格式。 */
export interface TreeNodeInput {
  id: string;
  question: string;
  recommended?: string;
  dependsOn?: string[];
}

export interface RoundRecord {
  index: number;
  qa: { id: string; answer: string }[];
}

export interface DesignTree {
  nodes: Record<string, TreeNode>;
  rounds: RoundRecord[];
}

export interface TreePatch {
  add?: TreeNodeInput[];
  remove?: string[];
  update?: { id: string; question?: string; recommended?: string }[];
}

export function emptyTree(): DesignTree {
  return { nodes: {}, rounds: [] };
}

export function buildTree(inputs: TreeNodeInput[]): DesignTree {
  const tree = emptyTree();
  for (const n of inputs) {
    tree.nodes[n.id] = {
      id: n.id,
      question: n.question,
      recommended: n.recommended,
      status: 'pending',
      dependsOn: n.dependsOn ?? [],
    };
  }
  return tree;
}

/** 校验：id 重复、dependsOn 引用不存在、环。返回错误列表（空 = 合法）。 */
export function validateTree(tree: DesignTree): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const n of Object.values(tree.nodes)) {
    if (seen.has(n.id)) errors.push(`重复 id: ${n.id}`);
    seen.add(n.id);
  }
  for (const n of Object.values(tree.nodes)) {
    for (const d of n.dependsOn) {
      if (!seen.has(d)) errors.push(`节点 ${n.id} 依赖不存在的 ${d}`);
    }
  }
  // 环检测：DFS 三色标记
  const color = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 在栈中 2 完成
  const visit = (id: string): void => {
    const c = color.get(id) ?? 0;
    if (c === 2) return;
    if (c === 1) {
      errors.push(`依赖环经过节点 ${id}`);
      return;
    }
    color.set(id, 1);
    for (const d of tree.nodes[id]?.dependsOn ?? []) visit(d);
    color.set(id, 2);
  };
  for (const n of Object.values(tree.nodes)) visit(n.id);
  return errors;
}

/** 前沿：pending 且依赖全部 answered 的节点，按 id 排序（保证本轮问题互不依赖）。 */
export function computeFrontier(tree: DesignTree): TreeNode[] {
  return Object.values(tree.nodes)
    .filter((n) => n.status !== 'answered' && n.dependsOn.every((d) => tree.nodes[d]?.status === 'answered'))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 应用一轮用户答案；留空答案 = 未回答（该节点留在后续轮次）。返回实际被采纳的问答。 */
export function applyAnswers(tree: DesignTree, answers: Record<string, string>, roundIndex: number): { id: string; answer: string }[] {
  const qa: { id: string; answer: string }[] = [];
  for (const [id, raw] of Object.entries(answers)) {
    const node = tree.nodes[id];
    if (!node) continue;
    const answer = String(raw).trim();
    if (!answer) continue;
    node.answer = answer;
    node.status = 'answered';
    qa.push({ id, answer });
  }
  if (qa.length > 0) tree.rounds.push({ index: roundIndex, qa });
  return qa;
}

/** 应用模型输出的 treePatch。返回错误列表（个别项失败不影响其余项）。 */
export function applyTreePatch(tree: DesignTree, patch: TreePatch): string[] {
  const errors: string[] = [];
  for (const n of patch.add ?? []) {
    if (tree.nodes[n.id]) {
      errors.push(`add 重复 id: ${n.id}`);
      continue;
    }
    tree.nodes[n.id] = {
      id: n.id,
      question: n.question,
      recommended: n.recommended,
      status: 'pending',
      dependsOn: n.dependsOn ?? [],
    };
  }
  for (const id of patch.remove ?? []) {
    if (!tree.nodes[id]) {
      errors.push(`remove 不存在的 id: ${id}`);
      continue;
    }
    if (tree.nodes[id].status === 'answered') {
      errors.push(`remove 已决节点 ${id}（已忽略，结论不能被删除）`);
      continue;
    }
    delete tree.nodes[id];
  }
  for (const u of patch.update ?? []) {
    const node = tree.nodes[u.id];
    if (!node) {
      errors.push(`update 不存在的 id: ${u.id}`);
      continue;
    }
    if (u.question !== undefined) node.question = u.question;
    if (u.recommended !== undefined) node.recommended = u.recommended;
  }
  return errors;
}

/** 从模型回复文本中提取 JSON（剥 ```json 围栏与前后杂文）。 */
export function extractJson(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

/** 严格解析模型输出的 JSON 设计树；失败返回错误。 */
export function parseTreeJson(text: string): { tree?: DesignTree; error?: string } {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(text));
  } catch (e) {
    return { error: `JSON 解析失败: ${(e as Error).message}` };
  }
  const nodes: TreeNodeInput[] = [];
  const rawNodes = (data as { nodes?: unknown })?.nodes;
  if (Array.isArray(rawNodes)) {
    for (const n of rawNodes) {
      if (!n || typeof n !== 'object') continue;
      const o = n as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.question !== 'string') continue;
      nodes.push({
        id: o.id,
        question: o.question,
        recommended: typeof o.recommended === 'string' ? o.recommended : undefined,
        dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.filter((x): x is string => typeof x === 'string') : [],
      });
    }
  }
  if (nodes.length === 0) return { error: '模型输出中没有有效问题节点' };
  const tree = buildTree(nodes);
  const errs = validateTree(tree);
  if (errs.length > 0) return { error: `树校验失败: ${errs.join('; ')}` };
  return { tree };
}

/** 解析 treePatch，宽松失败（返回 undefined = 忽略，树保持不变）。 */
export function parsePatchJson(text: string): TreePatch | undefined {
  try {
    const data = JSON.parse(extractJson(text)) as Partial<TreePatch>;
    return {
      add: Array.isArray(data.add) ? (data.add as TreeNodeInput[]) : [],
      remove: Array.isArray(data.remove) ? (data.remove as string[]) : [],
      update: Array.isArray(data.update) ? (data.update as TreePatch['update']) : [],
    };
  } catch {
    return undefined;
  }
}

/** 建树完全失败时的兜底：3 个通用问题，保证流程不死。 */
export function fallbackTree(): DesignTree {
  return buildTree([
    {
      id: 'q1',
      question: '这个任务最终想要达到的目标是什么？请描述成功后的样子。',
      recommended: '一个能跑的最小可用版本，先证明可行性',
    },
    {
      id: 'q2',
      question: '有哪些硬性约束？（技术栈、平台、时间、范围边界）没有的话答「无」即可。',
      recommended: '无硬性约束',
    },
    {
      id: 'q3',
      question: '怎样算完成？请给出 2-3 条可验证的验收标准。',
      recommended: '核心流程能跑通，且有基本测试',
      dependsOn: ['q1'],
    },
  ]);
}
