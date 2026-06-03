# 第 24 章：上下文压缩与长会话治理

第二十三章已经能从 transcript 恢复会话。恢复之后会遇到一个直接问题：历史越来越长，最终会超过模型的上下文窗口。

第十八章做过 token 预算和请求前裁剪。那一章解决的是“本轮请求别撑爆”。但裁剪只是临时视图，它不会把旧历史变成可长期使用的上下文。长会话真正需要的是 `/compact`：

- 把旧对话总结成一条摘要。
- 插入 compact boundary。
- 保留最近消息，让当前任务不断线。
- 后续请求只发送 boundary 之后的新上下文。
- transcript 仍然保留完整历史，便于恢复和审计。

本章实现 Mini 版上下文压缩。它不追求真实工程的所有策略，但要把长期会话的主干能力做出来。

## 真实工程怎么做

真实工程的上下文压缩主要分布在这些位置：

- `src/commands/compact/compact.ts`：`/compact` 命令入口。
- `src/services/compact/compact.ts`：全量摘要压缩、boundary、摘要消息、压缩后附件恢复。
- `src/services/compact/autoCompact.ts`：自动压缩阈值、warning、blocking limit、连续失败熔断。
- `src/services/compact/microCompact.ts`：清理旧工具结果，避免工具输出拖垮上下文。
- `src/services/compact/grouping.ts`：按 API round 分组，保证截断和重试不破坏工具调用配对。
- `src/utils/messages.ts`：创建 `compact_boundary`，并提供 `getMessagesAfterCompactBoundary()`。
- `src/query.ts`：每轮请求前执行 microcompact、auto compact，并用 `buildPostCompactMessages()` 替换上下文。

真实工程有三层策略：

1. MicroCompact：只清旧工具结果，不调用模型。
2. Session Memory Compact：用已提取的 session memory 压缩，不调用摘要模型。
3. 传统摘要 Compact：调用模型生成摘要，替换旧历史。

Mini 版先实现第三层，也就是用户最能感知的 `/compact`。等这条主链路稳定后，再加自动触发和 microcompact。

## 本章目标

完成后，Mini 应该支持：

```text
/compact
/compact 聚焦保留认证、模型配置、文件修改记录
/context
```

并且启动参数和 AgentLoop 能自动触发压缩：

```bash
bun run dev
bun run typecheck
```

压缩后的 messages 大致变成：

```text
system compact_boundary
user compact summary
recent user/assistant messages
```

后续请求只把这段压缩后上下文发给模型。旧 transcript 不删除，只是不再直接参与 API 请求。

## 和第十八章的区别

第十八章的上下文预算做的是“发送视图裁剪”：

```text
完整 messages
  ↓
请求前裁剪
  ↓
发送给模型的临时 messages
```

本章的 compact 做的是“会话状态重写”：

```text
完整 messages
  ↓
摘要旧历史
  ↓
boundary + summary + 最近 messages
  ↓
成为 AgentLoop 的新 messages
```

两者都重要：

- 预算裁剪适合处理单条超长工具结果。
- compact 适合让长会话继续保留早期决策和任务状态。

不要用一个完全替代另一个。

## 推荐目录

新增：

```text
src/compact/
  compactTypes.ts
  compactPrompt.ts
  compactBoundary.ts
  compactConversation.ts
  autoCompact.ts
  microCompact.ts

src/commands/
  compact.ts
```

修改：

```text
src/chat/agentLoop.ts
src/context/contextPreparer.ts
src/transcript/resume.ts
src/transcript/writer.ts
src/repl/commands.ts
```

如果你的 Mini 项目目录不同，按职责放置即可。

## 核心类型

先把 compact 相关类型集中起来：

```ts
// src/compact/compactTypes.ts
import type { ChatMessage } from "../chat/messageTypes";

export type CompactTrigger = "manual" | "auto";

export type CompactBoundaryMessage = {
  role: "system";
  kind: "compact_boundary";
  content: "Conversation compacted";
  compact: {
    trigger: CompactTrigger;
    preTokens: number;
    createdAt: string;
    summarizedMessageCount: number;
    lastPreCompactMessageId: string | null;
    customInstructions?: string;
  };
};

export type CompactSummaryMessage = {
  role: "user";
  kind: "compact_summary";
  content: string;
  isMeta: true;
};

export type CompactResult = {
  boundary: CompactBoundaryMessage;
  summary: CompactSummaryMessage;
  messagesToKeep: ChatMessage[];
  preTokens: number;
  postTokens: number;
};
```

这里给 `ChatMessage` 增加了两个可选的特殊形态：`compact_boundary` 和 `compact_summary`。如果你前面的 `ChatMessage` 只有 `role/content`，可以先扩展成联合类型：

```ts
export type NormalChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

export type ChatMessage =
  | NormalChatMessage
  | CompactBoundaryMessage
  | CompactSummaryMessage;
```

注意：`compact_boundary` 是本地系统消息，不一定要发给模型。它主要用于 UI、恢复和截断边界。

## 创建 compact boundary

真实工程通过 `createCompactBoundaryMessage()` 创建系统消息，里面记录 trigger、preTokens、被压缩消息数量等信息。

Mini 版实现：

```ts
// src/compact/compactBoundary.ts
import { randomUUID } from "node:crypto";
import type {
  CompactBoundaryMessage,
  CompactTrigger,
} from "./compactTypes";

export function createCompactBoundaryMessage(input: {
  trigger: CompactTrigger;
  preTokens: number;
  summarizedMessageCount: number;
  lastPreCompactMessageId: string | null;
  customInstructions?: string;
}): CompactBoundaryMessage {
  return {
    id: randomUUID(),
    role: "system",
    kind: "compact_boundary",
    content: "Conversation compacted",
    compact: {
      trigger: input.trigger,
      preTokens: input.preTokens,
      createdAt: new Date().toISOString(),
      summarizedMessageCount: input.summarizedMessageCount,
      lastPreCompactMessageId: input.lastPreCompactMessageId,
      customInstructions: input.customInstructions,
    },
  };
}
```

再实现边界查找：

```ts
export function isCompactBoundaryMessage(
  message: ChatMessage,
): message is CompactBoundaryMessage {
  return (
    message.role === "system" &&
    "kind" in message &&
    message.kind === "compact_boundary"
  );
}

export function findLastCompactBoundaryIndex(
  messages: ChatMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isCompactBoundaryMessage(messages[index])) {
      return index;
    }
  }

  return -1;
}

export function getMessagesAfterCompactBoundary(
  messages: ChatMessage[],
): ChatMessage[] {
  const index = findLastCompactBoundaryIndex(messages);
  return index === -1 ? messages : messages.slice(index);
}
```

这条函数很关键：所有模型请求前都应该先拿最后一个 boundary 之后的消息，再做预算裁剪。

## 摘要提示词

压缩不是随便让模型“总结一下”。摘要要能让后续开发继续，所以提示词必须明确保留工程信息。

```ts
// src/compact/compactPrompt.ts
export function buildCompactPrompt(customInstructions?: string): string {
  const extra = customInstructions
    ? `\n\n用户额外要求：\n${customInstructions}\n`
    : "";

  return `你要为一个 AI Coding Agent 的长会话生成继续工作摘要。

请只输出摘要正文，不要调用工具。

摘要必须保留：
1. 用户的主要目标和最新明确要求。
2. 已经做过的关键步骤。
3. 修改、读取、创建过的重要文件路径。
4. 重要代码结构、函数名、配置项和命令。
5. 遇到过的错误以及修复方式。
6. 尚未完成的任务。
7. 下一步应该继续做什么。

写作要求：
- 使用中文。
- 按条目组织。
- 不要编造没有出现过的文件、命令、API 或结果。
- 如果某个信息不确定，明确写“不确定”。
${extra}`;
}

export function buildCompactSummaryMessage(summary: string): string {
  return `以下是此前对话的压缩摘要。后续工作必须把它当作历史上下文继续执行。

${summary}`;
}
```

真实工程的 prompt 会更长，并要求模型先输出 `<analysis>` 再输出 `<summary>`，最后只取 summary。Mini 版先用更直接的文本摘要即可。

## 选择压缩范围

最简单的 compact 是：压缩全部历史，只保留摘要。

但 Coding Agent 需要保留最近几轮原文，因为当前任务通常在最近几轮里。建议 Mini 版保留最近 6 到 10 条消息。

```ts
export type CompactWindowConfig = {
  keepRecentMessages: number;
  minMessagesToCompact: number;
};

export const DEFAULT_COMPACT_WINDOW: CompactWindowConfig = {
  keepRecentMessages: 8,
  minMessagesToCompact: 6,
};

export function splitMessagesForCompact(
  messages: ChatMessage[],
  config = DEFAULT_COMPACT_WINDOW,
): {
  messagesToSummarize: ChatMessage[];
  messagesToKeep: ChatMessage[];
} {
  const compactable = getMessagesAfterCompactBoundary(messages).filter(
    (message) => !isCompactBoundaryMessage(message),
  );

  if (compactable.length < config.minMessagesToCompact) {
    throw new Error(
      "Not enough messages to compact. Send a few more messages first.",
    );
  }

  const keepCount = Math.min(config.keepRecentMessages, compactable.length - 1);
  const splitIndex = Math.max(1, compactable.length - keepCount);

  return {
    messagesToSummarize: compactable.slice(0, splitIndex),
    messagesToKeep: compactable.slice(splitIndex),
  };
}
```

这里的原则：

- 至少要有一部分消息被压缩。
- 最近消息尽量保留原文。
- 不要跨最后一个 compact boundary 往前重复压缩旧摘要。

## 摘要模型调用

前面章节已经有模型路由。建议给 compact 单独一个 role：

```ts
type ModelRole = "main" | "fast" | "planner" | "compact";
```

压缩调用使用 compact role：

```ts
import { createMessage } from "../llm/client";
import { selectModelForRole } from "../models/modelRouter";
import { buildCompactPrompt } from "./compactPrompt";

async function summarizeMessages(input: {
  messages: ChatMessage[];
  customInstructions?: string;
}): Promise<string> {
  const model = selectModelForRole("compact");
  const system = buildCompactPrompt(input.customInstructions);

  const response = await createMessage({
    model,
    system,
    messages: input.messages.map(toApiMessage),
    maxTokens: 4000,
    temperature: 0,
  });

  const summary = extractText(response).trim();

  if (!summary) {
    throw new Error("Compact failed: empty summary.");
  }

  return summary;
}
```

如果你第二章已经按 DeepSeek Anthropic-compatible endpoint 配好了 `@anthropic-ai/sdk`，这里不需要换 SDK。仍然走同一个 client，只是模型 role 选 `compact`。

## compactConversation 主函数

把前面几步串起来：

```ts
// src/compact/compactConversation.ts
import { estimateMessagesTokens } from "../context/tokenCounter";
import {
  buildCompactSummaryMessage,
} from "./compactPrompt";
import {
  createCompactBoundaryMessage,
} from "./compactBoundary";
import type { ChatMessage } from "../chat/messageTypes";
import type { CompactResult, CompactTrigger } from "./compactTypes";

export async function compactConversation(input: {
  messages: ChatMessage[];
  trigger: CompactTrigger;
  customInstructions?: string;
}): Promise<CompactResult> {
  const preTokens = estimateMessagesTokens(input.messages);
  const { messagesToSummarize, messagesToKeep } = splitMessagesForCompact(
    input.messages,
  );

  const summaryText = await summarizeMessages({
    messages: messagesToSummarize,
    customInstructions: input.customInstructions,
  });

  const boundary = createCompactBoundaryMessage({
    trigger: input.trigger,
    preTokens,
    summarizedMessageCount: messagesToSummarize.length,
    lastPreCompactMessageId: messagesToSummarize.at(-1)?.id ?? null,
    customInstructions: input.customInstructions,
  });

  const summary: CompactSummaryMessage = {
    id: crypto.randomUUID(),
    role: "user",
    kind: "compact_summary",
    isMeta: true,
    content: buildCompactSummaryMessage(summaryText),
  };

  const postMessages = buildPostCompactMessages({
    boundary,
    summary,
    messagesToKeep,
  });

  return {
    boundary,
    summary,
    messagesToKeep,
    preTokens,
    postTokens: estimateMessagesTokens(postMessages),
  };
}

export function buildPostCompactMessages(input: {
  boundary: CompactBoundaryMessage;
  summary: CompactSummaryMessage;
  messagesToKeep: ChatMessage[];
}): ChatMessage[] {
  return [input.boundary, input.summary, ...input.messagesToKeep];
}
```

真实工程的 `buildPostCompactMessages()` 还会拼接：

- 压缩后的文件附件。
- hook 结果。
- plan mode 指令。
- skill 内容。
- MCP / deferred tools 增量说明。

Mini 版先只保留 boundary、summary 和最近消息。

如果当前会话处于 Mini plan mode，compact 后仍要保留 plan mode 语义：

- `PlannerStore` 的当前 plan 不要因为 compact 丢失。
- 后续请求仍然要通过 plan mode prompt 包装。
- 工具列表仍然只能暴露 read-only tools 和 `update_plan`。

## 接入 AgentLoop

AgentLoop 需要能替换当前 messages：

```ts
export class AgentLoop {
  private messages: ChatMessage[];

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  replaceMessages(messages: ChatMessage[]): void {
    this.messages = [...messages];
  }

  async compact(customInstructions?: string): Promise<CompactResult> {
    const result = await compactConversation({
      messages: this.messages,
      trigger: "manual",
      customInstructions,
    });

    this.messages = buildPostCompactMessages(result);
    return result;
  }
}
```

注意不要只把压缩结果返回给 UI，却忘了替换 AgentLoop 的内部 messages。否则下一次请求还是会带着旧历史。

## 接入 /compact 命令

命令实现：

```ts
// src/commands/compact.ts
import type { AgentLoop } from "../chat/agentLoop";

export async function handleCompactCommand(input: {
  args: string;
  agentLoop: AgentLoop;
}): Promise<void> {
  const customInstructions = input.args.trim() || undefined;

  const result = await input.agentLoop.compact(customInstructions);

  console.log(
    [
      "Conversation compacted.",
      `Before: ${result.preTokens} tokens`,
      `After: ${result.postTokens} tokens`,
      `Kept: ${result.messagesToKeep.length} recent messages`,
    ].join("\n"),
  );
}
```

REPL 分发：

```ts
if (input.startsWith("/compact")) {
  await handleCompactCommand({
    args: input.slice("/compact".length),
    agentLoop,
  });
  return;
}
```

示例：

```text
/compact
/compact 保留最近修改的 src/services/api/claude.ts 和模型配置讨论
```

自定义指令只影响摘要，不应该变成新的用户任务。压缩完成后，用户仍然需要继续输入下一步。

## 写入 transcript

compact 不能只改内存，也要写入 transcript。否则 `/resume` 后会找不到 boundary 和 summary。

建议在 transcript entry 里保留特殊类型：

```ts
type TranscriptCompactBoundaryEntry = {
  type: "compact_boundary";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  compact: CompactBoundaryMessage["compact"];
};

type TranscriptCompactSummaryEntry = {
  type: "compact_summary";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  content: string;
};
```

压缩成功后追加：

```ts
await transcript.write({
  type: "compact_boundary",
  uuid: result.boundary.id,
  parentUuid: previousMessageId,
  sessionId: getSessionId(),
  timestamp: result.boundary.compact.createdAt,
  compact: result.boundary.compact,
});

await transcript.write({
  type: "compact_summary",
  uuid: result.summary.id,
  parentUuid: result.boundary.id,
  sessionId: getSessionId(),
  timestamp: new Date().toISOString(),
  content: result.summary.content,
});
```

后续保留消息不需要重复写一遍。它们原本已经在 transcript 里。

## 恢复 compact 后的会话

第二十三章的恢复逻辑只处理 `message`。现在要让它理解 compact entry。

恢复时应该把 `compact_summary` 当作一条 meta user message：

```ts
function transcriptEntryToMessage(
  entry: TranscriptEntry,
): ChatMessage | null {
  if (entry.type === "message") {
    return entry.message;
  }

  if (entry.type === "compact_boundary") {
    return {
      id: entry.uuid,
      role: "system",
      kind: "compact_boundary",
      content: "Conversation compacted",
      compact: entry.compact,
    };
  }

  if (entry.type === "compact_summary") {
    return {
      id: entry.uuid,
      role: "user",
      kind: "compact_summary",
      isMeta: true,
      content: entry.content,
    };
  }

  return null;
}
```

构建恢复链时有一个细节：最后一个 compact boundary 之前的普通消息可以不进入 AgentLoop 初始上下文。恢复函数最终应该再调用：

```ts
const restoredMessages = getMessagesAfterCompactBoundary(chainMessages);
```

这样恢复后的会话不会重新加载已经被摘要覆盖的长历史。

## 请求前过滤 boundary

`compact_boundary` 是本地消息，不一定能直接发给 API。发送前应该过滤掉 boundary，但保留 summary：

```ts
export function toModelMessages(messages: ChatMessage[]): ApiMessage[] {
  return getMessagesAfterCompactBoundary(messages)
    .filter((message) => !isCompactBoundaryMessage(message))
    .map(toApiMessage);
}
```

此时模型看到的是：

```text
user: 以下是此前对话的压缩摘要...
user: 最近保留的原始用户消息
assistant: 最近保留的原始助手消息
user: 新输入
```

boundary 仍然留在本地 messages 中，用于 UI 和恢复。

## 自动压缩阈值

手动 `/compact` 做完后，可以接自动压缩。第十八章已经有预算配置，本章复用它。

```ts
// src/compact/autoCompact.ts
import { estimateMessagesTokens } from "../context/tokenCounter";
import { DEFAULT_CONTEXT_BUDGET } from "../context/budget";

export type AutoCompactDecision = {
  shouldCompact: boolean;
  usedTokens: number;
  threshold: number;
};

export function shouldAutoCompact(
  messages: ChatMessage[],
): AutoCompactDecision {
  const usedTokens = estimateMessagesTokens(messages);
  const effectiveInput =
    DEFAULT_CONTEXT_BUDGET.contextWindowTokens -
    DEFAULT_CONTEXT_BUDGET.reservedOutputTokens;
  const threshold =
    effectiveInput - DEFAULT_CONTEXT_BUDGET.compactBufferTokens;

  return {
    shouldCompact: usedTokens >= threshold,
    usedTokens,
    threshold,
  };
}
```

接入 AgentLoop 的 `ask()` 前：

```ts
async ask(input: string): Promise<string> {
  const decision = shouldAutoCompact(this.messages);

  if (decision.shouldCompact) {
    const result = await compactConversation({
      messages: this.messages,
      trigger: "auto",
    });

    this.messages = buildPostCompactMessages(result);
  }

  this.messages.push({ role: "user", content: input });
  const response = await this.callModel(toModelMessages(this.messages));
  this.messages.push({ role: "assistant", content: response });

  return response;
}
```

真实工程的阈值更细：

- `AUTOCOMPACT_BUFFER_TOKENS = 13_000`
- warning buffer 约 20K
- blocking limit 约最后 3K
- 连续失败 3 次后停止自动压缩
- compact 查询源自己不会触发 compact，防止递归

Mini 版至少要加一个递归保护。

```ts
let isCompacting = false;

async function autoCompactIfNeeded(): Promise<void> {
  if (isCompacting) return;

  const decision = shouldAutoCompact(this.messages);
  if (!decision.shouldCompact) return;

  try {
    isCompacting = true;
    const result = await compactConversation({
      messages: this.messages,
      trigger: "auto",
    });
    this.messages = buildPostCompactMessages(result);
  } finally {
    isCompacting = false;
  }
}
```

## 自动压缩失败熔断

如果 compact 一直失败，不能每轮都重试。真实工程用连续失败次数做熔断。Mini 版也加上：

```ts
const MAX_COMPACT_FAILURES = 3;

let consecutiveAutoCompactFailures = 0;

async function autoCompactIfNeeded(): Promise<void> {
  if (isCompacting) return;
  if (consecutiveAutoCompactFailures >= MAX_COMPACT_FAILURES) return;

  const decision = shouldAutoCompact(this.messages);
  if (!decision.shouldCompact) return;

  try {
    isCompacting = true;
    const result = await compactConversation({
      messages: this.messages,
      trigger: "auto",
    });

    this.messages = buildPostCompactMessages(result);
    consecutiveAutoCompactFailures = 0;
  } catch (error) {
    consecutiveAutoCompactFailures += 1;
    console.error(`Auto compact failed: ${String(error)}`);
  } finally {
    isCompacting = false;
  }
}
```

手动 `/compact` 不应该受这个熔断影响。用户主动触发时要允许再次尝试。

## MicroCompact：先清旧工具结果

全量 compact 成本高，因为它要再调用一次模型。很多时候上下文被撑爆只是因为旧工具结果太长，可以先做轻量清理。

Mini 版实现一个简单规则：

- 只处理 `tool_result`。
- 保留最近 5 个工具结果。
- 更早的工具结果替换为占位符。

```ts
// src/compact/microCompact.ts
const CLEARED_TOOL_RESULT = "[Old tool result content cleared]";

export function microCompactToolResults(
  messages: ChatMessage[],
  keepRecentToolResults = 5,
): {
  messages: ChatMessage[];
  clearedCount: number;
} {
  const toolResultLocations: Array<{
    messageIndex: number;
    blockIndex: number;
  }> = [];

  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue;

    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type === "tool_result") {
        toolResultLocations.push({ messageIndex, blockIndex });
      }
    }
  }

  const clearSet = new Set(
    toolResultLocations
      .slice(0, Math.max(0, toolResultLocations.length - keepRecentToolResults))
      .map((location) => `${location.messageIndex}:${location.blockIndex}`),
  );

  if (clearSet.size === 0) {
    return { messages, clearedCount: 0 };
  }

  const next = messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) return message;

    return {
      ...message,
      content: message.content.map((block, blockIndex) => {
        if (!clearSet.has(`${messageIndex}:${blockIndex}`)) return block;
        if (block.type !== "tool_result") return block;
        return { ...block, content: CLEARED_TOOL_RESULT };
      }),
    };
  });

  return {
    messages: next,
    clearedCount: clearSet.size,
  };
}
```

调用顺序：

```ts
const micro = microCompactToolResults(this.messages);

if (micro.clearedCount > 0) {
  this.messages = micro.messages;
}

await autoCompactIfNeeded();
```

真实工程的 microcompact 还会按工具类型筛选，只清 `Read`、shell、搜索、网页抓取、编辑等输出，并记录 `microcompact_boundary`。Mini 版先不加 boundary，只要能减少旧工具结果占用即可。

## prompt-too-long 的兜底处理

压缩请求本身也可能太长。真实工程会按 API round 分组，丢弃最老的 round 后重试。

Mini 版先做保守版本：

```ts
async function summarizeWithPromptTooLongRetry(input: {
  messages: ChatMessage[];
  customInstructions?: string;
}): Promise<string> {
  let messages = input.messages;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await summarizeMessages({
        messages,
        customInstructions: input.customInstructions,
      });
    } catch (error) {
      if (!isPromptTooLongError(error)) {
        throw error;
      }

      messages = dropOldestConversationChunk(messages);
    }
  }

  throw new Error(
    "Conversation too long to summarize. Run /clear or start a new session.",
  );
}
```

`dropOldestConversationChunk` 不要随便删一条消息。最少按 user/assistant 成组删除：

```ts
function dropOldestConversationChunk(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 2) {
    throw new Error("No safe chunk left to drop.");
  }

  const dropCount = Math.max(2, Math.ceil(messages.length * 0.2));
  return [
    {
      id: crypto.randomUUID(),
      role: "user",
      content: "[Earlier conversation truncated for compact retry.]",
    },
    ...messages.slice(dropCount),
  ];
}
```

如果你的消息里已经有 tool use / tool result，删除时必须保持配对。Mini 版如果还没做复杂工具 block，可以先按普通消息处理；工具 block 完整后再升级成 API round 分组。

## /context 展示 compact 状态

第十八章已经有 `/context`。现在可以补充 compact 信息：

```ts
export function getCompactStats(messages: ChatMessage[]): {
  hasCompactBoundary: boolean;
  compactCount: number;
  messagesAfterLastCompact: number;
  lastCompactAt: string | null;
} {
  const boundaries = messages.filter(isCompactBoundaryMessage);
  const lastBoundaryIndex = findLastCompactBoundaryIndex(messages);

  return {
    hasCompactBoundary: boundaries.length > 0,
    compactCount: boundaries.length,
    messagesAfterLastCompact:
      lastBoundaryIndex === -1 ? messages.length : messages.length - lastBoundaryIndex - 1,
    lastCompactAt: boundaries.at(-1)?.compact.createdAt ?? null,
  };
}
```

输出示例：

```text
Context Usage

Estimated used: 48200 tokens
Auto compact threshold: 167000 tokens
Compactions: 2
Messages after last compact: 14
Last compact: 2026-05-26 10:15:00
```

这样用户能理解为什么历史突然变短，也能知道 compact 是否发生过。

## UI 展示

如果你有消息列表，不要把 compact summary 当成普通用户消息直接展示在主屏里。更好的展示是：

```text
Conversation compacted · view summary
```

用户展开时再看摘要。

Mini 版命令行可以简单一点：

```ts
function renderMessage(message: ChatMessage): void {
  if (isCompactBoundaryMessage(message)) {
    console.log("Conversation compacted");
    return;
  }

  if ("kind" in message && message.kind === "compact_summary") {
    return;
  }

  renderNormalMessage(message);
}
```

摘要是模型上下文，不一定要默认刷屏展示给用户。

## 测试清单

建议补这些测试：

```ts
describe("compact boundary", () => {
  test("creates boundary metadata", () => {});
  test("returns messages after last compact boundary", () => {});
});

describe("splitMessagesForCompact", () => {
  test("keeps recent messages", () => {});
  test("throws when there are too few messages", () => {});
  test("does not summarize messages before last boundary", () => {});
});

describe("compactConversation", () => {
  test("builds boundary summary and kept messages", async () => {});
  test("passes custom instructions into summary prompt", async () => {});
  test("updates agent loop messages after compact", async () => {});
});

describe("autoCompact", () => {
  test("triggers when messages exceed threshold", () => {});
  test("does not recurse while compacting", async () => {});
  test("stops after consecutive failures", async () => {});
});

describe("microCompactToolResults", () => {
  test("keeps recent tool results", () => {});
  test("clears older tool results with marker", () => {});
});
```

对应命令：

```bash
bun test src/compact/__tests__/compactBoundary.test.ts
bun test src/compact/__tests__/compactConversation.test.ts
bun test src/compact/__tests__/autoCompact.test.ts
bun run typecheck
```

## 常见问题

### 为什么 compact summary 用 user message？

因为摘要要作为“历史上下文”参与下一轮请求。放在 user message 里最直接，模型会把它当作用户提供的背景材料。

真实工程也会把 compact summary 做成不可见的 user message，并保留 boundary 作为系统元信息。

### 为什么 boundary 不直接发给模型？

boundary 是本地控制消息。它对恢复、UI、截断边界有用，但对模型没有直接价值。真正给模型看的，是 summary 和保留的最近消息。

### 为什么不删除 transcript 里的旧历史？

旧历史仍然有价值：

- 用户可以查看完整记录。
- `/resume` 可以还原更完整的链路。
- debug 时需要知道 compact 前发生了什么。
- 后续可以做更精细的 partial compact。

compact 只改变 AgentLoop 当前上下文，不销毁历史资产。

### 为什么要保留最近消息？

摘要再好也会丢细节。最近几轮通常包含当前任务的代码片段、报错、用户修正和下一步动作。保留原文可以减少 compact 后“失忆”。

### 自动 compact 会不会打断用户？

不应该。自动 compact 应该发生在下一次模型请求前，压缩成功后继续发送用户刚输入的任务。UI 可以给一条简短提示，但不要要求用户重新输入。

### compact 失败怎么办？

手动 compact 失败要直接告诉用户。自动 compact 失败可以记录错误并继续尝试本轮请求。如果连续失败，就停止自动 compact，避免每轮都浪费一次摘要请求。

### 为什么需要 prompt-too-long 重试？

长会话可能已经大到连“请总结这些消息”的请求都超限。此时只能先丢掉最旧的一部分，再尝试总结剩余内容。这个兜底有损，但比整个会话无法继续更好。

## 本章完成标准

完成后应满足：

- `/compact` 能生成摘要并替换 AgentLoop 当前 messages。
- `/compact <说明>` 能把用户说明放进摘要 prompt。
- 压缩后 messages 包含 boundary、summary、最近消息。
- 请求前会忽略 boundary，但保留 summary。
- `/resume` 后不会重新发送最后一个 boundary 之前的旧历史。
- 自动 compact 在超过阈值时触发。
- 自动 compact 有递归保护和连续失败熔断。
- microcompact 能清理旧工具结果。
- transcript 能记录 compact boundary 和 compact summary。
- `bun run typecheck` 通过。

第二十四章到这里，Mini 就有了长会话治理的核心能力：短期靠预算裁剪，长期靠 compact 摘要，恢复时靠 boundary 避免重复加载旧历史。下一章可以继续做命令、工具和插件的治理：当系统能力越来越多时，如何让扩展能力可发现、可启用、可禁用，并且不会把核心代码拖成一团。
