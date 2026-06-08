import { readFile } from "node:fs/promises";
import type {
  TranscriptEntry,
  TranscriptMessageEntry,
  TranscriptCompactBoundaryEntry,
  TranscriptCompactSummaryEntry,
} from "./types";
import type { ChatMessage } from "../llm/types";
import { getMessagesAfterCompactBoundary } from "../compact/boundary";

export type RestoredConversation = {
  sessionId: string;
  path: string;
  messages: ChatMessage[];
  lastMessageUuid: string | null;
};

export async function readTranscriptFile(path: string): Promise<TranscriptEntry[]> {
  const text = await readFile(path, "utf8");
  const entries: TranscriptEntry[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      entries.push({
        type: "event",
        sessionId: "unknown",
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event: "api_error",
        data: {
          kind: "malformed_transcript_line",
        },
      });
    }
  }

  return entries;
}

export function restoreMessages(
  entries: TranscriptEntry[],
): TranscriptMessageEntry[] {
  const messages = new Map<string, TranscriptMessageEntry>();

  for (const entry of entries) {
    if (entry.type === "message") {
      messages.set(entry.uuid, entry);
    }
  }

  const leaves = new Set(messages.keys());
  for (const message of messages.values()) {
    if (message.parentUuid) {
      leaves.delete(message.parentUuid);
    }
  }

  const leafUuid = [...leaves].at(-1);
  if (!leafUuid) {
    return [];
  }

  const restored: TranscriptMessageEntry[] = [];
  let current: TranscriptMessageEntry | undefined = messages.get(leafUuid);

  while (current) {
    restored.push(current);
    current = current.parentUuid ? messages.get(current.parentUuid) : undefined;
  }

  return restored.reverse();
}

// ─── 23add: resume functions ───────────────────────────────────────

/** Read transcript entries, silently skipping broken lines. */
async function readTranscriptEntries(path: string): Promise<TranscriptEntry[]> {
  const content = await readFile(path, "utf8");
  const entries: TranscriptEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // Ignore broken lines
    }
  }

  return entries;
}

/** Find the latest leaf: a message with no children, preferring newest timestamp. */
function findLatestLeaf(
  messages: TranscriptMessageEntry[],
): TranscriptMessageEntry {
  const parentUuids = new Set(
    messages
      .map((message) => message.parentUuid)
      .filter((uuid): uuid is string => uuid !== null),
  );

  const leaves = messages.filter((message) => !parentUuids.has(message.uuid));
  const candidates = leaves.length > 0 ? leaves : messages;

  return candidates.sort((a, b) => {
    return Date.parse(b.timestamp) - Date.parse(a.timestamp);
  })[0]!;
}

/** Build the message chain from leaf back to root, then reverse. */
function buildMessageChain(
  messages: TranscriptMessageEntry[],
  leafUuid: string,
): TranscriptMessageEntry[] {
  const byUuid = new Map(messages.map((message) => [message.uuid, message]));
  const chain: TranscriptMessageEntry[] = [];
  const seen = new Set<string>();

  let current = byUuid.get(leafUuid);

  while (current) {
    if (seen.has(current.uuid)) {
      throw new Error(`Cycle detected in transcript at ${current.uuid}`);
    }

    seen.add(current.uuid);
    chain.push(current);

    if (current.parentUuid === null) {
      break;
    }

    current = byUuid.get(current.parentUuid);
  }

  return chain.reverse();
}

/** Convert transcript message entries to ChatMessage[], with cleanup. */
function deserializeForResume(
  chain: TranscriptMessageEntry[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const entry of chain) {
    // Skip system messages — they are not part of the user-assistant conversation
    if (entry.role === "system") continue;
    // Skip blank assistant messages
    if (entry.role === "assistant" && entry.content.trim().length === 0) {
      continue;
    }
    messages.push({ role: entry.role, content: entry.content });
  }

  // If last message is user, add an assistant sentinel so history
  // doesn't end mid-turn
  const last = messages.at(-1);
  if (last?.role === "user") {
    messages.push({
      role: "assistant",
      content: "[No response recorded for the previous user message.]",
    });
  }

  return messages;
}

export async function restoreConversationFromPath(
  path: string,
): Promise<RestoredConversation> {
  const entries = await readTranscriptEntries(path);
  const messageEntries = entries.filter(
    (entry): entry is TranscriptMessageEntry => entry.type === "message",
  );

  if (messageEntries.length === 0) {
    throw new Error(`No messages found in transcript: ${path}`);
  }

  const leaf = findLatestLeaf(messageEntries);
  const chain = buildMessageChain(messageEntries, leaf.uuid);
  let messages = deserializeForResume(chain);

  // 24add: Convert compact entries from transcript to ChatMessage format,
  // then filter to only messages after the last compact boundary.
  const compactMessages = convertCompactEntries(entries);
  messages = mergeAndFilterByBoundary(messages, compactMessages);

  return {
    sessionId: leaf.sessionId,
    path,
    messages,
    lastMessageUuid: leaf.uuid,
  };
}

/** Convert compact_boundary and compact_summary transcript entries to ChatMessage. */
function convertCompactEntries(entries: TranscriptEntry[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const entry of entries) {
    if (entry.type === "compact_boundary") {
      const ce = entry as TranscriptCompactBoundaryEntry;
      result.push({
        id: ce.uuid,
        role: "system",
        kind: "compact_boundary",
        content: "Conversation compacted",
        compact: ce.compact,
      });
    } else if (entry.type === "compact_summary") {
      const ce = entry as TranscriptCompactSummaryEntry;
      result.push({
        id: ce.uuid,
        role: "user",
        kind: "compact_summary",
        isMeta: true,
        content: ce.content,
      });
    }
  }

  return result;
}

/** Merge message chain with compact entries, then filter to post-boundary only. */
function mergeAndFilterByBoundary(
  chain: ChatMessage[],
  compactMessages: ChatMessage[],
): ChatMessage[] {
  if (compactMessages.length === 0) return chain;

  // Insert compact messages in chronological order based on id/uuid matching.
  // For simplicity, prepend compact messages before the chain and rely on
  // getMessagesAfterCompactBoundary to filter correctly.
  const merged = [...compactMessages, ...chain];

  return getMessagesAfterCompactBoundary(merged);
}
