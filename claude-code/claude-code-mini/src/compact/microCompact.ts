import type { ChatMessage, ToolResultContentBlock } from "../llm/types";

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
      .map((loc) => `${loc.messageIndex}:${loc.blockIndex}`),
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

        const cleared: ToolResultContentBlock = {
          ...block,
          content: CLEARED_TOOL_RESULT,
        };
        return cleared;
      }),
    };
  });

  return {
    messages: next,
    clearedCount: clearSet.size,
  };
}
