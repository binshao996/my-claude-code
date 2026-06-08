import { describe, expect, test } from "bun:test";
import { microCompactToolResults } from "../microCompact";
import type { ChatMessage } from "../../llm/types";

describe("microCompactToolResults", () => {
  test("keeps recent tool results", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "old result 1" },
          { type: "tool_result", tool_use_id: "2", content: "old result 2" },
          { type: "tool_result", tool_use_id: "3", content: "recent result" },
        ],
      },
    ];

    const { messages: result, clearedCount } = microCompactToolResults(
      messages,
      1,
    );

    expect(clearedCount).toBe(2);
    const msg0 = result[0];
    if (!msg0) throw new Error("Expected message");
    const blocks = msg0.content;
    if (!Array.isArray(blocks)) throw new Error("Expected array content");
    const b0 = blocks[0], b1 = blocks[1], b2 = blocks[2];
    if (!b0 || !b1 || !b2) throw new Error("Expected 3 blocks");
    expect(b0.type === "tool_result" ? b0.content : "").toContain("cleared");
    expect(b1.type === "tool_result" ? b1.content : "").toContain("cleared");
    expect(b2.type === "tool_result" ? b2.content : "").toBe("recent result");
  });

  test("clears older tool results with marker", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "very old" },
        ],
      },
    ];

    const { messages: result, clearedCount } = microCompactToolResults(
      messages,
      0,
    );

    expect(clearedCount).toBe(1);
    const msg0b = result[0];
    if (!msg0b) throw new Error("Expected message");
    const blocks2 = msg0b.content;
    if (!Array.isArray(blocks2)) throw new Error("Expected array content");
    const b0b = blocks2[0];
    if (!b0b) throw new Error("Expected block");
    expect(b0b.type === "tool_result" ? b0b.content : "").toContain(
      "[Old tool result content cleared]",
    );
  });

  test("returns unchanged when no tool results to clear", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "plain text" },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "only one" },
        ],
      },
    ];

    const { messages: result, clearedCount } = microCompactToolResults(
      messages,
      10,
    );

    expect(clearedCount).toBe(0);
    expect(result).toEqual(messages);
  });
});
