export type ChatRole = "user" | "assistant";

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

export type ChatMessage = {
  role: ChatRole;
  content: string | ChatContentBlock[];
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
