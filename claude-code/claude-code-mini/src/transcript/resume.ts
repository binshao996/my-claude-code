import { access } from "node:fs/promises";
import { join } from "node:path";
import { switchSession } from "../session/sessionState";
import { getProjectTranscriptDir } from "./paths";
import { listSessions } from "./sessionList";
import type { ChatMessage } from "../llm/types";
import {
  restoreConversationFromPath,
  type RestoredConversation,
} from "./reader";

export type { RestoredConversation } from "./reader";

export async function loadConversationForResume(
  source: string | undefined,
  transcriptDir: string,
): Promise<RestoredConversation> {
  if (!source) {
    const sessions = await listSessions(transcriptDir, 1);
    const latest = sessions.at(0);

    if (!latest) {
      throw new Error("No conversation found to continue.");
    }

    return restoreConversationFromPath(latest.path);
  }

  if (source.endsWith(".jsonl")) {
    await assertReadable(source);
    return restoreConversationFromPath(source);
  }

  const path = join(transcriptDir, `${source}.jsonl`);
  await assertReadable(path);
  return restoreConversationFromPath(path);
}

export async function continueLatestConversation(
  transcriptDir: string,
): Promise<{ restored: RestoredConversation; messages: ChatMessage[] }> {
  const restored = await loadConversationForResume(undefined, transcriptDir);
  switchSession(restored.sessionId);
  return {
    restored,
    messages: restored.messages,
  };
}

export async function resumeConversation(
  source: string,
  transcriptDir: string,
): Promise<{ restored: RestoredConversation; messages: ChatMessage[] }> {
  const restored = await loadConversationForResume(source, transcriptDir);
  switchSession(restored.sessionId);
  return {
    restored,
    messages: restored.messages,
  };
}

export function getTranscriptDirForCwd(cwd: string): string {
  return getProjectTranscriptDir(cwd);
}

async function assertReadable(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Transcript not found: ${path}`);
  }
}
