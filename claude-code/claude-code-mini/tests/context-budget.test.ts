// 18add: Context budget tests — message trimming, memory truncation, tool result capping
import { describe, expect, test } from "bun:test";
import { ContextPreparer } from "../src/context/contextPreparer";
import type { ChatMessage } from "../src/llm/types";

function text(size: number): string {
  return "x".repeat(size);
}

describe("ContextPreparer", () => {
  test("keeps newest messages inside the budget", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: text(4000) },
      { role: "assistant", content: text(4000) },
      { role: "user", content: "latest task" },
    ];

    const preparer = new ContextPreparer({
      contextWindowTokens: 3000,
      reservedOutputTokens: 500,
      compactBufferTokens: 500,
      memoryBudgetTokens: 200,
      runtimeBudgetTokens: 200,
      maxToolResultTokens: 300,
    });

    const result = preparer.prepare({
      systemPrompt: "system",
      memoryPrompt: null,
      runtimeContext: "",
      messages,
    });

    const lastMessage = result.messages.at(-1);
    expect(lastMessage?.content).toBe("latest task");
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.truncated).toBe(true);
  });

  test("truncates memory independently from messages", () => {
    const preparer = new ContextPreparer({
      contextWindowTokens: 5000,
      reservedOutputTokens: 500,
      compactBufferTokens: 500,
      memoryBudgetTokens: 100,
      runtimeBudgetTokens: 200,
      maxToolResultTokens: 300,
    });

    const result = preparer.prepare({
      systemPrompt: "system",
      memoryPrompt: text(2000),
      runtimeContext: "",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.system).toContain("Content truncated");
    expect(result.truncated).toBe(true);
  });

  test("truncates large tool results", () => {
    const preparer = new ContextPreparer({
      contextWindowTokens: 8000,
      reservedOutputTokens: 500,
      compactBufferTokens: 500,
      memoryBudgetTokens: 200,
      runtimeBudgetTokens: 200,
      maxToolResultTokens: 100,
    });

    const result = preparer.prepare({
      systemPrompt: "system",
      memoryPrompt: null,
      runtimeContext: "",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: text(4000),
            },
          ],
        },
      ],
    });

    const content = result.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(JSON.stringify(content)).toContain("Tool result truncated");
    expect(result.truncated).toBe(true);
  });
});
