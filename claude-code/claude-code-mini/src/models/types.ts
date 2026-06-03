// 20add: Model routing types — roles, capabilities, route request/response
export type ModelRole = "main" | "fast" | "planner" | "compact" | "plugin";

export type PermissionMode = "default" | "plan";

export type ModelRouteRequest = {
  role: ModelRole;
  permissionMode?: PermissionMode;
  commandModel?: string;
  contextTokens?: number;
};

export type ModelProvider = "anthropic-compatible";

export type ModelCapability = {
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
};

export type ResolvedModel = {
  provider: ModelProvider;
  role: ModelRole;
  model: string;
  baseUrl?: string;
  authTokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  reason: string;
  capability: ModelCapability;
};

export type ModelConfig = {
  provider: ModelProvider;
  baseUrl?: string;
  authToken?: string;
  authTokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  mainModel: string;
  fastModel?: string;
  plannerModel?: string;
  compactModel?: string;
  pluginModel?: string;
  largeContextModel?: string;
  // 21add: fallback model for overloaded/rate-limited requests
  fallbackModel?: string;
};
