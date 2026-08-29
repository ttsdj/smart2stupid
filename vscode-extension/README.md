# smart2stupid VS Code 集成

0.3.1 修复了“在 Claude Code 中打开”可能无响应的问题：按钮现在直接调用当前 VS Code 实例中的 Claude Code 会话命令，不再经过 Windows 的外部 `vscode://` 协议；扩展缺失、命令不兼容或打开失败时会显示明确错误。

0.3.0 修复了短任务结束后面板不自动打开的问题：每个新任务/新轮次即使已经快速完成或失败，也会补开结构化面板。只有 Claude 的 `init` 事件确认会话已建立后，“在 Claude Code 中打开”按钮才会出现。

默认工作流完全在 VS Code 内完成：

- 右侧官方 Codex 对话负责需求澄清、brief、派单与审核；
- 左侧 smart2stupid 结构化面板实时展示 Claude Code 的回复、工具调用、命令、文件操作、测试、错误和状态；
- 不启动 HTTP 服务，不弹出浏览器；
- Claude 会话由官方 CLI 持久化，执行结束后可在面板中点击“在 Claude Code 中打开”。

## 使用

1. 安装本扩展的 VSIX，并确认官方 Codex 与 Claude Code 扩展已安装。
2. 在 Codex 对话中显式输入 **$smart2stupid** 加任务描述。
3. 与 Codex 完成设计树追问并确认最终 brief。
4. Codex 调用 **npm run delegate** 后，左侧执行面板自动打开。
5. Claude 完成后 Codex 只读审核；未通过时最多自动修正三轮。

状态栏的 **smart2stupid** 可随时重新打开当前执行面板。

## 面板操作

- **停止 Claude**：终止当前执行并标记为 cancelled，不会自动重跑。
- **在 Claude Code 中打开**：按 session ID 打开官方 Claude Code 会话。
- **下轮新开会话**：下一轮不复用当前 Claude 上下文。
- **追加一轮**：将默认三轮上限增加一轮。

所有面板和落盘执行日志都会遮盖 API key、Token、Cookie、Authorization 和密码值。

## 旧版 Web UI

旧实现仅作为手动备用入口保留，不参与正常工作流：

- **smart2stupid: 启动旧版 Web UI（备用）**
- **smart2stupid: 打开旧版 Web UI（备用）**
- **smart2stupid: 停止旧版 Web UI**

只有显式执行这些命令时才会启动本地 HTTP 服务。

## 设置

- **smart2stupid.autoOpenExecutionPanel**：检测到委派任务时自动打开面板，默认开启。
- **smart2stupid.pollIntervalMs**：本地事件刷新间隔，默认 700 ms。
- **smart2stupid.projectRoot**：smart2stupid 源码目录，仅委派工具定位和旧 Web UI 使用。
