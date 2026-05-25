# 07. Remote、Background 与高级 Agent 能力

## Remote/CCR

CCR remote 让本地 TUI 连接远程 session。核心模块：

- `src/remote/RemoteSessionManager.ts`
- `src/remote/SessionsWebSocket.ts`
- `src/remote/sdkMessageAdapter.ts`
- `src/remote/remotePermissionBridge.ts`
- `src/hooks/useRemoteSession.ts`

职责：

- 创建/订阅远程 session。
- 将 SDK message 转为本地 `Message`。
- 将远程 permission request 桥接到本地权限 UI。
- 支持 interrupt、status、rate limit、tool progress。

## Bridge / Remote Control

Remote Control Bridge 让本机作为可被远程控制的执行环境。

关键源码：

- `src/bridge/bridgeMain.ts`
- `src/bridge/replBridge.ts`
- `src/bridge/bridgeMessaging.ts`
- `src/bridge/sessionRunner.ts`
- `src/bridge/bridgePermissionCallbacks.ts`
- `src/hooks/useReplBridge.tsx`

能力：

- bridge loop。
- inbound messages / attachments。
- permission callback。
- result scheduling。
- trusted device/work secret。
- bridge command safety。

## Direct Connect / Server

CLI 中有 `server` 子命令和 direct connect URL 处理：

- `src/server/*`
- `src/hooks/useDirectConnect.ts`
- `src/server/createDirectConnectSession.ts`

参考源码中部分 direct server 文件是 stub/auto-generated 状态，但入口和 TUI 接入点已经存在。重新实现时可先不做完整 server，但应保留 session transport 抽象。

## SSH

SSH 模式本地渲染 UI，远端执行命令/工具：

- `src/ssh/*`
- `src/services/ssh/*`
- `src/hooks/useSSHSession.ts`

该模式要求 tool execution context 能表达“执行环境”和“本地 UI”分离。

## Daemon 与后台 session

Daemon 统一管理后台能力：

- `src/daemon/main.ts`
- `src/daemon/workerRegistry.ts`
- `src/daemon/state.ts`
- `src/cli/bg/*`

`cli/bg/engine.ts` 抽象两类后台执行：

- `TmuxEngine`: 支持交互 attach。
- `DetachedEngine`: detached process + log tail。

daemon 子命令包含：

- `start`
- `stop`
- `status`
- `bg`
- `attach`
- `logs`
- `kill`

## Subagents 和任务

Subagent 不是简单递归调用模型，而是有自己的上下文、工具过滤、权限、输出、任务状态。

关键源码：

- `packages/builtin-tools/src/tools/AgentTool/*`
- `src/services/agent/*`
- `src/utils/agentContext.ts`
- `src/utils/swarm/*`
- `src/coordinator/*`
- `src/tasks/*`
- `packages/builtin-tools/src/tools/Task*`

能力：

- built-in agents 和 custom agents。
- agent tool filtering。
- async agent/task。
- coordinator mode。
- swarm worker permission forwarding。
- task list tools。

## Worktree

Worktree 支持并行开发会话：

- `src/utils/worktree.ts`
- `src/utils/worktreeModeEnabled.ts`
- `packages/builtin-tools/src/tools/EnterWorktreeTool/*`
- `packages/builtin-tools/src/tools/ExitWorktreeTool/*`
- `src/components/WorktreeExitDialog.tsx`

实现重点：工作区路径、branch、session 和权限目录都要联动。

## Cron、monitor、proactive

源码中有多类自动化能力：

- Cron tools: 定期触发 prompt。
- Monitor tool/task: 监控 MCP 或环境。
- Proactive/Kairos: 主动建议或 assistant session。
- Sleep tool: 等待/定时唤醒。

关键源码：

- `src/services/cron/*`
- `packages/builtin-tools/src/tools/Cron*`
- `packages/builtin-tools/src/tools/MonitorTool/*`
- `src/proactive/*`
- `src/assistant/*`

## Browser、Chrome、Computer Use、Voice

高级交互能力：

- Claude in Chrome MCP/native host。
- WebBrowser tool。
- Computer use MCP。
- Voice mode。
- image processing/native packages。

关键源码：

- `src/utils/claudeInChrome/*`
- `packages/@ant/claude-for-chrome-mcp/*`
- `packages/@ant/computer-use-*`
- `packages/builtin-tools/src/tools/WebBrowserTool/*`
- `src/voice/*`

## 重新实现建议

建议分阶段：

1. 第一阶段只实现本地 interactive/headless。
2. 第二阶段实现 session persistence 和 background detached。
3. 第三阶段实现 subagent/task。
4. 第四阶段实现 MCP/remote permission bridge。
5. 第五阶段实现 daemon/remote/SSH/worktree/browser 等高级能力。

如果一开始同时做 remote、daemon、TUI、agent loop，会导致接口频繁返工。先把 event/message/tool/permission/session 这几个核心边界打稳。

