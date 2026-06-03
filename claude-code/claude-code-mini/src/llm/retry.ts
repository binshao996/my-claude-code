// 21add: Retry logic — abortable sleep, exponential backoff with jitter, withRetry
import { classifyApiError } from "./apiErrors";

export type RetryEvent = {
  type: "retry";
  errorKind: string;
  attempt: number;
  maxRetries: number;
  retryInMs: number;
};

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (event: RetryEvent) => void;
};

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 32_000;

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly attempts: number,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = "CannotRetryError";
  }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Request aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function getRetryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const jitter = Math.random() * 0.25 * exponential;
  return Math.round(exponential + jitter);
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const classified = classifyApiError(error);

      if (!classified.retryable || attempt > maxRetries) {
        throw new CannotRetryError(error, attempt);
      }

      const retryInMs = getRetryDelayMs(
        attempt,
        classified.retryAfterMs,
        baseDelayMs,
        maxDelayMs,
      );

      options.onRetry?.({
        type: "retry",
        errorKind: classified.kind,
        attempt,
        maxRetries,
        retryInMs,
      });

      await sleep(retryInMs, options.signal);
    }
  }

  throw new CannotRetryError(lastError, maxRetries + 1);
}
