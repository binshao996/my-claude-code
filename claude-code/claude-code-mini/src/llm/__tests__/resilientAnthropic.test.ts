// 21add: Fallback strategy tests — model fallback, streaming fallback decisions
import { describe, expect, test } from "bun:test";
import {
  shouldFallbackModel,
  shouldFallbackToNonStreaming,
} from "../fallback";

describe("shouldFallbackModel", () => {
  test("triggers for overloaded errors", () => {
    expect(shouldFallbackModel({ status: 529, message: "overloaded_error" })).toBe(true);
  });

  test("triggers for rate limit errors", () => {
    expect(shouldFallbackModel({ status: 429, message: "rate limited" })).toBe(true);
  });

  test("does not trigger for auth errors", () => {
    expect(shouldFallbackModel({ status: 401, message: "invalid x-api-key" })).toBe(false);
  });

  test("does not trigger for invalid requests", () => {
    expect(shouldFallbackModel({ status: 400, message: "bad request" })).toBe(false);
  });
});

describe("shouldFallbackToNonStreaming", () => {
  test("triggers for 404 on streaming endpoint", () => {
    expect(shouldFallbackToNonStreaming({ status: 404, message: "stream not found" })).toBe(true);
  });

  test("triggers for connection errors", () => {
    expect(shouldFallbackToNonStreaming({ name: "Error", message: "econnreset" })).toBe(true);
  });

  test("triggers for timeout errors", () => {
    expect(shouldFallbackToNonStreaming({ name: "APIConnectionTimeoutError", message: "timeout" })).toBe(true);
  });

  test("does not trigger for aborted requests", () => {
    expect(shouldFallbackToNonStreaming({ name: "AbortError", message: "aborted" })).toBe(false);
  });

  test("does not trigger for auth errors", () => {
    expect(shouldFallbackToNonStreaming({ status: 401, message: "unauthorized" })).toBe(false);
  });
});
