import type { LLMConfig } from "./types";

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_MAX_TOKENS = 4096;

type Env = Record<string, string | undefined>;

export function loadLLMConfig(env: Env = process.env): LLMConfig {
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Set it with: export ANTHROPIC_API_KEY=\"<your-api-key>\"",
    );
  }

  const maxTokens = parsePositiveInt(env.CCMINI_MAX_TOKENS, DEFAULT_MAX_TOKENS);

  return {
    apiKey,
    model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    maxTokens,
    ...(env.ANTHROPIC_BASE_URL && { baseURL: env.ANTHROPIC_BASE_URL }),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`CCMINI_MAX_TOKENS must be a positive integer, got: ${value}`);
  }

  return parsed;
}
