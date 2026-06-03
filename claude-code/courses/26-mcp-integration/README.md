# 第 26 章：MCP 外部工具接入

第二十五章把 slash command 和能力入口收拢到了统一注册中心。现在 Mini 已经有了一个清晰的扩展入口：外部能力只要能被转换成 `Tool` 或 `Command`，就能进入主循环。

这一章继续做 MCP。

MCP 的价值很直接：不要把所有工具都写死在 Mini 里。数据库、浏览器、设计系统、内部平台、知识库、远程服务，都可以由外部 MCP server 提供。Mini 只需要作为 MCP client 连接它们，然后把它们暴露给模型。

本章先实现最小但真实可用的 MCP client：

- 读取 `.mcp.json` 配置。
- 启动 stdio MCP server。
- 调用 MCP 初始化流程。
- 发现 `tools/list` 并注册成 Mini Tool。
- 调用 `tools/call`。
- 支持 `resources/list` 和 `resources/read`。
- 支持 `prompts/list` 并转换成 slash command。
- 提供 `/mcp` 管理命令。

SSE、HTTP、OAuth、内置 MCP、IDE MCP 这些能力先不做。先把本地 stdio 闭环跑通。

## 真实工程怎么做

真实工程的 MCP 集中在这些位置：

- `src/services/mcp/types.ts`：MCP 配置、连接状态、资源类型。
- `src/services/mcp/config.ts`：合并 user、project、local、plugin、enterprise 等配置来源。
- `src/services/mcp/client.ts`：连接 server、发现工具、读取资源、执行工具。
- `src/services/mcp/useManageMCPConnections.ts`：在 React/Ink 状态里管理连接生命周期。
- `packages/builtin-tools/src/tools/MCPTool/MCPTool.ts`：MCP 工具包装成统一 Tool。
- `packages/builtin-tools/src/tools/ListMcpResourcesTool/`：列出资源。
- `packages/builtin-tools/src/tools/ReadMcpResourceTool/`：读取资源。
- `src/commands/mcp/`：`/mcp` 管理入口。
- `packages/mcp-client/`：抽出的 MCP client 基础能力。

真实工程有 7 类传输层：stdio、SSE、HTTP、WebSocket、IDE、Claude.ai proxy、InProcess。Mini 第一版只做 stdio，因为它最容易本地验证，也覆盖了很多 MCP server 的使用方式。

真实工程还有一个关键设计：MCP 发现出来的工具不会特殊走一套 Agent Loop。它们被转换成统一 Tool，并使用统一的权限、执行、结果写入链路。Mini 也要保持这个方向。

## 本章目标

完成后，用户可以在项目根目录放一个 `.mcp.json`：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

然后启动：

```bash
bun run dev
```

在 Mini 里可以看到：

```text
/mcp list
/mcp tools filesystem
/mcp resources filesystem
```

模型也能调用类似这样的工具名：

```text
mcp__filesystem__read_file
mcp__filesystem__list_directory
```

具体工具名取决于 MCP server 自己返回的 `tools/list`。

## 安装依赖

使用官方 MCP SDK：

```bash
bun add @modelcontextprotocol/sdk
```

如果你的 Mini 前面已经安装过，可以跳过。这里仍然用 Bun 管理依赖。

## 推荐目录

新增：

```text
src/mcp/
  mcpTypes.ts
  mcpConfig.ts
  mcpNames.ts
  mcpClient.ts
  mcpManager.ts
  mcpToolAdapter.ts
  mcpResourceTools.ts
  mcpPromptAdapter.ts

src/commands/
  mcpCommand.ts
```

修改：

```text
src/capabilities/capabilityRuntime.ts
src/tools/toolRegistry.ts
src/commands/builtinCommands.ts
src/chat/agentLoop.ts
```

职责分层：

- `mcpConfig.ts` 只负责读配置。
- `mcpClient.ts` 只负责连接单个 server。
- `mcpManager.ts` 管多个 server 的生命周期。
- `mcpToolAdapter.ts` 把 MCP tool 转成 Mini Tool。
- `mcpPromptAdapter.ts` 把 MCP prompt 转成 slash command。
- `mcpResourceTools.ts` 提供资源读取工具。
- `mcpCommand.ts` 提供用户管理命令。

## MCP 配置类型

Mini 第一版只支持 stdio。

```ts
// src/mcp/mcpTypes.ts
export type McpStdioServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};

export type McpServerConfig = McpStdioServerConfig;

export type McpConfigFile = {
  mcpServers: Record<string, McpServerConfig>;
};

export type McpServerState =
  | {
      type: "connected";
      name: string;
      config: McpServerConfig;
      client: McpConnectedClient;
    }
  | {
      type: "failed";
      name: string;
      config: McpServerConfig;
      error: string;
    }
  | {
      type: "disabled";
      name: string;
      config: McpServerConfig;
    };
```

`McpConnectedClient` 后面定义，它包装 SDK client、transport 和清理函数。

注意 `enabled` 是 Mini 自己加的字段。真实工程会把启用禁用状态放在更完整的 settings 和 AppState 中。Mini 先直接在配置里表达。

## 不要把 secret 写进配置

MCP 配置经常要用 token。不要把 token 直接写进 `.mcp.json`，尤其不要提交到仓库。

推荐用环境变量引用：

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "scripts/internal-mcp.ts"],
      "env": {
        "INTERNAL_API_TOKEN": "${INTERNAL_API_TOKEN}"
      }
    }
  }
}
```

然后在读取配置时展开 `${NAME}`。

```ts
function expandEnvValue(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    return process.env[name] ?? "";
  });
}

function expandEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, expandEnvValue(value)]),
  );
}
```

这不等于加密，只是避免把 secret 写进文件。真正的 secret 管理后面可以接系统 keychain 或团队配置中心。

## 读取 .mcp.json

Mini 先支持两个来源：

- 项目级：`<project>/.mcp.json`
- 用户级：`~/.cc-mini/mcp.json`

项目级覆盖用户级同名 server。

```ts
// src/mcp/mcpConfig.ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpConfigFile, McpServerConfig } from "./mcpTypes";

export async function loadMcpConfig(cwd: string): Promise<Record<string, McpServerConfig>> {
  const userConfig = await readMcpConfigFile(join(homedir(), ".cc-mini", "mcp.json"));
  const projectConfig = await readMcpConfigFile(join(cwd, ".mcp.json"));

  return {
    ...userConfig.mcpServers,
    ...projectConfig.mcpServers,
  };
}

async function readMcpConfigFile(path: string): Promise<McpConfigFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as McpConfigFile;
    return normalizeMcpConfig(parsed);
  } catch (error) {
    if (isMissingFile(error)) {
      return { mcpServers: {} };
    }

    throw new Error(`Failed to read MCP config ${path}: ${String(error)}`);
  }
}

function normalizeMcpConfig(config: McpConfigFile): McpConfigFile {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers ?? {}).map(([name, server]) => [
        name,
        {
          ...server,
          type: server.type ?? "stdio",
          args: server.args ?? [],
          env: expandEnv(server.env),
        },
      ]),
    ),
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
```

真实工程会合并更多来源：local、plugin、enterprise、Claude.ai connectors，并做同内容去重。Mini 第一版先把 user + project 做好。

## MCP 工具命名

MCP server 返回的工具名可能和内置工具重名，所以要加前缀。

真实工程使用：

```text
mcp__<serverName>__<toolName>
```

Mini 也使用这个规则。

```ts
// src/mcp/mcpNames.ts
export function normalizeMcpName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.slice(0, 64);
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(toolName)}`;
}

export function parseMcpToolName(name: string): {
  serverName: string;
  toolName: string;
} | null {
  const parts = name.split("__");
  const [prefix, serverName, ...toolParts] = parts;

  if (prefix !== "mcp" || !serverName || toolParts.length === 0) {
    return null;
  }

  return {
    serverName,
    toolName: toolParts.join("__"),
  };
}
```

这里有个教学版简化：`parseMcpToolName` 解析出来的是 normalized name，不一定等于 server 原始名称。生产实现需要维护 normalized 到 original 的映射。Mini 可以在 manager 里额外存一份 `normalizedServerName -> originalServerName`。

```ts
private normalizedServerNames = new Map<string, string>();

private rememberServerName(name: string): void {
  this.normalizedServerNames.set(normalizeMcpName(name), name);
}

resolveServerName(name: string): string | undefined {
  return this.normalizedServerNames.get(name) ?? name;
}
```

## 连接单个 MCP server

用官方 SDK 建立 stdio 连接：

```ts
// src/mcp/mcpClient.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./mcpTypes";

export type McpConnectedClient = {
  client: Client;
  cleanup(): Promise<void>;
};

export async function connectMcpServer(input: {
  name: string;
  config: McpServerConfig;
  cwd: string;
}): Promise<McpConnectedClient> {
  if (input.config.type && input.config.type !== "stdio") {
    throw new Error(`Unsupported MCP transport: ${input.config.type}`);
  }

  const transport = new StdioClientTransport({
    command: input.config.command,
    args: input.config.args ?? [],
    env: mergeEnv(input.config.env),
    cwd: input.cwd,
  });

  const client = new Client(
    {
      name: "cc-mini",
      version: "0.1.0",
    },
    {
      capabilities: {
        roots: {},
      },
    },
  );

  await withTimeout(
    client.connect(transport),
    30_000,
    `MCP server "${input.name}" connection timed out`,
  );

  return {
    client,
    async cleanup() {
      await client.close();
    },
  };
}

function mergeEnv(env: Record<string, string> | undefined): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );

  return {
    ...base,
    ...(env ?? {}),
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
```

MCP SDK 会处理 stdio 的 JSON-RPC framing。Mini 不需要自己解析 `Content-Length`。

## MCP Manager

Manager 管多个 server：

```ts
// src/mcp/mcpManager.ts
import type { ToolDefinition } from "../tools/toolTypes";
import { loadMcpConfig } from "./mcpConfig";
import { connectMcpServer } from "./mcpClient";
import { mcpToolToToolDefinition } from "./mcpToolAdapter";
import { normalizeMcpName } from "./mcpNames";
import type { McpServerConfig, McpServerState } from "./mcpTypes";

export class McpManager {
  private states = new Map<string, McpServerState>();
  private normalizedServerNames = new Map<string, string>();

  async loadAndConnect(cwd: string): Promise<void> {
    await this.disconnectAll();

    const configs = await loadMcpConfig(cwd);

    for (const [name, config] of Object.entries(configs)) {
      this.normalizedServerNames.set(normalizeMcpName(name), name);

      if (config.enabled === false) {
        this.states.set(name, { type: "disabled", name, config });
        continue;
      }

      try {
        const connected = await connectMcpServer({ name, config, cwd });
        this.states.set(name, {
          type: "connected",
          name,
          config,
          client: connected,
        });
      } catch (error) {
        this.states.set(name, {
          type: "failed",
          name,
          config,
          error: String(error),
        });
      }
    }
  }

  listServers(): McpServerState[] {
    return [...this.states.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getConnectedServer(name: string): Extract<McpServerState, { type: "connected" }> | undefined {
    const originalName = this.normalizedServerNames.get(name) ?? name;
    const state = this.states.get(originalName);
    return state?.type === "connected" ? state : undefined;
  }

  async disconnectAll(): Promise<void> {
    const connected = [...this.states.values()].filter(
      (state): state is Extract<McpServerState, { type: "connected" }> => {
        return state.type === "connected";
      },
    );

    await Promise.all(connected.map((state) => state.client.cleanup()));
    this.states.clear();
    this.normalizedServerNames.clear();
  }
}
```

启动和退出时都要调用：

```ts
const mcpManager = new McpManager();
await mcpManager.loadAndConnect(process.cwd());

process.on("exit", () => {
  void mcpManager.disconnectAll();
});
```

真实工程对子进程清理做了信号升级：先 `SIGINT`，再 `SIGTERM`，最后 `SIGKILL`。Mini 先交给 SDK `client.close()`，后续如果遇到 server 不退出，再补进程级清理。

## 发现 MCP 工具

MCP 工具发现调用 `tools/list`：

```ts
// src/mcp/mcpToolAdapter.ts
import {
  ListToolsResultSchema,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "../tools/toolTypes";
import type { McpManager } from "./mcpManager";
import { buildMcpToolName } from "./mcpNames";

export async function discoverMcpTools(
  manager: McpManager,
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];

  for (const server of manager.listServers()) {
    if (server.type !== "connected") continue;

    const result = await server.client.client.request(
      { method: "tools/list" },
      ListToolsResultSchema,
    );

    for (const tool of result.tools ?? []) {
      tools.push(mcpToolToToolDefinition(manager, server.name, tool));
    }
  }

  return tools;
}

export function mcpToolToToolDefinition(
  manager: McpManager,
  serverName: string,
  tool: McpTool,
): ToolDefinition {
  const name = buildMcpToolName(serverName, tool.name);

  return {
    name,
    description: truncateDescription(tool.description ?? ""),
    inputSchema: tool.inputSchema,
    isReadOnly: () => tool.annotations?.readOnlyHint === true,
    isDestructive: () => tool.annotations?.destructiveHint === true,
    async execute(input) {
      const server = manager.getConnectedServer(serverName);
      if (!server) {
        throw new Error(`MCP server "${serverName}" is not connected`);
      }

      return callMcpTool(server.client.client, tool.name, input);
    },
  };
}

function truncateDescription(description: string): string {
  const max = 2048;
  return description.length > max
    ? `${description.slice(0, max)}... [truncated]`
    : description;
}
```

真实工程会把 `readOnlyHint` 映射成并发安全和只读标记，把 `destructiveHint` 映射成破坏性标记，把 `openWorldHint` 映射成开放世界工具。Mini 先保留只读和破坏性两个最重要的。

## 调用 MCP 工具

工具调用走 `tools/call`：

```ts
import {
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function callMcpTool(
  client: Client,
  toolName: string,
  input: unknown,
): Promise<string> {
  const result = await client.request(
    {
      method: "tools/call",
      params: {
        name: toolName,
        arguments: normalizeToolInput(input),
      },
    },
    CallToolResultSchema,
  );

  if (result.isError) {
    throw new Error(formatMcpContent(result.content));
  }

  return truncateToolResult(formatMcpContent(result.content));
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return {};
}
```

把 MCP content 转成文本：

```ts
function formatMcpContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }

  return content
    .map((item) => {
      if (item && typeof item === "object" && "type" in item) {
        if (item.type === "text" && "text" in item) {
          return String(item.text);
        }

        if (item.type === "image") {
          return "[MCP image content omitted]";
        }

        if (item.type === "resource") {
          return JSON.stringify(item);
        }
      }

      return JSON.stringify(item);
    })
    .join("\n\n");
}

function truncateToolResult(text: string): string {
  const maxChars = 100_000;

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[Tool result truncated]`;
}
```

真实工程会对图片、二进制 blob 做持久化，把内容保存到文件后返回路径。Mini 第一版先用 marker 占位，避免把 base64 直接塞进上下文。

## 注册到 ToolRegistry

启动时把 MCP tools 合并进现有 tool registry：

```ts
const mcpManager = new McpManager();
await mcpManager.loadAndConnect(process.cwd());

const mcpTools = await discoverMcpTools(mcpManager);

toolRegistry.registerMany([
  ...getBuiltinTools(),
  ...getMcpResourceTools(mcpManager),
  ...mcpTools,
]);
```

注意顺序：内置工具和 MCP 工具不应该同名。MCP 工具有 `mcp__server__tool` 前缀，天然避免覆盖内置工具。

## MCP 工具权限

MCP 工具来自外部进程，不应该默认自动授权。

建议默认策略：

```ts
function checkMcpToolPermission(toolName: string): PermissionDecision {
  return {
    behavior: "ask",
    reason: `MCP tool requires permission: ${toolName}`,
  };
}
```

即使 MCP tool 标了 `readOnlyHint`，第一版也建议进入确认流程。`readOnlyHint` 是 server 自报信息，不是 Mini 验证过的事实。

真实工程里 MCP 工具默认返回 passthrough，让统一权限系统处理。权限规则使用完整工具名：

```text
mcp__filesystem__read_file
mcp__filesystem__*
```

Mini 如果已经有 allowlist，可以支持：

```ts
function isMcpToolAllowed(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.some((rule) => {
    if (rule.endsWith("*")) {
      return toolName.startsWith(rule.slice(0, -1));
    }

    return rule === toolName;
  });
}
```

## MCP Resources

MCP server 除了 tools，还可以提供 resources。资源不是模型主动调用的 tool use，而是可枚举、可读取的上下文数据。

真实工程提供两个内置工具：

- `ListMcpResourcesTool`
- `ReadMcpResourceTool`

Mini 也做两个工具。

```ts
// src/mcp/mcpResourceTools.ts
import {
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpManager } from "./mcpManager";
import type { ToolDefinition } from "../tools/toolTypes";

export function getMcpResourceTools(manager: McpManager): ToolDefinition[] {
  return [
    {
      name: "list_mcp_resources",
      description: "List resources from connected MCP servers",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string" },
        },
      },
      isReadOnly: () => true,
      async execute(input) {
        const target = readString(input, "server");
        const servers = manager
          .listServers()
          .filter((server) => server.type === "connected")
          .filter((server) => !target || server.name === target);

        const results = await Promise.all(
          servers.map(async (server) => {
            const resources = await server.client.client.request(
              { method: "resources/list" },
              ListResourcesResultSchema,
            );

            return (resources.resources ?? []).map((resource) => ({
              ...resource,
              server: server.name,
            }));
          }),
        );

        return JSON.stringify(results.flat(), null, 2);
      },
    },
    {
      name: "read_mcp_resource",
      description: "Read a resource from a connected MCP server",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string" },
          uri: { type: "string" },
        },
        required: ["server", "uri"],
      },
      isReadOnly: () => true,
      async execute(input) {
        const serverName = readRequiredString(input, "server");
        const uri = readRequiredString(input, "uri");
        const server = manager.getConnectedServer(serverName);

        if (!server) {
          throw new Error(`MCP server "${serverName}" is not connected`);
        }

        const result = await server.client.client.request(
          {
            method: "resources/read",
            params: { uri },
          },
          ReadResourceResultSchema,
        );

        return formatResourceContents(result.contents);
      },
    },
  ];
}
```

辅助函数：

```ts
function formatResourceContents(contents: Array<Record<string, unknown>>): string {
  return contents
    .map((content) => {
      if (typeof content.text === "string") {
        return content.text;
      }

      if (typeof content.blob === "string") {
        return "[MCP binary resource omitted]";
      }

      return JSON.stringify(content);
    })
    .join("\n\n");
}
```

资源工具要只读，并且仍然写入 transcript。这样恢复后能看到资源读取发生过。

## MCP Prompts 变成 Slash Command

MCP server 还可以提供 prompts。真实工程把它们转换成 `Command`，source 标记为 `mcp`。

Mini 也这样做。

```ts
// src/mcp/mcpPromptAdapter.ts
import {
  ListPromptsResultSchema,
  GetPromptResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CommandDefinition } from "../commands/commandTypes";
import type { McpManager } from "./mcpManager";
import { normalizeMcpName } from "./mcpNames";

export async function discoverMcpPromptCommands(
  manager: McpManager,
): Promise<CommandDefinition[]> {
  const commands: CommandDefinition[] = [];

  for (const server of manager.listServers()) {
    if (server.type !== "connected") continue;

    const result = await server.client.client.request(
      { method: "prompts/list" },
      ListPromptsResultSchema,
    );

    for (const prompt of result.prompts ?? []) {
      const name = `mcp__${normalizeMcpName(server.name)}__${normalizeMcpName(prompt.name)}`;
      const argNames = (prompt.arguments ?? []).map((arg) => arg.name);

      commands.push({
        type: "prompt",
        name,
        source: "mcp",
        description: prompt.description ?? `Prompt from MCP server ${server.name}`,
        argumentHint: argNames.length > 0 ? argNames.join(" ") : undefined,
        async getPrompt(args) {
          const values = args.split(/\s+/).filter(Boolean);
          const promptArgs = Object.fromEntries(
            argNames.map((argName, index) => [argName, values[index] ?? ""]),
          );

          const response = await server.client.client.request(
            {
              method: "prompts/get",
              params: {
                name: prompt.name,
                arguments: promptArgs,
              },
            },
            GetPromptResultSchema,
          );

          return response.messages
            .map((message) => formatMcpPromptMessage(message))
            .join("\n\n");
        },
      });
    }
  }

  return commands;
}
```

这里的参数解析很简化：按空格把参数映射到 prompt arguments。更完整的实现应该支持具名参数：

```text
/mcp__server__prompt --file src/a.ts --mode strict
```

第一版先保证可用。

## 接入 CapabilityRuntime

第二十五章已经有 `CapabilityRuntime`。现在加入 MCP：

```ts
export async function loadCapabilityRuntime(input: {
  pluginRegistry: PluginRegistry;
  mcpManager: McpManager;
  cwd: string;
}): Promise<CapabilityRuntime> {
  const errors: string[] = [];
  const commands: CommandDefinition[] = [];
  const tools: ToolDefinition[] = [];

  try {
    await input.mcpManager.loadAndConnect(input.cwd);
    tools.push(...getMcpResourceTools(input.mcpManager));
    tools.push(...await discoverMcpTools(input.mcpManager));
    commands.push(...await discoverMcpPromptCommands(input.mcpManager));
  } catch (error) {
    errors.push(`Failed to load MCP: ${String(error)}`);
  }

  const pluginRuntime = await input.pluginRegistry.load();

  return {
    commands: [
      ...commands,
      ...pluginRuntime.commands.map(pluginCommandToCommandDefinition),
      ...getBuiltinCommands(),
    ],
    tools: [
      ...getBuiltinTools(),
      ...pluginRuntime.tools,
      ...tools,
    ],
    errors,
  };
}
```

注意这里需要让 `CapabilityRuntime` 同时返回 `commands` 和 `tools`。第二十五章只有 commands，本章开始能力来源会同时影响工具池。

## /mcp 命令

新增本地命令：

```ts
// src/commands/mcpCommand.ts
import type { CommandDefinition } from "./commandTypes";
import type { McpManager } from "../mcp/mcpManager";

export function createMcpCommand(manager: McpManager): CommandDefinition {
  return {
    type: "local",
    name: "mcp",
    source: "builtin",
    description: "Manage MCP servers",
    argumentHint: "[list|tools|resources|reload]",
    async run(args) {
      const [action, target] = args.trim().split(/\s+/);

      if (!action || action === "list") {
        return {
          type: "text",
          text: renderMcpServers(manager),
        };
      }

      if (action === "tools") {
        return {
          type: "text",
          text: await renderMcpTools(manager, target),
        };
      }

      if (action === "resources") {
        return {
          type: "text",
          text: await renderMcpResources(manager, target),
        };
      }

      if (action === "reload") {
        await manager.loadAndConnect(process.cwd());
        return {
          type: "text",
          text: "MCP servers reloaded.",
        };
      }

      return {
        type: "text",
        text: "Usage: /mcp [list|tools|resources|reload]",
      };
    },
  };
}
```

渲染 server 状态：

```ts
function renderMcpServers(manager: McpManager): string {
  const servers = manager.listServers();

  if (servers.length === 0) {
    return "No MCP servers configured.";
  }

  return servers
    .map((server) => {
      if (server.type === "connected") {
        return `- ${server.name} connected`;
      }

      if (server.type === "disabled") {
        return `- ${server.name} disabled`;
      }

      return `- ${server.name} failed: ${server.error}`;
    })
    .join("\n");
}
```

真实工程的 `/mcp` 是 Ink UI，还支持 enable、disable、reconnect、认证提示和工具详情。Mini 先提供文本命令。

## 启用和禁用

Mini 可以先把启用禁用写回 `.mcp.json`：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@modelcontextprotocol/server-filesystem", "."],
      "enabled": false
    }
  }
}
```

`/mcp reload` 后重新加载。

如果要做 `/mcp enable filesystem` 和 `/mcp disable filesystem`，不要只改内存。要么写回配置，要么明确告诉用户“只对当前会话生效”。真实工程会把状态放在设置和 AppState 中，Mini 可以先选择写回项目配置。

## MCP 结果写入 transcript

MCP 工具调用和内置工具一样，要写 transcript：

```ts
await transcript.write({
  type: "tool_use",
  uuid: randomUUID(),
  sessionId: getSessionId(),
  timestamp: new Date().toISOString(),
  toolName: mcpToolName,
  input,
  source: "mcp",
});

await transcript.write({
  type: "tool_result",
  uuid: randomUUID(),
  sessionId: getSessionId(),
  timestamp: new Date().toISOString(),
  toolName: mcpToolName,
  output: result,
  source: "mcp",
});
```

不要把 secret 写进 transcript。如果 MCP 工具输入里可能包含 token，要用前面命令系统里的敏感参数策略做脱敏。

## 连接失败怎么处理

MCP server 失败不应该导致 Mini 启动失败。正确行为是：

- 记录 failed state。
- `/mcp list` 能展示错误。
- 其他 server 继续可用。
- 工具池只注册 connected server 的 tools。

```ts
try {
  const connected = await connectMcpServer({ name, config, cwd });
  this.states.set(name, { type: "connected", name, config, client: connected });
} catch (error) {
  this.states.set(name, {
    type: "failed",
    name,
    config,
    error: String(error),
  });
}
```

真实工程还会做连接缓存、onclose 清缓存、HTTP session 过期重试、连续错误后重连。Mini 第一版先支持手动 `/mcp reload`。

## 测试清单

建议补这些测试：

```ts
describe("loadMcpConfig", () => {
  test("loads project .mcp.json", async () => {});
  test("project config overrides user config", async () => {});
  test("expands environment variables", async () => {});
});

describe("mcp names", () => {
  test("builds prefixed tool name", () => {});
  test("normalizes invalid characters", () => {});
  test("parses mcp tool name", () => {});
});

describe("McpManager", () => {
  test("marks disabled server as disabled", async () => {});
  test("keeps failed server state without throwing", async () => {});
  test("disconnects connected servers", async () => {});
});

describe("mcp tool adapter", () => {
  test("converts MCP tools to ToolDefinition", async () => {});
  test("calls tools/call with original tool name", async () => {});
  test("truncates long tool descriptions", async () => {});
});

describe("mcp prompt adapter", () => {
  test("converts MCP prompts to CommandDefinition", async () => {});
  test("calls prompts/get with arguments", async () => {});
});
```

对应命令：

```bash
bun test src/mcp/__tests__/mcpConfig.test.ts
bun test src/mcp/__tests__/mcpNames.test.ts
bun test src/mcp/__tests__/mcpManager.test.ts
bun test src/mcp/__tests__/mcpToolAdapter.test.ts
bun run typecheck
```

## 常见问题

### 为什么第一版只做 stdio？

stdio 最容易本地运行，也不需要 OAuth、HTTP stream、SSE reconnect 等复杂状态。先跑通 stdio，才能验证工具发现、工具调用、权限和 transcript 链路。

### 为什么 MCP 工具要加 `mcp__server__tool` 前缀？

避免和内置工具重名，也方便权限规则匹配。用户可以允许单个工具，也可以允许整个 server 的工具：

```text
mcp__filesystem__read_file
mcp__filesystem__*
```

### `readOnlyHint` 可以自动放行吗？

第一版不要。它是 MCP server 自己声明的元信息，Mini 没有验证。可以用它影响 UI 展示和并发策略，但权限上仍建议默认询问。

### MCP resources 和 tools 有什么区别？

tool 是模型主动调用的动作，例如查询、读取、写入。

resource 是可枚举、可读取的上下文数据，例如文档、表结构、页面内容。Mini 通过 `list_mcp_resources` 和 `read_mcp_resource` 两个工具让模型访问 resources。

### MCP prompts 为什么变成 slash command？

MCP prompt 本质是外部 server 提供的一段可执行提示词模板。把它变成 slash command 后，用户和模型都能复用同一套命令注册中心。

### 为什么 MCP 连接失败不让启动失败？

一个外部 server 失败，不应该阻止用户继续使用内置工具。MCP 是扩展能力，失败要可见，但不能把核心 CLI 拖死。

### 什么时候需要做 HTTP/SSE/OAuth？

当你要接远程 MCP server 或 SaaS connector 时需要。那时要处理 OAuth、token 刷新、session 过期、重连和请求超时。Mini 先不做，是为了保证本地 stdio 主链路足够稳定。

## 本章完成标准

完成后应满足：

- Mini 能读取项目 `.mcp.json` 和用户 MCP 配置。
- Mini 能启动 stdio MCP server 并完成初始化。
- `/mcp list` 能展示 connected、failed、disabled 状态。
- MCP `tools/list` 返回的工具能注册进 ToolRegistry。
- 模型能调用 `mcp__server__tool` 格式的工具名。
- MCP 工具执行会调用 `tools/call` 并返回文本结果。
- MCP resources 能通过 `list_mcp_resources` 和 `read_mcp_resource` 访问。
- MCP prompts 能转换成 slash command。
- MCP 工具默认进入权限确认，不自动放行。
- MCP 调用和结果写入 transcript。
- 单个 MCP server 失败不会导致 Mini 启动失败。
- `bun run typecheck` 通过。

第二十六章到这里，Mini 的能力边界已经打开：内置工具、插件命令、MCP 外部工具都能进入同一套 Agent Loop。下一章可以继续补安全层：MCP 工具、Shell、文件编辑、远程资源这些高风险能力，如何统一进入权限规则、审批 UI 和审计记录。
