import { join } from "node:path";
import { getSessionId } from "../session/sessionState";

export function getConfigDir(): string {
  return process.env.CCMINI_HOME ?? join(process.env.HOME ?? ".", ".claude-code-mini");
}

export function sanitizePathForFile(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function getProjectTranscriptDir(cwd = process.cwd()): string {
  return join(getConfigDir(), "projects", sanitizePathForFile(cwd));
}

export function getTranscriptPath(sessionId = getSessionId()): string {
  return join(getProjectTranscriptDir(), `${sessionId}.jsonl`);
}
