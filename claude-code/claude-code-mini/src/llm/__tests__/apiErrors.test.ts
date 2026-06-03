// 21add: API error classification, redaction, and user-facing message tests
import { describe, expect, test } from "bun:test";
import {
  classifyApiError,
  redactApiErrorMessage,
  toUserFacingApiError,
} from "../apiErrors";

describe("classifyApiError", () => {
  test("classifies 429 as retryable rate limit", () => {
    const error = {
      status: 429,
      message: "rate limited",
      headers: {
        "retry-after": "2",
      },
    };

    const classified = classifyApiError(error);

    expect(classified.kind).toBe("rate_limit");
    expect(classified.retryable).toBe(true);
    expect(classified.retryAfterMs).toBe(2000);
  });

  test("classifies 529 as overloaded", () => {
    const classified = classifyApiError({
      status: 529,
      message: "overloaded_error",
    });

    expect(classified.kind).toBe("overloaded");
    expect(classified.retryable).toBe(true);
  });

  test("does not retry auth errors", () => {
    const classified = classifyApiError({
      status: 401,
      message: "invalid x-api-key",
    });

    expect(classified.kind).toBe("auth");
    expect(classified.retryable).toBe(false);
  });

  test("redacts token-like text", () => {
    const redacted = redactApiErrorMessage("bad key sk-test123");

    expect(redacted).not.toContain("sk-test123");
    expect(redacted).toContain("[redacted]");
  });

  test("user-facing auth error does not include raw detail", () => {
    const message = toUserFacingApiError(
      {
        status: 401,
        message: "invalid x-api-key sk-test123",
      },
      "deepseek-v4-flash",
    );

    expect(message).toBe("API Error: authentication failed. Check ANTHROPIC_AUTH_TOKEN.");
  });
});
