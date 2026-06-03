// 21add: Retry logic tests — transient errors, non-retryable, retry-after, events
import { describe, expect, test } from "bun:test";
import { CannotRetryError, getRetryDelayMs, withRetry } from "../retry";

describe("withRetry", () => {
  test("retries transient errors and returns success", async () => {
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) {
          throw { status: 500, message: "server error" };
        }
        return "ok";
      },
      {
        baseDelayMs: 1,
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("does not retry invalid request", async () => {
    let calls = 0;

    await expect(
      withRetry(async () => {
        calls++;
        throw { status: 400, message: "bad request" };
      }),
    ).rejects.toBeInstanceOf(CannotRetryError);

    expect(calls).toBe(1);
  });

  test("uses retry-after before exponential delay", () => {
    expect(getRetryDelayMs(3, 2000)).toBe(2000);
  });

  test("emits retry events", async () => {
    const events: unknown[] = [];
    let calls = 0;

    await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { status: 500, message: "server error" };
        }
        return "ok";
      },
      {
        baseDelayMs: 1,
        onRetry(event) {
          events.push(event);
        },
      },
    );

    expect(events).toHaveLength(1);
  });
});
