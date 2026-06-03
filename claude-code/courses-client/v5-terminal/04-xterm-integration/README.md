# 04 - xterm.js 集成

## 当前章节目标

本章实现 Terminal UI。

完成后，用户可以在页面中看到真实终端输出，并输入命令。

## 安装

```bash
pnpm add xterm @xterm/addon-fit
```

## XtermTerminal

```tsx
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";

export function XtermTerminal({
  sessionId,
  api,
}: {
  sessionId: string;
  api: TerminalIpcApi;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#111111",
        foreground: "#f4f1ed",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current!);
    fitAddon.fit();

    const inputDisposable = terminal.onData(data => {
      void api.writeTerminal(sessionId, data);
    });

    const outputDispose = api.onTerminalData(event => {
      if (event.sessionId === sessionId) {
        terminal.write(event.data);
      }
    });

    terminalRef.current = terminal;

    return () => {
      inputDisposable.dispose();
      outputDispose();
      terminal.dispose();
    };
  }, [api, sessionId]);

  return <div className="xterm-container" ref={containerRef} />;
}
```

## Resize

```ts
function resizeTerminal() {
  fitAddon.fit();
  const dimensions = fitAddon.proposeDimensions();
  if (!dimensions) return;

  void api.resizeTerminal(sessionId, {
    cols: dimensions.cols,
    rows: dimensions.rows,
  });
}
```

生产实现要监听容器尺寸，而不是只监听 window resize。

推荐用 `ResizeObserver`：

```tsx
useEffect(() => {
  const element = containerRef.current;
  if (!element) return;

  const observer = new ResizeObserver(() => resizeTerminal());
  observer.observe(element);
  resizeTerminal();

  return () => observer.disconnect();
}, [resizeTerminal]);
```

每次 fit 后都要把 `cols`、`rows` 传回 main 进程，否则 shell 里的 `vim`、`less`、测试 watch UI 会错位。

## TerminalLayout

```tsx
export function TerminalLayout({ state, api }: TerminalLayoutProps) {
  const active = selectActiveTerminalSession(state);

  if (!active) {
    return <button onClick={() => createTerminal()}>New Terminal</button>;
  }

  return (
    <section className="terminal-layout">
      <TerminalTabs state={state} />
      <XtermTerminal sessionId={active.id} api={api} />
    </section>
  );
}
```

## 本章实操：xterm 输入、输出、resize、dispose

### 专属改动文件

```text
src/renderer/components/XtermTerminal.tsx
src/renderer/components/TerminalLayout.tsx
src/renderer/components/TerminalTabs.tsx
src/renderer/terminal/terminalActions.ts
src/renderer/terminal/selectors.ts
src/renderer/styles/terminal.css
```

### 实现步骤

1. 执行安装命令，并在 `XtermTerminal.tsx` import `xterm/css/xterm.css`。
2. 组件 mount 时创建 `new Terminal()` 和 `new FitAddon()`，`terminal.open(container)` 后立即 `fit()`。
3. `terminal.onData` 调用 `api.writeTerminal(sessionId, data)`，不要写入 store；store 的输出来自 PTY data event。
4. `api.onTerminalData` 收到当前 session data 后调用 `terminal.write(data)`。
5. 用 `ResizeObserver` 监听容器尺寸，fit 后调用 `api.resizeTerminal(sessionId, { cols, rows })`。
6. 组件 unmount 时按顺序清理：取消 IPC listener、dispose xterm onData、dispose terminal；关闭 tab 时额外调用 `api.disposeTerminal(sessionId)`。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm add xterm @xterm/addon-fit
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，Terminal panel 出现真实 shell prompt；输入 `pwd` 能看到 workspace root；拖动 panel 尺寸后输入 `stty size`，行列数应接近当前 xterm 尺寸；关闭 tab 后 shell 不再接收输入。

### 常见报错

- xterm 显示空白：确认容器有高度，且 `terminal.open()` 时 `containerRef.current` 不为空。
- 输入重复显示：不要在 `onData` 本地 `terminal.write(data)`，回显应由 PTY 返回。
- resize 后 curses UI 错位：确认 `FitAddon.proposeDimensions()` 后调用了 main `resizeTerminal`。
- 切换 tab 后输出写错终端：IPC listener 必须按 `event.sessionId === sessionId` 过滤。

## 可运行验收

本章验收：

- xterm 能渲染 PTY prompt 和 ANSI 颜色。
- 用户输入经 IPC 写入 PTY。
- PTY 输出经 IPC 写回 xterm 和 terminalStore。
- resize 同步到 PTY。
- unmount 和 close tab 会清理 listener、xterm 和 PTY。

## 当前章节缺陷

本章只实现单个 active terminal 的基础显示，没有 split、links、shell integration。

## 下一章预告

下一章会实现命令执行与实时输出：从 UI 快捷操作触发测试、构建等命令，并持续显示输出。
