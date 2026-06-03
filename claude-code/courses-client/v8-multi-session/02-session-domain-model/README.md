# 02 - Session 数据模型

## 当前章节目标

本章定义 Client 侧 Session 模型。

## Runtime 基础类型

```ts
export type SessionMetadata = {
  sessionId: string;
  cwd: string;
  createdAt: string;
  version: string;
};

export type LoadedSession = {
  metadata: SessionMetadata;
  messages: ChatMessage[];
  plan: Plan | null;
  path: string;
};
```

## Client Session

```ts
export type ClientSession = {
  id: string;
  workspaceId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  firstPrompt: string;
  transcriptPath: string;
};
```

## SessionDetail

```ts
export type SessionDetail = {
  session: ClientSession;
  messages: ChatMessage[];
  plan: AgentPlanView | null;
  timeline: AgentTimelineEvent[];
  diffDecisions: PatchAuditRecord[];
};
```

## SessionState

```ts
export type SessionState = {
  workspaceId: string | null;
  currentSessionId: string | null;
  sessions: ClientSession[];
  details: Record<string, SessionDetail>;
  status: "idle" | "loading" | "resuming" | "error";
  error: string | null;
};
```

## 本章交付

本章交付 metadata / transcript 的 Client 模型。

`SessionDetail` 不应只保存 messages，还要保留可构建 timeline 的 transcript entry：

```text
metadata
transcript entries
messages
plan
tool events
diff decisions
```

推荐新增 `TranscriptEntryView`：

```ts
export type TranscriptEntryView = {
  id: string;
  type: "message" | "plan" | "tool" | "diff";
  timestamp: string;
  summary: string;
};
```

## Fake Transcript Fixture

本章必须提供一个 fake transcript/metadata fixture。后续章节都从这个 fixture 派生 UI，避免每章各自编一份数据。

```ts
export const fakeSessionMetadata: SessionMetadata = {
  sessionId: "sess_v8_fixture_001",
  cwd: "/workspaces/claude-code-client",
  createdAt: "2026-06-03T09:00:00.000Z",
  version: "2.1.888",
};

export const fakeTranscriptEntries = [
  {
    id: "entry_001",
    type: "metadata",
    timestamp: "2026-06-03T09:00:00.000Z",
    metadata: fakeSessionMetadata,
  },
  {
    id: "entry_002",
    type: "message",
    timestamp: "2026-06-03T09:01:00.000Z",
    role: "user",
    content: "Add a diff review panel",
  },
  {
    id: "entry_003",
    type: "plan",
    timestamp: "2026-06-03T09:02:00.000Z",
    title: "Implement diff review panel",
    items: [
      { id: "plan_1", text: "Create panel shell", status: "completed" },
      { id: "plan_2", text: "Wire patch decisions", status: "in_progress" },
    ],
  },
] as const;
```

## Code Skeleton

```ts
export function transcriptEntriesToSessionDetail(
  workspaceId: string,
  transcriptPath: string,
  entries: readonly unknown[],
): SessionDetail {
  const metadata = readMetadataEntry(entries);
  const messages = readMessageEntries(entries);
  const plan = readLatestPlanEntry(entries);
  const timeline = entriesToTimeline(entries);

  return {
    session: {
      id: metadata.sessionId,
      workspaceId,
      cwd: metadata.cwd,
      createdAt: metadata.createdAt,
      updatedAt: timeline.at(-1)?.timestamp ?? metadata.createdAt,
      messageCount: messages.length,
      firstPrompt: messages.find(message => message.role === "user")?.content ?? "",
      transcriptPath,
    },
    messages,
    plan,
    timeline,
    diffDecisions: [],
  };
}

function readMetadataEntry(entries: readonly unknown[]): SessionMetadata {
  const entry = entries.find(isMetadataEntry);
  if (!entry) throw new Error("Transcript metadata missing.");
  return entry.metadata;
}

function readMessageEntries(entries: readonly unknown[]): ChatMessage[] {
  return entries.filter(isMessageEntry).map(entry => ({
    role: entry.role,
    content: entry.content,
  }));
}

function readLatestPlanEntry(entries: readonly unknown[]): AgentPlanView | null {
  return entries.filter(isPlanEntry).at(-1) ?? null;
}
```

调试 UI 骨架：

```tsx
export function SessionDebugPanel({ detail }: { detail: SessionDetail }) {
  return (
    <aside className="session-debug-panel">
      <h2>Session Metadata</h2>
      <dl>
        <dt>sessionId</dt>
        <dd>{detail.session.id}</dd>
        <dt>cwd</dt>
        <dd>{detail.session.cwd}</dd>
        <dt>transcriptPath</dt>
        <dd>{detail.session.transcriptPath}</dd>
      </dl>
    </aside>
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

加载一个已有 session 后，调试面板应该显示：

- `metadata.sessionId`、`cwd`、`createdAt` 和 `version`。
- `ClientSession.transcriptPath` 指向当前 workspace 的 JSONL。
- fake fixture 中的首条用户消息显示为 `firstPrompt`。
- `messageCount` 来自 transcript，不是 UI 当前消息数组长度猜测。
- `SessionDetail.timeline` 至少能从 message / plan 构建。
- transcript 解析失败时 session 进入 `error`，列表仍可继续展示其他 session。

## 当前章节缺陷

Runtime transcript 当前不完整记录 tool timeline 和 diff decisions。V8 教学版可以从 Client event log 扩展。

## 下一章预告

下一章会实现 Session List：按当前 Workspace 列出历史会话。
