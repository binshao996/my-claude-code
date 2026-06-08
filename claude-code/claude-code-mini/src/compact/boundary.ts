import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../llm/types";
import type { CompactTrigger } from "./types";

export function createCompactBoundary(input: {
  trigger: CompactTrigger;
  preTokens: number;
  summarizedMessageCount: number;
  lastPreCompactMessageId: string | null;
  customInstructions?: string;
}): ChatMessage {
  return {
    id: randomUUID(),
    role: "system",
    kind: "compact_boundary",
    content: "Conversation compacted",
    compact: {
      trigger: input.trigger,
      preTokens: input.preTokens,
      createdAt: new Date().toISOString(),
      summarizedMessageCount: input.summarizedMessageCount,
      lastPreCompactMessageId: input.lastPreCompactMessageId,
      customInstructions: input.customInstructions,
    },
  };
}

export function isCompactBoundary(
  message: ChatMessage,
): boolean {
  return message.kind === "compact_boundary";
}

export function isCompactSummary(
  message: ChatMessage,
): boolean {
  return message.kind === "compact_summary";
}

export function findLastCompactBoundaryIndex(
  messages: ChatMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isCompactBoundary(messages[index]!)) {
      return index;
    }
  }
  return -1;
}

export function getMessagesAfterCompactBoundary(
  messages: ChatMessage[],
): ChatMessage[] {
  const index = findLastCompactBoundaryIndex(messages);
  return index === -1 ? messages : messages.slice(index);
}

export function toModelMessages(messages: ChatMessage[]): ChatMessage[] {
  return getMessagesAfterCompactBoundary(messages)
    .filter((msg) => !isCompactBoundary(msg));
}

export function getCompactStats(messages: ChatMessage[]): {
  hasCompactBoundary: boolean;
  compactCount: number;
  messagesAfterLastCompact: number;
  lastCompactAt: string | null;
} {
  const boundaries = messages.filter(isCompactBoundary);
  const lastBoundaryIndex = findLastCompactBoundaryIndex(messages);

  return {
    hasCompactBoundary: boundaries.length > 0,
    compactCount: boundaries.length,
    messagesAfterLastCompact:
      lastBoundaryIndex === -1
        ? messages.length
        : messages.length - lastBoundaryIndex - 1,
    lastCompactAt: boundaries.at(-1)?.compact?.createdAt ?? null,
  };
}
