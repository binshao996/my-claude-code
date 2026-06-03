# 04 - Runtime Event Timeline

## 当前章节目标

本章实现 Runtime Event Timeline。

Tool Timeline 只展示工具。Runtime Timeline 展示更完整的执行过程：

- turn start。
- context update。
- tool result。
- message done。
- max turns。
- error。

## Timeline Event

```ts
export type AgentTimelineEvent = {
  id: string;
  type:
    | "turn_start"
    | "context_update"
    | "tool_start"
    | "tool_result"
    | "permission"
    | "done"
    | "error";
  title: string;
  detail: string | null;
  createdAt: number;
};
```

## 映射 RuntimeEvent

```ts
export function runtimeEventToTimelineEvent(
  event: RuntimeEvent,
  now: number,
): AgentTimelineEvent | null {
  switch (event.type) {
    case "turn_start":
      return {
        id: crypto.randomUUID(),
        type: "turn_start",
        title: `Turn ${event.turn} started`,
        detail: null,
        createdAt: now,
      };

    case "context_update":
      return {
        id: crypto.randomUUID(),
        type: "context_update",
        title: "Context updated",
        detail: `${event.beforeTokens} -> ${event.afterTokens} tokens`,
        createdAt: now,
      };

    case "done":
      return {
        id: crypto.randomUUID(),
        type: "done",
        title: "Run completed",
        detail: null,
        createdAt: now,
      };

    case "error":
      return {
        id: crypto.randomUUID(),
        type: "error",
        title: "Run failed",
        detail: event.message,
        createdAt: now,
      };

    default:
      return null;
  }
}
```

## Timeline UI

```tsx
export function RuntimeEventTimeline({
  events,
}: {
  events: AgentTimelineEvent[];
}) {
  return (
    <section className="runtime-event-timeline">
      <h2>Runtime Timeline</h2>
      {events.map(event => (
        <article key={event.id} className={`timeline-event ${event.type}`}>
          <strong>{event.title}</strong>
          {event.detail ? <p>{event.detail}</p> : null}
        </article>
      ))}
    </section>
  );
}
```

## 本章实操：RuntimeTimeline 保存运行轨迹

### 专属改动文件

```text
src/renderer/agent-workspace/types.ts
src/renderer/agent-workspace/runtimeEventToTimelineEvent.ts
src/renderer/agent-workspace/runtimeEventToAgentAction.ts
src/renderer/agent-workspace/agentWorkspaceStore.ts
src/renderer/agent-workspace/fakeRuntimeEvents.ts
src/renderer/components/RuntimeEventTimeline.tsx
```

### 实现步骤

1. 在 `types.ts` 定义 `AgentTimelineEvent`，包含 `id`、`type`、`title`、`detail`、`createdAt`。
2. 实现 `runtimeEventToTimelineEvent(event, now)`，覆盖 `turn_start`、`context_update`、`tool_start`、`tool_result`、`permission_requested`、`done`、`error`。
3. event adapter 对每个 RuntimeEvent 同时生成业务 action 和 timeline action：例如 tool_start 既更新 ToolTimeline，也追加 RuntimeTimeline。
4. reducer 处理 `timeline_event_appended`，保留最近 N 条，例如 500 条，避免长任务无限增长。
5. `RuntimeEventTimeline` 按时间展示事件；detail 只显示摘要，不塞完整 stdout/stderr。
6. fake events 加入 context token 变化、tool result、done，点击 replay 后能看到完整运行轨迹。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，Runtime Timeline 会出现 `Turn 1 started`、`Context updated 1200 -> 1800 tokens`、`Tool read_file started`、`Run completed` 等条目；Tool Timeline 和 Runtime Timeline 同时更新但展示粒度不同。

### 常见报错

- timeline 重复两条相同事件：检查 adapter 是否被 main 和 renderer 双重订阅。
- stdout 把页面撑爆：timeline detail 只放摘要，完整输出留 Tool result 或 Terminal transcript。
- id 每次 render 都变化：id 在转换事件时生成，不在 React render 中生成。

## 可运行验收

本章验收：

- fake RuntimeEvent 能追加 timeline event。
- context_update 显示 token 变化。
- tool_start/tool_result 同时驱动 ToolTimeline 和 RuntimeTimeline。
- timeline 有最大长度裁剪。

## 当前章节缺陷

本章是内存时间线，不做持久化回放。

## 下一章预告

下一章会实现 Permission Queue：当 Runtime 需要用户审批时，Agent Workspace 展示审批队列并把结果回传 Runtime。
