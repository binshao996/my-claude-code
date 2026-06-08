import { describe, expect, test } from "bun:test";
import {
  createCompactBoundary,
  findLastCompactBoundaryIndex,
  getCompactStats,
  getMessagesAfterCompactBoundary,
  isCompactBoundary,
  isCompactSummary,
  toModelMessages,
} from "../boundary";

function msg(role: "user" | "assistant", content: string) {
  return { role, content };
}

describe("compact boundary", () => {
  test("creates boundary metadata", () => {
    const boundary = createCompactBoundary({
      trigger: "manual",
      preTokens: 50000,
      summarizedMessageCount: 20,
      lastPreCompactMessageId: "msg-19",
    });

    expect(boundary.role).toBe("system");
    expect(boundary.kind).toBe("compact_boundary");
    expect(boundary.compact?.trigger).toBe("manual");
    expect(boundary.compact?.preTokens).toBe(50000);
    expect(boundary.compact?.summarizedMessageCount).toBe(20);
    expect(boundary.compact?.createdAt).toBeDefined();
  });

  test("identifies compact boundary and summary messages", () => {
    const boundary = createCompactBoundary({
      trigger: "auto",
      preTokens: 30000,
      summarizedMessageCount: 10,
      lastPreCompactMessageId: null,
    });

    expect(isCompactBoundary(boundary)).toBe(true);
    expect(isCompactBoundary(msg("user", "hi"))).toBe(false);

    const summary = {
      role: "user" as const,
      kind: "compact_summary" as const,
      isMeta: true,
      content: "summary text",
    };
    expect(isCompactSummary(summary)).toBe(true);
    expect(isCompactSummary(msg("user", "hi"))).toBe(false);
  });

  test("returns messages after last compact boundary", () => {
    const messages = [
      msg("user", "old"),
      msg("assistant", "old reply"),
      createCompactBoundary({
        trigger: "auto",
        preTokens: 1000,
        summarizedMessageCount: 2,
        lastPreCompactMessageId: null,
      }),
      { role: "user" as const, kind: "compact_summary" as const, isMeta: true, content: "summary" },
      msg("user", "new"),
      msg("assistant", "new reply"),
    ];

    const post = getMessagesAfterCompactBoundary(messages);
    expect(post).toHaveLength(4);
    expect(post[0]!.kind).toBe("compact_boundary");
  });

  test("toModelMessages filters out boundary but keeps summary", () => {
    const messages = [
      createCompactBoundary({
        trigger: "manual",
        preTokens: 1000,
        summarizedMessageCount: 1,
        lastPreCompactMessageId: null,
      }),
      { role: "user" as const, kind: "compact_summary" as const, isMeta: true, content: "summary" },
      msg("user", "recent"),
    ];

    const modelMsgs = toModelMessages(messages);
    expect(modelMsgs).toHaveLength(2);
    expect(modelMsgs[0]!.kind).toBe("compact_summary");
    expect(modelMsgs[1]!.content).toBe("recent");
  });

  test("getCompactStats returns correct counts", () => {
    const messages = [
      msg("user", "1"),
      createCompactBoundary({
        trigger: "auto",
        preTokens: 100,
        summarizedMessageCount: 1,
        lastPreCompactMessageId: null,
      }),
      msg("user", "2"),
      msg("assistant", "3"),
      createCompactBoundary({
        trigger: "manual",
        preTokens: 200,
        summarizedMessageCount: 2,
        lastPreCompactMessageId: null,
      }),
      msg("user", "4"),
    ];

    const stats = getCompactStats(messages);
    expect(stats.hasCompactBoundary).toBe(true);
    expect(stats.compactCount).toBe(2);
    expect(stats.messagesAfterLastCompact).toBe(1);
    expect(stats.lastCompactAt).toBeDefined();
  });
});
