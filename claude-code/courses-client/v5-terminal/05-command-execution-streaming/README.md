# 05 - 命令执行与实时输出

## 当前章节目标

本章实现从 UI 触发常用命令，并在 Terminal 中实时显示输出。

注意：这里说的是用户通过 Terminal 运行命令，不是 Agent 工具执行。

## Command Shortcut

```ts
export type CommandShortcut = {
  id: string;
  label: string;
  command: string;
};

export const DEFAULT_COMMAND_SHORTCUTS: CommandShortcut[] = [
  { id: "typecheck", label: "Typecheck", command: "bun run typecheck" },
  { id: "test", label: "Test", command: "bun test" },
  { id: "build", label: "Build", command: "bun run build" },
];
```

这些命令只是用户快捷入口，不代表 Agent 可以自动执行。

## 写入 Terminal

```ts
export async function runCommandInTerminal(
  api: TerminalIpcApi,
  sessionId: string,
  command: string,
): Promise<void> {
  await api.writeTerminal(sessionId, `${command}\r`);
}
```

为什么是 `\r`：终端回车通常发送 carriage return。

## CommandShortcutBar

```tsx
export function CommandShortcutBar({
  sessionId,
  api,
}: {
  sessionId: string;
  api: TerminalIpcApi;
}) {
  return (
    <div className="command-shortcut-bar">
      {DEFAULT_COMMAND_SHORTCUTS.map(shortcut => (
        <button
          key={shortcut.id}
          type="button"
          onClick={() => void runCommandInTerminal(api, sessionId, shortcut.command)}
        >
          {shortcut.label}
        </button>
      ))}
    </div>
  );
}
```

## 输出归档

V5 可以把 terminal 输出保存在轻量 ring buffer 中，但不要把完整 terminal transcript 自动注入模型。

原因：

- 输出可能包含 secrets。
- 输出可能非常长。
- 用户 terminal 和 Agent tool result 不是同一权限语义。

如果用户希望 Agent 分析 terminal 输出，应该通过明确动作触发：

```text
Analyze latest terminal output
```

## 本章实操：用户快捷命令进入交互式 Terminal

本章做的是“替用户输入命令到当前 terminal”，不是结构化任务系统。

### 专属改动文件

```text
src/renderer/terminal/commandShortcuts.ts
src/renderer/terminal/terminalActions.ts
src/renderer/components/CommandShortcutBar.tsx
src/renderer/components/TerminalLayout.tsx
src/renderer/terminal/terminalRuntimeBridge.ts
```

### 实现步骤

1. 在 `commandShortcuts.ts` 定义当前项目可用快捷命令，命令文案按项目脚本选择，例如 `bun run typecheck` 或 `pnpm typecheck`。
2. `runCommandInTerminal(api, sessionId, command)` 只做 `writeTerminal(sessionId, command + "\r")`。
3. `CommandShortcutBar` 只在 active terminal running 时显示；exited session 不显示快捷按钮。
4. 输出仍由 PTY data 进入 xterm 和 store，不为快捷命令额外开 `child_process`。
5. 在 `terminalRuntimeBridge.ts` 只保留最近输出摘要函数，默认不自动发给模型。
6. 如果用户点击 `Analyze latest terminal output`，先弹确认，再把裁剪后的 `recentOutputPreview` 加入 prompt context。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，Terminal 顶部出现 `Typecheck`、`Test`、`Build` 等按钮；点击 `Typecheck` 后，命令文本出现在当前 terminal，输出实时流式显示在 xterm 中，terminalStore transcript 保存最近输出。

### 常见报错

- 命令没有执行只是停在 prompt：确认写入的是 `\r`，不是只写命令文本。
- 快捷命令跑错项目：确认 terminal session cwd 是 workspace root，不是 Electron app cwd。
- 用户正在 vim/tmux 时快捷按钮插入命令：教学版可以禁用快捷按钮，生产版需要 shell integration 判断 prompt 状态。
- Agent 自动触发快捷按钮：不允许，Agent 命令必须走 Runtime `run_command`。

## 可运行验收

本章验收：

- 快捷按钮会把命令写入 active terminal。
- 输出实时显示并进入 transcript 裁剪缓冲。
- exited terminal 不允许运行快捷命令。
- Chat/Agent 不会调用 `runCommandInTerminal`。

## 当前章节缺陷

本章不能稳定拿到一次命令的 exit code，因为交互式 shell 不是结构化命令执行器。

如果需要稳定 exit code，应该使用 Runtime `run_command` 路径。

## 下一章预告

下一章会建立 Terminal 与 Runtime Bridge，明确何时使用用户 Terminal，何时使用 Agent `run_command`。
