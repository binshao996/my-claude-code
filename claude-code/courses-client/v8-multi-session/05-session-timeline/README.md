# 05 - Session Timeline

## 当前章节目标

本章实现 Session Timeline。

## Timeline 类型

```ts
export type SessionTimelineItem =
  | { type: "message"; timestamp: string; role: "user" | "assistant"; summary: string }
  | { type: "plan"; timestamp: string; title: string; completed: number; total: number }
  | { type: "tool"; timestamp: string; name: string; status: "success" | "error" }
  | { type: "diff"; timestamp: string; fileCount: number; decision: "accepted" | "rejected" | "pending" };
```

## 从 LoadedSession 构建

```ts
export function loadedSessionToTimeline(
  loaded: LoadedSession,
): SessionTimelineItem[] {
  const items: SessionTimelineItem[] = [];

  for (const message of loaded.messages) {
    items.push({
      type: "message",
      timestamp: loaded.metadata.createdAt,
      role: message.role,
      summary: summarizeMessage(message),
    });
  }

  if (loaded.plan) {
    items.push({
      type: "plan",
      timestamp: loaded.plan.updatedAt,
      title: loaded.plan.title,
      completed: loaded.plan.items.filter(item => item.status === "completed").length,
      total: loaded.plan.items.length,
    });
  }

  return items;
}
```

Runtime 当前 message entry 有 timestamp，但 `LoadedSession.messages` 没保留每条 timestamp。生产实现应保留 transcript entry 级数据。

## Fixture / Fake Event Log

本章必须用 fake event log 覆盖四种 UI item，避免 Timeline 只显示 Chat message：

```ts
export const fakeTimelineEvents: SessionTimelineItem[] = [
  {
    type: "message",
    timestamp: "2026-06-03T09:01:00.000Z",
    role: "user",
    summary: "Add session timeline",
  },
  {
    type: "tool",
    timestamp: "2026-06-03T09:03:00.000Z",
    name: "FileEdit",
    status: "success",
  },
  {
    type: "plan",
    timestamp: "2026-06-03T09:04:00.000Z",
    title: "Implement timeline",
    completed: 2,
    total: 3,
  },
  {
    type: "diff",
    timestamp: "2026-06-03T09:06:00.000Z",
    fileCount: 2,
    decision: "accepted",
  },
];
```

```ts
export function mergeTranscriptAndClientEvents(
  transcriptItems: SessionTimelineItem[],
  clientEvents: SessionTimelineItem[],
): SessionTimelineItem[] {
  return [...transcriptItems, ...clientEvents].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}
```

## SessionTimeline

```tsx
export function SessionTimeline({ items }: { items: SessionTimelineItem[] }) {
  return (
    <section className="session-timeline">
      <h2>Timeline</h2>
      {items.map((item, index) => (
        <article key={index} className={`timeline-item ${item.type}`}>
          <strong>{item.type}</strong>
          <span>{item.timestamp}</span>
          <p>{renderTimelineSummary(item)}</p>
        </article>
      ))}
    </section>
  );
}
```

## Service / Store / UI Skeleton

本章最小骨架：

- service：`loadedSessionToTimeline()` 和 `mergeTranscriptAndClientEvents()`。
- store：`sessionStore.activeSession.timeline` 保存合并后的 `SessionTimelineItem[]`。
- UI：`SessionTimeline` 渲染 message、plan、tool、diff 四类 item。

```tsx
export function renderTimelineSummary(item: SessionTimelineItem): string {
  switch (item.type) {
    case "message":
      return `${item.role}: ${item.summary}`;
    case "plan":
      return `${item.title} (${item.completed}/${item.total})`;
    case "tool":
      return `${item.name} ${item.status}`;
    case "diff":
      return `${item.fileCount} files ${item.decision}`;
  }
}
```

## 本章交付

本章交付 `SessionTimeline`，把 transcript 和 Client event log 合并为可浏览历史。

Timeline 至少展示四类 item：

- `message`：用户和 assistant 消息摘要。
- `plan`：计划标题、完成数和总数。
- `tool`：工具名称和 success/error。
- `diff`：文件数和 accepted/rejected/pending。

Diff decision 来自 V7 的 `PatchAuditRecord`，不能只从 message 文本猜。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

恢复一个包含工具调用和 diff 决策的 session 后，Timeline 应该显示：

- 消息条目按 timestamp 顺序排列。
- Plan 条目显示完成进度。
- Tool 条目显示工具名和状态。
- Diff 条目显示文件数和最终 decision。
- 使用 fake event log 时屏幕上能同时看到 `FileEdit success` 和 `2 files accepted`。
- transcript 中缺少单条 timestamp 时使用 entry timestamp fallback，并在诊断日志标记。

## 当前章节缺陷

教学版 timeline 受 Runtime transcript 当前结构限制。完整工具和 diff decision history 需要 Client 扩展事件记录。

## 下一章预告

下一章会实现 Project Session Scope：确保不同 Workspace 的 sessions 不串项目。
