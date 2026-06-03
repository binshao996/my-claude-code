import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatMessage } from "../llm/types";
import type {
  LoadedSession,
  SessionListItem,
  SessionMetadata,
  SessionTranscriptEntry,
} from "./types";
import type { Plan } from "../planner";

const SESSION_FILE_EXTENSION = ".jsonl";
const MINI_VERSION = "mini";
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export class SessionStore {
  constructor(
    private readonly cwd: string,
    private readonly homeDir = getMiniHomeDir(),
  ) {}

  async createSession(requestedSessionId?: string): Promise<LoadedSession> {
    const sessionId = requestedSessionId ?? randomUUID();
    assertValidSessionId(sessionId);

    const createdAt = new Date().toISOString();
    const path = this.getSessionPath(sessionId);

    const metadata: SessionMetadata = {
      sessionId,
      cwd: this.cwd,
      createdAt,
      version: MINI_VERSION,
    };

    const entry: SessionTranscriptEntry = {
      type: "metadata",
      metadata,
    };

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    return {
      metadata,
      messages: [],
      plan: null,
      path,
    };
  }

  async appendMessages(
    sessionId: string,
    messages: readonly ChatMessage[],
  ): Promise<void> {
    assertValidSessionId(sessionId);

    if (messages.length === 0) {
      return;
    }

    const path = this.getSessionPath(sessionId);
    const now = new Date().toISOString();
    const lines = messages
      .map(
        message =>
          JSON.stringify({
            type: "message",
            sessionId,
            timestamp: now,
            message,
          } satisfies SessionTranscriptEntry) + "\n",
      )
      .join("");

    await appendFile(path, lines, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async loadSession(sessionId: string): Promise<LoadedSession | null> {
    assertValidSessionId(sessionId);

    const path = this.getSessionPath(sessionId);

    try {
      const raw = await readFile(path, "utf8");
      return parseSessionTranscript(raw, path, sessionId, this.cwd);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async listSessions(): Promise<SessionListItem[]> {
    const dir = this.getProjectSessionsDir();

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }

      throw error;
    }

    const sessions: SessionListItem[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(SESSION_FILE_EXTENSION)) {
        continue;
      }

      const sessionId = entry.slice(0, -SESSION_FILE_EXTENSION.length);
      const loaded = await this.loadSession(sessionId);

      if (!loaded) {
        continue;
      }

      const fileStat = await stat(loaded.path);
      sessions.push({
        sessionId,
        path: loaded.path,
        cwd: loaded.metadata.cwd,
        createdAt: loaded.metadata.createdAt,
        updatedAt: fileStat.mtime.toISOString(),
        messageCount: loaded.messages.length,
        firstPrompt: getFirstPrompt(loaded.messages),
      });
    }

    return sessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async getLatestSession(): Promise<LoadedSession | null> {
    const [latest] = await this.listSessions();

    if (!latest) {
      return null;
    }

    return this.loadSession(latest.sessionId);
  }

  getSessionPath(sessionId: string): string {
    assertValidSessionId(sessionId);

    return join(
      this.getProjectSessionsDir(),
      `${sessionId}${SESSION_FILE_EXTENSION}`,
    );
  }

  private getProjectSessionsDir(): string {
    return join(this.homeDir, "projects", sanitizeProjectPath(this.cwd));
  }

  async appendPlan(sessionId: string, plan: Plan | null): Promise<void> {
    assertValidSessionId(sessionId);

    const path = this.getSessionPath(sessionId);
    const entry: SessionTranscriptEntry = {
      type: "plan",
      sessionId,
      timestamp: new Date().toISOString(),
      plan,
    };

    await appendFile(path, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function parseSessionTranscript(
  raw: string,
  path: string,
  fallbackSessionId: string,
  fallbackCwd: string,
): LoadedSession {
  let metadata: SessionMetadata | undefined;
  const messages: ChatMessage[] = [];
  let plan: Plan | null = null;

  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim();

    if (!line) {
      continue;
    }

    let entry: SessionTranscriptEntry;

    try {
      entry = JSON.parse(line) as SessionTranscriptEntry;
    } catch {
      throw new Error(`Invalid JSONL at ${path}:${index + 1}`);
    }

    if (entry.type === "metadata") {
      metadata = entry.metadata;
      continue;
    }

    if (entry.type === "message") {
      messages.push(entry.message);
      continue;
    }

    if (entry.type === "plan") {
      plan = entry.plan;
    }
  }

  return {
    metadata:
      metadata ??
      {
        sessionId: fallbackSessionId,
        cwd: fallbackCwd,
        createdAt: new Date(0).toISOString(),
        version: MINI_VERSION,
      },
    messages,
    plan,
    path,
  };
}

function getFirstPrompt(messages: readonly ChatMessage[]): string {
  const firstUserMessage = messages.find(
    message => message.role === "user" && typeof message.content === "string",
  );

  if (!firstUserMessage || typeof firstUserMessage.content !== "string") {
    return "";
  }

  const prompt = firstUserMessage.content.replace(/\s+/g, " ").trim();
  return prompt.length > 80 ? `${prompt.slice(0, 80).trim()}...` : prompt;
}

function sanitizeProjectPath(cwd: string): string {
  const sanitized = cwd
    .normalize("NFC")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-");

  return sanitized || "default";
}

function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      "Invalid session id. Use letters, numbers, dots, underscores, or dashes.",
    );
  }
}

function getMiniHomeDir(): string {
  return process.env.CCMINI_HOME ?? join(homedir(), ".claude-code-mini");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

