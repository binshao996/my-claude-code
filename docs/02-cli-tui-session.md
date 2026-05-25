# 02. CLI、TUI 与会话系统

## CLI fast path

`src/entrypoints/cli.tsx` 是真正入口。它先处理不需要完整 CLI 的路径，再动态导入 `src/main.tsx`。

典型 fast path：

- `--version`
- `--dump-system-prompt`
- `--claude-in-chrome-mcp`
- `--chrome-native-host`
- `--computer-use-mcp`
- `--acp`
- `weixin`
- `--daemon-worker=<kind>`
- `remote-control|rc|remote|sync|bridge`
- `daemon`
- `autonomy`
- `--bg|--background`
- `job`
- `environment-runner`
- `--worktree + --tmux`
- `--update|--upgrade`
- `--bare`

设计重点：小命令不加载 Commander、React、TUI、大量 services，降低启动时间。

## main.tsx 的职责

`src/main.tsx` 是完整 CLI bootstrap：

- 启动 profiler、MDM raw read、keychain prefetch。
- 处理 deep link / `cc://` / SSH / assistant viewer / remote。
- 加载 settings、managed settings、policy limits、GrowthBook。
- 初始化 auth、provider、model、permissions、MCP、plugins、skills。
- 注册 Commander root options 和 subcommands。
- 根据模式进入 headless、interactive REPL、remote、server、ssh 等分支。

它不是普通命令注册文件，而是整个 runtime 的启动装配器。

## 运行模式

| 模式 | 触发 | 说明 |
| --- | --- | --- |
| Interactive REPL | 默认 | Ink TUI，本地模型调用和工具执行 |
| Headless print | `-p/--print` | 非交互，输出 text/json/stream-json |
| Remote/CCR | `--remote` | 本地 TUI 连接远程 session |
| Assistant viewer | `claude assistant [sessionId]` | viewer-only 远程会话 |
| SSH | `claude ssh <host> [dir]` | 本地 UI，远程执行 |
| Direct Connect | `cc://...` 或 `server` | 本地 server/session 连接 |
| Bridge/remote-control | `remote-control|bridge` | 本机作为远程控制环境 |
| Daemon/background | `daemon`, `--bg` | 后台 session、tmux/detached |

## TUI 根结构

TUI 启动链路：

1. `main.tsx` 创建初始 `AppState`、stats、render root。
2. `replLauncher.tsx` 渲染 `<App><REPL /></App>`。
3. `components/App.tsx` 提供 `FpsMetricsProvider`、`StatsProvider`、`AppStateProvider`、`ThemeProvider`。
4. `screens/REPL.tsx` 管理主交互。

关键组件：

- `screens/REPL.tsx`: 主屏幕和 query orchestration。
- `components/PromptInput/PromptInput.tsx`: 输入、补全、footer、快捷键。
- `components/VirtualMessageList.tsx`: 长会话虚拟列表。
- `components/Messages.tsx` 和 `components/messages/*`: 消息渲染。
- `components/permissions/*`: 工具权限请求 UI。
- `components/StatusLine.tsx`: 状态栏。
- `components/CompactSummary.tsx`, `TokenWarning.tsx`, `ToolUseLoader.tsx`: agent loop 辅助 UI。

## REPL 内部状态

`REPL.tsx` 是超大组件，核心状态包括：

- `messages`: 当前 transcript。
- `messagesRef`: 避免异步闭包拿到旧消息。
- `inputValue`: 当前输入。
- `screen`: prompt/transcript 等显示状态。
- `toolUseConfirmQueue`: 权限弹窗队列。
- `promptQueue`: 用户在 loading 时提交的输入队列。
- `streamingToolUses`: 流式工具调用状态。
- remote/direct/ssh 相关 transport 状态。
- AppState 中的 MCP、plugins、skills、commands、permission context。

提交路径：

1. PromptInput 调用 `handlePromptSubmit()`。
2. 解析 slash command、bash shortcut、queued prompt、attachments。
3. 构造 user message。
4. 调用 `onQuery()`。
5. `onQueryImpl()` 调用 `query()`。
6. `onQueryEvent()` 将 stream event/message 写入 UI 和 transcript。

## 命令体系

命令类型定义在 `src/types/command.ts`：

- `prompt`: 展开为模型可见 prompt，可限制 allowed tools。
- `local`: 本地执行，返回文字、compact、skip 等结果。
- `local-jsx`: 打开本地 Ink UI。

命令来源：

- 内置命令：`src/commands.ts` 汇总。
- skill commands: user/bundled/plugin/MCP skills。
- plugin commands。
- workflow commands。

`getCommands(cwd)` 会合并上述来源，并按 auth/provider/feature/remote safety 过滤。

典型命令模块：

- `/help`, `/clear`, `/compact`, `/context`, `/memory`
- `/mcp`, `/plugin`, `/skills`
- `/model`, `/permissions`, `/status`, `/usage`
- `/resume`, `/session`, `/export`, `/history`
- `/doctor`, `/ide`, `/terminalSetup`
- `/agents`, `/tasks`, `/workflows`

## 会话持久化与恢复

会话恢复不是“加载文本历史”这么简单。源码会恢复：

- JSONL transcript messages。
- session id、project path、cwd。
- file history / read file state。
- todo/task state。
- selected model、agent、mode。
- worktree/session metadata。
- compact boundary 和 attachment 信息。

关键源码：

- `src/utils/sessionStorage.ts`
- `src/utils/sessionRestore.ts`
- `src/utils/conversationRecovery.ts`
- `src/screens/REPL.tsx`
- `src/commands/resume/*`

## 重新实现建议

优先搭出：

1. CLI fast path 和 main bootstrap 分离。
2. TUI 只消费 query event，不内嵌 agent loop。
3. transcript 格式固定，先支持 append/resume。
4. command 类型固定，再逐步补命令。
5. permission queue 和 prompt queue 先做成可测试状态机。

