import type { SandboxConfig, SandboxDecision, SandboxMode } from "./types";

const MODE_SET = new Set<SandboxMode>([
  "read_only",
  "workspace_write",
  "dangerous",
]);

const ALWAYS_DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(\/|~)(\s|$)/,
    reason: "Refuse recursive force removal of root or home.",
  },
  {
    pattern: /\b(sudo|doas|pkexec)\b/,
    reason: "Privilege escalation is not allowed.",
  },
  {
    pattern: /\b(curl|wget)\b[\s\S]*\|\s*(bash|sh)\b/,
    reason: "Piping network data into a shell is not allowed.",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: "Hard reset may discard local work.",
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    reason: "Forced git clean may delete untracked files.",
  },
  {
    pattern: /:\s*\(\)\s*\{/,
    reason: "Shell fork pattern is not allowed.",
  },
];

const WRITE_LIKE_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln)\b/,
  /(^|[^<])>{1,2}/,
  /\bgit\s+(add|commit|push|merge|rebase|checkout|switch|restore|rm)\b/,
  /\bbun\s+(add|install)\b/,
];

const READ_ONLY_EXACT_COMMANDS = new Set([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "sed",
  "rg",
  "grep",
  "find",
  "wc",
  "git status",
  "git diff",
  "git log",
  "git show",
  "bun run typecheck",
]);

export function parseSandboxMode(value: string | undefined): SandboxMode {
  if (value && MODE_SET.has(value as SandboxMode)) {
    return value as SandboxMode;
  }

  return "read_only";
}

export class SandboxPolicyEngine {
  constructor(readonly config: SandboxConfig) {}

  decideFileWrite(path: string): SandboxDecision {
    if (this.config.mode === "read_only") {
      return {
        behavior: "ask",
        reason: `File write requires approval in read_only mode: ${path}`,
      };
    }

    return {
      behavior: "allow",
      reason: "Workspace file writes are allowed in this sandbox mode.",
    };
  }

  decideCommand(command: string): SandboxDecision {
    const normalized = command.trim();

    if (!normalized) {
      return { behavior: "deny", reason: "Command is empty." };
    }

    for (const rule of ALWAYS_DENY_PATTERNS) {
      if (rule.pattern.test(normalized)) {
        return { behavior: "deny", reason: rule.reason };
      }
    }

    if (this.config.mode === "dangerous") {
      return {
        behavior: "allow",
        reason: "Dangerous mode allows shell execution after hard denials.",
      };
    }

    if (isReadOnlyCommand(normalized)) {
      return { behavior: "allow", reason: "Command is read-only." };
    }

    if (WRITE_LIKE_PATTERNS.some(pattern => pattern.test(normalized))) {
      return {
        behavior: "ask",
        reason: "Command may modify files. Mini does not auto-approve it yet.",
      };
    }

    return {
      behavior: "ask",
      reason: "Command is not in the read-only allowlist.",
    };
  }

  assertCanWriteFile(path: string): void {
    const decision = this.decideFileWrite(path);

    if (decision.behavior !== "allow") {
      throw new Error(decision.reason);
    }
  }
}

function isReadOnlyCommand(command: string): boolean {
  if (READ_ONLY_EXACT_COMMANDS.has(command)) {
    return true;
  }

  if (command.startsWith("git diff ")) return true;
  if (command.startsWith("git show ")) return true;
  if (command.startsWith("git log ")) return true;
  if (command.startsWith("rg ")) return true;
  if (command.startsWith("grep ")) return true;
  if (command.startsWith("find ")) return true;
  if (command.startsWith("ls ")) return true;
  if (command.startsWith("cat ")) return true;
  if (command.startsWith("sed ")) return !/(^|[;&|]\s*)sed\s+.*\s-i\b/.test(command);

  return false;
}
