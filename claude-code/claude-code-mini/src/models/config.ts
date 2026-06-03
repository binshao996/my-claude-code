// 20add: Model config loader — reads env vars, provides defaults
import type { ModelConfig } from "./types";

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadModelConfig(): ModelConfig {
  const authToken = readEnv("ANTHROPIC_AUTH_TOKEN") ?? readEnv("ANTHROPIC_API_KEY");
  const authTokenEnv = readEnv("ANTHROPIC_AUTH_TOKEN")
    ? "ANTHROPIC_AUTH_TOKEN"
    : "ANTHROPIC_API_KEY";

  const mainModel = readEnv("CCMINI_MODEL_MAIN")
    ?? readEnv("ANTHROPIC_MODEL")
    ?? DEFAULT_MODEL;

  return {
    provider: "anthropic-compatible",
    baseUrl: readEnv("ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL,
    authToken,
    authTokenEnv,
    mainModel,
    fastModel: readEnv("CCMINI_MODEL_FAST"),
    plannerModel: readEnv("CCMINI_MODEL_PLANNER"),
    compactModel: readEnv("CCMINI_MODEL_COMPACT"),
    pluginModel: readEnv("CCMINI_MODEL_PLUGIN"),
    largeContextModel: readEnv("CCMINI_MODEL_LARGE_CONTEXT"),
    // 21add: fallback model for overloaded/rate-limited requests
    fallbackModel: readEnv("CCMINI_MODEL_FALLBACK"),
  };
}

export function assertModelConfig(config: ModelConfig): void {
  if (!config.authToken) {
    throw new Error(
      `Missing ${config.authTokenEnv}. Set ANTHROPIC_AUTH_TOKEN for DeepSeek Anthropic-compatible access.`,
    );
  }

  if (!config.mainModel) {
    throw new Error("Missing main model. Set ANTHROPIC_MODEL or CCMINI_MODEL_MAIN.");
  }
}
