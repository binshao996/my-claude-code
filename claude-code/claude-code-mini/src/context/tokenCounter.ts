// 18add: Approximate token counting — self-contained, no LLM type dependencies
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

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    return sum + estimateMessageTokens(message);
  }, 0);
}
