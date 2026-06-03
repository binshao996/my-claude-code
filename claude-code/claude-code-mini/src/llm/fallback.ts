// 21add: Fallback strategies — model fallback, streaming-to-non-streaming fallback
import { classifyApiError } from "./apiErrors";

export type ModelFallbackEvent = {
  type: "model_fallback";
  from: string;
  to: string;
  reason: string;
};

export type StreamingFallbackEvent = {
  type: "streaming_fallback";
  reason: string;
};

export type FallbackEvent = ModelFallbackEvent | StreamingFallbackEvent;

export function shouldFallbackModel(error: unknown): boolean {
  const classified = classifyApiError(error);
  return classified.kind === "overloaded" || classified.kind === "rate_limit";
}

export function shouldFallbackToNonStreaming(error: unknown): boolean {
  const classified = classifyApiError(error);

  if (classified.kind === "aborted") {
    return false;
  }

  if (classified.status === 404) {
    return true;
  }

  return classified.kind === "connection" || classified.kind === "timeout";
}
