import { randomUUID } from "node:crypto";

let currentSessionId = process.env.CCMINI_SESSION_ID ?? "";
let resumedFromSessionId: string | null = null;

export function setSessionId(id: string): void {
  currentSessionId = id;
}

export function getSessionId(): string {
  return currentSessionId;
}

export function switchSession(sessionId: string): void {
  currentSessionId = sessionId;
  process.env.CCMINI_SESSION_ID = sessionId;
}

export function forkSession(): string {
  resumedFromSessionId = currentSessionId;
  currentSessionId = randomUUID();
  process.env.CCMINI_SESSION_ID = currentSessionId;
  return currentSessionId;
}

export function getResumedFromSessionId(): string | null {
  return resumedFromSessionId;
}
