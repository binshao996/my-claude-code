# 第 25 章：Slash Command 与能力注册中心

第二十四章做完 compact 后，Mini 已经具备长会话治理能力。此时系统能力会越来越多：

- `/context`
- `/memory`
- `/plan`
- `/compact`
- `/resume`
- `/plugin`
- 插件命令
- skill 命令
- 未来的 MCP 命令

这里要特别保留第 13/15 章的 `/plan` 语义。

注册中心里不要把 `/plan` 简化成“查看计划”。

它应该拆成至少四个内置命令：

```txt
/plan       进入 plan mode；如果已经在 plan mode，则展示当前 plan
/plan show  查看当前 plan
/plan clear 清空当前 plan
/plan exit  退出 Mini plan mode
```

如果每加一个能力都在 REPL 里写一段 `if (input.startsWith(...))`，主循环很快会变成一团。真实工程没有这么做。它把所有 slash command 抽象成统一的 `Command`，再按来源加载、过滤、展示和执行。

本章要给 Mini 补上这层能力治理：命令不再散落在 REPL 里，而是进入统一注册中心。

## 真实工程怎么做

真实工程里命令系统主要分布在：

- `src/types/command.ts`：定义 `Command`、`PromptCommand`、`LocalCommand`、`LocalJSXCommand`、执行结果类型。
- `src/commands.ts`：集中声明内置命令，并加载 skills、plugin commands、workflow commands。
- `src/utils/slashCommandParsing.ts`：解析 `/command args`。
- `src/utils/processUserInput/processSlashCommand.tsx`：执行 slash command。
- `src/utils/plugins/loadPluginCommands.ts`：把插件 Markdown 转成 `Command`。
- `src/commands/reload-plugins/`：刷新插件能力并更新当前会话。
- `src/components/HelpV2/` 和 `src/components/PromptInput/`：展示帮助和命令补全。

真实工程的 `Command` 大致分三类：

1. `prompt`：把命令内容转成 model-visible message，继续请求模型。
2. `local`：在本地执行逻辑，返回文本、compact 结果或 skip。
3. `local-jsx`：打开交互 UI，例如设置页、帮助页、选择器。

Mini 先实现前两类。`local-jsx` 需要 Ink UI，可以后面再加。

## 本章目标

完成后，Mini 的命令系统应该支持：

```text
/help
/commands
/context
/compact
/resume <sessionId>
/plugin list
/git-helper:branch-summary
```

并且具备这些工程能力：

- 内置命令和插件命令走同一个注册接口。
- 命令可以声明 `source`、`description`、`aliases`、`isEnabled`、`isHidden`。
- REPL 只负责把输入交给命令系统，不再知道每个命令细节。
- prompt command 可以把内容注入 AgentLoop 并触发模型。
- local command 可以返回本地输出，不触发模型。
- `/help` 和 `/commands` 从注册中心生成，不手写列表。
- `/reload-plugins` 后可以刷新命令缓存。

## 推荐目录

新增：

```text
src/commands/
  commandTypes.ts
  commandRegistry.ts
  commandParser.ts
  commandExecutor.ts
  builtinCommands.ts
  helpCommand.ts
  commandsCommand.ts
  reloadPluginsCommand.ts

src/capabilities/
  capabilitySource.ts
  capabilityRuntime.ts
```

修改：

```text
src/repl/repl.ts
src/plugins/registry.ts
src/chat/agentLoop.ts
```

如果你前面章节已经有 `src/commands/`，就按现有结构合并。重点是把“命令定义、命令查找、命令执行”拆开。

## Command 类型设计

先定义 Mini 版命令类型：

```ts
// src/commands/commandTypes.ts
import type { ChatMessage } from "../chat/messageTypes";
import type { AgentLoop } from "../chat/agentLoop";

export type CommandSource =
  | "builtin"
  | "plugin"
  | "skill"
  | "mcp"
  | "workflow";

export type CommandExecutionContext = {
  cwd: string;
  agentLoop: AgentLoop;
  commands: CommandRegistryView;
};

export type CommandRegistryView = {
  list(): CommandDefinition[];
  find(name: string): CommandDefinition | undefined;
};

export type CommandResult =
  | { type: "skip" }
  | { type: "text"; text: string }
  | { type: "inject"; messages: ChatMessage[]; shouldQuery: boolean }
  | { type: "replaceMessages"; messages: ChatMessage[]; text?: string };

export type BaseCommand = {
  name: string;
  description: string;
  source: CommandSource;
  aliases?: string[];
  argumentHint?: string;
  isEnabled?: () => boolean;
  isHidden?: boolean;
  supportsHeadless?: boolean;
};

export type LocalCommand = BaseCommand & {
  type: "local";
  run(args: string, context: CommandExecutionContext): Promise<CommandResult>;
};

export type PromptCommand = BaseCommand & {
  type: "prompt";
  allowedTools?: string[];
  modelRole?: "main" | "fast" | "planner" | "compact";
  getPrompt(args: string, context: CommandExecutionContext): Promise<string>;
};

export type CommandDefinition = LocalCommand | PromptCommand;
```

这里刻意没有把所有真实工程字段都搬进来。Mini 第一版只保留足够支撑命令治理的字段。

几个字段的含义：

- `source`：命令来自内置、插件、skill、MCP 还是 workflow。
- `aliases`：别名，例如 `/cost` 可以指向 `/usage`。
- `isEnabled`：按环境、配置、feature flag 决定是否可用。
- `isHidden`：命令可执行，但不在 `/help` 和补全里展示。
- `supportsHeadless`：未来给非交互模式或远程控制用。

## 为什么分 local 和 prompt

很多 slash command 不是同一种东西。

`/context`、`/plugin list`、`/version` 是本地命令：

```text
用户输入
  ↓
本地函数执行
  ↓
输出文本
  ↓
不请求模型
```

插件 Markdown 命令、skill 命令更像 prompt 命令：

```text
用户输入
  ↓
读取命令内容
  ↓
替换参数
  ↓
注入隐藏 user message
  ↓
请求模型继续工作
```

把这两类混在 REPL 里会让流程很乱。统一 `CommandResult` 后，REPL 只看结果类型。

## 解析 Slash Command

先实现解析：

```ts
// src/commands/commandParser.ts
export type ParsedCommandInput = {
  name: string;
  args: string;
};

export function parseCommandInput(input: string): ParsedCommandInput | null {
  const trimmed = input.trim();

  if (!trimmed.startsWith("/")) {
    return null;
  }

  const body = trimmed.slice(1).trim();
  if (!body) return null;

  const firstSpace = body.search(/\s/);

  if (firstSpace === -1) {
    return { name: body, args: "" };
  }

  return {
    name: body.slice(0, firstSpace),
    args: body.slice(firstSpace).trim(),
  };
}
```

这个解析和真实工程的 `parseSlashCommand()` 类似：先去掉 `/`，第一个空白前是命令名，后面全部是参数。

不要把参数再按空格强拆成数组。很多命令参数是自然语言，例如：

```text
/compact 聚焦保留认证模块和模型路由的决策
```

这里参数应该是一整段字符串。

## CommandRegistry

注册中心负责四件事：

1. 注册命令。
2. 按 name 或 alias 查找命令。
3. 过滤 disabled / hidden 命令。
4. 暴露稳定的列表给 help、补全和执行器。

```ts
// src/commands/commandRegistry.ts
import type { CommandDefinition } from "./commandTypes";

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private aliases = new Map<string, string>();

  register(command: CommandDefinition): void {
    assertCommandName(command.name);

    if (this.commands.has(command.name)) {
      throw new Error(`Command already registered: ${command.name}`);
    }

    this.commands.set(command.name, command);

    for (const alias of command.aliases ?? []) {
      assertCommandName(alias);

      if (this.aliases.has(alias) || this.commands.has(alias)) {
        throw new Error(`Command alias already registered: ${alias}`);
      }

      this.aliases.set(alias, command.name);
    }
  }

  replaceAll(commands: CommandDefinition[]): void {
    this.commands.clear();
    this.aliases.clear();

    for (const command of commands) {
      this.register(command);
    }
  }

  find(name: string): CommandDefinition | undefined {
    const canonicalName = this.aliases.get(name) ?? name;
    const command = this.commands.get(canonicalName);

    if (!command) return undefined;
    if (command.isEnabled?.() === false) return undefined;

    return command;
  }

  list(options: { includeHidden?: boolean } = {}): CommandDefinition[] {
    return [...this.commands.values()]
      .filter((command) => command.isEnabled?.() !== false)
      .filter((command) => options.includeHidden || !command.isHidden)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  view(): CommandRegistryView {
    return {
      list: () => this.list(),
      find: (name) => this.find(name),
    };
  }
}

function assertCommandName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(name)) {
    throw new Error(`Invalid command name: ${name}`);
  }
}
```

命令名允许 `:`，是为了支持插件命名空间：

```text
/git-helper:branch-summary
```

不要允许 `/`、空格、反斜杠进入命令名。命令名是注册表 key，不应该是路径。

## 执行器

执行器把输入变成 `CommandResult`，然后交给 AgentLoop 或 UI。

```ts
// src/commands/commandExecutor.ts
import { parseCommandInput } from "./commandParser";
import type {
  CommandDefinition,
  CommandExecutionContext,
  CommandResult,
} from "./commandTypes";

export type CommandExecution =
  | { handled: false }
  | {
      handled: true;
      command: CommandDefinition;
      result: CommandResult;
    };

export async function executeCommandInput(
  input: string,
  context: CommandExecutionContext,
): Promise<CommandExecution> {
  const parsed = parseCommandInput(input);
  if (!parsed) return { handled: false };

  const command = context.commands.find(parsed.name);

  if (!command) {
    return {
      handled: true,
      command: unknownCommand(parsed.name),
      result: {
        type: "text",
        text: `Unknown command: ${parsed.name}`,
      },
    };
  }

  if (command.type === "local") {
    return {
      handled: true,
      command,
      result: await command.run(parsed.args, context),
    };
  }

  const prompt = await command.getPrompt(parsed.args, context);

  return {
    handled: true,
    command,
    result: {
      type: "inject",
      shouldQuery: true,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: `/${command.name} ${parsed.args}`.trim(),
          isMeta: false,
        },
        {
          id: crypto.randomUUID(),
          role: "user",
          content: prompt,
          isMeta: true,
        },
      ],
    },
  };
}
```

`unknownCommand` 可以是一个虚拟命令，方便日志和测试统一处理：

```ts
function unknownCommand(name: string): CommandDefinition {
  return {
    type: "local",
    name,
    source: "builtin",
    description: "Unknown command",
    async run() {
      return { type: "text", text: `Unknown command: ${name}` };
    },
  };
}
```

真实工程遇到未知 `/xxx` 时还会判断它是不是文件路径，例如 `/tmp/a.txt` 不应该直接被当成未知命令。Mini 版可以后面再补。第一版先保持简单。

## REPL 接入

REPL 现在不再手写每个命令：

```ts
const execution = await executeCommandInput(input, {
  cwd: process.cwd(),
  agentLoop,
  commands: commandRegistry.view(),
});

if (execution.handled) {
  await applyCommandResult(execution.result, agentLoop);
  return;
}

await agentLoop.ask(input);
```

`applyCommandResult` 负责处理各种结果：

```ts
async function applyCommandResult(
  result: CommandResult,
  agentLoop: AgentLoop,
): Promise<void> {
  if (result.type === "skip") {
    return;
  }

  if (result.type === "text") {
    console.log(result.text);
    return;
  }

  if (result.type === "replaceMessages") {
    agentLoop.replaceMessages(result.messages);
    if (result.text) console.log(result.text);
    return;
  }

  if (result.type === "inject") {
    agentLoop.appendMessages(result.messages);

    if (result.shouldQuery) {
      await agentLoop.continue();
    }
  }
}
```

这要求 AgentLoop 新增两个方法：

```ts
appendMessages(messages: ChatMessage[]): void {
  this.messages.push(...messages);
}

async continue(): Promise<string> {
  const response = await this.callModel(toModelMessages(this.messages));
  this.messages.push({
    id: crypto.randomUUID(),
    role: "assistant",
    content: response,
  });
  return response;
}
```

`ask(input)` 是“追加用户输入再请求模型”。`continue()` 是“已有命令注入了消息，直接继续请求模型”。这两个语义要分开。

## 内置命令列表

创建内置命令集合：

```ts
// src/commands/builtinCommands.ts
import { compactCommand } from "./compactCommand";
import { commandsCommand } from "./commandsCommand";
import { contextCommand } from "./contextCommand";
import { helpCommand } from "./helpCommand";
import { pluginCommand } from "./pluginCommand";
import { reloadPluginsCommand } from "./reloadPluginsCommand";
import { resumeCommand } from "./resumeCommand";
import type { CommandDefinition } from "./commandTypes";

export function getBuiltinCommands(): CommandDefinition[] {
  return [
    helpCommand,
    commandsCommand,
    contextCommand,
    compactCommand,
    pluginCommand,
    reloadPluginsCommand,
    resumeCommand,
  ];
}
```

不要在模块顶层读取配置或扫描磁盘。真实工程的 `COMMANDS` 是函数，并且用缓存包起来，就是为了避免初始化时做太多副作用。

Mini 版也保持这个习惯：`getBuiltinCommands()` 返回定义，真正加载外部能力由 runtime 完成。

## /commands

`/commands` 用来列出当前可用命令：

```ts
// src/commands/commandsCommand.ts
import type { CommandDefinition } from "./commandTypes";

export const commandsCommand: CommandDefinition = {
  type: "local",
  name: "commands",
  aliases: ["cmds"],
  source: "builtin",
  description: "List available slash commands",
  async run(_args, context) {
    const commands = context.commands.list();

    if (commands.length === 0) {
      return { type: "text", text: "No commands available." };
    }

    return {
      type: "text",
      text: commands.map(formatCommandRow).join("\n"),
    };
  },
};

function formatCommandRow(command: CommandDefinition): string {
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return `/${command.name}${hint}  ${command.description}  (${command.source})`;
}
```

示例输出：

```text
/compact [instructions]  Compact current conversation  (builtin)
/context  Show context usage  (builtin)
/git-helper:branch-summary [branch]  Summarize branch changes  (plugin)
```

真实工程在命令补全和 help 中会展示来源，例如 plugin、bundled、workflow。Mini 用文本后缀即可。

## /help

`/help` 可以先复用 `/commands`，再加几行常用说明：

```ts
// src/commands/helpCommand.ts
export const helpCommand: CommandDefinition = {
  type: "local",
  name: "help",
  aliases: ["h"],
  source: "builtin",
  description: "Show help and available commands",
  async run(_args, context) {
    const rows = context.commands
      .list()
      .map((command) => `/${command.name} - ${command.description}`);

    return {
      type: "text",
      text: [
        "Claude Code Mini",
        "",
        "Slash commands:",
        ...rows,
        "",
        "Type normal text to ask the agent.",
      ].join("\n"),
    };
  },
};
```

不要手写固定命令表。命令列表必须来自 registry，否则插件命令和后续新增命令不会出现。

## /compact 迁移为 local command

上一章的 `/compact` 可以改成标准 local command：

```ts
export const compactCommand: CommandDefinition = {
  type: "local",
  name: "compact",
  source: "builtin",
  argumentHint: "[instructions]",
  description: "Compact current conversation",
  async run(args, context) {
    const result = await context.agentLoop.compact(args.trim() || undefined);

    return {
      type: "replaceMessages",
      messages: context.agentLoop.getMessages(),
      text: [
        "Conversation compacted.",
        `Before: ${result.preTokens} tokens`,
        `After: ${result.postTokens} tokens`,
      ].join("\n"),
    };
  },
};
```

注意这里返回 `replaceMessages`，因为 compact 会改 AgentLoop 的当前上下文。

## /resume 迁移为 local command

第二十三章的 `/resume` 也迁移：

```ts
export const resumeCommand: CommandDefinition = {
  type: "local",
  name: "resume",
  source: "builtin",
  argumentHint: "<sessionId | path>",
  description: "Resume a saved conversation",
  async run(args, context) {
    const source = args.trim();

    if (!source) {
      return {
        type: "text",
        text: "Usage: /resume <sessionId | transcript.jsonl>",
      };
    }

    const restored = await resumeConversation(source, context.cwd);
    context.agentLoop.replaceMessages(restored.messages);

    return {
      type: "replaceMessages",
      messages: restored.messages,
      text: `Resumed session ${restored.sessionId}`,
    };
  },
};
```

执行器不用知道 resume 怎么工作，只要按结果类型更新状态。

## 插件命令进入同一注册中心

第十九章已经能加载插件命令。现在把插件命令转成 `PromptCommand`：

```ts
export function pluginCommandToCommandDefinition(
  pluginCommand: PluginCommand,
): PromptCommand {
  return {
    type: "prompt",
    name: pluginCommand.name,
    source: "plugin",
    description: pluginCommand.description,
    argumentHint: pluginCommand.argumentHint,
    allowedTools: pluginCommand.allowedTools,
    async getPrompt(args) {
      return renderPluginCommand(pluginCommand, args);
    },
  };
}
```

然后 runtime 加载时合并：

```ts
export async function buildRuntimeCommands(
  pluginRegistry: PluginRegistry,
): Promise<CommandDefinition[]> {
  const pluginRuntime = await pluginRegistry.load();

  return [
    ...pluginRuntime.commands.map(pluginCommandToCommandDefinition),
    ...getBuiltinCommands(),
  ];
}
```

顺序上建议插件命令放在内置命令前面，但不允许覆盖内置命令名。真实工程也会做 dedupe 和来源标注。Mini 的 `CommandRegistry.register()` 已经会在重名时报错。

## 能力 Runtime

当系统能力来源变多，可以用一个 `CapabilityRuntime` 聚合：

```ts
// src/capabilities/capabilityRuntime.ts
import type { CommandDefinition } from "../commands/commandTypes";
import { getBuiltinCommands } from "../commands/builtinCommands";
import type { PluginRegistry } from "../plugins/registry";
import { pluginCommandToCommandDefinition } from "../plugins/commandAdapter";

export type CapabilityRuntime = {
  commands: CommandDefinition[];
  errors: string[];
};

export async function loadCapabilityRuntime(input: {
  pluginRegistry: PluginRegistry;
}): Promise<CapabilityRuntime> {
  const errors: string[] = [];
  const commands: CommandDefinition[] = [];

  try {
    const pluginRuntime = await input.pluginRegistry.load();
    commands.push(
      ...pluginRuntime.commands.map(pluginCommandToCommandDefinition),
    );
  } catch (error) {
    errors.push(`Failed to load plugin commands: ${String(error)}`);
  }

  commands.push(...getBuiltinCommands());

  return { commands, errors };
}
```

启动时：

```ts
const commandRegistry = new CommandRegistry();
const runtime = await loadCapabilityRuntime({ pluginRegistry });

commandRegistry.replaceAll(runtime.commands);

for (const error of runtime.errors) {
  console.error(error);
}
```

这层的价值是：以后 MCP、workflow、skills 都可以往 `CapabilityRuntime` 里追加，不需要改 REPL。

## /reload-plugins

`/reload-plugins` 本质上是重新加载 runtime，并替换 registry：

```ts
export function createReloadPluginsCommand(input: {
  pluginRegistry: PluginRegistry;
  commandRegistry: CommandRegistry;
}): CommandDefinition {
  return {
    type: "local",
    name: "reload-plugins",
    source: "builtin",
    description: "Reload plugin commands in current session",
    async run() {
      const runtime = await loadCapabilityRuntime({
        pluginRegistry: input.pluginRegistry,
      });

      input.commandRegistry.replaceAll(runtime.commands);

      return {
        type: "text",
        text: [
          `Reloaded ${runtime.commands.length} commands.`,
          runtime.errors.length > 0
            ? `${runtime.errors.length} errors during load.`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  };
}
```

真实工程的 `/reload-plugins` 还会刷新 agents、hooks、MCP、LSP，并更新 AppState。Mini 当前只刷新 commands，后续加 MCP 时再扩展。

## 启用、禁用和隐藏

命令是否出现，不应该由 UI 手写判断。统一用字段：

```ts
export const debugCommand: CommandDefinition = {
  type: "local",
  name: "debug",
  source: "builtin",
  description: "Toggle debug logging",
  isEnabled: () => process.env.CCMINI_DEBUG_COMMANDS === "1",
  async run(args) {
    return toggleDebug(args);
  },
};
```

隐藏命令：

```ts
export const internalReloadCommand: CommandDefinition = {
  type: "local",
  name: "internal-reload",
  source: "builtin",
  description: "Internal reload command",
  isHidden: true,
  async run() {
    return { type: "skip" };
  },
};
```

规则：

- `isEnabled === false`：不可执行，也不展示。
- `isHidden === true`：可执行，但不在 help 和补全展示。
- 插件禁用后，它的命令不应该进入 registry。

## prompt command 的 allowedTools

插件命令经常需要额外授权，比如只允许读文件：

```md
---
description: Summarize current branch changes
allowed-tools: Read, Bash(git diff:*), Bash(git status:*)
---

请总结当前分支相对 main 的改动。
```

Mini 可以先把 `allowedTools` 放进 meta message：

```ts
function buildAllowedToolsMessage(command: PromptCommand): ChatMessage | null {
  if (!command.allowedTools || command.allowedTools.length === 0) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    role: "user",
    isMeta: true,
    content: `Allowed tools for this command: ${command.allowedTools.join(", ")}`,
  };
}
```

执行 prompt command 时：

```ts
const permissionMessage = buildAllowedToolsMessage(command);

messages: [
  commandInputMessage,
  promptMessage,
  ...(permissionMessage ? [permissionMessage] : []),
]
```

更完整的实现应该把 allowedTools 合并进本轮 `ToolPermissionContext`，而不是只告诉模型。Mini 可以先做提示，等权限系统成熟后再做强约束。

## 命令执行记录

命令也应该写进 transcript，方便恢复和 debug。

建议记录两类：

```ts
type TranscriptCommandEntry = {
  type: "command";
  uuid: string;
  sessionId: string;
  timestamp: string;
  commandName: string;
  args: string;
  source: CommandSource;
};

type TranscriptCommandOutputEntry = {
  type: "command_output";
  uuid: string;
  sessionId: string;
  timestamp: string;
  commandName: string;
  output: string;
};
```

执行器里写入：

```ts
await transcript.write({
  type: "command",
  uuid: randomUUID(),
  sessionId: getSessionId(),
  timestamp: new Date().toISOString(),
  commandName: command.name,
  args: command.isSensitive ? "***" : parsed.args,
  source: command.source,
});
```

如果命令返回本地文本，再写 output：

```ts
if (result.type === "text") {
  await transcript.write({
    type: "command_output",
    uuid: randomUUID(),
    sessionId: getSessionId(),
    timestamp: new Date().toISOString(),
    commandName: command.name,
    output: result.text,
  });
}
```

这里预留了 `isSensitive` 字段。真实工程里敏感命令会把参数从显示和日志里打码。Mini 后续做登录、token、provider 配置时会用到。

## 非交互模式

有些命令只能在交互模式执行，比如打开选择器。有些命令可以在 headless 模式执行，比如：

```bash
echo "/context" | bun run src/entrypoints/cli.tsx -p
```

Mini 先用 `supportsHeadless` 控制：

```ts
export function assertCommandCanRunInMode(
  command: CommandDefinition,
  mode: "interactive" | "headless",
): void {
  if (mode === "headless" && command.supportsHeadless !== true) {
    throw new Error(`Command /${command.name} is only available interactively.`);
  }
}
```

执行前：

```ts
assertCommandCanRunInMode(command, context.mode);
```

真实工程里还有 remote-safe、bridge-safe 的概念：远程客户端发来的命令不能随便打开本地 UI，也不能执行本地危险操作。Mini 可以先抽象成 mode gate，后面再加远程模式。

## 命令补全

如果你的 REPL 有简单补全，可以直接从 registry 取：

```ts
export function getCommandSuggestions(
  input: string,
  registry: CommandRegistry,
): string[] {
  if (!input.startsWith("/")) return [];

  const query = input.slice(1).toLowerCase();

  return registry
    .list()
    .filter((command) => command.name.toLowerCase().startsWith(query))
    .slice(0, 10)
    .map((command) => `/${command.name}`);
}
```

补全不要扫描磁盘。磁盘扫描应该发生在 `/reload-plugins` 或启动加载时，补全只读内存 registry。

## 错误处理

命令失败时，不要让 REPL 崩掉：

```ts
try {
  const execution = await executeCommandInput(input, context);
  if (execution.handled) {
    await applyCommandResult(execution.result, agentLoop);
    return;
  }
} catch (error) {
  console.error(`Command failed: ${String(error)}`);
  return;
}
```

对于 prompt command，错误要生成本地输出，不要发给模型继续推理：

```ts
return {
  handled: true,
  command,
  result: {
    type: "text",
    text: `Command /${command.name} failed: ${String(error)}`,
  },
};
```

真实工程里会把 local command 错误包装成 `<local-command-stderr>`，写进消息流，但不触发模型请求。Mini 用普通文本输出即可。

## 测试清单

建议补这些测试：

```ts
describe("parseCommandInput", () => {
  test("parses command without args", () => {});
  test("parses command with natural language args", () => {});
  test("returns null for normal user input", () => {});
});

describe("CommandRegistry", () => {
  test("registers and finds commands by name", () => {});
  test("finds commands by alias", () => {});
  test("rejects duplicate names", () => {});
  test("filters disabled commands", () => {});
  test("hides hidden commands from list", () => {});
});

describe("executeCommandInput", () => {
  test("returns handled false for normal input", async () => {});
  test("runs local command", async () => {});
  test("injects prompt command messages", async () => {});
  test("returns text for unknown command", async () => {});
});

describe("CapabilityRuntime", () => {
  test("merges builtin and plugin commands", async () => {});
  test("keeps loading when plugin command fails", async () => {});
  test("reload replaces registry contents", async () => {});
});
```

对应命令：

```bash
bun test src/commands/__tests__/commandParser.test.ts
bun test src/commands/__tests__/commandRegistry.test.ts
bun test src/commands/__tests__/commandExecutor.test.ts
bun test src/capabilities/__tests__/capabilityRuntime.test.ts
bun run typecheck
```

## 常见问题

### 为什么不继续在 REPL 里写 if 分发？

因为命令来源会越来越多。REPL 如果知道每个命令细节，就会同时承担 UI、解析、权限、插件、执行、日志这些职责。注册中心把这些能力收敛到一个边界里。

### prompt command 为什么要注入 meta user message？

因为它本质上是“把一段命令内容交给模型执行”。用户输入 `/git-helper:branch-summary`，模型真正需要看到的是插件 Markdown 渲染后的任务说明。

meta user message 可以对用户隐藏，但对模型可见。

### local command 为什么默认不请求模型？

因为 local command 的目标通常是改变本地状态或显示信息。例如 `/context`、`/help`、`/plugin list`。这些命令如果执行后又请求模型，会产生意外回复和额外成本。

### 为什么 help 要从 registry 生成？

因为命令可能来自插件、skill、MCP、workflow。手写 help 一定会过期。registry 是当前会话真实可用能力的唯一来源。

### 插件命令能覆盖内置命令吗？

不要允许。覆盖内置命令会让 `/help`、`/compact` 这种基础能力变得不可预测。插件应该用命名空间，例如 `/git-helper:branch-summary`。

### disabled 和 hidden 有什么区别？

`disabled` 是不可用。查找和执行都应该失败。

`hidden` 是不展示。高级命令、迁移命令或内部命令可以隐藏，但仍允许明确输入时执行。

### 为什么要记录命令到 transcript？

因为命令会改变会话状态。比如 `/compact` 改 messages，`/resume` 改 session，插件 prompt command 会向模型注入任务。没有 transcript 记录，恢复和 debug 时会看不懂历史。

## 本章完成标准

完成后应满足：

- REPL 不再手写 `/compact`、`/context`、`/resume` 等命令分支。
- 所有 slash command 都通过 `CommandRegistry` 查找。
- 内置命令和插件命令能合并进同一 registry。
- `/commands` 和 `/help` 从 registry 生成列表。
- local command 能返回文本、skip 或替换 messages。
- prompt command 能注入 meta message 并触发 AgentLoop 继续执行。
- disabled 命令不可执行。
- hidden 命令不出现在 help 里。
- `/reload-plugins` 能刷新当前 registry。
- 命令执行记录能写入 transcript。
- `bun run typecheck` 通过。

第二十五章到这里，Mini 的能力入口就从“散落在主循环里的分支”升级成了“统一注册、统一展示、统一执行”。下一章可以继续做 MCP：让外部进程把工具、资源和 prompt 接入 Mini，而不是只能靠本地内置工具和插件扩展。
