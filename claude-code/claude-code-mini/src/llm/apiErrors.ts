// 21add: API error classification, redaction, and user-facing messages
export type ApiErrorKind =
  | "timeout"
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "invalid_request"
  | "prompt_too_long"
  | "request_too_large"
  | "model_unavailable"
  | "connection"
  | "server"
  | "aborted"
  | "unknown";

export type ClassifiedApiError = {
  kind: ApiErrorKind;
  status?: number;
  message: string;
  retryAfterMs?: number;
  retryable: boolean;
};

type HeadersLike = Headers | Record<string, string | undefined>;

type ErrorLike = {
  name?: string;
  message?: string;
  status?: number;
  headers?: HeadersLike;
  cause?: unknown;
};

function asErrorLike(error: unknown): ErrorLike {
  if (error instanceof Error) {
    return error as ErrorLike;
  }
  if (typeof error === "object" && error !== null) {
    return error as ErrorLike;
  }
  return {
    message: String(error),
  };
}

function headerValue(headers: HeadersLike | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()];
}

export function getRetryAfterMs(error: unknown): number | undefined {
  const value = headerValue(asErrorLike(error).headers, "retry-after");
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

export function classifyApiError(error: unknown): ClassifiedApiError {
  const err = asErrorLike(error);
  const message = err.message ?? "Unknown API error";
  const lower = message.toLowerCase();
  const retryAfterMs = getRetryAfterMs(error);

  if (err.name === "AbortError" || lower.includes("aborted")) {
    return {
      kind: "aborted",
      message,
      retryable: false,
    };
  }

  if (lower.includes("timeout") || err.name === "APIConnectionTimeoutError") {
    return {
      kind: "timeout",
      message,
      retryable: true,
    };
  }

  if (err.status === 429) {
    return {
      kind: "rate_limit",
      status: err.status,
      message,
      retryAfterMs,
      retryable: true,
    };
  }

  if (err.status === 529 || lower.includes("overloaded_error")) {
    return {
      kind: "overloaded",
      status: err.status,
      message,
      retryAfterMs,
      retryable: true,
    };
  }

  if (err.status === 401 || err.status === 403 || lower.includes("x-api-key")) {
    return {
      kind: "auth",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (err.status === 404 || lower.includes("invalid model")) {
    return {
      kind: "model_unavailable",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (lower.includes("prompt is too long")) {
    return {
      kind: "prompt_too_long",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (err.status === 413 || lower.includes("request too large")) {
    return {
      kind: "request_too_large",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (err.status === 400) {
    return {
      kind: "invalid_request",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (err.status === 408 || err.status === 409) {
    return {
      kind: "server",
      status: err.status,
      message,
      retryAfterMs,
      retryable: true,
    };
  }

  if (err.status !== undefined && err.status >= 500) {
    return {
      kind: "server",
      status: err.status,
      message,
      retryAfterMs,
      retryable: true,
    };
  }

  if (
    err.name === "APIConnectionError" ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("network")
  ) {
    return {
      kind: "connection",
      message,
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    status: err.status,
    message,
    retryAfterMs,
    retryable: false,
  };
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/g,
  /ANTHROPIC_AUTH_TOKEN=([^\s]+)/g,
  /ANTHROPIC_API_KEY=([^\s]+)/g,
  /api[_-]?key["']?\s*[:=]\s*["']?[^"',\s]+/gi,
];

export function redactApiErrorMessage(message: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    message,
  );
}

export function toUserFacingApiError(error: unknown, model: string): string {
  const classified = classifyApiError(error);
  const detail = redactApiErrorMessage(classified.message);

  switch (classified.kind) {
    case "timeout":
      return "API Error: request timed out. Try again or increase API_TIMEOUT_MS.";
    case "rate_limit":
      return "API Error: rate limit reached. Wait and retry, or switch to another configured model.";
    case "overloaded":
      return `API Error: model is overloaded (${model}). Try again or configure CCMINI_MODEL_FALLBACK.`;
    case "auth":
      return "API Error: authentication failed. Check ANTHROPIC_AUTH_TOKEN.";
    case "model_unavailable":
      return `API Error: model is unavailable (${model}). Check ANTHROPIC_MODEL or /model.`;
    case "prompt_too_long":
      return "API Error: prompt is too long. Run /context or /compact, then retry.";
    case "request_too_large":
      return "API Error: request is too large. Remove large files or images from the request.";
    case "invalid_request":
      return `API Error: invalid request. ${detail}`;
    case "connection":
      return `API Error: connection failed. ${detail}`;
    case "server":
      return `API Error: server error. ${detail}`;
    case "aborted":
      return "Request interrupted.";
    case "unknown":
      return `API Error: ${detail}`;
  }
}
