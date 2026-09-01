// smart2stupid VS Code 扩展：结构化 Claude 执行面板（默认、无 HTTP）+ 旧 Web UI 手动回退。

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

interface DelegationIteration {
  index: number;
  status: string;
  startedAt: string;
  endedAt?: string;
  handoffPath: string;
  claudeSessionId?: string;
  changesPath?: string;
  resultSummary?: string;
  executorUsage?: TokenUsage;
  review?: { verdict: string; path: string; recordedAt: string };
}

interface ModelTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd?: number;
}

interface TokenUsage {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  costUsd?: number;
  models?: ModelTokenUsage[];
}

interface DelegationState {
  taskId: string;
  workdir: string;
  title: string;
  phase: string;
  briefPath: string;
  claudeSessionId: string;
  sessionEstablished?: boolean;
  model: string;
  maxIterations: number;
  extraIterations: number;
  newSessionNext: boolean;
  iterations: DelegationIteration[];
  createdAt: string;
  updatedAt: string;
}

interface ActiveState {
  state: DelegationState;
  statePath: string;
}

interface PanelPayload {
  state: DelegationState;
  handoff: string;
  events: Record<string, unknown>[];
  changes?: Record<string, unknown>;
  review?: string;
}

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let executionPanel: vscode.WebviewPanel | null = null;
let executionView: vscode.WebviewView | null = null;
let legacyPanel: vscode.WebviewPanel | null = null;
let activeState: ActiveState | null = null;
let lastSignature = '';
let lastAutoOpenedRun = '';
let pollTimer: NodeJS.Timeout | undefined;
let legacyProc: ChildProcess | null = null;
let legacyToken = '';
let legacyPort = 3747;

function cfg<T>(key: string, fallback: T): T {
  const value = vscode.workspace.getConfiguration('smart2stupid').get<T>(key);
  return value === undefined || value === null || value === '' ? fallback : value;
}

function resolveProjectRoot(): string {
  const candidates = [
    cfg<string>('projectRoot', ''),
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    'd:/00.project/smart2stupid',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (existsSync(path.join(resolved, 'package.json')) && existsSync(path.join(resolved, 'src', 'main.ts'))) return resolved;
  }
  throw new Error(`找不到 smart2stupid 项目目录。已尝试：\n${candidates.join('\n')}`);
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readText(file: string | undefined): string {
  if (!file) return '';
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function findActiveState(): ActiveState | null {
  let newest: ActiveState | null = null;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const activeFile = path.join(folder.uri.fsPath, '.smart2stupid', 'active.json');
    const pointer = readJson<{ statePath?: string }>(activeFile);
    if (!pointer?.statePath) continue;
    const state = readJson<DelegationState>(pointer.statePath);
    if (!state) continue;
    if (!newest || state.updatedAt > newest.state.updatedAt) newest = { state, statePath: pointer.statePath };
  }
  return newest;
}

function readEvents(state: DelegationState): Record<string, unknown>[] {
  const file = path.join(state.workdir, '.smart2stupid', 'sessions', state.taskId, 'delegate-events.jsonl');
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-2000)
      .map((line) => {
        try { return JSON.parse(line) as Record<string, unknown>; } catch { return { type: 'stderr', text: '事件记录解析失败' }; }
      });
  } catch {
    return [];
  }
}

function payloadFor(state: DelegationState): PanelPayload {
  const iteration = state.iterations.at(-1);
  return {
    state,
    handoff: readText(iteration?.handoffPath),
    events: readEvents(state),
    changes: iteration?.changesPath ? readJson<Record<string, unknown>>(iteration.changesPath) : undefined,
    review: readText(iteration?.review?.path),
  };
}

function setStatus(state: DelegationState | null): void {
  const running = state?.phase === 'running' || state?.phase === 'queued';
  const icon = running ? '$(sync~spin)' : state ? '$(checklist)' : '$(circle-outline)';
  statusBar.text = `${icon} smart2stupid${state ? ` · ${state.phase}` : ''}`;
  statusBar.tooltip = state
    ? `${state.title}\n${state.taskId}\n点击打开 Claude 执行面板`
    : '等待 $smart2stupid 委派任务';
}

function executionHtml(): string {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 22px 48px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.55 var(--vscode-font-family); }
  header { position: sticky; top: 0; z-index: 2; margin: -18px -22px 16px; padding: 14px 22px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
  h1 { margin: 0 0 4px; font-size: 17px; font-weight: 650; }
  h2 { margin: 22px 0 10px; font-size: 14px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
  button { border: 1px solid var(--vscode-button-border, transparent); padding: 5px 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-radius: 3px; cursor: pointer; }
  button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
  button.danger { color: var(--vscode-errorForeground); background: transparent; border-color: var(--vscode-errorForeground); }
  button[hidden] { display: none; }
  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  details.section { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 10px 0; overflow: hidden; }
  details.section > summary { cursor: pointer; padding: 10px 12px; background: var(--vscode-sideBar-background); font-weight: 600; }
  pre { margin: 0; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.55 var(--vscode-editor-font-family); }
  #timeline { display: flex; flex-direction: column; gap: 8px; }
  .event { border-left: 3px solid var(--vscode-panel-border); padding: 8px 10px; background: var(--vscode-textCodeBlock-background); border-radius: 2px 5px 5px 2px; }
  .event.reply { border-left-color: var(--vscode-charts-blue); }
  .event.tool { border-left-color: var(--vscode-charts-yellow); }
  .event.error { border-left-color: var(--vscode-errorForeground); }
  .event.status { border-left-color: var(--vscode-charts-green); }
  .event .label { font-size: 11px; font-weight: 700; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .event .content { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
  .event details summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
  .event details pre { padding: 8px 0 0; }
  .changes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .usage { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .usage-card { padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; min-width: 0; }
  .usage-value { display: block; font-size: 18px; font-weight: 650; }
  .usage-label { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .change { padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; min-width: 0; }
  .change strong { display: block; margin-bottom: 5px; }
  .change div { overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .empty { color: var(--vscode-descriptionForeground); padding: 18px 0; }
  @media (max-width: 520px) {
    body { padding: 12px 10px 36px; }
    header { position: static; margin: -12px -10px 12px; padding: 10px; }
    .top { display: block; }
    .actions { margin-top: 10px; justify-content: flex-start; }
    .changes, .usage { grid-template-columns: 1fr; }
  }
</style></head><body>
<header><div class="top"><div><h1 id="title">smart2stupid</h1><div class="meta"><span id="phase" class="badge">idle</span> <span id="meta"></span></div></div>
<div class="actions"><button id="stop" class="danger">停止 Claude</button><button id="openClaude">在 Claude Code 中打开</button><button id="openEditor" class="secondary">在编辑区展开</button><button id="newSession" class="secondary">下轮新开会话</button><button id="extend" class="secondary">追加一轮</button></div></div></header>
<div id="empty" class="empty">等待 Codex 通过 $smart2stupid 派发任务。</div>
<main id="main" hidden>
  <h2>本轮 Token</h2><div id="usage" class="usage"></div>
  <details class="section" open><summary>收到的完整指令</summary><pre id="handoff"></pre></details>
  <h2>Claude 实时执行</h2><div id="timeline"></div>
  <h2>本轮文件变化</h2><div id="changes" class="changes"></div>
  <details id="reviewBox" class="section"><summary>Codex 审核记录</summary><pre id="review"></pre></details>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  ['stop','openClaude','openEditor','newSession','extend'].forEach(id => el(id).addEventListener('click', () => vscode.postMessage({ command: id })));
  function stringify(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  function addEvent(kind, label, content, details) {
    const card = document.createElement('div'); card.className = 'event ' + kind;
    const head = document.createElement('div'); head.className = 'label'; head.textContent = label; card.appendChild(head);
    const body = document.createElement('div'); body.className = 'content'; body.textContent = content || ''; card.appendChild(body);
    if (details !== undefined) { const d = document.createElement('details'); const s = document.createElement('summary'); s.textContent = '查看参数/输出'; const p = document.createElement('pre'); p.textContent = stringify(details); d.append(s,p); card.appendChild(d); }
    el('timeline').appendChild(card);
  }
  function renderEvents(events) {
    el('timeline').replaceChildren();
    let partial = '';
    const flush = () => { if (partial) { addEvent('reply','CLAUDE 回复',partial); partial = ''; } };
    for (const event of events) {
      if (event.type === 'stdout' && event.partial) { partial += event.text || ''; continue; }
      if (event.type === 'stdout') { if (partial && String(event.text || '').includes(partial)) partial = ''; else flush(); addEvent('reply','CLAUDE 回复',String(event.text || '')); }
      else if (event.type === 'tool_use') { if (event.partial) continue; flush(); const tool = String(event.tool || '工具'); const cls = /bash|shell|powershell/i.test(tool) ? '命令' : /edit|write|notebook/i.test(tool) ? '文件修改' : '工具调用'; addEvent('tool',cls + ' · ' + tool,'',event.input); }
      else if (event.type === 'tool_result') { flush(); addEvent(event.isError ? 'error' : 'tool',event.isError ? '工具错误' : '工具结果','',event.content); }
      else if (event.type === 'stderr') { flush(); addEvent('error','STDERR',String(event.text || '')); }
      else if (event.type === 'status') { flush(); addEvent(event.status === 'failed' ? 'error' : 'status','状态 · ' + event.status,String(event.message || '')); }
      else if (event.type === 'result') { flush(); addEvent('reply','最终结果',String(event.text || '')); }
    }
    flush();
    if (!events.length) addEvent('status','等待','Claude 尚未产生执行事件');
  }
  function renderChanges(changes) {
    const root = el('changes'); root.replaceChildren();
    for (const [key,label] of [['created','新增'],['modified','修改'],['deleted','删除']]) {
      const box = document.createElement('div'); box.className = 'change'; const strong = document.createElement('strong'); const list = Array.isArray(changes?.[key]) ? changes[key] : []; strong.textContent = label + ' · ' + list.length; box.appendChild(strong);
      if (!list.length) { const row = document.createElement('div'); row.textContent = '无'; box.appendChild(row); }
      for (const file of list) { const row = document.createElement('div'); row.textContent = String(file); box.appendChild(row); }
      root.appendChild(box);
    }
  }
  function renderUsage(usage) {
    const root = el('usage'); root.replaceChildren();
    const values = usage ? [
      ['总计', Number(usage.totalTokens || 0).toLocaleString()],
      ['普通输入', Number(usage.inputTokens || 0).toLocaleString()],
      ['输出', Number(usage.outputTokens || 0).toLocaleString()],
      ['缓存输入', Number(usage.cacheReadInputTokens || 0).toLocaleString()],
      ['缓存写入', Number(usage.cacheCreationInputTokens || 0).toLocaleString()],
      ['费用', usage.costUsd === undefined ? '未提供' : '$' + Number(usage.costUsd).toFixed(6)],
    ] : [['执行端', '等待 Claude 返回 usage']];
    for (const [label,value] of values) {
      const card = document.createElement('div'); card.className = 'usage-card';
      const val = document.createElement('span'); val.className = 'usage-value'; val.textContent = value;
      const lab = document.createElement('span'); lab.className = 'usage-label'; lab.textContent = label;
      card.append(val,lab); root.appendChild(card);
    }
    if (Array.isArray(usage?.models) && usage.models.length) {
      const card = document.createElement('div'); card.className = 'usage-card'; card.style.gridColumn = '1 / -1';
      const lab = document.createElement('span'); lab.className = 'usage-label'; lab.textContent = '分模型明细'; card.appendChild(lab);
      for (const model of usage.models) { const row = document.createElement('div'); row.textContent = model.model + ': ' + Number(model.inputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens + model.outputTokens).toLocaleString() + ' tokens'; card.appendChild(row); }
      root.appendChild(card);
    }
  }
  window.addEventListener('message', ({ data }) => {
    if (!data?.state) return;
    const state = data.state; el('empty').hidden = true; el('main').hidden = false;
    el('title').textContent = state.title || state.taskId; el('phase').textContent = state.phase;
    const iteration = state.iterations?.length || 0; el('meta').textContent = state.taskId + ' · Claude ' + state.model + ' · 第 ' + iteration + '/' + (state.maxIterations + state.extraIterations) + ' 轮';
    const current = state.iterations?.[state.iterations.length - 1]; renderUsage(current?.executorUsage);
    el('handoff').textContent = data.handoff || '尚无 handoff'; renderEvents(data.events || []); renderChanges(data.changes || {});
    el('review').textContent = data.review || '尚未审核'; el('reviewBox').open = Boolean(data.review);
    const running = state.phase === 'running' || state.phase === 'queued'; el('stop').hidden = !running; el('newSession').hidden = running; el('extend').hidden = running; el('openClaude').hidden = !state.claudeSessionId || state.sessionEstablished !== true;
  });
</script></body></html>`;
}

class ExecutionViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    executionView = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = executionHtml();
    view.webview.onDidReceiveMessage((message) => void handlePanelMessage(message));
    view.onDidDispose(() => { if (executionView === view) executionView = null; });
    if (activeState) void view.webview.postMessage(payloadFor(activeState.state));
  }
}

async function showExecutionView(): Promise<void> {
  await vscode.commands.executeCommand('smart2stupid.executionView.focus');
  if (executionView && activeState) void executionView.webview.postMessage(payloadFor(activeState.state));
}

function ensureExecutionPanel(preserveFocus = true): vscode.WebviewPanel {
  if (!executionPanel) {
    executionPanel = vscode.window.createWebviewPanel('smart2stupidExecution', 'Claude 执行 · smart2stupid', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    executionPanel.webview.html = executionHtml();
    executionPanel.webview.onDidReceiveMessage((message) => void handlePanelMessage(message));
    executionPanel.onDidDispose(() => { executionPanel = null; });
  }
  executionPanel.reveal(vscode.ViewColumn.One, preserveFocus);
  if (activeState) void executionPanel.webview.postMessage(payloadFor(activeState.state));
  return executionPanel;
}

async function openClaudeSession(sessionId: string): Promise<void> {
  const claudeExtension = vscode.extensions.getExtension('anthropic.claude-code');
  if (!claudeExtension) {
    throw new Error('未检测到官方 Claude Code 扩展（anthropic.claude-code）');
  }

  await claudeExtension.activate();
  const commands = await vscode.commands.getCommands(true);
  const openCommand = commands.includes('claude-vscode.primaryEditor.open')
    ? 'claude-vscode.primaryEditor.open'
    : commands.includes('claude-vscode.editor.open')
      ? 'claude-vscode.editor.open'
      : undefined;

  if (!openCommand) {
    throw new Error('当前 Claude Code 扩展没有提供会话打开命令，请升级该扩展');
  }

  await vscode.commands.executeCommand(openCommand, sessionId);
}

async function handlePanelMessage(message: { command?: string }): Promise<void> {
  if (!activeState) return;
  const state = activeState.state;
  const sessionDir = path.join(state.workdir, '.smart2stupid', 'sessions', state.taskId);
  if (message.command === 'stop') {
    writeFileSync(path.join(sessionDir, 'control.json'), JSON.stringify({ stop: true, requestedAt: new Date().toISOString() }, null, 2), 'utf8');
    void vscode.window.showWarningMessage('已请求停止 Claude；正在终止当前工具进程。');
  } else if (message.command === 'openClaude') {
    try {
      await openClaudeSession(state.claudeSessionId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      output.appendLine(`[openClaude] ${detail}`);
      void vscode.window.showErrorMessage(`无法在 Claude Code 中打开会话：${detail}`);
    }
  } else if (message.command === 'openEditor') {
    ensureExecutionPanel(false);
  } else if (message.command === 'newSession') {
    state.newSessionNext = true;
    state.updatedAt = new Date().toISOString();
    writeFileSync(activeState.statePath, JSON.stringify(state, null, 2), 'utf8');
    void vscode.window.showInformationMessage('下一轮将创建新的 Claude session。');
  } else if (message.command === 'extend') {
    state.extraIterations = (state.extraIterations || 0) + 1;
    state.updatedAt = new Date().toISOString();
    writeFileSync(activeState.statePath, JSON.stringify(state, null, 2), 'utf8');
    void vscode.window.showInformationMessage(`迭代上限已增加到 ${state.maxIterations + state.extraIterations} 轮。`);
  }
}

function refreshExecutionState(): void {
  const found = findActiveState();
  activeState = found;
  setStatus(found?.state ?? null);
  if (!found) return;
  const payload = payloadFor(found.state);
  const signature = `${found.state.updatedAt}:${payload.events.length}:${found.state.phase}:${payload.review?.length ?? 0}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  if (executionPanel) void executionPanel.webview.postMessage(payload);
  if (executionView) void executionView.webview.postMessage(payload);
  const runKey = `${found.state.taskId}:${found.state.iterations.length}`;
  if (cfg<boolean>('autoOpenExecutionPanel', true) && lastAutoOpenedRun !== runKey) {
    lastAutoOpenedRun = runKey;
    void showExecutionView();
  }
}

async function startLegacyServer(): Promise<{ port: number; token: string }> {
  if (legacyProc && legacyToken) return { port: legacyPort, token: legacyToken };
  const root = resolveProjectRoot();
  legacyPort = cfg<number>('port', 3747);
  const command = cfg<string>('startCommand', 'npm run dev');
  output.appendLine(`[legacy] ${command} (cwd=${root})`);
  legacyProc = spawn(command, { cwd: root, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('60 秒内未捕获旧版服务地址')), 60_000);
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString(); output.append(text);
      const token = text.match(/token=([a-f0-9]{20,})/)?.[1];
      const port = text.match(/127\.0\.0\.1:(\d+)\//)?.[1];
      if (token && port) { clearTimeout(timer); legacyToken = token; legacyPort = Number(port); resolve({ port: legacyPort, token }); }
    };
    legacyProc!.stdout!.on('data', onData); legacyProc!.stderr!.on('data', onData);
    legacyProc!.once('exit', (code) => { legacyProc = null; if (!legacyToken) reject(new Error(`旧版服务退出 code=${code}`)); });
  });
}

function legacyHtml(url: string): string {
  return `<!doctype html><html><body style="margin:0;height:100vh"><iframe style="border:0;width:100%;height:100%" src="${url}"></iframe></body></html>`;
}

async function openLegacyPanel(): Promise<void> {
  const { port, token } = await startLegacyServer();
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  if (!legacyPanel) {
    legacyPanel = vscode.window.createWebviewPanel('smart2stupidLegacy', 'smart2stupid · 旧版 Web UI', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    legacyPanel.onDidDispose(() => { legacyPanel = null; });
  }
  legacyPanel.webview.html = legacyHtml(url);
  legacyPanel.reveal();
}

function stopLegacy(): void {
  if (legacyProc) killTree(legacyProc);
  legacyProc = null; legacyToken = ''; legacyPanel?.dispose(); legacyPanel = null;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('smart2stupid');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'smart2stupid.open';
  statusBar.show();
  setStatus(null);

  context.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerWebviewViewProvider('smart2stupid.executionView', new ExecutionViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('smart2stupid.open', () => void showExecutionView()),
    vscode.commands.registerCommand('smart2stupid.openEditor', () => ensureExecutionPanel(false)),
    vscode.commands.registerCommand('smart2stupid.stopExecution', () => void handlePanelMessage({ command: 'stop' })),
    vscode.commands.registerCommand('smart2stupid.openClaudeSession', () => void handlePanelMessage({ command: 'openClaude' })),
    vscode.commands.registerCommand('smart2stupid.newClaudeSession', () => void handlePanelMessage({ command: 'newSession' })),
    vscode.commands.registerCommand('smart2stupid.extendIteration', () => void handlePanelMessage({ command: 'extend' })),
    vscode.commands.registerCommand('smart2stupid.legacyStart', async () => { await startLegacyServer(); void vscode.window.showInformationMessage('旧版 Web UI 服务已启动'); }),
    vscode.commands.registerCommand('smart2stupid.legacyOpen', () => void openLegacyPanel().catch((error) => vscode.window.showErrorMessage(String(error)))),
    vscode.commands.registerCommand('smart2stupid.legacyStop', () => stopLegacy()),
  );

  refreshExecutionState();
  pollTimer = setInterval(refreshExecutionState, Math.max(300, cfg<number>('pollIntervalMs', 700)));
  context.subscriptions.push({ dispose: () => { if (pollTimer) clearInterval(pollTimer); } });
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer);
  stopLegacy();
}
