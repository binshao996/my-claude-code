import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TranscriptEntry } from "./types";
import { getProjectTranscriptDir } from "./paths";

export type SessionSummary = {
  sessionId: string;
  path: string;
  summary: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  createdAt: string | null;
  lastModified: Date;
  fileSize: number;
};

const SAMPLE_BYTES = 64 * 1024;

export async function listSessions(
  transcriptDir: string,
  limit = 20,
): Promise<SessionSummary[]> {
  const names = await readdir(transcriptDir).catch(() => []);
  const jsonlNames = names.filter((name) => name.endsWith(".jsonl"));

  const files = await Promise.all(
    jsonlNames.map(async (name) => {
      const path = join(transcriptDir, name);
      const info = await stat(path);
      return { path, info };
    }),
  );

  const newest = files
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    .slice(0, limit);

  return Promise.all(
    newest.map(async ({ path, info }) => {
      const sample = await readHeadTail(path);
      return parseSessionSummary(path, sample, info);
    }),
  );
}

export async function listSessionsForCwd(
  cwd: string,
  limit = 20,
): Promise<SessionSummary[]> {
  return listSessions(getProjectTranscriptDir(cwd), limit);
}

async function readHeadTail(path: string): Promise<string> {
  const content = await readFile(path, "utf8");

  if (content.length <= SAMPLE_BYTES * 2) {
    return content;
  }

  return [
    content.slice(0, SAMPLE_BYTES),
    "\n",
    content.slice(-SAMPLE_BYTES),
  ].join("");
}

function parseSessionSummary(
  path: string,
  sample: string,
  info: { mtime: Date; size: number },
): SessionSummary {
  const entries = sample
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((entry): entry is TranscriptEntry => entry !== null);

  // Use sessionId from first message entry, fall back to filename
  const firstMsg = entries.find(
    (entry): entry is TranscriptEntry & { type: "message" } =>
      entry.type === "message",
  );
  const sessionId = firstMsg?.sessionId ?? basename(path, ".jsonl");

  const userMessages = entries
    .filter((entry) => entry.type === "message")
    .filter((entry) => entry.role === "user");

  const firstPrompt = userMessages.at(0)?.content ?? null;
  const lastPrompt = userMessages.at(-1)?.content ?? null;

  return {
    sessionId,
    path,
    summary: truncate(lastPrompt ?? firstPrompt ?? sessionId, 80),
    firstPrompt,
    lastPrompt,
    createdAt: entries.at(0)?.timestamp ?? null,
    lastModified: info.mtime,
    fileSize: info.size,
  };
}

function parseJsonLine(line: string): TranscriptEntry | null {
  try {
    const entry = JSON.parse(line) as TranscriptEntry;
    // Only accept known transcript entry types
    if (
      entry.type === "message" ||
      entry.type === "event" ||
      entry.type === "meta"
    ) {
      return entry;
    }
    return null;
  } catch {
    return null;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "...";
}
