import type { ClientEventState } from "./event-state";

export type StoredSession = {
  sessionId: string;
  workspaceId: string;
  title: string;
  state: ClientEventState;
  updatedAt: string;
};

export interface SessionStore {
  save(session: StoredSession): void;
  findById(sessionId: string): StoredSession | null;
  listByWorkspace(workspaceId: string): StoredSession[];
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();

  save(session: StoredSession): void {
    this.sessions.set(session.sessionId, session);
  }

  findById(sessionId: string): StoredSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  listByWorkspace(workspaceId: string): StoredSession[] {
    return Array.from(this.sessions.values()).filter((session) => session.workspaceId === workspaceId);
  }
}
