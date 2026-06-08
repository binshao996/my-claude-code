import {
  Activity,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  Code2,
  FileCode2,
  FolderTree,
  GitCompareArrows,
  LayoutDashboard,
  Play,
  Plug,
  Save,
  Search,
  Send,
  ShieldCheck,
  SplitSquareHorizontal,
  Terminal,
  X,
} from "lucide-react";
import { useMemo, useReducer, useRef } from "react";
import type { ClientAction, ClientState, FileNode, NavSection, OpenFile, PolicyRule } from "./domain";
import { FakeRuntimeAdapter } from "./runtime/fakeRuntime";
import {
  activeDiff,
  activeFile,
  clientReducer,
  createInitialClientState,
  currentProject,
  visibleFiles,
} from "./store/clientStore";

const navItems: Array<{ id: NavSection; label: string; icon: typeof LayoutDashboard; version: string }> = [
  { id: "workspace", label: "Workspace", icon: LayoutDashboard, version: "V2" },
  { id: "chat", label: "Chat", icon: Bot, version: "V1" },
  { id: "editor", label: "Editor", icon: Code2, version: "V4" },
  { id: "terminal", label: "Terminal", icon: Terminal, version: "V5" },
  { id: "agent", label: "Agent", icon: Activity, version: "V6" },
  { id: "diff", label: "Diff", icon: GitCompareArrows, version: "V7" },
  { id: "sessions", label: "Sessions", icon: SplitSquareHorizontal, version: "V8" },
  { id: "plugins", label: "Plugins", icon: Plug, version: "V9" },
  { id: "governance", label: "Governance", icon: ShieldCheck, version: "V10" },
];

const runtime = new FakeRuntimeAdapter();

export function App() {
  const [state, dispatch] = useReducer(clientReducer, undefined, createInitialClientState);
  const isSendingRef = useRef(false);
  const project = currentProject(state);
  const openFiles = state.editor.openFiles.map((file) => file.path);

  async function sendPrompt() {
    const prompt = state.chat.prompt.trim();
    if (!prompt || state.runtime.isRunning || isSendingRef.current) {
      return;
    }

    isSendingRef.current = true;
    try {
      for await (const event of runtime.startSession({
        prompt,
        cwd: project.rootPath,
        openFiles,
      })) {
        dispatch({ type: "runtime_event", event });
      }
    } finally {
      isSendingRef.current = false;
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CC</div>
          <div>
            <strong>Code Client</strong>
            <span>Enterprise agent desk</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Client sections">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={item.id === state.activeSection ? "nav-item active" : "nav-item"}
                key={item.id}
                onClick={() => dispatch({ type: "navigate", section: item.id })}
              >
                <Icon size={16} />
                <span>{item.label}</span>
                <small>{item.version}</small>
              </button>
            );
          })}
        </nav>

        <div className="runtime-card">
          <div className="eyebrow">Runtime</div>
          <strong>{state.runtime.session?.sessionId ?? "fake-adapter"}</strong>
          <span>{state.runtime.isRunning ? "streaming events" : "ready for next turn"}</span>
        </div>
      </aside>

      <main className="main-surface">
        <TopBar state={state} />
        <div className="content-grid">
          <section className="primary-panel">
            {state.activeSection === "workspace" && <WorkspaceView state={state} dispatch={dispatch} />}
            {state.activeSection === "chat" && <ChatView state={state} dispatch={dispatch} onSend={sendPrompt} />}
            {state.activeSection === "editor" && <EditorView state={state} dispatch={dispatch} />}
            {state.activeSection === "terminal" && <TerminalView state={state} dispatch={dispatch} />}
            {state.activeSection === "agent" && <AgentView state={state} dispatch={dispatch} />}
            {state.activeSection === "diff" && <DiffView state={state} dispatch={dispatch} />}
            {state.activeSection === "sessions" && <SessionsView state={state} dispatch={dispatch} />}
            {state.activeSection === "plugins" && <PluginsView state={state} dispatch={dispatch} />}
            {state.activeSection === "governance" && <GovernanceView state={state} dispatch={dispatch} />}
          </section>

          <aside className="inspector">
            <RuntimeTimeline state={state} />
            <MiniGovernance state={state} />
          </aside>
        </div>
      </main>
    </div>
  );
}

function TopBar({ state }: { state: ClientState }) {
  const project = currentProject(state);

  return (
    <header className="topbar">
      <div>
        <div className="eyebrow">Active workspace</div>
        <h1>{project.name}</h1>
      </div>
      <div className="topbar-meta">
        <StatusPill tone={project.trust === "trusted" ? "green" : "amber"}>{project.trust}</StatusPill>
        <StatusPill tone={state.runtime.isRunning ? "amber" : "green"}>
          {state.runtime.isRunning ? "agent running" : "idle"}
        </StatusPill>
        <StatusPill tone="blue">{state.governance.release.current}</StatusPill>
      </div>
    </header>
  );
}

function WorkspaceView({ state, dispatch }: ViewProps) {
  const filteredFiles = useMemo(
    () => visibleFiles(state.workspace.files, state.workspace.searchQuery),
    [state.workspace.files, state.workspace.searchQuery],
  );

  return (
    <div className="workspace-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V2 + V3</div>
          <h2>Workspace and file tree</h2>
        </div>
        <StatusPill tone="green">cwd bound</StatusPill>
      </div>

      <div className="project-strip">
        {state.workspace.projects.map((project) => (
          <article className={project.id === state.workspace.activeProjectId ? "project-card active" : "project-card"} key={project.id}>
            <strong>{project.name}</strong>
            <span>{project.rootPath}</span>
            <small>{project.lastOpenedAt}</small>
          </article>
        ))}
      </div>

      <div className="split-panel">
        <div>
          <label className="search-box">
            <Search size={16} />
            <input
              value={state.workspace.searchQuery}
              onChange={(event) => dispatch({ type: "set_workspace_search", query: event.target.value })}
              placeholder="Search files"
            />
          </label>
          <div className="file-tree">
            {filteredFiles.map((file) => (
              <FileTreeNode file={file} dispatch={dispatch} key={file.id} />
            ))}
          </div>
        </div>

        <div className="chapter-notes">
          <FeatureLine title="Open project" detail="最近项目、信任状态、Runtime cwd 在同一个模型里。" />
          <FeatureLine title="Ignore-ready scan" detail="当前用 fixture，后续替换 main process 文件扫描。" />
          <FeatureLine title="OpenFileIntent" detail="点击文件会切到 Editor 并打开 tab。" />
        </div>
      </div>
    </div>
  );
}

function FileTreeNode({ file, dispatch }: { file: FileNode; dispatch: React.Dispatch<ClientAction> }) {
  if (file.kind === "directory") {
    return (
      <div className="tree-group">
        <div className="tree-row directory">
          <ChevronRight size={14} />
          <FolderTree size={15} />
          <span>{file.name}</span>
        </div>
        <div className="tree-children">
          {(file.children ?? []).map((child) => (
            <FileTreeNode file={child} dispatch={dispatch} key={child.id} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <button className="tree-row file" onClick={() => dispatch({ type: "open_file", path: file.path })}>
      <FileCode2 size={15} />
      <span>{file.name}</span>
      <small>{file.language}</small>
    </button>
  );
}

function ChatView({ state, dispatch, onSend }: ViewProps & { onSend: () => void }) {
  return (
    <div className="chat-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V0 + V1</div>
          <h2>Streaming chat and tool activity</h2>
        </div>
        <StatusPill tone={state.runtime.isRunning ? "amber" : "green"}>
          {state.runtime.isRunning ? "streaming" : "ready"}
        </StatusPill>
      </div>

      <div className="message-list">
        {state.chat.messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <div className="message-role">{message.role}</div>
            <MessageContent content={message.content} />
            {message.status === "streaming" && <span className="cursor" />}
          </article>
        ))}
      </div>

      <div className="composer">
        <textarea
          value={state.chat.prompt}
          onChange={(event) => dispatch({ type: "set_prompt", prompt: event.target.value })}
          placeholder="Send an agent task"
        />
        <button className="primary-button" onClick={onSend} disabled={state.runtime.isRunning}>
          <Send size={16} />
          Send
        </button>
      </div>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/```/g);

  return (
    <div className="message-content">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <pre key={`${part}-${index}`}>
            <code>{part}</code>
          </pre>
        ) : (
          <p key={`${part}-${index}`}>{part}</p>
        ),
      )}
    </div>
  );
}

function EditorView({ state, dispatch }: ViewProps) {
  const file = activeFile(state);

  return (
    <div className="editor-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V4</div>
          <h2>Editor buffer and dirty save</h2>
        </div>
        {file && file.content !== file.savedContent && <StatusPill tone="amber">dirty</StatusPill>}
      </div>

      <div className="tab-strip">
        {state.editor.openFiles.map((openFile) => (
          <button
            className={openFile.path === state.editor.activePath ? "tab active" : "tab"}
            key={openFile.path}
            onClick={() => dispatch({ type: "open_file", path: openFile.path })}
          >
            {openFile.path}
            {openFile.content !== openFile.savedContent && <span className="dirty-dot" />}
          </button>
        ))}
      </div>

      {file ? (
        <>
          <textarea
            className="code-editor"
            value={file.content}
            spellCheck={false}
            onChange={(event) => dispatch({ type: "edit_file", path: file.path, content: event.target.value })}
          />
          <div className="editor-actions">
            <span>{file.language}</span>
            <button className="secondary-button" onClick={() => dispatch({ type: "save_file", path: file.path })}>
              <Save size={16} />
              Save buffer
            </button>
          </div>
        </>
      ) : (
        <EmptyState title="No file open" detail="Use Workspace to open a file intent." />
      )}
    </div>
  );
}

function TerminalView({ state, dispatch }: ViewProps) {
  return (
    <div className="terminal-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V5</div>
          <h2>Workspace terminal boundary</h2>
        </div>
        <StatusPill tone="blue">fake pty</StatusPill>
      </div>

      <div className="terminal-screen">
        {state.terminal.lines.map((line) => (
          <div className={`terminal-line ${line.kind}`} key={line.id}>
            {line.text}
          </div>
        ))}
      </div>

      <div className="terminal-input">
        <Terminal size={16} />
        <input
          value={state.terminal.command}
          onChange={(event) => dispatch({ type: "set_terminal_command", command: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              dispatch({ type: "run_terminal_command" });
            }
          }}
        />
        <button className="icon-button" title="Run command" onClick={() => dispatch({ type: "run_terminal_command" })}>
          <Play size={16} />
        </button>
      </div>
    </div>
  );
}

function AgentView({ state, dispatch }: ViewProps) {
  return (
    <div className="agent-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V6</div>
          <h2>Agent workspace observability</h2>
        </div>
        <StatusPill tone="amber">{state.agent.permissions.filter((permission) => permission.status === "pending").length} pending</StatusPill>
      </div>

      <div className="agent-grid">
        <section className="plain-section">
          <h3>Plan</h3>
          <div className="plan-list">
            {state.agent.plan.map((item) => (
              <div className={`plan-row ${item.status}`} key={item.id}>
                <span />
                <strong>{item.title}</strong>
                <small>{item.status}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="plain-section">
          <h3>Tool timeline</h3>
          <div className="activity-list">
            {state.agent.tools.map((tool) => (
              <article className="activity-row" key={tool.id}>
                <div>
                  <strong>{tool.name}</strong>
                  <code>{JSON.stringify(tool.input)}</code>
                </div>
                <StatusPill tone={tool.status === "success" ? "green" : tool.status === "error" ? "red" : "amber"}>
                  {tool.status}
                </StatusPill>
              </article>
            ))}
          </div>
        </section>

        <section className="plain-section wide">
          <h3>Permission queue</h3>
          <div className="permission-list">
            {state.agent.permissions.map((permission) => (
              <article className="permission-row" key={permission.id}>
                <div>
                  <strong>{permission.toolName}</strong>
                  <span>{permission.reason}</span>
                </div>
                <StatusPill tone={permission.risk === "high" ? "red" : "amber"}>{permission.risk}</StatusPill>
                <button
                  className="icon-button"
                  title="Approve"
                  onClick={() => dispatch({ type: "resolve_permission", id: permission.id, status: "approved" })}
                >
                  <Check size={16} />
                </button>
                <button
                  className="icon-button"
                  title="Deny"
                  onClick={() => dispatch({ type: "resolve_permission", id: permission.id, status: "denied" })}
                >
                  <X size={16} />
                </button>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function DiffView({ state, dispatch }: ViewProps) {
  const diff = activeDiff(state);

  return (
    <div className="diff-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V7</div>
          <h2>Diff proposal and patch decision</h2>
        </div>
        {diff && <StatusPill tone={diff.status === "pending" ? "amber" : diff.status === "accepted" ? "green" : "red"}>{diff.status}</StatusPill>}
      </div>

      {diff ? (
        <>
          <div className="diff-header">
            <div>
              <strong>{diff.title}</strong>
              <span>{diff.filePath}</span>
            </div>
            <div className="diff-actions">
              <button className="secondary-button" onClick={() => dispatch({ type: "resolve_diff", id: diff.id, status: "accepted" })}>
                <Check size={16} />
                Accept
              </button>
              <button className="secondary-button danger" onClick={() => dispatch({ type: "resolve_diff", id: diff.id, status: "rejected" })}>
                <X size={16} />
                Reject
              </button>
            </div>
          </div>
          <div className="diff-viewer">
            <pre className="removed">{prefixLines(diff.before, "- ")}</pre>
            <pre className="added">{prefixLines(diff.after, "+ ")}</pre>
          </div>
        </>
      ) : (
        <EmptyState title="No diff proposal" detail="Send a chat task to receive a runtime diff event." />
      )}
    </div>
  );
}

function SessionsView({ state, dispatch }: ViewProps) {
  return (
    <div className="session-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V8</div>
          <h2>Multi-session resume and timeline</h2>
        </div>
        <StatusPill tone="blue">{state.sessions.items.length} sessions</StatusPill>
      </div>

      <div className="session-list">
        {state.sessions.items.map((session) => (
          <button
            className={session.id === state.sessions.activeSessionId ? "session-row active" : "session-row"}
            key={session.id}
            onClick={() => dispatch({ type: "switch_session", id: session.id })}
          >
            <div>
              <strong>{session.title}</strong>
              <span>{session.id}</span>
            </div>
            <small>{session.turns} turns</small>
            <StatusPill tone={session.status === "running" ? "green" : session.status === "paused" ? "amber" : "blue"}>{session.status}</StatusPill>
          </button>
        ))}
      </div>
    </div>
  );
}

function PluginsView({ state, dispatch }: ViewProps) {
  return (
    <div className="plugin-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V9</div>
          <h2>Plugin registry and capability lifecycle</h2>
        </div>
        <StatusPill tone="green">{state.plugins.items.filter((plugin) => plugin.enabled).length} enabled</StatusPill>
      </div>

      <div className="plugin-grid">
        {state.plugins.items.map((plugin) => (
          <article className="plugin-card" key={plugin.id}>
            <div className="plugin-title">
              <Boxes size={18} />
              <div>
                <strong>{plugin.name}</strong>
                <span>{plugin.version}</span>
              </div>
            </div>
            <div className="capability-row">
              {plugin.capabilities.map((capability) => (
                <StatusPill tone="blue" key={capability}>
                  {capability}
                </StatusPill>
              ))}
            </div>
            <div className="plugin-footer">
              <StatusPill tone={plugin.verified ? "green" : "amber"}>{plugin.verified ? "verified" : "unverified"}</StatusPill>
              <button className="secondary-button" onClick={() => dispatch({ type: "toggle_plugin", id: plugin.id })}>
                {plugin.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function GovernanceView({ state, dispatch }: ViewProps) {
  return (
    <div className="governance-layout">
      <div className="section-heading">
        <div>
          <div className="eyebrow">V10</div>
          <h2>Policy, audit, diagnostics and release</h2>
        </div>
        <StatusPill tone={state.governance.release.compatibility === "compatible" ? "green" : "amber"}>
          {state.governance.release.available} available
        </StatusPill>
      </div>

      <div className="governance-grid">
        <section className="plain-section">
          <h3>Managed policy</h3>
          {state.governance.policies.map((policy) => (
            <PolicyRow policy={policy} dispatch={dispatch} key={policy.id} />
          ))}
        </section>

        <section className="plain-section">
          <h3>Audit stream</h3>
          <div className="audit-list">
            {state.governance.audits.map((audit) => (
              <article className="audit-row" key={audit.id}>
                <StatusPill tone={audit.severity === "blocked" ? "red" : audit.severity === "review" ? "amber" : "blue"}>
                  {audit.severity}
                </StatusPill>
                <div>
                  <strong>{audit.action}</strong>
                  <span>{audit.actor} {"->"} {audit.target}</span>
                </div>
                <small>{audit.at}</small>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function PolicyRow({ policy, dispatch }: { policy: PolicyRule; dispatch: React.Dispatch<ClientAction> }) {
  return (
    <article className="policy-row">
      <div>
        <strong>{policy.name}</strong>
        <span>{policy.scope}</span>
      </div>
      <select
        value={policy.effect}
        onChange={(event) =>
          dispatch({
            type: "set_policy_effect",
            id: policy.id,
            effect: event.target.value as PolicyRule["effect"],
          })
        }
      >
        <option value="allow">allow</option>
        <option value="review">review</option>
        <option value="deny">deny</option>
      </select>
    </article>
  );
}

function RuntimeTimeline({ state }: { state: ClientState }) {
  return (
    <section className="inspector-section">
      <div className="section-mini-heading">
        <Activity size={16} />
        <strong>Runtime timeline</strong>
      </div>
      <div className="timeline-list">
        {state.runtime.events.slice(0, 8).map((event) => (
          <article className={`timeline-row ${event.tone}`} key={event.id}>
            <strong>{event.label}</strong>
            <span>{event.detail}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function MiniGovernance({ state }: { state: ClientState }) {
  return (
    <section className="inspector-section">
      <div className="section-mini-heading">
        <ShieldCheck size={16} />
        <strong>Enterprise boundary</strong>
      </div>
      <FeatureLine title="Policy" detail={`${state.governance.policies.length} managed rules`} />
      <FeatureLine title="Audit" detail={`${state.governance.audits.length} captured events`} />
      <FeatureLine title="Release" detail={`${state.governance.release.current} -> ${state.governance.release.available}`} />
    </section>
  );
}

function FeatureLine({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="feature-line">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function StatusPill({ children, tone }: { children: React.ReactNode; tone: "green" | "amber" | "blue" | "red" }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function prefixLines(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

type ViewProps = {
  state: ClientState;
  dispatch: React.Dispatch<ClientAction>;
};
