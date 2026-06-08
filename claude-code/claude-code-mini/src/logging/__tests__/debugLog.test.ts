import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setSessionId } from "../../session/sessionState";
import {
  disableDebugLog,
  enableDebugLog,
  getDebugLogPath,
  isDebugLogEnabled,
  writeDebugLog,
} from "../debugLog";

let home: string;
const testSessionId = "test-session-debug";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cc-mini-debug-"));
  process.env.CCMINI_HOME = home;
  setSessionId(testSessionId);
  enableDebugLog();
});

afterEach(async () => {
  disableDebugLog();
  delete process.env.CCMINI_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("debugLog", () => {
  test("enable/disable toggles logging", () => {
    expect(isDebugLogEnabled()).toBe(true);

    disableDebugLog();
    expect(isDebugLogEnabled()).toBe(false);

    enableDebugLog();
    expect(isDebugLogEnabled()).toBe(true);
  });

  test("writes log line to file", async () => {
    await writeDebugLog("info", "test message");

    const path = getDebugLogPath();
    const content = await readFile(path, "utf8");

    expect(content).toContain("[INFO]");
    expect(content).toContain("test message");
  });

  test("does not write when disabled", async () => {
    disableDebugLog();
    await writeDebugLog("info", "should not appear");

    const path = getDebugLogPath();
    // File shouldn't exist since we never wrote
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  test("redacts secrets in log messages", async () => {
    await writeDebugLog("info", "token: sk-abc123secret");

    const path = getDebugLogPath();
    const content = await readFile(path, "utf8");

    expect(content).toContain("[redacted]");
    expect(content).not.toContain("sk-abc123secret");
  });
});
