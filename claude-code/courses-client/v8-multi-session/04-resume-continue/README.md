# 04 - Resume / Continue

## 当前章节目标

本章实现恢复会话。

## Resume

```ts
export async function resumeSession(
  workspace: Workspace,
  sessionId: string,
): Promise<LoadedSession> {
  const store = new SessionStore(workspace.rootPath);
  const loaded = await store.loadSession(sessionId);

  if (!loaded) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return loaded;
}
```

## Continue

```ts
export async function continueLatestSession(
  workspace: Workspace,
): Promise<LoadedSession> {
  const store = new SessionStore(workspace.rootPath);
  const loaded = await store.getLatestSession();

  if (!loaded) {
    throw new Error("No session found to continue.");
  }

  return loaded;
}
```

## Runtime 重建

恢复会话后，要用 loaded session 创建 Runtime：

```ts
export async function createRuntimeForLoadedSession(
  workspace: Workspace,
  loadedSession: LoadedSession,
): Promise<RuntimeClient> {
  return createRuntimeClientForWorkspace(workspace, {
    loadedSession,
  });
}
```

教学版先用 fake runtime handoff 验证恢复链路。handoff event 明确 Runtime、Chat、Plan、Header 要同步更新：

```ts
export type RuntimeHandoffEvent =
  | {
      type: "runtime:handoff_started";
      workspaceId: string;
      sessionId: string;
      mode: "resumed" | "continued";
    }
  | {
      type: "runtime:handoff_completed";
      workspaceId: string;
      sessionId: string;
      messageCount: number;
      hasPlan: boolean;
    }
  | { type: "runtime:handoff_failed"; sessionId: string; error: string };

export const fakeRuntimeHandoffEvents: RuntimeHandoffEvent[] = [
  {
    type: "runtime:handoff_started",
    workspaceId: "workspace-client",
    sessionId: "sess_v8_fixture_001",
    mode: "resumed",
  },
  {
    type: "runtime:handoff_completed",
    workspaceId: "workspace-client",
    sessionId: "sess_v8_fixture_001",
    messageCount: 4,
    hasPlan: true,
  },
];
```

```ts
export async function resumeSessionWithHandoff(
  workspace: Workspace,
  sessionId: string,
  dispatch: (event: RuntimeHandoffEvent) => void,
): Promise<RuntimeClient> {
  dispatch({
    type: "runtime:handoff_started",
    workspaceId: workspace.id,
    sessionId,
    mode: "resumed",
  });

  const loaded = await resumeSession(workspace, sessionId);
  const runtime = await createRuntimeForLoadedSession(workspace, loaded);

  dispatch({
    type: "runtime:handoff_completed",
    workspaceId: workspace.id,
    sessionId,
    messageCount: loaded.messages.length,
    hasPlan: loaded.plan !== null,
  });

  return runtime;
}
```

## UI 状态重建

Resume 后需要恢复：

- Chat messages。
- Plan View。
- Session header。

不自动恢复：

- 打开的 editor tabs。
- terminal process。
- 未保存 buffer。

## 本章交付

本章交付 `Resume` 和 `Continue` 的真实恢复链路。

恢复成功后必须同时更新：

- Runtime：用 `LoadedSession` 创建新的 RuntimeClient。
- Chat：恢复历史 messages。
- Plan：恢复 plan view。
- Header：显示 `resumed` 或 `continued` 和 session id。
- Store：`currentSessionId` 指向恢复后的 session。

UI skeleton：

```tsx
export function ResumeStatusBanner({
  event,
}: {
  event: RuntimeHandoffEvent | null;
}) {
  if (!event) return null;

  if (event.type === "runtime:handoff_started") {
    return <p>Restoring {event.sessionId}...</p>;
  }

  if (event.type === "runtime:handoff_failed") {
    return <p role="alert">{event.error}</p>;
  }

  return (
    <p>
      Restored {event.messageCount} messages
      {event.hasPlan ? " with plan" : ""}
    </p>
  );
}
```

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

手动验证：

- 点击 Session List 某一项后，Chat 恢复该 session 的 messages。
- 点击 Continue 后恢复当前 workspace 最新 session，而不是全局最新 session。
- handoff banner 先显示 `Restoring sess_v8_fixture_001...`，成功后显示 restored message count。
- session id 不存在时显示 `Session not found`。
- 当前 workspace 没有 session 时 Continue 显示 `No session found to continue.`。
- Resume 不恢复 terminal process、editor tabs 和 dirty buffer。

## 当前章节缺陷

本章只恢复 Runtime history，不恢复完整 UI layout。

## 下一章预告

下一章会实现 Session Timeline：把 messages、plan、tools、diff decisions 展示成会话详情。
