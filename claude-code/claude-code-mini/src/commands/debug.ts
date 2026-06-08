import {
  disableDebugLog,
  enableDebugLog,
  getDebugLogPath,
  isDebugLogEnabled,
} from "../logging/debugLog";

export function runDebugCommand(args: string[]): string {
  const action = args[0];

  if (action === "on") {
    enableDebugLog();
    return `Debug logging enabled: ${getDebugLogPath()}`;
  }

  if (action === "off") {
    disableDebugLog();
    return "Debug logging disabled";
  }

  return [
    `Debug logging: ${isDebugLogEnabled() ? "on" : "off"}`,
    `Path: ${getDebugLogPath()}`,
    "Usage: /debug on | /debug off",
  ].join("\n");
}
