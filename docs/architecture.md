# smart2stupid 架构描述与图像生成提示词

本文档用于配合仓库 README 顶部的架构大图（`docs/architecture.png`）与项目 logo（`docs/logo.png`）。两张图由用户交给 GPT 类图像模型生成，本文提供准确、可复现的架构描述与生成 prompt。

## 一、架构描述（给图像模型看的中文版）

smart2stupid 是一套 **VS Code 内的双 Agent 开发工作流**：

- **右侧 = 官方 Codex 对话（smart 端 / 聪明模型）**：负责需求澄清（设计树追问）→ 生成六节 brief → 派单 → 只读审核 → 生成修正指令。Codex 不修改业务文件，只写目标工作区 `.smart2stupid/` 元数据。
- **左侧 = smart2stupid 结构化执行面板（VS Code Activity Bar 独立入口）**：实时展示 Claude Code 收到的完整 handoff、回复、工具调用、命令、文件变化、测试、错误、token 用量与状态。
- **中间 = `npm run delegate` 无 HTTP 委派 CLI**：把 brief/handoff 交给 Claude、回收结果，管理 session、轮次、快照与审计事件。
- **底层 = Claude Code CLI（stupid 端 / 唯一实施者）**：真正写代码、跑测试、改文件、安装依赖；固定 session ID 持久化，后续 `--resume`；`--permission-mode bypassPermissions` + deny 规则保护删除类危险操作。
- **闭环**：用户确认一次 brief → Claude 独立执行到终态 → Codex 只读审核 → 不通过自动生成最小修正指令重跑，默认最多 3 轮。
- **数据落盘**：`<workdir>/.smart2stupid/`（brief、handoff、baseline、changes、delegate-events、delegate-state、review）。
- **脱敏**：面板与日志不保存 API key、Token、Cookie、Authorization、密码原文。

数据流（用于构图）：

```
用户（VS Code 内）
   │  $smart2stupid <任务描述>
   ▼
┌─ Codex 对话（smart）───────────────┐
│ 设计树追问 → brief → 派单 → 审核    │
└──────────────┬────────────────────┘
               │ brief（六节）
               ▼
        ┌─────────────┐
        │ delegate CLI │（无 HTTP）
        └──────┬──────┘
               │ handoff（brief + 修正反馈）
               ▼
┌─ Claude Code CLI（stupid · 唯一实施者）─┐
│ 工具调用 / 写文件 / 测试 / 构建           │
└──────┬──────────────────────────────────┘
       │ 执行事件 → 左侧结构化面板（实时）
       │ 结果 → Codex 审核 ──不通过→ 修正 → 再执行（≤3 轮）
```

## 二、主图（hero 架构图）生成 prompt

```
Create a clean, modern architecture-diagram illustration for a developer tool called
"smart2stupid" — a two-agent coding workflow inside VS Code.

Layout (left to right):
- LEFT: a VS Code window containing a "structured execution panel" that shows Claude Code's
  live activity — a stack of tool-call chips (Bash / Edit / Read), a code diff block,
  green-check test results, and token-usage counters.
- RIGHT: the official Codex chat panel, showing requirements clarification (a small
  decision-tree of questions) and a review checklist with pass/fail verdicts.
- Flowing between them, a horizontal pipeline of rounded nodes connected by arrows:
  User prompt → [Codex: plan & review] → [brief] → [delegate CLI] → [Claude Code: execute],
  with a circular return arrow labeled "review → fix (≤ 3 rounds)".

Style: flat vector tech illustration, dark navy background (#0f172a), thin subtle grid,
cyan-to-teal gradient accents (#22d3ee → #2dd4bf → #14b8a6) on the flow lines and node
borders, clean sans-serif labels, minimal, no logos, no photorealism, wide banner ratio
(roughly 16:6), crisp and legible.
```

## 三、Logo 生成 prompt（青色渐变）

```
Create a minimal, geometric logo icon for a developer tool called "smart2stupid".

Concept: two abstract nodes connected by a short pipeline — on the left a bright
"spark / brain" node (the smart planner), on the right a smaller, simpler "gear" node
(the efficient executor), linked by a curved arrow, symbolizing "smart thinking handed
off to cheap execution".

Style: flat vector, rounded geometry, subtle depth, on a transparent background (also
reads well on dark), using a cyan-to-teal gradient (#22d3ee → #2dd4bf → #14b8a6).
No text (or an optional tiny "s2s" wordmark below). Square / round icon format, clean
and modern, legible even at small favicon size.
```

## 四、放置位置

- 主图：生成后存为 `docs/architecture.png`（README 顶部已引用此路径）。
- Logo：生成后存为 `docs/logo.png`；如需替换 VS Code 扩展的 Activity Bar 图标，可一并替换 `vscode-extension/media/smart2stupid.svg`（需 SVG 格式）。
