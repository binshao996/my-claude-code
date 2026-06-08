import { afterEach, describe, expect, test } from "bun:test";
import { emitRuntimeEvent, onRuntimeEvent, resetEventBus } from "../events";

describe("runtime events", () => {
  afterEach(() => {
    resetEventBus();
  });

  test("delivers emitted events to listener", () => {
    const seen: unknown[] = [];
    const off = onRuntimeEvent(event => {
      seen.push(event);
    });

    emitRuntimeEvent({
      type: "api_retry",
      data: {
        errorKind: "rate_limit",
        attempt: 1,
        maxRetries: 4,
        retryInMs: 100,
      },
    });

    off();

    expect(seen).toHaveLength(1);
  });

  test("queues events before listener attached, drains on attach", async () => {
    // Reset so we have no listeners yet
    resetEventBus();

    emitRuntimeEvent({
      type: "api_retry",
      data: {
        errorKind: "rate_limit",
        attempt: 1,
        maxRetries: 4,
        retryInMs: 100,
      },
    });

    const seen: unknown[] = [];

    // Drain happens in queueMicrotask, so we need to wait
    await new Promise<void>(resolve => {
      onRuntimeEvent(event => {
        seen.push(event);
        resolve();
      });
    });

    expect(seen).toHaveLength(1);
  });
});
