import type {
  ChatContentBlock,
  ChatMessage,
  ToolResultContentBlock,
} from "../llm/types";
import { estimateMessagesTokens } from "./tokenCounter";

export const CLEARED_TOOL_RESULT = "[Old tool result content cleared]";

export type ContextManagerOptions = {
  maxTokens: number;
  targetTokens?: number;
  keepRecentUserPrompts?: number;
  keepRecentToolResults?: number;
};

export type ResolvedContextManagerOptions = {
  maxTokens: number;
  targetTokens: number;
  keepRecentUserPrompts: number;
  keepRecentToolResults: number;
};

export type ContextPreparationResult = {
  messages: ChatMessage[];
  beforeTokens: number;
  afterTokens: number;
  compactedToolResults: number;
  trimmedMessages: number;
  changed: boolean;
};

export class ContextBudgetExceededError extends Error {
  constructor(
    readonly maxTokens: number,
    readonly actualTokens: number,
  ) {
    super(
      `Context is still too large after compaction: ${actualTokens} estimated tokens, max is ${maxTokens}.`,
    );
    this.name = "ContextBudgetExceededError";
  }
}

export class ContextManager {
  private readonly options: ResolvedContextManagerOptions;

  constructor(options: ContextManagerOptions) {
    this.options = resolveOptions(options);
  }

  prepare(messages: readonly ChatMessage[]): ContextPreparationResult {
    const beforeTokens = estimateMessagesTokens(messages);
    let prepared = cloneMessages(messages);
    let compactedToolResults = 0;
    let trimmedMessages = 0;

    if (beforeTokens > this.options.maxTokens) {
      compactedToolResults = compactOldToolResults(
        prepared,
        this.options.keepRecentToolResults,
      );
    }

    let afterTokens = estimateMessagesTokens(prepared);

    if (afterTokens > this.options.maxTokens) {
      const trimmed = trimToRecentUserPrompts(prepared, this.options);
      prepared = trimmed.messages;
      trimmedMessages = trimmed.trimmedMessages;
      afterTokens = estimateMessagesTokens(prepared);
    }

    if (afterTokens > this.options.maxTokens) {
      throw new ContextBudgetExceededError(this.options.maxTokens, afterTokens);
    }

    return {
      messages: prepared,
      beforeTokens,
      afterTokens,
      compactedToolResults,
      trimmedMessages,
      changed:
        compactedToolResults > 0 ||
        trimmedMessages > 0 ||
        beforeTokens !== afterTokens,
    };
  }
}

export function createDefaultContextOptions(
  contextWindow: number,
): ResolvedContextManagerOptions {
  if (!Number.isFinite(contextWindow) || contextWindow < 1000) {
    throw new Error("contextWindow must be a number greater than or equal to 1000.");
  }

  return {
    maxTokens: Math.floor(contextWindow),
    targetTokens: Math.floor(contextWindow * 0.75),
    keepRecentUserPrompts: 3,
    keepRecentToolResults: 6,
  };
}

function resolveOptions(
  options: ContextManagerOptions,
): ResolvedContextManagerOptions {
  const defaults = createDefaultContextOptions(options.maxTokens);

  return {
    ...defaults,
    ...options,
    targetTokens: options.targetTokens ?? defaults.targetTokens,
    keepRecentUserPrompts:
      options.keepRecentUserPrompts ?? defaults.keepRecentUserPrompts,
    keepRecentToolResults:
      options.keepRecentToolResults ?? defaults.keepRecentToolResults,
  };
}

function compactOldToolResults(
  messages: ChatMessage[],
  keepRecentToolResults: number,
): number {
  const toolResults: ToolResultContentBlock[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (isToolResultBlock(block)) {
        toolResults.push(block);
      }
    }
  }

  const preserved = new Set(
    keepRecentToolResults > 0 ? toolResults.slice(-keepRecentToolResults) : [],
  );
  let compacted = 0;

  for (const block of toolResults) {
    if (preserved.has(block)) {
      continue;
    }

    if (block.content === CLEARED_TOOL_RESULT) {
      continue;
    }

    block.content = CLEARED_TOOL_RESULT;
    compacted++;
  }

  return compacted;
}

function trimToRecentUserPrompts(
  messages: ChatMessage[],
  options: ResolvedContextManagerOptions,
): { messages: ChatMessage[]; trimmedMessages: number } {
  let bestMessages = messages;
  let bestTrimmedMessages = 0;

  for (let keep = options.keepRecentUserPrompts; keep >= 1; keep--) {
    const boundaryIndex = findNthLatestRealUserPromptIndex(messages, keep);
    const suffix = messages.slice(boundaryIndex);
    const trimmedMessages = messages.length - suffix.length;
    const candidate = addCompactionNotice(suffix, trimmedMessages);
    const candidateTokens = estimateMessagesTokens(candidate);

    bestMessages = candidate;
    bestTrimmedMessages = trimmedMessages;

    if (candidateTokens <= options.targetTokens) {
      return {
        messages: candidate,
        trimmedMessages,
      };
    }
  }

  return {
    messages: bestMessages,
    trimmedMessages: bestTrimmedMessages,
  };
}

function findNthLatestRealUserPromptIndex(
  messages: readonly ChatMessage[],
  count: number,
): number {
  let seen = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message && isRealUserPrompt(message)) {
      seen++;

      if (seen === count) {
        return index;
      }
    }
  }

  return 0;
}

function addCompactionNotice(
  messages: ChatMessage[],
  trimmedMessages: number,
): ChatMessage[] {
  if (trimmedMessages === 0 || messages.length === 0) {
    return messages;
  }

  const firstMessage = messages[0];
  if (!firstMessage) {
    return messages;
  }

  const rest = messages.slice(1);
  const notice = `[Context compacted: ${trimmedMessages} older message(s) omitted.]`;

  if (firstMessage.role === "user" && typeof firstMessage.content === "string") {
    return [
      {
        ...firstMessage,
        content: `${notice}\n\n${firstMessage.content}`,
      },
      ...rest,
    ];
  }

  return [
    {
      role: "user",
      content: notice,
    },
    ...messages,
  ];
}

function isRealUserPrompt(message: ChatMessage): boolean {
  return message.role === "user" && typeof message.content === "string";
}

function isToolResultBlock(
  block: ChatContentBlock,
): block is ToolResultContentBlock {
  return block.type === "tool_result";
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map(message => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map(cloneBlock),
  }));
}

function cloneBlock(block: ChatContentBlock): ChatContentBlock {
  return { ...block };
}
