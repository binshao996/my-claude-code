import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  restoreConversationFromPath,
} from "../reader";
import {
  loadConversationForResume,
} from "../resume";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-mini-resume-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function writeTranscript(path: string, entries: object[]): Promise<void> {
  return writeFile(
    path,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

describe("restoreConversationFromPath", () => {
  test("restores message chain from latest leaf", async () => {
    const path = join(dir, "test.jsonl");
    await writeTranscript(path, [
      {
        type: "message",
        sessionId: "s1",
        uuid: "1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "hello",
      },
      {
        type: "message",
        sessionId: "s1",
        uuid: "2",
        parentUuid: "1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: "/test",
        role: "assistant",
        content: "hi there",
      },
    ]);

    const restored = await restoreConversationFromPath(path);
    expect(restored.sessionId).toBe("s1");
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0]!.role).toBe("user");
    expect(restored.messages[0]!.content).toBe("hello");
    expect(restored.messages[1]!.role).toBe("assistant");
    expect(restored.messages[1]!.content).toBe("hi there");
  });

  test("ignores transcript event entries", async () => {
    const path = join(dir, "test.jsonl");
    await writeTranscript(path, [
      {
        type: "message",
        sessionId: "s1",
        uuid: "1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "question",
      },
      {
        type: "event",
        sessionId: "s1",
        uuid: "e1",
        timestamp: "2026-01-01T00:00:00.500Z",
        event: "api_retry",
        data: { attempt: 1 },
      },
      {
        type: "message",
        sessionId: "s1",
        uuid: "2",
        parentUuid: "1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: "/test",
        role: "assistant",
        content: "answer",
      },
    ]);

    const restored = await restoreConversationFromPath(path);
    expect(restored.messages).toHaveLength(2);
  });

  test("stops safely when parent is missing", async () => {
    const path = join(dir, "test.jsonl");
    await writeTranscript(path, [
      {
        type: "message",
        sessionId: "s1",
        uuid: "1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "root message",
      },
      {
        type: "message",
        sessionId: "s1",
        uuid: "2",
        parentUuid: "1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: "/test",
        role: "assistant",
        content: "first reply",
      },
      {
        type: "message",
        sessionId: "s1",
        uuid: "3",
        parentUuid: "missing-uuid",
        timestamp: "2026-01-01T00:00:02.000Z",
        cwd: "/test",
        role: "user",
        content: "orphaned message",
      },
    ]);

    // "3" has no children and the latest timestamp → chosen as leaf.
    // Its chain only has "3" since "missing-uuid" doesn't exist.
    // Should not throw — it safely returns what it can.
    const restored = await restoreConversationFromPath(path);
    expect(restored.messages).toHaveLength(2); // user "3" + sentinel assistant
    expect(restored.messages[0]!.content).toBe("orphaned message");
  });

  test("throws when transcript contains a parent cycle", async () => {
    const path = join(dir, "test.jsonl");
    await writeTranscript(path, [
      {
        type: "message",
        sessionId: "s1",
        uuid: "1",
        parentUuid: "2",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "a",
      },
      {
        type: "message",
        sessionId: "s1",
        uuid: "2",
        parentUuid: "1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: "/test",
        role: "assistant",
        content: "b",
      },
    ]);

    await expect(restoreConversationFromPath(path)).rejects.toThrow("Cycle detected");
  });

  test("adds assistant sentinel when last message is user", async () => {
    const path = join(dir, "test.jsonl");
    await writeTranscript(path, [
      {
        type: "message",
        sessionId: "s1",
        uuid: "1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "unanswered question",
      },
    ]);

    const restored = await restoreConversationFromPath(path);
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[1]!.role).toBe("assistant");
    expect(restored.messages[1]!.content).toContain("No response recorded");
  });
});

describe("loadConversationForResume", () => {
  test("loads latest session when source is undefined", async () => {
    // Write one transcript
    const path = join(dir, "latest.jsonl");
    await writeTranscript(path, [
      {
        type: "message",
        sessionId: "s-latest",
        uuid: "1",
        parentUuid: null,
        timestamp: "2026-06-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "latest",
      },
    ]);

    const restored = await loadConversationForResume(undefined, dir);
    expect(restored.sessionId).toBe("s-latest");
  });

  test("loads by session id", async () => {
    const path = join(dir, "target.jsonl");
    await writeTranscript(path, [
      {
        type: "message",
        sessionId: "target",
        uuid: "1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "by id",
      },
    ]);

    const restored = await loadConversationForResume("target", dir);
    expect(restored.sessionId).toBe("target");
  });

  test("loads by jsonl path", async () => {
    const path = join(dir, "custom.jsonl");
    await writeTranscript(path, [
      {
        type: "message",
        sessionId: "by-path",
        uuid: "1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/test",
        role: "user",
        content: "by path",
      },
    ]);

    const restored = await loadConversationForResume(path, dir);
    expect(restored.sessionId).toBe("by-path");
  });

  test("throws when source session id not found", async () => {
    await expect(
      loadConversationForResume("nonexistent", dir),
    ).rejects.toThrow("Transcript not found");
  });
});
