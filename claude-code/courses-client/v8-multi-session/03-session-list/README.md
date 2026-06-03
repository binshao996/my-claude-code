# 03 - Session List

## 当前章节目标

本章实现项目级 Session List。

## SessionService

```ts
export class SessionService {
  constructor(private readonly workspace: Workspace) {}

  async listSessions(): Promise<ClientSession[]> {
    const store = new SessionStore(this.workspace.rootPath);
    const sessions = await store.listSessions();

    return sessions.map(item => ({
      id: item.sessionId,
      workspaceId: this.workspace.id,
      cwd: item.cwd,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messageCount,
      firstPrompt: item.firstPrompt,
      transcriptPath: item.path,
    }));
  }
}
```

教学实现先提供 fake transcript/metadata fixture loader，确保本章写完就能看到列表：

```ts
export const fakeSessionListFixture = [
  {
    metadata: {
      sessionId: "sess_v8_list_newer",
      cwd: "/workspaces/claude-code-client",
      createdAt: "2026-06-03T09:00:00.000Z",
      version: "2.1.888",
    },
    transcriptPath:
      "/workspaces/claude-code-client/.client-sessions/sess_v8_list_newer.jsonl",
    updatedAt: "2026-06-03T09:24:00.000Z",
    firstPrompt: "Add session timeline",
    messageCount: 8,
  },
  {
    metadata: {
      sessionId: "sess_v8_list_older",
      cwd: "/workspaces/claude-code-client",
      createdAt: "2026-06-02T15:00:00.000Z",
      version: "2.1.888",
    },
    transcriptPath:
      "/workspaces/claude-code-client/.client-sessions/sess_v8_list_older.jsonl",
    updatedAt: "2026-06-02T15:12:00.000Z",
    firstPrompt: "",
    messageCount: 2,
  },
] as const;

export function fakeListSessions(workspace: Workspace): ClientSession[] {
  return fakeSessionListFixture
    .filter(item => item.metadata.cwd === workspace.rootPath)
    .map(item => ({
      id: item.metadata.sessionId,
      workspaceId: workspace.id,
      cwd: item.metadata.cwd,
      createdAt: item.metadata.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messageCount,
      firstPrompt: item.firstPrompt,
      transcriptPath: item.transcriptPath,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
```

## SessionList

```tsx
export function SessionList({
  sessions,
  status,
  error,
  onResume,
}: {
  sessions: ClientSession[];
  status: SessionState["status"];
  error: string | null;
  onResume(sessionId: string): void;
}) {
  if (status === "error") {
    return <SessionListError message={error ?? "Failed to load sessions."} />;
  }

  if (sessions.length === 0) {
    return <SessionListEmpty title="No sessions in this workspace" />;
  }

  return (
    <section className="session-list">
      <h2>Sessions</h2>
      {sessions.map(session => (
        <button key={session.id} type="button" onClick={() => onResume(session.id)}>
          <strong>{session.firstPrompt || "Untitled session"}</strong>
          <span>{session.updatedAt}</span>
          <small>{session.messageCount} messages</small>
        </button>
      ))}
    </section>
  );
}
```

```tsx
export function SessionListEmpty({ title }: { title: string }) {
  return (
    <section className="session-list-empty">
      <h2>{title}</h2>
      <p>Start a new session to create workspace history.</p>
    </section>
  );
}

export function SessionListError({ message }: { message: string }) {
  return (
    <section className="session-list-error" role="alert">
      <h2>Session list failed</h2>
      <p>{message}</p>
    </section>
  );
}
```

## 排序

默认按 `updatedAt desc`，与 Runtime `listSessions()` 保持一致。

## 本章交付

本章交付 `SessionService.listSessions()` 和 `SessionList`。

接入链路：

```text
Workspace.rootPath
  -> main/session/SessionService.listSessions()
  -> ipc session:list
  -> renderer/session/sessionActions.loadSessions()
  -> SessionList
```

列表必须展示 `firstPrompt`、`updatedAt`、`messageCount`，并按 `updatedAt desc` 排序。空项目显示 `No sessions in this workspace`，不要显示其他项目历史。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

在同一 workspace 创建两条 session 后，应该看到：

- Session List 出现两行，最新 session 在最上方。
- 每行显示首条用户 prompt 或 `Untitled session`。
- 使用 fake fixture 时第一行显示 `Add session timeline`。
- 空 workspace 显示 `No sessions in this workspace`。
- 点击某行只触发 `onResume(session.id)`，不直接重建 Runtime。
- 切换 workspace 后列表重新加载，旧项目 session 消失。
- `listSessions()` 失败时显示错误但不清空当前 Chat。

## 当前章节缺陷

本章只展示列表，不实现 resume。

## 下一章预告

下一章会实现 Resume / Continue：恢复指定 session 或继续当前项目最新 session。
