export type TranscriptRole = "user" | "assistant" | "system";

export type TranscriptMessageEntry = {
  type: "message";
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  cwd: string;
  role: TranscriptRole;
  content: string;
  model?: string;
};

export type TranscriptEventEntry = {
  type: "event";
  sessionId: string;
  uuid: string;
  timestamp: string;
  event: "api_retry" | "streaming_fallback" | "model_fallback" | "api_error";
  data: Record<string, unknown>;
};

export type TranscriptMetaEntry = {
  type: "meta";
  sessionId: string;
  uuid: string;
  timestamp: string;
  key: string;
  value: unknown;
};

// 24add: Compact boundary and summary transcript entries
export type TranscriptCompactBoundaryEntry = {
  type: "compact_boundary";
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  compact: {
    trigger: "manual" | "auto";
    preTokens: number;
    createdAt: string;
    summarizedMessageCount: number;
    lastPreCompactMessageId: string | null;
    customInstructions?: string;
  };
};

export type TranscriptCompactSummaryEntry = {
  type: "compact_summary";
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  content: string;
};

export type TranscriptEntry =
  | TranscriptMessageEntry
  | TranscriptEventEntry
  | TranscriptMetaEntry
  | TranscriptCompactBoundaryEntry
  | TranscriptCompactSummaryEntry;
