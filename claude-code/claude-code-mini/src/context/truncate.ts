// 18add: Text truncation — clip to token budget with marker
import { estimateTokens } from "./tokenCounter";

export type TruncateResult = {
  text: string;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
};

export function truncateTextToTokens(text: string, maxTokens: number): TruncateResult {
  const originalTokens = estimateTokens(text);

  if (originalTokens <= maxTokens) {
    return {
      text,
      originalTokens,
      finalTokens: originalTokens,
      truncated: false,
    };
  }

  const maxChars = Math.max(0, maxTokens * 4);
  const preview = text.slice(0, maxChars).trimEnd();
  const marker =
    `\n\n[Content truncated. Original ~${originalTokens} tokens. ` +
    `Showing first ~${maxTokens} tokens.]`;
  const finalText = `${preview}${marker}`;

  return {
    text: finalText,
    originalTokens,
    finalTokens: estimateTokens(finalText),
    truncated: true,
  };
}
