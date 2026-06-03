export function approvalKeyForToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "run_command") {
    return `run_command:${String(input.command ?? "").trim()}`;
  }

  if (toolName === "write_file" || toolName === "edit_file") {
    return `${toolName}:${String(input.path ?? "").trim()}`;
  }

  return `${toolName}:${JSON.stringify(input)}`;
}

export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "run_command") {
    return String(input.command ?? "");
  }

  if (toolName === "write_file" || toolName === "edit_file") {
    return String(input.path ?? "");
  }

  return JSON.stringify(input, null, 2);
}
