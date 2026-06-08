import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { getSessionId } from "../session/sessionState";
import { redactJson } from "../logging/redact";
import { getTranscriptPath } from "./paths";
import type { TranscriptEntry, TranscriptRole } from "./types";

let lastMessageUuid: string | null = null;

export function getLastMessageUuid(): string | null {
  return lastMessageUuid;
}

export async function appendTranscriptEntry(entry: TranscriptEntry): Promise<void> {
  const safeEntry = redactJson(entry);
  const path = getTranscriptPath(safeEntry.sessionId);

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(safeEntry) + "\n", { mode: 0o600 });
}

export async function recordTranscriptMessage(input: {
  role: TranscriptRole;
  content: string;
  model?: string;
}): Promise<string> {
  const uuid = randomUUID();
  const entry: TranscriptEntry = {
    type: "message",
    sessionId: getSessionId(),
    uuid,
    parentUuid: lastMessageUuid,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    role: input.role,
    content: input.content,
    model: input.model,
  };

  await appendTranscriptEntry(entry);
  lastMessageUuid = uuid;
  return uuid;
}

export async function recordTranscriptEvent(input: {
  event: TranscriptEntry extends infer T
    ? T extends { type: "event"; event: infer E }
      ? E
      : never
    : never;
  data: Record<string, unknown>;
}): Promise<string> {
  const uuid = randomUUID();
  const entry: TranscriptEntry = {
    type: "event",
    sessionId: getSessionId(),
    uuid,
    timestamp: new Date().toISOString(),
    event: input.event,
    data: input.data,
  };

  await appendTranscriptEntry(entry);
  return uuid;
}
