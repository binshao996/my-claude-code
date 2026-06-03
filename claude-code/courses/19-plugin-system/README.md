# 第 19 章：实现插件系统

第十八章完成了 Token 预算和上下文裁剪。现在 Mini 已经具备长对话能力，但还有一个架构问题：所有能力都写在核心代码里。

前面章节里，工具、slash command、Memory、Planner、Sandbox 都是核心模块。随着能力增加，核心会越来越臃肿：

- 想加一个团队内部命令，需要改核心代码。
- 想加一个自定义工具，需要改工具注册表。
- 想给某个项目注入额外上下文，需要改 ContextPreparer。
- 想临时启用某个实验能力，需要重启并改配置。

插件系统要解决的不是“让任何代码都能随便运行”，而是把扩展点收束成一个可安装、可启用、可禁用、可刷新、可审计的机制。

本章为 Mini 实现一个本地插件系统：

- 插件用 manifest 描述自己。
- 插件可以提供 Markdown slash command。
- 插件可以提供工具模块。
- 插件可以提供上下文片段。
- 插件安装状态写入全局文件。
- 插件启用状态可以切换。
- `/reload-plugins` 刷新当前会话的插件能力。

真实 Claude Code 的插件系统更完整，支持 marketplace、commands、agents、skills、hooks、MCP、LSP、内置插件、策略控制和缓存刷新。本章先实现最小闭环，把架构位置搭起来。

## 本章目标

完成本章后，你会得到：

1. 一个 `src/plugins/` 模块，负责安装、加载、启用、禁用插件。
2. 一个插件 manifest 格式。
3. 一个全局 `installed.json`，记录已安装插件。
4. Markdown command 的加载和注册。
5. 工具模块的动态加载和注册。
6. 插件上下文片段注入到 ContextPreparer。
7. `/plugin` 和 `/reload-plugins` 两个命令。
8. 插件加载测试。

这一章结束后，Mini 的核心代码不再需要知道所有工具和命令。它只需要知道如何加载插件提供的扩展。

## 本章完成效果

创建一个本地插件：

```txt
plugins/git-helper/
  .claude-plugin/
    plugin.json
  commands/
    branch-summary.md
  tools/
    git-status.ts
  context/
    rules.md
```

manifest：

```json
{
  "name": "git-helper",
  "version": "0.1.0",
  "description": "Git helper commands and tools",
  "commands": {
    "branch-summary": {
      "source": "./commands/branch-summary.md",
      "description": "Summarize the current branch"
    }
  },
  "tools": {
    "git_status": {
      "source": "./tools/git-status.ts",
      "description": "Read current git status"
    }
  },
  "context": ["./context/rules.md"]
}
```

安装：

```bash
bun run dev -- plugin install ./plugins/git-helper
```

进入 REPL 后：

```txt
> /plugin list
Installed plugins:
- git-helper  enabled  0.1.0

> /git-helper:branch-summary
```

模型请求里会出现：

- 插件命令 `/git-helper:branch-summary`
- 插件工具 `git-helper.git_status`
- 插件上下文 `context/rules.md`

禁用插件：

```txt
> /plugin disable git-helper
> /reload-plugins
```

刷新后，插件提供的命令、工具和上下文都会从当前会话移除。

## 本章项目结构变化

新增：

```txt
src/
  plugins/
    types.ts
    paths.ts
    manifest.ts
    install.ts
    loader.ts
    commandLoader.ts
    toolLoader.ts
    contextLoader.ts
    registry.ts
tests/
  plugin-system.test.ts
```

修改：

```txt
src/chat/session.ts
src/chat/chatLoop.ts
src/tools/toolRegistry.ts
src/commands/commandRegistry.ts
```

如果你的 Mini 项目目前没有 `commandRegistry.ts`，可以先把 slash command 分发表抽出来。本章需要让内置命令和插件命令走同一套注册接口。

抽分发表时不要丢掉前面章节已有的内置命令。

内置命令至少要先注册这些：

```txt
/plan
/plan show
/plan clear
/plan exit
/memory
/remember
/context
/tools
/tool
/clear
/exit
```

其中 `/plan` 是进入 Mini plan mode，不是单纯查看计划。

插件命令应该追加到 registry，不应该替换这些 built-in command。

## 插件系统的边界

插件系统很容易失控，所以先定边界。

Mini 第一版只支持本地插件：

- 不从网络下载插件。
- 不自动执行安装脚本。
- 不读取 manifest 之外的任意路径。
- 不默认启用新插件之外的额外权限。
- 不在插件里保存 secret。

插件提供的 TypeScript 工具模块仍然是代码执行能力，因此必须由用户显式安装。真实产品会有 marketplace 签名、策略、信任提示、blocklist、allowlist、版本缓存等机制。Mini 先把本地信任边界写清楚。

## 真实工程里的插件模型

真实工程里，插件模块主要集中在：

```txt
src/utils/plugins/
src/commands/plugin/
src/commands/reload-plugins/
src/types/plugin.ts
```

它的核心思路是三层模型：

```txt
Layer 1: intent
settings 中声明哪些插件启用或禁用

Layer 2: materialization
插件被安装、缓存、校验到本地目录

Layer 3: active components
当前会话把插件命令、agents、hooks、MCP、LSP 加载进 AppState
```

`/reload-plugins` 做的就是第三层刷新：清缓存、重新加载插件、更新 AppState、触发 MCP/LSP 重连。

Mini 也沿用这个三层模型，只是把第二层简化为“从本地目录复制到插件缓存”。

## 插件目录协议

Mini 使用和真实工程接近的目录结构：

```txt
my-plugin/
  .claude-plugin/
    plugin.json
  commands/
    hello.md
  tools/
    some-tool.ts
  context/
    rules.md
```

约定：

- `.claude-plugin/plugin.json` 是 manifest。
- `commands/*.md` 是 slash command。
- `tools/*.ts` 是工具模块。
- `context/*.md` 是插件上下文。

命名规则：

- 插件名必须是 kebab-case 或 snake_case。
- 插件命令运行时命名为 `plugin-name:command-name`。
- 插件工具运行时命名为 `plugin-name.tool_name`。
- 插件上下文会带来源路径，方便 `/context` 展示。

为什么命令用冒号，工具用点号？

因为 slash command 里 `/plugin:command` 更像真实 Claude Code 的命名空间；工具名里 `plugin.tool` 更容易和普通工具区分，也便于权限规则匹配。

## 完整核心代码

### `src/plugins/types.ts`

```ts
import type { ChatMessage } from "../context/tokenCounter";

export type PluginCommandManifest = {
  source: string;
  description?: string;
  argumentHint?: string;
};

export type PluginToolManifest = {
  source: string;
  description?: string;
};

export type PluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: Record<string, PluginCommandManifest>;
  tools?: Record<string, PluginToolManifest>;
  context?: string[];
};

export type InstalledPlugin = {
  name: string;
  version?: string;
  installPath: string;
  enabled: boolean;
  installedAt: string;
};

export type InstalledPluginsFile = {
  version: 1;
  plugins: Record<string, InstalledPlugin>;
};

export type PluginCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  getPrompt(args: string): Promise<ChatMessage[]>;
};

export type PluginTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  run(input: unknown, context: { cwd: string }): Promise<string>;
};

export type PluginContextSnippet = {
  pluginName: string;
  path: string;
  content: string;
};

export type LoadedPlugin = {
  manifest: PluginManifest;
  installPath: string;
  commands: PluginCommand[];
  tools: PluginTool[];
  context: PluginContextSnippet[];
};

export type PluginLoadResult = {
  enabled: LoadedPlugin[];
  disabled: InstalledPlugin[];
  errors: string[];
};
```

这里没有把 marketplace、hooks、agents 都塞进第一版类型。插件系统的关键是扩展点和生命周期，功能可以后续增加。

### `src/plugins/paths.ts`

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function getMiniHome(): string {
  return process.env.CCMINI_HOME ?? join(homedir(), ".ccmini");
}

export function getPluginsHome(): string {
  return join(getMiniHome(), "plugins");
}

export function getPluginCacheDir(): string {
  return join(getPluginsHome(), "cache");
}

export function getInstalledPluginsPath(): string {
  return join(getPluginsHome(), "installed.json");
}

export function getCachedPluginPath(pluginName: string): string {
  return join(getPluginCacheDir(), pluginName);
}
```

真实工程里插件安装状态是全局的，启用状态可以按用户、项目、本地多层 settings 合并。Mini 先把两者都放在一个文件里，等后面需要项目级启用时再拆分。

### `src/plugins/manifest.ts`

```ts
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { PluginManifest } from "./types";

const PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validatePluginName(name: string): void {
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid plugin name "${name}". Use letters, numbers, "_" or "-".`,
    );
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function readString(value: unknown, label: string, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readSourceMap(
  value: unknown,
  label: string,
): Record<string, { source: string; description?: string; argumentHint?: string }> | undefined {
  if (value === undefined) return undefined;
  assertRecord(value, label);

  const result: Record<string, { source: string; description?: string; argumentHint?: string }> = {};
  for (const [name, item] of Object.entries(value)) {
    validatePluginName(name);
    assertRecord(item, `${label}.${name}`);
    result[name] = {
      source: readString(item.source, `${label}.${name}.source`, true)!,
      description: readString(item.description, `${label}.${name}.description`),
      argumentHint: readString(item.argumentHint, `${label}.${name}.argumentHint`),
    };
  }
  return result;
}

function readContextList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("context must be an array.");

  return value.map((item, index) => {
    return readString(item, `context.${index}`, true)!;
  });
}

export function parsePluginManifest(value: unknown): PluginManifest {
  assertRecord(value, "plugin manifest");

  const name = readString(value.name, "name", true)!;
  validatePluginName(name);

  return {
    name,
    version: readString(value.version, "version"),
    description: readString(value.description, "description"),
    commands: readSourceMap(value.commands, "commands"),
    tools: readSourceMap(value.tools, "tools"),
    context: readContextList(value.context),
  };
}

export async function loadPluginManifest(pluginRoot: string): Promise<PluginManifest> {
  const manifestPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
  const raw = await readFile(manifestPath, "utf8");
  return parsePluginManifest(JSON.parse(raw));
}

export async function assertInsidePluginRoot(
  pluginRoot: string,
  relativePath: string,
): Promise<string> {
  if (!relativePath.startsWith("./")) {
    throw new Error(`Plugin paths must start with "./": ${relativePath}`);
  }

  const root = resolve(pluginRoot);
  const fullPath = resolve(root, relativePath);
  if (fullPath !== root && !fullPath.startsWith(root + sep)) {
    throw new Error(`Plugin path escapes plugin root: ${relativePath}`);
  }

  const info = await stat(fullPath);
  if (!info.isFile()) {
    throw new Error(`Plugin path is not a file: ${relativePath}`);
  }

  return fullPath;
}
```

真实工程用 schema 做了非常多校验，例如相对路径必须以 `./` 开头、marketplace 名不能伪装官方来源、manifest 字段要按组件类型验证。本章实现最关键的两点：

- 插件名可控。
- 插件路径不能逃出插件根目录。

### `src/plugins/install.ts`

```ts
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  getCachedPluginPath,
  getInstalledPluginsPath,
  getPluginsHome,
} from "./paths";
import { loadPluginManifest } from "./manifest";
import type { InstalledPluginsFile } from "./types";

const EMPTY_INSTALLED: InstalledPluginsFile = {
  version: 1,
  plugins: {},
};

export async function readInstalledPlugins(): Promise<InstalledPluginsFile> {
  try {
    const raw = await readFile(getInstalledPluginsPath(), "utf8");
    const parsed = JSON.parse(raw) as InstalledPluginsFile;
    if (parsed.version !== 1 || typeof parsed.plugins !== "object") {
      throw new Error("Invalid installed plugins file.");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_INSTALLED;
    }
    throw error;
  }
}

async function writeInstalledPlugins(file: InstalledPluginsFile): Promise<void> {
  const path = getInstalledPluginsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), "utf8");
}

export async function installPluginFromPath(sourcePath: string): Promise<string> {
  const resolvedSource = resolve(sourcePath);
  const manifest = await loadPluginManifest(resolvedSource);
  const targetPath = getCachedPluginPath(manifest.name);

  await mkdir(getPluginsHome(), { recursive: true });
  await rm(targetPath, { recursive: true, force: true });
  await cp(resolvedSource, targetPath, {
    recursive: true,
    filter(source) {
      return !source.includes("/.git/");
    },
  });

  const installed = await readInstalledPlugins();
  installed.plugins[manifest.name] = {
    name: manifest.name,
    version: manifest.version,
    installPath: targetPath,
    enabled: true,
    installedAt: new Date().toISOString(),
  };

  await writeInstalledPlugins(installed);
  return manifest.name;
}

export async function setPluginEnabled(name: string, enabled: boolean): Promise<void> {
  const installed = await readInstalledPlugins();
  const plugin = installed.plugins[name];
  if (!plugin) {
    throw new Error(`Plugin is not installed: ${name}`);
  }

  plugin.enabled = enabled;
  await writeInstalledPlugins(installed);
}

export async function listInstalledPlugins(): Promise<InstalledPluginsFile> {
  return readInstalledPlugins();
}
```

这里选择“安装时复制到缓存目录”，而不是直接引用源目录。

原因：

- 用户可以删除原始目录，插件仍能运行。
- 当前会话加载的是稳定路径。
- 后续做版本缓存时，不需要重写加载层。

真实工程还会记录 marketplace、scope、versioned cache、seed cache、依赖和策略。Mini 先记录最少字段。

### `src/plugins/commandLoader.ts`

```ts
import { readFile } from "node:fs/promises";
import { assertInsidePluginRoot } from "./manifest";
import type { PluginCommand, PluginManifest } from "./types";

function substituteArguments(content: string, args: string): string {
  return content.replaceAll("$ARGUMENTS", args);
}

export async function loadPluginCommands(
  pluginRoot: string,
  manifest: PluginManifest,
): Promise<PluginCommand[]> {
  const commands = manifest.commands ?? {};
  const result: PluginCommand[] = [];

  for (const [commandName, command] of Object.entries(commands)) {
    const filePath = await assertInsidePluginRoot(pluginRoot, command.source);
    const content = await readFile(filePath, "utf8");
    const runtimeName = `${manifest.name}:${commandName}`;

    result.push({
      name: runtimeName,
      description: command.description ?? `Command from ${manifest.name}`,
      argumentHint: command.argumentHint,
      async getPrompt(args) {
        return [
          {
            role: "user",
            content: substituteArguments(content, args),
          },
        ];
      },
    });
  }

  return result;
}
```

真实工程的插件命令支持 frontmatter、allowed tools、模型覆盖、参数名、shell 展开、`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`、`${CLAUDE_SESSION_ID}` 等变量。

Mini 第一版只支持 `$ARGUMENTS`。这样足够让插件命令跑通，同时避免一开始就引入复杂权限问题。

### `src/plugins/toolLoader.ts`

```ts
import { pathToFileURL } from "node:url";
import { assertInsidePluginRoot } from "./manifest";
import type { PluginManifest, PluginTool } from "./types";

type ToolModule = {
  default?: PluginTool;
};

function assertPluginTool(value: unknown, source: string): asserts value is PluginTool {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Tool module ${source} must export a default object.`);
  }

  const tool = value as Partial<PluginTool>;
  if (typeof tool.name !== "string") {
    throw new Error(`Tool module ${source} is missing name.`);
  }
  if (typeof tool.description !== "string") {
    throw new Error(`Tool module ${source} is missing description.`);
  }
  if (typeof tool.run !== "function") {
    throw new Error(`Tool module ${source} is missing run().`);
  }
}

export async function loadPluginTools(
  pluginRoot: string,
  manifest: PluginManifest,
): Promise<PluginTool[]> {
  const tools = manifest.tools ?? {};
  const result: PluginTool[] = [];

  for (const [toolName, toolManifest] of Object.entries(tools)) {
    const filePath = await assertInsidePluginRoot(pluginRoot, toolManifest.source);
    const mod = (await import(pathToFileURL(filePath).href)) as ToolModule;
    const exported = mod.default;

    assertPluginTool(exported, toolManifest.source);

    result.push({
      ...exported,
      name: `${manifest.name}.${toolName}`,
      description: toolManifest.description ?? exported.description,
    });
  }

  return result;
}
```

插件工具示例 `tools/git-status.ts`：

```ts
import { $ } from "bun";
import type { PluginTool } from "../../../src/plugins/types";

const tool: PluginTool = {
  name: "git_status",
  description: "Read current git status",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async run(_input, context) {
    const output = await $`git -C ${context.cwd} status --short`.text();
    return output.trim() || "Working tree clean.";
  },
};

export default tool;
```

注意：这里的插件工具是 Mini 为教学加入的扩展点。真实 Claude Code 插件更倾向于通过 MCP 提供外部工具，而不是直接加载任意 TypeScript 工具。Mini 这样做是为了让前面章节的 Tool Registry 能直接被插件复用。

### `src/plugins/contextLoader.ts`

```ts
import { readFile } from "node:fs/promises";
import { assertInsidePluginRoot } from "./manifest";
import type { PluginContextSnippet, PluginManifest } from "./types";
import { truncateTextToTokens } from "../context/truncate";

export async function loadPluginContext(
  pluginRoot: string,
  manifest: PluginManifest,
): Promise<PluginContextSnippet[]> {
  const snippets: PluginContextSnippet[] = [];

  for (const source of manifest.context ?? []) {
    const filePath = await assertInsidePluginRoot(pluginRoot, source);
    const raw = await readFile(filePath, "utf8");
    const content = truncateTextToTokens(raw, 4_000).text;

    snippets.push({
      pluginName: manifest.name,
      path: source,
      content,
    });
  }

  return snippets;
}

export function renderPluginContext(snippets: PluginContextSnippet[]): string | null {
  if (snippets.length === 0) return null;

  const sections = snippets.map((snippet) => {
    return `Plugin context from ${snippet.pluginName}:${snippet.path}\n\n${snippet.content}`;
  });

  return sections.join("\n\n");
}
```

插件上下文也必须限额。否则一个插件可以通过 `context` 字段把大量 Markdown 永久塞进每次请求。

### `src/plugins/loader.ts`

```ts
import { readInstalledPlugins } from "./install";
import { loadPluginManifest } from "./manifest";
import { loadPluginCommands } from "./commandLoader";
import { loadPluginTools } from "./toolLoader";
import { loadPluginContext } from "./contextLoader";
import type { LoadedPlugin, PluginLoadResult } from "./types";

export async function loadPlugins(): Promise<PluginLoadResult> {
  const installed = await readInstalledPlugins();
  const enabled: LoadedPlugin[] = [];
  const disabled = [];
  const errors: string[] = [];

  for (const plugin of Object.values(installed.plugins)) {
    if (!plugin.enabled) {
      disabled.push(plugin);
      continue;
    }

    try {
      const manifest = await loadPluginManifest(plugin.installPath);
      const [commands, tools, context] = await Promise.all([
        loadPluginCommands(plugin.installPath, manifest),
        loadPluginTools(plugin.installPath, manifest),
        loadPluginContext(plugin.installPath, manifest),
      ]);

      enabled.push({
        manifest,
        installPath: plugin.installPath,
        commands,
        tools,
        context,
      });
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `${plugin.name}: ${error.message}`
          : `${plugin.name}: Unknown plugin load error`,
      );
    }
  }

  return { enabled, disabled, errors };
}
```

加载时不要因为一个插件失败就让整个 CLI 启动失败。真实工程也是收集 `PluginError[]`，再在 UI 或 `/doctor` 里展示。

### `src/plugins/registry.ts`

```ts
import { renderPluginContext } from "./contextLoader";
import { loadPlugins } from "./loader";
import type { PluginCommand, PluginTool } from "./types";

export type PluginRuntime = {
  commands: PluginCommand[];
  tools: PluginTool[];
  contextPrompt: string | null;
  errors: string[];
  enabledCount: number;
};

export class PluginRegistry {
  private runtime: PluginRuntime = {
    commands: [],
    tools: [],
    contextPrompt: null,
    errors: [],
    enabledCount: 0,
  };

  async reload(): Promise<PluginRuntime> {
    const result = await loadPlugins();
    const commands = result.enabled.flatMap((plugin) => plugin.commands);
    const tools = result.enabled.flatMap((plugin) => plugin.tools);
    const context = result.enabled.flatMap((plugin) => plugin.context);

    this.runtime = {
      commands,
      tools,
      contextPrompt: renderPluginContext(context),
      errors: result.errors,
      enabledCount: result.enabled.length,
    };

    return this.runtime;
  }

  getRuntime(): PluginRuntime {
    return this.runtime;
  }

  findCommand(name: string): PluginCommand | undefined {
    return this.runtime.commands.find((command) => command.name === name);
  }

  getTools(): PluginTool[] {
    return this.runtime.tools;
  }

  getContextPrompt(): string | null {
    return this.runtime.contextPrompt;
  }
}
```

这个 registry 是第三层 active components。安装和启用只是修改磁盘状态，当前会话要看到变化，必须调用 `reload()`。

## 接入 Tool Registry

假设前面章节里有内置工具注册表：

```ts
const registry = new ToolRegistry();
registry.register(readFileTool);
registry.register(writeFileTool);
registry.register(shellTool);
```

现在改成：

```ts
const pluginRuntime = pluginRegistry.getRuntime();

const registry = new ToolRegistry();
registry.register(readFileTool);
registry.register(writeFileTool);
registry.register(shellTool);

for (const tool of pluginRuntime.tools) {
  registry.register({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async call(input) {
      return tool.run(input, { cwd: process.cwd() });
    },
  });
}
```

注意两个细节：

1. 插件工具的 runtime name 已经带插件名前缀。
2. 插件工具仍然走统一权限和工具调用流程。

不要让插件工具绕过 Agent Loop 直接执行。否则权限、日志、上下文预算都会失效。

## 接入 Command Registry

把内置 slash command 和插件 command 放进同一个分发表。

```ts
export class CommandRegistry {
  private commands = new Map<string, (args: string) => Promise<void>>();

  register(name: string, handler: (args: string) => Promise<void>): void {
    this.commands.set(name, handler);
  }

  async run(input: string): Promise<boolean> {
    if (!input.startsWith("/")) return false;

    const [rawName, ...rest] = input.slice(1).split(/\s+/);
    if (!rawName) return false;

    const handler = this.commands.get(rawName);
    if (!handler) return false;

    await handler(rest.join(" "));
    return true;
  }
}
```

注册插件命令：

```ts
for (const command of pluginRegistry.getRuntime().commands) {
  commandRegistry.register(command.name, async (args) => {
    const messages = await command.getPrompt(args);
    await session.injectMessages(messages);
  });
}
```

这样用户输入：

```txt
/git-helper:branch-summary
```

就会把插件 Markdown 转成普通 user message，继续走主 Agent Loop。

## 接入 ContextPreparer

第十八章已经有：

```ts
const prepared = this.contextPreparer.prepare({
  systemPrompt: this.baseSystemPrompt,
  memoryPrompt,
  runtimeContext,
  messages: this.messages,
});
```

现在把插件上下文并入 runtime context：

```ts
const pluginContext = this.pluginRegistry.getContextPrompt();
const runtimeContext = [
  await this.runtimeContext.render(),
  pluginContext,
].filter(Boolean).join("\n\n");

const prepared = this.contextPreparer.prepare({
  systemPrompt: this.baseSystemPrompt,
  memoryPrompt,
  runtimeContext,
  messages: this.messages,
});
```

插件上下文属于运行时上下文，不属于 Memory。因为它跟插件启用状态绑定，插件禁用后应该立即消失。

## 实现 `/plugin`

Mini 第一版支持几个子命令：

```txt
/plugin list
/plugin install <path>
/plugin enable <name>
/plugin disable <name>
```

实现：

```ts
import {
  installPluginFromPath,
  listInstalledPlugins,
  setPluginEnabled,
} from "../plugins/install";

export async function handlePluginCommand(args: string): Promise<string> {
  const [action, target] = args.trim().split(/\s+/);

  if (!action || action === "list") {
    const installed = await listInstalledPlugins();
    const rows = Object.values(installed.plugins);

    if (rows.length === 0) return "No plugins installed.";

    return [
      "Installed plugins:",
      ...rows.map((plugin) => {
        const state = plugin.enabled ? "enabled" : "disabled";
        return `- ${plugin.name}  ${state}  ${plugin.version ?? "unknown"}`;
      }),
    ].join("\n");
  }

  if (action === "install") {
    if (!target) return "Usage: /plugin install <path>";
    const name = await installPluginFromPath(target);
    return `Installed plugin: ${name}. Run /reload-plugins to apply.`;
  }

  if (action === "enable") {
    if (!target) return "Usage: /plugin enable <name>";
    await setPluginEnabled(target, true);
    return `Enabled plugin: ${target}. Run /reload-plugins to apply.`;
  }

  if (action === "disable") {
    if (!target) return "Usage: /plugin disable <name>";
    await setPluginEnabled(target, false);
    return `Disabled plugin: ${target}. Run /reload-plugins to apply.`;
  }

  return "Usage: /plugin [list|install|enable|disable]";
}
```

真实工程里 `/plugin` 是 Ink UI，可以浏览 marketplace、安装、卸载、配置、启用、禁用。Mini 先做文本命令，减少 UI 干扰。

## 实现 `/reload-plugins`

```ts
import type { PluginRegistry } from "../plugins/registry";

export async function handleReloadPlugins(
  pluginRegistry: PluginRegistry,
): Promise<string> {
  const runtime = await pluginRegistry.reload();

  return [
    `Reloaded ${runtime.enabledCount} plugins.`,
    `Commands: ${runtime.commands.length}`,
    `Tools: ${runtime.tools.length}`,
    runtime.errors.length > 0 ? `Errors: ${runtime.errors.length}` : null,
  ].filter(Boolean).join("\n");
}
```

启动时也要加载一次：

```ts
const pluginRegistry = new PluginRegistry();
await pluginRegistry.reload();
```

安装、启用、禁用只改变磁盘状态。`/reload-plugins` 才改变当前会话状态。

这个设计和真实工程一致：`/plugin` 负责修改 intent，`/reload-plugins` 负责刷新 active components。

## 示例插件

创建 `plugins/git-helper/.claude-plugin/plugin.json`：

```json
{
  "name": "git-helper",
  "version": "0.1.0",
  "description": "Git helper commands and tools",
  "commands": {
    "branch-summary": {
      "source": "./commands/branch-summary.md",
      "description": "Summarize the current branch",
      "argumentHint": "[focus]"
    }
  },
  "tools": {
    "git_status": {
      "source": "./tools/git-status.ts",
      "description": "Read current git status"
    }
  },
  "context": ["./context/rules.md"]
}
```

创建 `plugins/git-helper/commands/branch-summary.md`：

```md
请总结当前分支的变更，重点关注：$ARGUMENTS

要求：
- 先查看 git 状态。
- 再查看最近提交。
- 最后给出风险点和建议验证命令。
```

创建 `plugins/git-helper/context/rules.md`：

```md
Git helper plugin rules:

- Prefer short branch summaries.
- Mention uncommitted files explicitly.
- Do not create commits unless the user asks.
```

创建 `plugins/git-helper/tools/git-status.ts`：

```ts
import { $ } from "bun";
import type { PluginTool } from "../../../src/plugins/types";

const tool: PluginTool = {
  name: "git_status",
  description: "Read current git status",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async run(_input, context) {
    const output = await $`git -C ${context.cwd} status --short`.text();
    return output.trim() || "Working tree clean.";
  },
};

export default tool;
```

安装并运行：

```bash
bun run dev -- plugin install ./plugins/git-helper
bun run dev
```

在 REPL 里：

```txt
/reload-plugins
/plugin list
/git-helper:branch-summary 当前未提交变更
```

## 单元测试

新增 `tests/plugin-system.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPluginFromPath, setPluginEnabled } from "../src/plugins/install";
import { loadPlugins } from "../src/plugins/loader";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccmini-plugin-"));
  process.env.CCMINI_HOME = join(dir, "home");
});

afterEach(async () => {
  delete process.env.CCMINI_HOME;
  await rm(dir, { recursive: true, force: true });
});

async function createPlugin(): Promise<string> {
  const root = join(dir, "git-helper");
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "context"), { recursive: true });
  await mkdir(join(root, "tools"), { recursive: true });

  await Bun.write(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: "git-helper",
        version: "0.1.0",
        commands: {
          hello: {
            source: "./commands/hello.md",
            description: "Say hello",
          },
        },
        context: ["./context/rules.md"],
      },
      null,
      2,
    ),
  );

  await Bun.write(join(root, "commands", "hello.md"), "Hello $ARGUMENTS");
  await Bun.write(join(root, "context", "rules.md"), "Use concise output.");

  return root;
}

describe("plugin system", () => {
  test("installs and loads an enabled plugin", async () => {
    const root = await createPlugin();
    await installPluginFromPath(root);

    const result = await loadPlugins();

    expect(result.enabled).toHaveLength(1);
    expect(result.enabled[0]?.manifest.name).toBe("git-helper");
    expect(result.enabled[0]?.commands[0]?.name).toBe("git-helper:hello");
    expect(result.enabled[0]?.context[0]?.content).toContain("concise");
  });

  test("disabled plugins are not loaded as active components", async () => {
    const root = await createPlugin();
    await installPluginFromPath(root);
    await setPluginEnabled("git-helper", false);

    const result = await loadPlugins();

    expect(result.enabled).toHaveLength(0);
    expect(result.disabled).toHaveLength(1);
  });

  test("rejects paths escaping plugin root", async () => {
    const root = await createPlugin();
    await Bun.write(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "git-helper",
        commands: {
          bad: {
            source: "../outside.md",
          },
        },
      }),
    );

    await installPluginFromPath(root);
    const result = await loadPlugins();

    expect(result.enabled).toHaveLength(0);
    expect(result.errors[0]).toContain("must start");
  });
});
```

运行：

```bash
bun test tests/plugin-system.test.ts
bun run typecheck
```

测试重点不是动态工具执行，而是插件生命周期：

- 安装后能加载。
- 禁用后不进入 active components。
- manifest 路径不能逃逸插件根目录。

## 关键源码分析

真实工程的插件系统有几个值得直接学习的设计。

### 1. `src/utils/plugins/schemas.ts`

这里定义了插件 manifest、marketplace、安装状态、依赖和配置的 schema。

几个关键点：

- 插件名不能包含空格。
- 相对路径必须以 `./` 开头。
- marketplace 名要防止伪装官方来源。
- manifest 支持 commands、agents、skills、hooks、MCP、LSP、output styles。
- 插件依赖用 `plugin@marketplace` 标识。

Mini 的 manifest 是它的缩小版。

### 2. `src/utils/plugins/pluginLoader.ts`

这是真实插件加载的核心。它做了几件事：

- 从 settings 的 `enabledPlugins` 读取用户意图。
- 从 marketplace 和 session-only 目录发现插件。
- 将插件 materialize 到本地缓存。
- 读取 `.claude-plugin/plugin.json`。
- 自动发现 `commands/`、`agents/`、`skills/`、`hooks/` 等目录。
- 合并 built-in、marketplace、session 插件。
- 收集错误，而不是让一个插件拖垮整个 CLI。

本章的 `loadPlugins()` 就是它的教学版。

### 3. `src/utils/plugins/loadPluginCommands.ts`

真实插件命令来自 Markdown 文件，运行时被转成 `Command` 对象。命名空间格式是：

```txt
plugin-name:command-name
```

它还支持：

- frontmatter 描述。
- allowed tools。
- 参数替换。
- 模型覆盖。
- effort 覆盖。
- 插件变量替换。
- skill 目录格式。

Mini 第一版只实现 Markdown + `$ARGUMENTS`，但命名空间沿用同一思想。

### 4. `src/utils/plugins/loadPluginAgents.ts`

真实插件还能提供 agents。Agent 文件也是 Markdown + frontmatter，运行时变成 AgentDefinition。

注意一个安全设计：插件 agent 中的 `permissionMode`、`hooks`、`mcpServers` 会被忽略。因为这些字段会扩大权限边界，不能让插件里某个 agent 文件悄悄提升权限。

Mini 现在还没有插件 agent，但后续实现 Multi Agent 时应该照这个原则做。

### 5. `src/utils/plugins/mcpPluginIntegration.ts`

真实插件提供工具的主要方式是 MCP。插件可以通过 `.mcp.json`、manifest 中的 `mcpServers` 或 MCP bundle 声明 MCP 服务器。

服务器名会被命名空间化，类似：

```txt
plugin:pluginName:serverName
```

这样不会和用户手动配置的 MCP server 冲突。

Mini 本章直接加载 TypeScript 工具，是为了教学简化。生产级扩展更建议走 MCP。

### 6. `src/utils/plugins/refresh.ts`

`refreshActivePlugins()` 体现了三层模型：

```txt
clear caches
loadAllPlugins
getPluginCommands
getAgentDefinitionsWithOverrides
load plugin MCP/LSP
update AppState
reinitialize managers
load hooks
```

也就是说，安装插件和当前会话生效是两个动作。这个设计让用户可以批量安装或禁用，再用一次 reload 应用。

## 调试与验证

建议按下面顺序验证：

```bash
bun test tests/plugin-system.test.ts
bun run typecheck
```

手动验证：

```bash
bun run dev -- plugin install ./plugins/git-helper
bun run dev
```

REPL 中执行：

```txt
/reload-plugins
/plugin list
/git-helper:branch-summary 当前分支
/plugin disable git-helper
/reload-plugins
/plugin list
```

检查：

- 安装后插件出现在列表里。
- reload 后命令可用。
- 禁用并 reload 后命令不可用。
- `/context` 中能看到插件上下文占用。
- 插件工具走统一工具调用和权限流程。

如果插件加载失败，不要只打印 `Failed`。至少输出：

- 插件名。
- manifest 路径。
- 失败组件。
- 具体错误。

插件系统的可调试性很重要，因为错误通常来自用户写的插件，而不是核心代码。

## 常见问题

### 为什么安装后还要 `/reload-plugins`

因为安装只是写磁盘状态，当前会话的命令、工具和上下文已经加载过了。

把“修改配置”和“刷新运行时”拆开，有两个好处：

- 用户可以批量操作后一次刷新。
- 当前对话不会在用户浏览插件 UI 时突然改变可用工具。

### 为什么插件命令用 Markdown

很多扩展能力本质上是 Prompt 工作流，不需要写代码。Markdown 命令比 TypeScript 插件更容易审查，也更适合团队共享。

只有需要真实执行逻辑时，才应该写工具模块或 MCP server。

### 为什么插件工具要命名空间化

避免冲突。

如果两个插件都提供 `search` 工具，核心注册表无法判断哪个应该覆盖哪个。命名成 `plugin-a.search` 和 `plugin-b.search` 后，权限、日志和调试都更清楚。

### 为什么不实现 marketplace

marketplace 不是插件系统的第一步。它需要额外处理：

- 来源验证。
- 版本缓存。
- 更新策略。
- 依赖解析。
- blocklist 和 allowlist。
- 信任提示。
- 网络失败和缓存回退。

Mini 先把本地插件生命周期跑通，再考虑 marketplace。

### 插件能不能读取 secret

插件工具是代码，当然可能读取环境变量或文件。因此插件必须被视为受信任代码。

本章没有实现插件权限沙箱。使用插件时要遵守第十四章的权限边界：工具执行仍然必须走统一权限审批，不要让插件绕过核心执行器。

### 插件上下文和 Memory 有什么区别

Memory 是用户和项目长期约定，跟插件是否启用无关。

插件上下文是插件能力的一部分，插件禁用后就不应该继续注入。它应该进入 runtime context，而不是写进 `CLAUDE.md`。

## 本章小结

本章完成了 Mini 插件系统的第一版：

- 定义了 `.claude-plugin/plugin.json`。
- 实现了本地安装、启用、禁用和加载。
- 支持插件 Markdown command。
- 支持插件工具模块。
- 支持插件上下文片段。
- 通过 `PluginRegistry` 管理当前会话 active components。
- 通过 `/plugin` 修改插件 intent。
- 通过 `/reload-plugins` 刷新当前会话。

到这里，Mini 的架构已经从“所有能力都内置”变成“核心提供扩展点，插件提供能力”。

下一章可以继续做模型路由：把主模型、快速模型、规划模型、压缩模型、插件命令指定模型统一纳入 provider 和 router，让不同任务走不同模型。
