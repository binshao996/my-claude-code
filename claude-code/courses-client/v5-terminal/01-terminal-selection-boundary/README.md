# 01 - Terminal 选型与边界

## 当前章节目标

本章明确 Terminal 的技术选型和边界。

结论：

```text
Terminal frontend: xterm.js
PTY backend: node-pty
Agent command path: Runtime run_command
```

## 为什么选择 xterm.js

Terminal 不能用普通 `<textarea>` 或 `<pre>` 实现。

真实终端需要：

- ANSI escape sequence。
- 光标移动。
- 颜色。
- 交互式输入。
- resize。
- curses 程序。
- shell prompt。

xterm.js 是主流 Web Terminal 前端。它不是 shell，也不是 PTY；它负责把终端字节流渲染成用户看到的终端界面。

## 为什么需要 PTY

普通 `child_process.exec()` 只能运行一次性命令，不适合交互式终端。

交互式终端需要：

```text
shell process
  <-> pseudo terminal
  <-> xterm.js
```

所以 V5 使用 `node-pty`。

## 用户 Terminal 和 Agent run_command 的区别

这是本章最重要的边界。

用户 Terminal：

```text
用户自己输入
  -> xterm.js
  -> PTY
  -> shell
```

Agent 命令：

```text
Agent tool_use run_command
  -> ToolRunner
  -> SandboxPolicyEngine
  -> Permission
  -> runCommand()
```

Agent 不应该直接写入用户 PTY。原因：

- 无法稳定解析退出码。
- 无法做权限审批。
- 无法控制输出截断。
- 无法保证命令生命周期。
- 用户终端可能正在运行别的程序。

## 本章实操：先画出 Terminal 和 run_command 的分界线

本章不创建 PTY，但要让 UI 上出现 Terminal 面板位置，并在代码里固定两条路径的命名。

### 专属改动文件

```text
src/main/terminal/TerminalService.ts       # 用户 terminal 最小入口
src/main/ipc/terminalIpc.ts                # terminal:* IPC 最小入口
src/preload/terminalApi.ts                 # window.clientTerminal 最小入口
src/renderer/terminal/types.ts             # TerminalState / TerminalSessionView
src/renderer/components/TerminalLayout.tsx # Terminal panel 空状态
src/runtime/runCommand.ts                  # 仅引用现有 Runtime 命令路径，不改实现
```

### 实现步骤

1. 在 `types.ts` 定义 `TerminalSession`、`TerminalState` 和 `TerminalRuntimeContext` 的导出位置。
2. 在 `TerminalLayout.tsx` 渲染 `New Terminal` 按钮和一行边界提示：用户 terminal 不等于 Agent command。
3. 在 preload 暴露 `window.clientTerminal` API 名称：`createTerminal`、`writeTerminal`、`resizeTerminal`、`disposeTerminal`、`onTerminalData`。
4. 在 Runtime 命令入口保留现有 `run_command` 调用链，不从 terminal store import 任何东西。
5. 在产品 UI 中把 Agent 命令结果放到 V6 Agent Workspace 预留区域，而不是 Terminal panel。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，Editor 下方或右侧出现 Terminal panel 空状态和 `New Terminal` 按钮；DevTools 中 `window.clientTerminal` 存在。此时点击按钮可以先提示“PTY not implemented”，但 UI 落点和 API 边界已经固定。

### 常见报错

- Agent 输出进入 Terminal：检查 Chat/Runtime 代码，`run_command` result 应进入 Chat 或 Agent Workspace，不应调用 `writeTerminal`。
- `window.clientTerminal` 不存在：确认 preload 入口 import 了 `terminalApi.ts`。
- Terminal 面板挤压 Editor：先给 Terminal panel 固定高度或可折叠布局，避免破坏 V4。

## 可运行验收

本章验收：

- Terminal panel 空状态可见。
- `window.clientTerminal` API 名称固定。
- Runtime `run_command` 没有依赖 terminal store 或 PTY。
- `pnpm typecheck` 通过。

## 当前章节缺陷

本章只定义选型和边界，不创建 PTY。

## 下一章预告

下一章会实现 PTY Service：在主进程创建 shell、接收输入、输出数据、resize 和关闭。
