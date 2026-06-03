# 第 18 章：Token 预算与上下文裁剪

第十七章实现了 Memory，Mini 已经能带着项目约定工作。但 Memory 带来一个新问题：上下文变多了。

一个 Coding Agent 的上下文不是只有聊天历史，它至少包含：

- system prompt
- tool schema
- Memory
- 当前时间、工作目录、Git 状态
- 用户消息
- assistant 消息
- tool use
- tool result
- 文件内容和命令输出

如果不做预算，项目越复杂、工具结果越多，模型请求就越容易撞上 context window。真实 Claude Code 的解决方式不是“全部塞进去，失败再说”，而是在请求前动态计算上下文，并在必要时裁剪、压缩或阻塞。

本章为 Mini 实现一个轻量版本：

- 估算每部分 token。
- 给 Memory、运行时上下文、消息历史、工具结果分配预算。
- 对超长文本做可解释截断。
- 对旧工具结果做 preview 替换。
- 提供 `/context` 命令查看上下文使用情况。

注意：真实工程里还有一个名为 `TOKEN_BUDGET` 的 feature，用于让模型按用户指定的输出 token 目标持续工作。本章讲的不是那个输出预算，而是请求输入侧的上下文预算。

## 本章目标

完成本章后，你会得到：

1. `src/context/tokenCounter.ts`：近似 token 计数。
2. `src/context/budget.ts`：上下文窗口和各类预算配置。
3. `src/context/truncate.ts`：按 token 预算截断文本。
4. `src/context/toolResultBudget.ts`：裁剪过大的工具结果。
5. `src/context/contextPreparer.ts`：请求前统一准备上下文。
6. `/context` 命令：展示当前上下文占用。
7. 对上下文裁剪行为的单元测试。

这一章的工程目标是：每次请求模型前，Mini 都知道自己要发送多少上下文，以及哪些内容被裁剪了。

## 本章完成效果

用户在长对话后输入：

```txt
> /context
```

Mini 输出类似：

```txt
Context Usage

Window: 200000 tokens
Effective input budget: 179000 tokens
Estimated used: 48620 tokens

Category             Tokens
System prompt         4200
Memory files          1800
Runtime context        900
Messages            41720
Free space          130380
Reserved output       8000
Compact buffer       13000
```

如果某个 shell 命令输出 120000 字符，Mini 不再把完整输出塞回模型，而是替换成：

```txt
[Tool result truncated. Original ~30000 tokens. Showing first ~2000 tokens.]

...preview...
```

模型仍然知道工具执行过，也能看到预览，但不会被单个工具结果撑爆上下文。

## 本章项目结构变化

新增：

```txt
src/
  context/
    tokenCounter.ts
    budget.ts
    truncate.ts
    toolResultBudget.ts
    contextPreparer.ts
tests/
  context-budget.test.ts
```

修改：

```txt
src/chat/session.ts
src/chat/chatLoop.ts
```

如果你前面章节的文件名不同，对应职责即可：

- 发模型请求前，调用 `ContextPreparer.prepare()`。
- slash command 分发处，添加 `/context`。
- 工具执行结果写入消息前，仍保留原结果；请求前再裁剪发送视图。

注意不要把第 13、15 章的 plan mode 接线覆盖掉：

- `sendUserMessageStream()` / `runUserTurn()` 仍要支持 `mode: "plan"`。
- `/plan` 仍然进入 Mini plan mode。
- `/plan show` 才查看当前计划。
- plan mode 下仍然只暴露 read-only tools 和 `update_plan`。

`ContextPreparer.prepare()` 应该处理“发给模型的视图”，不要改掉 session transcript 里的原始消息和 plan 状态。

## 为什么不能只靠模型报错

最简单的做法是：请求超长了再让 API 返回错误。

这个做法在 Coding Agent 里很差：

1. 用户等到最后才看到失败。
2. 大型请求会浪费网络和等待时间。
3. 工具结果越大，失败概率越高。
4. 第三方 provider 的错误格式不统一。
5. 超长失败后很难知道该删哪一部分。

更稳的做法是请求前先生成一个“API 视图”：

```txt
完整会话历史
   |
   v
请求前上下文准备
   |
   |-- Memory 限额
   |-- Runtime context 限额
   |-- Tool result 限额
   |-- Message history 限额
   v
可发送给模型的 messages + system
```

注意这里有一个重要设计：裁剪的是发送给 API 的视图，不是用户本地 transcript。

本地 transcript 可以保存完整历史，便于恢复、审计和后续压缩。模型请求只拿预算内的内容。

## 预算模型

Mini 先采用固定预算：

```txt
Context window:       200000
Reserved output:        8000
Compact buffer:        13000
Effective input:      179000
```

其中：

- `Reserved output` 是给模型本轮输出预留的空间。
- `Compact buffer` 是安全缓冲，避免下一轮马上撞线。
- `Effective input` 是本轮最多可发送的输入上下文。

在 `Effective input` 内部，再做分类预算：

```txt
System prompt        固定，不轻易裁剪
Memory files         最多 20000 tokens
Runtime context      最多 12000 tokens
Messages             吃剩余预算
Tool result          每条最多 4000 tokens
```

这不是唯一正确的比例。真正重要的是把它集中成配置，而不是散落在各个模块里。

## 完整核心代码

### `src/context/tokenCounter.ts`

Mini 第一版使用近似估算：大约 4 个字符算 1 个 token。JSON、命令输出、代码片段会有偏差，但足够做本地预算。

```ts
export function estimateTokens(text: string, bytesPerToken = 4): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / bytesPerToken);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value), 3);
}

export type TextBlock = {
  type: "text";
  text: string;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};

export type RedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export type ChatMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === "text") {
    return estimateTokens(block.text);
  }

  if (block.type === "thinking") {
    return estimateTokens(block.thinking);
  }

  if (block.type === "redacted_thinking") {
    return estimateTokens(block.data);
  }

  if (block.type === "tool_use") {
    return estimateTokens(`${block.name}\n${JSON.stringify(block.input)}`);
  }

  return estimateTokens(block.content);
}

export function estimateMessageTokens(message: ChatMessage): number {
  if (typeof message.content === "string") {
    return estimateTokens(message.content);
  }

  return message.content.reduce((sum, block) => {
    return sum + estimateBlockTokens(block);
  }, 0);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    return sum + estimateMessageTokens(message);
  }, 0);
}
```

真实工程会优先使用 provider 的 count tokens API，失败时才回退到估算。Mini 面向 Anthropic-compatible provider，很多 provider 并不支持精确计数，所以先把估算做好。

这里继续保留第 7 章加入的 `thinking` / `redacted_thinking`。

它们不会进入可见回答，但仍然占用上下文窗口；如果这里漏掉，预算层会低估历史长度。

### `src/context/budget.ts`

```ts
export type ContextBudgetConfig = {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  compactBufferTokens: number;
  memoryBudgetTokens: number;
  runtimeBudgetTokens: number;
  maxToolResultTokens: number;
};

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  contextWindowTokens: 200_000,
  reservedOutputTokens: 8_000,
  compactBufferTokens: 13_000,
  memoryBudgetTokens: 20_000,
  runtimeBudgetTokens: 12_000,
  maxToolResultTokens: 4_000,
};

export function getEffectiveInputBudget(config: ContextBudgetConfig): number {
  return Math.max(
    0,
    config.contextWindowTokens -
      config.reservedOutputTokens -
      config.compactBufferTokens,
  );
}

export function readBudgetConfigFromEnv(): ContextBudgetConfig {
  const contextWindow = Number(process.env.CCMINI_CONTEXT_WINDOW_TOKENS);

  return {
    ...DEFAULT_CONTEXT_BUDGET,
    contextWindowTokens:
      Number.isFinite(contextWindow) && contextWindow > 0
        ? contextWindow
        : DEFAULT_CONTEXT_BUDGET.contextWindowTokens,
  };
}
```

这里只暴露一个环境变量用于测试和本地调试。不要一开始就把所有预算都做成配置项，否则用户会被不稳定的参数淹没。

### `src/context/truncate.ts`

```ts
import { estimateTokens } from "./tokenCounter";

export type TruncateResult = {
  text: string;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
};

export function truncateTextToTokens(text: string, maxTokens: number): TruncateResult {
  const originalTokens = estimateTokens(text);

  if (originalTokens <= maxTokens) {
    return {
      text,
      originalTokens,
      finalTokens: originalTokens,
      truncated: false,
    };
  }

  const maxChars = Math.max(0, maxTokens * 4);
  const preview = text.slice(0, maxChars).trimEnd();
  const marker =
    `\n\n[Content truncated. Original ~${originalTokens} tokens. ` +
    `Showing first ~${maxTokens} tokens.]`;
  const finalText = `${preview}${marker}`;

  return {
    text: finalText,
    originalTokens,
    finalTokens: estimateTokens(finalText),
    truncated: true,
  };
}
```

裁剪文本时一定要留下 marker。静默截断很危险，模型会误以为自己看到了完整内容。

### `src/context/toolResultBudget.ts`

```ts
import {
  type ChatMessage,
  type ContentBlock,
  estimateTokens,
} from "./tokenCounter";
import { truncateTextToTokens } from "./truncate";

export type ToolResultBudgetReport = {
  truncatedToolResults: number;
  savedTokens: number;
};

function truncateToolResultContent(content: string, maxTokens: number): {
  content: string;
  savedTokens: number;
  truncated: boolean;
} {
  const originalTokens = estimateTokens(content);
  if (originalTokens <= maxTokens) {
    return { content, savedTokens: 0, truncated: false };
  }

  const result = truncateTextToTokens(content, maxTokens);
  const header =
    `[Tool result truncated. Original ~${originalTokens} tokens. ` +
    `Showing first ~${maxTokens} tokens.]\n\n`;

  return {
    content: `${header}${result.text}`,
    savedTokens: Math.max(0, originalTokens - result.finalTokens),
    truncated: true,
  };
}

export function applyToolResultBudget(
  messages: ChatMessage[],
  maxToolResultTokens: number,
): { messages: ChatMessage[]; report: ToolResultBudgetReport } {
  let truncatedToolResults = 0;
  let savedTokens = 0;
  let changed = false;

  const nextMessages = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;

    const nextContent = message.content.map((block): ContentBlock => {
      if (block.type !== "tool_result") return block;

      const result = truncateToolResultContent(block.content, maxToolResultTokens);
      if (!result.truncated) return block;

      changed = true;
      truncatedToolResults += 1;
      savedTokens += result.savedTokens;

      return {
        ...block,
        content: result.content,
      };
    });

    return {
      ...message,
      content: nextContent,
    };
  });

  return {
    messages: changed ? nextMessages : messages,
    report: {
      truncatedToolResults,
      savedTokens,
    },
  };
}
```

这一版对所有工具结果使用同一个上限。真实项目里会按工具设置不同阈值，例如 shell 输出可以低一些，文件读取可以高一些。

### `src/context/contextPreparer.ts`

```ts
import {
  type ContextBudgetConfig,
  DEFAULT_CONTEXT_BUDGET,
  getEffectiveInputBudget,
} from "./budget";
import {
  type ChatMessage,
  estimateMessagesTokens,
  estimateTokens,
} from "./tokenCounter";
import { truncateTextToTokens } from "./truncate";
import { applyToolResultBudget } from "./toolResultBudget";

export type ContextCategory = {
  name: string;
  tokens: number;
};

export type PreparedContext = {
  system: string;
  messages: ChatMessage[];
  categories: ContextCategory[];
  totalTokens: number;
  effectiveInputBudget: number;
  contextWindowTokens: number;
  truncated: boolean;
};

export type PrepareContextInput = {
  systemPrompt: string;
  memoryPrompt: string | null;
  runtimeContext: string;
  messages: ChatMessage[];
  config?: ContextBudgetConfig;
};

function fitSection(name: string, text: string, maxTokens: number): {
  name: string;
  text: string;
  tokens: number;
  truncated: boolean;
} {
  if (!text.trim()) {
    return { name, text: "", tokens: 0, truncated: false };
  }

  const result = truncateTextToTokens(text, maxTokens);
  return {
    name,
    text: result.text,
    tokens: result.finalTokens,
    truncated: result.truncated,
  };
}

function keepNewestMessages(messages: ChatMessage[], maxTokens: number): {
  messages: ChatMessage[];
  tokens: number;
  truncated: boolean;
} {
  const kept: ChatMessage[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const tokens = estimateMessagesTokens([message]);

    if (kept.length > 0 && used + tokens > maxTokens) {
      break;
    }

    kept.unshift(message);
    used += tokens;
  }

  return {
    messages: kept,
    tokens: used,
    truncated: kept.length < messages.length,
  };
}

export class ContextPreparer {
  constructor(
    private readonly config: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET,
  ) {}

  prepare(input: PrepareContextInput): PreparedContext {
    const config = input.config ?? this.config;
    const effectiveInputBudget = getEffectiveInputBudget(config);

    const systemTokens = estimateTokens(input.systemPrompt);
    const memory = fitSection(
      "Memory files",
      input.memoryPrompt ?? "",
      config.memoryBudgetTokens,
    );
    const runtime = fitSection(
      "Runtime context",
      input.runtimeContext,
      config.runtimeBudgetTokens,
    );

    const fixedTokens = systemTokens + memory.tokens + runtime.tokens;
    const messageBudget = Math.max(0, effectiveInputBudget - fixedTokens);

    const toolBudgeted = applyToolResultBudget(
      input.messages,
      config.maxToolResultTokens,
    );
    const messages = keepNewestMessages(toolBudgeted.messages, messageBudget);

    const system = [input.systemPrompt, memory.text, runtime.text]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");

    const categories: ContextCategory[] = [
      { name: "System prompt", tokens: systemTokens },
      { name: "Memory files", tokens: memory.tokens },
      { name: "Runtime context", tokens: runtime.tokens },
      { name: "Messages", tokens: messages.tokens },
      {
        name: "Free space",
        tokens: Math.max(0, effectiveInputBudget - fixedTokens - messages.tokens),
      },
      { name: "Reserved output", tokens: config.reservedOutputTokens },
      { name: "Compact buffer", tokens: config.compactBufferTokens },
    ];

    return {
      system,
      messages: messages.messages,
      categories,
      totalTokens: fixedTokens + messages.tokens,
      effectiveInputBudget,
      contextWindowTokens: config.contextWindowTokens,
      truncated:
        memory.truncated ||
        runtime.truncated ||
        messages.truncated ||
        toolBudgeted.report.truncatedToolResults > 0,
    };
  }
}
```

这里有几个刻意简化：

- 不做 API 精确计数。
- 不做自动摘要。
- 不处理图片和文档 token。
- 不处理复杂 tool pair 边界。

但它已经建立了正确结构：所有上下文进入模型前，都必须经过同一个预算入口。

## 接入 `ChatSession`

在第 11 章的 `ContextManager` 或第 15 章的完整闭环里，找到发模型请求前准备 messages 的地方。

将：

```ts
const response = await this.agentLoop.run({
  system: this.baseSystemPrompt,
  messages: this.messages,
});
```

改成：

```ts
import { ContextPreparer } from "../context/contextPreparer";

export class ChatSession {
  private readonly contextPreparer = new ContextPreparer();

  async send(input: string): Promise<void> {
    this.messages.push({ role: "user", content: input });

    const memoryPrompt = await this.memory.getPrompt();
    const runtimeContext = await this.runtimeContext.render();

    const prepared = this.contextPreparer.prepare({
      systemPrompt: this.baseSystemPrompt,
      memoryPrompt,
      runtimeContext,
      messages: this.messages,
    });

    const response = await this.agentLoop.run({
      system: prepared.system,
      messages: prepared.messages,
    });

    this.messages.push(response);
  }
}
```

关键点：`this.messages` 仍然保存完整历史，`prepared.messages` 只是本次请求视图。

这和第十七章 Memory 的原则一致：运行时上下文参与请求，但不污染 transcript。

## 实现 `/context`

为了让用户知道裁剪是否发生，添加一个 `/context` 命令。

```ts
import type { PreparedContext } from "../context/contextPreparer";

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

export function renderContextReport(context: PreparedContext): string {
  const lines: string[] = [];

  lines.push("Context Usage");
  lines.push("");
  lines.push(`Window: ${formatTokens(context.contextWindowTokens)} tokens`);
  lines.push(`Effective input budget: ${formatTokens(context.effectiveInputBudget)} tokens`);
  lines.push(`Estimated used: ${formatTokens(context.totalTokens)} tokens`);
  lines.push("");
  lines.push("Category             Tokens");

  for (const category of context.categories) {
    lines.push(`${category.name.padEnd(20)} ${formatTokens(category.tokens)}`);
  }

  if (context.truncated) {
    lines.push("");
    lines.push("Some context was truncated for this request.");
  }

  return lines.join("\n");
}
```

在 `chatLoop.ts` 里：

```ts
if (input === "/context") {
  const memoryPrompt = await this.memory.getPrompt();
  const runtimeContext = await this.runtimeContext.render();

  const prepared = this.contextPreparer.prepare({
    systemPrompt: this.baseSystemPrompt,
    memoryPrompt,
    runtimeContext,
    messages: this.session.messages,
  });

  console.log(renderContextReport(prepared));
  return true;
}
```

这里复用真实请求路径，而不是另写一套估算逻辑。否则 `/context` 显示的结果和模型实际收到的内容会越来越不一致。

## 单元测试

新增 `tests/context-budget.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { ContextPreparer } from "../src/context/contextPreparer";
import type { ChatMessage } from "../src/context/tokenCounter";

function text(size: number): string {
  return "x".repeat(size);
}

describe("ContextPreparer", () => {
  test("keeps newest messages inside the budget", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: text(4000) },
      { role: "assistant", content: text(4000) },
      { role: "user", content: "latest task" },
    ];

    const preparer = new ContextPreparer({
      contextWindowTokens: 3000,
      reservedOutputTokens: 500,
      compactBufferTokens: 500,
      memoryBudgetTokens: 200,
      runtimeBudgetTokens: 200,
      maxToolResultTokens: 300,
    });

    const result = preparer.prepare({
      systemPrompt: "system",
      memoryPrompt: null,
      runtimeContext: "",
      messages,
    });

    expect(result.messages.at(-1)?.content).toBe("latest task");
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.truncated).toBe(true);
  });

  test("truncates memory independently from messages", () => {
    const preparer = new ContextPreparer({
      contextWindowTokens: 5000,
      reservedOutputTokens: 500,
      compactBufferTokens: 500,
      memoryBudgetTokens: 100,
      runtimeBudgetTokens: 200,
      maxToolResultTokens: 300,
    });

    const result = preparer.prepare({
      systemPrompt: "system",
      memoryPrompt: text(2000),
      runtimeContext: "",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.system).toContain("Content truncated");
    expect(result.truncated).toBe(true);
  });

  test("truncates large tool results", () => {
    const preparer = new ContextPreparer({
      contextWindowTokens: 8000,
      reservedOutputTokens: 500,
      compactBufferTokens: 500,
      memoryBudgetTokens: 200,
      runtimeBudgetTokens: 200,
      maxToolResultTokens: 100,
    });

    const result = preparer.prepare({
      systemPrompt: "system",
      memoryPrompt: null,
      runtimeContext: "",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: text(4000),
            },
          ],
        },
      ],
    });

    const content = result.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(JSON.stringify(content)).toContain("Tool result truncated");
    expect(result.truncated).toBe(true);
  });
});
```

运行：

```bash
bun test tests/context-budget.test.ts
bun run typecheck
```

## 关键源码分析

真实工程的上下文预算链路分布在多个模块里。第十八章主要参考下面这些路径。

### 1. `src/services/tokenEstimation.ts`

真实工程有两类 token 计数：

- 精确计数：调用 provider 的 count tokens 接口。
- 近似估算：按文本长度和内容类型估算。

代码里 `roughTokenCountEstimation(content, bytesPerToken = 4)` 就是近似路径。JSON 使用更小的 bytes-per-token 比例，因为符号密集，真实 token 密度更高。

Mini 先实现近似计数，因为它不需要额外 API，也更适合 Anthropic-compatible provider。

### 2. `src/utils/analyzeContext.ts`

这是 `/context` 的核心分析逻辑。它会按类别统计：

- System prompt
- System tools
- MCP tools
- Custom agents
- Memory files
- Skills
- Messages
- Free space
- Autocompact buffer

本章的 `/context` 是它的简化版。关键思想一样：不要只给用户一个总数，要告诉用户 token 花在哪些类别上。

### 3. `src/utils/tokens.ts`

真实工程不会简单累加所有历史消息 token，因为那会重复计算上下文。它优先读取最近一次 API response 的 usage，再估算之后新增的消息。

这解决了一个常见误区：token usage 不是每轮 output token 的累计和，而是“下一次请求会带上的上下文窗口大小”。

Mini 第一版可以只估算当前 API 视图，但要记住这个区别。

### 4. `src/utils/toolResultStorage.ts`

工具结果是 Coding Agent 最容易爆上下文的来源。

真实工程做了两层保护：

- 单个工具有 `maxResultSizeChars`。
- 同一条 user message 里的工具结果总量还有 aggregate budget。

并且它会把过大的结果持久化到磁盘，只给模型一个预览和文件路径。这样既保留完整结果，又不会把上下文撑爆。

Mini 本章没有做磁盘持久化，只做 preview 截断。后续如果要更接近真实工程，可以把完整工具结果写入 `.ccmini/tool-results/`。

### 5. `src/services/compact/microCompact.ts`

MicroCompact 的核心思路是：旧工具结果价值会随时间下降，所以可以替换成 `[Old tool result content cleared]`。

它不是全量摘要，也不需要模型调用。它只是把旧的大块工具输出从 API 视图里移除。

Mini 本章实现的是“每条工具结果上限”，还没有实现“按时间清理旧工具结果”。这是下一步可以加的能力。

### 6. `src/services/compact/autoCompact.ts`

真实工程用几个关键阈值控制自动压缩：

- 自动压缩 buffer
- warning threshold
- error threshold
- blocking limit
- consecutive failure circuit breaker

本章的 `reservedOutputTokens` 和 `compactBufferTokens` 就是从这里抽出来的简化模型。

### 7. `src/query.ts`

真实请求进入模型前，会依次经过多层预处理：

```txt
getMessagesAfterCompactBoundary
applyToolResultBudget
snipCompact
microcompact
contextCollapse
autoCompact
blocking limit check
callModel
```

Mini 不需要一口气实现这么多层，但要学习它的管道形态：所有“改变 API 视图”的操作都集中在模型调用前，而不是散落在工具、UI、session 保存里。

## 调试与验证

建议按顺序验证：

```bash
bun test tests/context-budget.test.ts
bun run typecheck
```

然后手动构造一个大工具结果：

```txt
> 请运行一个会输出很多内容的命令
```

如果你的 shell tool 支持，可以让它输出大文本。随后输入：

```txt
> /context
```

检查：

- Messages 类别有明显增长。
- 超长 tool result 被标记为 truncated。
- 最近用户消息仍然保留。
- system prompt、Memory、runtime context 没有进入普通消息历史。

如果要临时压低窗口测试裁剪：

```bash
CCMINI_CONTEXT_WINDOW_TOKENS=3000 bun run dev
```

这会让裁剪更容易触发。

## 常见问题

### 为什么不用精确 token 计数

精确计数需要 provider 支持。Anthropic 原生接口支持 count tokens，但很多 Anthropic-compatible provider 不支持，或者响应格式不完全一致。

Mini 第一版使用估算更稳。等主链路稳定后，可以增加可选的 `countTokens()` provider 方法：

```ts
type ModelProvider = {
  stream(input: ModelRequest): AsyncIterable<ModelEvent>;
  countTokens?: (input: ModelRequest) => Promise<number>;
};
```

有精确计数就用精确计数，没有就回退估算。

### 为什么裁剪发送视图而不是删除历史

因为历史有多个用途：

- UI 展示。
- 会话恢复。
- 审计工具调用。
- 未来压缩摘要。
- 用户导出 transcript。

如果为了省 token 直接删历史，后续很多能力都会失真。

### 为什么 system prompt 不裁剪

system prompt 是行为边界，轻易裁剪会改变 Agent 行为。Mini 可以先把 system prompt 当作固定成本。

如果 system prompt 真的太大，应该拆分功能、延迟加载工具说明，而不是简单截断前几千 token。

### 为什么 Memory 有独立预算

Memory 是长期上下文，它不能无限增长。给它独立预算有两个好处：

- 大 Memory 不会挤掉最近用户消息。
- `/context` 能直接提示用户 Memory 是否过大。

### 为什么工具结果要优先裁剪

工具结果通常体积最大，而且信息密度不稳定。

一个 `grep` 或 shell 输出可能有几万行，但模型真正需要的只是文件路径、错误片段、前后几行上下文。对工具结果做 preview，通常比裁剪用户消息更安全。

### 什么时候需要真正的 `/compact`

本章的裁剪是“丢弃旧消息的 API 视图”，没有生成摘要。它适合短期控制窗口，但会丢失远期对话细节。

当你希望长期对话还能保留早期决策、已完成步骤、用户偏好时，就需要 `/compact`：

- 把旧历史总结成一条摘要。
- 插入 compact boundary。
- 保留最近消息。
- 重新注入 Memory 和必要文件。

这可以作为后续章节继续扩展。

## 本章小结

本章把 Mini 的上下文管理从“简单压缩历史”推进到“预算化准备请求”：

- 用近似 token 计数让预算决策本地可运行。
- 用固定窗口、输出预留、compact buffer 得到有效输入预算。
- 给 Memory、runtime context、tool result 和 messages 分开限额。
- 对超长内容做带 marker 的截断。
- 用 `/context` 暴露当前上下文使用情况。
- 明确区分完整 transcript 和 API 发送视图。

到这里，Mini 已经具备长对话的基本生存能力。下一章可以继续做插件系统：让工具、slash command 和上下文扩展点从核心代码里拆出来，变成可安装、可启用、可禁用的模块。
