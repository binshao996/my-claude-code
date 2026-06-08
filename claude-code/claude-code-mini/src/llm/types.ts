export type ChatRole = "user" | "assistant" | "system";

export type TextContentBlock = {
  type: "text";
  text: string;
};

export type ThinkingContentBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};

export type RedactedThinkingContentBlock = {
  type: "redacted_thinking";
  data: string;
};

export type ToolUseContentBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultContentBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type AssistantContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | RedactedThinkingContentBlock
  | ToolUseContentBlock;

export type ChatContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | RedactedThinkingContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock;

// 24add: Extended message kinds for compact support
export type ChatMessageKind = "compact_boundary" | "compact_summary";

export type ChatMessage = {
  role: ChatRole;
  content: string | ChatContentBlock[];
  // 24add: Optional fields for compact messages
  id?: string;
  kind?: ChatMessageKind;
  isMeta?: boolean;
  compact?: {
    trigger: "manual" | "auto";
    preTokens: number;
    createdAt: string;
    summarizedMessageCount: number;
    lastPreCompactMessageId: string | null;
    customInstructions?: string;
  };
};

export type LLMConfig = {
  apiKey: string;
  model: string;
  maxTokens: number;
  baseURL?: string;
};

export type LLMResponse = {
  content: AssistantContentBlock[];
  text: string;
  toolUses: ToolUseContentBlock[];
  model: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
};

export type LLMStreamEvent =
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "tool_use_start";
      id: string;
      name: string;
    }
  | {
      type: "tool_input_delta";
      id: string;
      name: string;
      inputJSONLength: number;
    }
  | {
      type: "tool_use";
      toolUse: ToolUseContentBlock;
    }
  | {
      type: "message_stop";
      response: LLMResponse;
    };
