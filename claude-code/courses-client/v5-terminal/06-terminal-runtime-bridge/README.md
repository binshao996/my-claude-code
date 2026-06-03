# 06 - Terminal 与 Runtime Bridge

## 当前章节目标

本章建立 Terminal 和 Agent Runtime 的边界。

完成后：

- 用户 Terminal 继续作为交互式 shell。
- Agent 命令继续走 `run_command`。
- Chat 可以展示 terminal context，但不会自动泄露完整输出。

## Agent 为什么不能直接使用用户 Terminal

用户 Terminal 是开放交互环境：

- 可能正在运行 dev server。
- 可能在 vim/tmux 中。
- 可能有未完成输入。
- 输出无法稳定分段。
- exit code 不可靠。

Agent 工具执行需要结构化结果：

```text
exitCode
stdout
stderr
durationMs
truncated
```

当前 Runtime 的 `run_command` 已经提供这个方向：

```text
run_command
  -> SandboxPolicyEngine.decideCommand()
  -> Permission
  -> runCommand()
  -> formatted result
```

所以 Agent 不写用户 PTY。

## TerminalRuntimeContext

```ts
export type TerminalRuntimeContext = {
  activeTerminal: {
    sessionId: string;
    cwd: string;
    shell: string;
    status: "running" | "exited";
  } | null;
  recentOutputPreview: string | null;
};
```

## 构建上下文

```ts
export function buildTerminalRuntimeContext(
  state: TerminalState,
): TerminalRuntimeContext {
  const active = selectActiveTerminalSession(state);

  if (!active) {
    return { activeTerminal: null, recentOutputPreview: null };
  }

  return {
    activeTerminal: {
      sessionId: active.id,
      cwd: active.cwd,
      shell: active.shell,
      status: active.status,
    },
    recentOutputPreview: active.output.slice(-4000),
  };
}
```

生产实现应默认不注入 `recentOutputPreview`，除非用户明确允许。

## 用户要求 Agent 运行命令

当用户在 Chat 里说：

```text
运行测试
```

正确路径是：

```text
Chat prompt
  -> Runtime
  -> tool_use run_command
  -> Sandbox / Permission
  -> tool_result
  -> Chat / Agent Activity
```

不是：

```text
Chat prompt
  -> terminal.write("bun test\r")
```

## 用户要求分析 Terminal 输出

正确产品动作：

```text
Analyze latest terminal output
  -> ask user confirmation
  -> collect bounded output preview
  -> add to prompt context
```

这保证用户知道 terminal 输出会进入模型上下文。

## 本章实操：TerminalRuntimeBridge 和 run_command 边界

### 专属改动文件

```text
src/renderer/terminal/terminalRuntimeBridge.ts
src/renderer/terminal/selectors.ts
src/renderer/components/TerminalStatusBar.tsx
src/runtime/runCommand.ts
src/runtime/runtimeContext.ts
src/renderer/agent-workspace/runtimeCommandEvents.ts
```

最后一个文件如果 V6 尚未实现，可以先放在现有 Runtime event adapter 中，目标是让 Agent 命令结果进入 Agent Workspace，而不是 Terminal。

### 实现步骤

1. 实现 `buildTerminalRuntimeContext(state)`，只返回 active session 的 `sessionId`、`cwd`、`shell`、`status`。
2. `recentOutputPreview` 默认返回 `null`；只有用户点击“分析最近终端输出”并确认后，才返回裁剪后的输出。
3. 检查 Chat prompt handler：用户说“运行测试”时触发 Runtime `run_command` 工具链，不调用 `writeTerminal`。
4. 检查 Runtime `run_command` result：结构化结果进入 Chat 或 V6 Agent Workspace event，不写入用户 PTY。
5. 在 Terminal 状态栏显示 `Agent commands use Runtime run_command` 或等价短提示，避免读者误接。
6. 给 bridge 写测试：active terminal、no terminal、exited terminal、recent output opt-in。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，用户 terminal 可以正常交互；在 Chat 中让 Agent 运行 `pwd`，Terminal 不会被写入命令，Agent 的结果出现在 Chat/Agent Activity 中。Terminal context/debug 只显示 cwd、shell、status，不显示完整输出。

### 常见报错

- Agent 命令出现在用户 terminal：搜索 `writeTerminal(` 调用点，确保 Chat/Runtime 没接到它。
- Agent 看到了敏感 terminal 输出：默认不要注入 transcript，分析输出必须用户确认且做长度裁剪。
- Runtime 结果没有 exit code：说明误用了交互式 terminal；应回到 `run_command` 结构化执行路径。

## 可运行验收

本章验收：

- `buildTerminalRuntimeContext` 有单测。
- Chat 触发 Agent 命令时不调用 terminal IPC。
- Runtime `run_command` 保留 sandbox、permission、exitCode、stdout/stderr。
- terminal transcript 默认不会进入模型上下文。

## 当前章节缺陷

V5 只建立 Bridge 边界，不实现完整 Agent Workspace。

## 下一版本预告

V6 会实现 Agent Workspace。

它会把 V1 的 Tool Activity、V5 的命令结果、V0 的 Runtime Events 统一成更完整的 Agent 执行观察面板：

```text
Plan
Tool calls
Command results
Context updates
Permission prompts
```

到 V6，用户能在一个专门区域观察 Agent 执行状态。
