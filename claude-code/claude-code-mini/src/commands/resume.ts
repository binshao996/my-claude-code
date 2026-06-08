import type { ChatMessage } from "../llm/types";
import {
  continueLatestConversation,
  getTranscriptDirForCwd,
  resumeConversation,
} from "../transcript/resume";

export type ResumeResult = {
  sessionId: string;
  messages: ChatMessage[];
};

export async function runContinueCommand(cwd: string): Promise<ResumeResult> {
  const transcriptDir = getTranscriptDirForCwd(cwd);
  const { restored, messages } = await continueLatestConversation(transcriptDir);
  return { sessionId: restored.sessionId, messages };
}

export async function runResumeCommand(
  source: string,
  cwd: string,
): Promise<ResumeResult> {
  const transcriptDir = getTranscriptDirForCwd(cwd);
  const { restored, messages } = await resumeConversation(source, transcriptDir);
  return { sessionId: restored.sessionId, messages };
}
