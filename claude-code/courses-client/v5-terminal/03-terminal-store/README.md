# 03 - Terminal Store

## 当前章节目标

本章实现 Renderer 侧 Terminal Store。

完成后，UI 可以管理：

- terminal sessions。
- active terminal。
- 输出缓冲。
- terminal 状态。

## TerminalState

```ts
export type TerminalState = {
  workspaceId: string | null;
  sessions: Record<string, TerminalSessionView>;
  activeSessionId: string | null;
  status: "idle" | "creating" | "ready" | "error";
  error: string | null;
};

export type TerminalSessionView = TerminalSession & {
  output: string;
  createdAt: number;
  exitedAt: number | null;
};
```

## 输出缓冲

不要无限保存终端输出。

```ts
const MAX_TERMINAL_OUTPUT_CHARS = 200_000;

export function appendTerminalOutput(output: string, data: string): string {
  const next = output + data;
  if (next.length <= MAX_TERMINAL_OUTPUT_CHARS) {
    return next;
  }

  return next.slice(next.length - MAX_TERMINAL_OUTPUT_CHARS);
}
```

UI 侧 xterm.js 自己有 buffer，Store 中只保留轻量 transcript，用于 Agent Bridge 或调试。

## Actions

```ts
export type TerminalAction =
  | { type: "create_started"; workspaceId: string }
  | { type: "created"; session: TerminalSession; now: number }
  | { type: "data_received"; sessionId: string; data: string }
  | { type: "exited"; sessionId: string; exitCode: number | undefined; now: number }
  | { type: "activated"; sessionId: string }
  | { type: "failed"; message: string };
```

## Reducer

```ts
export function terminalReducer(
  state: TerminalState,
  action: TerminalAction,
): TerminalState {
  switch (action.type) {
    case "created":
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.session.id]: {
            ...action.session,
            output: "",
            createdAt: action.now,
            exitedAt: null,
          },
        },
        activeSessionId: action.session.id,
        status: "ready",
      };

    case "data_received": {
      const session = state.sessions[action.sessionId];
      if (!session) return state;

      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.sessionId]: {
            ...session,
            output: appendTerminalOutput(session.output, action.data),
          },
        },
      };
    }

    case "exited": {
      const session = state.sessions[action.sessionId];
      if (!session) return state;

      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.sessionId]: {
            ...session,
            status: "exited",
            exitedAt: action.now,
          },
        },
      };
    }

    default:
      return state;
  }
}
```

## Workspace 切换

切换 Workspace 时，应关闭旧 terminal 或明确保留为后台 project terminal。

V5 教学版采用简单策略：

```text
workspace changed
  -> dispose old terminals
  -> reset TerminalState
  -> create new terminal on demand
```

## 本章实操：renderer terminalStore

本章把 PTY 生命周期变成 UI 可消费的状态。它不负责渲染 ANSI，ANSI 渲染留给 xterm.js。

### 专属改动文件

```text
src/renderer/terminal/types.ts
src/renderer/terminal/terminalStore.ts
src/renderer/terminal/terminalActions.ts
src/renderer/terminal/selectors.ts
src/renderer/terminal/terminalStore.test.ts
src/renderer/components/TerminalTabs.tsx
src/renderer/components/TerminalStatusBar.tsx
```

### 实现步骤

1. 在 `types.ts` 定义 `TerminalSessionView`，把 main 返回的 session 加上 `output`、`createdAt`、`exitedAt`。
2. 在 `terminalStore.ts` 实现 reducer：`create_started`、`created`、`data_received`、`exited`、`activated`、`disposed`、`failed`。
3. `appendTerminalOutput` 必须做最大长度裁剪，默认保留最近 `200_000` 字符。
4. 在 `terminalActions.ts` 封装 `createTerminal(workspaceId, size)`，调用 preload API 后 dispatch `created`。
5. 订阅 `window.clientTerminal.onTerminalData` 和 `onTerminalExit`，收到事件后 dispatch 到 store。
6. `TerminalTabs` 显示 session shell、running/exited 状态；`TerminalStatusBar` 显示 cwd、cols、rows。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，点击 `New Terminal` 会新增一个 terminal tab，状态栏显示 shell 和 cwd；执行 `echo hello` 后，store transcript 中可以看到最近输出，关闭 session 后 tab 状态变为 `exited` 或被移除。

### 常见报错

- terminal 输出越来越卡：确认 store 只存裁剪 transcript，xterm 自己维护屏幕 buffer。
- data event 找不到 session：可能 renderer 订阅晚于 main 首次 prompt；允许忽略未知 session，或创建 session 后立即订阅。
- workspace 切换串 session：workspace change 时调用 dispose old sessions，并 reset store。

## 可运行验收

本章验收：

- 创建 terminal 后 `activeSessionId` 指向新 session。
- PTY data 会进入对应 session transcript。
- transcript 超长会裁剪。
- exit event 会更新 session 状态。
- reducer 和 selector 有单测。

## 当前章节缺陷

本章还没有 xterm.js UI，只是管理状态。

## 下一章预告

下一章会接入 xterm.js，把 PTY data 渲染为真实终端界面，并把用户输入写回 PTY。
