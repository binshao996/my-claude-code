import { createMessage } from "../llm/anthropicClient";
import { loadLLMConfig } from "../llm/config";
import { modelRouter } from "../models";
import type { ChatMessage } from "../llm/types";
import { buildCompactPrompt } from "./prompt";

function isPromptTooLongError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 400
  );
}

function dropOldestConversationChunk(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 2) {
    throw new Error("No safe chunk left to drop.");
  }

  const dropCount = Math.max(2, Math.ceil(messages.length * 0.2));
  return [
    {
      role: "user",
      content: "[Earlier conversation truncated for compact retry.]",
    },
    ...messages.slice(dropCount),
  ];
}

async function summarizeMessages(input: {
  messages: ChatMessage[];
  customInstructions?: string;
}): Promise<string> {
  const config = loadLLMConfig();
  // Use compact role or fall back to main model
  const resolved = modelRouter.resolve({ role: "main" });
  const system = buildCompactPrompt(input.customInstructions);

  const response = await createMessage(
    input.messages,
    [],
    { ...config, model: resolved.model, maxTokens: 4000 },
    system,
  );

  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text.trim()) {
    throw new Error("Compact failed: empty summary.");
  }

  return text.trim();
}

export async function summarizeWithRetry(input: {
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
