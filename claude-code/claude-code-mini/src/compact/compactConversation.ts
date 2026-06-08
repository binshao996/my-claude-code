import { randomUUID } from "node:crypto";
import { estimateMessagesTokens } from "../context/tokenCounter";
import type { ChatMessage } from "../llm/types";
import { createCompactBoundary } from "./boundary";
import { buildCompactSummaryMessage } from "./prompt";
import { summarizeWithRetry } from "./summarize";
import type { CompactResult, CompactTrigger } from "./types";
import { splitMessagesForCompact } from "./window";

export async function compactConversation(input: {
  messages: ChatMessage[];
  trigger: CompactTrigger;
  customInstructions?: string;
}): Promise<CompactResult> {
  const preTokens = estimateMessagesTokens(input.messages);
  const { messagesToSummarize, messagesToKeep } =
    splitMessagesForCompact(input.messages);

  const summaryText = await summarizeWithRetry({
    messages: messagesToSummarize,
    customInstructions: input.customInstructions,
  });

  const boundary = createCompactBoundary({
    trigger: input.trigger,
    preTokens,
    summarizedMessageCount: messagesToSummarize.length,
    lastPreCompactMessageId: messagesToSummarize.at(-1)?.id ?? null,
    customInstructions: input.customInstructions,
  });

  const summary: ChatMessage = {
    id: randomUUID(),
    role: "user",
    kind: "compact_summary",
    isMeta: true,
    content: buildCompactSummaryMessage(summaryText),
  };

  const postMessages = buildPostCompactMessages({
    boundary,
    summary,
    messagesToKeep,
  });

  return {
    boundary,
    summary,
    messagesToKeep,
    preTokens,
    postTokens: estimateMessagesTokens(postMessages),
  };
}

export function buildPostCompactMessages(input: {
  boundary: ChatMessage;
  summary: ChatMessage;
  messagesToKeep: ChatMessage[];
}): ChatMessage[] {
  return [input.boundary, input.summary, ...input.messagesToKeep];
}
