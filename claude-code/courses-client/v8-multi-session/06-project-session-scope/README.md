# 06 - Project Session Scope

## 当前章节目标

本章实现项目级会话隔离。

## Runtime 当前设计

`SessionStore` 通过 `cwd` 决定项目目录：

```ts
new SessionStore(options.cwd)
```

内部路径类似：

```text
~/.claude-code-mini/projects/<sanitized-cwd>/<sessionId>.jsonl
```

这说明 session 已经天然是项目级。

## Client 侧原则

Client 必须保证：

```text
Workspace.rootPath
  -> SessionService
  -> SessionStore(rootPath)
```

不要让 renderer 直接传任意 cwd 给 SessionStore。

## 切换 Workspace

```text
workspace changed
  -> clear current session state
  -> list sessions for new workspace
  -> create or resume runtime for selected session
```

## Workspace Scoped Fixtures

本章必须覆盖空态和错态，证明 UI 是 workspace scoped：

```ts
export const workspaceAFixture: Workspace = {
  id: "workspace-a",
  name: "client-a",
  rootPath: "/workspaces/client-a",
};

export const workspaceBFixture: Workspace = {
  id: "workspace-b",
  name: "client-b",
  rootPath: "/workspaces/client-b",
};

export const fakeScopedSession = {
  metadata: {
    sessionId: "sess_workspace_a_only",
    cwd: "/workspaces/client-a",
    createdAt: "2026-06-03T10:00:00.000Z",
    version: "2.1.888",
  },
};

export const fakeWorkspaceBEmptyState: SessionState = {
  workspaceId: "workspace-b",
  currentSessionId: null,
  sessions: [],
  details: {},
  status: "idle",
  error: null,
};

export const fakeCrossWorkspaceErrorState: SessionState = {
  ...fakeWorkspaceBEmptyState,
  status: "error",
  error: "Session does not belong to current workspace.",
};
```

## 错误防护

恢复 session 时要验证：

```ts
export function assertSessionBelongsToWorkspace(
  workspace: Workspace,
  loaded: LoadedSession,
): void {
  if (normalizePath(loaded.metadata.cwd) !== normalizePath(workspace.rootPath)) {
    throw new Error("Session does not belong to current workspace.");
  }
}
```

Renderer 只处理 scoped state，不接收裸 `cwd`：

```tsx
export function WorkspaceSessionStateView({
  workspace,
  state,
}: {
  workspace: Workspace;
  state: SessionState;
}) {
  if (state.status === "error") {
    return <p role="alert">{state.error}</p>;
  }

  if (state.sessions.length === 0) {
    return <p>No sessions in {workspace.name}</p>;
  }

  return (
    <SessionList
      sessions={state.sessions}
      status={state.status}
      error={state.error}
      onResume={resumeByIdOnly}
    />
  );
}

function resumeByIdOnly(sessionId: string): void {
  dispatchSessionAction({ type: "session:resume_clicked", sessionId });
}
```

## 本章交付

本章交付 Project Session Scope，确保 session 只能在所属 workspace 恢复。

强制规则：

- `SessionService` 只能由 `Workspace.rootPath` 构造 `SessionStore`。
- Resume 前必须执行 `assertSessionBelongsToWorkspace()`。
- workspace 切换时清空 `currentSessionId`、details 和 active timeline。
- renderer 只能传 `sessionId`，不能传任意 `cwd`。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

准备两个 workspace 后验证：

- A 项目创建的 session 不出现在 B 项目的 Session List。
- 在 B 项目强行 resume A 的 session id 会报 `Session does not belong to current workspace.`。
- B 项目空态显示 `No sessions in client-b`，不是显示 A 项目列表。
- 切换 workspace 后 Session Header、Timeline 和 active session 都刷新。
- Continue 只取当前 workspace 最新 session。
- 失败事件进入 diagnostics，但不泄露完整本地路径之外的敏感内容。

## 当前章节缺陷

V8 只处理本地项目会话，不处理远程、后台和多客户端一致性。

## 下一版本预告

V9 会实现 Plugin System。

有了 Workspace、Editor、Terminal、Agent Workspace 和 Session，Client 已经具备核心产品骨架。V9 会让它可扩展：

```text
Plugin commands
Plugin tools
Plugin panels
Lifecycle
Permission boundary
```
