# 第 30 章：多 Agent 与子任务调度

第二十九章让 Mini 支持了后台任务。长运行命令不再卡住主循环，输出也能落盘、读取和停止。

现在可以继续往上走一层：**让模型把一部分工作交给子 Agent**。

大型编码任务里，主 Agent 经常同时面对几类工作：

- 查找代码位置。
- 阅读一批相关文件。
- 验证某个假设。
- 跑测试或构建。
- 评审改动是否有风险。
- 把最终结果整理给用户。

如果全部压在同一个对话上下文里，主 Agent 会越来越慢，也更容易把“探索过程”和“最终决策”混在一起。多 Agent 的价值不是炫技，而是把可拆分的工作单元放到独立执行链里：

```text
主 Agent：决定拆什么、何时等结果、如何汇总。
子 Agent：带着明确任务独立运行，完成后只把结果交回。
```

本章会给 Mini 加一个基础版 `Agent` 工具。它可以同步运行子 Agent，也可以把子 Agent 放到第二十九章的后台任务系统中继续执行。

## 真实工程怎么做

真实工程的多 Agent 能力主要分布在：

- `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx`：`Agent` 工具入口，解析 `description`、`prompt`、`subagent_type`、`model`、`run_in_background`、`isolation` 等参数，决定同步执行还是后台执行。
- `packages/builtin-tools/src/tools/AgentTool/runAgent.ts`：真正运行子 Agent，构建独立 system prompt、消息、工具池、权限模式和 transcript。
- `packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts`：加载内置、项目、用户和插件提供的 Agent 定义。
- `packages/builtin-tools/src/tools/AgentTool/agentToolUtils.ts`：解析 Agent 工具白名单、汇总结果、跟踪 progress、处理后台生命周期。
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`：把后台子 Agent 注册成统一 task，记录进度、结果、通知和取消逻辑。
- `src/utils/agentContext.ts`：用 `AsyncLocalStorage` 隔离并发子 Agent 的运行上下文，避免不同 Agent 的事件和日志互相串线。
- `packages/builtin-tools/src/tools/TaskOutputTool/TaskOutputTool.tsx`：读取后台 Agent 输出。
- `packages/builtin-tools/src/tools/TaskStopTool/TaskStopTool.ts`：停止后台 Agent。
- `src/tasks/LocalShellTask/killShellTasks.ts`：子 Agent 结束时清理它启动的 shell 任务。

真实工程里有几个非常关键的判断：

- 子 Agent 默认从空上下文开始，必须把任务说明写完整。
- 子 Agent 有自己的 system prompt、工具池、模型和权限模式。
- 后台子 Agent 不能依赖交互式权限弹窗，所以权限必须提前收窄或自动拒绝。
- 子 Agent 的 transcript 和输出文件要独立记录，方便恢复、查看和调试。
- 同步子 Agent 运行太久时，也可以转入后台。
- 子 Agent 结束时要清理它创建的 shell 任务、hook、临时状态和缓存。

Mini 先做其中最核心的一层：本地子 Agent 调度。

## 本章目标

完成后，Mini 可以支持这样的调用：

```text
> 让一个 explorer agent 检查登录逻辑在哪里，再告诉我入口文件
```

主 Agent 调用：

```json
{
  "description": "检查登录入口",
  "subagent_type": "explorer",
  "prompt": "查找项目中登录流程的入口文件。只做阅读和检索，不要修改代码。返回关键文件路径和判断依据。"
}
```

同步结果：

```json
{
  "status": "completed",
  "agentId": "a_2m9kq1p8",
  "content": "登录入口在 src/auth/login.ts，CLI 入口通过 src/main.tsx 调用 auth command...",
  "totalToolUseCount": 5,
  "totalDurationMs": 3182
}
```

也可以后台运行：

```json
{
  "description": "并行跑测试",
  "subagent_type": "runner",
  "prompt": "运行相关测试并总结失败原因。不要修改文件。",
  "run_in_background": true
}
```

返回：

```json
{
  "status": "async_launched",
  "agentId": "a_z7c0w6ta",
  "description": "并行跑测试",
  "outputFile": ".mini/tmp/<sessionId>/tasks/a_z7c0w6ta.output"
}
```

本章要实现：

- Agent 定义：类型、使用场景、工具白名单、system prompt。
- Agent 注册表：内置 Agent 和项目 Agent 合并。
- `Agent` 工具：同步子 Agent 和后台子 Agent。
- 子 Agent 运行器：独立消息、独立工具、独立权限和独立取消。
- `local_agent` task：复用第二十九章的 task store 和输出文件。
- progress：统计工具调用、token 和最近活动。
- 完成通知：后台子 Agent 结束后注入下一轮对话。
- 停止逻辑：`/tasks stop` 可以停止后台 Agent。
- 输出读取：`/tasks read` 可以读取后台 Agent 最终结果。

## 推荐目录

新增：

```text
src/agents/
  agentTypes.ts
  builtInAgents.ts
  agentRegistry.ts
  agentTools.ts
  agentContext.ts
  agentProgress.ts
  runAgent.ts

src/tasks/
  localAgentTask.ts

src/tools/
  agentTool.ts
```

修改：

```text
src/tasks/taskTypes.ts
src/tasks/taskStore.ts
src/tasks/stopTask.ts
src/tools/taskOutputTool.ts
src/tools/taskStopTool.ts
src/tools/toolRegistry.ts
src/chat/agentLoop.ts
src/transcript/types.ts
```

本章不做远程 Agent、团队 Agent、工作树隔离和可视化面板。先把“一个主 Agent 调度多个本地子 Agent”的运行链路打通。

## Agent 定义

先定义 Agent 的元信息。

```ts
// src/agents/agentTypes.ts
import type { PermissionMode } from "../permissions/permissionTypes";

export type AgentSource = "built-in" | "project" | "user";

export type AgentModel = "default" | "fast" | "smart";

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
  getSystemPrompt: () => string;
};

export type AgentToolInput = {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: AgentModel;
  run_in_background?: boolean;
};

export type CompletedAgentOutput = {
  status: "completed";
  agentId: string;
  agentType: string;
  prompt: string;
  content: string;
  totalToolUseCount: number;
  totalDurationMs: number;
};

export type AsyncAgentOutput = {
  status: "async_launched";
  agentId: string;
  description: string;
  prompt: string;
  outputFile: string;
};

export type AgentToolOutput = CompletedAgentOutput | AsyncAgentOutput;
```

`AgentDefinition` 里最重要的是三类信息：

- 这个 Agent 什么时候该被用。
- 这个 Agent 能用哪些工具。
- 这个 Agent 的 system prompt 如何约束行为。

不要把 Agent 定义做成“模型名字别名”。一个好的 Agent 类型应该代表任务边界，比如 `explorer`、`reviewer`、`runner`。

## 内置 Agent

Mini 先内置三个 Agent：

- `general-purpose`：通用子 Agent。
- `explorer`：只读检索 Agent。
- `reviewer`：代码评审 Agent。

```ts
// src/agents/builtInAgents.ts
import type { AgentDefinition } from "./agentTypes";

export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: "general-purpose",
  whenToUse: "处理需要独立完成的通用编码任务、调查任务或总结任务。",
  source: "built-in",
  tools: ["*"],
  model: "default",
  getSystemPrompt() {
    return [
      "你是一个独立运行的编码子 Agent。",
      "你只知道用户交给你的这一个任务，不知道主对话里发生了什么。",
      "先理解目标，再使用工具完成任务。",
      "完成后返回清晰、可执行、可核查的结果。",
    ].join("\n");
  },
};

export const EXPLORER_AGENT: AgentDefinition = {
  agentType: "explorer",
  whenToUse: "查找文件、阅读代码、定位实现位置，不做代码修改。",
  source: "built-in",
  tools: ["read_file", "glob", "grep", "bash"],
  disallowedTools: ["edit_file", "write_file"],
  model: "fast",
  permissionMode: "readOnly",
  maxTurns: 8,
  getSystemPrompt() {
    return [
      "你是只读代码探索 Agent。",
      "你的职责是查找、阅读和解释代码。",
      "不要修改文件，不要生成补丁，不要运行会改变工作区状态的命令。",
      "最终输出必须包含关键文件路径、相关函数或模块名，以及你的判断依据。",
    ].join("\n");
  },
};

export const REVIEWER_AGENT: AgentDefinition = {
  agentType: "reviewer",
  whenToUse: "评审已经完成的代码改动，找出 bug、回归风险和缺失测试。",
  source: "built-in",
  tools: ["read_file", "glob", "grep", "bash"],
  disallowedTools: ["edit_file", "write_file"],
  model: "smart",
  permissionMode: "readOnly",
  maxTurns: 10,
  getSystemPrompt() {
    return [
      "你是代码评审 Agent。",
      "优先找真实 bug、行为回归、安全风险和测试缺口。",
      "不要因为风格偏好提出无意义意见。",
      "输出按严重程度排序，并给出文件路径、原因和建议修复方向。",
    ].join("\n");
  },
};

export const BUILT_IN_AGENTS: AgentDefinition[] = [
  GENERAL_PURPOSE_AGENT,
  EXPLORER_AGENT,
  REVIEWER_AGENT,
];
```

注意 `explorer` 和 `reviewer` 都是只读 Agent。读写权限越窄，主 Agent 越容易放心并行派发任务。

## Agent 注册表

真实工程会从多个位置加载 Agent：内置、用户配置、项目配置、插件和策略配置。Mini 可以先简化成“内置 + 项目”。

```ts
// src/agents/agentRegistry.ts
import { BUILT_IN_AGENTS, GENERAL_PURPOSE_AGENT } from "./builtInAgents";
import type { AgentDefinition } from "./agentTypes";

export type AgentRegistry = {
  activeAgents: AgentDefinition[];
  getAgent(type: string | undefined): AgentDefinition;
};

export function createAgentRegistry(projectAgents: AgentDefinition[] = []): AgentRegistry {
  const map = new Map<string, AgentDefinition>();

  for (const agent of BUILT_IN_AGENTS) {
    map.set(agent.agentType, agent);
  }

  for (const agent of projectAgents) {
    map.set(agent.agentType, agent);
  }

  const activeAgents = [...map.values()].sort((a, b) => {
    return a.agentType.localeCompare(b.agentType);
  });

  return {
    activeAgents,
    getAgent(type) {
      if (!type) {
        return GENERAL_PURPOSE_AGENT;
      }

      const agent = map.get(type);
      if (!agent) {
        const available = activeAgents.map(item => item.agentType).join(", ");
        throw new Error(`Unknown agent type: ${type}. Available agents: ${available}`);
      }

      return agent;
    },
  };
}
```

项目 Agent 覆盖内置 Agent 是一个有用的策略。团队可以把 `reviewer` 改成更贴合本仓库的评审口径。

但覆盖也有风险，所以 Mini 先只支持代码内传入 `projectAgents`。后续再做 `.mini/agents/*.md` 文件加载。

## 工具解析

Agent 不能天然继承主 Agent 的全部工具。否则一个只读 Agent 也可能误拿到写文件工具。

定义工具解析：

```ts
// src/agents/agentTools.ts
import type { AgentDefinition } from "./agentTypes";
import type { ToolDefinition } from "../tools/toolTypes";

const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "agent",
]);

const BACKGROUND_AGENT_DISALLOWED_TOOLS = new Set([
  "ask_user",
]);

export type ResolvedAgentTools = {
  resolvedTools: ToolDefinition[];
  invalidTools: string[];
};

export function resolveAgentTools(
  agent: AgentDefinition,
  availableTools: ToolDefinition[],
  options: {
    isBackground: boolean;
  },
): ResolvedAgentTools {
  const availableByName = new Map<string, ToolDefinition>();

  for (const tool of availableTools) {
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      continue;
    }

    if (options.isBackground && BACKGROUND_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      continue;
    }

    if (agent.disallowedTools?.includes(tool.name)) {
      continue;
    }

    availableByName.set(tool.name, tool);
  }

  if (!agent.tools || agent.tools.length === 0 || agent.tools.includes("*")) {
    return {
      resolvedTools: [...availableByName.values()],
      invalidTools: [],
    };
  }

  const resolvedTools: ToolDefinition[] = [];
  const invalidTools: string[] = [];

  for (const toolName of agent.tools) {
    const tool = availableByName.get(toolName);
    if (!tool) {
      invalidTools.push(toolName);
      continue;
    }
    resolvedTools.push(tool);
  }

  return { resolvedTools, invalidTools };
}
```

这里有两个硬规则：

- 子 Agent 不能再随便调用 `agent`，避免无限递归。
- 后台 Agent 不能使用需要用户交互的工具。

真实工程会更复杂：它支持 `Agent(foo,bar)` 这种限定子 Agent 类型的工具规则，也会把 MCP 工具、插件 Agent、策略配置一起纳入解析。Mini 先保留可扩展接口即可。

## Agent Context

多个子 Agent 并发运行时，不能用一个全局变量记录“当前 Agent”。否则 Agent A 的日志可能被写成 Agent B 的日志。

用 `AsyncLocalStorage` 做隔离：

```ts
// src/agents/agentContext.ts
import { AsyncLocalStorage } from "node:async_hooks";

export type AgentRuntimeContext = {
  agentId: string;
  agentType: string;
  parentSessionId: string;
  taskId?: string;
};

const storage = new AsyncLocalStorage<AgentRuntimeContext>();

export function runWithAgentContext<T>(
  context: AgentRuntimeContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getAgentContext(): AgentRuntimeContext | undefined {
  return storage.getStore();
}
```

这和第二十九章的 task store 不是同一件事：

- task store 记录后台任务状态。
- Agent context 记录当前异步执行链属于哪个 Agent。

一个同步子 Agent 不一定是后台 task，但它也应该有 Agent context，方便 transcript、日志和工具调用归属。

## Agent 进度

后台 Agent 不能只是“跑着”。主 Agent 和用户需要知道它有没有进展。

```ts
// src/agents/agentProgress.ts
import type { ChatMessage } from "../chat/messageTypes";

export type AgentProgress = {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: string;
  recentActivities: string[];
};

export type AgentProgressTracker = {
  toolUseCount: number;
  tokenCount: number;
  recentActivities: string[];
};

export function createAgentProgressTracker(): AgentProgressTracker {
  return {
    toolUseCount: 0,
    tokenCount: 0,
    recentActivities: [],
  };
}

export function updateAgentProgressFromMessage(
  tracker: AgentProgressTracker,
  message: ChatMessage,
): void {
  if (message.role !== "assistant") {
    return;
  }

  if (message.usage) {
    tracker.tokenCount += message.usage.inputTokens + message.usage.outputTokens;
  }

  for (const part of message.content) {
    if (part.type !== "tool_use") {
      continue;
    }

    tracker.toolUseCount += 1;
    tracker.recentActivities.push(`called ${part.name}`);

    if (tracker.recentActivities.length > 5) {
      tracker.recentActivities.shift();
    }
  }
}

export function getAgentProgress(tracker: AgentProgressTracker): AgentProgress {
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: tracker.tokenCount,
    lastActivity: tracker.recentActivities.at(-1),
    recentActivities: [...tracker.recentActivities],
  };
}
```

真实工程还会把 Bash progress、PowerShell progress、SDK progress 事件都往外转发。Mini 先统计工具调用和 token。

## 扩展 Task 类型

第二十九章只有 `local_bash`。现在增加 `local_agent`。

```ts
// src/tasks/taskTypes.ts
export type TaskType = "local_bash" | "local_agent";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export type TaskStateBase = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  outputFile: string;
  outputOffset: number;
  notified: boolean;
};

export type LocalAgentTaskState = TaskStateBase & {
  type: "local_agent";
  agentId: string;
  agentType: string;
  prompt: string;
  abortController: AbortController;
  progress?: {
    toolUseCount: number;
    tokenCount: number;
    lastActivity?: string;
    recentActivities: string[];
  };
  result?: {
    content: string;
    totalToolUseCount: number;
    totalDurationMs: number;
  };
  error?: string;
};
```

如果你已经在第二十九章定义过 `TaskState` 联合类型，现在补上：

```ts
export type TaskState = LocalShellTaskState | LocalAgentTaskState;
```

## 注册后台 Agent Task

实现 `localAgentTask.ts`。

```ts
// src/tasks/localAgentTask.ts
import { createTaskId } from "./taskIds";
import { createTaskOutputFile, appendTaskOutput } from "./diskOutput";
import { registerTask, updateTask } from "./taskStore";
import type { LocalAgentTaskState } from "./taskTypes";
import type { CompletedAgentOutput } from "../agents/agentTypes";
import type { AgentProgress } from "../agents/agentProgress";

export function createAgentId(): string {
  return createTaskId("local_agent");
}

export async function registerLocalAgentTask(input: {
  description: string;
  prompt: string;
  agentType: string;
  toolUseId?: string;
}): Promise<LocalAgentTaskState> {
  const agentId = createAgentId();
  const outputFile = await createTaskOutputFile(agentId);

  const task: LocalAgentTaskState = {
    id: agentId,
    type: "local_agent",
    status: "running",
    description: input.description,
    toolUseId: input.toolUseId,
    startTime: Date.now(),
    outputFile,
    outputOffset: 0,
    notified: false,
    agentId,
    agentType: input.agentType,
    prompt: input.prompt,
    abortController: new AbortController(),
  };

  registerTask(task);
  await appendTaskOutput(agentId, `Agent prompt:\n${input.prompt}\n\n`);

  return task;
}

export async function appendAgentTaskMessage(
  taskId: string,
  text: string,
): Promise<void> {
  await appendTaskOutput(taskId, `${text}\n`);
}

export function updateAgentTaskProgress(
  taskId: string,
  progress: AgentProgress,
): void {
  updateTask<LocalAgentTaskState>(taskId, task => ({
    ...task,
    progress,
  }));
}

export function completeAgentTask(
  taskId: string,
  output: CompletedAgentOutput,
): void {
  updateTask<LocalAgentTaskState>(taskId, task => ({
    ...task,
    status: "completed",
    endTime: Date.now(),
    abortController: undefined as never,
    result: {
      content: output.content,
      totalToolUseCount: output.totalToolUseCount,
      totalDurationMs: output.totalDurationMs,
    },
  }));
}

export function failAgentTask(taskId: string, error: string): void {
  updateTask<LocalAgentTaskState>(taskId, task => ({
    ...task,
    status: "failed",
    endTime: Date.now(),
    abortController: undefined as never,
    error,
  }));
}

export function killAgentTask(taskId: string): void {
  updateTask<LocalAgentTaskState>(taskId, task => {
    if (task.status !== "running") {
      return task;
    }

    task.abortController.abort();

    return {
      ...task,
      status: "killed",
      endTime: Date.now(),
      abortController: undefined as never,
    };
  });
}
```

这里用 `undefined as never` 是为了少改章节前面的类型。真实代码里建议把 `abortController` 定义成可选字段：

```ts
abortController?: AbortController;
```

这样终态任务不必保留已经没用的 controller。

## 子 Agent 运行器

`runAgent` 是本章的核心。它要做四件事：

- 构建子 Agent 的 system prompt。
- 给子 Agent 一个独立消息数组。
- 用子 Agent 的工具池跑一轮 Agent Loop。
- 把最终文本、工具调用数和耗时汇总回来。

```ts
// src/agents/runAgent.ts
import type { AgentDefinition, AgentModel, CompletedAgentOutput } from "./agentTypes";
import { runWithAgentContext } from "./agentContext";
import {
  createAgentProgressTracker,
  getAgentProgress,
  updateAgentProgressFromMessage,
} from "./agentProgress";
import type { ChatMessage } from "../chat/messageTypes";
import type { ToolDefinition } from "../tools/toolTypes";
import { runAgentLoop } from "../chat/agentLoop";

export type RunAgentInput = {
  agentId: string;
  parentSessionId: string;
  agent: AgentDefinition;
  prompt: string;
  model: AgentModel;
  tools: ToolDefinition[];
  abortSignal: AbortSignal;
  onMessage?: (message: ChatMessage) => void | Promise<void>;
  onProgress?: (progress: ReturnType<typeof getAgentProgress>) => void;
};

export async function runAgent(input: RunAgentInput): Promise<CompletedAgentOutput> {
  const startTime = Date.now();
  const tracker = createAgentProgressTracker();
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: input.prompt }],
    },
  ];

  const result = await runWithAgentContext(
    {
      agentId: input.agentId,
      agentType: input.agent.agentType,
      parentSessionId: input.parentSessionId,
    },
    async () => {
      let finalText = "";

      for await (const message of runAgentLoop({
        systemPrompt: input.agent.getSystemPrompt(),
        messages,
        tools: input.tools,
        model: input.model,
        maxTurns: input.agent.maxTurns ?? 12,
        abortSignal: input.abortSignal,
      })) {
        messages.push(message);
        await input.onMessage?.(message);

        updateAgentProgressFromMessage(tracker, message);
        input.onProgress?.(getAgentProgress(tracker));

        if (message.role === "assistant") {
          const textParts = message.content
            .filter(part => part.type === "text")
            .map(part => part.text);

          if (textParts.length > 0) {
            finalText = textParts.join("\n");
          }
        }
      }

      return finalText;
    },
  );

  return {
    status: "completed",
    agentId: input.agentId,
    agentType: input.agent.agentType,
    prompt: input.prompt,
    content: result,
    totalToolUseCount: tracker.toolUseCount,
    totalDurationMs: Date.now() - startTime,
  };
}
```

这里假设你已有 `runAgentLoop()`，它能像前面章节一样按消息流返回 assistant message 和 tool result。

关键点是：子 Agent 的 `messages` 从一个 user prompt 开始，不直接复用主对话历史。

如果你把主对话完整塞给子 Agent，会带来三个问题：

- token 变大。
- 子 Agent 看到太多无关信息，执行边界变模糊。
- 子 Agent 可能误以为自己要接管主 Agent 的最终决策。

真实工程有一种 fork 模式会继承父上下文，但那是额外能力。Mini 当前不做。

## 后台生命周期

后台 Agent 需要一个生命周期函数，负责从启动跑到终态，并写入 task 输出。

```ts
// src/agents/runAgent.ts
import {
  appendAgentTaskMessage,
  completeAgentTask,
  failAgentTask,
  updateAgentTaskProgress,
} from "../tasks/localAgentTask";

export async function runBackgroundAgent(input: RunAgentInput & {
  taskId: string;
}): Promise<void> {
  try {
    const output = await runAgent({
      ...input,
      onMessage: async message => {
        await input.onMessage?.(message);

        if (message.role !== "assistant") {
          return;
        }

        const text = message.content
          .filter(part => part.type === "text")
          .map(part => part.text)
          .join("\n");

        if (text) {
          await appendAgentTaskMessage(input.taskId, text);
        }
      },
      onProgress: progress => {
        updateAgentTaskProgress(input.taskId, progress);
        input.onProgress?.(progress);
      },
    });

    await appendAgentTaskMessage(input.taskId, `\nFinal result:\n${output.content}`);
    completeAgentTask(input.taskId, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendAgentTaskMessage(input.taskId, `\nAgent failed:\n${message}`);
    failAgentTask(input.taskId, message);
  }
}
```

真实工程里完成状态会先写入 task store，再做后续的安全分类、工作树清理和通知装饰。原因很直接：读取输出的工具可能正在等待任务终态，不能被额外的慢操作卡住。

Mini 也应遵守这个原则：

```text
先把 task 标记成 completed / failed / killed。
再做通知、清理和额外总结。
```

## Agent Tool

现在实现 `Agent` 工具。

```ts
// src/tools/agentTool.ts
import type { ToolDefinition } from "./toolTypes";
import type { AgentToolInput, AgentToolOutput } from "../agents/agentTypes";
import type { AgentRegistry } from "../agents/agentRegistry";
import { resolveAgentTools } from "../agents/agentTools";
import { createAgentId, registerLocalAgentTask } from "../tasks/localAgentTask";
import { runAgent, runBackgroundAgent } from "../agents/runAgent";

export function createAgentTool(input: {
  registry: AgentRegistry;
  availableTools: ToolDefinition[];
  parentSessionId: string;
}): ToolDefinition<AgentToolInput, AgentToolOutput> {
  return {
    name: "agent",
    description: "Launch a specialized sub-agent for a complex task",
    inputSchema: {
      type: "object",
      required: ["description", "prompt"],
      properties: {
        description: {
          type: "string",
          description: "Short description of the task",
        },
        prompt: {
          type: "string",
          description: "Complete instructions for the sub-agent",
        },
        subagent_type: {
          type: "string",
          description: "Agent type to launch",
        },
        model: {
          type: "string",
          enum: ["default", "fast", "smart"],
        },
        run_in_background: {
          type: "boolean",
          description: "Run the agent as a background task",
        },
      },
    },
    async call(args, context) {
      const agent = input.registry.getAgent(args.subagent_type);
      const shouldRunBackground = args.run_in_background === true || agent.background === true;

      const { resolvedTools, invalidTools } = resolveAgentTools(
        agent,
        input.availableTools,
        { isBackground: shouldRunBackground },
      );

      if (invalidTools.length > 0) {
        throw new Error(
          `Agent ${agent.agentType} references unavailable tools: ${invalidTools.join(", ")}`,
        );
      }

      if (shouldRunBackground) {
        const task = await registerLocalAgentTask({
          description: args.description,
          prompt: args.prompt,
          agentType: agent.agentType,
          toolUseId: context.toolUseId,
        });

        void runBackgroundAgent({
          taskId: task.id,
          agentId: task.agentId,
          parentSessionId: input.parentSessionId,
          agent,
          prompt: args.prompt,
          model: args.model ?? agent.model ?? "default",
          tools: resolvedTools,
          abortSignal: task.abortController.signal,
        });

        return {
          status: "async_launched",
          agentId: task.agentId,
          description: args.description,
          prompt: args.prompt,
          outputFile: task.outputFile,
        };
      }

      const agentId = createAgentId();

      return await runAgent({
        agentId,
        parentSessionId: input.parentSessionId,
        agent,
        prompt: args.prompt,
        model: args.model ?? agent.model ?? "default",
        tools: resolvedTools,
        abortSignal: context.abortSignal,
      });
    },
  };
}
```

同步和后台共用同一个 `runAgent()`。区别只在于：

- 同步 Agent 共享当前工具调用的取消信号。
- 后台 Agent 拥有自己的 `AbortController`。
- 后台 Agent 会注册成 task 并写 output file。
- 同步 Agent 的结果直接返回给主 Agent。

## 权限模式

后台 Agent 最大的问题是权限确认。

假设子 Agent 正在后台跑，突然需要写文件并弹出确认，用户未必正在看这个子 Agent。真实工程会让后台 Agent 避免直接弹窗，或者提前把权限模式和工具范围设置好。

Mini 可以先采用简单规则：

```ts
// src/agents/agentTools.ts
export function assertAgentCanRunInBackground(agent: AgentDefinition): void {
  if (agent.permissionMode === "ask") {
    throw new Error(
      `Agent ${agent.agentType} cannot run in background with ask permission mode`,
    );
  }
}
```

在 `AgentTool` 后台分支里加上：

```ts
if (shouldRunBackground) {
  assertAgentCanRunInBackground(agent);
}
```

如果你的 Mini 已经实现了自动拒绝权限，也可以允许后台 Agent 进入 `ask` 模式，但工具一旦需要确认就返回拒绝。这样更安全，但用户体验会差一些。

推荐策略：

- 只读后台 Agent：允许。
- 明确 `acceptEdits` 的后台 Agent：允许。
- 需要交互确认的后台 Agent：拒绝启动。

## 通知主 Agent

第二十九章已经做过 task notification。现在给 `local_agent` 增加更丰富的完成通知。

```ts
// src/tasks/taskNotifications.ts
import type { LocalAgentTaskState } from "./taskTypes";

export function buildAgentTaskNotification(task: LocalAgentTaskState): string {
  const statusLine =
    task.status === "completed"
      ? `Agent "${task.description}" completed`
      : task.status === "failed"
        ? `Agent "${task.description}" failed: ${task.error ?? "Unknown error"}`
        : `Agent "${task.description}" was stopped`;

  const result = task.result?.content
    ? `\n<result>${task.result.content}</result>`
    : "";

  const usage = task.result
    ? `\n<usage><tool_uses>${task.result.totalToolUseCount}</tool_uses><duration_ms>${task.result.totalDurationMs}</duration_ms></usage>`
    : "";

  return `<task_notification>
<task_id>${task.id}</task_id>
<output_file>${task.outputFile}</output_file>
<status>${task.status}</status>
<summary>${statusLine}</summary>${result}${usage}
</task_notification>`;
}
```

主循环在每轮开始前扫描终态但未通知的任务：

```ts
// src/chat/agentLoop.ts
import { listTasks, markTaskNotified } from "../tasks/taskStore";
import { buildAgentTaskNotification } from "../tasks/taskNotifications";

export function drainTaskNotifications(): string[] {
  const notifications: string[] = [];

  for (const task of listTasks()) {
    if (task.notified) {
      continue;
    }

    if (task.status === "running" || task.status === "pending") {
      continue;
    }

    if (task.type === "local_agent") {
      notifications.push(buildAgentTaskNotification(task));
      markTaskNotified(task.id);
    }
  }

  return notifications;
}
```

注入给模型时，使用 system 或 tool notification message 都可以。关键是主 Agent 必须看到：

- 哪个任务完成了。
- 结果在哪里。
- 最终摘要是什么。
- 输出文件在哪里。
- 状态是 completed、failed 还是 killed。

## 读取 Agent 输出

第二十九章的 `TaskOutputTool` 已经能读 task output。现在只需要识别 `local_agent`。

```ts
// src/tools/taskOutputTool.ts
import { readTaskOutput } from "../tasks/diskOutput";
import type { TaskState } from "../tasks/taskTypes";

export async function formatTaskOutput(task: TaskState): Promise<string> {
  if (task.type === "local_agent") {
    if (task.result?.content) {
      return [
        `Agent: ${task.agentType}`,
        `Status: ${task.status}`,
        "",
        task.result.content,
      ].join("\n");
    }

    return await readTaskOutput(task.id);
  }

  return await readTaskOutput(task.id);
}
```

真实工程会优先返回干净的最终答案，而不是原始 JSONL transcript。Mini 也应该这样：用户想读的是结果，不是每个中间消息块。

## 停止 Agent

`TaskStopTool` 不需要知道每类任务的细节。它调用统一入口 `stopTask()`。

```ts
// src/tasks/stopTask.ts
import { getTask } from "./taskStore";
import { killShellTask } from "./localShellTask";
import { killAgentTask } from "./localAgentTask";

export async function stopTask(taskId: string): Promise<{
  taskId: string;
  taskType: string;
  command: string;
}> {
  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (task.status !== "running") {
    throw new Error(`Task ${taskId} is not running`);
  }

  if (task.type === "local_bash") {
    killShellTask(taskId);
    return {
      taskId,
      taskType: task.type,
      command: task.command,
    };
  }

  if (task.type === "local_agent") {
    killAgentTask(taskId);
    return {
      taskId,
      taskType: task.type,
      command: task.description,
    };
  }

  task satisfies never;
}
```

只取消 Agent 自己还不够。子 Agent 可能启动了 shell 后台任务。真实工程会在子 Agent 结束时按 agent id 清理它创建的 shell tasks。

Mini 可以给 shell task 增加 `agentId`：

```ts
// src/tasks/taskTypes.ts
export type LocalShellTaskState = TaskStateBase & {
  type: "local_bash";
  command: string;
  isBackgrounded: boolean;
  agentId?: string;
};
```

BashTool 创建任务时读当前 Agent context：

```ts
// src/tools/bashTool.ts
import { getAgentContext } from "../agents/agentContext";

const agentContext = getAgentContext();

const task = await registerLocalShellTask({
  command,
  description,
  agentId: agentContext?.agentId,
});
```

Agent 生命周期结束时清理：

```ts
// src/tasks/localShellTask.ts
import { listTasks } from "./taskStore";

export function killShellTasksForAgent(agentId: string): void {
  for (const task of listTasks()) {
    if (task.type !== "local_bash") {
      continue;
    }

    if (task.agentId !== agentId) {
      continue;
    }

    if (task.status !== "running") {
      continue;
    }

    killShellTask(task.id);
  }
}
```

然后在 `runAgent()` 外层加 `finally`：

```ts
try {
  return await runAgent(input);
} finally {
  killShellTasksForAgent(input.agentId);
}
```

这一步非常重要。否则一个后台 Agent 被停止后，它启动的测试 watch、dev server 或脚本可能还在继续跑。

## 工具注册

把 `Agent` 工具加入工具注册表。

```ts
// src/tools/toolRegistry.ts
import { createAgentRegistry } from "../agents/agentRegistry";
import { createAgentTool } from "./agentTool";

export async function createToolRegistry(input: {
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

  const agentRegistry = createAgentRegistry();
  const agentTool = createAgentTool({
    registry: agentRegistry,
    availableTools: baseTools,
    parentSessionId: input.parentSessionId,
  });

  return [...baseTools, agentTool];
}
```

这里有一个细节：`Agent` 工具收到的 `availableTools` 不应该包含它自己，否则子 Agent 可能无限递归。

如果你确实想支持子 Agent 再派生子 Agent，需要额外限制深度：

```ts
const MAX_AGENT_DEPTH = 2;
```

本章先不开放递归。

## 给主 Agent 的工具说明

`Agent` 工具的 prompt 不能只写“launch agent”。它必须告诉主 Agent 什么时候该用、什么时候不该用、怎么写 prompt。

```ts
// src/tools/agentToolPrompt.ts
import type { AgentDefinition } from "../agents/agentTypes";

export function buildAgentToolPrompt(agents: AgentDefinition[]): string {
  const agentLines = agents
    .map(agent => {
      const tools = agent.tools?.join(", ") ?? "all tools";
      return `- ${agent.agentType}: ${agent.whenToUse} (tools: ${tools})`;
    })
    .join("\n");

  return `Launch a specialized sub-agent for complex, multi-step tasks.

Available agent types:
${agentLines}

Usage rules:
- Always include a short description.
- Write a complete prompt. The sub-agent has not seen the parent conversation.
- Use explorer for read-only code search and investigation.
- Use reviewer for code review.
- Use background mode only when the work is independent.
- Do not launch a background agent and then poll it repeatedly. Wait for the completion notification unless the user asks for progress.
- Do not delegate vague work such as "figure it out and fix it". Include files, constraints, expected output, and whether edits are allowed.`;
}
```

这段说明会显著影响模型是否正确使用子 Agent。

好的子 Agent prompt：

```text
查找 CLI 登录流程的入口。只读，不修改文件。请返回：
1. 入口 command 注册位置。
2. 实际执行登录校验的位置。
3. token 或 session 写入的位置。
4. 每个结论对应的文件路径和函数名。
```

差的 prompt：

```text
看看登录怎么做的
```

子 Agent 不知道主 Agent 的上下文，所以 prompt 越完整，结果越稳定。

## 并行派发

多 Agent 真正有用的场景是并行：

```text
主 Agent 同时派发：
- explorer 查找实现入口。
- runner 跑相关测试。
- reviewer 看当前 diff 风险。
```

但不是所有任务都应该并行。判断标准很简单：

```text
如果一个任务的输出会决定另一个任务怎么做，就不要并行。
如果两个任务读不同信息、互不依赖，可以并行。
```

例子：

```text
可以并行：
- Agent A 查 API 层。
- Agent B 查 UI 层。
- Agent C 跑测试。

不要并行：
- Agent A 查 bug 原因。
- Agent B 基于原因修复 bug。
```

第二种应该先等 A 的结论，再由主 Agent 决定是否修复。

## 同步还是后台

同步 Agent 适合：

- 主 Agent 必须依赖结果才能继续。
- 任务预计很快完成。
- 任务可能需要权限交互。
- 用户正在等明确答案。

后台 Agent 适合：

- 跑测试、构建、扫描等耗时工作。
- 多个独立探索任务。
- 用户可以先收到“已启动”的回复。
- 子 Agent 有明确权限，不需要中途询问。

不要把所有子 Agent 都后台化。后台化会带来额外复杂度：

- 结果不是立即可用。
- 主 Agent 需要等待通知再继续整合。
- 后台 Agent 可能与主 Agent 同时操作相同文件。
- 取消和清理更重要。

默认策略：

```text
先同步。
只有独立、耗时、可安全放后台的任务才用 run_in_background。
```

## Transcript

子 Agent 的输出文件是给任务系统看的。transcript 是给恢复、调试和审计看的。

如果你已经在第二十二章做了 transcript，可以给子 Agent 加一个子目录：

```text
.mini/transcripts/<sessionId>/
  main.jsonl
  subagents/
    a_2m9kq1p8.jsonl
    a_z7c0w6ta.jsonl
```

每条子 Agent message 都记录：

```ts
// src/transcript/types.ts
export type TranscriptMessage = {
  sessionId: string;
  agentId?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  createdAt: string;
};
```

`runAgent()` 里写入：

```ts
await appendTranscript({
  sessionId: input.parentSessionId,
  agentId: input.agentId,
  role: message.role,
  content: message.content,
  createdAt: new Date().toISOString(),
});
```

后台输出文件可以只写人类可读结果；transcript 保存完整消息和工具细节。

## 错误处理

子 Agent 错误不要直接吞掉，也不要让主循环崩掉。

同步 Agent：

```text
Agent 工具返回错误，由主 Agent 决定如何回应用户。
```

后台 Agent：

```text
task 标记为 failed，写 output file，下一轮注入通知。
```

常见错误：

- Agent 类型不存在。
- Agent 引用了不存在的工具。
- 后台 Agent 需要交互权限。
- 子 Agent 达到 maxTurns。
- 子 Agent 被用户停止。
- 子 Agent 内部工具调用失败。

建议错误文本包含：

```text
agentType
description
status
error message
output file
```

不要包含密钥、环境变量值或完整请求体。

## 测试

先测纯函数。

```ts
// src/agents/__tests__/agentRegistry.test.ts
import { describe, expect, test } from "bun:test";
import { createAgentRegistry } from "../agentRegistry";

describe("createAgentRegistry", () => {
  test("returns general-purpose by default", () => {
    const registry = createAgentRegistry();
    expect(registry.getAgent(undefined).agentType).toBe("general-purpose");
  });

  test("project agent overrides built-in agent with same type", () => {
    const registry = createAgentRegistry([
      {
        agentType: "explorer",
        whenToUse: "custom explorer",
        source: "project",
        tools: ["read_file"],
        getSystemPrompt: () => "custom",
      },
    ]);

    expect(registry.getAgent("explorer").source).toBe("project");
    expect(registry.getAgent("explorer").getSystemPrompt()).toBe("custom");
  });
});
```

再测工具解析。

```ts
// src/agents/__tests__/agentTools.test.ts
import { describe, expect, test } from "bun:test";
import { resolveAgentTools } from "../agentTools";

const tools = [
  { name: "read_file" },
  { name: "write_file" },
  { name: "agent" },
] as never;

describe("resolveAgentTools", () => {
  test("removes globally disallowed tools", () => {
    const result = resolveAgentTools(
      {
        agentType: "worker",
        whenToUse: "test",
        source: "project",
        tools: ["*"],
        getSystemPrompt: () => "test",
      },
      tools,
      { isBackground: false },
    );

    expect(result.resolvedTools.map(tool => tool.name)).toEqual([
      "read_file",
      "write_file",
    ]);
  });

  test("honors agent disallowed tools", () => {
    const result = resolveAgentTools(
      {
        agentType: "reader",
        whenToUse: "test",
        source: "project",
        tools: ["*"],
        disallowedTools: ["write_file"],
        getSystemPrompt: () => "test",
      },
      tools,
      { isBackground: false },
    );

    expect(result.resolvedTools.map(tool => tool.name)).toEqual(["read_file"]);
  });
});
```

然后测 Agent Tool：

```ts
// src/tools/__tests__/agentTool.test.ts
import { describe, expect, test } from "bun:test";

describe("agent tool", () => {
  test("returns completed output for sync agent", async () => {
    // mock runAgentLoop 返回一条 assistant 文本消息
  });

  test("returns async_launched for background agent", async () => {
    // mock runBackgroundAgent，不等待真实执行
  });

  test("rejects unknown agent type", async () => {
    // subagent_type 不存在时应报错，并列出可用 agent
  });
});
```

最后跑：

```bash
bun test src/agents/__tests__/agentRegistry.test.ts
bun test src/agents/__tests__/agentTools.test.ts
bun test src/tools/__tests__/agentTool.test.ts
bun run typecheck
```

## 验收清单

本章完成后，手动检查：

- `Agent` 工具能默认启动 `general-purpose`。
- 指定 `subagent_type: "explorer"` 时，只能拿到只读工具。
- 同步 Agent 能返回最终文本。
- 后台 Agent 能立即返回 `async_launched`。
- 后台 Agent 有 task id 和 output file。
- `/tasks` 能看到后台 Agent。
- `/tasks read <id>` 能读到最终结果。
- `/tasks stop <id>` 能停止运行中的后台 Agent。
- 子 Agent 被停止后，它启动的 shell task 也会被清理。
- 后台 Agent 完成后，主循环能收到 `<task_notification>`。
- 子 Agent 的 transcript 带 `agentId`。
- `bun run typecheck` 通过。

## 常见坑

### 1. 子 Agent 直接复用父消息

这样看起来省事，但会让子 Agent 边界不清晰。Mini 当前应该让子 Agent 从单条 prompt 开始。

### 2. 后台 Agent 等待权限弹窗

后台任务不应该卡在交互确认上。要么启动前拒绝，要么自动拒绝需要确认的工具。

### 3. 输出只存在内存里

后台 Agent 的输出必须落盘。否则会话中断后就没法读，也不利于输出过大时截断。

### 4. 停止 Agent 但没停子进程

Agent 可能通过 Bash 启动了测试、构建或 watch。停止 Agent 时要按 `agentId` 清理它创建的 shell task。

### 5. 子 Agent prompt 太短

子 Agent 没有父对话上下文。主 Agent 必须把目标、约束、已知信息和期望输出写清楚。

### 6. 并行任务写同一批文件

两个后台 Agent 同时改同一文件会制造冲突。Mini 当前没有工作树隔离，所以后台 Agent 更适合只读任务或测试任务。

### 7. 子 Agent 没有 maxTurns

每个子 Agent 都应该有 turn 上限，避免错误 prompt 导致无限循环。

## 本章小结

第三十章把 Mini 从“单 Agent 工具执行器”扩展成了“主 Agent + 子 Agent 调度器”。

现在系统具备了：

- Agent 定义和注册。
- 子 Agent 工具隔离。
- 子 Agent 独立 system prompt 和消息上下文。
- 同步 Agent 执行。
- 后台 Agent task。
- Agent progress、输出、停止和完成通知。
- 子 Agent transcript 归属。

这一步之后，Mini 已经具备多 Agent 的核心执行模型。

下一章可以继续做 **Agent 配置文件与项目级 Agent**：让用户在仓库里写 `.mini/agents/*.md`，用 frontmatter 定义 agent type、工具、模型、权限和专属 prompt。
