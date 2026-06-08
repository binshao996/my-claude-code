import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/index.mjs";
import { loadLLMConfig } from "./config";
import type { ToolSummary } from "../tools";
// 20add: ModelRouter for role-based model selection
import { modelRouter } from "../models";
import type { ModelRouteRequest } from "../models";
import type {
  AssistantContentBlock,
  ChatContentBlock,
  ChatMessage,
  LLMConfig,
  LLMResponse,
  LLMStreamEvent,
  TextContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types";

type PendingContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "thinking";
      thinking: string;
      signature: string;
    }
  | {
      type: "redacted_thinking";
      data: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      inputJSON: string;
    };

export async function createMessage(
  messages: ChatMessage[],
  tools: ToolSummary[] = [],
  config: LLMConfig = loadLLMConfig(),
  system?: string | null,
  route?: ModelRouteRequest,
): Promise<LLMResponse> {
  const resolved = route ? modelRouter.resolve(route) : null;
  const resolvedModel = resolved?.model ?? config.model;
  const maxTokens = resolved?.capability.maxOutputTokens ?? config.maxTokens;

  const client = createAnthropicClient(config);
  const toolSchemas = toAnthropicTools(tools);

  const response = await client.messages.create({
    model: resolvedModel,
    max_tokens: maxTokens,
    ...(system && { system }),
    messages: toMessageParams(messages),
    ...(toolSchemas.length > 0 && { tools: toolSchemas }),
  });

  const content = normalizeContentBlocks(response.content);

  return {
    content,
    text: extractText(content),
    toolUses: content.filter(isToolUseContentBlock),
    model: response.model,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

export async function* streamMessage(
  messages: ChatMessage[],
  tools: ToolSummary[] = [],
  config: LLMConfig = loadLLMConfig(),
  system?: string | null,
  route?: ModelRouteRequest,
): AsyncGenerator<LLMStreamEvent, void> {
  const resolved = route ? modelRouter.resolve(route) : null;
  const resolvedModel = resolved?.model ?? config.model;
  const maxTokens = resolved?.capability.maxOutputTokens ?? config.maxTokens;

  const client = createAnthropicClient(config);
  const toolSchemas = toAnthropicTools(tools);

  const stream = await client.messages.create({
    model: resolvedModel,
    max_tokens: maxTokens,
    ...(system && { system }),
    messages: toMessageParams(messages),
    stream: true,
    ...(toolSchemas.length > 0 && { tools: toolSchemas }),
  });

  const pendingBlocks = new Map<number, PendingContentBlock>();
  const content: AssistantContentBlock[] = [];

  let model = config.model;
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        model = event.message.model;
        inputTokens = event.message.usage.input_tokens;
        outputTokens = event.message.usage.output_tokens;
        break;

      case "content_block_start":
        if (event.content_block.type === "text") {
          pendingBlocks.set(event.index, {
            type: "text",
            text: "",
          });
        }

        if (event.content_block.type === "thinking") {
          pendingBlocks.set(event.index, {
            type: "thinking",
            thinking: event.content_block.thinking,
            signature: event.content_block.signature,
          });
        }

        if (event.content_block.type === "redacted_thinking") {
          pendingBlocks.set(event.index, {
            type: "redacted_thinking",
            data: event.content_block.data,
          });
        }

        if (event.content_block.type === "tool_use") {
          pendingBlocks.set(event.index, {
            type: "tool_use",
            id: event.content_block.id,
            name: event.content_block.name,
            inputJSON: "",
          });
          yield {
            type: "tool_use_start",
            id: event.content_block.id,
            name: event.content_block.name,
          };
        }

        break;

      case "content_block_delta": {
        const pendingBlock = pendingBlocks.get(event.index);

        if (!pendingBlock) {
          break;
        }

        if (event.delta.type === "text_delta" && pendingBlock.type === "text") {
          pendingBlock.text += event.delta.text;
          yield {
            type: "text_delta",
            text: event.delta.text,
          };
        }

        if (
          event.delta.type === "thinking_delta" &&
          pendingBlock.type === "thinking"
        ) {
          pendingBlock.thinking += event.delta.thinking;
        }

        if (
          event.delta.type === "signature_delta" &&
          pendingBlock.type === "thinking"
        ) {
          pendingBlock.signature = event.delta.signature;
        }

        if (
          event.delta.type === "input_json_delta" &&
          pendingBlock.type === "tool_use"
        ) {
          pendingBlock.inputJSON += event.delta.partial_json;
          yield {
            type: "tool_input_delta",
            id: pendingBlock.id,
            name: pendingBlock.name,
            inputJSONLength: pendingBlock.inputJSON.length,
          };
        }

        break;
      }

      case "content_block_stop": {
        const pendingBlock = pendingBlocks.get(event.index);

        if (!pendingBlock) {
          break;
        }

        pendingBlocks.delete(event.index);

        if (pendingBlock.type === "text") {
          if (pendingBlock.text.length > 0) {
            content.push({
              type: "text",
              text: pendingBlock.text,
            });
          }
        }

        if (pendingBlock.type === "thinking") {
          content.push({
            type: "thinking",
            thinking: pendingBlock.thinking,
            signature: pendingBlock.signature,
          });
        }

        if (pendingBlock.type === "redacted_thinking") {
          content.push({
            type: "redacted_thinking",
            data: pendingBlock.data,
          });
        }

        if (pendingBlock.type === "tool_use") {
          const toolUse: ToolUseContentBlock = {
            type: "tool_use",
            id: pendingBlock.id,
            name: pendingBlock.name,
            input: parseToolInput(pendingBlock.inputJSON, pendingBlock.name),
          };

          content.push(toolUse);
          yield {
            type: "tool_use",
            toolUse,
          };
        }

        break;
      }

      case "message_delta":
        stopReason = event.delta.stop_reason;
        outputTokens = event.usage.output_tokens;
        break;

      case "message_stop":
        yield {
          type: "message_stop",
          response: {
            content,
            text: extractText(content),
            toolUses: content.filter(isToolUseContentBlock),
            model,
            stopReason,
            inputTokens,
            outputTokens,
          },
        };
        break;
    }
  }
}

function createAnthropicClient(config: LLMConfig): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey,
    maxRetries: 1,
    ...(config.baseURL && { baseURL: config.baseURL }),
  });
}

function toMessageParams(messages: ChatMessage[]): MessageParam[] {
  return messages
    .filter((msg): msg is ChatMessage & { role: "user" | "assistant" } =>
      msg.role === "user" || msg.role === "assistant",
    )
    .map(message => ({
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : toContentBlockParams(message.content),
    }));
}

function toContentBlockParams(blocks: ChatContentBlock[]): ContentBlockParam[] {
  return blocks.map(block => {
    switch (block.type) {
      case "text":
        return {
          type: "text",
          text: block.text,
        };

      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };

      case "redacted_thinking":
        return {
          type: "redacted_thinking",
          data: block.data,
        };

      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };

      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error !== undefined && { is_error: block.is_error }),
        };
    }
  });
}

function toAnthropicTools(tools: ToolSummary[]): AnthropicTool[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputJSONSchema,
  }));
}

function normalizeContentBlocks(content: ContentBlock[]): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];

  for (const block of content) {
    if (block.type === "text") {
      blocks.push({
        type: "text",
        text: block.text,
      });
    }

    if (block.type === "thinking") {
      blocks.push({
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      });
    }

    if (block.type === "redacted_thinking") {
      blocks.push({
        type: "redacted_thinking",
        data: block.data,
      });
    }

    if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: normalizeToolInput(block.input),
      });
    }
  }

  return blocks;
}

function parseToolInput(
  inputJSON: string,
  toolName: string,
): Record<string, unknown> {
  const trimmed = inputJSON.trim();

  if (!trimmed) {
    return {};
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse tool input for "${toolName}": ${message}. ` +
        `Received ${trimmed.length} characters of tool input. ` +
        "This usually means the model output was cut off while generating a tool call. " +
        "Try increasing CCMINI_MAX_TOKENS, for example: " +
        "CCMINI_MAX_TOKENS=8192 bun run dev.",
    );
  }

  return normalizeToolInput(value);
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (isRecord(input)) {
    return input;
  }

  throw new Error("Tool input must be a JSON object.");
}

function extractText(content: AssistantContentBlock[]): string {
  return content
    .filter(isTextContentBlock)
    .map(block => block.text)
    .join("");
}

function isTextContentBlock(block: AssistantContentBlock): block is TextContentBlock {
  return block.type === "text";
}

function isToolUseContentBlock(
  block: AssistantContentBlock,
): block is ToolUseContentBlock {
  return block.type === "tool_use";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
