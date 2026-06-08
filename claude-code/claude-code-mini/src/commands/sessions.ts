import { listSessionsForCwd } from "../transcript/sessionList";

export async function runSessionsCommand(cwd: string): Promise<string> {
  const sessions = await listSessionsForCwd(cwd, 10);

  if (sessions.length === 0) {
    return "No sessions found.";
  }

  const lines: string[] = [];
  for (const session of sessions) {
    const time = session.lastModified.toLocaleString();
    lines.push(`${session.sessionId}  ${time}  ${session.summary}`);
  }

  return lines.join("\n");
}
