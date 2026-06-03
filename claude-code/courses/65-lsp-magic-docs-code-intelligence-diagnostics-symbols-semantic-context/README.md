# 第 65 章：LSP、Magic Docs 与代码智能层：诊断、符号、跳转、语义编辑提示与上下文注入

前面章节已经把 Claude Code 的核心交互、工具执行、权限、插件、技能、Hook、MCPB、安全回滚、终端 UI、Plan 视图、Diff 视图和中断恢复串起来了。

这一章补上一个非常关键的层：代码智能。

如果只有 `Read`、`Edit`、`Grep`、`Glob` 和 `Bash`，Agent 能工作，但它理解代码的方式主要还是文本级的。官方 Claude Code 的体验更接近一个“带工具的 IDE Agent”：它能知道一个符号在哪里定义、哪里被引用、当前文件有哪些函数和类型、某段代码的类型信息是什么、编辑之后引入了哪些新的诊断问题，并且能把这些信号压缩成上下文交给模型。

这一层不应该替代文件读写工具。

它的职责是：

- 在修改前帮助 Agent 找到真实定义，而不是靠搜索猜测。
- 在重构前帮助 Agent 找到真实引用，而不是靠字符串匹配。
- 在阅读大文件前提取文档符号轮廓，而不是一次性塞完整文件。
- 在编辑后收集新增诊断，而不是把历史错误都推给模型。
- 在对话空闲时维护 Magic Docs，让项目知识持续更新。
- 在插件体系中按语言启用 LSP，而不是把所有语言服务硬编码进主程序。

本章会设计并实现一套可落地的代码智能层。它会对齐当前仓库里已经存在的机制：

- `packages/builtin-tools/src/tools/LSPTool/LSPTool.ts`
- `packages/builtin-tools/src/tools/LSPTool/schemas.ts`
- `packages/builtin-tools/src/tools/LSPTool/formatters.ts`
- `packages/builtin-tools/src/tools/LSPTool/symbolContext.ts`
- `src/services/lsp/LSPServerManager.ts`
- `src/services/lsp/LSPServerInstance.ts`
- `src/services/lsp/LSPClient.ts`
- `src/services/lsp/config.ts`
- `src/services/lsp/passiveFeedback.ts`
- `src/services/lsp/LSPDiagnosticRegistry.ts`
- `src/services/diagnosticTracking.ts`
- `src/services/MagicDocs/magicDocs.ts`
- `src/services/MagicDocs/prompts.ts`
- `src/utils/plugins/lspPluginIntegration.ts`
- `src/utils/plugins/lspRecommendation.ts`
- `src/components/DiagnosticsDisplay.tsx`
- `src/components/LspRecommendation/LspRecommendationMenu.tsx`

> 本章仍然保持教程式实现。可以把代码放到独立的 `src/code-intelligence/` 命名空间里练习，也可以按现有仓库结构逐步接入。

---

## 65.1 为什么 Claude Code 需要 LSP

文本搜索适合找字符串。

LSP 适合找语义。

比如用户说：

> 把 `createSession` 的返回结构加一个字段，并修复所有调用方。

如果 Agent 只用 `Grep`：

- 它可能搜到注释里的 `createSession`。
- 它可能漏掉重命名导入后的调用。
- 它可能分不清同名函数。
- 它可能不知道接口定义、实现、测试和 mock 之间的关系。

如果 Agent 能用 LSP：

- 先 `goToDefinition` 找到真实定义。
- 再 `findReferences` 找到引用。
- 再 `documentSymbol` 看当前文件结构。
- 再 `hover` 获取类型签名。
- 编辑后通过 diagnostics 确认没有新增错误。

这就是代码智能层的核心价值。

Claude Code 的工具层应该有两种能力：

1. 文本级能力：读文件、搜索、写入、执行命令。
2. 语义级能力：定义、引用、符号、类型、诊断、调用关系。

两者配合，才接近官方体验。

---

## 65.2 总体架构

代码智能层可以拆成六个模块：

```text
┌────────────────────────────────────────────────────────────┐
│                    Agent Main Loop                          │
│  prompt -> context -> tools -> edit -> diagnostics -> reply  │
└──────────────────────────────┬─────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────┐
│                    Code Intelligence                         │
│  LSP Tool / Project Index / Diagnostics / Magic Docs         │
└───────┬─────────────┬─────────────┬──────────────┬──────────┘
        │             │             │              │
┌───────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐ ┌─────▼─────────┐
│ LSP Manager  │ │ Indexer  │ │ Diagnostic │ │ Magic Docs     │
│ lifecycle    │ │ symbols  │ │ baseline   │ │ updater        │
└───────┬──────┘ └────┬─────┘ └─────┬──────┘ └─────┬─────────┘
        │             │             │              │
┌───────▼─────────────▼─────────────▼──────────────▼──────────┐
│                Files, Plugin LSP Servers, IDE MCP            │
└──────────────────────────────────────────────────────────────┘
```

每个模块只做一件事：

- LSP Manager：发现、启动、路由和关闭语言服务。
- LSP Tool：把语义能力暴露成模型可调用的工具。
- Project Index：缓存符号、定义、引用、诊断摘要和文件摘要。
- Diagnostic Tracker：只报告本轮新增诊断。
- Magic Docs：把对话中的新知识沉淀到项目文档。
- Context Injector：把语义摘要压缩成可控 token 的上下文块。

注意：不要让 LSP 层直接修改文件。LSP 层应该是只读语义查询和诊断反馈，写操作仍然由 FileEdit/FileWrite 或更上层的编辑器完成。

---

## 65.3 LSP Tool 的工具面

当前仓库的 `LSPTool` 已经覆盖了官方体验中最关键的操作：

- `goToDefinition`
- `findReferences`
- `hover`
- `documentSymbol`
- `workspaceSymbol`
- `goToImplementation`
- `prepareCallHierarchy`
- `incomingCalls`
- `outgoingCalls`

从 Agent 的角度，工具输入应该保持小而稳定：

```ts
export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls";

export type LspToolInput = {
  operation: LspOperation;
  filePath: string;
  line: number;
  character: number;
};
```

即使 `workspaceSymbol` 本质上不需要精确行列，也建议保留统一输入结构。模型侧少一种分支，工具侧更容易复用权限、展示和日志逻辑。

实现时要把输入转换成 LSP 的 0 基坐标：

```ts
export function toLspPosition(line: number, character: number) {
  return {
    line: line - 1,
    character: character - 1,
  };
}
```

工具处理流程应固定：

```text
validate input
  -> expand path
  -> check read permission
  -> ensure LSP initialized
  -> choose server by file extension
  -> open file if needed
  -> send LSP request
  -> filter ignored files
  -> format result for model
```

这里有三个容易踩坑的点。

第一，LSP 的 URI 和本地文件路径不是一回事。工具输入应该是文件路径，语言服务通信时才转换成 `file://` URI。

第二，LSP 对行列非常敏感。对用户和模型暴露 1 基坐标，对 LSP 内部使用 0 基坐标，可以避免 UI 和编辑器显示不一致。

第三，LSP 返回的位置可能来自依赖、生成文件或被忽略文件。传给模型前要做过滤，否则上下文会被无关结果污染。

---

## 65.4 操作到协议方法的映射

可以把 LSP Tool 的操作映射集中写成一个纯函数：

```ts
export function getLspMethod(operation: LspOperation): string {
  switch (operation) {
    case "goToDefinition":
      return "textDocument/definition";
    case "findReferences":
      return "textDocument/references";
    case "hover":
      return "textDocument/hover";
    case "documentSymbol":
      return "textDocument/documentSymbol";
    case "workspaceSymbol":
      return "workspace/symbol";
    case "goToImplementation":
      return "textDocument/implementation";
    case "prepareCallHierarchy":
      return "textDocument/prepareCallHierarchy";
    case "incomingCalls":
      return "callHierarchy/incomingCalls";
    case "outgoingCalls":
      return "callHierarchy/outgoingCalls";
  }
}
```

但 `incomingCalls` 和 `outgoingCalls` 有一个特殊点：它们不能直接拿普通位置请求。

正确流程是：

```text
textDocument/prepareCallHierarchy(position)
  -> choose first CallHierarchyItem
  -> callHierarchy/incomingCalls(item)
```

也就是说调用层级是两段式。

可以封装成：

```ts
export async function requestCallHierarchy(
  manager: LspRequestManager,
  filePath: string,
  position: { line: number; character: number },
  direction: "incoming" | "outgoing",
) {
  const items = await manager.sendRequest<CallHierarchyItem[]>(
    filePath,
    "textDocument/prepareCallHierarchy",
    {
      textDocument: manager.textDocument(filePath),
      position,
    },
  );

  const item = items[0];
  if (!item) {
    return [];
  }

  return manager.sendRequest(
    filePath,
    direction === "incoming"
      ? "callHierarchy/incomingCalls"
      : "callHierarchy/outgoingCalls",
    { item },
  );
}
```

这样模型不用知道 LSP 的两段式细节，只需要说“查这个函数的调用方”。

---

## 65.5 LSP Server Manager

LSP Manager 的职责不是“实现语言服务”，而是管理语言服务进程。

它需要维护这些状态：

```ts
export type LspServerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type LspServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workspaceFolder?: string;
  startupTimeout?: number;
  maxRestarts?: number;
  extensionToLanguage: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
};

export type ScopedLspServerConfig = LspServerConfig & {
  scope: "dynamic";
  source: string;
};
```

Manager 需要维护两张表：

```ts
type LspManagerState = {
  servers: Map<string, LspServerInstance>;
  extensionMap: Map<string, string[]>;
  openedFiles: Map<string, string>;
};
```

含义：

- `servers`：serverName 到 server instance。
- `extensionMap`：文件扩展名到可用 serverName 列表。
- `openedFiles`：文件 URI 到处理它的 serverName。

初始化流程：

```ts
export async function initializeLspManager(
  configs: Record<string, ScopedLspServerConfig>,
): Promise<LspManagerState> {
  const state: LspManagerState = {
    servers: new Map(),
    extensionMap: new Map(),
    openedFiles: new Map(),
  };

  for (const [name, config] of Object.entries(configs)) {
    const instance = createLspServerInstance(name, config);
    state.servers.set(name, instance);

    for (const ext of Object.keys(config.extensionToLanguage)) {
      const existing = state.extensionMap.get(ext) ?? [];
      existing.push(name);
      state.extensionMap.set(ext, existing);
    }
  }

  return state;
}
```

注意：初始化 Manager 时不一定马上启动所有语言服务。

更好的方式是懒启动：

```text
Claude Code startup
  -> read plugin LSP configs
  -> create server instances
  -> do not spawn processes yet

first LSP request for .ts
  -> select TypeScript server
  -> start process
  -> initialize
  -> open file
  -> request definition
```

这样可以避免启动时拉起一堆用户未必会用到的服务。

---

## 65.6 语言服务实例生命周期

单个 LSP Server Instance 最少要支持这些方法：

```ts
export type LspServerInstance = {
  readonly name: string;
  readonly config: ScopedLspServerConfig;
  readonly state: LspServerState;
  readonly lastError?: Error;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isHealthy(): boolean;

  sendRequest<T>(method: string, params: unknown): Promise<T>;
  sendNotification(method: string, params: unknown): Promise<void>;

  onNotification(method: string, handler: (params: unknown) => void): void;
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void;
};
```

状态机：

```text
stopped -> starting -> running
running -> stopping -> stopped
running -> error
error   -> starting
```

启动时要发送 LSP `initialize` 请求，并声明客户端能力：

```ts
export function buildInitializeParams(
  workspaceFolder: string,
  initializationOptions?: Record<string, unknown>,
) {
  const workspaceUri = pathToFileUrl(workspaceFolder);

  return {
    processId: process.pid,
    initializationOptions: initializationOptions ?? {},
    workspaceFolders: [
      {
        uri: workspaceUri,
        name: basename(workspaceFolder),
      },
    ],
    rootPath: workspaceFolder,
    rootUri: workspaceUri,
    capabilities: {
      workspace: {
        configuration: false,
        workspaceFolders: false,
      },
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: true,
        },
        publishDiagnostics: {
          relatedInformation: true,
          versionSupport: false,
        },
        hover: {
          dynamicRegistration: false,
          contentFormat: ["markdown", "plaintext"],
        },
        definition: {
          dynamicRegistration: false,
          linkSupport: true,
        },
        references: {
          dynamicRegistration: false,
        },
        documentSymbol: {
          dynamicRegistration: false,
          hierarchicalDocumentSymbolSupport: true,
        },
        callHierarchy: {
          dynamicRegistration: false,
        },
      },
      general: {
        positionEncodings: ["utf-16"],
      },
    },
  };
}
```

这里的能力声明要保守。

不要声称支持你没有实现的能力。比如没有处理 `workspace/didChangeWorkspaceFolders`，就不要声明支持 workspace folders change。

---

## 65.7 文件同步：open、change、save、close

LSP 不直接读你的磁盘状态。客户端要通过通知告诉语言服务当前文件内容。

最小同步协议：

```text
openFile(file)
  -> textDocument/didOpen

changeFile(file, content, version)
  -> textDocument/didChange

saveFile(file)
  -> textDocument/didSave

closeFile(file)
  -> textDocument/didClose
```

可以实现一个文档状态：

```ts
export type OpenDocument = {
  uri: string;
  filePath: string;
  languageId: string;
  version: number;
  serverName: string;
};

export class OpenDocumentRegistry {
  private docs = new Map<string, OpenDocument>();

  get(uri: string): OpenDocument | undefined {
    return this.docs.get(uri);
  }

  set(doc: OpenDocument): void {
    this.docs.set(doc.uri, doc);
  }

  delete(uri: string): void {
    this.docs.delete(uri);
  }
}
```

`openFile` 的实现：

```ts
export async function openFileForLsp(
  manager: LspManagerState,
  filePath: string,
  content: string,
): Promise<OpenDocument> {
  const uri = pathToFileUrl(filePath);
  const existing = manager.openedFiles.get(uri);
  if (existing) {
    return {
      uri,
      filePath,
      languageId: "unknown",
      version: 1,
      serverName: existing,
    };
  }

  const serverName = selectServerForFile(manager, filePath);
  const server = manager.servers.get(serverName);
  if (!server) {
    throw new Error(`No LSP server found for ${filePath}`);
  }

  await server.start();

  const languageId = getLanguageId(server.config, filePath);
  await server.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId,
      version: 1,
      text: content,
    },
  });

  manager.openedFiles.set(uri, serverName);

  return {
    uri,
    filePath,
    languageId,
    version: 1,
    serverName,
  };
}
```

关键是：在发起 definition、hover、references 等请求前，必须确保文件已经被语言服务打开。

否则有些语言服务只会基于旧索引返回结果，或者直接没有结果。

---

## 65.8 请求路由与扩展名映射

插件 LSP 配置中应该显式声明扩展名到语言 ID 的映射：

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact"
    }
  }
}
```

Manager 根据文件扩展名选择 server：

```ts
export function selectServerForFile(
  manager: LspManagerState,
  filePath: string,
): string {
  const ext = extname(filePath).toLowerCase();
  const candidates = manager.extensionMap.get(ext);

  if (!candidates || candidates.length === 0) {
    throw new Error(`No LSP server configured for extension ${ext}`);
  }

  return candidates[0];
}
```

如果多个插件都支持同一种扩展名，可以用这些规则排序：

1. 用户显式选择的 server 优先。
2. 官方或受信 marketplace 插件优先。
3. 当前项目已经启用的插件优先。
4. 配置加载顺序兜底。

不要把这个选择权藏在模型里。模型应该调用统一工具，路由策略由客户端负责。

---

## 65.9 插件式 LSP 配置

当前仓库的 LSP 服务器来自插件，而不是用户随手写的任意配置。这是更安全的方式。

插件可以通过两种方式声明 LSP：

```text
plugin root
  -> .lsp.json
  -> manifest.lspServers
```

示例：

```json
{
  "name": "typescript-lsp",
  "description": "TypeScript code intelligence",
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      },
      "startupTimeout": 10000,
      "maxRestarts": 3
    }
  }
}
```

如果 `lspServers` 指向单独文件，必须防止路径穿越：

```ts
export function validatePathWithinPlugin(
  pluginPath: string,
  relativePath: string,
): string | null {
  const pluginRoot = resolve(pluginPath);
  const filePath = resolve(pluginPath, relativePath);
  const rel = relative(pluginRoot, filePath);

  if (rel.startsWith("..") || resolve(rel) === rel) {
    return null;
  }

  return filePath;
}
```

配置加载后要加插件作用域，避免不同插件使用同名 server：

```ts
export function addPluginScopeToLspServers(
  servers: Record<string, LspServerConfig>,
  pluginName: string,
): Record<string, ScopedLspServerConfig> {
  const scoped: Record<string, ScopedLspServerConfig> = {};

  for (const [name, config] of Object.entries(servers)) {
    scoped[`plugin:${pluginName}:${name}`] = {
      ...config,
      scope: "dynamic",
      source: pluginName,
    };
  }

  return scoped;
}
```

这样 `typescript` 这个名字只在插件内部有意义，运行时名字会变成：

```text
plugin:typescript-lsp:typescript
```

---

## 65.10 LSP 推荐安装

官方体验里，用户打开某类文件时，如果缺少对应 LSP，终端可以提示是否安装插件。

但推荐逻辑必须克制：

- 只从已登记 marketplace 中找插件。
- 只推荐支持当前扩展名的插件。
- 只推荐本机已经存在二进制命令的插件。
- 已安装的不再推荐。
- 用户拒绝多次后自动停止打扰。
- 用户可以对单个插件选择 never。
- 用户可以全局关闭推荐。

推荐结构：

```ts
export type LspPluginRecommendation = {
  pluginId: string;
  pluginName: string;
  marketplaceName: string;
  description?: string;
  isOfficial: boolean;
  extensions: string[];
  command: string;
};
```

过滤流程：

```text
read file extension
  -> scan marketplace entries with inline lspServers
  -> extract extensionToLanguage and command
  -> skip already installed
  -> skip never suggest list
  -> check binary exists
  -> sort official first
  -> show permission dialog
```

UI 上不要自动安装。语言服务是可执行程序，必须让用户确认。

---

## 65.11 LSP Tool 的权限边界

LSP Tool 看起来是只读工具，但它仍然有安全边界。

它会：

- 读取目标文件内容。
- 启动语言服务进程。
- 把文件 URI 和项目结构发送给语言服务。
- 接收语言服务返回的位置、类型和诊断。

所以它至少要遵守读权限：

```ts
export async function checkLspReadPermission(
  filePath: string,
  canRead: (path: string) => Promise<boolean>,
): Promise<void> {
  const allowed = await canRead(filePath);
  if (!allowed) {
    throw new Error(`LSP read denied: ${filePath}`);
  }
}
```

还要避免泄露网络路径：

```ts
export function isUnsafeNetworkPath(filePath: string): boolean {
  return filePath.startsWith("\\\\");
}
```

在 Windows 上，UNC 路径可能导致凭据泄露。LSP Tool 应该拒绝这类路径，或者要求显式确认。

---

## 65.12 Gitignore 过滤

语言服务可能返回被忽略目录里的位置，比如构建产物、缓存、临时文件。

这些位置对 Agent 通常没有帮助，还会消耗上下文。

可以做一个过滤器：

```ts
export type LspLocation = {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

export async function filterIgnoredLocations(
  locations: LspLocation[],
  isIgnored: (filePath: string) => Promise<boolean>,
): Promise<LspLocation[]> {
  const result: LspLocation[] = [];

  for (const location of locations) {
    const filePath = fileUrlToPath(location.uri);
    if (!(await isIgnored(filePath))) {
      result.push(location);
    }
  }

  return result;
}
```

真实工程里要批量检查，避免对每个结果都启动一次进程。可以把 50 个路径作为一批。

过滤适用场景：

- definition
- references
- implementation
- workspace symbols

hover 和 document symbols 一般只看当前文件，不需要 gitignore 过滤。

---

## 65.13 格式化给模型看的结果

LSP 返回的是结构化 JSON，但模型更适合读短文本摘要。

定义结果可以这样格式化：

```text
Defined in src/session/createSession.ts:42:17
```

多个定义：

```text
Found 2 definitions:
  src/types/session.ts:12:8
  src/session/createSession.ts:42:17
```

引用结果按文件分组：

```text
Found 8 references across 3 files:

src/session/createSession.ts:
  Line 42:17
  Line 81:10

src/screens/REPL.tsx:
  Line 310:22
  Line 518:14
```

document symbols 保持层级：

```text
Document symbols:
createSession (Function) - Line 42
  validateInput (Function) - Line 55
  buildMetadata (Function) - Line 71
SessionState (Interface) - Line 104
```

格式化原则：

- 路径尽量相对项目根展示。
- 行列使用 1 基坐标。
- 多文件结果按文件分组。
- 空结果要解释可能原因。
- 不要输出完整大段源码。
- 不要把 malformed LSP 数据直接抛给模型。

---

## 65.14 符号上下文展示

当 LSP Tool 被调用时，终端 UI 里最好显示“正在查询哪个符号”，而不仅是 `line:character`。

可以从文件中提取光标位置附近的词：

```ts
export function getSymbolAtPosition(
  content: string,
  line: number,
  character: number,
): string | null {
  const lines = content.split("\n");
  const lineContent = lines[line];
  if (!lineContent) {
    return null;
  }

  const pattern = /[\w$'!]+|[+\-*/%&|^~<>=]+/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(lineContent)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (character >= start && character < end) {
      return match[0].slice(0, 30);
    }
  }

  return null;
}
```

UI 可以显示：

```text
LSP: go to definition for createSession
```

比下面这种更有用：

```text
LSP: goToDefinition src/session.ts:42:17
```

但这个能力只是展示增强，失败时应该静默降级为行列位置。

---

## 65.15 Project Index 的必要性

LSP 是在线查询。

Project Index 是本地缓存。

为什么还需要 Project Index？

- LSP server 可能还没启动。
- 某些语言没有 LSP 插件。
- 模型需要的是摘要，不是每次都发起实时查询。
- 大项目需要快速定位入口点。
- 对话上下文需要稳定、短小、可复用的语义块。

建议缓存这些内容：

```ts
export type IndexedSymbol = {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  containerName?: string;
};

export type IndexedFile = {
  filePath: string;
  languageId: string;
  symbols: IndexedSymbol[];
  diagnostics: IndexedDiagnostic[];
  summary?: string;
  updatedAt: number;
  contentHash: string;
};

export type ProjectIndex = {
  root: string;
  files: Map<string, IndexedFile>;
  symbolsByName: Map<string, IndexedSymbol[]>;
};
```

Project Index 不要求强一致。

它的目标是给 Agent 提供“足够新、足够短、足够有用”的上下文。

---

## 65.16 建立文件符号索引

最简单的索引来自 `documentSymbol`：

```ts
export async function indexFileSymbols(
  lsp: LspToolClient,
  filePath: string,
): Promise<IndexedSymbol[]> {
  const symbols = await lsp.documentSymbols(filePath);
  return flattenDocumentSymbols(symbols, filePath);
}
```

递归展开：

```ts
export type DocumentSymbolNode = {
  name: string;
  kind: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  children?: DocumentSymbolNode[];
};

export function flattenDocumentSymbols(
  symbols: DocumentSymbolNode[],
  filePath: string,
  containerName?: string,
): IndexedSymbol[] {
  const result: IndexedSymbol[] = [];

  for (const symbol of symbols) {
    result.push({
      name: symbol.name,
      kind: symbol.kind,
      filePath,
      line: symbol.range.start.line + 1,
      containerName,
    });

    if (symbol.children?.length) {
      result.push(
        ...flattenDocumentSymbols(symbol.children, filePath, symbol.name),
      );
    }
  }

  return result;
}
```

如果 LSP 返回的是扁平 `SymbolInformation[]`，也要统一转换成 `IndexedSymbol[]`。

---

## 65.17 增量更新索引

文件写入后，不要全量重建索引。

用内容 hash 判断是否需要更新：

```ts
export async function refreshIndexedFile(
  index: ProjectIndex,
  filePath: string,
  readText: (path: string) => Promise<string>,
  lsp: LspToolClient,
): Promise<void> {
  const content = await readText(filePath);
  const contentHash = await sha256(content);
  const existing = index.files.get(filePath);

  if (existing?.contentHash === contentHash) {
    return;
  }

  const symbols = await indexFileSymbols(lsp, filePath);
  const diagnostics = await lsp.getDiagnostics?.(filePath) ?? [];

  index.files.set(filePath, {
    filePath,
    languageId: detectLanguageId(filePath),
    symbols,
    diagnostics,
    updatedAt: Date.now(),
    contentHash,
  });

  rebuildSymbolNameEntries(index, filePath, symbols);
}
```

`rebuildSymbolNameEntries` 要先清理旧文件里的符号，再写入新符号：

```ts
export function rebuildSymbolNameEntries(
  index: ProjectIndex,
  filePath: string,
  symbols: IndexedSymbol[],
): void {
  for (const [name, entries] of index.symbolsByName) {
    const kept = entries.filter(entry => entry.filePath !== filePath);
    if (kept.length === 0) {
      index.symbolsByName.delete(name);
    } else {
      index.symbolsByName.set(name, kept);
    }
  }

  for (const symbol of symbols) {
    const entries = index.symbolsByName.get(symbol.name) ?? [];
    entries.push(symbol);
    index.symbolsByName.set(symbol.name, entries);
  }
}
```

---

## 65.18 语义上下文注入

语义上下文不是把索引全塞进 prompt。

它应该按当前任务动态选择：

- 用户提到的文件。
- 用户提到的符号。
- 当前打开文件。
- 最近编辑文件。
- 新增诊断所在文件。
- Plan 中涉及的模块。

上下文块可以设计成：

```ts
export type SemanticContextBlock = {
  type:
    | "symbol_outline"
    | "definition"
    | "references"
    | "diagnostics"
    | "magic_doc"
    | "file_summary";
  title: string;
  priority: number;
  tokenEstimate: number;
  content: string;
};
```

选择器：

```ts
export function selectSemanticContext(
  candidates: SemanticContextBlock[],
  budget: number,
): SemanticContextBlock[] {
  const sorted = [...candidates].sort((a, b) => b.priority - a.priority);
  const selected: SemanticContextBlock[] = [];
  let used = 0;

  for (const block of sorted) {
    if (used + block.tokenEstimate > budget) {
      continue;
    }
    selected.push(block);
    used += block.tokenEstimate;
  }

  return selected;
}
```

格式化后注入到模型：

```text
<semantic_context>
<symbol_outline file="src/session.ts">
- createSession (Function) line 42
- SessionState (Interface) line 104
</symbol_outline>

<diagnostics>
src/session.ts:
  Error [Line 47:12] Type 'number' is not assignable to type 'string'
</diagnostics>
</semantic_context>
```

这类上下文应该是“辅助信号”，不要伪装成用户消息。

---

## 65.19 语义编辑提示

语义编辑提示不是自动改代码，而是在模型编辑前提醒它应该先做什么。

比如用户说：

> 重命名 `SessionEvent`。

系统可以注入一条提示：

```text
Before renaming a symbol, use LSP findReferences and goToDefinition when available.
Do not rely on plain text search for semantic rename.
```

也可以由工具选择器产生一个候选动作：

```ts
export type SemanticEditHint = {
  reason: string;
  recommendedTools: Array<{
    toolName: string;
    input: Record<string, unknown>;
  }>;
};

export function buildRenameHint(
  filePath: string,
  line: number,
  character: number,
): SemanticEditHint {
  return {
    reason: "The task appears to rename or modify a symbol across files.",
    recommendedTools: [
      {
        toolName: "LSP",
        input: {
          operation: "goToDefinition",
          filePath,
          line,
          character,
        },
      },
      {
        toolName: "LSP",
        input: {
          operation: "findReferences",
          filePath,
          line,
          character,
        },
      },
    ],
  };
}
```

这里不要强制模型必须调用 LSP。LSP 可能不可用、语言服务可能缺失、任务可能很简单。提示的作用是让模型在风险较高时优先选择语义工具。

---

## 65.20 诊断基线：只报告新增问题

编辑后直接把全部诊断报告给模型，会造成两个问题：

1. 老问题会干扰本轮修复。
2. 模型可能试图修无关错误，扩大修改范围。

更好的方式是建立基线：

```text
before edit
  -> capture diagnostics for target file

after edit
  -> fetch diagnostics again
  -> compare with baseline
  -> report only new diagnostics
```

类型：

```ts
export type Diagnostic = {
  message: string;
  severity: "Error" | "Warning" | "Info" | "Hint";
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source?: string;
  code?: string;
};

export type DiagnosticFile = {
  uri: string;
  diagnostics: Diagnostic[];
};
```

基线跟踪器：

```ts
export class DiagnosticBaseline {
  private before = new Map<string, Diagnostic[]>();

  capture(filePath: string, diagnostics: Diagnostic[]): void {
    this.before.set(normalizeDiagnosticPath(filePath), diagnostics);
  }

  diff(filePath: string, after: Diagnostic[]): Diagnostic[] {
    const key = normalizeDiagnosticPath(filePath);
    const before = this.before.get(key) ?? [];

    return after.filter(
      diagnostic => !before.some(old => diagnosticsEqual(old, diagnostic)),
    );
  }
}
```

诊断相等判断必须包含：

- message
- severity
- source
- code
- start line
- start character
- end line
- end character

不要只比 message。相同 message 可能出现在不同位置。

---

## 65.21 IDE MCP 与 LSP 诊断的两条路径

当前仓库里有两类诊断来源：

1. IDE MCP 主动查询：`diagnosticTracker.getNewDiagnostics()`。
2. LSP passive notification：`textDocument/publishDiagnostics`。

前者适合编辑前后基线比对。

后者适合语言服务异步推送。

它们最终都应该变成统一附件：

```ts
export type DiagnosticsAttachment = {
  type: "diagnostics";
  files: DiagnosticFile[];
  isNew: boolean;
};
```

附件注入时要控制条件：

- 只有主线程对话需要诊断附件。
- 只有 Agent 有能力修复时才注入。
- 空诊断不注入。
- 重复诊断要去重。
- 数量要限制。

数量限制建议：

```ts
export const MAX_DIAGNOSTICS_PER_FILE = 10;
export const MAX_TOTAL_DIAGNOSTICS = 30;
```

排序上优先 Error，再 Warning，再 Info，再 Hint。

---

## 65.22 Passive LSP Diagnostics Registry

语言服务可能在任意时间发来诊断。

不能在通知回调里直接插入对话。应该先放入 pending registry，下一次组装附件时再消费。

```ts
export type PendingLspDiagnostic = {
  serverName: string;
  files: DiagnosticFile[];
  timestamp: number;
  attachmentSent: boolean;
};

export class LspDiagnosticRegistry {
  private pending = new Map<string, PendingLspDiagnostic>();
  private delivered = new Map<string, Set<string>>();

  register(serverName: string, files: DiagnosticFile[]): void {
    this.pending.set(crypto.randomUUID(), {
      serverName,
      files,
      timestamp: Date.now(),
      attachmentSent: false,
    });
  }

  drain(): Array<{ serverName: string; files: DiagnosticFile[] }> {
    const files: DiagnosticFile[] = [];
    const serverNames = new Set<string>();

    for (const item of this.pending.values()) {
      if (!item.attachmentSent) {
        files.push(...item.files);
        serverNames.add(item.serverName);
        item.attachmentSent = true;
      }
    }

    this.pending.clear();

    const deduped = this.deduplicate(files);
    if (deduped.length === 0) {
      return [];
    }

    return [
      {
        serverName: [...serverNames].join(", "),
        files: deduped,
      },
    ];
  }

  private deduplicate(files: DiagnosticFile[]): DiagnosticFile[] {
    const byUri = new Map<string, DiagnosticFile>();

    for (const file of files) {
      const out = byUri.get(file.uri) ?? { uri: file.uri, diagnostics: [] };
      const seen = new Set(out.diagnostics.map(createDiagnosticKey));

      for (const diagnostic of file.diagnostics) {
        const key = createDiagnosticKey(diagnostic);
        if (!seen.has(key)) {
          out.diagnostics.push(diagnostic);
          seen.add(key);
        }
      }

      byUri.set(file.uri, out);
    }

    return [...byUri.values()].filter(file => file.diagnostics.length > 0);
  }
}
```

跨轮去重也很重要。否则同一个 LSP diagnostic 会每轮都提醒模型。

---

## 65.23 诊断附件展示

默认视图不要铺满终端，只展示摘要：

```text
Found 3 new diagnostic issues in 2 files
```

展开视图再展示详情：

```text
src/session.ts:
  x [Line 47:12] Type 'number' is not assignable to type 'string' [2322] (ts)
  ! [Line 82:5] 'result' is declared but never used [6133] (ts)
```

UI 组件可以接收：

```ts
export type DiagnosticsDisplayProps = {
  attachment: DiagnosticsAttachment;
  verbose: boolean;
};
```

伪实现：

```tsx
export function DiagnosticsDisplay({
  attachment,
  verbose,
}: DiagnosticsDisplayProps) {
  const total = attachment.files.reduce(
    (sum, file) => sum + file.diagnostics.length,
    0,
  );

  if (!verbose) {
    return (
      <Text dimColor>
        Found <Text bold>{total}</Text> new diagnostic issues in{" "}
        {attachment.files.length} files
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {attachment.files.map(file => (
        <Box key={file.uri} flexDirection="column">
          <Text bold>{file.uri}</Text>
          {file.diagnostics.map((diagnostic, index) => (
            <Text key={index} dimColor>
              {formatDiagnostic(diagnostic)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
```

注意：终端 UI 里的诊断不是最终回答。它是给用户和模型共同看的过程信号。

---

## 65.24 Magic Docs 的定位

Magic Docs 是项目知识的自动维护层。

它不是普通文档生成器，也不是 changelog。

它的特点是：

- 文件用特殊 header 标记。
- 只有读过的 Magic Doc 会被追踪。
- 主对话空闲时触发更新。
- 更新由受限子代理完成。
- 子代理只能编辑当前 Magic Doc。
- 没有新信息时不修改。

Magic Doc header：

```md
# MAGIC DOC: Code Intelligence
_Only keep stable architecture and entry points._
```

第一行是标题。

第二行可选，是文档专属更新指令。

检测函数：

```ts
export type MagicDocInfo = {
  title: string;
  instructions?: string;
};

export function detectMagicDocHeader(content: string): MagicDocInfo | null {
  const lines = content.split("\n");
  const first = lines[0]?.trim();
  const match = first?.match(/^# MAGIC DOC:\s*(.+)$/);
  if (!match) {
    return null;
  }

  const second = lines[1]?.trim();
  const instructionMatch = second?.match(/^_(.+)_$/);

  return {
    title: match[1].trim(),
    instructions: instructionMatch?.[1]?.trim(),
  };
}
```

Magic Docs 的价值不是“自动多写文档”，而是把对话中真正稳定的新知识沉淀下来。

---

## 65.25 Magic Docs 更新流程

流程可以这样设计：

```text
FileRead reads a file
  -> detect # MAGIC DOC
  -> register tracked doc

assistant turn finishes
  -> if no tool calls
  -> update tracked docs sequentially
  -> run restricted sub-agent
  -> allow only Edit on that doc
```

为什么要在“没有 tool calls 的 assistant turn 后”更新？

因为这通常意味着主任务进入暂时稳定状态。此时更新文档，不容易和正在执行的编辑动作冲突。

核心更新函数：

```ts
export async function updateMagicDoc(
  doc: TrackedMagicDoc,
  context: MagicDocContext,
): Promise<void> {
  const current = await context.readFile(doc.filePath);
  const header = detectMagicDocHeader(current);
  if (!header) {
    context.untrack(doc.filePath);
    return;
  }

  const prompt = await buildMagicDocUpdatePrompt({
    docPath: doc.filePath,
    docContents: current,
    docTitle: header.title,
    instructions: header.instructions,
    conversation: context.conversation,
  });

  await context.runSubAgent({
    name: "magic-docs",
    prompt,
    allowedTools: [
      {
        name: "Edit",
        filePath: doc.filePath,
      },
    ],
  });
}
```

受限子代理非常重要。Magic Docs 更新不应该能随意读写项目其他文件。

---

## 65.26 Magic Docs 更新提示词

更新提示词要强调四件事：

1. 不要把更新指令写进文档。
2. 保留 Magic Doc header。
3. 文档表达当前状态，不写历史流水。
4. 只在有实质新信息时编辑。

模板：

```text
You are updating one Magic Doc.

The file has already been read.
Your only allowed edit target is:
{{docPath}}

Preserve this header exactly:
# MAGIC DOC: {{docTitle}}

If an italic instruction line exists immediately after the header, preserve it.

Update the document only if the conversation contains substantial new stable knowledge.
Keep the document current. Do not append historical change notes.
Prefer architecture, entry points, invariants, and navigation hints.
Avoid duplicating details that are obvious from source code.

Current document:
<current_doc_content>
{{docContents}}
</current_doc_content>

Document-specific instructions:
{{customInstructions}}
```

Magic Docs 的核心约束是“少写但写准”。

一个好的 Magic Doc 应该帮未来的 Agent 快速进入上下文，而不是把源码复述一遍。

---

## 65.27 代码智能上下文预算

代码智能很容易膨胀。

比如 `findReferences` 可能返回几百个引用。diagnostics 可能有几十个文件。workspace symbols 可能上千个符号。

必须加预算：

```ts
export type ContextBudget = {
  maxBlocks: number;
  maxCharsPerBlock: number;
  maxTotalChars: number;
};

export const DEFAULT_SEMANTIC_CONTEXT_BUDGET: ContextBudget = {
  maxBlocks: 8,
  maxCharsPerBlock: 4000,
  maxTotalChars: 12000,
};
```

截断函数：

```ts
export function truncateContextBlock(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars - 20)}\n...[truncated]`;
}
```

选择策略：

```text
diagnostics in edited files
  > definitions for mentioned symbols
  > references for active rename/refactor task
  > current file outline
  > Magic Docs
  > workspace symbol search results
```

这样可以避免“看起来很智能，但上下文被低价值信号占满”。

---

## 65.28 LSP 错误与重试

语言服务不是稳定 RPC。

常见问题：

- server binary 不存在。
- server 启动慢。
- workspace 还在索引。
- 请求时文件内容已变化。
- server 崩溃。
- server 返回 malformed URI。
- server 返回外部依赖里的位置。

对 transient error 要重试。

比如 LSP `ContentModified` 错误：

```ts
const LSP_ERROR_CONTENT_MODIFIED = -32801;

export async function sendLspRequestWithRetry<T>(
  send: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await send();
    } catch (error) {
      lastError = error;
      const code = (error as { code?: number }).code;
      const retryable = code === LSP_ERROR_CONTENT_MODIFIED;

      if (!retryable || attempt === maxRetries) {
        break;
      }

      await sleep(500 * 2 ** attempt);
    }
  }

  throw lastError;
}
```

对启动超时要清理子进程，避免残留。

对崩溃重启要有上限，避免每次工具调用都反复拉起一个必崩的 server。

---

## 65.29 和工具系统的集成

LSP Tool 是只读工具，应声明：

```ts
export const LspToolDefinition = {
  name: "LSP",
  description: "Code intelligence: definitions, references, symbols, hover.",
  isReadOnly: true,
  isConcurrencySafe: true,
  isLsp: true,
};
```

是否启用由 Manager 状态决定：

```ts
export function isLspToolEnabled(manager: LspManagerState | undefined): boolean {
  if (!manager) {
    return false;
  }

  for (const server of manager.servers.values()) {
    if (server.state !== "error") {
      return true;
    }
  }

  return false;
}
```

这样没有 LSP 插件时，模型不会看到不可用工具。

如果初始化仍在 pending，可以在工具调用时等待一小段：

```ts
export async function ensureLspReady(
  status: InitializationStatus,
  wait: () => Promise<void>,
): Promise<void> {
  if (status.status === "pending") {
    await wait();
  }

  if (status.status === "failed") {
    throw status.error;
  }
}
```

---

## 65.30 和编辑工具的集成

FileEdit/FileWrite 要在写入前通知诊断基线：

```ts
export async function beforeEditFile(
  filePath: string,
  diagnostics: DiagnosticBaseline,
): Promise<void> {
  await diagnostics.captureForFile(filePath);
}
```

写入后可以：

```text
write file
  -> notify LSP didChange
  -> notify LSP didSave
  -> collect new diagnostics
  -> attach diagnostics to next turn
```

示例：

```ts
export async function afterEditFile(
  filePath: string,
  content: string,
  lsp: LspSyncClient,
  diagnostics: DiagnosticBaseline,
): Promise<Diagnostic[]> {
  await lsp.didChange(filePath, content);
  await lsp.didSave(filePath);

  const latest = await lsp.getDiagnostics(filePath);
  return diagnostics.diff(filePath, latest);
}
```

如果 LSP 不可用，不应阻塞编辑。代码智能是增强层，不是编辑工具的硬依赖。

---

## 65.31 和 Plan 模式的集成

Plan 模式适合利用代码智能做“修改前调研”。

当用户请求涉及跨文件修改时，Plan 可以包含语义步骤：

```text
1. Use LSP goToDefinition on SessionEvent to locate the canonical type.
2. Use LSP findReferences to collect call sites.
3. Use documentSymbol on the primary modules to identify edit boundaries.
4. Edit the smallest set of files.
5. Run Bun typecheck.
6. Inspect new diagnostics only.
```

计划展示不需要暴露 LSP 协议细节。

它应该展示用户能理解的动作：

```text
确认 SessionEvent 的定义和引用
更新类型与调用方
运行类型检查
处理新增诊断
```

模型内部再选择 LSP Tool。

---

## 65.32 和终端 UI 的集成

终端 UI 中，LSP 相关反馈要短。

工具调用展示：

```text
⎿ LSP hover createSession
```

或：

```text
⎿ LSP references SessionEvent
```

诊断展示默认收起：

```text
Found 2 new diagnostic issues in 1 file
```

展开后显示：

```text
src/session.ts:
  x [Line 42:11] Property 'id' is missing
  ! [Line 78:5] Unused variable 'event'
```

LSP 推荐安装弹窗要明确：

```text
LSP Plugin Recommendation

LSP provides code intelligence like go-to-definition and error checking
Plugin: typescript-lsp
Triggered by: .ts files

Would you like to install this LSP plugin?
```

选项：

- Yes, install
- No, not now
- Never for this plugin
- Disable all recommendations

---

## 65.33 和多 Agent 的集成

子代理可以使用 LSP，但要遵守上下文隔离。

建议：

- 主代理负责用户交互和最终编辑策略。
- Explore/Research 类子代理可以使用 LSP 查询定义、引用、符号。
- Magic Docs 子代理只允许编辑目标文档。
- Review 子代理可以读取 diagnostics 和 diff，但不直接写文件。

子代理返回内容要压缩：

```text
Symbol: createSession
Definition: src/session/createSession.ts:42
References:
- src/screens/REPL.tsx:310
- src/services/sessionStore.ts:88
Risk:
- public API used by tests and remote control bridge
```

不要把完整 LSP JSON 返回给主代理。

---

## 65.34 代码智能的降级策略

必须设计没有 LSP 时的体验。

降级路径：

```text
LSP available
  -> semantic query

LSP unavailable but index exists
  -> use cached index

index unavailable
  -> use Grep/Glob/FileRead

all unavailable
  -> explain limitation and continue with direct file inspection
```

工具内部不要把“没有 LSP”当成任务失败。

可以返回：

```text
LSP is not available for this file type. Use text search or install a matching LSP plugin.
```

但如果 Agent 已经有足够文本上下文，就不要频繁打扰用户安装插件。

---

## 65.35 代码智能层的文件结构

如果从教程角度新增一层，可以这样放：

```text
src/code-intelligence/
  index.ts
  lsp/
    manager.ts
    serverInstance.ts
    client.ts
    protocol.ts
    pluginConfig.ts
    diagnosticsRegistry.ts
  indexer/
    projectIndex.ts
    symbolIndex.ts
    refresh.ts
  diagnostics/
    baseline.ts
    compare.ts
    format.ts
  context/
    semanticContext.ts
    budget.ts
    inject.ts
  magic-docs/
    detect.ts
    registry.ts
    update.ts
    prompt.ts
  ui/
    diagnosticsDisplay.tsx
    lspRecommendationMenu.tsx
```

在当前仓库中，大部分能力已经分布在：

```text
src/services/lsp/
src/services/MagicDocs/
src/services/diagnosticTracking.ts
packages/builtin-tools/src/tools/LSPTool/
```

如果你继续工程化，可以优先补：

- 更完整的 project index。
- 语义上下文预算器。
- LSP 结果缓存。
- Magic Docs 的非内部用户启用策略。
- LSP 插件推荐和安装后的 reinitialize 流程验证。

---

## 65.36 最小实现：语义上下文构建器

先实现一个轻量上下文构建器。

```ts
export type SemanticContextInput = {
  mentionedFiles: string[];
  mentionedSymbols: string[];
  recentEditedFiles: string[];
  diagnostics: DiagnosticFile[];
  index: ProjectIndex;
};

export function buildSemanticContextBlocks(
  input: SemanticContextInput,
): SemanticContextBlock[] {
  const blocks: SemanticContextBlock[] = [];

  for (const filePath of input.recentEditedFiles) {
    const file = input.index.files.get(filePath);
    if (!file) {
      continue;
    }

    blocks.push({
      type: "symbol_outline",
      title: `Symbols in ${filePath}`,
      priority: 80,
      tokenEstimate: estimateTokens(file.symbols),
      content: formatSymbolOutline(file.symbols),
    });
  }

  for (const diagnosticFile of input.diagnostics) {
    blocks.push({
      type: "diagnostics",
      title: `Diagnostics in ${diagnosticFile.uri}`,
      priority: 100,
      tokenEstimate: estimateTokens(diagnosticFile.diagnostics),
      content: formatDiagnostics(diagnosticFile),
    });
  }

  for (const symbol of input.mentionedSymbols) {
    const entries = input.index.symbolsByName.get(symbol) ?? [];
    if (entries.length === 0) {
      continue;
    }

    blocks.push({
      type: "definition",
      title: `Known symbols named ${symbol}`,
      priority: 70,
      tokenEstimate: estimateTokens(entries),
      content: formatIndexedSymbols(entries),
    });
  }

  return blocks;
}
```

格式化函数：

```ts
export function formatSymbolOutline(symbols: IndexedSymbol[]): string {
  return symbols
    .slice(0, 80)
    .map(symbol => {
      const container = symbol.containerName
        ? ` in ${symbol.containerName}`
        : "";
      return `- ${symbol.name} (${symbol.kind}) line ${symbol.line}${container}`;
    })
    .join("\n");
}
```

这一步不需要复杂模型总结，先用结构化信息就够有用。

---

## 65.37 最小实现：诊断比较

```ts
export function diagnosticsEqual(a: Diagnostic, b: Diagnostic): boolean {
  return (
    a.message === b.message &&
    a.severity === b.severity &&
    a.source === b.source &&
    a.code === b.code &&
    a.range.start.line === b.range.start.line &&
    a.range.start.character === b.range.start.character &&
    a.range.end.line === b.range.end.line &&
    a.range.end.character === b.range.end.character
  );
}

export function getNewDiagnostics(
  before: Diagnostic[],
  after: Diagnostic[],
): Diagnostic[] {
  return after.filter(
    diagnostic => !before.some(old => diagnosticsEqual(old, diagnostic)),
  );
}
```

测试：

```ts
import { describe, expect, test } from "bun:test";
import { getNewDiagnostics } from "../diagnostics/compare";

describe("getNewDiagnostics", () => {
  test("returns only diagnostics that were not present in the baseline", () => {
    const before = [
      diagnostic("old", "Error", 1, 1),
    ];

    const after = [
      diagnostic("old", "Error", 1, 1),
      diagnostic("new", "Error", 2, 1),
    ];

    expect(getNewDiagnostics(before, after)).toEqual([
      diagnostic("new", "Error", 2, 1),
    ]);
  });
});

function diagnostic(
  message: string,
  severity: "Error" | "Warning" | "Info" | "Hint",
  line: number,
  character: number,
) {
  return {
    message,
    severity,
    range: {
      start: { line, character },
      end: { line, character: character + 1 },
    },
  };
}
```

运行：

```bash
bun test src/code-intelligence/diagnostics/compare.test.ts
```

---

## 65.38 最小实现：Magic Doc 检测

```ts
import { describe, expect, test } from "bun:test";
import { detectMagicDocHeader } from "../magic-docs/detect";

describe("detectMagicDocHeader", () => {
  test("detects title and optional instruction", () => {
    const result = detectMagicDocHeader([
      "# MAGIC DOC: Code Intelligence",
      "_Keep only architecture notes._",
      "",
      "Content",
    ].join("\n"));

    expect(result).toEqual({
      title: "Code Intelligence",
      instructions: "Keep only architecture notes.",
    });
  });

  test("returns null for normal markdown", () => {
    expect(detectMagicDocHeader("# Normal Doc")).toBeNull();
  });
});
```

运行：

```bash
bun test src/code-intelligence/magic-docs/detect.test.ts
```

---

## 65.39 最小实现：上下文预算

```ts
import { describe, expect, test } from "bun:test";
import { selectSemanticContext } from "../context/budget";

describe("selectSemanticContext", () => {
  test("selects highest priority blocks within budget", () => {
    const selected = selectSemanticContext(
      [
        block("low", 10, 20),
        block("high", 100, 80),
        block("medium", 50, 40),
      ],
      100,
    );

    expect(selected.map(item => item.title)).toEqual(["high", "low"]);
  });
});

function block(title: string, priority: number, tokenEstimate: number) {
  return {
    type: "file_summary" as const,
    title,
    priority,
    tokenEstimate,
    content: title,
  };
}
```

运行：

```bash
bun test src/code-intelligence/context/budget.test.ts
```

---

## 65.40 推荐的检查命令

本章相关改动涉及类型、工具输入和异步进程，至少跑：

```bash
bun test src/code-intelligence
bun run typecheck
```

如果改动触及现有 `src/services/lsp/` 或 `packages/builtin-tools/src/tools/LSPTool/`，还应该跑对应就近测试。

---

## 65.41 常见错误

### 把 LSP 当成编辑器

LSP 可以给语义信息，不应该直接替代 Edit 工具。

### 把所有引用都塞进上下文

引用数量可能非常大。要按文件分组、限制数量，并让模型在需要时继续查询。

### 把历史诊断都报告给模型

应该只报告本轮新增诊断。历史诊断可以给用户看，但不应该驱动本轮修改。

### 启动时拉起所有语言服务

会拖慢启动，也容易制造后台进程问题。应懒启动。

### 信任任意 LSP 配置

语言服务是本地可执行程序。配置来源必须受控，并经过用户确认。

### Magic Docs 写成日志

Magic Docs 应该维护当前状态，不应该记录“之前如何、后来如何”的流水。

---

## 65.42 接近官方 Claude Code 的验收标准

实现到这一章后，代码智能层应该满足：

- 打开支持的文件类型时，可以推荐匹配 LSP 插件。
- LSP Tool 只在有健康 server 时暴露。
- Agent 能调用 definition、references、hover、document symbols、workspace symbols、implementation 和 call hierarchy。
- LSP Tool 会先检查读权限。
- LSP 查询前会确保文件已 open。
- 语言服务崩溃或超时不会拖垮主进程。
- LSP diagnostics 可以作为附件进入下一轮上下文。
- FileEdit/FileWrite 前会记录诊断基线。
- 编辑后只报告新增诊断。
- 诊断展示默认摘要，支持展开。
- Project Index 至少能缓存文件符号轮廓。
- 语义上下文注入有预算。
- Magic Docs 能识别、追踪并受限更新。
- 无 LSP 时能降级到文本工具。

这才是“代码工具”到“代码 Agent”的关键一步。

---

## 65.43 本章小结

这一章补上了 Claude Code 的代码智能层。

核心设计是：

- 用 LSP 提供定义、引用、类型、符号和调用关系。
- 用插件体系加载语言服务配置。
- 用 Manager 管理语言服务生命周期。
- 用诊断基线只报告新增问题。
- 用 passive diagnostics 接收异步 LSP 通知。
- 用 Project Index 缓存可复用语义信息。
- 用 Semantic Context Injector 控制上下文预算。
- 用 Magic Docs 自动沉淀稳定项目知识。

如果目标是接近官方 Claude Code，这一层非常关键。没有它，Agent 只是会读写文件；有了它，Agent 才能在大项目里做更可靠的跨文件理解和修改。

下一章建议继续补：`doctor`、`health`、更新检查、环境诊断、自检报告与故障修复建议。代码智能层能告诉 Agent 项目哪里错了，doctor/health 层则要告诉用户“工具本身哪里错了”。
