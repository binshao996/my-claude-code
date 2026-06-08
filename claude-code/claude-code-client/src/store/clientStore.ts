import { initialState } from "../fixtures";
import type {
  ClientAction,
  ClientMessage,
  ClientState,
  DiffProposal,
  FileNode,
  OpenFile,
  RuntimeEvent,
  TerminalLine,
} from "../domain";

export function createInitialClientState(): ClientState {
  return structuredClone(initialState);
}

export function clientReducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case "navigate":
      return { ...state, activeSection: action.section };

    case "set_prompt":
      return { ...state, chat: { ...state.chat, prompt: action.prompt } };

    case "runtime_event":
      return reduceRuntimeEvent(state, action.event);

    case "set_workspace_search":
      return {
        ...state,
        workspace: { ...state.workspace, searchQuery: action.query },
      };

    case "open_file": {
      const found = findFileNode(state.workspace.files, action.path);
      if (!found || found.kind !== "file") {
        return state;
      }

      const existing = state.editor.openFiles.find((file) => file.path === action.path);
      const openFile: OpenFile =
        existing ??
        createOpenFile(action.path, found.language ?? languageFromPath(action.path));

      return {
        ...state,
        activeSection: "editor",
        editor: {
          activePath: action.path,
          openFiles: existing ? state.editor.openFiles : [...state.editor.openFiles, openFile],
        },
        runtime: appendTimeline(state.runtime, "Open file intent", action.path, "info"),
      };
    }

    case "edit_file":
      return {
        ...state,
        editor: {
          ...state.editor,
          openFiles: state.editor.openFiles.map((file) =>
            file.path === action.path ? { ...file, content: action.content } : file,
          ),
        },
      };

    case "save_file":
      return {
        ...state,
        editor: {
          ...state.editor,
          openFiles: state.editor.openFiles.map((file) =>
            file.path === action.path ? { ...file, savedContent: file.content } : file,
          ),
        },
        runtime: appendTimeline(state.runtime, "File saved", action.path, "success"),
      };

    case "set_terminal_command":
      return {
        ...state,
        terminal: { ...state.terminal, command: action.command },
      };

    case "run_terminal_command": {
      const command = state.terminal.command.trim();
      if (!command) {
        return state;
      }

      const lines: TerminalLine[] = [
        ...state.terminal.lines,
        { id: createId("terminal-input"), kind: "input", text: `$ ${command}` },
        {
          id: createId("terminal-status"),
          kind: "status",
          text: command.includes("typecheck")
            ? "TypeScript check completed with zero errors."
            : "Command completed in workspace cwd.",
        },
      ];

      return {
        ...state,
        terminal: { ...state.terminal, lines },
        governance: {
          ...state.governance,
          audits: [
            createAudit("user", "ran_terminal_command", command, "info"),
            ...state.governance.audits,
          ],
        },
      };
    }

    case "resolve_permission":
      return {
        ...state,
        agent: {
          ...state.agent,
          permissions: state.agent.permissions.map((permission) =>
            permission.id === action.id ? { ...permission, status: action.status } : permission,
          ),
        },
        governance: {
          ...state.governance,
          audits: [
            createAudit("user", `${action.status}_permission`, action.id, action.status === "approved" ? "info" : "blocked"),
            ...state.governance.audits,
          ],
        },
      };

    case "resolve_diff":
      return {
        ...state,
        diff: {
          ...state.diff,
          proposals: state.diff.proposals.map((proposal) =>
            proposal.id === action.id ? { ...proposal, status: action.status } : proposal,
          ),
        },
        runtime: appendTimeline(state.runtime, `Diff ${action.status}`, action.id, action.status === "accepted" ? "success" : "warning"),
      };

    case "switch_session":
      return {
        ...state,
        activeSection: "sessions",
        sessions: { ...state.sessions, activeSessionId: action.id },
        runtime: appendTimeline(state.runtime, "Session switched", action.id, "info"),
      };

    case "toggle_plugin":
      return {
        ...state,
        plugins: {
          items: state.plugins.items.map((plugin) =>
            plugin.id === action.id ? { ...plugin, enabled: !plugin.enabled } : plugin,
          ),
        },
        governance: {
          ...state.governance,
          audits: [createAudit("user", "toggled_plugin", action.id, "info"), ...state.governance.audits],
        },
      };

    case "set_policy_effect":
      return {
        ...state,
        governance: {
          ...state.governance,
          policies: state.governance.policies.map((policy) =>
            policy.id === action.id ? { ...policy, effect: action.effect } : policy,
          ),
          audits: [createAudit("admin", "updated_policy", `${action.id}:${action.effect}`, "review"), ...state.governance.audits],
        },
      };
  }
}

export function reduceRuntimeEvent(state: ClientState, event: RuntimeEvent): ClientState {
  switch (event.type) {
    case "session_started":
      return {
        ...state,
        runtime: {
          ...state.runtime,
          session: event.session,
          events: [
            {
              id: createId("event"),
              label: "Session started",
              detail: event.session.sessionId,
              tone: "success",
            },
            ...state.runtime.events,
          ],
        },
      };

    case "turn_started":
      return {
        ...state,
        activeSection: "chat",
        runtime: {
          ...state.runtime,
          activeTurnId: event.turnId,
          isRunning: true,
          events: [
            {
              id: createId("event"),
              label: "Turn started",
              detail: event.prompt,
              tone: "info",
            },
            ...state.runtime.events,
          ],
        },
        chat: {
          ...state.chat,
          prompt: "",
          messages: [
            ...state.chat.messages,
            {
              id: `user-${event.turnId}`,
              role: "user",
              content: event.prompt,
              status: "complete",
            },
          ],
        },
      };

    case "assistant_delta":
      return {
        ...state,
        chat: {
          ...state.chat,
          messages: appendAssistantDelta(state.chat.messages, event.messageId, event.text),
        },
      };

    case "tool_started":
      return {
        ...state,
        agent: {
          ...state.agent,
          tools: [
            {
              id: event.toolCallId,
              name: event.name,
              input: event.input,
              output: null,
              status: "running",
            },
            ...state.agent.tools,
          ],
        },
        runtime: appendTimeline(state.runtime, "Tool started", event.name, "info"),
      };

    case "tool_finished":
      return {
        ...state,
        agent: {
          ...state.agent,
          tools: state.agent.tools.map((tool) =>
            tool.id === event.toolCallId
              ? {
                  ...tool,
                  output: event.output,
                  status: event.ok ? "success" : "error",
                }
              : tool,
          ),
        },
        runtime: appendTimeline(state.runtime, "Tool finished", event.output, event.ok ? "success" : "warning"),
      };

    case "plan_updated":
      return {
        ...state,
        agent: { ...state.agent, plan: event.items },
        runtime: appendTimeline(state.runtime, "Plan updated", `${event.items.length} items`, "info"),
      };

    case "permission_requested":
      return {
        ...state,
        agent: {
          ...state.agent,
          permissions: [event.request, ...state.agent.permissions],
        },
        governance: {
          ...state.governance,
          audits: [
            createAudit("agent", "requested_permission", `${event.request.toolName}:${event.request.risk}`, "review"),
            ...state.governance.audits,
          ],
        },
      };

    case "diff_ready":
      return {
        ...state,
        activeSection: "diff",
        diff: {
          activeProposalId: event.diff.id,
          proposals: [event.diff, ...state.diff.proposals],
        },
        runtime: appendTimeline(state.runtime, "Diff ready", event.diff.filePath, "warning"),
      };

    case "terminal_output":
      return {
        ...state,
        terminal: {
          ...state.terminal,
          lines: [
            ...state.terminal.lines,
            {
              id: createId(event.commandId),
              kind: "output",
              text: event.chunk,
            },
          ],
        },
      };

    case "audit_event":
      return {
        ...state,
        governance: {
          ...state.governance,
          audits: [event.event, ...state.governance.audits],
        },
      };

    case "turn_finished":
      return {
        ...state,
        runtime: {
          ...state.runtime,
          activeTurnId: null,
          isRunning: false,
          events: [
            {
              id: createId("event"),
              label: "Turn finished",
              detail: event.turnId,
              tone: "success",
            },
            ...state.runtime.events,
          ],
        },
        chat: {
          ...state.chat,
          messages: state.chat.messages.map((message) =>
            message.role === "assistant" && message.status === "streaming"
              ? { ...message, status: "complete" }
              : message,
          ),
        },
      };
  }
}

export function visibleFiles(files: FileNode[], query: string): FileNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return files;
  }

  return files.flatMap((file) => {
    if (file.kind === "file") {
      return file.path.toLowerCase().includes(normalizedQuery) ? [file] : [];
    }

    const children = visibleFiles(file.children ?? [], query);
    if (children.length > 0 || file.path.toLowerCase().includes(normalizedQuery)) {
      return [{ ...file, children }];
    }

    return [];
  });
}

export function currentProject(state: ClientState) {
  return state.workspace.projects.find((project) => project.id === state.workspace.activeProjectId) ?? state.workspace.projects[0];
}

export function activeFile(state: ClientState): OpenFile | null {
  return state.editor.openFiles.find((file) => file.path === state.editor.activePath) ?? null;
}

export function activeDiff(state: ClientState): DiffProposal | null {
  return state.diff.proposals.find((proposal) => proposal.id === state.diff.activeProposalId) ?? state.diff.proposals[0] ?? null;
}

function appendAssistantDelta(messages: ClientMessage[], messageId: string, text: string): ClientMessage[] {
  const existing = messages.find((message) => message.id === messageId);

  if (!existing) {
    return [
      ...messages,
      {
        id: messageId,
        role: "assistant",
        content: text,
        status: "streaming",
      },
    ];
  }

  return messages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          content: `${message.content}${text}`,
        }
      : message,
  );
}

function findFileNode(files: FileNode[], path: string): FileNode | null {
  for (const file of files) {
    if (file.path === path) {
      return file;
    }

    if (file.children) {
      const found = findFileNode(file.children, path);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function createOpenFile(path: string, language: string): OpenFile {
  const content = `// ${path}\n// Loaded from the workspace file tree intent.\nexport const chapter = "courses-client";\n`;

  return {
    path,
    language,
    content,
    savedContent: content,
  };
}

function languageFromPath(path: string): string {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".json")) return "json";
  return "text";
}

function appendTimeline(
  runtime: ClientState["runtime"],
  label: string,
  detail: string,
  tone: ClientState["runtime"]["events"][number]["tone"],
): ClientState["runtime"] {
  return {
    ...runtime,
    events: [
      {
        id: createId("event"),
        label,
        detail,
        tone,
      },
      ...runtime.events,
    ],
  };
}

function createAudit(
  actor: string,
  action: string,
  target: string,
  severity: ClientState["governance"]["audits"][number]["severity"],
) {
  return {
    id: createId("audit"),
    actor,
    action,
    target,
    at: new Date().toISOString().slice(0, 19).replace("T", " "),
    severity,
  };
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}
