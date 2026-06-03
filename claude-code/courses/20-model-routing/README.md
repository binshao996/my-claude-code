# 第 20 章：实现模型路由

第十九章完成了插件系统。Mini 现在已经可以通过插件扩展命令、工具和上下文，但还有一个更底层的问题没有解决：所有模型调用都默认走同一个模型。

真实 Coding Agent 不会把所有任务都交给同一个模型：

- 主循环需要稳定处理工具调用和长上下文。
- 标题生成、简单分类、轻量摘要可以走更快的模型。
- 计划模式可能需要更强的推理模型。
- 压缩上下文需要便宜、稳定、格式遵循能力强的模型。
- 插件命令有时希望指定自己的模型偏好。
- 用户在会话中执行 `/model` 后，下一轮应该立即切换，但历史消息不能丢。

如果把这些选择散落在调用点里，代码会很快变成一堆 `if`。本章要做的是把模型选择统一收束成一个 ModelRouter。

本章仍然保持第二章里的 DeepSeek 接入方式：不换 SDK，不实现新的协议适配层，继续使用 `@anthropic-ai/sdk`。DeepSeek 的 Anthropic-compatible endpoint 已经能直接使用，所以 Mini 只需要把这三个配置传给 SDK：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

注意：密钥只能通过环境变量传入，不要写进源码、文档示例输出或日志。

## 本章目标

完成本章后，你会得到：

1. 一个 `src/models/` 模块，集中负责模型配置和路由。
2. 角色化模型：`main`、`fast`、`planner`、`compact`、`plugin`。
3. DeepSeek Anthropic-compatible 默认配置。
4. 模型别名解析：`main`、`fast`、`planner`、`compact`、`sonnet`、`haiku`、`opus`、`best`。
5. 会话级 `/model` 覆盖。
6. 插件命令级 `model` 覆盖。
7. LLM 客户端按路由结果创建请求。
8. `/models` 命令展示当前路由表。
9. 模型路由测试。

这一章的工程目标是：任何调用模型的地方都不直接猜模型名，而是先声明“这次调用的角色”，再由 ModelRouter 解析为具体模型。

## 本章完成效果

配置 DeepSeek：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

运行 Mini：

```bash
bun run dev
```

查看当前模型路由：

```txt
> /models
```

输出类似：

```txt
Model Routes

Provider: anthropic-compatible
Base URL: https://api.deepseek.com/anthropic

Role       Model                 Reason
main       deepseek-v4-flash     ANTHROPIC_MODEL
fast       deepseek-v4-flash     fallback to main
planner    deepseek-v4-flash     fallback to main
compact    deepseek-v4-flash     fallback to main
plugin     deepseek-v4-flash     fallback to main
```

临时切换主循环模型：

```txt
> /model deepseek-v4-flash
```

下一轮主循环会使用新的主模型，但同一个会话的历史消息、工具状态和 Memory 都保留。

插件命令也可以声明模型：

```json
{
  "name": "git-helper",
  "version": "0.1.0",
  "commands": {
    "branch-summary": {
      "source": "./commands/branch-summary.md",
      "description": "Summarize current branch",
      "model": "fast"
    }
  }
}
```

执行这个命令时，Mini 会把 `model: "fast"` 交给 ModelRouter，而不是让插件直接碰 API 配置。

## 真实工程如何处理模型

真实 Claude Code 的模型选择不是一个单点函数，而是几个层次组合起来的。

### Provider 选择

`src/utils/model/providers.ts` 负责选择 provider。优先级大致是：

1. 用户设置里的 `modelType`。
2. Bedrock、Vertex、Foundry 相关环境变量。
3. OpenAI、Gemini、Grok 兼容层环境变量。
4. 默认 `firstParty`。

Provider 解决的是“用什么协议和客户端发请求”，不是“这次任务用哪个模型”。这两个概念必须分开：

- Provider：请求协议、认证方式、stream adapter、beta header、token 统计能力。
- Model：具体模型名、上下文能力、输出上限、成本、是否适合某类任务。

本章 Mini 先不实现多协议 provider，只做 Anthropic-compatible provider。这样可以直接覆盖 Anthropic 官方 API 和 DeepSeek Anthropic-compatible API。

### 模型默认值和别名

`src/utils/model/model.ts` 负责主模型、快速模型、默认 Opus/Sonnet/Haiku 族模型和用户指定模型解析。真实工程里有几个关键点：

- `/model` 或启动参数覆盖优先级最高。
- `ANTHROPIC_MODEL` 可以覆盖默认主模型。
- `OPENAI_DEFAULT_*_MODEL`、`GEMINI_DEFAULT_*_MODEL`、`ANTHROPIC_DEFAULT_*_MODEL` 用于不同 provider 的默认族模型。
- `sonnet`、`opus`、`haiku`、`best` 是别名，不是固定模型 ID。
- `opusplan` 表示普通模式用默认主模型，计划模式用更强模型。
- 模型字符串可能带 `[1m]` 后缀，请求 API 前会被规范化。

Mini 不需要复制所有商业逻辑，但要保留核心思想：调用方说角色，路由器解析具体模型。

### 请求层分发

`src/services/api/claude.ts` 在共享预处理后，根据 provider 分发：

- `openai` 走 OpenAI adapter。
- `gemini` 走 Gemini adapter。
- `grok` 走 Grok adapter。
- 其他走 Anthropic SDK 路径。

这说明一个重要边界：provider 分发发生在请求层，模型路由发生在请求层之前。Mini 本章只做模型路由，不做 OpenAI/Gemini/Grok 的 stream adapter。

### 运行时模型

真实工程在运行时还会根据上下文改变模型：

- plan mode 可能触发计划专用模型。
- small fast model 用于轻量任务。
- skill frontmatter 可以覆盖模型。
- context window 和 max output tokens 会随模型变化。
- streaming 失败时可能切到非流式 fallback。

本章把这些能力压缩成最小可维护版本：角色化路由 + 命令覆盖 + 插件覆盖 + 静态能力表。

## 本章项目结构变化

新增：

```txt
src/
  models/
    types.ts
    config.ts
    aliases.ts
    router.ts
    modelState.ts
    report.ts
    __tests__/
      router.test.ts
```

会修改：

```txt
src/
  llm/
    anthropic.ts
  agent/
    agentLoop.ts
  planner/
    planner.ts
  context/
    compactor.ts
  commands/
    model.ts
    models.ts
  plugins/
    manifest.ts
    commandRunner.ts
```

如果你的 Mini 当前文件名和前面章节不同，以你已有的 LLM 客户端、AgentLoop、Planner、Compactor、CommandRegistry 为准。关键不是路径名字，而是调用模型前统一走 `modelRouter.resolve()`。

## 设计原则

模型路由有四条规则：

1. 调用点不直接读取模型环境变量。
2. 调用点只声明任务角色。
3. 用户显式覆盖优先于默认配置。
4. 路由结果可以打印给用户，但不能包含密钥。

优先级从高到低：

```txt
commandModel override
  ↓
session /model override
  ↓
role-specific config
  ↓
ANTHROPIC_MODEL
  ↓
built-in fallback
```

这里的 `commandModel override` 包含插件命令声明的模型，也包含未来内部命令临时指定的模型。

## 第一步：定义模型类型

创建 `src/models/types.ts`：

```ts
export type ModelRole = "main" | "fast" | "planner" | "compact" | "plugin";

export type PermissionMode = "default" | "plan";

export type ModelRouteRequest = {
  role: ModelRole;
  permissionMode?: PermissionMode;
  commandModel?: string;
  contextTokens?: number;
};

export type ModelProvider = "anthropic-compatible";

export type ModelCapability = {
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
};

export type ResolvedModel = {
  provider: ModelProvider;
  role: ModelRole;
  model: string;
  baseUrl?: string;
  authTokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  reason: string;
  capability: ModelCapability;
};

export type ModelConfig = {
  provider: ModelProvider;
  baseUrl?: string;
  authToken?: string;
  authTokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  mainModel: string;
  fastModel?: string;
  plannerModel?: string;
  compactModel?: string;
  pluginModel?: string;
  largeContextModel?: string;
};
```

这里把 token 的值放在 `ModelConfig.authToken`，但 `ResolvedModel` 里只保留 `authTokenEnv`，不把真实 token 暴露给报告、日志和错误消息。

## 第二步：读取模型配置

创建 `src/models/config.ts`：

```ts
import type { ModelConfig } from "./types";

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadModelConfig(): ModelConfig {
  const authToken = readEnv("ANTHROPIC_AUTH_TOKEN") ?? readEnv("ANTHROPIC_API_KEY");
  const authTokenEnv = readEnv("ANTHROPIC_AUTH_TOKEN")
    ? "ANTHROPIC_AUTH_TOKEN"
    : "ANTHROPIC_API_KEY";

  const mainModel = readEnv("CCMINI_MODEL_MAIN")
    ?? readEnv("ANTHROPIC_MODEL")
    ?? DEFAULT_MODEL;

  return {
    provider: "anthropic-compatible",
    baseUrl: readEnv("ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL,
    authToken,
    authTokenEnv,
    mainModel,
    fastModel: readEnv("CCMINI_MODEL_FAST"),
    plannerModel: readEnv("CCMINI_MODEL_PLANNER"),
    compactModel: readEnv("CCMINI_MODEL_COMPACT"),
    pluginModel: readEnv("CCMINI_MODEL_PLUGIN"),
    largeContextModel: readEnv("CCMINI_MODEL_LARGE_CONTEXT"),
  };
}

export function assertModelConfig(config: ModelConfig): void {
  if (!config.authToken) {
    throw new Error(
      `Missing ${config.authTokenEnv}. Set ANTHROPIC_AUTH_TOKEN for DeepSeek Anthropic-compatible access.`,
    );
  }

  if (!config.mainModel) {
    throw new Error("Missing main model. Set ANTHROPIC_MODEL or CCMINI_MODEL_MAIN.");
  }
}
```

为什么默认 `DEFAULT_BASE_URL` 指向 DeepSeek？

因为本课程前面已经按 DeepSeek Anthropic-compatible 路径推进。它不要求你安装 Claude Code，也不要求新增协议适配层。你只要给 SDK 一个 `baseURL`、一个 token、一个模型名即可。

如果你要接 Anthropic 官方 API，可以这样覆盖：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-anthropic-key>"
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_MODEL="<your-model>"
```

这里不在课程里写死官方模型名，避免教程和具体模型发布时间绑定。工程上只需要把模型 ID 当字符串传给 SDK。

## 第三步：实现别名解析

创建 `src/models/aliases.ts`：

```ts
import type { ModelConfig, ModelRole } from "./types";

const ROLE_ALIASES: Record<string, ModelRole> = {
  main: "main",
  fast: "fast",
  planner: "planner",
  plan: "planner",
  compact: "compact",
  plugin: "plugin",
};

export function resolveModelAlias(input: string, config: ModelConfig): string {
  const raw = input.trim();
  const normalized = raw.toLowerCase();
  const role = ROLE_ALIASES[normalized];

  if (role) {
    return modelForRole(role, config).model;
  }

  switch (normalized) {
    case "sonnet":
      return config.mainModel;
    case "haiku":
      return config.fastModel ?? config.mainModel;
    case "opus":
    case "best":
      return config.plannerModel ?? config.mainModel;
    default:
      return raw;
  }
}

export function modelForRole(
  role: ModelRole,
  config: ModelConfig,
): { model: string; reason: string } {
  switch (role) {
    case "main":
      return { model: config.mainModel, reason: "main model" };
    case "fast":
      return config.fastModel
        ? { model: config.fastModel, reason: "fast model" }
        : { model: config.mainModel, reason: "fallback to main" };
    case "planner":
      return config.plannerModel
        ? { model: config.plannerModel, reason: "planner model" }
        : { model: config.mainModel, reason: "fallback to main" };
    case "compact":
      return config.compactModel
        ? { model: config.compactModel, reason: "compact model" }
        : { model: config.mainModel, reason: "fallback to main" };
    case "plugin":
      return config.pluginModel
        ? { model: config.pluginModel, reason: "plugin model" }
        : { model: config.mainModel, reason: "fallback to main" };
  }
}
```

真实工程里的 `sonnet`、`opus`、`haiku` 会映射到不同 provider 的真实默认模型。Mini 这里把它们映射到你自己的配置：

- `sonnet`：主模型。
- `haiku`：快速模型，没有则回退主模型。
- `opus` / `best`：计划模型，没有则回退主模型。

这样做的好处是：即使你当前只用 DeepSeek 一个模型，接口仍然为未来多模型保留了结构。

## 第四步：实现 ModelRouter

创建 `src/models/router.ts`：

```ts
import { modelForRole, resolveModelAlias } from "./aliases";
import { loadModelConfig } from "./config";
import { getSessionModelOverride } from "./modelState";
import type {
  ModelCapability,
  ModelConfig,
  ModelRouteRequest,
  ResolvedModel,
} from "./types";

const DEFAULT_CAPABILITY: ModelCapability = {
  maxInputTokens: 200_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsStreaming: true,
};

export class ModelRouter {
  constructor(private readonly config: ModelConfig = loadModelConfig()) {}

  resolve(request: ModelRouteRequest): ResolvedModel {
    const commandModel = request.commandModel?.trim();
    if (commandModel) {
      const model = resolveModelAlias(commandModel, this.config);
      return this.toResolved(request, model, "command model override");
    }

    const sessionModel = getSessionModelOverride();
    if (sessionModel && request.role === "main") {
      const model = resolveModelAlias(sessionModel, this.config);
      return this.toResolved(request, model, "session /model override");
    }

    if (request.permissionMode === "plan") {
      const planner = modelForRole("planner", this.config);
      return this.toResolved(request, planner.model, `plan mode ${planner.reason}`);
    }

    if (
      request.contextTokens !== undefined &&
      request.contextTokens > 180_000 &&
      this.config.largeContextModel
    ) {
      return this.toResolved(request, this.config.largeContextModel, "large context route");
    }

    const selected = modelForRole(request.role, this.config);
    return this.toResolved(request, selected.model, selected.reason);
  }

  getConfig(): ModelConfig {
    return this.config;
  }

  private toResolved(
    request: ModelRouteRequest,
    model: string,
    reason: string,
  ): ResolvedModel {
    return {
      provider: this.config.provider,
      role: request.role,
      model,
      baseUrl: this.config.baseUrl,
      authTokenEnv: this.config.authTokenEnv,
      reason,
      capability: capabilityFor(model),
    };
  }
}

export const modelRouter = new ModelRouter();

export function capabilityFor(model: string): ModelCapability {
  if (model.toLowerCase().includes("large")) {
    return {
      maxInputTokens: 1_000_000,
      maxOutputTokens: 16_000,
      supportsTools: true,
      supportsStreaming: true,
    };
  }

  return DEFAULT_CAPABILITY;
}
```

这里有一个刻意简化：`capabilityFor()` 只做本地静态判断。真实工程会根据 provider、模型能力缓存、订阅状态和 API 返回能力决定 context window。Mini 当前只需要避免把能力判断散落在业务逻辑里。

## 第五步：保存会话级模型覆盖

创建 `src/models/modelState.ts`：

```ts
let sessionModelOverride: string | null = null;

export function getSessionModelOverride(): string | null {
  return sessionModelOverride;
}

export function setSessionModelOverride(model: string | null): void {
  sessionModelOverride = model;
}
```

这和真实工程的思路一致：`/model` 不改历史消息，只改会话后续请求的模型选择。

不要把 `/model` 写入全局配置，除非用户明确执行“保存默认模型”的命令。本章只做会话级覆盖，风险更小。

## 第六步：把路由结果接入 SDK

假设你的 LLM 客户端在 `src/llm/anthropic.ts`，把它改成接收 `ModelRouteRequest`，而不是直接接收模型名。

```ts
import Anthropic from "@anthropic-ai/sdk";
import { assertModelConfig } from "../models/config";
import { modelRouter } from "../models/router";
import type { ModelRouteRequest } from "../models/types";
import type { ChatMessage } from "./types";

export type LlmRequest = {
  route: ModelRouteRequest;
  system: string;
  messages: ChatMessage[];
  tools?: unknown[];
  signal?: AbortSignal;
};

export async function createMessage(request: LlmRequest): Promise<string> {
  const route = modelRouter.resolve(request.route);
  const config = modelRouter.getConfig();
  assertModelConfig(config);

  const client = new Anthropic({
    apiKey: config.authToken,
    baseURL: config.baseUrl,
  });

  const response = await client.messages.create(
    {
      model: route.model,
      max_tokens: route.capability.maxOutputTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    },
    {
      signal: request.signal,
    },
  );

  return response.content
    .map(block => (block.type === "text" ? block.text : ""))
    .join("");
}
```

关键点：

- SDK 仍然是 `@anthropic-ai/sdk`。
- DeepSeek 只通过 `baseURL` 和模型名接入。
- token 从环境变量读取，但不进入 route report。
- `max_tokens` 来自 route capability，调用点不需要知道模型上限。

如果你已经实现了 streaming，把同样的 `route.model` 和 `route.capability.maxOutputTokens` 放到 stream 请求里即可：

```ts
const stream = client.messages.stream({
  model: route.model,
  max_tokens: route.capability.maxOutputTokens,
  system: request.system,
  messages: request.messages,
  tools: request.tools,
});
```

## 第七步：改主 AgentLoop

主循环调用模型时，使用 `role: "main"`：

```ts
const answer = await createMessage({
  route: {
    role: "main",
    permissionMode: state.permissionMode,
    contextTokens: preparedContext.estimatedTokens,
  },
  system: preparedContext.system,
  messages: preparedContext.messages,
  tools: toolRegistry.toAnthropicTools(),
  signal,
});
```

这样主循环不再关心 `ANTHROPIC_MODEL`、DeepSeek、快速模型或计划模型。它只知道“我要做主循环推理”。

## 第八步：改 Planner

计划生成调用模型时，使用 `role: "planner"`：

```ts
const plan = await createMessage({
  route: {
    role: "planner",
    permissionMode: "plan",
    contextTokens: context.estimatedTokens,
  },
  system: plannerSystemPrompt,
  messages: [
    {
      role: "user",
      content: userGoal,
    },
  ],
  signal,
});
```

如果你没有配置 `CCMINI_MODEL_PLANNER`，它会回退到主模型；如果配置了，就会走计划模型。

示例：

```bash
export CCMINI_MODEL_PLANNER="deepseek-v4-flash"
```

当前你只有一个 DeepSeek 模型也没关系，路由层仍然能保持语义清晰。

## 第九步：改压缩器

第十八章实现上下文裁剪后，压缩器可以使用 `compact` 角色：

```ts
const compacted = await createMessage({
  route: {
    role: "compact",
    contextTokens: context.estimatedTokens,
  },
  system: compactSystemPrompt,
  messages: [
    {
      role: "user",
      content: transcriptToCompact,
    },
  ],
  signal,
});
```

配置：

```bash
export CCMINI_MODEL_COMPACT="deepseek-v4-flash"
```

压缩模型不一定要最强，但必须稳定遵守格式。以后你可以为 compact 配一个便宜模型，而不用改压缩器代码。

## 第十步：改轻量任务

标题生成、命令意图分类、是否需要继续执行等轻量任务使用 `fast` 角色：

```ts
const title = await createMessage({
  route: {
    role: "fast",
  },
  system: "Generate a short title for this coding session.",
  messages: [
    {
      role: "user",
      content: firstUserMessage,
    },
  ],
});
```

配置：

```bash
export CCMINI_MODEL_FAST="deepseek-v4-flash"
```

这一步看似只是换一个字段，但它会让未来成本优化变得简单：你只改配置，不改业务逻辑。

## 第十一步：支持 `/model`

创建或修改 `src/commands/model.ts`：

```ts
import { setSessionModelOverride } from "../models/modelState";
import { modelRouter } from "../models/router";

export function runModelCommand(args: string[]): string {
  const input = args.join(" ").trim();

  if (!input) {
    const current = modelRouter.resolve({ role: "main" });
    return `Current main model: ${current.model}\nReason: ${current.reason}`;
  }

  if (input === "default") {
    setSessionModelOverride(null);
    const current = modelRouter.resolve({ role: "main" });
    return `Main model reset to default: ${current.model}`;
  }

  setSessionModelOverride(input);
  const current = modelRouter.resolve({ role: "main" });
  return `Main model set to: ${current.model}`;
}
```

命令效果：

```txt
> /model
Current main model: deepseek-v4-flash
Reason: main model

> /model fast
Main model set to: deepseek-v4-flash

> /model default
Main model reset to default: deepseek-v4-flash
```

这里允许用户输入别名，也允许输入完整模型名。完整模型名是否真实存在，不在路由器里做网络校验；Mini 可以等第一次 API 请求失败后显示错误。真实产品会在模型 picker 和 allowlist 里做更严格校验。

## 第十二步：支持 `/models`

创建 `src/models/report.ts`：

```ts
import { modelRouter } from "./router";
import type { ModelRole } from "./types";

const ROLES: ModelRole[] = ["main", "fast", "planner", "compact", "plugin"];

export function renderModelRoutes(): string {
  const config = modelRouter.getConfig();
  const lines = [
    "Model Routes",
    "",
    `Provider: ${config.provider}`,
    `Base URL: ${config.baseUrl ?? "(default)"}`,
    "",
    "Role       Model                 Reason",
  ];

  for (const role of ROLES) {
    const route = modelRouter.resolve({ role });
    lines.push(`${role.padEnd(10)} ${route.model.padEnd(21)} ${route.reason}`);
  }

  return lines.join("\n");
}
```

创建或修改 `src/commands/models.ts`：

```ts
import { renderModelRoutes } from "../models/report";

export function runModelsCommand(): string {
  return renderModelRoutes();
}
```

不要在 `/models` 输出里打印 token。只显示 `authTokenEnv` 也要谨慎，本章的报告直接不展示认证字段。

## 第十三步：插件命令支持模型覆盖

第十九章的 manifest 可以扩展一个 `model` 字段。

修改 `src/plugins/manifest.ts`：

```ts
export type PluginCommandManifest = {
  source: string;
  description?: string;
  model?: string;
};
```

然后在命令执行器里把它传给 LLM 调用。

修改 `src/plugins/commandRunner.ts`：

```ts
const result = await createMessage({
  route: {
    role: "plugin",
    commandModel: command.model,
    contextTokens: context.estimatedTokens,
  },
  system: pluginCommandSystemPrompt,
  messages: [
    {
      role: "user",
      content: renderedPrompt,
    },
  ],
  tools: toolRegistry.toAnthropicTools(),
  signal,
});
```

插件作者可以写：

```json
{
  "commands": {
    "deep-review": {
      "source": "./commands/deep-review.md",
      "description": "Review the current diff carefully",
      "model": "planner"
    }
  }
}
```

这里的 `planner` 不是模型 ID，而是路由别名。实际模型仍然由本地配置决定。

## 第十四步：测试模型路由

创建 `src/models/__tests__/router.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { ModelRouter } from "../router";
import type { ModelConfig } from "../types";

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: "anthropic-compatible",
    baseUrl: "https://api.deepseek.com/anthropic",
    authToken: "test-token",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
    mainModel: "deepseek-v4-flash",
    ...overrides,
  };
}

describe("ModelRouter", () => {
  test("routes main role to ANTHROPIC_MODEL equivalent", () => {
    const router = new ModelRouter(config());

    const route = router.resolve({ role: "main" });

    expect(route.model).toBe("deepseek-v4-flash");
    expect(route.provider).toBe("anthropic-compatible");
    expect(route.reason).toBe("main model");
  });

  test("uses fast model when configured", () => {
    const router = new ModelRouter(
      config({
        fastModel: "deepseek-fast",
      }),
    );

    const route = router.resolve({ role: "fast" });

    expect(route.model).toBe("deepseek-fast");
    expect(route.reason).toBe("fast model");
  });

  test("falls back to main when role model is not configured", () => {
    const router = new ModelRouter(config());

    const route = router.resolve({ role: "compact" });

    expect(route.model).toBe("deepseek-v4-flash");
    expect(route.reason).toBe("fallback to main");
  });

  test("command model override wins over role config", () => {
    const router = new ModelRouter(
      config({
        plannerModel: "deepseek-planner",
      }),
    );

    const route = router.resolve({
      role: "planner",
      commandModel: "deepseek-command",
    });

    expect(route.model).toBe("deepseek-command");
    expect(route.reason).toBe("command model override");
  });

  test("command model can use role alias", () => {
    const router = new ModelRouter(
      config({
        plannerModel: "deepseek-planner",
      }),
    );

    const route = router.resolve({
      role: "plugin",
      commandModel: "planner",
    });

    expect(route.model).toBe("deepseek-planner");
  });

  test("plan permission mode uses planner route", () => {
    const router = new ModelRouter(
      config({
        plannerModel: "deepseek-planner",
      }),
    );

    const route = router.resolve({
      role: "main",
      permissionMode: "plan",
    });

    expect(route.model).toBe("deepseek-planner");
    expect(route.reason).toBe("plan mode planner model");
  });

  test("route report does not expose token value", () => {
    const router = new ModelRouter(config({ authToken: "secret-value" }));

    const route = router.resolve({ role: "main" });
    const serialized = JSON.stringify(route);

    expect(serialized).not.toContain("secret-value");
    expect(route.authTokenEnv).toBe("ANTHROPIC_AUTH_TOKEN");
  });
});
```

运行测试：

```bash
bun test src/models/__tests__/router.test.ts
```

再跑类型检查：

```bash
bun run typecheck
```

## 第十五步：让错误更可读

模型路由层应该在启动或第一次请求前给出清晰错误。

推荐错误：

```txt
Missing ANTHROPIC_AUTH_TOKEN. Set it in your shell environment.
```

不要输出：

```txt
Invalid token sk-...
```

也不要把完整请求配置打印出来。调试模型路由时，只打印这些字段：

```txt
provider
baseUrl
model
role
reason
maxInputTokens
maxOutputTokens
```

不要打印：

```txt
authToken
headers.authorization
request body with secrets
```

## 第十六步：与上下文预算打通

第十八章的上下文预算可以开始读取 route capability：

```ts
const route = modelRouter.resolve({
  role: "main",
  contextTokens: estimatedTokens,
});

const budget = createContextBudget({
  contextWindowTokens: route.capability.maxInputTokens,
  reservedOutputTokens: route.capability.maxOutputTokens,
});
```

这样切换模型后，预算也会变化。真实工程里 `getMaxOutputTokensForModel()`、`modelCapabilities` 和 provider 能力缓存就是做类似的事情。

Mini 当前只有静态能力表，但调用方向已经正确。

## 第十七步：与成本统计预留接口

如果你已经有 usage 统计，可以把 route model 写进去：

```ts
usageTracker.record({
  model: route.model,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
});
```

不要把成本计算写进 ModelRouter。路由器只负责选择模型；价格、用量、预算提醒属于 cost tracker。

保持边界后，未来你可以替换价格表，而不用改模型路由。

## 第十八步：配置示例

只用 DeepSeek 一个模型：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

同一个 DeepSeek 模型服务所有角色：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export CCMINI_MODEL_MAIN="deepseek-v4-flash"
export CCMINI_MODEL_FAST="deepseek-v4-flash"
export CCMINI_MODEL_PLANNER="deepseek-v4-flash"
export CCMINI_MODEL_COMPACT="deepseek-v4-flash"
```

未来接入多个模型时，只需要改配置：

```bash
export CCMINI_MODEL_MAIN="deepseek-v4-flash"
export CCMINI_MODEL_FAST="deepseek-v4-flash"
export CCMINI_MODEL_PLANNER="deepseek-v4-flash"
export CCMINI_MODEL_COMPACT="deepseek-v4-flash"
```

这组示例看起来重复，是因为当前你使用的是同一个模型。路由结构仍然有价值：调用点已经不需要知道这个事实。

## 常见问题

### 为什么 DeepSeek 还能用 `@anthropic-ai/sdk`

因为这里接的是 DeepSeek 的 Anthropic-compatible endpoint。协议形状和 Anthropic Messages API 对齐，所以 SDK 可以继续使用。

代码里真正变化的是：

```ts
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
```

请求时再传：

```ts
model: process.env.ANTHROPIC_MODEL
```

本章只是把这些读取动作集中到 `loadModelConfig()` 和 `ModelRouter`，避免每个调用点都直接读环境变量。

### 为什么不叫 ProviderRouter

因为本章没有实现多 provider 协议。Anthropic-compatible、OpenAI-compatible、Gemini 原生协议的消息格式、工具格式和 streaming 事件都不一样，应该放在 provider adapter 层。

本章只解决同一请求协议下的模型选择问题。

### `/model` 会不会影响 planner 和 compact

本章默认只影响 `main` 角色。

原因是用户执行 `/model` 通常是想切换主对话模型，不一定想改变压缩器、计划器和插件命令。如果要临时改变插件命令，可以在 manifest 里写 `model`；如果要长期改变 planner 或 compact，用环境变量配置。

### 插件为什么不能直接写 API key

插件是扩展能力，不应该拥有认证控制权。它可以声明“我希望用 planner 角色”，但不能决定请求打到哪里、用什么 token、打印什么日志。

认证配置只属于宿主程序。

### 模型不存在怎么办

Mini 可以先接受字符串，等 API 返回错误时展示：

```txt
Model request failed for role planner using model deepseek-planner.
Check CCMINI_MODEL_PLANNER or command model override.
```

真实产品会在模型选择 UI 里加 allowlist 和远程能力校验。本章先不做，避免引入网络依赖。

## 本章检查清单

完成后确认：

1. 所有模型调用都通过 `ModelRouteRequest`。
2. LLM 客户端只接收 route，不再直接读取业务侧传来的模型名。
3. `@anthropic-ai/sdk` 保持不变。
4. DeepSeek 通过 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 接入。
5. `/model default` 可以清除会话覆盖。
6. `/models` 不打印 token。
7. 插件 command 的 `model` 字段可以使用别名。
8. 测试覆盖命令覆盖、角色回退、plan mode、secret 不泄漏。

验证命令：

```bash
bun test src/models/__tests__/router.test.ts
bun run typecheck
```

## 小结

本章给 Mini 加了一层模型路由。它不复杂，但边界很关键：

- Provider 负责协议。
- ModelRouter 负责模型选择。
- LLM client 负责发请求。
- AgentLoop、Planner、Compactor、Plugin 只声明任务角色。

这样 Mini 既能维持当前 DeepSeek Anthropic-compatible 的简单接入，又为未来多模型、多角色、多 provider adapter 留出了清晰扩展点。

下一章可以继续做模型层的另一个关键能力：API 请求容错，包括重试、限流、streaming fallback、模型 fallback 和错误归一化。
