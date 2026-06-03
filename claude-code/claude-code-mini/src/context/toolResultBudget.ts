// 18add: Tool result budget — cap per-result token size to prevent context blowout
import type { ChatContentBlock, ChatMessage } from "../llm/types";
import type { ToolResultContentBlock } from "../llm/types";
import { estimateTokens } from "./tokenCounter";
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

    const nextContent = message.content.map((block): ChatContentBlock => {
      if (block.type !== "tool_result") return block;

      const result = truncateToolResultContent(block.content, maxToolResultTokens);
      if (!result.truncated) return block;

      changed = true;
      truncatedToolResults += 1;
      savedTokens += result.savedTokens;

      return {
        ...block,
        content: result.content,
      } satisfies ToolResultContentBlock;
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
