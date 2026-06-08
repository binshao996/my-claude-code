import { describe, expect, test } from "bun:test";
import { splitMessagesForCompact } from "../window";
import type { ChatMessage } from "../../llm/types";
import { createCompactBoundary } from "../boundary";

function msg(role: "user" | "assistant", content: string): ChatMessage {
  return { role, content };
}

describe("splitMessagesForCompact", () => {
  test("keeps recent messages", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg(i % 2 === 0 ? "user" : "assistant", `msg ${i}`));
    }

    const { messagesToSummarize, messagesToKeep } =
      splitMessagesForCompact(messages, {
        keepRecentMessages: 8,
        minMessagesToCompact: 6,
      });

    expect(messagesToKeep).toHaveLength(8);
    expect(messagesToSummarize).toHaveLength(12);
    expect(messagesToKeep[0]!.content).toBe("msg 12");
    expect(messagesToKeep[7]!.content).toBe("msg 19");
  });

  test("throws when there are too few messages", () => {
    const messages = [msg("user", "hi")];

    expect(() =>
      splitMessagesForCompact(messages, {
        keepRecentMessages: 8,
        minMessagesToCompact: 6,
      }),
    ).toThrow("Not enough messages to compact");
  });

  test("does not summarize messages before last boundary", () => {
    const boundary = createCompactBoundary({
      trigger: "manual",
      preTokens: 1000,
      summarizedMessageCount: 2,
      lastPreCompactMessageId: null,
    });

    const messages: ChatMessage[] = [
      msg("user", "pre-boundary 1"),
      msg("assistant", "pre-boundary 2"),
      boundary,
      { role: "user", kind: "compact_summary", isMeta: true, content: "summary" } as ChatMessage,
      msg("user", "post-1"),
      msg("assistant", "post-2"),
      msg("user", "post-3"),
      msg("assistant", "post-4"),
      msg("user", "post-5"),
      msg("assistant", "post-6"),
      msg("user", "post-7"),
      msg("assistant", "post-8"),
    ];

    const { messagesToSummarize } = splitMessagesForCompact(messages, {
      keepRecentMessages: 4,
      minMessagesToCompact: 4,
    });

    // Post-boundary compactable: 1 summary + 8 recent = 9 items.
    // keepRecentMessages=4, so keepCount=min(4, 8)=4, splitIndex=max(1, 9-4)=5.
    // 5 items to summarize, 4 kept.
    expect(messagesToSummarize).toHaveLength(5);
    // First summarized is the compact summary
    expect(messagesToSummarize[0]!.kind).toBe("compact_summary");
    expect(messagesToSummarize[1]!.content).toBe("post-1");
  });
});
