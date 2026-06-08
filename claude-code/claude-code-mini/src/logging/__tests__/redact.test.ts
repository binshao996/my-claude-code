import { describe, expect, test } from "bun:test";
import { redactJson, redactSecrets } from "../redact";

describe("redactSecrets", () => {
  test("redacts token-like strings", () => {
    const text = redactSecrets("Authorization: Bearer secret-token");

    expect(text).toContain("[redacted]");
    expect(text).not.toContain("secret-token");
  });

  test("redacts env-style auth token", () => {
    const text = redactSecrets("ANTHROPIC_AUTH_TOKEN=abc123");

    expect(text).toBe("[redacted]");
  });

  test("redacts nested JSON values", () => {
    const redacted = redactJson({
      headers: {
        authorization: "Bearer abc123",
      },
    });

    expect(JSON.stringify(redacted)).not.toContain("abc123");
  });
});
