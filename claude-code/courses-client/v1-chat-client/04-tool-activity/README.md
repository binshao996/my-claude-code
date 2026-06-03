# 04 - Tool Activity

## 当前章节目标

本章把 Runtime 的工具事件渲染成 Agent Activity。

完成后，用户可以看到：

- Agent 调用了哪个工具。
- 工具当前是否运行中。
- 工具输入摘要。
- 工具执行成功或失败。
- 工具结果摘要。

## 为什么需要 Tool Activity

AI Coding Agent Client 不是普通聊天产品。用户关心的不只是回答，还关心 Agent 做了什么。

如果没有 Tool Activity，用户只能看到最终回答：

```text
我已经修改完成。
```

但不知道：

- 它读了哪些文件。
- 它执行了哪些命令。
- 它是否真的写入了文件。
- 它是否遇到错误后换了方案。

Tool Activity 是建立信任的基础。

## ToolActivityList

```tsx
type ToolActivityListProps = {
  activities: ToolActivity[];
};

export function ToolActivityList({ activities }: ToolActivityListProps) {
  if (activities.length === 0) {
    return null;
  }

  return (
    <aside className="tool-activity-list">
      <h2>Agent Activity</h2>
      {activities.map(activity => (
        <ToolActivityItem key={activity.id} activity={activity} />
      ))}
    </aside>
  );
}
```

## ToolActivityItem

```tsx
type ToolActivityItemProps = {
  activity: ToolActivity;
};

export function ToolActivityItem({ activity }: ToolActivityItemProps) {
  return (
    <article className={`tool-activity tool-activity-${activity.status}`}>
      <header>
        <span>{renderToolStatus(activity.status)}</span>
        <strong>{activity.name}</strong>
      </header>

      {activity.input ? (
        <pre className="tool-input">{formatToolInput(activity.input)}</pre>
      ) : null}

      {activity.content ? (
        <p className="tool-result">{summarizeToolResult(activity.content)}</p>
      ) : null}
    </article>
  );
}
```

## 输入摘要

不要把完整 JSON 输入都塞进 UI。工具输入可能很长，也可能包含不适合展示的字段。

教学版先做保守摘要：

```ts
export function formatToolInput(input: unknown): string {
  const text = JSON.stringify(input, null, 2);
  if (!text) return "";

  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}
```

生产实现应按工具类型定制摘要：

| 工具 | 摘要方式 |
| --- | --- |
| `read_file` | 显示路径 |
| `write_file` | 显示路径和写入大小 |
| `edit_file` | 显示路径和 patch 摘要 |
| `run_command` | 显示命令和退出码 |
| `update_plan` | 显示计划项数量和状态 |

## 结果摘要

```ts
export function summarizeToolResult(content: string): string {
  const normalized = content.trim();
  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 240)}...`;
}
```

V1 不展示完整工具结果，因为完整内容会冲掉主对话。后续 V6 Agent Workspace 可以把工具详情放进独立面板。

## 状态视觉

```css
.tool-activity-list {
  border-top: 1px solid #2f2a25;
  padding: 12px 16px;
}

.tool-activity {
  margin-top: 8px;
  padding: 10px;
  border: 1px solid #3a332d;
  border-radius: 8px;
  background: #171514;
}

.tool-activity-running {
  border-color: #5769f7;
}

.tool-activity-success {
  border-color: #2f7d55;
}

.tool-activity-error {
  border-color: #b54747;
}

.tool-input {
  max-height: 140px;
  overflow: auto;
  font-size: 12px;
}
```

## 和主消息的关系

Tool Activity 不应该混进 assistant 气泡里。

原因：

- assistant 消息是模型对用户说的话。
- tool activity 是系统观察到的执行过程。
- 二者来源不同，权限和审计含义也不同。

正确结构：

```text
ChatTimeline
  user message
  assistant message

AgentActivity
  tool start
  tool input
  tool result
```

等到 V6，会把 Agent Activity 升级为更完整的 Agent Workspace。

## 调试验证

用假事件验证：

```ts
dispatch({ type: "tool_started", id: "t1", name: "read_file", now: Date.now() });
dispatch({ type: "tool_input_received", id: "t1", input: { path: "package.json" } });
dispatch({
  type: "tool_finished",
  id: "t1",
  ok: true,
  content: "{ name: 'demo' }",
  now: Date.now(),
});
```

预期：

- 初始显示 running。
- 收到 input 后展示路径 JSON。
- 收到 result 后状态变成 success。
- 失败时状态变成 error。

## 本章实操标准

### 本章效果

完成本章后，Runtime 的工具事件会进入独立的 Agent Activity 区域，而不是混进 assistant 气泡：

```text
Runtime tool_start/tool_input/tool_result
  -> runtimeEventToChatAction()
  -> chatReducer.activities
  -> selectActivities()
  -> ToolActivityList
```

用户能一边看 streaming chat，一边看到 Agent 正在读文件、执行命令或工具失败。

### 改动文件

本章改动文件：

```text
src/renderer/chat/types.ts
src/renderer/chat/chatReducer.ts
src/renderer/chat/selectors.ts
src/renderer/components/ChatScreen.tsx
src/renderer/components/ToolActivityList.tsx
src/renderer/components/ToolActivityItem.tsx
src/renderer/styles/chat.css
```

如果前几章已经实现了 `ToolActivity` 类型和 reducer action，本章重点是补 UI、摘要函数和状态样式。

### 实现步骤

1. 确认 `tool_started` 创建 running activity，`tool_input_received` 合并 input，`tool_finished` 写入 success/error、content、diff、endedAt。
2. 在 `selectors.ts` 增加 `selectActivities()`，按 `startedAt` 保持 Runtime 事件顺序。
3. 在 `ToolActivityList.tsx` 渲染活动列表；没有 activity 时返回 `null`，避免空面板。
4. 在 `ToolActivityItem.tsx` 显示工具名、状态、输入摘要、结果摘要；不要展示完整大 JSON。
5. 在 `ChatScreen.tsx` 把 `ToolActivityList` 放在 timeline 下方或侧栏，让用户能同时看到 chat 和 activity。
6. 用假事件或真实 prompt 验证 running -> success/error 的状态变化。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

用能触发工具的 prompt 验证，例如：

```text
请读取 package.json，并告诉我 scripts 里有哪些命令。
```

预期效果：

- 工具开始时出现一条 `read_file` 或对应工具 activity，状态为 running。
- 收到 input 后能看到 `{ "path": "package.json" }` 这类摘要。
- 工具成功后边框或状态文案变为 success，并显示结果摘要。
- 工具失败时状态变为 error，错误摘要可见，但不会阻塞 assistant 后续文本显示。
- assistant 的自然语言回答仍在 `ChatTimeline` 中，工具过程只在 `ToolActivityList` 中。

### 常见报错

- Activity 永远 running：确认 Runtime 的 `tool_result` 被映射成 `tool_finished`，并且 id 与 `tool_start` 一致。
- Activity 重复出现：确认 `tool_input_received` 和 `tool_finished` 是 update 既有 activity，不是 push 新 activity。
- 工具输入太长导致页面卡顿：确认 `formatToolInput()` 有长度截断。
- 工具结果把聊天挤走：确认 `summarizeToolResult()` 有长度截断，完整结果留给后续详情面板。
- 状态颜色不变：确认 CSS class 使用 `tool-activity-${activity.status}`，状态值是 `running | success | error`。

## 可运行验收

本章完成后执行 V1 完整 smoke check：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

最终页面必须同时具备 streaming chat、Markdown/code block 和 Tool Activity。三者都消费同一个 `ChatState`，不要各自维护一份 Runtime event 状态。

## 当前章节缺陷

V1 的 Tool Activity 只展示摘要。

它还不能：

- 展开完整工具详情。
- 跳转到文件。
- 展示命令实时输出。
- 展示 diff。
- 做权限审批。

这些能力分别会在 V3、V5、V6、V7 中演化。

## 下一版本预告

V2 会实现 Workspace，把 Chat 从单纯对话升级为围绕具体项目运行的 Client。
