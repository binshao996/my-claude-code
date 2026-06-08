import type { ChatMessage } from "../llm/types";
import {
  getMessagesAfterCompactBoundary,
  isCompactBoundary,
} from "./boundary";
import { DEFAULT_COMPACT_WINDOW, type CompactWindowConfig } from "./types";

export function splitMessagesForCompact(
  messages: ChatMessage[],
  config: CompactWindowConfig = DEFAULT_COMPACT_WINDOW,
): {
  messagesToSummarize: ChatMessage[];
  messagesToKeep: ChatMessage[];
} {
  const compactable = getMessagesAfterCompactBoundary(messages).filter(
    (msg) => !isCompactBoundary(msg),
  );

  if (compactable.length < config.minMessagesToCompact) {
    throw new Error(
      "Not enough messages to compact. Send a few more messages first.",
    );
  }

  const keepCount = Math.min(
    config.keepRecentMessages,
    compactable.length - 1,
  );
  const splitIndex = Math.max(1, compactable.length - keepCount);

  return {
    messagesToSummarize: compactable.slice(0, splitIndex),
    messagesToKeep: compactable.slice(splitIndex),
  };
}
