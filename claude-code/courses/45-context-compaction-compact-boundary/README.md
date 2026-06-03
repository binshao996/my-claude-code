# 第 45 章：上下文压缩、Compact Boundary 与 Projection

第二十四章已经实现了 Mini 版 `/compact`：把旧历史总结成摘要，插入 boundary，保留最近消息，让长会话继续跑。

第四十四章又把 transcript、resume、rewind、tombstone 和文件快照做成了可靠会话系统。

现在要把这两条线合起来：压缩不能只是“把 messages 替换成摘要”，它必须成为 session projection 的一部分。

接近官方 Claude Code 的上下文压缩，需要同时解决这些问题：

- 请求前要按固定顺序执行多层压缩。
- `/compact`、auto compact、reactive compact 的行为要一致。
- compact boundary 要让 UI、transcript、resume、rewind 都理解。
- 压缩不能切断 `tool_use` / `tool_result`。
- 压缩后保留的 recent messages 不能在恢复时断链。
- compact 请求自己 prompt-too-long 时要能有损降级。
- 压缩后要重新注入必要的文件、memory、skill、MCP/tool 上下文。
- 自动压缩失败要熔断，不能每轮浪费一次摘要请求。

本章是第 24 章的进阶版：把 Mini 的 compact 做成一个可恢复、可投影、可长期运行的压缩协议。

## 本章目标

完成本章后，Mini 会新增或升级：

1. `src/compact/types.ts`：统一 compact boundary、summary、micro boundary、preserved segment 类型。
2. `src/compact/boundary.ts`：创建 boundary、查找最后 boundary、提取模型视图。
3. `src/compact/apiRound.ts`：按 API round 分组，避免压缩切断工具配对。
4. `src/compact/split.ts`：选择摘要范围和保留窗口，并修正工具/思考块边界。
5. `src/compact/prompt.ts`：严格的摘要 prompt，禁止工具调用。
6. `src/compact/compactConversation.ts`：手动/自动/响应式共用的主压缩函数。
7. `src/compact/autoCompact.ts`：阈值、输出预留、预测式 headroom、失败熔断。
8. `src/compact/reactiveCompact.ts`：prompt-too-long 后的紧急压缩。
9. `src/compact/microCompact.ts`：旧工具结果清理和 micro boundary。
10. `src/compact/postCompactContext.ts`：压缩后重新注入文件、memory、skill 和工具说明。
11. `src/session/projector.ts`：理解 compact boundary 和 preserved segment。
12. `/compact`、`/context`、Agent Loop 请求前管线的接入。
13. 关键测试：boundary projection、preserved segment、tool pair、auto compact、PTL retry、microcompact。

本章完成后，Mini 的长会话治理会从“有一个 compact 命令”升级为“每轮请求都有稳定的上下文策略”。

## 本章完成效果

手动压缩：

```txt
> /compact
Compacted conversation.
Before: 186230 tokens
After: 41280 tokens
Kept: 14 messages
```

带指令压缩：

```txt
> /compact 重点保留 DeepSeek Anthropic-compatible 配置、auth provider 设计和 session resume 方案
Compacted conversation.
```

查看上下文状态：

```txt
> /context
Context
Used: 61,420 tokens
Window: 180,000 tokens
Auto compact threshold: 167,000 tokens
Compactions: 3
Messages after last compact: 22
Microcompactions: 5
```

触发自动压缩：

```txt
[context] Auto compacting conversation...
[context] Compacted 152 messages into summary, kept 18 recent messages.
```

遇到 prompt-too-long 后响应式压缩：

```txt
[context] Prompt too long. Running reactive compact and retrying...
```

启动恢复：

```bash
bun run dev -- --resume 5a7f6c10-8f2f-4b0c-92c8-0e6a11111111
```

恢复后只会发送最后一个 compact boundary 之后的摘要和近期消息，不会把压缩前的旧历史重新塞给模型。

## 先明确和第 24 章的关系

第 24 章已经实现：

- `/compact`。
- compact summary。
- compact boundary。
- 基础 auto compact。
- microcompact 的简化版本。
- resume 后忽略 boundary 之前的历史。

第 45 章补的是生产级细节：

- 请求前压缩管线顺序。
- API round 分组。
- preserved segment。
- compact 后 transcript relink。
- PTL retry。
- 自动压缩熔断。
- microcompact boundary。
- post-compact context reinjection。
- reactive compact。
- context collapse 的接口边界。

也就是说，第 24 章让 Mini “能 compact”。本章让 Mini “compact 后仍然稳定”。

## 真实工程的压缩管线

真实工程每轮请求前不是直接调用模型，而是走一条上下文预处理管线：

```txt
完整 messages
  ↓ getMessagesAfterCompactBoundary()
  ↓ applyToolResultBudget()
  ↓ snipCompactIfNeeded()
  ↓ microcompactMessages()
  ↓ contextCollapse.applyCollapsesIfNeeded()
  ↓ autoCompactIfNeeded()
  ↓ blocking limit / reactive compact guard
  ↓ callModel()
```

这条顺序很重要。

- `getMessagesAfterCompactBoundary()` 先把旧 compact 前历史排除。
- `applyToolResultBudget()` 处理单个巨大 tool result。
- `snip` 删除用户或模型明确标记可移除的历史。
- `microcompact` 清理旧工具结果。
- `context collapse` 做更细粒度的折叠投影。
- `auto compact` 是更重的摘要压缩，放在轻量策略后面。
- reactive compact 在真实 API 413 后兜底，而不是提前伪造错误。

Mini 应该保持同样的思路：从低成本、低破坏的策略开始，最后才做全量摘要。

## 压缩类型总览

| 类型 | 是否调用模型 | 是否替换消息数组 | 是否写 boundary | 主要用途 |
| --- | --- | --- | --- | --- |
| MicroCompact | 否 | 可选 | 是，micro boundary | 清旧工具结果 |
| Manual Compact | 是 | 是 | 是，compact boundary | 用户主动压缩 |
| Auto Compact | 是 | 是 | 是，compact boundary | 接近阈值时自动压缩 |
| Reactive Compact | 是 | 是 | 是，compact boundary | API 返回 prompt-too-long 后恢复 |
| Partial Compact | 是 | 是 | 是，带 preserved segment | 压缩部分历史 |
| Session Memory Compact | 否 | 是 | 是，compact boundary | 使用已提取 memory |
| Context Collapse | 通常是 | 投影视图 | commit/snapshot | 细粒度折叠旧 spans |

本章 Mini 会实现前五种的结构，Session Memory 和 Context Collapse 先保留接口。

## 推荐目录

新增：

```txt
src/
  compact/
    types.ts
    boundary.ts
    apiRound.ts
    split.ts
    prompt.ts
    compactConversation.ts
    autoCompact.ts
    reactiveCompact.ts
    microCompact.ts
    postCompactContext.ts
    contextCollapse.ts
    __tests__/
      boundary.test.ts
      apiRound.test.ts
      split.test.ts
      compactConversation.test.ts
      autoCompact.test.ts
      reactiveCompact.test.ts
      microCompact.test.ts
```

修改：

```txt
src/
  agent/
    agentLoop.ts
  session/
    types.ts
    projector.ts
    transcript.ts
  commands/
    compact.ts
    context.ts
```

如果你的 Mini 当前目录不同，按职责归位即可。

## 第一步：定义 compact 类型

创建 `src/compact/types.ts`：

```ts
import type { ChatMessage, MessageId, ToolUseId } from "../session/types";

export type CompactTrigger = "manual" | "auto" | "reactive" | "partial";

export type CompactPreservedSegment = {
  headUuid: MessageId;
  anchorUuid: MessageId;
  tailUuid: MessageId;
};

export type CompactMetadata = {
  trigger: CompactTrigger;
  preTokens: number;
  postTokens?: number;
  summarizedMessageCount?: number;
  lastPreCompactMessageUuid?: MessageId;
  userContext?: string;
  preservedSegment?: CompactPreservedSegment;
  preCompactDiscoveredTools?: string[];
};

export type CompactBoundaryMessage = {
  uuid: MessageId;
  role: "system";
  kind: "compact_boundary";
  content: "Conversation compacted";
  createdAt: string;
  compact: CompactMetadata;
  isMeta?: false;
};

export type CompactSummaryMessage = {
  uuid: MessageId;
  role: "user";
  kind: "compact_summary";
  content: string;
  createdAt: string;
  isMeta: true;
  visibleInTranscriptOnly: true;
};

export type MicroCompactBoundaryMessage = {
  uuid: MessageId;
  role: "system";
  kind: "microcompact_boundary";
  content: "Context microcompacted";
  createdAt: string;
  microcompact: {
    trigger: "auto";
    preTokens: number;
    tokensSaved: number;
    compactedToolIds: ToolUseId[];
    clearedAttachmentIds: string[];
  };
};

export type CompactMessage =
  | CompactBoundaryMessage
  | CompactSummaryMessage
  | MicroCompactBoundaryMessage;

export type CompactionResult = {
  boundary: CompactBoundaryMessage;
  summaryMessages: CompactSummaryMessage[];
  messagesToKeep: ChatMessage[];
  attachments: ChatMessage[];
  hookResults: ChatMessage[];
  preTokens: number;
  postTokens: number;
  truePostTokens?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
};

export type CompactProgress =
  | { type: "pre_hooks_start" }
  | { type: "compact_start" }
  | { type: "session_context_start" }
  | { type: "post_hooks_start" }
  | { type: "compact_end" };
```

`preservedSegment` 是本章的关键。

它描述 compact 后仍然保留的一段旧消息：

```txt
boundary -> summary -> keep[0] -> ... -> keep[n]
```

但这些 `keep[]` 在 transcript 里已经写过，不能重复写。恢复时需要知道如何把它们接到新的 boundary/summary 后面。

## 第二步：boundary 工具函数

创建 `src/compact/boundary.ts`：

```ts
import { randomUUID } from "node:crypto";
import type { ChatMessage, MessageId } from "../session/types";
import type {
  CompactBoundaryMessage,
  CompactMessage,
  CompactMetadata,
  CompactTrigger,
  MicroCompactBoundaryMessage,
} from "./types";

export function createCompactBoundaryMessage(input: {
  trigger: CompactTrigger;
  preTokens: number;
  postTokens?: number;
  summarizedMessageCount?: number;
  lastPreCompactMessageUuid?: MessageId;
  userContext?: string;
  preCompactDiscoveredTools?: string[];
}): CompactBoundaryMessage {
  return {
    uuid: randomUUID(),
    role: "system",
    kind: "compact_boundary",
    content: "Conversation compacted",
    createdAt: new Date().toISOString(),
    compact: {
      trigger: input.trigger,
      preTokens: input.preTokens,
      postTokens: input.postTokens,
      summarizedMessageCount: input.summarizedMessageCount,
      lastPreCompactMessageUuid: input.lastPreCompactMessageUuid,
      userContext: input.userContext,
      preCompactDiscoveredTools: input.preCompactDiscoveredTools,
    },
  };
}

export function createMicroCompactBoundaryMessage(input: {
  preTokens: number;
  tokensSaved: number;
  compactedToolIds: string[];
  clearedAttachmentIds?: string[];
}): MicroCompactBoundaryMessage {
  return {
    uuid: randomUUID(),
    role: "system",
    kind: "microcompact_boundary",
    content: "Context microcompacted",
    createdAt: new Date().toISOString(),
    microcompact: {
      trigger: "auto",
      preTokens: input.preTokens,
      tokensSaved: input.tokensSaved,
      compactedToolIds: input.compactedToolIds,
      clearedAttachmentIds: input.clearedAttachmentIds ?? [],
    },
  };
}

export function isCompactBoundaryMessage(
  message: ChatMessage | CompactMessage,
): message is CompactBoundaryMessage {
  return message.role === "system" && "kind" in message && message.kind === "compact_boundary";
}

export function isMicroCompactBoundaryMessage(
  message: ChatMessage | CompactMessage,
): message is MicroCompactBoundaryMessage {
  return message.role === "system" && "kind" in message && message.kind === "microcompact_boundary";
}

export function findLastCompactBoundaryIndex(
  messages: Array<ChatMessage | CompactMessage>,
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && isCompactBoundaryMessage(message)) {
      return index;
    }
  }
  return -1;
}

export function getMessagesAfterCompactBoundary<T extends ChatMessage | CompactMessage>(
  messages: T[],
): T[] {
  const boundaryIndex = findLastCompactBoundaryIndex(messages);
  return boundaryIndex === -1 ? messages : messages.slice(boundaryIndex);
}

export function toModelMessages<T extends ChatMessage | CompactMessage>(
  messages: T[],
): ChatMessage[] {
  return getMessagesAfterCompactBoundary(messages).filter(
    (message): message is ChatMessage => {
      if (isCompactBoundaryMessage(message)) {
        return false;
      }
      if (isMicroCompactBoundaryMessage(message)) {
        return false;
      }
      return true;
    },
  );
}

export function withPreservedSegment(
  boundary: CompactBoundaryMessage,
  segment: CompactMetadata["preservedSegment"] | undefined,
): CompactBoundaryMessage {
  if (!segment) {
    return boundary;
  }

  return {
    ...boundary,
    compact: {
      ...boundary.compact,
      preservedSegment: segment,
    },
  };
}
```

模型请求前过滤 boundary，但保留 compact summary：

```txt
system compact_boundary       不发给模型
user compact_summary          发给模型
recent user/assistant         发给模型
```

boundary 是本地控制消息，不是语义上下文。summary 才是语义上下文。

## 第三步：按 API round 分组

compact 请求自己 prompt-too-long 时，不能随机删一条消息。删除必须按 API round。

创建 `src/compact/apiRound.ts`：

```ts
import type { ChatMessage } from "../session/types";

export function groupMessagesByApiRound(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let lastAssistantId: string | undefined;

  for (const message of messages) {
    const assistantId = getAssistantResponseId(message);

    if (assistantId && assistantId !== lastAssistantId && current.length > 0) {
      groups.push(current);
      current = [message];
    } else {
      current.push(message);
    }

    if (assistantId) {
      lastAssistantId = assistantId;
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function getAssistantResponseId(message: ChatMessage): string | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }

  return "providerMessageId" in message && typeof message.providerMessageId === "string"
    ? message.providerMessageId
    : message.uuid;
}
```

为什么不用“每个 user message 一个 group”？

Coding Agent 经常是一条用户请求触发多轮工具调用：

```txt
user: 修复测试
assistant: tool_use Read
user: tool_result
assistant: tool_use Edit
user: tool_result
assistant: tool_use Bash
user: tool_result
assistant: final
```

这是一条用户请求，但包含多个 API round。按 assistant response id 分组更细，响应式压缩可以删除更小的安全块。

## 第四步：切分摘要范围和保留窗口

创建 `src/compact/split.ts`：

```ts
import type { ChatMessage, ToolUseId } from "../session/types";
import { estimateMessageTokens } from "../context/tokenEstimate";
import { isCompactBoundaryMessage } from "./boundary";

export type CompactWindowConfig = {
  minTokensToKeep: number;
  minTextMessagesToKeep: number;
  maxTokensToKeep: number;
};

export const DEFAULT_COMPACT_WINDOW: CompactWindowConfig = {
  minTokensToKeep: 10_000,
  minTextMessagesToKeep: 5,
  maxTokensToKeep: 40_000,
};

export function splitMessagesForCompact(
  messages: ChatMessage[],
  config: CompactWindowConfig = DEFAULT_COMPACT_WINDOW,
): {
  messagesToSummarize: ChatMessage[];
  messagesToKeep: ChatMessage[];
} {
  const compactable = messages.filter((message) => !isCompactBoundaryMessage(message));

  if (compactable.length < 4) {
    throw new Error("Not enough messages to compact. Send a few more messages first.");
  }

  const startIndex = calculateMessagesToKeepIndex(compactable, config);
  return {
    messagesToSummarize: compactable.slice(0, startIndex),
    messagesToKeep: compactable.slice(startIndex),
  };
}

export function calculateMessagesToKeepIndex(
  messages: ChatMessage[],
  config: CompactWindowConfig,
): number {
  let startIndex = messages.length;
  let totalTokens = 0;
  let textMessageCount = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    totalTokens += estimateMessageTokens(message);
    if (hasTextContent(message)) {
      textMessageCount++;
    }
    startIndex = index;

    if (totalTokens >= config.maxTokensToKeep) {
      break;
    }

    if (
      totalTokens >= config.minTokensToKeep &&
      textMessageCount >= config.minTextMessagesToKeep
    ) {
      break;
    }
  }

  return adjustIndexToPreserveApiInvariants(messages, startIndex);
}

export function adjustIndexToPreserveApiInvariants(
  messages: ChatMessage[],
  startIndex: number,
): number {
  let adjusted = startIndex;
  const neededToolUses = collectToolResultIds(messages.slice(adjusted));
  const keptToolUses = collectToolUseIds(messages.slice(adjusted));

  for (const id of keptToolUses) {
    neededToolUses.delete(id);
  }

  for (let index = adjusted - 1; index >= 0 && neededToolUses.size > 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const ids = message.content
      .filter((block) => block.type === "tool_use")
      .map((block) => block.id);

    if (ids.some((id) => neededToolUses.has(id))) {
      adjusted = index;
      for (const id of ids) {
        neededToolUses.delete(id);
      }
    }
  }

  return adjusted;
}

function collectToolResultIds(messages: ChatMessage[]): Set<ToolUseId> {
  const ids = new Set<ToolUseId>();
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

function collectToolUseIds(messages: ChatMessage[]): Set<ToolUseId> {
  const ids = new Set<ToolUseId>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_use") {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

function hasTextContent(message: ChatMessage): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  return message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}
```

这一步保证压缩不会从 `tool_result` 开始保留，却把对应的 `tool_use` 压进摘要里。

真实工程还会处理同一个 assistant response 的多个 streaming block，它们共享 provider message id。Mini 如果也把 thinking / redacted_thinking、tool_use、text 拆成多个 message，要在这里按 provider id 向前扩展。

## 第五步：compact prompt

创建 `src/compact/prompt.ts`：

```ts
export function getCompactPrompt(customInstructions?: string): string {
  return [
    "CRITICAL: Respond with TEXT ONLY. Do NOT call tools.",
    "",
    "Your task is to create a detailed summary of the conversation so far.",
    "This summary will be used by a coding agent to continue the same work after older messages are removed from context.",
    "",
    "Your summary must preserve:",
    "1. The user's primary requests and latest explicit intent.",
    "2. Key technical concepts, architecture, constraints, and decisions.",
    "3. Files read, edited, created, or discussed, with why each matters.",
    "4. Important commands, errors, test results, and fixes.",
    "5. API/provider/model/auth/session details that affect future work.",
    "6. Current work immediately before compaction.",
    "7. Pending tasks and the next step, only if directly implied.",
    "",
    "Rules:",
    "- Do not invent files, APIs, test results, or decisions.",
    "- Preserve exact identifiers when they matter.",
    "- Include user corrections and preferences.",
    "- If something is unknown, say it is unknown.",
    customInstructions ? `\nAdditional user compact instructions:\n${customInstructions}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function getCompactUserSummaryMessage(input: {
  summary: string;
  transcriptPath: string;
  suppressFollowUpQuestions: boolean;
}): string {
  return [
    "The previous conversation was compacted. Continue using this summary as historical context.",
    "",
    input.summary.trim(),
    "",
    `Full transcript path: ${input.transcriptPath}`,
    input.suppressFollowUpQuestions
      ? "Do not ask follow-up questions only because compaction occurred."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
```

真实工程会要求模型先输出 `<analysis>` 再输出 `<summary>`，并禁止工具调用。Mini 可以先只要求纯文本，但“禁止工具”这条不能省。

compact agent 调工具会导致两个问题：

- compact 本身变成 agent loop，成本和时延不可控。
- 工具结果会污染被压缩会话。

## 第六步：strip media 和重复附件

compact 请求不需要图片原文、PDF 原文、会被下一轮重新注入的附件。

创建 `src/compact/compactConversation.ts` 的辅助函数：

```ts
import type { ChatMessage } from "../session/types";

export function stripMediaForCompact(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    let changed = false;
    const content = message.content.map((block) => {
      if (block.type === "image") {
        changed = true;
        return { type: "text" as const, text: "[image]" };
      }
      if (block.type === "document") {
        changed = true;
        return { type: "text" as const, text: "[document]" };
      }
      return block;
    });

    return changed ? { ...message, content } : message;
  });
}

export function stripReinjectedAttachments(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => {
    if (!("attachmentType" in message)) {
      return true;
    }

    return ![
      "skill_listing",
      "skill_discovery",
      "mcp_instructions",
      "deferred_tools_delta",
    ].includes(String(message.attachmentType));
  });
}
```

这一步不是为了信息隐藏，而是为了让 compact 请求自己更不容易超限。

后面 `postCompactContext.ts` 会重新注入当前有效版本。

## 第七步：主压缩函数

创建 `src/compact/compactConversation.ts`：

```ts
import { randomUUID } from "node:crypto";
import { getCurrentTranscriptPath } from "../session/transcript";
import type { ChatMessage } from "../session/types";
import { estimateMessagesTokens } from "../context/tokenEstimate";
import { createCompactBoundaryMessage, withPreservedSegment } from "./boundary";
import { getCompactPrompt, getCompactUserSummaryMessage } from "./prompt";
import { splitMessagesForCompact } from "./split";
import { buildPostCompactAttachments } from "./postCompactContext";
import type { CompactSummaryMessage, CompactTrigger, CompactionResult } from "./types";

export async function compactConversation(input: {
  messages: ChatMessage[];
  trigger: CompactTrigger;
  customInstructions?: string;
  suppressFollowUpQuestions: boolean;
  onProgress?: (progress: { type: string }) => void;
}): Promise<CompactionResult> {
  if (input.messages.length === 0) {
    throw new Error("Not enough messages to compact. Send a few more messages first.");
  }

  input.onProgress?.({ type: "pre_hooks_start" });
  const preTokens = estimateMessagesTokens(input.messages);
  const { messagesToSummarize, messagesToKeep } = splitMessagesForCompact(input.messages);

  input.onProgress?.({ type: "compact_start" });
  const summaryText = await summarizeWithRetry({
    messages: stripReinjectedAttachments(stripMediaForCompact(messagesToSummarize)),
    customInstructions: input.customInstructions,
  });

  const boundaryBase = createCompactBoundaryMessage({
    trigger: input.trigger,
    preTokens,
    summarizedMessageCount: messagesToSummarize.length,
    lastPreCompactMessageUuid: messagesToSummarize.at(-1)?.uuid,
    userContext: input.customInstructions,
    preCompactDiscoveredTools: extractDiscoveredToolNames(input.messages),
  });

  const summary: CompactSummaryMessage = {
    uuid: randomUUID(),
    role: "user",
    kind: "compact_summary",
    isMeta: true,
    visibleInTranscriptOnly: true,
    createdAt: new Date().toISOString(),
    content: getCompactUserSummaryMessage({
      summary: summaryText,
      transcriptPath: getCurrentTranscriptPath(),
      suppressFollowUpQuestions: input.suppressFollowUpQuestions,
    }),
  };

  input.onProgress?.({ type: "session_context_start" });
  const attachments = await buildPostCompactAttachments({
    messagesToKeep,
    maxFiles: 5,
    maxTokensPerFile: 5_000,
    skillsTokenBudget: 25_000,
  });

  const boundary = withPreservedSegment(
    boundaryBase,
    createPreservedSegment(summary.uuid, messagesToKeep),
  );

  const postMessages = buildPostCompactMessages({
    boundary,
    summaryMessages: [summary],
    messagesToKeep,
    attachments,
    hookResults: [],
  });

  const postTokens = estimateMessagesTokens(postMessages);

  input.onProgress?.({ type: "post_hooks_start" });
  input.onProgress?.({ type: "compact_end" });

  return {
    boundary,
    summaryMessages: [summary],
    messagesToKeep,
    attachments,
    hookResults: [],
    preTokens,
    postTokens,
    truePostTokens: postTokens,
  };
}

export function buildPostCompactMessages(input: {
  boundary: ChatMessage;
  summaryMessages: ChatMessage[];
  messagesToKeep: ChatMessage[];
  attachments: ChatMessage[];
  hookResults: ChatMessage[];
}): ChatMessage[] {
  return [
    input.boundary,
    ...input.summaryMessages,
    ...stripRuntimeOnlyPayloads(input.messagesToKeep),
    ...input.attachments,
    ...input.hookResults,
  ];
}

function createPreservedSegment(
  anchorUuid: string,
  messagesToKeep: ChatMessage[],
) {
  if (messagesToKeep.length === 0) {
    return undefined;
  }

  return {
    headUuid: messagesToKeep[0]!.uuid,
    anchorUuid,
    tailUuid: messagesToKeep.at(-1)!.uuid,
  };
}

async function summarizeWithRetry(input: {
  messages: ChatMessage[];
  customInstructions?: string;
}): Promise<string> {
  let messages = input.messages;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await summarizeMessages({
        messages,
        customInstructions: input.customInstructions,
      });
    } catch (error) {
      lastError = error;
      if (!isPromptTooLongError(error)) {
        throw error;
      }
      messages = truncateHeadForCompactRetry(messages);
    }
  }

  throw new Error(`Conversation too long to summarize: ${String(lastError)}`);
}

async function summarizeMessages(input: {
  messages: ChatMessage[];
  customInstructions?: string;
}): Promise<string> {
  const prompt = getCompactPrompt(input.customInstructions);
  const response = await callCompactModel({
    system: prompt,
    messages: input.messages,
    maxTokens: 16_000,
  });

  const text = response.trim();
  if (!text) {
    throw new Error("Failed to generate compact summary.");
  }
  return text;
}

function truncateHeadForCompactRetry(messages: ChatMessage[]): ChatMessage[] {
  const groups = groupMessagesByApiRound(messages);
  if (groups.length < 2) {
    throw new Error("No safe compact retry chunk left to drop.");
  }

  const dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  return [
    {
      uuid: randomUUID(),
      role: "user",
      content: "[Earlier conversation truncated for compaction retry.]",
      createdAt: new Date().toISOString(),
      isMeta: true,
    },
    ...groups.slice(dropCount).flat(),
  ];
}

function stripRuntimeOnlyPayloads(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if ("toolUseResult" in message) {
      const { toolUseResult: _toolUseResult, ...rest } = message;
      return rest as ChatMessage;
    }
    return message;
  });
}
```

这里有几个真实工程对应点：

- `preCompactTokenCount` 用于 telemetry 和阈值判断。
- `messagesToKeep` 保留最近窗口。
- `stripRuntimeOnlyPayloads` 释放 UI-only 的大对象。
- `preservedSegment` 让 transcript 恢复知道 keep 段如何接回 summary。
- PTL retry 按 API round 丢最老 group，而不是随机删消息。

## 第八步：post-compact context reinjection

压缩后模型会丢掉很多“隐式上下文”，需要重新注入当前有效信息。

创建 `src/compact/postCompactContext.ts`：

```ts
import type { ChatMessage } from "../session/types";
import { readRecentFileState } from "../files/readState";
import { loadActiveSkills } from "../skills/runtime";
import { loadMemoryContext } from "../memory/runtime";
import { renderAvailableDeferredTools } from "../tools/deferredTools";

export async function buildPostCompactAttachments(input: {
  messagesToKeep: ChatMessage[];
  maxFiles: number;
  maxTokensPerFile: number;
  skillsTokenBudget: number;
}): Promise<ChatMessage[]> {
  const [files, memory, skills, deferredTools] = await Promise.all([
    buildFileAttachments(input.maxFiles, input.maxTokensPerFile),
    buildMemoryAttachment(),
    buildSkillAttachment(input.skillsTokenBudget),
    buildDeferredToolsAttachment(input.messagesToKeep),
  ]);

  return [files, memory, skills, deferredTools].filter(
    (message): message is ChatMessage => message !== null,
  );
}

async function buildFileAttachments(
  maxFiles: number,
  maxTokensPerFile: number,
): Promise<ChatMessage | null> {
  const files = await readRecentFileState({ maxFiles, maxTokensPerFile });
  if (files.length === 0) {
    return null;
  }

  return {
    uuid: crypto.randomUUID(),
    role: "user",
    content: files
      .map((file) => `File context: ${file.path}\n\n${file.content}`)
      .join("\n\n---\n\n"),
    createdAt: new Date().toISOString(),
    isMeta: true,
  };
}

async function buildMemoryAttachment(): Promise<ChatMessage | null> {
  const memory = await loadMemoryContext();
  if (!memory.trim()) {
    return null;
  }

  return {
    uuid: crypto.randomUUID(),
    role: "user",
    content: `Project memory after compaction:\n\n${memory}`,
    createdAt: new Date().toISOString(),
    isMeta: true,
  };
}

async function buildSkillAttachment(tokenBudget: number): Promise<ChatMessage | null> {
  const skills = await loadActiveSkills({ tokenBudget });
  if (skills.length === 0) {
    return null;
  }

  return {
    uuid: crypto.randomUUID(),
    role: "user",
    content: skills.map((skill) => `Skill: ${skill.name}\n${skill.content}`).join("\n\n"),
    createdAt: new Date().toISOString(),
    isMeta: true,
  };
}

async function buildDeferredToolsAttachment(
  messagesToKeep: ChatMessage[],
): Promise<ChatMessage | null> {
  const text = await renderAvailableDeferredTools({ alreadyAnnouncedIn: messagesToKeep });
  if (!text) {
    return null;
  }

  return {
    uuid: crypto.randomUUID(),
    role: "user",
    content: text,
    createdAt: new Date().toISOString(),
    isMeta: true,
  };
}
```

Mini 如果还没有 skills/deferred tools，可以先只实现 memory 和 recent files。

但接口要留出来，因为压缩后“重新告知模型当前可用能力”是官方 Claude Code 体验里很重要的一环。

## 第九步：MicroCompact

全量 compact 成本高。很多上下文压力来自旧工具结果。

创建 `src/compact/microCompact.ts`：

```ts
import type { ChatMessage, ToolUseId } from "../session/types";
import { estimateMessagesTokens } from "../context/tokenEstimate";
import { createMicroCompactBoundaryMessage } from "./boundary";

export const CLEARED_TOOL_RESULT = "[Old tool result content cleared]";

export type MicroCompactResult = {
  messages: ChatMessage[];
  boundary?: ChatMessage;
  tokensSaved: number;
  clearedToolUseIds: ToolUseId[];
};

export function microCompactMessages(
  messages: ChatMessage[],
  options: { keepRecentToolResults: number },
): MicroCompactResult {
  const locations = collectToolResultLocations(messages);
  const clearLocations = locations.slice(
    0,
    Math.max(0, locations.length - options.keepRecentToolResults),
  );

  if (clearLocations.length === 0) {
    return { messages, tokensSaved: 0, clearedToolUseIds: [] };
  }

  const clearSet = new Set(clearLocations.map((loc) => `${loc.messageIndex}:${loc.blockIndex}`));
  let tokensSaved = 0;
  const clearedToolUseIds: ToolUseId[] = [];

  const next = messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    let changed = false;
    const content = message.content.map((block, blockIndex) => {
      if (!clearSet.has(`${messageIndex}:${blockIndex}`)) {
        return block;
      }
      if (block.type !== "tool_result") {
        return block;
      }
      if (block.content === CLEARED_TOOL_RESULT) {
        return block;
      }

      changed = true;
      tokensSaved += estimateToolResultTokens(block.content);
      clearedToolUseIds.push(block.tool_use_id);
      return { ...block, content: CLEARED_TOOL_RESULT };
    });

    return changed ? { ...message, content } : message;
  });

  return {
    messages: next,
    tokensSaved,
    clearedToolUseIds,
    boundary:
      tokensSaved > 0
        ? createMicroCompactBoundaryMessage({
            preTokens: estimateMessagesTokens(messages),
            tokensSaved,
            compactedToolIds: clearedToolUseIds,
          })
        : undefined,
  };
}

function collectToolResultLocations(messages: ChatMessage[]): Array<{
  messageIndex: number;
  blockIndex: number;
}> {
  const locations: Array<{ messageIndex: number; blockIndex: number }> = [];

  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      return;
    }

    message.content.forEach((block, blockIndex) => {
      if (block.type === "tool_result") {
        locations.push({ messageIndex, blockIndex });
      }
    });
  });

  return locations;
}

function estimateToolResultTokens(content: unknown): number {
  if (typeof content === "string") {
    return Math.ceil(content.length / 4);
  }
  return Math.ceil(JSON.stringify(content).length / 4);
}
```

MicroCompact 的约束：

- 不删除 tool result block，只替换内容。
- 不改变 tool_use id。
- 不破坏 role 顺序。
- 写 micro boundary 只用于 UI/统计，不作为模型上下文。

真实工程还有 cached microcompact：通过 `cache_edits` 删除服务端 prompt cache 里的旧工具结果，本地 messages 不变。这是更高级的优化。Mini 当前不需要实现，但可以保留 `MicroCompactResult` 的结构。

## 第十步：AutoCompact

创建 `src/compact/autoCompact.ts`：

```ts
import type { ChatMessage } from "../session/types";
import { getContextWindowForModel, getMaxOutputTokensForModel } from "../models/spec";
import { estimateMessagesTokens } from "../context/tokenEstimate";
import { compactConversation } from "./compactConversation";

const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
const DEFAULT_BUFFER_TOKENS = 13_000;
const TOOL_RESULT_GROWTH_ESTIMATE = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export type AutoCompactState = {
  compacted: boolean;
  turnCounter: number;
  turnId: string;
  consecutiveFailures: number;
};

export function getEffectiveContextWindow(model: string): number {
  const reservedForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
  return getContextWindowForModel(model) - reservedForSummary;
}

export function getAutoCompactBuffer(model: string): number {
  const window = getEffectiveContextWindow(model);
  if (window >= 800_000) return 50_000;
  if (window >= 400_000) return 30_000;
  return DEFAULT_BUFFER_TOKENS;
}

export function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindow(model) - getAutoCompactBuffer(model);
}

export function estimateMaxTurnGrowth(model: string): number {
  return Math.min(getMaxOutputTokensForModel(model), MAX_OUTPUT_TOKENS_FOR_SUMMARY) +
    TOOL_RESULT_GROWTH_ESTIMATE;
}

export function shouldAutoCompact(input: {
  messages: ChatMessage[];
  model: string;
  snipTokensFreed?: number;
}): boolean {
  const used = estimateMessagesTokens(input.messages) - (input.snipTokensFreed ?? 0);
  return used + estimateMaxTurnGrowth(input.model) >= getAutoCompactThreshold(input.model);
}

export async function autoCompactIfNeeded(input: {
  messages: ChatMessage[];
  model: string;
  state: AutoCompactState;
  querySource: string;
}): Promise<{
  messages: ChatMessage[];
  state: AutoCompactState;
  compacted: boolean;
}> {
  if (input.querySource === "compact" || input.querySource === "session_memory") {
    return { messages: input.messages, state: input.state, compacted: false };
  }

  if (input.state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { messages: input.messages, state: input.state, compacted: false };
  }

  if (!shouldAutoCompact({ messages: input.messages, model: input.model })) {
    return { messages: input.messages, state: input.state, compacted: false };
  }

  try {
    const result = await compactConversation({
      messages: input.messages,
      trigger: "auto",
      suppressFollowUpQuestions: true,
    });

    return {
      messages: buildPostCompactMessages(result),
      compacted: true,
      state: {
        compacted: true,
        turnCounter: 0,
        turnId: crypto.randomUUID(),
        consecutiveFailures: 0,
      },
    };
  } catch {
    return {
      messages: input.messages,
      compacted: false,
      state: {
        ...input.state,
        consecutiveFailures: input.state.consecutiveFailures + 1,
      },
    };
  }
}
```

重点是：

- 为 compact summary 输出预留 token。
- 自动压缩前考虑本轮可能增长。
- compact 自己不能递归触发 compact。
- 连续失败要停止重试。

第 24 章的 auto compact 只是阈值判断。本章要加“预测式 headroom”和失败熔断。

## 第十一步：Reactive Compact

Reactive Compact 只在真实 API 返回 prompt-too-long 后触发。

创建 `src/compact/reactiveCompact.ts`：

```ts
import type { ChatMessage } from "../session/types";
import { compactConversation } from "./compactConversation";
import { buildPostCompactMessages } from "./compactConversation";

export async function tryReactiveCompact(input: {
  messages: ChatMessage[];
  hasAttempted: boolean;
  aborted: boolean;
}): Promise<ChatMessage[] | null> {
  if (input.hasAttempted || input.aborted) {
    return null;
  }

  try {
    const result = await compactConversation({
      messages: input.messages,
      trigger: "reactive",
      suppressFollowUpQuestions: true,
    });
    return buildPostCompactMessages(result);
  } catch {
    return null;
  }
}
```

接入 API 错误恢复：

```ts
if (isPromptTooLongError(error)) {
  const compacted = await tryReactiveCompact({
    messages: messagesForQuery,
    hasAttempted: state.hasAttemptedReactiveCompact,
    aborted: abortController.signal.aborted,
  });

  if (compacted) {
    state.hasAttemptedReactiveCompact = true;
    messagesForQuery = compacted;
    continue;
  }
}
```

不要在请求前直接伪造 prompt-too-long。真实 API 413 里可能包含具体 token gap 或 provider 行为，reactive compact 应该响应真实失败。

## 第十二步：Context Collapse 接口

Context Collapse 是更细粒度的系统：它不是把整个旧历史变成一条 summary，而是把某些 spans 折叠成 commit。

Mini 先保留接口：

```ts
import type { ChatMessage } from "../session/types";

export type CollapseCommit = {
  id: string;
  sessionId: string;
  coveredMessageIds: string[];
  summaryMessage: ChatMessage;
  createdAt: string;
};

export type ContextCollapseState = {
  commits: CollapseCommit[];
  staged: CollapseCommit[];
};

export function applyCollapsesIfNeeded(messages: ChatMessage[]): {
  messages: ChatMessage[];
  committed: CollapseCommit[];
} {
  return {
    messages: projectCollapsedView(messages, []),
    committed: [],
  };
}

export function recoverFromOverflow(messages: ChatMessage[]): {
  messages: ChatMessage[];
  committed: number;
} {
  return { messages, committed: 0 };
}

export function projectCollapsedView(
  messages: ChatMessage[],
  commits: CollapseCommit[],
): ChatMessage[] {
  if (commits.length === 0) {
    return messages;
  }

  const hidden = new Set(commits.flatMap((commit) => commit.coveredMessageIds));
  const summaries = new Map(
    commits.map((commit) => [commit.coveredMessageIds.at(-1), commit.summaryMessage]),
  );

  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (summaries.has(message.uuid)) {
      result.push(summaries.get(message.uuid)!);
      continue;
    }
    if (!hidden.has(message.uuid)) {
      result.push(message);
    }
  }
  return result;
}
```

本章不要求完整实现 Collapse agent，但要在请求管线里留位置：

```txt
snip
microcompact
context collapse
auto compact
```

未来如果实现 collapse，auto compact 就可以更少触发。

## 第十三步：transcript entry

第 44 章的 transcript entry 需要扩展：

```ts
import type {
  CompactBoundaryMessage,
  CompactSummaryMessage,
  MicroCompactBoundaryMessage,
} from "../compact/types";

export type CompactBoundaryEntry = {
  type: "compact_boundary";
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  boundary: CompactBoundaryMessage;
};

export type CompactSummaryEntry = {
  type: "compact_summary";
  sessionId: string;
  uuid: string;
  parentUuid: string;
  timestamp: string;
  summary: CompactSummaryMessage;
};

export type MicroCompactBoundaryEntry = {
  type: "microcompact_boundary";
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  boundary: MicroCompactBoundaryMessage;
};
```

压缩成功后写入：

```ts
await recordCompactResult(result);
```

实现：

```ts
export async function recordCompactResult(result: CompactionResult): Promise<void> {
  const previousParent = getLastParentUuid();

  await transcriptWriter.append(getCurrentTranscriptPath(), {
    type: "compact_boundary",
    sessionId: getSessionId(),
    uuid: result.boundary.uuid,
    parentUuid: previousParent,
    timestamp: result.boundary.createdAt,
    boundary: result.boundary,
  });

  let parent = result.boundary.uuid;
  for (const summary of result.summaryMessages) {
    await transcriptWriter.append(getCurrentTranscriptPath(), {
      type: "compact_summary",
      sessionId: getSessionId(),
      uuid: summary.uuid,
      parentUuid: parent,
      timestamp: summary.createdAt,
      summary,
    });
    parent = summary.uuid;
  }

  setLastParentUuid(parent);
}
```

`messagesToKeep` 不重复写入 transcript。它们已经在旧历史里存在。

这就是 preserved segment 必须存在的原因。

## 第十四步：projection 处理 compact boundary

在 `src/session/projector.ts` 中，把 compact entry 转回消息：

```ts
function entryToMessage(entry: TranscriptEntry): ChatMessage | null {
  if (entry.type === "message") {
    return entry.message;
  }

  if (entry.type === "compact_boundary") {
    return entry.boundary;
  }

  if (entry.type === "compact_summary") {
    return entry.summary;
  }

  if (entry.type === "microcompact_boundary") {
    return entry.boundary;
  }

  return null;
}
```

projection 最后应用 compact boundary：

```ts
export function projectSessionMessages(entries: TranscriptEntry[]): ChatMessage[] {
  const allMessages = buildParentChain(entries)
    .map(entryToMessage)
    .filter((message): message is ChatMessage => message !== null);

  return getMessagesAfterCompactBoundary(allMessages);
}
```

但 preserved segment 要多一步 relink。

## 第十五步：preserved segment relink

问题场景：

```txt
原 transcript:
U1 -> A1 -> U2 -> A2 -> U3 -> A3

compact 后内存:
B1 -> S1 -> U3 -> A3
```

`U3` 和 `A3` 已经在 transcript 里，它们的 parent 仍然是 `A2`。

如果不 relink，恢复时从最新 leaf `A3` 往前走：

```txt
A3 -> U3 -> A2 -> U2 -> A1 -> U1
```

旧历史又回来了，compact 失效。

因此 boundary 要记录：

```ts
preservedSegment: {
  headUuid: "U3",
  anchorUuid: "S1",
  tailUuid: "A3",
}
```

projection 加 relink：

```ts
export function applyPreservedSegmentRelinks(
  messagesById: Map<string, TranscriptMessage>,
): void {
  const boundaries = [...messagesById.values()].filter(isCompactBoundaryTranscriptMessage);
  const last = boundaries.at(-1);
  const segment = last?.message.compact.preservedSegment;
  if (!segment) {
    return;
  }

  const head = messagesById.get(segment.headUuid);
  if (!head) {
    return;
  }

  messagesById.set(segment.headUuid, {
    ...head,
    parentUuid: segment.anchorUuid,
  });

  for (const [uuid, message] of messagesById) {
    if (uuid === segment.headUuid) {
      continue;
    }

    if (message.parentUuid === segment.anchorUuid) {
      messagesById.set(uuid, {
        ...message,
        parentUuid: segment.tailUuid,
      });
    }
  }
}
```

真实工程会先验证 `tail -> head` 能走通，避免坏 metadata 破坏恢复。Mini 也应该加验证：

```ts
function validateSegmentWalk(
  messagesById: Map<string, TranscriptMessage>,
  segment: CompactPreservedSegment,
): boolean {
  const seen = new Set<string>();
  let cursor = messagesById.get(segment.tailUuid);

  while (cursor) {
    if (seen.has(cursor.uuid)) {
      return false;
    }
    seen.add(cursor.uuid);

    if (cursor.uuid === segment.headUuid) {
      return true;
    }

    cursor = cursor.parentUuid ? messagesById.get(cursor.parentUuid) : undefined;
  }

  return false;
}
```

如果验证失败，宁可加载完整历史，也不要错误截断。

## 第十六步：Agent Loop 请求前管线

在 `src/agent/agentLoop.ts` 中，把请求前逻辑统一成一个函数。

```ts
import { getMessagesAfterCompactBoundary, toModelMessages } from "../compact/boundary";
import { microCompactMessages } from "../compact/microCompact";
import { autoCompactIfNeeded } from "../compact/autoCompact";
import { applyCollapsesIfNeeded } from "../compact/contextCollapse";

export async function prepareMessagesForQuery(input: {
  messages: ChatMessage[];
  model: string;
  querySource: string;
  autoCompactState: AutoCompactState;
}): Promise<{
  modelMessages: ChatMessage[];
  runtimeMessages: ChatMessage[];
  autoCompactState: AutoCompactState;
}> {
  let runtimeMessages = getMessagesAfterCompactBoundary(input.messages);

  const micro = microCompactMessages(runtimeMessages, {
    keepRecentToolResults: 5,
  });
  runtimeMessages = micro.messages;
  if (micro.boundary) {
    runtimeMessages = [...runtimeMessages, micro.boundary];
  }

  const collapsed = applyCollapsesIfNeeded(runtimeMessages);
  runtimeMessages = collapsed.messages;

  const auto = await autoCompactIfNeeded({
    messages: runtimeMessages,
    model: input.model,
    state: input.autoCompactState,
    querySource: input.querySource,
  });
  runtimeMessages = auto.messages;

  return {
    runtimeMessages,
    modelMessages: toModelMessages(runtimeMessages),
    autoCompactState: auto.state,
  };
}
```

然后 Agent Loop：

```ts
const prepared = await prepareMessagesForQuery({
  messages: this.messages,
  model: this.model,
  querySource: "repl_main_thread",
  autoCompactState: this.autoCompactState,
});

this.messages = prepared.runtimeMessages;
this.autoCompactState = prepared.autoCompactState;

const response = await callModel({
  messages: prepared.modelMessages,
  model: this.model,
});
```

不要把这段逻辑散落在 `/compact`、`AgentLoop.ask()`、`resume` 和 `retry` 里。压缩策略必须有单一入口。

## 第十七步：`/compact` 命令只做编排

创建或升级 `src/commands/compact.ts`：

```ts
import { buildPostCompactMessages, compactConversation } from "../compact/compactConversation";
import { recordCompactResult } from "../session/transcript";

export async function compactCommand(input: {
  args: string;
  messages: ChatMessage[];
  replaceMessages: (messages: ChatMessage[]) => void;
}): Promise<string> {
  const customInstructions = input.args.trim() || undefined;

  const result = await compactConversation({
    messages: input.messages,
    trigger: "manual",
    customInstructions,
    suppressFollowUpQuestions: false,
  });

  await recordCompactResult(result);
  input.replaceMessages(buildPostCompactMessages(result));

  return [
    "Compacted conversation.",
    `Before: ${result.preTokens} tokens`,
    `After: ${result.postTokens} tokens`,
    `Kept: ${result.messagesToKeep.length} messages`,
  ].join("\n");
}
```

命令层不要自己决定哪些消息保留，也不要自己写 summary prompt。

## 第十八步：`/context` 展示压缩状态

升级 `src/commands/context.ts`：

```ts
import { findLastCompactBoundaryIndex, isCompactBoundaryMessage, isMicroCompactBoundaryMessage } from "../compact/boundary";
import { estimateMessagesTokens } from "../context/tokenEstimate";
import { getAutoCompactThreshold } from "../compact/autoCompact";

export function contextCommand(input: {
  messages: ChatMessage[];
  model: string;
}): string {
  const used = estimateMessagesTokens(input.messages);
  const compactCount = input.messages.filter(isCompactBoundaryMessage).length;
  const microCount = input.messages.filter(isMicroCompactBoundaryMessage).length;
  const lastBoundary = findLastCompactBoundaryIndex(input.messages);

  return [
    "Context",
    `Used: ${used} tokens`,
    `Auto compact threshold: ${getAutoCompactThreshold(input.model)} tokens`,
    `Compactions: ${compactCount}`,
    `Microcompactions: ${microCount}`,
    `Messages after last compact: ${
      lastBoundary === -1 ? input.messages.length : input.messages.length - lastBoundary - 1
    }`,
  ].join("\n");
}
```

用户需要知道当前上下文策略发生了什么。否则 compact 后消息突然消失，会让人误以为历史丢了。

## 第十九步：UI 展示规则

主屏：

```txt
✻ Conversation compacted
```

不要把完整 summary 默认铺满屏幕。

Transcript 模式：

```txt
Compact summary
  ...
```

建议规则：

```ts
function shouldRenderMessage(message: ChatMessage, mode: "main" | "transcript"): boolean {
  if (isMicroCompactBoundaryMessage(message)) {
    return false;
  }

  if (isCompactBoundaryMessage(message)) {
    return true;
  }

  if ("kind" in message && message.kind === "compact_summary") {
    return mode === "transcript";
  }

  return true;
}
```

模型需要 summary，用户主屏未必需要每次都看到它。

## 第二十步：测试 boundary projection

创建 `src/compact/__tests__/boundary.test.ts`：

```ts
import { expect, test } from "bun:test";
import {
  createCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
  toModelMessages,
} from "../boundary";
import type { ChatMessage } from "../../session/types";

test("getMessagesAfterCompactBoundary returns messages from last boundary", () => {
  const before = user("u1");
  const boundary = createCompactBoundaryMessage({
    trigger: "manual",
    preTokens: 1000,
  });
  const summary = user("s1");
  const after = user("u2");

  const result = getMessagesAfterCompactBoundary([before, boundary, summary, after]);
  expect(result.map((message) => message.uuid)).toEqual([
    boundary.uuid,
    "s1",
    "u2",
  ]);
});

test("toModelMessages filters boundary but keeps summary", () => {
  const boundary = createCompactBoundaryMessage({
    trigger: "manual",
    preTokens: 1000,
  });
  const summary = user("summary");

  const result = toModelMessages([boundary, summary]);
  expect(result.map((message) => message.uuid)).toEqual(["summary"]);
});

function user(uuid: string): ChatMessage {
  return {
    uuid,
    role: "user",
    content: "hello",
    createdAt: new Date().toISOString(),
  };
}
```

## 第二十一步：测试 split 不切断工具配对

创建 `src/compact/__tests__/split.test.ts`：

```ts
import { expect, test } from "bun:test";
import { adjustIndexToPreserveApiInvariants } from "../split";
import type { ChatMessage } from "../../session/types";

test("adjustIndexToPreserveApiInvariants moves start before matching tool_use", () => {
  const messages: ChatMessage[] = [
    user("u1", "start"),
    assistantToolUse("a1", "toolu_1"),
    userToolResult("u2", "toolu_1"),
    assistantText("a2", "done"),
  ];

  const adjusted = adjustIndexToPreserveApiInvariants(messages, 2);
  expect(adjusted).toBe(1);
});

function user(uuid: string, content: string): ChatMessage {
  return { uuid, role: "user", content, createdAt: now() };
}

function assistantText(uuid: string, text: string): ChatMessage {
  return { uuid, role: "assistant", content: text, createdAt: now() };
}

function assistantToolUse(uuid: string, id: string): ChatMessage {
  return {
    uuid,
    role: "assistant",
    createdAt: now(),
    content: [{ type: "tool_use", id, name: "Read", input: { file: "a.ts" } }],
  };
}

function userToolResult(uuid: string, id: string): ChatMessage {
  return {
    uuid,
    role: "user",
    createdAt: now(),
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  };
}

function now(): string {
  return new Date().toISOString();
}
```

## 第二十二步：测试 API round 分组

创建 `src/compact/__tests__/apiRound.test.ts`：

```ts
import { expect, test } from "bun:test";
import { groupMessagesByApiRound } from "../apiRound";
import type { ChatMessage } from "../../session/types";

test("groups messages when a new assistant response starts", () => {
  const messages = [
    user("u1"),
    assistant("a1", "resp-1"),
    user("tr1"),
    assistant("a2", "resp-2"),
  ];

  const groups = groupMessagesByApiRound(messages);
  expect(groups).toHaveLength(2);
  expect(groups[0]!.map((message) => message.uuid)).toEqual(["u1", "a1", "tr1"]);
  expect(groups[1]!.map((message) => message.uuid)).toEqual(["a2"]);
});

function user(uuid: string): ChatMessage {
  return { uuid, role: "user", content: "hello", createdAt: now() };
}

function assistant(uuid: string, providerMessageId: string): ChatMessage {
  return {
    uuid,
    role: "assistant",
    providerMessageId,
    content: "ok",
    createdAt: now(),
  } as ChatMessage;
}

function now(): string {
  return new Date().toISOString();
}
```

## 第二十三步：测试 auto compact 熔断

创建 `src/compact/__tests__/autoCompact.test.ts`：

```ts
import { expect, test } from "bun:test";
import { autoCompactIfNeeded, type AutoCompactState } from "../autoCompact";

test("does not auto compact after consecutive failures trip breaker", async () => {
  const state: AutoCompactState = {
    compacted: false,
    turnCounter: 0,
    turnId: "turn",
    consecutiveFailures: 3,
  };

  const result = await autoCompactIfNeeded({
    messages: [],
    model: "test-model",
    state,
    querySource: "repl_main_thread",
  });

  expect(result.compacted).toBe(false);
  expect(result.state.consecutiveFailures).toBe(3);
});
```

如果 `getContextWindowForModel()` 依赖真实模型表，测试里注入 model spec 或 mock 它。不要让测试依赖远端。

## 第二十四步：测试 microcompact

创建 `src/compact/__tests__/microCompact.test.ts`：

```ts
import { expect, test } from "bun:test";
import { CLEARED_TOOL_RESULT, microCompactMessages } from "../microCompact";
import type { ChatMessage } from "../../session/types";

test("microCompactMessages clears old tool results and keeps recent ones", () => {
  const messages = [
    toolResultMessage("u1", "t1", "old"),
    toolResultMessage("u2", "t2", "recent"),
  ];

  const result = microCompactMessages(messages, { keepRecentToolResults: 1 });

  const first = result.messages[0]!;
  const second = result.messages[1]!;

  expect(Array.isArray(first.content) && first.content[0]?.content).toBe(CLEARED_TOOL_RESULT);
  expect(Array.isArray(second.content) && second.content[0]?.content).toBe("recent");
  expect(result.boundary).toBeDefined();
});

function toolResultMessage(uuid: string, toolUseId: string, content: string): ChatMessage {
  return {
    uuid,
    role: "user",
    createdAt: new Date().toISOString(),
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  };
}
```

## 第二十五步：手工验证

运行类型检查：

```bash
bun run typecheck
```

运行 compact 相关测试：

```bash
bun test src/compact/__tests__/boundary.test.ts
bun test src/compact/__tests__/split.test.ts
bun test src/compact/__tests__/apiRound.test.ts
bun test src/compact/__tests__/microCompact.test.ts
bun test src/compact/__tests__/autoCompact.test.ts
```

启动：

```bash
bun run dev
```

手动压缩：

```txt
/compact
```

查看状态：

```txt
/context
```

恢复：

```bash
bun run dev -- --continue
```

检查恢复后 `/context`：

```txt
/context
```

应该看到 compact count 不为 0，并且 messages after last compact 是一个较小数字。

## 常见坑

### 坑 1：压缩后重复写 messagesToKeep

不要重复写。

`messagesToKeep` 已经在 transcript 里。重复写会制造重复 UUID 或重复语义。

正确做法是写 boundary 和 summary，然后用 preserved segment relink。

### 坑 2：恢复时不处理 preserved segment

这样会导致 compact 后恢复又加载完整旧历史，下一轮马上再次 auto compact。

### 坑 3：auto compact 在 compact 请求里递归触发

`querySource === "compact"` 必须跳过 auto compact。

### 坑 4：compact summary 发散成新任务

summary 是历史上下文，不是用户新需求。prompt 和 summary wrapper 都要避免让模型“开始执行摘要里的任务”。

### 坑 5：压缩切断 tool pair

如果保留窗口以 `tool_result` 开头，必须向前包含对应 `tool_use`。

### 坑 6：compact 请求自己超限后直接失败

要按 API round 丢弃最旧 group 重试。虽然有损，但能救回会话。

### 坑 7：microcompact 删除 block

不要删除 `tool_result` block。替换内容即可。删除 block 会破坏工具配对。

### 坑 8：压缩后不清缓存

压缩后至少要清理：

- token usage baseline。
- read file cache。
- memory file cache。
- microcompact state。
- content replacement state。

否则会出现“压缩了但马上又触发压缩”或“恢复用旧缓存”的问题。

## 与官方 Claude Code 的差距

做到本章后，Mini 的压缩系统已经接近官方主干设计，但仍有差距：

- Session Memory Compact 需要单独的 memory extraction 系统。
- Context Collapse 需要后台 agent、commit log 和 collapse projection。
- Cached MicroCompact 需要 provider 支持 `cache_edits`。
- Compact cache sharing 需要 forked agent 复用主线程 prompt cache。
- Post-compact hooks 要接完整 hook 系统。
- SearchExtraTools / deferred tools 的增量注入需要完整工具发现系统。
- 超大 transcript 的 pre-boundary 快速扫描还需要 fd 级优化。

这些可以继续作为后续章节扩展。

## 本章验收标准

代码层面：

- 所有模型请求前统一走 `prepareMessagesForQuery()`。
- 请求前先执行 boundary projection，再执行轻量压缩，最后才 auto compact。
- `/compact` 和 auto/reactive compact 复用同一个 `compactConversation()`。
- compact result 包含 boundary、summary、messagesToKeep、attachments、hookResults。
- compact boundary 记录 trigger、preTokens、summary count、preservedSegment。
- projection 能识别 compact boundary、summary 和 micro boundary。
- preserved segment 恢复不会重新加载 compact 前旧历史。
- auto compact 有输出预留、预测式 headroom 和连续失败熔断。
- reactive compact 只响应真实 prompt-too-long。
- microcompact 只替换旧工具结果内容，不删除工具块。

测试层面：

- boundary projection 正确。
- model messages 过滤 boundary 但保留 summary。
- split 不切断 tool pair。
- API round 分组稳定。
- compact PTL retry 会丢旧 group。
- preserved segment relink 生效。
- auto compact 熔断生效。
- microcompact 保留最近工具结果。

命令层面：

- `/compact` 能压缩并替换当前上下文。
- `/compact <说明>` 能把说明传入摘要 prompt。
- `/context` 能展示 compact 和 microcompact 状态。
- `bun run dev -- --continue` 恢复后不会重新发送 compact 前旧历史。
- `bun run typecheck` 通过。

## 小结

上下文压缩不是一个命令，而是一套协议：

```txt
boundary
  + summary
  + preserved segment
  + projection
  + tool-pair invariant
  + post-compact reinjection
  + auto/reactive trigger
```

第 24 章让 Mini 有了 compact 能力；第 45 章让 compact 成为可恢复、可组合、可长期运行的基础设施。

下一章可以继续补 **Session Memory 与长期记忆压缩**：把长会话里的稳定事实提取到 session memory，让自动压缩优先使用结构化记忆，而不是每次都调用摘要模型。
