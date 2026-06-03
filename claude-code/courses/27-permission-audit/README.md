# 第 27 章：统一权限规则与审计

第二十六章把 MCP 外部工具接进了 Mini。现在系统里已经有多种高风险能力：

- Shell 命令。
- 文件读取、编辑和写入。
- MCP 外部工具。
- MCP resources 读取。
- slash command 临时注入的能力。
- 插件和 skill 暴露出来的工具。

第十五章已经做过基础权限提示：工具执行前返回 `allow`、`ask` 或 `deny`，用户可以临时放行或拒绝。那一章解决的是“能不能弹出权限确认”。

本章解决更完整的问题：所有能力都进入同一套权限规则、审批流程和审计记录。Mini 不能让 Bash 有一套规则、文件编辑有一套规则、MCP 又有一套规则。能力来源可以很多，但权限入口必须只有一个。

## 真实工程怎么做

真实工程的权限系统主要分布在：

- `src/types/permissions.ts`：定义 `PermissionMode`、`PermissionRule`、`PermissionUpdate`、`PermissionDecisionReason`。
- `src/Tool.ts`：工具接口里定义 `checkPermissions`、`preparePermissionMatcher`、`getPath`、`mcpInfo`。
- `src/utils/permissions/permissions.ts`：核心权限决策链。
- `src/utils/permissions/permissionRuleParser.ts`：解析 `Tool(content)` 这种规则字符串。
- `src/utils/permissions/PermissionUpdate.ts`：把审批产生的规则更新应用到 context，并按来源持久化。
- `src/utils/permissions/denialTracking.ts`：追踪连续拒绝，避免自动判断陷入循环。
- `src/hooks/toolPermission/PermissionContext.ts`：把权限请求、审批、持久化和日志串起来。
- `src/hooks/toolPermission/permissionLogging.ts`：记录审批来源、等待时间、工具名和代码编辑指标。
- `src/components/permissions/PermissionRequest.tsx`：按工具类型渲染不同的审批 UI。
- `src/services/mcp/mcpStringUtils.ts`：把 MCP 工具名统一成 `mcp__server__tool`。
- `src/services/mcp/client.ts`：把 MCP tools 转成统一 Tool，并提供默认权限建议。

真实工程的关键点不是“弹窗长什么样”，而是这几件事：

1. 权限规则可以来自多个来源：用户配置、项目配置、本地配置、命令、会话。
2. 规则匹配支持工具级、内容级和 MCP server 级。
3. 每个工具可以先做自己的安全检查。
4. 用户审批可以产生 `PermissionUpdate`，例如“本次会话总是允许这个工具”。
5. 审批结果必须进入日志和 transcript，后面才能复盘。
6. deny 和安全检查要比宽松模式优先。

Mini 本章实现这个最小闭环。

## 本章目标

完成后，Mini 应该支持这些规则：

```text
Bash
Bash(git *)
Edit(src/**)
Write(docs/**)
mcp__filesystem__read_file
mcp__filesystem__*
```

并且具备这些行为：

- 所有 Tool 执行前都走 `PermissionEngine`。
- 权限规则有 `allow`、`ask`、`deny` 三种行为。
- deny 优先级最高。
- 文件工具可以按路径匹配。
- Bash 可以按命令 pattern 匹配。
- MCP 可以按单个工具或整个 server 匹配。
- slash command 可以临时注入 `allowedTools`。
- 用户在审批 UI 里可以选择“允许一次”或“本会话允许”。
- 审批决策会写入审计日志。
- 工具输入写入审计前要脱敏。
- 多次拒绝后 Agent Loop 可以停止继续尝试同类工具。

## 推荐目录

新增：

```text
src/permissions/
  permissionTypes.ts
  permissionRuleParser.ts
  permissionRules.ts
  permissionContext.ts
  permissionEngine.ts
  permissionPrompt.ts
  permissionAudit.ts
  denialTracker.ts

src/commands/
  permissionsCommand.ts
```

修改：

```text
src/tools/toolTypes.ts
src/tools/toolRunner.ts
src/tools/bashTool.ts
src/tools/fileTools.ts
src/mcp/mcpToolAdapter.ts
src/chat/agentLoop.ts
src/commands/commandTypes.ts
src/commands/commandExecutor.ts
```

职责边界：

- `permissionTypes.ts` 只放类型。
- `permissionRuleParser.ts` 只处理规则字符串和结构互转。
- `permissionRules.ts` 只做规则匹配。
- `permissionContext.ts` 管当前会话的规则和 mode。
- `permissionEngine.ts` 做最终权限判断。
- `permissionPrompt.ts` 负责问用户。
- `permissionAudit.ts` 负责脱敏和记录。
- `denialTracker.ts` 负责防止重复拒绝循环。

## 权限类型

先定义 Mini 版权限类型：

```ts
// src/permissions/permissionTypes.ts
import type { ToolDefinition, ToolInput } from "../tools/toolTypes";

export type PermissionBehavior = "allow" | "ask" | "deny";

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "dontAsk"
  | "bypassPermissions";

export type PermissionRuleSource =
  | "user"
  | "project"
  | "local"
  | "command"
  | "session";

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

export type PermissionRule = {
  source: PermissionRuleSource;
  behavior: PermissionBehavior;
  value: PermissionRuleValue;
};

export type PermissionDecisionReason =
  | { type: "rule"; rule: PermissionRule }
  | { type: "mode"; mode: PermissionMode }
  | { type: "tool"; toolName: string; reason: string }
  | { type: "safety"; reason: string }
  | { type: "user"; reason?: string }
  | { type: "other"; reason: string };

export type PermissionUpdate = {
  type: "addRules";
  behavior: PermissionBehavior;
  source: PermissionRuleSource;
  rules: PermissionRuleValue[];
};

export type PermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: ToolInput;
      reason?: PermissionDecisionReason;
    }
  | {
      behavior: "ask";
      message: string;
      updatedInput?: ToolInput;
      reason?: PermissionDecisionReason;
      suggestions?: PermissionUpdate[];
    }
  | {
      behavior: "deny";
      message: string;
      reason: PermissionDecisionReason;
    }
  | {
      behavior: "passthrough";
      message: string;
      updatedInput?: ToolInput;
      suggestions?: PermissionUpdate[];
    };

export type PermissionCheckRequest = {
  tool: ToolDefinition;
  input: ToolInput;
  context: PermissionContext;
};

export type PermissionContext = {
  mode: PermissionMode;
  rules: PermissionRule[];
  cwd: string;
};
```

这里保留 `passthrough`，是为了让工具可以表达：“我自己没有明确 allow 或 deny，交给统一权限引擎继续判断。”

## 扩展 Tool 接口

第五章和第七章已经有 Mini Tool。现在给它补权限能力：

```ts
// src/tools/toolTypes.ts
import type {
  PermissionContext,
  PermissionDecision,
} from "../permissions/permissionTypes";

export type ToolInput = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
  isReadOnly?: (input: ToolInput) => boolean;
  getPath?: (input: ToolInput) => string | undefined;
  preparePermissionMatcher?: (
    input: ToolInput,
  ) => Promise<(pattern: string) => boolean>;
  checkPermissions?: (
    input: ToolInput,
    context: PermissionContext,
  ) => Promise<PermissionDecision>;
  mcpInfo?: {
    serverName: string;
    toolName: string;
  };
  execute(input: ToolInput): Promise<ToolResult>;
};
```

这几个字段分别负责：

- `isReadOnly`：辅助并发和展示，不等于自动放行。
- `getPath`：文件工具暴露目标路径。
- `preparePermissionMatcher`：让工具自己决定 ruleContent 怎么匹配。
- `checkPermissions`：工具自己的安全判断。
- `mcpInfo`：即使 MCP 工具名被展示成别名，权限仍然用完整 MCP 名匹配。

## 权限规则语法

Mini 使用两种规则：

```text
Tool
Tool(content)
```

例子：

```text
Bash
Bash(git *)
Edit(src/**)
mcp__filesystem__read_file
mcp__filesystem__*
```

实现解析器：

```ts
// src/permissions/permissionRuleParser.ts
import type { PermissionRuleValue } from "./permissionTypes";

export function parsePermissionRule(raw: string): PermissionRuleValue {
  const open = findFirstUnescaped(raw, "(");
  if (open === -1) {
    return { toolName: raw };
  }

  const close = findLastUnescaped(raw, ")");
  if (close === -1 || close !== raw.length - 1 || close < open) {
    return { toolName: raw };
  }

  const toolName = raw.slice(0, open);
  const content = raw.slice(open + 1, close);

  if (!toolName || content === "" || content === "*") {
    return { toolName: toolName || raw };
  }

  return {
    toolName,
    ruleContent: unescapeRuleContent(content),
  };
}

export function stringifyPermissionRule(rule: PermissionRuleValue): string {
  if (!rule.ruleContent) {
    return rule.toolName;
  }

  return `${rule.toolName}(${escapeRuleContent(rule.ruleContent)})`;
}

function escapeRuleContent(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function unescapeRuleContent(value: string): string {
  return value.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

function findFirstUnescaped(value: string, char: string): number {
  for (let index = 0; index < value.length; index++) {
    if (value[index] === char && !isEscaped(value, index)) {
      return index;
    }
  }

  return -1;
}

function findLastUnescaped(value: string, char: string): number {
  for (let index = value.length - 1; index >= 0; index--) {
    if (value[index] === char && !isEscaped(value, index)) {
      return index;
    }
  }

  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) {
    slashCount++;
  }

  return slashCount % 2 === 1;
}
```

这里不要用简单的 `split("(")`，因为命令和路径里可能真的包含括号。

## MCP 工具名

MCP 工具必须使用完整权限名：

```ts
// src/mcp/mcpNames.ts
export function normalizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(toolName)}`;
}

export function parseMcpToolName(value: string):
  | { serverName: string; toolName?: string }
  | undefined {
  const parts = value.split("__");
  const [prefix, serverName, ...toolParts] = parts;

  if (prefix !== "mcp" || !serverName) {
    return undefined;
  }

  return {
    serverName,
    toolName: toolParts.length > 0 ? toolParts.join("__") : undefined,
  };
}

export function getToolPermissionName(tool: {
  name: string;
  mcpInfo?: { serverName: string; toolName: string };
}): string {
  if (!tool.mcpInfo) {
    return tool.name;
  }

  return buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName);
}
```

为什么不直接用 `tool.name`？

因为 MCP 工具可能为了展示或兼容而使用短名字。权限系统不能依赖展示名，否则外部工具可能和内置工具重名。

## 规则匹配

规则匹配分三层：

1. 工具名匹配。
2. MCP server 通配匹配。
3. 内容匹配。

```ts
// src/permissions/permissionRules.ts
import type {
  PermissionBehavior,
  PermissionContext,
  PermissionRule,
  PermissionRuleValue,
} from "./permissionTypes";
import type { ToolDefinition, ToolInput } from "../tools/toolTypes";
import { getToolPermissionName, parseMcpToolName } from "../mcp/mcpNames";

export async function findMatchingRule(params: {
  context: PermissionContext;
  behavior: PermissionBehavior;
  tool: ToolDefinition;
  input: ToolInput;
}): Promise<PermissionRule | undefined> {
  const rules = params.context.rules.filter((rule) => rule.behavior === params.behavior);

  for (const rule of rules) {
    if (await toolMatchesRule(params.tool, params.input, rule.value)) {
      return rule;
    }
  }

  return undefined;
}

export async function toolMatchesRule(
  tool: ToolDefinition,
  input: ToolInput,
  rule: PermissionRuleValue,
): Promise<boolean> {
  const toolName = getToolPermissionName(tool);

  if (!toolNameMatches(rule.toolName, toolName)) {
    return false;
  }

  if (!rule.ruleContent) {
    return true;
  }

  const matcher = await tool.preparePermissionMatcher?.(input);
  if (!matcher) {
    return false;
  }

  return matcher(rule.ruleContent);
}

function toolNameMatches(ruleName: string, toolName: string): boolean {
  if (ruleName === toolName) {
    return true;
  }

  const ruleMcp = parseMcpToolName(ruleName);
  const toolMcp = parseMcpToolName(toolName);

  if (!ruleMcp || !toolMcp) {
    return false;
  }

  if (ruleMcp.serverName !== toolMcp.serverName) {
    return false;
  }

  return !ruleMcp.toolName || ruleMcp.toolName === "*" || ruleMcp.toolName === toolMcp.toolName;
}
```

注意 `mcp__filesystem__*` 的含义是允许或拒绝 filesystem server 的所有工具，不是允许所有 MCP server。

## 权限上下文

权限规则要能按来源管理。Mini 先用内存实现，再接配置文件。

```ts
// src/permissions/permissionContext.ts
import type {
  PermissionBehavior,
  PermissionContext,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionUpdate,
} from "./permissionTypes";

const SOURCE_ORDER: PermissionRuleSource[] = [
  "user",
  "project",
  "local",
  "command",
  "session",
];

export class PermissionContextStore {
  private mode: PermissionMode = "default";
  private rules: PermissionRule[] = [];

  constructor(private readonly cwd: string) {}

  snapshot(): PermissionContext {
    return {
      mode: this.mode,
      cwd: this.cwd,
      rules: [...this.rules].sort(
        (left, right) => SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source),
      ),
    };
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  addRules(
    source: PermissionRuleSource,
    behavior: PermissionBehavior,
    values: PermissionRuleValue[],
  ): void {
    for (const value of values) {
      this.rules.push({ source, behavior, value });
    }
  }

  applyUpdate(update: PermissionUpdate): void {
    if (update.type === "addRules") {
      this.addRules(update.source, update.behavior, update.rules);
    }
  }

  removeSource(source: PermissionRuleSource): void {
    this.rules = this.rules.filter((rule) => rule.source !== source);
  }
}
```

`command` 来源很重要。slash command 可以声明自己运行期间允许哪些工具，但命令结束后这些规则应该被移除。

## 核心权限引擎

权限引擎只回答一件事：这个工具调用现在能不能执行。

推荐顺序：

1. deny 规则。
2. 工具自己的安全检查。
3. 工具自己的强制 ask 或 deny。
4. bypass 不可绕过的安全 ask。
5. 权限模式。
6. allow 规则。
7. ask 规则。
8. 默认 ask。

```ts
// src/permissions/permissionEngine.ts
import type {
  PermissionCheckRequest,
  PermissionDecision,
} from "./permissionTypes";
import { findMatchingRule } from "./permissionRules";
import { getToolPermissionName } from "../mcp/mcpNames";

export async function checkToolPermission(
  request: PermissionCheckRequest,
): Promise<PermissionDecision> {
  const { tool, input, context } = request;
  const toolName = getToolPermissionName(tool);

  const denyRule = await findMatchingRule({ context, behavior: "deny", tool, input });
  if (denyRule) {
    return {
      behavior: "deny",
      message: `Permission to use ${toolName} has been denied.`,
      reason: { type: "rule", rule: denyRule },
    };
  }

  const toolDecision = await runToolPermissionCheck(request);
  if (toolDecision.behavior === "deny") {
    return toolDecision;
  }

  if (
    toolDecision.behavior === "ask" &&
    toolDecision.reason?.type === "safety"
  ) {
    return toolDecision;
  }

  if (context.mode === "bypassPermissions") {
    return {
      behavior: "allow",
      updatedInput: toolDecision.updatedInput ?? input,
      reason: { type: "mode", mode: context.mode },
    };
  }

  if (context.mode === "plan" && !tool.isReadOnly?.(input)) {
    return {
      behavior: "deny",
      message: "Plan mode only allows read-only tools.",
      reason: { type: "mode", mode: context.mode },
    };
  }

  const allowRule = await findMatchingRule({ context, behavior: "allow", tool, input });
  if (allowRule) {
    return {
      behavior: "allow",
      updatedInput: toolDecision.updatedInput ?? input,
      reason: { type: "rule", rule: allowRule },
    };
  }

  const askRule = await findMatchingRule({ context, behavior: "ask", tool, input });
  if (askRule) {
    return {
      behavior: "ask",
      message: `Mini needs permission to use ${toolName}.`,
      updatedInput: toolDecision.updatedInput ?? input,
      reason: { type: "rule", rule: askRule },
    };
  }

  if (toolDecision.behavior === "ask") {
    return toolDecision;
  }

  if (context.mode === "dontAsk") {
    return {
      behavior: "deny",
      message: `Permission required for ${toolName}, but prompting is disabled.`,
      reason: { type: "mode", mode: context.mode },
    };
  }

  return {
    behavior: "ask",
    message: `Mini needs permission to use ${toolName}.`,
    updatedInput: toolDecision.updatedInput ?? input,
    suggestions: toolDecision.suggestions,
  };
}

async function runToolPermissionCheck(
  request: PermissionCheckRequest,
): Promise<PermissionDecision> {
  if (!request.tool.checkPermissions) {
    return {
      behavior: "passthrough",
      message: `Mini needs permission to use ${request.tool.name}.`,
    };
  }

  return request.tool.checkPermissions(request.input, request.context);
}
```

真实工程还有 hook、classifier、sandbox 等分支。Mini 先保留清晰主链路，后面再扩展。

## 文件工具权限

文件编辑和写入要按路径判断。

```ts
// src/tools/fileTools.ts
import path from "node:path";
import { matchGlob } from "../utils/glob";
import type { PermissionContext, PermissionDecision } from "../permissions/permissionTypes";
import type { ToolDefinition, ToolInput } from "./toolTypes";

const SENSITIVE_PATHS = [
  ".git/**",
  ".ssh/**",
  ".env",
  ".env.*",
  "**/id_rsa",
  "**/id_ed25519",
];

export const EditTool: ToolDefinition = {
  name: "Edit",
  description: "Edit a file",
  inputSchema: {},
  getPath(input) {
    return String(input.file_path ?? "");
  },
  async preparePermissionMatcher(input) {
    const filePath = String(input.file_path ?? "");
    return (pattern) => matchGlob(pattern, filePath);
  },
  async checkPermissions(input, context) {
    return checkFileWritePermission(EditTool, input, context);
  },
  async execute(input) {
    return editFile(input);
  },
};

export async function checkFileWritePermission(
  tool: ToolDefinition,
  input: ToolInput,
  context: PermissionContext,
): Promise<PermissionDecision> {
  const rawPath = tool.getPath?.(input);
  if (!rawPath) {
    return {
      behavior: "deny",
      message: "Missing file path.",
      reason: { type: "tool", toolName: tool.name, reason: "missing_path" },
    };
  }

  const absolutePath = path.resolve(context.cwd, rawPath);
  const relativePath = path.relative(context.cwd, absolutePath);

  if (relativePath.startsWith("..")) {
    return {
      behavior: "ask",
      message: `File is outside the current workspace: ${absolutePath}`,
      reason: { type: "safety", reason: "outside_workspace" },
    };
  }

  if (SENSITIVE_PATHS.some((pattern) => matchGlob(pattern, relativePath))) {
    return {
      behavior: "ask",
      message: `File is sensitive: ${relativePath}`,
      reason: { type: "safety", reason: "sensitive_path" },
    };
  }

  return {
    behavior: "passthrough",
    message: `Mini needs permission to edit ${relativePath}.`,
  };
}
```

这里用 `ask` 而不是 `deny`，因为用户确实可能需要修改 `.env.example` 或配置文件。真正禁止什么，交给 deny 规则。

## Bash 权限

Bash 的重点是命令 pattern，而不是整段字符串直接匹配。比如：

```text
FOO=bar git status
```

应该能匹配：

```text
Bash(git *)
```

Mini 第一版可以先做保守解析：

```ts
// src/tools/bashTool.ts
import { matchWildcard } from "../utils/matchWildcard";
import type { PermissionContext, PermissionDecision } from "../permissions/permissionTypes";
import type { ToolDefinition, ToolInput } from "./toolTypes";

const READ_ONLY_PREFIXES = [
  "pwd",
  "ls",
  "cat",
  "grep",
  "rg",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
];

const DANGEROUS_PATTERNS = [
  "rm -rf /",
  "chmod 777 *",
  "git push --force *",
  "curl * | sh",
  "curl * | bash",
];

export const BashTool: ToolDefinition = {
  name: "Bash",
  description: "Run a shell command",
  inputSchema: {},
  isReadOnly(input) {
    const command = normalizeCommand(String(input.command ?? ""));
    return READ_ONLY_PREFIXES.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
  },
  async preparePermissionMatcher(input) {
    const command = normalizeCommand(String(input.command ?? ""));
    const subcommands = splitSimpleCommandList(command);

    return (pattern) => subcommands.some((subcommand) => matchWildcard(pattern, subcommand));
  },
  async checkPermissions(input, context) {
    return checkBashPermission(input, context);
  },
  async execute(input) {
    return runShell(input);
  },
};

async function checkBashPermission(
  input: ToolInput,
  _context: PermissionContext,
): Promise<PermissionDecision> {
  const command = normalizeCommand(String(input.command ?? ""));

  if (!command) {
    return {
      behavior: "deny",
      message: "Missing shell command.",
      reason: { type: "tool", toolName: "Bash", reason: "missing_command" },
    };
  }

  if (DANGEROUS_PATTERNS.some((pattern) => matchWildcard(pattern, command))) {
    return {
      behavior: "ask",
      message: `Shell command needs explicit approval: ${command}`,
      reason: { type: "safety", reason: "dangerous_shell_pattern" },
    };
  }

  return {
    behavior: "passthrough",
    message: `Mini needs permission to run: ${command}`,
    suggestions: [
      {
        type: "addRules",
        behavior: "allow",
        source: "session",
        rules: [{ toolName: "Bash", ruleContent: command }],
      },
    ],
  };
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function splitSimpleCommandList(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;)\s*/g)
    .map(stripLeadingEnv)
    .filter(Boolean);
}

function stripLeadingEnv(command: string): string {
  return command.replace(/^(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)+/i, "");
}
```

这不是完整 shell parser，但它比直接字符串匹配安全一点。后续如果要支持复杂 shell 语法，应该引入专门解析器，而不是继续堆正则。

## MCP 工具权限

MCP 工具来自外部 server。即使它声明 `readOnlyHint`，Mini 第一版也不自动放行。

在第二十六章的 MCP adapter 里补权限字段：

```ts
// src/mcp/mcpToolAdapter.ts
import type { ToolDefinition } from "../tools/toolTypes";
import { buildMcpToolName } from "./mcpNames";

export function createMcpTool(params: {
  serverName: string;
  toolName: string;
  description?: string;
  inputSchema: unknown;
  callTool(input: Record<string, unknown>): Promise<unknown>;
}): ToolDefinition {
  const permissionName = buildMcpToolName(params.serverName, params.toolName);

  return {
    name: permissionName,
    description: params.description ?? "",
    inputSchema: params.inputSchema,
    mcpInfo: {
      serverName: params.serverName,
      toolName: params.toolName,
    },
    async checkPermissions() {
      return {
        behavior: "passthrough",
        message: `MCP tool requires permission: ${permissionName}`,
        suggestions: [
          {
            type: "addRules",
            behavior: "allow",
            source: "session",
            rules: [{ toolName: permissionName }],
          },
        ],
      };
    },
    async execute(input) {
      return params.callTool(input);
    },
  };
}
```

如果用户想允许整个 filesystem server，可以手动加：

```text
mcp__filesystem__*
```

但默认建议只允许单个 MCP tool。外部 server 能力范围通常比名字看起来更大，默认窄授权更稳。

## 命令级 allowedTools

第二十五章有 `PromptCommand`。现在给命令增加临时授权：

```ts
// src/commands/commandTypes.ts
import type { PermissionRuleValue } from "../permissions/permissionTypes";

export type PromptCommand = BaseCommand & {
  type: "prompt";
  prompt: string;
  allowedTools?: PermissionRuleValue[];
};
```

执行 prompt command 时，临时注入 `command` 来源规则：

```ts
// src/commands/commandExecutor.ts
export async function executeCommand(name: string, args: string, context: CommandExecutionContext) {
  const command = context.registry.find(name);
  if (!command) {
    return { type: "text", text: `Unknown command: ${name}` };
  }

  if (command.type !== "prompt") {
    return command.run(args, context);
  }

  context.permissions.removeSource("command");

  if (command.allowedTools?.length) {
    context.permissions.addRules("command", "allow", command.allowedTools);
  }

  try {
    return {
      type: "inject",
      shouldQuery: true,
      messages: [
        {
          role: "user",
          content: renderPromptCommand(command.prompt, args),
        },
      ],
    };
  } finally {
    context.permissions.removeSource("command");
  }
}
```

如果命令会触发后续 Agent Loop，不要在 `finally` 里立刻删除规则。更稳的做法是把 command scope 包在一次 agent turn 上：

```ts
await agentLoop.runWithPermissionScope("command", command.allowedTools ?? [], async () => {
  await agentLoop.query(renderPromptCommand(command.prompt, args));
});
```

重点是：命令级授权不能永久污染会话。

## 审批 UI

Mini 不需要马上做复杂 Ink UI。先做文本交互：

```ts
// src/permissions/permissionPrompt.ts
import type {
  PermissionDecision,
  PermissionUpdate,
} from "./permissionTypes";

export type PermissionPromptResult =
  | { behavior: "allow"; updates: PermissionUpdate[] }
  | { behavior: "deny"; feedback?: string };

export type AskUser = (message: string) => Promise<string>;

export async function promptForPermission(
  decision: Extract<PermissionDecision, { behavior: "ask" }>,
  askUser: AskUser,
): Promise<PermissionPromptResult> {
  const options = [
    "y = allow once",
    "s = allow for this session",
    "n = deny",
  ].join(", ");

  const answer = await askUser(`${decision.message}\n${options}\n> `);
  const normalized = answer.trim().toLowerCase();

  if (normalized === "y") {
    return { behavior: "allow", updates: [] };
  }

  if (normalized === "s") {
    return {
      behavior: "allow",
      updates: decision.suggestions ?? [],
    };
  }

  return {
    behavior: "deny",
    feedback: answer.trim() || undefined,
  };
}
```

如果后面做 UI，可以把不同工具拆成不同组件：

- Bash 展示命令。
- Edit 展示 diff。
- Write 展示目标路径和摘要。
- MCP 展示 server、tool 和 input preview。

但底层仍然只返回 `PermissionPromptResult`。

## 审计日志

审计记录不是调试日志。它应该回答：

- 哪个 session 里发生的？
- 哪个 tool 被请求？
- 输入摘要是什么？
- 最终是 allow、deny 还是 ask 后 allow？
- 决策来自规则、模式、用户还是工具安全检查？
- 是否产生了持久规则？
- 等了用户多久？

```ts
// src/permissions/permissionAudit.ts
import type {
  PermissionDecision,
  PermissionDecisionReason,
  PermissionUpdate,
} from "./permissionTypes";
import type { ToolDefinition, ToolInput } from "../tools/toolTypes";
import { recordTranscriptEvent } from "../transcript/store";

export type PermissionAuditEntry = {
  type: "permission_decision";
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  decision: "allow" | "deny";
  source: "rule" | "mode" | "tool" | "safety" | "user" | "other";
  reason?: string;
  updates?: PermissionUpdate[];
  waitMs?: number;
  createdAt: string;
};

export function buildPermissionAuditEntry(params: {
  sessionId: string;
  toolUseId: string;
  tool: ToolDefinition;
  input: ToolInput;
  decision: Extract<PermissionDecision, { behavior: "allow" | "deny" }>;
  updates?: PermissionUpdate[];
  waitMs?: number;
}): PermissionAuditEntry {
  return {
    type: "permission_decision",
    sessionId: params.sessionId,
    toolUseId: params.toolUseId,
    toolName: params.tool.name,
    input: redactInput(params.input),
    decision: params.decision.behavior,
    source: params.decision.reason?.type ?? "other",
    reason: reasonToString(params.decision.reason),
    updates: params.updates,
    waitMs: params.waitMs,
    createdAt: new Date().toISOString(),
  };
}

export function redactInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactInput);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactInput(nested);
    }
  }

  return output;
}

function isSensitiveKey(key: string): boolean {
  return /token|password|secret|api[_-]?key|authorization/i.test(key);
}

function reasonToString(reason: PermissionDecisionReason | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }

  switch (reason.type) {
    case "rule":
      return `${reason.rule.behavior}:${reason.rule.value.toolName}`;
    case "mode":
      return reason.mode;
    case "tool":
    case "safety":
    case "user":
    case "other":
      return reason.reason;
  }
}
```

写入复用第二十二章的 transcript event writer：

```ts
// src/permissions/permissionAudit.ts
export async function appendPermissionAudit(entry: PermissionAuditEntry): Promise<void> {
  await recordTranscriptEvent({
    event: "permission_decision",
    data: entry,
  });
}
```

如果你的 `TranscriptEntry` 事件类型还没有 `permission_decision`，在 `src/transcript/types.ts` 里把它加到 event union。不要在权限模块里重新实现一套 JSONL append。

## ToolRunner 接入

所有工具执行都必须从 `ToolRunner` 进入：

```ts
// src/tools/toolRunner.ts
import { checkToolPermission } from "../permissions/permissionEngine";
import { promptForPermission } from "../permissions/permissionPrompt";
import { buildPermissionAuditEntry, appendPermissionAudit } from "../permissions/permissionAudit";
import type { PermissionUpdate } from "../permissions/permissionTypes";

export async function runTool(params: RunToolParams): Promise<ToolResult> {
  const startedAt = Date.now();
  const initialDecision = await checkToolPermission({
    tool: params.tool,
    input: params.input,
    context: params.permissions.snapshot(),
  });

  let finalInput = params.input;
  let updates: PermissionUpdate[] = [];

  if (initialDecision.behavior === "deny") {
    await appendPermissionAudit(
      buildPermissionAuditEntry({
        sessionId: params.sessionId,
        toolUseId: params.toolUseId,
        tool: params.tool,
        input: params.input,
        decision: initialDecision,
      }),
    );

    return {
      ok: false,
      error: initialDecision.message,
    };
  }

  if (initialDecision.behavior === "ask") {
    const promptResult = await promptForPermission(initialDecision, params.askUser);

    if (promptResult.behavior === "deny") {
      const denied = {
        behavior: "deny" as const,
        message: promptResult.feedback ?? "User denied permission.",
        reason: { type: "user" as const, reason: promptResult.feedback },
      };

      await appendPermissionAudit(
        buildPermissionAuditEntry({
          sessionId: params.sessionId,
          toolUseId: params.toolUseId,
          tool: params.tool,
          input: params.input,
          decision: denied,
          waitMs: Date.now() - startedAt,
        }),
      );

      return { ok: false, error: denied.message };
    }

    updates = promptResult.updates;
    for (const update of updates) {
      params.permissions.applyUpdate(update);
    }
  }

  if (initialDecision.updatedInput) {
    finalInput = initialDecision.updatedInput;
  }

  const allowDecision = {
    behavior: "allow" as const,
    updatedInput: finalInput,
    reason: initialDecision.reason,
  };

  await appendPermissionAudit(
    buildPermissionAuditEntry({
      sessionId: params.sessionId,
      toolUseId: params.toolUseId,
      tool: params.tool,
      input: finalInput,
      decision: allowDecision,
      updates,
      waitMs: initialDecision.behavior === "ask" ? Date.now() - startedAt : undefined,
    }),
  );

  return params.tool.execute(finalInput);
}
```

这里有一个重要约束：审计写入失败不应该静默吞掉。最小实现可以让本次工具失败，因为权限审计是安全能力的一部分。后面可以做降级策略，但不要第一版就忽略。

## 拒绝追踪

如果模型连续请求同一个被拒绝的工具，用户体验会很差。加一个简单 tracker：

```ts
// src/permissions/denialTracker.ts
export type DenialTrackingState = {
  consecutiveDenials: number;
  totalDenials: number;
};

export function createDenialTrackingState(): DenialTrackingState {
  return {
    consecutiveDenials: 0,
    totalDenials: 0,
  };
}

export function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  };
}

export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  return {
    ...state,
    consecutiveDenials: 0,
  };
}

export function shouldStopForRepeatedDenials(state: DenialTrackingState): boolean {
  return state.consecutiveDenials >= 3 || state.totalDenials >= 20;
}
```

Agent Loop 里这样使用：

```ts
const result = await toolRunner.runTool(toolUse);

if (!result.ok && result.error.includes("permission")) {
  denialState = recordDenial(denialState);
} else {
  denialState = recordSuccess(denialState);
}

if (shouldStopForRepeatedDenials(denialState)) {
  return {
    type: "assistant",
    content: "I cannot continue because the requested tool permissions were denied repeatedly.",
  };
}
```

真实工程是为了避免自动判断循环和反复打扰用户。Mini 也应该有这个保护。

## `/permissions` 命令

加一个本地命令，方便调试和修改规则：

```text
/permissions
/permissions mode plan
/permissions mode default
/permissions allow Bash(git *)
/permissions ask Edit(src/**)
/permissions deny Bash(rm *)
/permissions allow mcp__filesystem__read_file
```

实现：

```ts
// src/commands/permissionsCommand.ts
import { parsePermissionRule } from "../permissions/permissionRuleParser";
import type { LocalCommand } from "./commandTypes";
import type { PermissionMode } from "../permissions/permissionTypes";

const MODES: PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
];

function isPermissionMode(value: string | undefined): value is PermissionMode {
  return !!value && MODES.includes(value as PermissionMode);
}

export const permissionsCommand: LocalCommand = {
  type: "local",
  name: "permissions",
  description: "View or update permission rules",
  source: "builtin",
  async run(args, context) {
    const parts = args.trim().split(/\s+/);
    const [action, first, ...rest] = parts;

    if (!action) {
      return {
        type: "text",
        text: formatPermissionContext(context.permissions.snapshot()),
      };
    }

    if (action === "mode") {
      if (!isPermissionMode(first)) {
        return {
          type: "text",
          text: `Unknown permission mode: ${first ?? ""}`,
        };
      }

      context.permissions.setMode(first);
      return { type: "text", text: `Permission mode: ${first}` };
    }

    if (action === "allow" || action === "ask" || action === "deny") {
      const rawRule = [first, ...rest].join(" ");
      context.permissions.addRules("session", action, [parsePermissionRule(rawRule)]);
      return { type: "text", text: `Added ${action} rule: ${rawRule}` };
    }

    return {
      type: "text",
      text: "Usage: /permissions [mode <mode>|allow <rule>|ask <rule>|deny <rule>]",
    };
  },
};
```

这里写入 `session`，不做持久化。等 Mini 有设置页后，再支持 `local`、`project` 和 `user`。

## 配置文件持久化

如果前面章节已经有 settings，可以加：

```json
{
  "permissions": {
    "allow": ["Bash(git *)", "Edit(src/**)"],
    "ask": ["Write(docs/**)"],
    "deny": ["Bash(rm *)"]
  }
}
```

加载时转成 `PermissionRule`：

```ts
export function loadPermissionRules(source: PermissionRuleSource, settings: Settings): PermissionRule[] {
  const permissions = settings.permissions ?? {};

  return [
    ...loadRules(source, "allow", permissions.allow ?? []),
    ...loadRules(source, "ask", permissions.ask ?? []),
    ...loadRules(source, "deny", permissions.deny ?? []),
  ];
}

function loadRules(
  source: PermissionRuleSource,
  behavior: PermissionBehavior,
  rawRules: string[],
): PermissionRule[] {
  return rawRules.map((raw) => ({
    source,
    behavior,
    value: parsePermissionRule(raw),
  }));
}
```

配置来源优先级建议：

```text
user < project < local < command < session
```

但 deny 规则仍然优先于 allow。也就是说，来源顺序只能解决同类规则的展示和管理，不能让低风险规则覆盖高风险 deny。

## 测试

建议新增这些测试：

```ts
// src/permissions/__tests__/permissionRuleParser.test.ts
describe("parsePermissionRule", () => {
  test("parses tool-wide rule", () => {});
  test("parses content rule", () => {});
  test("keeps escaped parentheses in content", () => {});
});

// src/permissions/__tests__/permissionRules.test.ts
describe("toolMatchesRule", () => {
  test("matches direct tool names", async () => {});
  test("matches bash command patterns", async () => {});
  test("matches file path patterns", async () => {});
  test("matches mcp server wildcard", async () => {});
});

// src/permissions/__tests__/permissionEngine.test.ts
describe("checkToolPermission", () => {
  test("deny rule wins over allow rule", async () => {});
  test("allow rule approves tool call", async () => {});
  test("plan mode denies write tools", async () => {});
  test("safety ask is not bypassed", async () => {});
  test("default passthrough becomes ask", async () => {});
});

// src/permissions/__tests__/permissionAudit.test.ts
describe("permission audit", () => {
  test("redacts sensitive input keys", () => {});
  test("records decision source and wait time", () => {});
});
```

对应命令：

```bash
bun test src/permissions/__tests__/permissionRuleParser.test.ts
bun test src/permissions/__tests__/permissionRules.test.ts
bun test src/permissions/__tests__/permissionEngine.test.ts
bun test src/permissions/__tests__/permissionAudit.test.ts
bun run typecheck
```

## 常见问题

### 为什么 deny 要优先于 allow？

deny 是安全边界，allow 是便利规则。便利规则不能覆盖安全边界，否则项目配置里的 deny 会被会话里的一次 allow 绕开。

### 为什么 MCP 的 `readOnlyHint` 不自动放行？

因为它是外部 server 自己声明的提示，不是 Mini 验证过的事实。第一版可以用它做展示和并发优化，但不要把它当权限依据。

### 为什么要有 `passthrough`？

工具自己的权限检查只知道局部风险，例如 Bash 知道命令内容，Edit 知道路径。全局规则、mode、session allow 应该由统一引擎处理。`passthrough` 就是把局部检查结果交回统一引擎。

### 为什么审计日志要脱敏？

工具 input 里可能包含 token、authorization header、配置内容或命令参数。审计要能复盘权限决策，但不能变成秘密泄漏的新来源。

### 为什么命令级 allowedTools 不能持久化？

命令级授权只服务于这一次命令意图。例如一个 `/review` 命令可以临时允许读文件和运行 `git diff`，但它不应该让后续所有对话都获得这些能力。

### 为什么安全 ask 不能被 bypass mode 绕过？

`bypassPermissions` 适合受控环境或自动化环境，但它不应该绕过所有安全检查。敏感路径、外部工作区、明确 deny 规则这类边界仍然要保留。

## 本章完成标准

完成后应满足：

- Mini 有统一的 `PermissionDecision` 类型。
- Tool 接口支持 `checkPermissions`、`preparePermissionMatcher`、`getPath` 和 `mcpInfo`。
- 权限规则能解析 `Tool` 和 `Tool(content)`。
- Bash 规则可以匹配命令 pattern。
- 文件工具规则可以匹配路径 pattern。
- MCP 工具使用 `mcp__server__tool` 权限名。
- `mcp__server__*` 可以匹配某个 server 的所有工具。
- deny 规则优先于 allow。
- `plan` mode 阻止写入类工具。
- `dontAsk` mode 不会弹出权限提示。
- `bypassPermissions` 不能绕过 deny 和安全 ask。
- 审批 UI 支持允许一次、本会话允许、拒绝。
- 审批产生的 session 规则能立即生效。
- 权限决策写入 transcript 或审计 JSONL。
- 审计输入会脱敏。
- 连续拒绝会停止重复请求。
- `/permissions` 能查看和添加 session 规则。
- `bun run typecheck` 通过。

第二十七章到这里，Mini 的工具系统有了真正的安全边界。下一章可以继续做更深一层的执行隔离：把 Shell、文件写入和 MCP 调用放到可控的 sandbox 或受限运行环境里，而不是只依赖审批。
