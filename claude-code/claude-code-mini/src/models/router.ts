// 20add: ModelRouter — resolves model route request to concrete model + capability
import { modelForRole, resolveModelAlias } from "./aliases";
import { loadModelConfig } from "./config";
import { getSessionModelOverride } from "./modelState";
import type {
  ModelCapability,
  ModelConfig,
  ModelRouteRequest,
  ResolvedModel,
} from "./types";

const DEFAULT_CAPABILITY: ModelCapability = {
  maxInputTokens: 200_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsStreaming: true,
};

export class ModelRouter {
  constructor(private readonly config: ModelConfig = loadModelConfig()) {}

  resolve(request: ModelRouteRequest): ResolvedModel {
    const commandModel = request.commandModel?.trim();
    if (commandModel) {
      const model = resolveModelAlias(commandModel, this.config);
      return this.toResolved(request, model, "command model override");
    }

    const sessionModel = getSessionModelOverride();
    if (sessionModel && request.role === "main") {
      const model = resolveModelAlias(sessionModel, this.config);
      return this.toResolved(request, model, "session /model override");
    }

    if (request.permissionMode === "plan") {
      const planner = modelForRole("planner", this.config);
      return this.toResolved(request, planner.model, `plan mode ${planner.reason}`);
    }

    if (
      request.contextTokens !== undefined &&
      request.contextTokens > 180_000 &&
      this.config.largeContextModel
    ) {
      return this.toResolved(request, this.config.largeContextModel, "large context route");
    }

    const selected = modelForRole(request.role, this.config);
    return this.toResolved(request, selected.model, selected.reason);
  }

  getConfig(): ModelConfig {
    return this.config;
  }

  private toResolved(
    request: ModelRouteRequest,
    model: string,
    reason: string,
  ): ResolvedModel {
    return {
      provider: this.config.provider,
      role: request.role,
      model,
      baseUrl: this.config.baseUrl,
      authTokenEnv: this.config.authTokenEnv,
      reason,
      capability: capabilityFor(model),
    };
  }
}

export const modelRouter = new ModelRouter();

export function capabilityFor(model: string): ModelCapability {
  if (model.toLowerCase().includes("large")) {
    return {
      maxInputTokens: 1_000_000,
      maxOutputTokens: 16_000,
      supportsTools: true,
      supportsStreaming: true,
    };
  }

  return DEFAULT_CAPABILITY;
}
