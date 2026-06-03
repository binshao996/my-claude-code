# 第 31 章：Agent 配置文件与项目级 Agent

第三十章已经实现了基础多 Agent：主 Agent 可以用 `Agent` 工具启动子 Agent，也可以把子 Agent 放到后台 task 里运行。

但上一章的 Agent 还都是写死在代码里的：

```ts
GENERAL_PURPOSE_AGENT
EXPLORER_AGENT
REVIEWER_AGENT
```

这对框架开发阶段够用，但对真实项目不够。

不同仓库会有不同规则：

- 哪些目录是业务代码。
- 哪些文件不能改。
- 测试应该怎么跑。
- 代码评审重点是什么。
- 迁移、国际化、埋点、权限、接口层分别有什么约定。

这些信息不应该全部写进 Mini 源码。更合理的方式是让项目自己提供 Agent：

```text
.mini/agents/
  frontend-reviewer.md
  api-investigator.md
  test-runner.md
```

每个文件用 frontmatter 描述元信息，用正文写这个 Agent 的 system prompt。

本章就实现这套项目级 Agent 配置。

## 真实工程怎么做

真实工程的 Agent 配置加载主要在这些模块里：

- `packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts`：加载、解析、合并 Agent 定义。
- `src/utils/markdownConfigLoader.ts`：从 managed、user、project 目录扫描 `agents` markdown 文件，解析 frontmatter 和正文。
- `src/utils/frontmatterParser.ts`：解析 `---` 包裹的 YAML frontmatter，并对特殊字符做容错。
- `packages/builtin-tools/src/tools/AgentTool/agentDisplay.ts`：给 CLI 和交互式 `/agents` 命令显示 Agent 来源、覆盖关系和模型。
- `src/cli/handlers/agents.ts`：`agents` 子命令，列出已配置 Agent。
- `src/main.tsx`：启动时并行加载 command 和 agent，支持 `--agents <json>` 注入临时 Agent，也支持 `--agent` 选择主线程 Agent。

真实工程里 Agent 来源不止一种：

- built-in：内置 Agent。
- userSettings：用户级 Agent。
- projectSettings：项目级 Agent。
- plugin：插件提供的 Agent。
- flagSettings：命令行传入的 Agent。
- policySettings：策略或托管配置提供的 Agent。

同名 Agent 会按优先级覆盖。真实工程的 active 选择顺序可以理解为：

```text
built-in < plugin < user < project < cli flag < managed policy
```

后面的来源覆盖前面的来源。比如项目里定义了 `reviewer`，它就可以覆盖内置或用户级 `reviewer`。

Mini 先实现三种来源：

```text
built-in < user < project
```

这已经足够覆盖日常使用：框架内置默认 Agent，用户可以写全局习惯，项目可以写仓库专属规则。

## 本章目标

完成后，Mini 支持：

```text
.mini/agents/reviewer.md
```

文件内容：

```markdown
---
name: reviewer
description: 评审当前代码改动，找出 bug、回归风险和缺失测试
tools:
  - read_file
  - grep
  - bash
disallowedTools:
  - write_file
  - edit_file
model: smart
permissionMode: readOnly
maxTurns: 10
background: false
---

你是当前仓库的代码评审 Agent。

评审时优先关注：

1. 行为回归。
2. 错误处理。
3. 类型安全。
4. 缺失测试。

不要提出纯风格建议。
输出必须包含文件路径、问题原因和建议修复方向。
```

主 Agent 可以继续调用：

```json
{
  "description": "评审当前改动",
  "subagent_type": "reviewer",
  "prompt": "评审当前工作区改动。只读，不要修改文件。"
}
```

Mini 会加载项目里的 `reviewer.md`，用它覆盖内置 `reviewer`。

本章要实现：

- `.mini/agents/*.md` 扫描。
- `~/.mini/agents/*.md` 用户级 Agent。
- frontmatter 解析。
- Agent schema 校验。
- markdown 正文作为 system prompt。
- Agent 来源和覆盖优先级。
- 解析失败记录，不影响内置 Agent。
- Agent 定义缓存和清理。
- `/agents` 命令查看可用 Agent 与覆盖关系。
- 把动态 Agent 接入第三十章的 `Agent` 工具。

## 推荐目录

新增：

```text
src/agents/
  agentConfigTypes.ts
  frontmatter.ts
  markdownAgentLoader.ts
  agentDefinitionLoader.ts
  agentDisplay.ts

src/commands/
  agentsCommand.ts
```

修改：

```text
src/agents/agentTypes.ts
src/agents/agentRegistry.ts
src/tools/toolRegistry.ts
src/cli.ts
```

如果你的 Mini 还没有 YAML 解析依赖，先加：

```bash
bun add yaml
```

只解析 JSON 风格的 frontmatter 也能做，但 YAML 对用户写配置更友好。

## Agent 文件格式

先确定 Mini 支持的 frontmatter 字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | Agent 类型名，主 Agent 调用时传给 `subagent_type` |
| `description` | 是 | 什么时候使用这个 Agent |
| `tools` | 否 | 工具白名单，省略表示全部工具 |
| `disallowedTools` | 否 | 工具黑名单，在白名单之后继续排除 |
| `model` | 否 | `default`、`fast`、`smart` 或 `inherit` |
| `permissionMode` | 否 | `ask`、`readOnly`、`acceptEdits` |
| `maxTurns` | 否 | 子 Agent 最大循环轮数 |
| `background` | 否 | 是否默认后台运行 |

正文就是 system prompt：

```markdown
---
name: explorer
description: 定位代码入口，只读检索，不修改文件
tools: [read_file, glob, grep, bash]
permissionMode: readOnly
maxTurns: 8
---

你是只读代码探索 Agent。
你的职责是查找文件、阅读代码、解释路径。
不要修改任何文件。
```

推荐规则：

- `name` 必须显式写，不用文件名兜底。
- `description` 必须短而具体。
- `tools` 推荐写 YAML 数组。
- system prompt 写行为边界，不写太多项目背景。
- 项目背景放到项目级 Agent 文件里，而不是写进 Mini 内置 Agent。

## 扩展 Agent 类型

第三十章已经有 `AgentDefinition`。现在补充文件来源信息。

```ts
// src/agents/agentTypes.ts
export type AgentSource = "built-in" | "user" | "project";

export type AgentModel = "default" | "fast" | "smart" | "inherit";

export type PermissionMode = "ask" | "readOnly" | "acceptEdits";

export type AgentDefinition = {
  agentType: string;
  whenToUse: string;
  source: AgentSource;
  tools?: string[];
  disallowedTools?: string[];
  model?: AgentModel;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  background?: boolean;
  filename?: string;
  baseDir?: string;
  getSystemPrompt: () => string;
};

export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[];
  allAgents: AgentDefinition[];
  failedFiles: Array<{
    path: string;
    error: string;
  }>;
};
```

`activeAgents` 是最终生效的 Agent。

`allAgents` 包含被覆盖的 Agent，用于 `/agents` 显示。

`failedFiles` 记录解析失败的文件，避免用户写错配置时完全不知道发生了什么。

## Frontmatter 解析

实现一个小解析器。

```ts
// src/agents/frontmatter.ts
import YAML from "yaml";

export type ParsedMarkdown = {
  frontmatter: Record<string, unknown>;
  content: string;
};

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMarkdownWithFrontmatter(
  raw: string,
  filePath: string,
): ParsedMarkdown {
  const match = raw.match(FRONTMATTER_REGEX);

  if (!match) {
    return {
      frontmatter: {},
      content: raw,
    };
  }

  const frontmatterText = match[1] ?? "";
  const content = raw.slice(match[0].length);

  try {
    const parsed = YAML.parse(frontmatterText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        frontmatter: parsed as Record<string, unknown>,
        content,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frontmatter in ${filePath}: ${message}`);
  }

  return {
    frontmatter: {},
    content,
  };
}
```

真实工程会对特殊 YAML 字符做容错，比如 glob 里常见的 `{ts,tsx}`。Mini 第一版可以要求用户把复杂值写成 YAML 数组或加引号。

推荐写法：

```yaml
tools:
  - read_file
  - grep
```

不推荐写法：

```yaml
tools: read_file, grep, src/*.{ts,tsx}
```

## 字段解析工具

frontmatter 是用户输入，不能直接强转。

```ts
// src/agents/agentConfigTypes.ts
import type { AgentModel, PermissionMode } from "./agentTypes";

const VALID_MODELS = new Set(["default", "fast", "smart", "inherit"]);
const VALID_PERMISSION_MODES = new Set(["ask", "readOnly", "acceptEdits"]);

export function parseRequiredString(
  value: unknown,
  fieldName: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required "${fieldName}" field`);
  }

  return value.trim();
}

export function parseStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    return trimmed.split(",").map(item => item.trim()).filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map(item => item.trim())
      .filter(Boolean);
  }

  throw new Error("Expected a string or string list");
}

export function parseModel(value: unknown): AgentModel | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("model must be a string");
  }

  const normalized = value.trim();
  if (!VALID_MODELS.has(normalized)) {
    throw new Error(`Invalid model: ${value}`);
  }

  return normalized as AgentModel;
}

export function parsePermissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("permissionMode must be a string");
  }

  const normalized = value.trim();
  if (!VALID_PERMISSION_MODES.has(normalized)) {
    throw new Error(`Invalid permissionMode: ${value}`);
  }

  return normalized as PermissionMode;
}

export function parsePositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got: ${String(value)}`);
  }

  return parsed;
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === true || value === "true") {
    return true;
  }

  if (value === false || value === "false") {
    return false;
  }

  throw new Error(`Expected boolean, got: ${String(value)}`);
}
```

这里要保留一个语义：

```text
tools 省略：默认全部工具。
tools 为空数组：没有工具。
```

这和真实工程一致。省略不是空，空也不是省略。

## Agent 名称校验

`name` 会被模型作为 `subagent_type` 使用，也会出现在日志和配置覆盖里。不要允许随意字符串。

```ts
// src/agents/agentConfigTypes.ts
const AGENT_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function parseAgentName(value: unknown): string {
  const name = parseRequiredString(value, "name");

  if (!AGENT_NAME_REGEX.test(name)) {
    throw new Error(
      "Agent name must start with a letter and contain only letters, numbers, _ or -",
    );
  }

  return name;
}
```

不要允许路径分隔符、空白、冒号或奇怪控制字符。后面做 transcript、output file、缓存目录时会轻松很多。

## 解析单个 Agent 文件

现在把 markdown 文件转成 `AgentDefinition`。

```ts
// src/agents/markdownAgentLoader.ts
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import type { AgentDefinition, AgentSource } from "./agentTypes";
import { parseMarkdownWithFrontmatter } from "./frontmatter";
import {
  parseAgentName,
  parseBoolean,
  parseModel,
  parsePermissionMode,
  parsePositiveInteger,
  parseRequiredString,
  parseStringList,
} from "./agentConfigTypes";

export async function parseAgentFile(input: {
  filePath: string;
  baseDir: string;
  source: AgentSource;
}): Promise<AgentDefinition | null> {
  const raw = await readFile(input.filePath, "utf8");
  const { frontmatter, content } = parseMarkdownWithFrontmatter(raw, input.filePath);

  if (!frontmatter.name) {
    return null;
  }

  const agentType = parseAgentName(frontmatter.name);
  const whenToUse = parseRequiredString(frontmatter.description, "description");
  const systemPrompt = content.trim();

  if (!systemPrompt) {
    throw new Error(`Agent ${agentType} has empty prompt body`);
  }

  return {
    agentType,
    whenToUse,
    source: input.source,
    filename: basename(input.filePath, ".md"),
    baseDir: input.baseDir,
    tools: parseStringList(frontmatter.tools),
    disallowedTools: parseStringList(frontmatter.disallowedTools),
    model: parseModel(frontmatter.model),
    permissionMode: parsePermissionMode(frontmatter.permissionMode),
    maxTurns: parsePositiveInteger(frontmatter.maxTurns),
    background: parseBoolean(frontmatter.background),
    getSystemPrompt: () => systemPrompt,
  };
}
```

这里选择 `frontmatter.name` 缺失时返回 `null`，表示这个 markdown 文件不是 Agent 文件。这样项目可以在 `.mini/agents/` 里放一些说明文档，不会直接报错。

但如果有 `name` 却缺 `description` 或正文为空，就应该记为失败文件。

## 扫描 Markdown 文件

Mini 先用 Node 文件系统递归扫描，不依赖外部命令。

```ts
// src/agents/markdownAgentLoader.ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  await walk(dir);
  return files.sort();
}

export async function loadMarkdownAgentsFromDir(input: {
  dir: string;
  source: AgentSource;
}): Promise<{
  agents: AgentDefinition[];
  failedFiles: Array<{ path: string; error: string }>;
}> {
  const filePaths = await findMarkdownFiles(input.dir);
  const agents: AgentDefinition[] = [];
  const failedFiles: Array<{ path: string; error: string }> = [];

  for (const filePath of filePaths) {
    try {
      const agent = await parseAgentFile({
        filePath,
        baseDir: input.dir,
        source: input.source,
      });

      if (agent) {
        agents.push(agent);
      }
    } catch (error) {
      failedFiles.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { agents, failedFiles };
}
```

真实工程默认会优先用快速文件搜索，再 fallback 到原生文件系统。Mini 这里直接用原生文件系统，足够清晰。

## 搜索目录

定义用户级和项目级目录。

```ts
// src/agents/agentDefinitionLoader.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getMiniHomeDir(): string {
  return process.env.MINI_HOME ?? join(homedir(), ".mini");
}

export function getUserAgentsDir(): string {
  return join(getMiniHomeDir(), "agents");
}

export function getProjectAgentsDir(cwd: string): string {
  return join(resolve(cwd), ".mini", "agents");
}
```

真实工程会从当前目录一路向上找到 git root，把沿途 `.claude/agents` 都纳入扫描。Mini 先只读取当前项目根目录：

```text
<project>/.mini/agents
```

后续如果你支持 monorepo，可以再扩展成向上查找。

## 合并优先级

同名 Agent 只能有一个 active 版本。定义合并函数：

```ts
// src/agents/agentDefinitionLoader.ts
import { BUILT_IN_AGENTS } from "./builtInAgents";
import type { AgentDefinition, AgentDefinitionsResult } from "./agentTypes";
import { loadMarkdownAgentsFromDir } from "./markdownAgentLoader";

export function getActiveAgentsFromList(
  allAgents: AgentDefinition[],
): AgentDefinition[] {
  const groups = [
    allAgents.filter(agent => agent.source === "built-in"),
    allAgents.filter(agent => agent.source === "user"),
    allAgents.filter(agent => agent.source === "project"),
  ];

  const map = new Map<string, AgentDefinition>();

  for (const group of groups) {
    for (const agent of group) {
      map.set(agent.agentType, agent);
    }
  }

  return [...map.values()].sort((a, b) => {
    return a.agentType.localeCompare(b.agentType);
  });
}

export async function loadAgentDefinitions(input: {
  cwd: string;
}): Promise<AgentDefinitionsResult> {
  const [userResult, projectResult] = await Promise.all([
    loadMarkdownAgentsFromDir({
      dir: getUserAgentsDir(),
      source: "user",
    }),
    loadMarkdownAgentsFromDir({
      dir: getProjectAgentsDir(input.cwd),
      source: "project",
    }),
  ]);

  const allAgents = [
    ...BUILT_IN_AGENTS,
    ...userResult.agents,
    ...projectResult.agents,
  ];

  return {
    allAgents,
    activeAgents: getActiveAgentsFromList(allAgents),
    failedFiles: [...userResult.failedFiles, ...projectResult.failedFiles],
  };
}
```

这里的顺序是刻意的：

```text
built-in 先进入 map
user 覆盖 built-in
project 覆盖 user
```

项目规则通常比个人规则更具体，所以项目优先级更高。

## 加缓存

Agent 文件不需要每次工具调用都重新扫描。启动时加载一次，必要时手动清理缓存。

```ts
// src/agents/agentDefinitionLoader.ts
let cached:
  | {
      cwd: string;
      result: AgentDefinitionsResult;
    }
  | undefined;

export async function getAgentDefinitions(input: {
  cwd: string;
  forceReload?: boolean;
}): Promise<AgentDefinitionsResult> {
  if (!input.forceReload && cached?.cwd === input.cwd) {
    return cached.result;
  }

  const result = await loadAgentDefinitions({ cwd: input.cwd });
  cached = {
    cwd: input.cwd,
    result,
  };
  return result;
}

export function clearAgentDefinitionsCache(): void {
  cached = undefined;
}
```

后面如果做 `/reload`，只要调用：

```ts
clearAgentDefinitionsCache();
```

下一次读取就会重新扫描。

## 接入 Agent Registry

第三十章的 `createAgentRegistry()` 可以改成直接接收 active agents。

```ts
// src/agents/agentRegistry.ts
import type { AgentDefinition } from "./agentTypes";

export type AgentRegistry = {
  activeAgents: AgentDefinition[];
  getAgent(type: string | undefined): AgentDefinition;
};

export function createAgentRegistry(activeAgents: AgentDefinition[]): AgentRegistry {
  const map = new Map<string, AgentDefinition>();

  for (const agent of activeAgents) {
    map.set(agent.agentType, agent);
  }

  return {
    activeAgents,
    getAgent(type) {
      const effectiveType = type ?? "general-purpose";
      const agent = map.get(effectiveType);

      if (!agent) {
        const available = activeAgents.map(item => item.agentType).join(", ");
        throw new Error(`Unknown agent type: ${effectiveType}. Available agents: ${available}`);
      }

      return agent;
    },
  };
}
```

然后工具注册时加载动态 Agent：

```ts
// src/tools/toolRegistry.ts
import { getAgentDefinitions } from "../agents/agentDefinitionLoader";
import { createAgentRegistry } from "../agents/agentRegistry";
import { createAgentTool } from "./agentTool";

export async function createToolRegistry(input: {
  cwd: string;
  parentSessionId: string;
}) {
  const baseTools = [
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
    createTaskOutputTool(),
    createTaskStopTool(),
  ];

  const agentDefinitions = await getAgentDefinitions({ cwd: input.cwd });
  const agentRegistry = createAgentRegistry(agentDefinitions.activeAgents);

  const agentTool = createAgentTool({
    registry: agentRegistry,
    availableTools: baseTools,
    parentSessionId: input.parentSessionId,
  });

  return {
    tools: [...baseTools, agentTool],
    agentDefinitions,
  };
}
```

返回 `agentDefinitions` 的原因是 CLI 和 `/agents` 命令也要展示这些信息。

## CLI 启动接入

如果你的 `cli.ts` 已经创建 tool registry，现在改成异步读取。

```ts
// src/cli.ts
import { randomUUID } from "node:crypto";
import { createToolRegistry } from "./tools/toolRegistry";
import { startChatLoop } from "./chat/agentLoop";

export async function main(): Promise<void> {
  const cwd = process.cwd();
  const sessionId = randomUUID();

  const { tools, agentDefinitions } = await createToolRegistry({
    cwd,
    parentSessionId: sessionId,
  });

  for (const failed of agentDefinitions.failedFiles) {
    console.warn(`[agent config] ${failed.path}: ${failed.error}`);
  }

  await startChatLoop({
    cwd,
    sessionId,
    tools,
    agentDefinitions,
  });
}
```

配置错误不要阻止 Mini 启动。只要内置 Agent 还能用，系统就应该能跑起来。

## `/agents` 命令

给用户一个查看 Agent 的入口。

先计算覆盖关系：

```ts
// src/agents/agentDisplay.ts
import type { AgentDefinition } from "./agentTypes";

export type DisplayAgent = AgentDefinition & {
  overriddenBy?: AgentDefinition["source"];
};

export function resolveAgentOverrides(input: {
  allAgents: AgentDefinition[];
  activeAgents: AgentDefinition[];
}): DisplayAgent[] {
  const activeByName = new Map<string, AgentDefinition>();

  for (const agent of input.activeAgents) {
    activeByName.set(agent.agentType, agent);
  }

  return input.allAgents.map(agent => {
    const active = activeByName.get(agent.agentType);
    const overriddenBy =
      active && active.source !== agent.source ? active.source : undefined;

    return {
      ...agent,
      overriddenBy,
    };
  });
}

export function sourceLabel(source: AgentDefinition["source"]): string {
  if (source === "built-in") {
    return "Built-in";
  }
  if (source === "user") {
    return "User";
  }
  return "Project";
}
```

实现命令：

```ts
// src/commands/agentsCommand.ts
import type { AgentDefinitionsResult } from "../agents/agentTypes";
import { resolveAgentOverrides, sourceLabel } from "../agents/agentDisplay";

const SOURCE_ORDER = ["project", "user", "built-in"] as const;

export function renderAgentsCommand(result: AgentDefinitionsResult): string {
  const displayAgents = resolveAgentOverrides({
    allAgents: result.allAgents,
    activeAgents: result.activeAgents,
  });

  const lines: string[] = [];
  lines.push(`${result.activeAgents.length} active agents`);
  lines.push("");

  for (const source of SOURCE_ORDER) {
    const group = displayAgents
      .filter(agent => agent.source === source)
      .sort((a, b) => a.agentType.localeCompare(b.agentType));

    if (group.length === 0) {
      continue;
    }

    lines.push(`${sourceLabel(source)} agents:`);

    for (const agent of group) {
      const parts = [agent.agentType];
      if (agent.model) {
        parts.push(agent.model);
      }
      if (agent.permissionMode) {
        parts.push(agent.permissionMode);
      }

      const prefix = agent.overriddenBy
        ? `  (shadowed by ${sourceLabel(agent.overriddenBy)})`
        : "  ";

      lines.push(`${prefix}${parts.join(" · ")}`);
    }

    lines.push("");
  }

  if (result.failedFiles.length > 0) {
    lines.push("Failed agent files:");
    for (const failed of result.failedFiles) {
      lines.push(`  ${failed.path}: ${failed.error}`);
    }
  }

  return lines.join("\n").trimEnd();
}
```

接到 CLI：

```ts
// src/cli.ts
import { getAgentDefinitions } from "./agents/agentDefinitionLoader";
import { renderAgentsCommand } from "./commands/agentsCommand";

if (process.argv[2] === "agents") {
  const result = await getAgentDefinitions({
    cwd: process.cwd(),
    forceReload: true,
  });

  console.log(renderAgentsCommand(result));
  return;
}
```

现在可以运行：

```bash
bun run src/cli.ts agents
```

示例输出：

```text
4 active agents

Project agents:
  reviewer · smart · readOnly

Built-in agents:
  explorer · fast · readOnly
  general-purpose · default
  (shadowed by Project)reviewer · smart · readOnly
```

你可以把格式做得更好看，但信息要完整：

- 有多少 active Agent。
- 每个 Agent 来自哪里。
- 同名 Agent 谁覆盖了谁。
- 失败文件有哪些。

## 创建项目 Agent

在 Mini 项目根目录创建：

```bash
mkdir -p .mini/agents
```

新增：

```text
.mini/agents/frontend-reviewer.md
```

内容：

```markdown
---
name: frontend-reviewer
description: 评审前端代码改动，重点关注状态流、组件边界、可访问性和测试缺口
tools:
  - read_file
  - glob
  - grep
  - bash
disallowedTools:
  - write_file
  - edit_file
model: smart
permissionMode: readOnly
maxTurns: 12
---

你是前端代码评审 Agent。

评审顺序：

1. 先理解改动范围。
2. 查找相关组件、hook、状态管理和测试。
3. 只指出会造成真实问题的风险。
4. 不要输出纯格式建议。

输出格式：

- 文件路径。
- 问题。
- 为什么这是问题。
- 建议修复方向。
```

然后运行：

```bash
bun run src/cli.ts agents
```

应能看到 `frontend-reviewer` 出现在 Project agents 中。

## 用项目 Agent

主 Agent 可以这样派发：

```json
{
  "description": "评审前端改动",
  "subagent_type": "frontend-reviewer",
  "prompt": "评审当前工作区前端相关改动。只读，不要修改文件。重点关注真实 bug、状态流和测试缺口。"
}
```

`Agent` 工具会：

1. 从 registry 找到 `frontend-reviewer`。
2. 根据它的 `tools` 和 `disallowedTools` 解析工具池。
3. 使用 markdown 正文作为 system prompt。
4. 使用它的 `model`、`permissionMode`、`maxTurns`。
5. 运行子 Agent 并返回结果。

这就是项目级 Agent 的核心价值：主 Agent 不需要记住每个仓库规则，仓库自己把专属角色定义好。

## 支持用户级 Agent

用户级目录：

```text
~/.mini/agents
```

适合放个人通用偏好，例如：

```text
~/.mini/agents/personal-reviewer.md
```

用户级 Agent 适合写：

- 你喜欢的代码评审格式。
- 常用调查 Agent。
- 常用测试 runner。
- 通用迁移 Agent。

项目级 Agent 适合写：

- 当前仓库的目录结构。
- 当前仓库的测试命令。
- 当前仓库的业务约束。
- 当前仓库的代码风格。

如果同名，项目级覆盖用户级。

## 主线程 Agent

真实工程除了“子 Agent”，还支持用某个 Agent 定义作为主线程 system prompt。Mini 可以先做一个简单参数：

```bash
bun run src/cli.ts --agent frontend-reviewer
```

解析：

```ts
// src/cli.ts
function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const selectedAgentType = readOption("--agent");
```

加载后选择：

```ts
const selectedAgent = selectedAgentType
  ? agentDefinitions.activeAgents.find(agent => agent.agentType === selectedAgentType)
  : undefined;

if (selectedAgentType && !selectedAgent) {
  const available = agentDefinitions.activeAgents.map(agent => agent.agentType).join(", ");
  throw new Error(`Unknown agent: ${selectedAgentType}. Available agents: ${available}`);
}
```

传给主循环：

```ts
await startChatLoop({
  cwd,
  sessionId,
  tools,
  agentDefinitions,
  mainAgent: selectedAgent,
});
```

构建主 system prompt 时：

```ts
const systemPrompt = input.mainAgent
  ? input.mainAgent.getSystemPrompt()
  : buildDefaultSystemPrompt();
```

这个能力很实用，但不要和 `Agent` 工具混淆：

- `--agent` 是主线程身份。
- `subagent_type` 是子 Agent 身份。

## 临时 Agent JSON

真实工程支持 `--agents <json>`。Mini 可以加一个简化版，用于测试或 CI。

```ts
// src/agents/agentDefinitionLoader.ts
export type CliAgentJson = Record<string, {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: AgentModel;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  background?: boolean;
}>;

export function parseAgentsFromJson(json: CliAgentJson): AgentDefinition[] {
  return Object.entries(json).map(([name, definition]) => ({
    agentType: name,
    whenToUse: definition.description,
    source: "project",
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    model: definition.model,
    permissionMode: definition.permissionMode,
    maxTurns: definition.maxTurns,
    background: definition.background,
    getSystemPrompt: () => definition.prompt,
  }));
}
```

Mini 第一版也可以先不开放这个入口。项目 Agent 文件已经能解决大多数需求。

## 安全边界

项目级 Agent 是提示词配置，不是代码执行配置。但它会影响模型如何使用工具，所以仍然要谨慎。

本章 Mini 不支持：

- hooks。
- inline MCP server。
- 自动执行初始化脚本。
- 从 Agent 文件里配置任意命令。

只支持：

- system prompt。
- 工具白名单和黑名单。
- 模型偏好。
- 权限模式。
- 最大轮数。
- 是否默认后台运行。

如果你的 Mini 已经有 trust dialog，建议在用户信任项目目录之后再加载项目 Agent。否则一个陌生仓库可以通过 `.mini/agents/*.md` 改写主 Agent 行为。

## 测试 Frontmatter

先测 parser。

```ts
// src/agents/__tests__/frontmatter.test.ts
import { describe, expect, test } from "bun:test";
import { parseMarkdownWithFrontmatter } from "../frontmatter";

describe("parseMarkdownWithFrontmatter", () => {
  test("parses yaml frontmatter and content", () => {
    const result = parseMarkdownWithFrontmatter(
      [
        "---",
        "name: reviewer",
        "description: Reviews code",
        "tools:",
        "  - read_file",
        "---",
        "You are a reviewer.",
      ].join("\n"),
      "reviewer.md",
    );

    expect(result.frontmatter.name).toBe("reviewer");
    expect(result.frontmatter.tools).toEqual(["read_file"]);
    expect(result.content.trim()).toBe("You are a reviewer.");
  });

  test("returns empty frontmatter when absent", () => {
    const result = parseMarkdownWithFrontmatter("hello", "x.md");
    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe("hello");
  });
});
```

## 测试 Agent 文件解析

```ts
// src/agents/__tests__/markdownAgentLoader.test.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { parseAgentFile } from "../markdownAgentLoader";

describe("parseAgentFile", () => {
  test("parses project agent markdown", async () => {
    const dir = join(tmpdir(), `mini-agent-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, "reviewer.md");
    await writeFile(
      filePath,
      [
        "---",
        "name: reviewer",
        "description: Reviews code",
        "tools:",
        "  - read_file",
        "permissionMode: readOnly",
        "maxTurns: 10",
        "---",
        "You are a reviewer.",
      ].join("\n"),
    );

    const agent = await parseAgentFile({
      filePath,
      baseDir: dir,
      source: "project",
    });

    expect(agent?.agentType).toBe("reviewer");
    expect(agent?.whenToUse).toBe("Reviews code");
    expect(agent?.tools).toEqual(["read_file"]);
    expect(agent?.permissionMode).toBe("readOnly");
    expect(agent?.maxTurns).toBe(10);
    expect(agent?.getSystemPrompt()).toBe("You are a reviewer.");
  });

  test("skips markdown without name", async () => {
    const dir = join(tmpdir(), `mini-agent-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, "notes.md");
    await writeFile(filePath, "just notes");

    const agent = await parseAgentFile({
      filePath,
      baseDir: dir,
      source: "project",
    });

    expect(agent).toBeNull();
  });
});
```

## 测试优先级

```ts
// src/agents/__tests__/agentDefinitionLoader.test.ts
import { describe, expect, test } from "bun:test";
import { getActiveAgentsFromList } from "../agentDefinitionLoader";
import type { AgentDefinition } from "../agentTypes";

function agent(agentType: string, source: AgentDefinition["source"]): AgentDefinition {
  return {
    agentType,
    source,
    whenToUse: `${source} ${agentType}`,
    getSystemPrompt: () => `${source} prompt`,
  };
}

describe("getActiveAgentsFromList", () => {
  test("project overrides user and built-in agents", () => {
    const active = getActiveAgentsFromList([
      agent("reviewer", "built-in"),
      agent("reviewer", "user"),
      agent("reviewer", "project"),
    ]);

    expect(active).toHaveLength(1);
    expect(active[0]?.source).toBe("project");
  });

  test("keeps distinct agent types", () => {
    const active = getActiveAgentsFromList([
      agent("explorer", "built-in"),
      agent("reviewer", "project"),
    ]);

    expect(active.map(item => item.agentType)).toEqual(["explorer", "reviewer"]);
  });
});
```

运行：

```bash
bun test src/agents/__tests__/frontmatter.test.ts
bun test src/agents/__tests__/markdownAgentLoader.test.ts
bun test src/agents/__tests__/agentDefinitionLoader.test.ts
bun run typecheck
```

## 验收清单

本章完成后，手动检查：

- `.mini/agents/*.md` 能被扫描。
- `~/.mini/agents/*.md` 能被扫描。
- 缺少 `name` 的 markdown 文件会被跳过。
- 有 `name` 但缺少 `description` 的文件会进入 `failedFiles`。
- markdown 正文会成为 Agent system prompt。
- `tools` 省略表示全部工具。
- `tools: []` 表示没有工具。
- `disallowedTools` 会继续排除工具。
- 项目级 Agent 覆盖用户级和内置 Agent。
- `/agents` 能显示 active Agent。
- `/agents` 能显示被覆盖的 Agent。
- `Agent` 工具可以启动项目级 Agent。
- `--agent <name>` 可以把某个 Agent 作为主线程身份。
- `bun run typecheck` 通过。

## 常见坑

### 1. 用文件名当 Agent 类型

文件名可以作为显示信息，但不要当成最终 `agentType`。`name` 必须显式写在 frontmatter 里，覆盖关系才清晰。

### 2. 配置错误导致系统无法启动

项目 Agent 写错时，不应该让整个 CLI 崩掉。记录到 `failedFiles`，继续使用内置 Agent。

### 3. `tools` 省略和空数组混淆

省略表示全部工具。空数组表示没有工具。这个语义在配置系统里要保持稳定。

### 4. 项目 Agent 偷偷覆盖用户 Agent

这是预期行为，但必须能通过 `/agents` 看出来。否则用户很难解释为什么某个 Agent 行为变了。

### 5. 过早支持 hooks 和脚本

Agent 文件第一版只做 prompt 和工具限制。hooks、脚本、动态 MCP 都会扩大安全面，等 trust 体系更完整再做。

### 6. system prompt 写成项目文档

Agent prompt 应该描述角色、边界、输出格式和关键约束。长篇项目文档应该放到项目记忆或上下文文件里，由 Agent 按需读取。

### 7. 没有缓存清理

启动时缓存没问题，但用户新增 Agent 后需要 `/reload` 或重启。不要让缓存行为变成隐形问题。

## 本章小结

第三十一章让 Mini 的多 Agent 系统从“代码写死”变成“项目可配置”。

现在系统具备了：

- `.mini/agents/*.md` 项目级 Agent。
- `~/.mini/agents/*.md` 用户级 Agent。
- frontmatter 解析与字段校验。
- Agent 来源和覆盖优先级。
- 配置错误收集。
- `/agents` 查看 active 和 shadowed Agent。
- 动态 Agent 接入 `Agent` 工具。
- 可选的主线程 `--agent` 身份。

到这里，Mini 的 Agent 已经能被真实项目定制。

下一章可以继续做 **Agent 工作树隔离与并行改动合并**：让多个写代码的子 Agent 在独立 worktree 里执行，避免并行修改互相覆盖。
