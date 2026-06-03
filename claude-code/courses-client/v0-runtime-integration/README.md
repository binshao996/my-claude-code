# V0 - Runtime Integration Client Foundation

## 本章目标

V0 的目标不是讲一个抽象架构，而是让读者从空目录初始化一个 Electron Client，写完最小文件后可以运行：

```bash
pnpm dev
```

然后在 Electron 窗口里输入 prompt，看到 Runtime event log。

本章完成这些能力：

- 初始化 `Electron + React + Vite + TypeScript` Client 工程。
- 在 Electron main process 中创建 `RuntimeClient`。
- 用 `MiniRuntimeAdapter` 包装 `claude-code-mini` 的 `ChatSession`。
- 通过 IPC 把 Runtime 事件推送给 renderer。
- 在 preload 暴露 typed `window.client.runtime` API。
- 在 React 里实现最小 `ClientShell`，展示 session、prompt composer 和 event log。
- 保持边界：renderer 不 import `claude-code-mini`，也不 import `src/main/runtime/*`。

V0 不做完整 Chat UI、Workspace、Editor、Terminal、Diff Viewer、Permission Dialog。它只打通第一条链路：

```text
Renderer ClientShell
  -> preload typed API
  -> Electron IPC
  -> main RuntimeClient
  -> MiniRuntimeAdapter
  -> claude-code-mini ChatSession
  -> RuntimeEvent
  -> Renderer event log
```

## 先看最终结构

从脚手架初始化后，`react-ts` 模板的真实目录是这样的。注意 renderer 代码在 `src/renderer/src/`，不是 `src/renderer/` 根目录。

```text
claude-code-client/
  package.json
  electron.vite.config.ts
  electron-builder.yml
  tsconfig.json
  tsconfig.node.json
  tsconfig.web.json
  src/
    main/
      index.ts
    preload/
      index.ts
      index.d.ts
    renderer/
      index.html
      src/
        App.tsx
        main.tsx
        env.d.ts
        assets/
        components/
```

V0 写完后，新增或覆盖这些文件：

```text
claude-code-client/
  package.json
  tsconfig.node.json
  tsconfig.web.json
  src/
    shared/
      runtimeTypes.ts
    main/
      index.ts
      ipc/
        runtimeIpc.ts
      runtime/
        RuntimeClient.ts
        MiniRuntimeAdapter.ts
        createRuntimeClient.ts
        normalizeRuntimeEvent.ts
    preload/
      index.ts
      index.d.ts
    renderer/
      src/
        App.tsx
        main.tsx
        shell/
          ClientShell.tsx
```

## 1. 初始化 electron-vite 工程

在 `claude-code-mini` 同级目录创建 Client 工程：

```bash
cd /Users/bin.ke/my-compony/my-claude-code/claude-code
pnpm create @quick-start/electron claude-code-client --template react-ts --skip
cd claude-code-client
pnpm install
```

如果不用 `--skip`，脚手架会问：

```text
Add Electron updater plugin?
Enable Electron download mirror proxy?
```

V0 先都选 `No`。Updater 和发布能力放到 V10。

脚手架生成的 `package.json` scripts 真实长这样：

```json
{
  "scripts": {
    "format": "prettier --write .",
    "lint": "eslint --cache .",
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json --composite false",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json --composite false",
    "typecheck": "npm run typecheck:node && npm run typecheck:web",
    "start": "electron-vite preview",
    "dev": "electron-vite dev",
    "build": "npm run typecheck && electron-vite build",
    "postinstall": "electron-builder install-app-deps",
    "build:unpack": "npm run build && electron-builder --dir",
    "build:win": "npm run build && electron-builder --win",
    "build:mac": "electron-vite build && electron-builder --mac",
    "build:linux": "electron-vite build && electron-builder --linux"
  }
}
```

本教程使用 `pnpm` 跑脚本，所以建议把内部 `npm run` 改成 `pnpm`：

```json
{
  "scripts": {
    "format": "prettier --write .",
    "lint": "eslint --cache .",
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json --composite false",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json --composite false",
    "typecheck": "pnpm typecheck:node && pnpm typecheck:web",
    "start": "electron-vite preview",
    "dev": "electron-vite dev",
    "build": "pnpm typecheck && electron-vite build",
    "postinstall": "electron-builder install-app-deps",
    "build:unpack": "pnpm build && electron-builder --dir",
    "build:win": "pnpm build && electron-builder --win",
    "build:mac": "electron-vite build && electron-builder --mac",
    "build:linux": "electron-vite build && electron-builder --linux"
  },
  "dependencies": {
    "@electron-toolkit/preload": "^3.0.2",
    "@electron-toolkit/utils": "^4.0.0",
    "claude-code-mini": "file:../claude-code-mini"
  }
}
```

改完后重新安装本地 runtime 依赖：

```bash
pnpm install
```

## 2. 让 shared 类型同时被 main 和 renderer 看到

V0 需要一份跨 preload、main、renderer 共享的类型。它只放产品语义，不放 Runtime 内部类。

把 `tsconfig.node.json` 改成：

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": [
    "electron.vite.config.*",
    "src/main/**/*",
    "src/preload/**/*",
    "src/shared/**/*"
  ],
  "compilerOptions": {
    "composite": true,
    "types": ["electron-vite/node"]
  }
}
```

把 `tsconfig.web.json` 改成：

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.web.json",
  "include": [
    "src/renderer/src/env.d.ts",
    "src/renderer/src/**/*",
    "src/renderer/src/**/*.tsx",
    "src/preload/*.d.ts",
    "src/shared/**/*"
  ],
  "compilerOptions": {
    "composite": true,
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@renderer/*": ["src/renderer/src/*"],
      "@shared/*": ["src/shared/*"]
    }
  }
}
```

## 3. 写 shared Runtime 类型

创建 `src/shared/runtimeTypes.ts`：

```ts
export type RuntimeSessionInfo = {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
};

export type RuntimeUserInput = {
  text: string;
  mode?: "default" | "plan";
};

export type RuntimeEvent =
  | { type: "session"; info: RuntimeSessionInfo }
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_input_delta"; id: string; name: string; inputJSONLength: number }
  | { type: "tool_input"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; content: string; diff?: string }
  | { type: "context_update"; beforeTokens: number; afterTokens: number }
  | { type: "turn_complete"; turn: number; toolUseCount: number }
  | { type: "max_turns_reached"; maxTurns: number }
  | { type: "done" }
  | { type: "error"; message: string };

export type RuntimeSendResult = {
  requestId: string;
};

export type RuntimeWireEvent = {
  requestId: string;
  event: RuntimeEvent;
};

export type RuntimeApi = {
  getSessionInfo(): Promise<RuntimeSessionInfo>;
  send(input: RuntimeUserInput): Promise<RuntimeSendResult>;
  onEvent(handler: (event: RuntimeWireEvent) => void): () => void;
};

export type ClientApi = {
  runtime: RuntimeApi;
};

export const RuntimeIpcChannel = {
  GetSessionInfo: "runtime:get-session-info",
  Send: "runtime:send",
  Event: "runtime:event",
} as const;
```

这份类型可以被 renderer import。它没有 `ChatSession`、`AgentLoop`、`ToolRegistry`，所以不会把 Runtime 内部泄漏到 UI。

## 4. 写 RuntimeClient 边界

创建 `src/main/runtime/RuntimeClient.ts`：

```ts
import type {
  RuntimeEvent,
  RuntimeSessionInfo,
  RuntimeUserInput,
} from "../../shared/runtimeTypes";

export interface RuntimeAdapter {
  getSessionInfo(): RuntimeSessionInfo;
  send(input: RuntimeUserInput): AsyncGenerator<RuntimeEvent, void>;
}

export type RuntimeClient = RuntimeAdapter;
```

Client 后续只依赖这个接口。`MiniRuntimeAdapter` 是一种实现，不是 UI 的依赖。

### Runtime adapter 导入边界

V0 有两种接入方式，优先级固定：

1. **优先使用稳定 Runtime Adapter package/export**。Client main process 从 `claude-code-mini/runtime` 这类稳定入口 import，后续 Runtime 内部目录变动时，Client 不需要改。
2. **如果当前 `claude-code-mini` 还没有 package export，再临时使用源码路径**。这只是 V0 过渡写法，后续要回到稳定 export。

Runtime 项目应该补一层导出边界，例如在 `claude-code-mini/package.json` 里补：

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./runtime": {
      "types": "./dist/client-runtime/index.d.ts",
      "import": "./dist/client-runtime/index.js"
    }
  }
}
```

或者先在 Runtime 源码里补一个聚合入口：

```text
claude-code-mini/src/client-runtime/index.ts
```

里面只导出 Client adapter 需要的稳定类型和工厂依赖：

```ts
export { ChatSession, type ChatSessionEvent } from "../chat/session";
export { loadLLMConfig } from "../llm/config";
export type { LLMConfig } from "../llm/types";
export { PlannerStore } from "../planner";
export { PermissionStore, type AskUser } from "../permissions";
export { PluginRegistry } from "../plugins";
export { parseSandboxMode, SandboxPolicyEngine } from "../sandbox";
export { SessionStore, type LoadedSession } from "../session";
export { createDefaultToolRegistry, type ToolContext, type ToolRegistry } from "../tools";
```

这是 **Runtime 项目需要补的边界**。renderer 不直接 import 这个入口，renderer 只走 `window.client.runtime`。V0 的 main process 可以先用它，等 Runtime package export 补齐后，把 import 从源码 fallback 改回稳定包入口即可。

## 5. 归一化 claude-code-mini 事件

创建 `src/main/runtime/normalizeRuntimeEvent.ts`：

```ts
import type { ChatSessionEvent } from "claude-code-mini/runtime";
import type { RuntimeEvent } from "../../shared/runtimeTypes";

export function normalizeRuntimeEvent(event: ChatSessionEvent): RuntimeEvent | null {
  switch (event.type) {
    case "turn_start":
      return { type: "turn_start", turn: event.turn };

    case "text_delta":
      return { type: "text_delta", text: event.text };

    case "tool_use_start":
      return {
        type: "tool_start",
        id: event.id,
        name: event.name,
      };

    case "tool_input_delta":
      return {
        type: "tool_input_delta",
        id: event.id,
        name: event.name,
        inputJSONLength: event.inputJSONLength,
      };

    case "tool_use":
      return {
        type: "tool_input",
        id: event.toolUse.id,
        name: event.toolUse.name,
        input: event.toolUse.input,
      };

    case "tool_result":
      return {
        type: "tool_result",
        id: event.toolUse.id,
        name: event.toolUse.name,
        ok: !event.result.is_error,
        content: event.result.content,
        diff: event.rawResult?.diff,
      };

    case "context_update":
      return {
        type: "context_update",
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
      };

    case "turn_complete":
      return {
        type: "turn_complete",
        turn: event.turn,
        toolUseCount: event.toolUseCount,
      };

    case "max_turns_reached":
      return { type: "max_turns_reached", maxTurns: event.maxTurns };

    case "message_stop":
      return { type: "done" };

    default:
      return null;
  }
}
```

这里的重点是：Runtime 原始事件不直接进入 renderer。renderer 只看 `RuntimeEvent`。

如果当前 `claude-code-mini` 还没有 `./runtime` export，把第一行临时改成源码 fallback：

```ts
import type { ChatSessionEvent } from "claude-code-mini/src/client-runtime";
```

如果连 `src/client-runtime/index.ts` 也还没补，才临时退到更细的源码路径：

```ts
import type { ChatSessionEvent } from "claude-code-mini/src/chat/session";
```

这两种都是 Runtime 项目的短期缺口，不要把它们复制到 renderer。

## 6. 写 MiniRuntimeAdapter

创建 `src/main/runtime/MiniRuntimeAdapter.ts`：

```ts
import {
  ChatSession,
  type LLMConfig,
  type LoadedSession,
  type PlannerStore,
  type PluginRegistry,
  type SessionStore,
  type ToolRegistry,
} from "claude-code-mini/runtime";
import type {
  RuntimeEvent,
  RuntimeSessionInfo,
  RuntimeUserInput,
} from "../../shared/runtimeTypes";
import type { RuntimeClient } from "./RuntimeClient";
import { normalizeRuntimeEvent } from "./normalizeRuntimeEvent";

export type MiniRuntimeAdapterOptions = {
  cwd: string;
  config: LLMConfig;
  toolRegistry: ToolRegistry;
  maxTurns: number;
  contextWindow: number;
  loadedSession: LoadedSession;
  sessionStore: SessionStore;
  planner: PlannerStore;
  pluginRegistry: PluginRegistry;
};

export class MiniRuntimeAdapter implements RuntimeClient {
  private readonly session: ChatSession;

  constructor(private readonly options: MiniRuntimeAdapterOptions) {
    this.session = new ChatSession(options.config, options.toolRegistry, {
      maxTurns: options.maxTurns,
      contextWindow: options.contextWindow,
      loadedSession: options.loadedSession,
      sessionStore: options.sessionStore,
      planner: options.planner,
      cwd: options.cwd,
      pluginRegistry: options.pluginRegistry,
    });
  }

  getSessionInfo(): RuntimeSessionInfo {
    return {
      sessionId: this.session.sessionId,
      transcriptPath: this.session.transcriptPath,
      cwd: this.options.cwd,
    };
  }

  async *send(input: RuntimeUserInput): AsyncGenerator<RuntimeEvent, void> {
    yield { type: "session", info: this.getSessionInfo() };

    try {
      for await (const event of this.session.sendUserMessageStream(input.text, {
        mode: input.mode ?? "default",
      })) {
        const normalized = normalizeRuntimeEvent(event);

        if (normalized) {
          yield normalized;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
```

如果 `claude-code-mini/runtime` 还没有导出，先把 import fallback 到 Runtime 的聚合源码入口：

```ts
import {
  ChatSession,
  type LLMConfig,
  type LoadedSession,
  type PlannerStore,
  type PluginRegistry,
  type SessionStore,
  type ToolRegistry,
} from "claude-code-mini/src/client-runtime";
```

如果当前 Runtime 连 `src/client-runtime/index.ts` 都还没有，只能临时回到细分源码路径：

```ts
import { ChatSession } from "claude-code-mini/src/chat/session";
import type { LLMConfig } from "claude-code-mini/src/llm/types";
import type { LoadedSession, SessionStore } from "claude-code-mini/src/session";
import type { PlannerStore } from "claude-code-mini/src/planner";
import type { PluginRegistry } from "claude-code-mini/src/plugins";
import type { ToolRegistry } from "claude-code-mini/src/tools";
```

这段 fallback 只允许出现在 `src/main/runtime/MiniRuntimeAdapter.ts` 这类 main Runtime 边界文件里。renderer 不能 import `claude-code-mini/runtime`，也不能 import `claude-code-mini/src/...`。

## 7. 创建 RuntimeClient

创建 `src/main/runtime/createRuntimeClient.ts`：

```ts
import {
  createDefaultToolRegistry,
  loadLLMConfig,
  parseSandboxMode,
  PermissionStore,
  PlannerStore,
  PluginRegistry,
  SandboxPolicyEngine,
  SessionStore,
  type AskUser,
  type ToolContext,
} from "claude-code-mini/runtime";
import type {
  RuntimeEvent,
  RuntimeSessionInfo,
  RuntimeUserInput,
} from "../../shared/runtimeTypes";
import type { RuntimeAdapter, RuntimeClient } from "./RuntimeClient";
import { MiniRuntimeAdapter } from "./MiniRuntimeAdapter";

const DEFAULT_CONTEXT_WINDOW = 32_000;

export async function createRuntimeClient(cwd: string): Promise<RuntimeClient> {
  if (process.env.V0_RUNTIME_ADAPTER === "fake") {
    return new FakeRuntimeAdapter(cwd);
  }

  const config = loadLLMConfig();
  const sessionStore = new SessionStore(cwd);
  const loadedSession = await sessionStore.createSession();
  const planner = new PlannerStore(loadedSession.metadata.sessionId, loadedSession.plan);
  const pluginRegistry = new PluginRegistry();

  await pluginRegistry.reload();

  const sandbox = new SandboxPolicyEngine({
    cwd,
    mode: parseSandboxMode("read_only"),
    commandTimeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });

  const permissions = new PermissionStore();
  const askUser: AskUser = async () => "no";
  const readFileState: ToolContext["readFileState"] = new Map();

  const toolRegistry = createDefaultToolRegistry({
    cwd,
    readFileState,
    sessionId: loadedSession.metadata.sessionId,
    messages: loadedSession.messages,
    planner,
    sandbox,
    permissions,
    askUser,
    pluginTools: pluginRegistry.getTools(),
  });

  return new MiniRuntimeAdapter({
    cwd,
    config,
    toolRegistry,
    maxTurns: 8,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    loadedSession,
    sessionStore,
    planner,
    pluginRegistry,
  });
}

class FakeRuntimeAdapter implements RuntimeAdapter {
  private readonly info: RuntimeSessionInfo;

  constructor(cwd: string) {
    this.info = {
      sessionId: `fake-${Date.now()}`,
      transcriptPath: `${cwd}/.fake-runtime/transcript.jsonl`,
      cwd,
    };
  }

  getSessionInfo(): RuntimeSessionInfo {
    return this.info;
  }

  async *send(input: RuntimeUserInput): AsyncGenerator<RuntimeEvent, void> {
    yield { type: "session", info: this.info };
    yield { type: "turn_start", turn: 1 };
    yield {
      type: "text_delta",
      text: `Fake adapter received: ${input.text}`,
    };
    yield {
      type: "tool_start",
      id: "fake-tool-1",
      name: "fake_runtime_echo",
    };
    yield {
      type: "tool_input",
      id: "fake-tool-1",
      name: "fake_runtime_echo",
      input: { mode: input.mode ?? "default" },
    };
    yield {
      type: "tool_result",
      id: "fake-tool-1",
      name: "fake_runtime_echo",
      ok: true,
      content: "Fake adapter is running without an API key.",
    };
    yield { type: "turn_complete", turn: 1, toolUseCount: 1 };
    yield { type: "done" };
  }
}
```

V0 的 `askUser` 先固定返回 `"no"`，表示需要审批的高风险工具默认拒绝。真正的桌面 Permission Dialog 放到后续章节；这里先保留注入口，避免后续返工。

如果 `claude-code-mini/runtime` 还没有导出，`createRuntimeClient.ts` 也使用同一个 fallback：

```ts
import {
  createDefaultToolRegistry,
  loadLLMConfig,
  parseSandboxMode,
  PermissionStore,
  PlannerStore,
  PluginRegistry,
  SandboxPolicyEngine,
  SessionStore,
  type AskUser,
  type ToolContext,
} from "claude-code-mini/src/client-runtime";
```

只有 `src/client-runtime/index.ts` 也不存在时，才临时拆成多个 `claude-code-mini/src/...` import。不要把这个临时路径扩散到 `src/preload` 或 `src/renderer`。

## 8. 设计 IPC channel

创建 `src/main/ipc/runtimeIpc.ts`：

```ts
import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import {
  RuntimeIpcChannel,
  type RuntimeUserInput,
  type RuntimeWireEvent,
} from "../../shared/runtimeTypes";
import { createRuntimeClient } from "../runtime/createRuntimeClient";

export function registerRuntimeIpc(cwd: string): void {
  const runtimePromise = createRuntimeClient(cwd);

  ipcMain.handle(RuntimeIpcChannel.GetSessionInfo, async () => {
    const runtime = await runtimePromise;
    return runtime.getSessionInfo();
  });

  ipcMain.handle(
    RuntimeIpcChannel.Send,
    async (ipcEvent, input: RuntimeUserInput) => {
      const requestId = randomUUID();
      const runtime = await runtimePromise;

      void streamRuntimeEvents(ipcEvent.sender, requestId, runtime.send(input));

      return { requestId };
    },
  );
}

async function streamRuntimeEvents(
  webContents: WebContents,
  requestId: string,
  events: AsyncGenerator<RuntimeWireEvent["event"], void>,
): Promise<void> {
  for await (const event of events) {
    const payload: RuntimeWireEvent = { requestId, event };
    webContents.send(RuntimeIpcChannel.Event, payload);
  }
}
```

IPC 设计原则：

- `runtime:get-session-info` 是 request/response。
- `runtime:send` 只负责启动一次 Runtime run，并立刻返回 `requestId`。
- `runtime:event` 是 main 主动推给 renderer 的事件流。
- 每次 send 都有 `requestId`，后续多会话、多窗口、取消任务时可以扩展。

V0 暂不实现 abort。后续可以新增：

```text
runtime:abort
runtime:permission:reply
```

## 9. 覆盖 main process 入口

把 `src/main/index.ts` 覆盖为：

```ts
import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import { registerRuntimeIpc } from "./ipc/runtimeIpc";

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.claude-code-client");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerRuntimeIpc(process.cwd());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

这里的最小 `BrowserWindow` 要点：

- `preload` 指向构建后的 `../preload/index.js`。
- `contextIsolation: true`，renderer 不能直接访问 Electron/Node。
- `nodeIntegration: false`，renderer 不能 import fs、shell、runtime。
- `registerRuntimeIpc(process.cwd())` 在 main process 注册 Runtime IPC。

## 10. 暴露 typed preload API

把 `src/preload/index.ts` 覆盖为：

```ts
import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import {
  RuntimeIpcChannel,
  type ClientApi,
  type RuntimeUserInput,
  type RuntimeWireEvent,
} from "../shared/runtimeTypes";

const clientApi: ClientApi = {
  runtime: {
    getSessionInfo: () => ipcRenderer.invoke(RuntimeIpcChannel.GetSessionInfo),
    send: (input: RuntimeUserInput) => ipcRenderer.invoke(RuntimeIpcChannel.Send, input),
    onEvent: (handler: (event: RuntimeWireEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RuntimeWireEvent) => {
        handler(payload);
      };

      ipcRenderer.on(RuntimeIpcChannel.Event, listener);

      return () => {
        ipcRenderer.removeListener(RuntimeIpcChannel.Event, listener);
      };
    },
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("client", clientApi);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = electronAPI;
  window.client = clientApi;
}
```

把 `src/preload/index.d.ts` 覆盖为：

```ts
import type { ElectronAPI } from "@electron-toolkit/preload";
import type { ClientApi } from "../shared/runtimeTypes";

declare global {
  interface Window {
    electron: ElectronAPI;
    client: ClientApi;
  }
}
```

preload 是 renderer 的唯一入口。React 组件只调用：

```ts
window.client.runtime.send(...)
window.client.runtime.onEvent(...)
```

不要在 renderer 写：

```ts
import { ChatSession } from "claude-code-mini/runtime";
import { createRuntimeClient } from "../../main/runtime/createRuntimeClient";
```

上面两种都违反 V0 边界。

## 11. 写最小 ClientShell UI

创建 `src/renderer/src/shell/ClientShell.tsx`：

```tsx
import { useEffect, useMemo, useState } from "react";
import type { RuntimeSessionInfo, RuntimeWireEvent } from "../../../shared/runtimeTypes";

type LogRow = RuntimeWireEvent & {
  createdAt: string;
};

export function ClientShell(): JSX.Element {
  const [session, setSession] = useState<RuntimeSessionInfo | null>(null);
  const [prompt, setPrompt] = useState("输出当前时间，然后总结当前工作目录。");
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);

  useEffect(() => {
    void window.client.runtime.getSessionInfo().then(setSession).catch((error) => {
      setLogs((current) => [
        ...current,
        {
          requestId: "local",
          createdAt: new Date().toLocaleTimeString(),
          event: {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      ]);
    });

    return window.client.runtime.onEvent((wireEvent) => {
      setLogs((current) => [
        ...current,
        {
          ...wireEvent,
          createdAt: new Date().toLocaleTimeString(),
        },
      ]);

      if (wireEvent.event.type === "done" || wireEvent.event.type === "error") {
        setIsRunning(false);
      }
    });
  }, []);

  const latestRequestId = useMemo(() => logs.at(-1)?.requestId ?? "none", [logs]);

  async function submit(): Promise<void> {
    const text = prompt.trim();

    if (!text || isRunning) {
      return;
    }

    setIsRunning(true);
    setLogs((current) => [
      ...current,
      {
        requestId: "local",
        createdAt: new Date().toLocaleTimeString(),
        event: { type: "text_delta", text: `> ${text}` },
      },
    ]);

    try {
      await window.client.runtime.send({ text });
    } catch (error) {
      setIsRunning(false);
      setLogs((current) => [
        ...current,
        {
          requestId: "local",
          createdAt: new Date().toLocaleTimeString(),
          event: {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      ]);
    }
  }

  return (
    <main className="client-shell">
      <header className="client-shell__header">
        <div>
          <h1>Claude Code Client V0</h1>
          <p>Runtime event log</p>
        </div>
        <div className="client-shell__session">
          <span>session</span>
          <strong>{session?.sessionId ?? "loading"}</strong>
          <span>cwd</span>
          <strong>{session?.cwd ?? "loading"}</strong>
        </div>
      </header>

      <section className="client-shell__body">
        <div className="client-shell__toolbar">
          <span>latest request: {latestRequestId}</span>
          <span>{isRunning ? "running" : "idle"}</span>
        </div>

        <div className="client-shell__log" aria-label="Runtime event log">
          {logs.length === 0 ? (
            <div className="client-shell__empty">Submit a prompt to stream Runtime events.</div>
          ) : (
            logs.map((row, index) => (
              <pre key={`${row.requestId}-${index}`}>
                {row.createdAt} [{row.requestId}] {JSON.stringify(row.event, null, 2)}
              </pre>
            ))
          )}
        </div>
      </section>

      <footer className="client-shell__composer">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              void submit();
            }
          }}
        />
        <button type="button" disabled={isRunning || !prompt.trim()} onClick={() => void submit()}>
          {isRunning ? "Running" : "Send"}
        </button>
      </footer>
    </main>
  );
}
```

这是最小 UI，不做 Markdown、不做 message reducer。V1 才会把 event log 变成真正 Chat UI。

## 12. 接入 App.tsx 和 main.tsx

把 `src/renderer/src/App.tsx` 覆盖为：

```tsx
import { ClientShell } from "./shell/ClientShell";

export default function App(): JSX.Element {
  return <ClientShell />;
}
```

脚手架生成的 `src/renderer/src/main.tsx` 可以保留，只确认它渲染的是 `App`：

```tsx
import "./assets/main.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

为了页面可读，把 `src/renderer/src/assets/main.css` 改成最小样式：

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  background: #f7f2ec;
  color: #1f1a17;
}

button,
textarea {
  font: inherit;
}

.client-shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
}

.client-shell__header {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 28px;
  border-bottom: 1px solid #ded6ce;
  background: #fffaf4;
}

.client-shell__header h1 {
  margin: 0;
  font-size: 22px;
}

.client-shell__header p {
  margin: 6px 0 0;
  color: #6f6259;
}

.client-shell__session {
  display: grid;
  grid-template-columns: auto minmax(220px, 1fr);
  gap: 6px 10px;
  max-width: 520px;
  font-size: 12px;
  color: #6f6259;
}

.client-shell__session strong {
  overflow: hidden;
  color: #1f1a17;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-shell__body {
  min-height: 0;
  display: grid;
  grid-template-rows: auto 1fr;
}

.client-shell__toolbar {
  display: flex;
  justify-content: space-between;
  padding: 12px 28px;
  border-bottom: 1px solid #ded6ce;
  color: #6f6259;
  font-size: 13px;
}

.client-shell__log {
  min-height: 0;
  overflow: auto;
  padding: 20px 28px;
}

.client-shell__log pre {
  margin: 0 0 10px;
  padding: 12px;
  border: 1px solid #ded6ce;
  border-radius: 6px;
  background: #1f1a17;
  color: #fffaf4;
  white-space: pre-wrap;
}

.client-shell__empty {
  color: #6f6259;
}

.client-shell__composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  padding: 16px 28px 24px;
  border-top: 1px solid #ded6ce;
  background: #fffaf4;
}

.client-shell__composer textarea {
  min-height: 80px;
  resize: vertical;
  border: 1px solid #cfc5bb;
  border-radius: 6px;
  padding: 12px;
  background: #ffffff;
  color: #1f1a17;
}

.client-shell__composer button {
  align-self: end;
  min-width: 96px;
  height: 42px;
  border: 0;
  border-radius: 6px;
  background: #d77757;
  color: #ffffff;
  cursor: pointer;
}

.client-shell__composer button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
```

CSS 不是 V0 的核心，但需要一个清晰的 shell，方便确认 Runtime event log 真的在流动。

## 13. 运行

先跑类型检查：

```bash
pnpm typecheck
```

没有 API key 时，先用 fake adapter 启动 Electron：

```bash
V0_RUNTIME_ADAPTER=fake pnpm dev
```

fake adapter 不请求模型，也不读写真实 Runtime transcript。它只用来验证 Electron、IPC、preload、React event log 这一条链路已经打通。

有真实模型配置时，再启动真实 adapter：

```bash
ANTHROPIC_API_KEY=你的_key pnpm dev
```

如果你的 `claude-code-mini` 使用其他模型环境变量，按它自己的配置方式设置。V0 Client 不把密钥写进代码，也不把密钥打印进日志。

启动后应该看到：

- 一个 Electron 窗口。
- 顶部显示 `Claude Code Client V0`。
- 右上显示 `sessionId` 和 `cwd`。
- 中间是 Runtime event log。
- 底部是 prompt 输入框和 `Send` 按钮。

输入：

```text
输出当前时间，然后总结当前工作目录。
```

点击 `Send` 后，event log 至少会出现：

```text
{"type":"session","info":{"sessionId":"...","transcriptPath":"...","cwd":"..."}}
{"type":"turn_start","turn":1}
{"type":"text_delta","text":"..."}
{"type":"done"}
```

fake adapter 模式下，还应该稳定看到：

```text
{"type":"tool_start","id":"fake-tool-1","name":"fake_runtime_echo"}
{"type":"tool_input","id":"fake-tool-1","name":"fake_runtime_echo","input":{"mode":"default"}}
{"type":"tool_result","id":"fake-tool-1","name":"fake_runtime_echo","ok":true,"content":"Fake adapter is running without an API key."}
{"type":"turn_complete","turn":1,"toolUseCount":1}
```

如果模型触发工具，还会看到：

```text
{"type":"tool_start","id":"...","name":"current_time"}
{"type":"tool_input","id":"...","name":"current_time","input":{}}
{"type":"tool_result","id":"...","name":"current_time","ok":true,"content":"..."}
```

如果 prompt 触发需要写文件或执行命令的工具，V0 默认审批为 `"no"`，你会看到工具结果失败或模型解释无法执行。这是预期行为。

## 14. 验收清单

完成 V0 后逐项检查：

### UI 验收：fake adapter

- `pnpm typecheck` 通过。
- `V0_RUNTIME_ADAPTER=fake pnpm dev` 能打开 Electron 窗口。
- renderer 可以调用 `window.client.runtime.getSessionInfo()`。
- prompt 提交后能收到 `runtime:event`。
- fake adapter event log 能显示 `session`、`turn_start`、`text_delta`、`tool_start`、`tool_input`、`tool_result`、`turn_complete`、`done`。
- 页面右上角 `session` 以 `fake-` 开头，`cwd` 是启动 Electron 的工作目录。
- event log 里稳定出现 `fake_runtime_echo`，说明没有 API key 时也能验证 IPC 和 UI。

### UI 验收：真实 adapter

- 使用 `ANTHROPIC_API_KEY=你的_key pnpm dev` 或 Runtime 自己支持的模型环境变量启动。
- 真实 adapter event log 能显示 `session`、`turn_start`、`text_delta`、`done`，模型触发工具时还能显示真实 `tool_*` 事件。
- 页面右上角 `session` 是 Runtime 创建的真实 session id，`transcriptPath` 对应真实 Runtime transcript。
- prompt 要能看到模型返回的 `text_delta`，而不是 fake adapter 的 `Fake adapter received: ...`。
- 真实 adapter 缺少 API key 时不要卡在 UI 空白；切回 `V0_RUNTIME_ADAPTER=fake pnpm dev` 仍然能跑出 event log。

### 边界验收

- renderer 没有 import `claude-code-mini`。
- renderer 没有 import `src/main/runtime/*`。
- Runtime 原始事件先经过 `normalizeRuntimeEvent()`，再进入 UI。

可以用下面命令检查 renderer 是否误 import runtime：

```bash
rg "claude-code-mini|src/main|main/runtime|ChatSession|MiniRuntimeAdapter" src/renderer/src
```

这条命令应该没有输出。

## 常见报错

### `Project name:` 交互没有跳过

确认命令带了项目名和 `--skip`：

```bash
pnpm create @quick-start/electron claude-code-client --template react-ts --skip
```

如果已经进入交互，也可以手动选择：

```text
Project name: claude-code-client
Select a framework: react
Add TypeScript? Yes
Add Electron updater plugin? No
Enable Electron download mirror proxy? No
```

### `Cannot find module "claude-code-mini/runtime"`

优先让 Runtime 项目补稳定 export。`claude-code-mini/package.json` 应该暴露类似：

```json
{
  "exports": {
    "./runtime": {
      "types": "./dist/client-runtime/index.d.ts",
      "import": "./dist/client-runtime/index.js"
    }
  }
}
```

同时 Runtime 源码可以先补：

```text
claude-code-mini/src/client-runtime/index.ts
```

Client main process 临时 fallback 到：

```ts
import { ChatSession } from "claude-code-mini/src/client-runtime";
```

注意这是 `src/main/runtime/*` 的临时写法，不是 renderer 写法。

### `Cannot find module "claude-code-mini/src/client-runtime"`

说明 Runtime 项目还没补聚合源码入口。短期可以在 `src/main/runtime/MiniRuntimeAdapter.ts` 和 `src/main/runtime/createRuntimeClient.ts` 使用更细的源码路径：

```ts
import { ChatSession } from "claude-code-mini/src/chat/session";
```

但这个状态不应该长期存在。V0 教程的稳定目标是 Runtime 补 `src/client-runtime/index.ts` 和 package export，Client 只依赖 Runtime adapter 边界。

### `Cannot find module "claude-code-mini/src/..."`

确认 Client 工程和 `claude-code-mini` 是同级目录：

```text
claude-code/
  claude-code-mini/
  claude-code-client/
```

确认 `claude-code-client/package.json` 有：

```json
{
  "dependencies": {
    "claude-code-mini": "file:../claude-code-mini"
  }
}
```

然后重新安装：

```bash
pnpm install
```

如果只有细分源码路径找不到，说明当前 Runtime 源码目录名和教程不一致。不要在 renderer 里继续试路径，先回到 Runtime 项目补稳定 `src/client-runtime/index.ts`，再让 Client main process 从这个入口导入。

### `ANTHROPIC_API_KEY` 缺失

`MiniRuntimeAdapter` 会走真实 `claude-code-mini` LLM 配置。没有模型 key 时，先用 fake adapter 验证 UI 和 IPC：

```bash
V0_RUNTIME_ADAPTER=fake pnpm dev
```

fake adapter 正常时，event log 会出现 `fake_runtime_echo` 工具事件。

要跑真实 adapter，再用环境变量启动：


```bash
ANTHROPIC_API_KEY=你的_key pnpm dev
```

不要把 key 写进 `package.json`、源码、README 示例输出或截图。

### `window.client is undefined`

检查三处：

- `src/main/index.ts` 的 `webPreferences.preload` 是否是 `join(__dirname, "../preload/index.js")`。
- `contextIsolation` 是否为 `true`。
- `src/preload/index.ts` 是否执行了 `contextBridge.exposeInMainWorld("client", clientApi)`。

改完 preload 后需要重启 `pnpm dev`，只刷新 renderer 不一定重新加载 preload。

### `ipcMain.handle` 被重复注册

如果你在热更新过程中看到重复 handler 报错，先完整退出 Electron 再重启：

```bash
pnpm dev
```

V0 的 `registerRuntimeIpc()` 只应该在 main process 启动时注册一次，不要在 `createWindow()` 里每开一个窗口注册一次。

### TypeScript 找不到 `@shared/*`

确认 `tsconfig.web.json` 里加了：

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  }
}
```

本章代码大多使用相对路径，`@shared/*` 是后续章节方便 renderer 组织代码时使用。

### 提交 prompt 后只有 `session` 和 `error`

看 error message：

- 如果是模型 key 或 base URL 问题，修正 LLM 环境变量。
- 如果是权限问题，V0 默认拒绝需要审批的工具。
- 如果是 import/bundle 问题，先跑 `pnpm typecheck`，再重启 `pnpm dev`。

## 为什么 renderer 不能 import runtime

Renderer 是 UI 层，不能持有这些能力：

```text
File System
Shell
Sandbox
Permission Store
Session Store
Plugin Loader
LLM Config
```

正确边界是：

```text
renderer
  -> window.client.runtime
  -> preload
  -> IPC
  -> main RuntimeClient
  -> MiniRuntimeAdapter
  -> claude-code-mini
```

这样后续替换 Runtime 来源时，UI 不需要重写：

- 本地 `claude-code-mini` 换成完整 Claude Code Runtime。
- main process 内嵌换成 sidecar worker。
- 本地 Runtime 换成远程 Runtime。
- CLI prompt 权限换成桌面 Permission Dialog。

V0 的核心成果不是 UI 多漂亮，而是边界稳定：`RuntimeClient` 是 Client 依赖的接口，`MiniRuntimeAdapter` 是当前 Runtime 的适配器，renderer 只消费 typed preload API 和 `RuntimeEvent`。

## 下一章如何承接

V0 的 event log 只是调试视图。V1 会把 `RuntimeEvent` 转成可维护的 Chat 状态：

```text
RuntimeEvent
  -> ChatAction
  -> chatReducer
  -> ChatState
  -> Streaming Message UI
```

所以 V0 不要提前把复杂状态写进 `ClientShell`。本章只要能启动 shell、提交 prompt、看到 Runtime event log，就已经完成 Client 工程基座。
