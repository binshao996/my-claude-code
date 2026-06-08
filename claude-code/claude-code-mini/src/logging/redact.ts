const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/g,
  /ANTHROPIC_AUTH_TOKEN=([^\s]+)/g,
  /ANTHROPIC_API_KEY=([^\s]+)/g,
  /api[_-]?key["']?\s*[:=]\s*["']?[^"',\s]+/gi,
  /authorization["']?\s*[:=]\s*["']?[^"',\s]+/gi,
];

// JSON-safe patterns removed — redactJson now handles this in two passes.
// See redactJson() below for the implementation.

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    value,
  );
}

export function redactJson<T>(value: T): T {
  const json = JSON.stringify(value);

  // Pass 1: redact simple token patterns (within string values)
  const TOKEN_PATTERNS = [
    /sk-[a-zA-Z0-9_-]+/g,
    /Bearer\s+[a-zA-Z0-9._-]+/g,
    /ANTHROPIC_AUTH_TOKEN=([^\s]+)/g,
    /ANTHROPIC_API_KEY=([^\s]+)/g,
  ];
  let redacted = TOKEN_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    json,
  );

  // Pass 2: redact full "key":"value" pairs (JSON-safe)
  const KV_PATTERN = /"[^"]*?\b(?:api[_-]?key|authorization)\b[^"]*"\s*:\s*"[^"]*"/gi;
  redacted = redacted.replace(KV_PATTERN, '"redacted":"[redacted]"');

  try {
    return JSON.parse(redacted) as T;
  } catch {
    // If JSON-safe redaction somehow fails, return original value.
    return value;
  }
}
