import { DEFAULT_CONTEXT_BUDGET } from "../context/budget";
import { estimateMessagesTokens } from "../context/tokenCounter";
import type { ChatMessage } from "../llm/types";
import { compactConversation } from "./compactConversation";
import { buildPostCompactMessages } from "./compactConversation";

export type AutoCompactDecision = {
  shouldCompact: boolean;
  usedTokens: number;
  threshold: number;
};

export function shouldAutoCompact(
  messages: ChatMessage[],
): AutoCompactDecision {
  const usedTokens = estimateMessagesTokens(messages);
  const effectiveInput =
    DEFAULT_CONTEXT_BUDGET.contextWindowTokens -
    DEFAULT_CONTEXT_BUDGET.reservedOutputTokens;
  const threshold =
    effectiveInput - DEFAULT_CONTEXT_BUDGET.compactBufferTokens;

  return {
    shouldCompact: usedTokens >= threshold,
    usedTokens,
    threshold,
  };
}

const MAX_COMPACT_FAILURES = 3;

let isCompacting = false;
let consecutiveAutoCompactFailures = 0;

export function resetAutoCompactState(): void {
  isCompacting = false;
  consecutiveAutoCompactFailures = 0;
}

export async function autoCompactIfNeeded(
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  if (isCompacting) return messages;
  if (consecutiveAutoCompactFailures >= MAX_COMPACT_FAILURES) return messages;

  const decision = shouldAutoCompact(messages);
  if (!decision.shouldCompact) return messages;

  try {
    isCompacting = true;
    const result = await compactConversation({
      messages,
      trigger: "auto",
    });

    consecutiveAutoCompactFailures = 0;
    return buildPostCompactMessages(result);
  } catch (error) {
    consecutiveAutoCompactFailures += 1;
    console.error(`Auto compact failed: ${String(error)}`);
    return messages;
  } finally {
    isCompacting = false;
  }
}
