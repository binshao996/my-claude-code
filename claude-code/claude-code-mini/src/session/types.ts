import type { ChatMessage } from "../llm/types";
import type { Plan } from "../planner";

export type SessionMetadata = {
  sessionId: string;
  cwd: string;
  createdAt: string;
  version: string;
};

export type SessionTranscriptEntry =
  | {
      type: "metadata";
      metadata: SessionMetadata;
    }
  | {
      type: "message";
      sessionId: string;
      timestamp: string;
      message: ChatMessage;
    }
  | {
      type: "plan";
      sessionId: string;
      timestamp: string;
      plan: Plan | null;
    };

export type LoadedSession = {
  metadata: SessionMetadata;
  messages: ChatMessage[];
  plan: Plan | null;
  path: string;
};

export type SessionListItem = {
  sessionId: string;
  path: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  firstPrompt: string;
};
