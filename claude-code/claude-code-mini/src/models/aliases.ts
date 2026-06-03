// 20add: Model aliases — role-based model resolution
import type { ModelConfig, ModelRole } from "./types";

const ROLE_ALIASES: Record<string, ModelRole> = {
  main: "main",
  fast: "fast",
  planner: "planner",
  plan: "planner",
  compact: "compact",
  plugin: "plugin",
};

export function resolveModelAlias(input: string, config: ModelConfig): string {
  const raw = input.trim();
  const normalized = raw.toLowerCase();
  const role = ROLE_ALIASES[normalized];

  if (role) {
    return modelForRole(role, config).model;
  }

  switch (normalized) {
    case "sonnet":
      return config.mainModel;
    case "haiku":
      return config.fastModel ?? config.mainModel;
    case "opus":
    case "best":
      return config.plannerModel ?? config.mainModel;
    default:
      return raw;
  }
}

export function modelForRole(
  role: ModelRole,
  config: ModelConfig,
): { model: string; reason: string } {
  switch (role) {
    case "main":
      return { model: config.mainModel, reason: "main model" };
    case "fast":
      return config.fastModel
        ? { model: config.fastModel, reason: "fast model" }
        : { model: config.mainModel, reason: "fallback to main" };
    case "planner":
      return config.plannerModel
        ? { model: config.plannerModel, reason: "planner model" }
        : { model: config.mainModel, reason: "fallback to main" };
    case "compact":
      return config.compactModel
        ? { model: config.compactModel, reason: "compact model" }
        : { model: config.mainModel, reason: "fallback to main" };
    case "plugin":
      return config.pluginModel
        ? { model: config.pluginModel, reason: "plugin model" }
        : { model: config.mainModel, reason: "fallback to main" };
  }
}
