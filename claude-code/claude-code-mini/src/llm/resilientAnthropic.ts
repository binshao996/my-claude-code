// 21add: Resilient Anthropic client — retry + streaming fallback + model fallback
import { createMessage, streamMessage } from "./anthropicClient";
import type { ChatMessage, LLMConfig, LLMResponse, LLMStreamEvent } from "./types";
import type { ToolSummary } from "../tools";
import type { ModelRouteRequest } from "../models";
import { toUserFacingApiError } from "./apiErrors";
import {
  type FallbackEvent,
  shouldFallbackModel,
  shouldFallbackToNonStreaming,
} from "./fallback";
import { CannotRetryError, type RetryEvent, withRetry } from "./retry";

export type ResilientStreamEvent =
  | LLMStreamEvent
  | RetryEvent
  | FallbackEvent;

export type ResilientOptions = {
  signal?: AbortSignal;
  onRetry?: (event: RetryEvent) => void;
  onFallback?: (event: FallbackEvent) => void;
};

export async function* streamMessageResilient(
  messages: ChatMessage[],
  tools: ToolSummary[],
  config: LLMConfig,
  system: string | null | undefined,
  route: ModelRouteRequest,
  options: ResilientOptions = {},
): AsyncGenerator<ResilientStreamEvent, void> {
  let usedModelFallback = false;
  let currentRoute = route;

  while (true) {
    try {
      yield* await attemptStreaming(messages, tools, config, system, currentRoute, options);
      return;
    } catch (error) {
      const originalError =
        error instanceof CannotRetryError ? error.originalError : error;

      if (
        !usedModelFallback &&
        shouldFallbackModel(originalError)
      ) {
        const modelConfig = (await import("../models/config")).loadModelConfig();
        if (modelConfig.fallbackModel) {
          options.onFallback?.({
            type: "model_fallback",
            from: currentRoute.commandModel ?? currentRoute.role,
            to: modelConfig.fallbackModel,
            reason: "capacity or rate limit error",
          });

          usedModelFallback = true;
          currentRoute = { ...currentRoute, commandModel: modelConfig.fallbackModel };
          continue;
        }
      }

      const model = currentRoute.commandModel ?? currentRoute.role;
      throw new Error(toUserFacingApiError(originalError, model));
    }
  }
}

async function attemptStreaming(
  messages: ChatMessage[],
  tools: ToolSummary[],
  config: LLMConfig,
  system: string | null | undefined,
  route: ModelRouteRequest,
  options: ResilientOptions,
): Promise<AsyncGenerator<ResilientStreamEvent, void>> {
  async function* inner(): AsyncGenerator<ResilientStreamEvent, void> {
    try {
      yield* await withRetry(
        async () => {
          return streamAttempt(messages, tools, config, system, route, options);
        },
        {
          signal: options.signal,
          onRetry: options.onRetry,
        },
      );
    } catch (error) {
      const originalError =
        error instanceof CannotRetryError ? error.originalError : error;

      if (shouldFallbackToNonStreaming(originalError)) {
        options.onFallback?.({
          type: "streaming_fallback",
          reason: "streaming request failed; retrying once without streaming",
        });

        yield* nonStreamingAsStream(messages, tools, config, system, route);
        return;
      }

      throw error;
    }
  }

  return inner();
}

// streamAttempt wraps streamMessage for withRetry — must be a simple async function
// that returns an AsyncGenerator when called. withRetry expects a plain async function.
async function streamAttempt(
  messages: ChatMessage[],
  tools: ToolSummary[],
  config: LLMConfig,
  system: string | null | undefined,
  route: ModelRouteRequest,
  options: ResilientOptions,
): Promise<AsyncGenerator<ResilientStreamEvent, void>> {
  async function* gen(): AsyncGenerator<ResilientStreamEvent, void> {
    for await (const event of streamMessage(messages, tools, config, system, route)) {
      yield event;
    }
  }
  return gen();
}

async function* nonStreamingAsStream(
  messages: ChatMessage[],
  tools: ToolSummary[],
  config: LLMConfig,
  system: string | null | undefined,
  route: ModelRouteRequest,
): AsyncGenerator<ResilientStreamEvent, void> {
  let response: LLMResponse;
  try {
    response = await createMessage(messages, tools, config, system, route);
  } catch (error) {
    throw error;
  }

  for (const block of response.content) {
    if (block.type === "text") {
      yield {
        type: "text_delta",
        text: block.text,
      };
    }

    if (block.type === "tool_use") {
      yield {
        type: "tool_use_start",
        id: block.id,
        name: block.name,
      };
      yield {
        type: "tool_use",
        toolUse: block,
      };
    }
  }

  yield {
    type: "message_stop",
    response,
  };
}
