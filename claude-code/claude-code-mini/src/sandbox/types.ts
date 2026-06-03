export type SandboxMode = "read_only" | "workspace_write" | "dangerous";

export type SandboxDecisionBehavior = "allow" | "ask" | "deny";

export type SandboxDecision = {
  behavior: SandboxDecisionBehavior;
  reason: string;
};

export type SandboxConfig = {
  cwd: string;
  mode: SandboxMode;
  commandTimeoutMs: number;
  maxOutputBytes: number;
};

export type RunCommandInput = {
  command: string;
};

export type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
};
