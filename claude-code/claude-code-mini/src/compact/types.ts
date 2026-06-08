import type { ChatMessage } from "../llm/types";

export type CompactTrigger = "manual" | "auto";

export type CompactResult = {
  boundary: ChatMessage;
  summary: ChatMessage;
  messagesToKeep: ChatMessage[];
  preTokens: number;
  postTokens: number;
};

export type CompactWindowConfig = {
  keepRecentMessages: number;
  minMessagesToCompact: number;
};

export const DEFAULT_COMPACT_WINDOW: CompactWindowConfig = {
  keepRecentMessages: 8,
  minMessagesToCompact: 6,
};
