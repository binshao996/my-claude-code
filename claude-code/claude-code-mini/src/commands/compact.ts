import type { ChatSession } from "../chat/session";

export async function runCompactCommand(
  session: ChatSession,
  customInstructions?: string,
): Promise<string> {
  const result = await session.compact(customInstructions);

  return [
    "Conversation compacted.",
    `Before: ${result.preTokens} tokens`,
    `After: ${result.postTokens} tokens`,
    `Kept: ${result.messagesToKeep.length} recent messages`,
  ].join("\n");
}
