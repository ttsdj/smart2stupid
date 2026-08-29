# smart2stupid 移交文档

> 生成日期：2026-08-29。本文档面向接手者，汇总设计需求、已完成功能、架构、配置、验证记录与已知限制。

## 2026-08-29 Claude 全权限执行升级

- Claude 默认改为 `--permission-mode bypassPermissions`，文件写入、普通 Bash、构建、测试和安装等操作无需人工批准。
- `stupid.disallowedTools` 作为 CLI 细粒度 deny 列表，即使在 bypass 模式下仍优先生效。
- 默认阻止递归 `rm`、PowerShell `Remove-Item -Recurse`、Windows `/s` 删除、`find -delete`、强制 `git clean`，以及常见 Python/Node recursive delete 调用。
- handoff 明确要求 Claude 不得绕过删除保护；确实需要批量删除时必须停止并返回 blocked。
- 真实探针任务 `task-20260829-083813-ed08782a` 已验证：Write 和 `node --version` 自动执行，`rm -rf` 被拒绝，测试文件保持存在。
- 注意：命令模式 deny 不是 OS 级 syscall 沙箱；不受信任的任务仍建议在容器或虚拟机内执行。

## 2026-08-29 持久会话与面板补丁（0.3.0）

- 根因：Codex 文件沙箱禁止 Claude CLI 用固定 `--session-id` 写入用户 `.claude/projects`，导致 `EPERM`；委派命令必须用窄范围批准在沙箱外启动，仍在 VS Code 内完成。
- `sessionEstablished` 只在 Claude stream-json `system/init` 后置为 true；init 前失败不会再 resume 不存在的 UUID。
- Claude `result.errors` 现在进入脱敏后的 stderr/status 事件，面板能显示原始失败原因。
- 面板按 `taskId:iteration` 自动打开，能补捉快速完成或失败的轮次；无有效 session 时隐藏“在 Claude Code 中打开”。
- 真实验证任务 `task-20260829-075209-b6df61f4`：首轮创建会话，第二轮以相同 session ID 恢复并返回 `RESUME_OK`。

## 0. 最新需求收敛与实现（VS Code 双面板）

用户重新确认后的默认产品形态如下：

- 全程在 VS Code 内；正常路径不启动 HTTP 服务、不打开浏览器、不嵌入旧 Web UI。
- 右侧官方 Codex 对话是 smart 端，负责设计树追问、brief、派单、只读审核与修正指令。
- 左侧 smart2stupid 结构化面板是 stupid 端的可视化执行面板，展示完整 handoff、Claude 回复、工具调用/结果、命令、文件变化、测试、错误与状态。
- Claude Code 是唯一实施者；Codex 不修改业务文件，只允许写目标工作区 `.smart2stupid/` 元数据。
- Claude 每轮独立运行到完成、失败、阻塞或取消；Codex 不在运行途中发送指令。交互只发生在每轮 handoff/结果边界。
- 首轮 brief 由用户确认一次；后续审核与修正自动闭环，默认最多三轮。
- 纯技术细节由 Codex 依据 brief 决定；功能、范围、数据风险、危险权限与验收变化必须回问用户。
- Claude CLI 使用固定 session ID，后续 `--resume`；面板可让下一轮新开 session，也可通过官方 URI 在 Claude Code 扩展中打开已完成会话。
- 面板和执行日志默认脱敏，不保存 API key、Token、Cookie、Authorization 或密码原文。

新增实现：

- `src/delegate.ts`：当前 Codex 对话使用的无 HTTP 委派/审核 CLI。
- `src/delegation/`：任务状态、文件基线、变化检测、事件落盘与脱敏。
- `skill-package/smart2stupid/`：显式调用的 `$smart2stupid` Codex 技能包。
- `vscode-extension/extension.ts`：结构化执行面板、停止、追加轮次、新 session、打开官方 Claude 会话；旧 Web UI 命令降级为显式备用入口。

## 1. 项目定位

**smart2stupid**：两段式 agent 编排系统，核心洞察是「规划/思考阶段需要聪明模型（贵），执行阶段不需要（便宜即可）」。

```
粗糙提示词 ──► smart 端（聪明模型）──► brief ──► stupid 端（廉价 CLI agent）──► 产物
              · 设计树多轮追问           · 六节契约    · claude/codex/qwen/桌面版…
              · 提示词优化 + 完整 plan   · md+json    · 流式回显 + 日志落盘
                                        ▲           │
                                        └─ 执行后自动审核 ─┘ 不通过 → 修正 → 迭代重跑
```

- **两端热插拔**：smart = provider 注册表；stupid = executor 注册表，全部 config 驱动。
- **人在环 / 无人环双模式**：Web UI（人工一步步）与 `npm run auto`（全自动闭环）共用同一套引擎与数据落盘。

## 2. 需求清单与状态

| # | 需求 | 状态 |
|---|---|---|
| 1 | 技术栈 Node.js + TypeScript，运行时 0 依赖 | ✅ 完成 |
| 2 | smart 端本地 Web UI + 交互式多轮追问（设计树，复用 grilling 模式） | ✅ 完成 |
| 3 | brief 六节契约（背景/澄清结论/优化提示词/分步计划/约束/验收标准），md+json 成对 | ✅ 完成 |
| 4 | smart providers 热插拔：openai-compatible / playwright-web-chat / cli-agent / mock | ✅ 完成（playwright-web-chat 易碎未实测） |
| 5 | stupid executors 热插拔：claude / codex / qwen / chatgpt-desktop / generic / echo | ✅ 完成（chatgpt-desktop/qwen 未实测 DOM/登录） |
| 6 | smart 端**审核执行结果**（自动审核 + 手动迭代） | ✅ 完成 |
| 7 | 全自动闭环（smart 自问自答 + 无人迭代，CLI + VSCode 命令） | ✅ 完成 |
| 8 | 实时日志：smart 调用日志 + 执行日志，落盘 | ✅ 完成 |
| 9 | Claude 执行时间线可视化（VS Code 结构化面板，无 HTTP） | ✅ 完成（编译与数据链路验证，待安装后人工目测） |
| 10 | ChatGPT 桌面端 agent 接入（Electron CDP + Playwright） | ⚠️ 代码完成，CDP 层用 msedge 验证过连接+错误路径，真实 DOM 未实测 |
| 11 | VS Code 双面板集成（官方 Codex + Claude 结构化执行面板） | ✅ 完成（待安装新 VSIX） |
| 12 | 任务起点文件基线、文件变化视图、停止/追加轮次/切换 Claude session | ✅ 完成 |

## 3. 目录结构

```
smart2stupid/
├─ src/
│  ├─ main.ts                 # 入口：加载配置→注册表→HTTP→热重载→接线
│  ├─ cli.ts                  # auto 命令行入口
│  ├─ auto.ts                 # 自动闭环引擎（runAuto：自问自答→执行→审核→修正迭代）
│  ├─ config/                 # schema.ts + loader.ts（default+local 深合并、${ENV}、热重载）
│  ├─ providers/              # types / registry / openaiCompat / cliAgent / playwrightWebChat / mock
│  ├─ executors/              # types / registry / detect / claude / codex / qwen / generic / chatgptDesktop / commandBuilder
│  ├─ smart/                  # orchestrator（追问+审核+修正）/ designTree / promptTemplates / brief / review / reviewContext
│  ├─ stupid/                 # orchestrator（执行编排）/ handoff / sessionLog
│  ├─ sessions/store.ts       # 会话存储 + iterations + 落盘 + 恢复
│  ├─ server/                 # httpServer（路由+token）/ sse / static / publicDir
│  └─ util/                   # spawn（.cmd shim 解析、PATH 解析、kill tree）/ path / pwTypes
├─ public/                    # 零构建前端
│  ├─ index.html/app.js/style.css   # Web UI 四视图 + 审核面板 + smart 日志面板
│  └─ auto.html/auto.js             # agent 对话时间线
├─ vscode-extension/          # VSCode/Qoder 扩展（start/stop/open/timeline/auto 命令）
├─ config/config.default.json # 默认配置（提交 git）
├─ config/config.local.json   # 本机覆盖（绝对路径 + codex 代理，gitignored）
├─ tests/fixtures/demo-repo/  # 验收用工作目录
```

## 4. 关键设计决策（重要，接手者须理解）

1. **设计树分工**：模型负责树的生成与演进（treePatch），服务端负责 frontier 的确定性计算（`smart/designTree.ts`）。
2. **brief 是共识契约**：修正指令不覆盖 brief，只注入下一轮 handoff 的「上一轮执行反馈」段（`stupid/handoff.ts`）。
3. **迭代记录**：每次执行 = 一条 `iterations[]`，挂 status/审核报告/修正指令/decision（`sessions/store.ts`）。
4. **零循环 import**：smart ↔ stupid 之间用回调桥接（`onActivity` / `onRunFinished` / `onExecEvent`），不互相 import。
5. **SSE 通道命名**：`exec:<taskId>`（执行）、`smart:<taskId>`（smart 日志）、`auto`（自动闭环全局里程碑）。
6. **CLI agent 通用化**：`providers/cliAgent.ts` 让任何一问一答的 CLI（codex/claude/qwen）都能当 smart 端。

## 5. 配置要点

`config/config.default.json`（通用）+ `config/config.local.json`（本机敏感，gitignored）两层深合并，`${ENV}` 展开，300ms 热重载。

**本机 config.local.json 关键内容**（换机器需改）：
```jsonc
{
  "providers": {
    "codex-cli": { "command": "D:/app/codex.cmd", "env": { "HTTPS_PROXY": "http://127.0.0.1:7897", "HTTP_PROXY": "..." } },
    "claude-cli": { "command": "D:/tools/node-v20.20.2-win-x64/claude.cmd" }
  },
  "executors": {
    "claude": { "command": "D:/tools/node-v20.20.2-win-x64/claude.cmd" },
    "codex": { "command": "D:/app/codex.cmd", "env": { "HTTPS_PROXY": "..." } },
    "qwen":  { "command": "D:/app/qwen.cmd" }
  }
}
```

**全局环境变量**（已写入用户级）：`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` = `http://127.0.0.1:7897`

**工具安装位置**：codex-cli、qwen-code 装在 `D:\app`（已在用户 PATH）。

## 6. 使用方式

### 推荐：官方 Codex + 结构化 Claude 面板

```text
在 Codex 对话输入：$smart2stupid <任务描述>
→ Codex 追问并展示 brief
→ 用户确认一次
→ 左侧结构化面板自动打开并实时显示 Claude 执行
→ Codex 审核；未通过时自动修正，最多三轮
```

底层命令：

```bash
npm run delegate -- run --workdir "d:/path" --brief-file "d:/path/.smart2stupid/pending/brief.md"
npm run delegate -- review --workdir "d:/path" --task-id "task-..." --verdict pass --review-file "..."
```

### 旧入口（备用）

```bash
# ① Web UI（人在环）
npm run dev          # 仅明确使用旧 Web UI 时运行

# ② 自动闭环（无人环，命令行）
npm run auto -- --prompt "任务" --workdir "d:/path" --smart codex-cli --stupid claude

# ③ VS Code 旧 Web UI
#    仅通过“smart2stupid: 打开旧版 Web UI（备用）”显式启动
```

**smart provider**：openai-compat / claude-cli / codex-cli / mock / playwright-web-chat
**stupid executor**：claude / codex / qwen / chatgpt-desktop / echo / generic

## 7. 数据落盘

```
<workdir>/.smart2stupid/
├── briefs/<taskId>/brief.md + brief.json   # 计划契约
└── sessions/<taskId>/
    ├── events.jsonl    # 执行流水（claude 干活）
    ├── smartlog.jsonl  # smart 思考原文（codex 命令+原始输出）
    ├── stdout.log      # 执行纯文本
    ├── state.json      # 会话状态 + iterations（审核/修正/decision）
    ├── tree.json       # 设计树
    └── brief.md
项目根 .smart2stupid/index.json             # 任务总索引（重启恢复）
```

## 8. 验证记录

- ✅ mock+echo 全链路（建树→追问→执行→审核→修正→迭代→结束）
- ✅ claude-cli 真实当 smart 端（自问自答 + 真实 brief）
- ✅ **codex 想 + claude 干真实闭环**：3 轮迭代，claude 实际产出 `linecount` 工具（源码 + 43 测试 + 14 夹具），codex 逐条审核 14 项（13 pass/3 unknown）
- ✅ 时间线数据链路（/api/auto/start + auto/stream + smart-stream + exec-stream）
- ✅ 错误路径：未装 executor 报安装命令、审核不可用降级、迭代上限、端口占用
- ✅ VSCode/Qoder 扩展安装

## 9. 已知限制与风险（接手者注意）

1. **Anthropic 账户 402 余额不足**：claude 执行曾中断（`402 Insufficient Balance`），需充值后稳定。
2. **codex 依赖代理**：`127.0.0.1:7897`（Clash Verge）。当前节点出口 IP（23.186.200.82 深圳乐速云中转）被 OpenAI 半拉黑，普通网页能过、API/WebSocket 会 TLS 中断；**换干净节点或走国内 OpenAI 兼容端点**可根治。config.local.json 里已配 codex 代理。
3. **chatgpt-desktop executor**：CDP 驱动逻辑完整（用 msedge 验证过 launch→connect→selector 错误路径），但真实 ChatGPT 桌面版 DOM 未实测，selector 需按实际界面调。
4. **qwen executor**：已安装未登录（首次运行交互 `/auth`），未实测执行。
5. **playwright-web-chat provider**：易碎、未实测，风险自担。
6. **git 未提交**：所有改动在工作区，尚未 commit。
7. 审核材料截断预算 10k 字符，证据不足时审核会诚实地判 `unknown`（导致 verdict=partial 而非 pass，属正常行为）。
8. 官方 Claude Code 面板不支持由第三方扩展自动提交 prompt。实时过程显示在 smart2stupid 结构化面板；每轮结束后可按 session ID 打开官方 Claude 会话。
9. `claude -p` 自动化会话不会自然出现在普通 picker 中，必须使用面板按钮或明确 session ID 打开。

## 10. 接手后建议的下一步

1. `git init` 已做，**做首次 commit**（当前零提交）。
2. 充值 Anthropic 或换 codex 代理节点，把真实闭环冲到 `verdict=pass`。
3. chatgpt-desktop 装好后（已装 `D:\app\ChatGPT.exe`），实测并调 selector。
4. 若需更紧密的 agent 实时对话/辩论，可在此架构上加一层（当前是文档接力式闭环）。
