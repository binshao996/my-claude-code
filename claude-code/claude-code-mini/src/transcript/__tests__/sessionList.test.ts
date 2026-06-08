import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listSessions } from "../sessionList";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-mini-sessions-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listSessions", () => {
  test("returns empty array for empty directory", async () => {
    const sessions = await listSessions(dir);
    expect(sessions).toHaveLength(0);
  });

  test("returns sessions newest first", async () => {
    // Write two transcript files
    const older = join(dir, "a-session.jsonl");
    const newer = join(dir, "b-session.jsonl");

    await writeFile(
      older,
      JSON.stringify({
        type: "message",
        sessionId: "a",
        uuid: "1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "old question",
      }) + "\n",
    );

    // Small delay so mtime differs
    await new Promise((r) => setTimeout(r, 20));

    await writeFile(
      newer,
      JSON.stringify({
        type: "message",
        sessionId: "b",
        uuid: "2",
        parentUuid: null,
        timestamp: "2026-06-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "newer question",
      }) + "\n",
    );

    const sessions = await listSessions(dir);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0]!.sessionId).toBe("b");
  });

  test("uses last user prompt as summary", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "message",
          sessionId: "s1",
          uuid: "1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/test",
          role: "user",
          content: "first question",
        }),
        JSON.stringify({
          type: "message",
          sessionId: "s1",
          uuid: "2",
          parentUuid: "1",
          timestamp: "2026-01-01T00:00:01.000Z",
          cwd: "/test",
          role: "assistant",
          content: "answer",
        }),
        JSON.stringify({
          type: "message",
          sessionId: "s1",
          uuid: "3",
          parentUuid: "2",
          timestamp: "2026-01-01T00:00:02.000Z",
          cwd: "/test",
          role: "user",
          content: "second question",
        }),
      ].join("\n") + "\n",
    );

    const sessions = await listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.summary).toContain("second question");
  });

  test("ignores broken jsonl lines", async () => {
    const path = join(dir, "test.jsonl");
    await writeFile(
      path,
      [
        "this is not json",
        JSON.stringify({
          type: "message",
          sessionId: "s1",
          uuid: "1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/test",
          role: "user",
          content: "valid message",
        }),
      ].join("\n") + "\n",
    );

    const sessions = await listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.firstPrompt).toBe("valid message");
  });
});
