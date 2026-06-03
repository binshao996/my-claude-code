# 03 - Tool Timeline

## 当前章节目标

本章实现 Tool Timeline。

完成后，用户可以看到：

- 工具名称。
- 输入摘要。
- 执行状态。
- 结果摘要。
- 是否产生 diff。

## Tool Call 模型

```ts
export type AgentToolCall = {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "success" | "error";
  content: string | null;
  diff: string | null;
  startedAt: number;
  endedAt: number | null;
};
```

## RuntimeEvent 映射

```ts
export function applyToolEvent(
  state: AgentWorkspaceState,
  event: RuntimeEvent,
  now: number,
): AgentWorkspaceState {
  switch (event.type) {
    case "tool_start":
      return {
        ...state,
        status: "acting",
        tools: [
          ...state.tools,
          {
            id: event.id,
            name: event.name,
            input: null,
            status: "running",
            content: null,
            diff: null,
            startedAt: now,
            endedAt: null,
          },
        ],
      };

    case "tool_input":
      return {
        ...state,
        tools: state.tools.map(tool =>
          tool.id === event.id ? { ...tool, input: event.input } : tool,
        ),
      };

    case "tool_result":
      return {
        ...state,
        tools: state.tools.map(tool =>
          tool.id === event.id
            ? {
                ...tool,
                status: event.ok ? "success" : "error",
                content: event.content,
                diff: event.diff ?? null,
                endedAt: now,
              }
            : tool,
        ),
      };

    default:
      return state;
  }
}
```

## ToolTimeline

```tsx
export function ToolTimeline({ tools }: { tools: AgentToolCall[] }) {
  return (
    <section className="tool-timeline">
      <h2>Tools</h2>
      {tools.map(tool => (
        <article key={tool.id} className={`tool-call ${tool.status}`}>
          <header>
            <strong>{tool.name}</strong>
            <span>{tool.status}</span>
          </header>
          <pre>{formatToolInput(tool.input)}</pre>
          {tool.content ? <p>{summarizeToolContent(tool.content)}</p> : null}
          {tool.diff ? <button type="button">Open diff</button> : null}
        </article>
      ))}
    </section>
  );
}
```

V6 的 `Open diff` 只发出 intent，真正 Diff Viewer 在 V7。

## 本章实操：Tool events 驱动 ToolTimeline

### 专属改动文件

```text
src/renderer/agent-workspace/types.ts
src/renderer/agent-workspace/toolEventReducer.ts
src/renderer/agent-workspace/runtimeEventToAgentAction.ts
src/renderer/agent-workspace/agentWorkspaceStore.ts
src/renderer/agent-workspace/fakeRuntimeEvents.ts
src/renderer/components/ToolTimeline.tsx
```

### 实现步骤

1. 在 `types.ts` 定义 `AgentToolCall`，字段包含 `id`、`name`、`input`、`status`、`content`、`diff`、`startedAt`、`endedAt`。
2. 在 event adapter 中映射 `tool_start`、`tool_input`、`tool_result` 为 `tool_started`、`tool_input_updated`、`tool_finished`。
3. reducer 收到 `tool_started` 时追加 running tool，并把 status 设为 `acting`。
4. 收到 result 时按 `id` 更新对应 tool；`event.ok=false` 时 status 为 `error`，`diff` 只保存摘要或原始 diff 引用。
5. `ToolTimeline` 展示工具名称、输入摘要、运行状态、结果摘要；有 diff 时只显示 `Open diff` intent 按钮。
6. fake events 加入 `read_file` success、`run_command` error、带 diff 的 `edit_file` result，确保三种状态都能看见。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，点击 replay，Tool Timeline 依次出现 `read_file` running -> success、`run_command` running -> error；带 diff 的工具卡片出现 `Open diff` 按钮，但点击只发 intent 或提示 V7 实现。

### 常见报错

- tool result 找不到 tool：Runtime 可能先发 result，教学版可创建 orphan result 卡片或忽略并记录 warning。
- input 太长撑爆 UI：`formatToolInput` 必须截断，比如 2KB。
- diff 被当场应用：V6 不能 accept/reject diff，只展示入口，真正交互留 V7。

## 可运行验收

本章验收：

- tool_start 创建 running 卡片。
- tool_input 更新输入摘要。
- tool_result 更新 success/error、content、diff。
- ToolTimeline 不直接执行工具、不应用 diff。

## 当前章节缺陷

Tool Timeline 只展示摘要，不做 diff 交互，也不支持 tool replay。

## 下一章预告

下一章会实现 Runtime Event Timeline：把 turn、context update、done、error 等事件统一展示。
