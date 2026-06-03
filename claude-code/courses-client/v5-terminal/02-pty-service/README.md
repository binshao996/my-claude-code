# 02 - PTY Service

## 当前章节目标

本章实现主进程侧 `TerminalService`。

完成后，Client 可以：

- 创建 shell。
- 写入用户输入。
- 接收实时输出。
- resize。
- dispose。

## TerminalSession

```ts
export type TerminalSession = {
  id: string;
  workspaceId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
};
```

## shell profile

```ts
export function getDefaultShell(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }

  return process.env.SHELL || "/bin/zsh";
}
```

生产实现要支持用户配置 profile，比如 zsh、bash、fish、PowerShell。

## TerminalService

```ts
import pty from "node-pty";

export class TerminalService {
  private readonly sessions = new Map<string, pty.IPty>();

  createSession(input: {
    workspace: Workspace;
    cols: number;
    rows: number;
    onData(sessionId: string, data: string): void;
    onExit(sessionId: string, exitCode: number | undefined): void;
  }): TerminalSession {
    const id = crypto.randomUUID();
    const shell = getDefaultShell();

    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd: input.workspace.rootPath,
      env: process.env,
    });

    ptyProcess.onData(data => input.onData(id, data));
    ptyProcess.onExit(event => input.onExit(id, event.exitCode));

    this.sessions.set(id, ptyProcess);

    return {
      id,
      workspaceId: input.workspace.id,
      cwd: input.workspace.rootPath,
      shell,
      cols: input.cols,
      rows: input.rows,
      status: "running",
    };
  }

  write(sessionId: string, data: string): void {
    this.requireSession(sessionId).write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.requireSession(sessionId).resize(cols, rows);
  }

  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.kill();
    this.sessions.delete(sessionId);
  }

  private requireSession(sessionId: string): pty.IPty {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Terminal session not found: ${sessionId}`);
    }
    return session;
  }
}
```

## IPC 设计

```ts
export type TerminalIpcApi = {
  createTerminal(workspaceId: string, size: { cols: number; rows: number }): Promise<TerminalSession>;
  writeTerminal(sessionId: string, data: string): Promise<void>;
  resizeTerminal(sessionId: string, size: { cols: number; rows: number }): Promise<void>;
  disposeTerminal(sessionId: string): Promise<void>;
  onTerminalData(handler: (event: TerminalDataEvent) => void): () => void;
};
```

## 原生模块常见报错

`node-pty` 是原生模块，本章最容易卡在 Electron ABI：

| 报错 | 常见原因 | 处理 |
| --- | --- | --- |
| `Cannot find module ... pty.node` | 没有构建 native binding | 重新安装或执行 Electron rebuild |
| `Module did not self-register` | Node ABI 与 Electron ABI 不一致 | 用当前 Electron 版本 rebuild |
| `gyp ERR! find Python` | node-gyp 缺 Python | 安装 Python 3 并配置 node-gyp |
| macOS `xcrun: error` | 缺 Xcode CLI | `xcode-select --install` |
| Windows `MSB8020` | 缺 C++ build tools | 安装 Visual Studio Build Tools |
| 打包后能启动但 terminal 空白 | `pty.node` 被打进 asar | 配置 asarUnpack native module |

如果项目使用 Electron Forge / electron-builder，把 rebuild 命令放到安装后脚本或打包流水线里，不要让读者手工复制 `pty.node`。

## 本章实操：main 进程创建和管理 PTY

### 专属改动文件

```text
src/main/terminal/terminalProfiles.ts
src/main/terminal/TerminalService.ts
src/main/ipc/terminalIpc.ts
src/preload/terminalApi.ts
src/renderer/terminal/types.ts
```

### 实现步骤

1. 执行 `pnpm add node-pty`，如 Electron 项目已有 native rebuild 流程，把 `node-pty` 纳入该流程。
2. 在 `terminalProfiles.ts` 实现 `getDefaultShell()`，macOS/Linux 使用 `process.env.SHELL || "/bin/zsh"`，Windows 使用 `powershell.exe`。
3. 在 `TerminalService` 用 `pty.spawn` 创建 shell，cwd 必须是 `workspace.rootPath`。
4. `onData` 通过 `webContents.send("terminal:data", event)` 发给 renderer；`onExit` 发 `terminal:exit`。
5. `write`、`resize`、`dispose` 都通过 `requireSession` 校验 session 存在。
6. 在 `terminalIpc.ts` 注册 `terminal:create`、`terminal:write`、`terminal:resize`、`terminal:dispose`，preload 暴露同名包装方法。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm add node-pty
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，点击 `New Terminal` 会在 main 进程创建一个 session；即使还没接 xterm，DevTools 或临时日志能看到 `terminal:data` 收到 shell prompt 字节流。关闭窗口时 session 应被 dispose。

### 常见报错

- `spawn ENOENT`：默认 shell 路径不存在，检查 `process.env.SHELL` 或 Windows profile。
- `cwd does not exist`：workspace 已关闭或路径无效，创建 terminal 前必须校验 workspace。
- 关闭窗口后 shell 还在：确保 BrowserWindow close 或 workspace change 时调用 `dispose` / `disposeAllForWorkspace`。
- Renderer 调不到 IPC：确认 preload 方法和 main channel 名称完全一致。

## 可运行验收

本章验收：

- main 进程能创建 PTY session，cwd 是 workspace root。
- `write` 能把数据写入 shell。
- `resize` 调用 `pty.resize`。
- `dispose` 会 kill shell 并删除 session。
- 原生模块错误在 README 或课程中有处理路径。

## 当前章节缺陷

本章只处理 PTY 生命周期，还没有 Renderer 状态管理。

## 下一章预告

下一章会实现 Terminal Store：管理多个 terminal session、active terminal、输出缓冲和状态。
