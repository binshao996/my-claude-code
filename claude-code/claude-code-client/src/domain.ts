export type NavSection =
  | "workspace"
  | "chat"
  | "editor"
  | "terminal"
  | "agent"
  | "diff"
  | "sessions"
  | "plugins"
  | "governance";

export type RuntimeSessionInfo = {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
};

export type RuntimeEvent =
  | {
      type: "session_started";
      session: RuntimeSessionInfo;
    }
  | {
      type: "turn_started";
      turnId: string;
      prompt: string;
    }
  | {
      type: "assistant_delta";
      messageId: string;
      text: string;
    }
  | {
      type: "tool_started";
      toolCallId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_finished";
      toolCallId: string;
      ok: boolean;
      output: string;
    }
  | {
      type: "plan_updated";
      items: PlanItem[];
    }
  | {
      type: "permission_requested";
      request: PermissionRequest;
    }
  | {
      type: "diff_ready";
      diff: DiffProposal;
    }
  | {
      type: "terminal_output";
      commandId: string;
      chunk: string;
    }
  | {
      type: "audit_event";
      event: AuditEvent;
    }
  | {
      type: "turn_finished";
      turnId: string;
    };

export type ClientMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "complete";
};

export type WorkspaceProject = {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt: string;
  trust: "trusted" | "restricted";
};

export type FileNode = {
  id: string;
  name: string;
  path: string;
  kind: "file" | "directory";
  language?: string;
  children?: FileNode[];
};

export type OpenFile = {
  path: string;
  language: string;
  content: string;
  savedContent: string;
};

export type TerminalLine = {
  id: string;
  text: string;
  kind: "input" | "output" | "status";
};

export type PlanItem = {
  id: string;
  title: string;
  status: "pending" | "running" | "done";
};

export type ToolActivity = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string | null;
  status: "running" | "success" | "error";
};

export type RuntimeTimelineItem = {
  id: string;
  label: string;
  detail: string;
  tone: "info" | "success" | "warning";
};

export type PermissionRequest = {
  id: string;
  toolName: string;
  reason: string;
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "denied";
};

export type DiffProposal = {
  id: string;
  filePath: string;
  title: string;
  before: string;
  after: string;
  status: "pending" | "accepted" | "rejected";
};

export type SessionSummary = {
  id: string;
  workspaceId: string;
  title: string;
  status: "running" | "paused" | "complete";
  updatedAt: string;
  turns: number;
};

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  capabilities: Array<"command" | "tool" | "panel">;
  enabled: boolean;
  verified: boolean;
};

export type PolicyRule = {
  id: string;
  name: string;
  scope: string;
  effect: "allow" | "review" | "deny";
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  target: string;
  at: string;
  severity: "info" | "review" | "blocked";
};

export type ClientState = {
  activeSection: NavSection;
  runtime: {
    session: RuntimeSessionInfo | null;
    activeTurnId: string | null;
    isRunning: boolean;
    events: RuntimeTimelineItem[];
  };
  chat: {
    messages: ClientMessage[];
    prompt: string;
  };
  workspace: {
    activeProjectId: string;
    projects: WorkspaceProject[];
    files: FileNode[];
    searchQuery: string;
  };
  editor: {
    openFiles: OpenFile[];
    activePath: string;
  };
  terminal: {
    command: string;
    lines: TerminalLine[];
  };
  agent: {
    plan: PlanItem[];
    tools: ToolActivity[];
    permissions: PermissionRequest[];
  };
  diff: {
    proposals: DiffProposal[];
    activeProposalId: string;
  };
  sessions: {
    items: SessionSummary[];
    activeSessionId: string;
  };
  plugins: {
    items: PluginManifest[];
  };
  governance: {
    policies: PolicyRule[];
    audits: AuditEvent[];
    release: {
      current: string;
      available: string;
      compatibility: "compatible" | "needs-review";
    };
  };
};

export type ClientAction =
  | { type: "navigate"; section: NavSection }
  | { type: "set_prompt"; prompt: string }
  | { type: "runtime_event"; event: RuntimeEvent }
  | { type: "set_workspace_search"; query: string }
  | { type: "open_file"; path: string }
  | { type: "edit_file"; path: string; content: string }
  | { type: "save_file"; path: string }
  | { type: "set_terminal_command"; command: string }
  | { type: "run_terminal_command" }
  | { type: "resolve_permission"; id: string; status: "approved" | "denied" }
  | { type: "resolve_diff"; id: string; status: "accepted" | "rejected" }
  | { type: "switch_session"; id: string }
  | { type: "toggle_plugin"; id: string }
  | { type: "set_policy_effect"; id: string; effect: PolicyRule["effect"] };

export type RuntimeUserInput = {
  prompt: string;
  cwd: string;
  openFiles: string[];
};

export interface RuntimeAdapter {
  startSession(input: RuntimeUserInput): AsyncGenerator<RuntimeEvent, void>;
}
