// 20add: Model route report — /models command output
import { modelRouter } from "./router";
import type { ModelRole } from "./types";

const ROLES: ModelRole[] = ["main", "fast", "planner", "compact", "plugin"];

export function renderModelRoutes(): string {
  const config = modelRouter.getConfig();
  const lines = [
    "Model Routes",
    "",
    `Provider: ${config.provider}`,
    `Base URL: ${config.baseUrl ?? "(default)"}`,
    "",
    "Role       Model                 Reason",
  ];

  for (const role of ROLES) {
    const route = modelRouter.resolve({ role });
    lines.push(`${role.padEnd(10)} ${route.model.padEnd(21)} ${route.reason}`);
  }

  return lines.join("\n");
}
