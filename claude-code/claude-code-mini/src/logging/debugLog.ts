import { appendFile, mkdir, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSessionId } from "../session/sessionState";
import { redactSecrets } from "./redact";

export type DebugLevel = "verbose" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<DebugLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

let debugEnabled = process.env.CCMINI_DEBUG === "1";
let minLevel: DebugLevel = "debug";

export function enableDebugLog(): void {
  debugEnabled = true;
}

export function disableDebugLog(): void {
  debugEnabled = false;
}

export function isDebugLogEnabled(): boolean {
  return debugEnabled;
}

export function setDebugMinLevel(level: DebugLevel): void {
  minLevel = level;
}

export function getConfigDir(): string {
  return process.env.CCMINI_HOME ?? join(process.env.HOME ?? ".", ".claude-code-mini");
}

export function getDebugLogPath(): string {
  return process.env.CCMINI_DEBUG_FILE
    ?? join(getConfigDir(), "debug", `${getSessionId()}.log`);
}

async function updateLatestSymlink(path: string): Promise<void> {
  const latest = join(dirname(path), "latest.log");
  await unlink(latest).catch(() => {});
  await symlink(path, latest).catch(() => {});
}

export async function writeDebugLog(
  level: DebugLevel,
  message: string,
): Promise<void> {
  if (!debugEnabled) {
    return;
  }

  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
    return;
  }

  const path = getDebugLogPath();
  await mkdir(dirname(path), { recursive: true });

  const safeMessage = redactSecrets(message).replace(/\n/g, "\\n");
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${safeMessage}\n`;

  await appendFile(path, line, { mode: 0o600 });
  await updateLatestSymlink(path);
}
