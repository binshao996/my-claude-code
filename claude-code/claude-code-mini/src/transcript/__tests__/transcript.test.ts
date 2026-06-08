import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setSessionId } from "../../session/sessionState";
import {
  appendTranscriptEntry,
  recordTranscriptMessage,
} from "../store";
import { readTranscriptFile, restoreMessages } from "../reader";

let home: string;
const testSessionId = "test-session-transcript";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cc-mini-transcript-"));
  process.env.CCMINI_HOME = home;
  setSessionId(testSessionId);
});

afterEach(async () => {
  delete process.env.CCMINI_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("transcript", () => {
  test("writes one JSON entry per line", async () => {
    await appendTranscriptEntry({
      type: "event",
      sessionId: testSessionId,
      uuid: "e1",
      timestamp: "2026-05-26T00:00:00.000Z",
      event: "api_retry",
      data: { attempt: 1 },
    });

    const sanitized = process.cwd().replace(/[^a-zA-Z0-9._-]/g, "-");
    const file = join(home, "projects", sanitized, `${testSessionId}.jsonl`);
    const text = await readFile(file, "utf8");

    expect(text.trim().split("\n")).toHaveLength(1);
  });

  test("restores message chain and ignores events", async () => {
    await recordTranscriptMessage({ role: "user", content: "hi" });
    await appendTranscriptEntry({
      type: "event",
      sessionId: testSessionId,
      uuid: "e1",
      timestamp: "2026-05-26T00:00:00.000Z",
      event: "api_retry",
      data: { attempt: 1 },
    });
    await recordTranscriptMessage({ role: "assistant", content: "hello" });

    const sanitized = process.cwd().replace(/[^a-zA-Z0-9._-]/g, "-");
    const file = join(home, "projects", sanitized, `${testSessionId}.jsonl`);
    const entries = await readTranscriptFile(file);
    const restored = restoreMessages(entries);

    expect(restored.map(message => message.role)).toEqual(["user", "assistant"]);
  });
});
