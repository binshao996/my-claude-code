# 01 - 事件状态模型

## 当前章节目标

本章实现 V1 的核心：把 V0 的 `RuntimeEvent` 转成可维护的 `ChatState`。

完成后，Client 会具备：

- 可追加用户消息。
- 可流式追加 assistant 文本。
- 可记录工具运行状态。
- 可记录 turn、context、session 信息。
- 可被 UI 组件通过 selector 稳定消费。

## 为什么先做状态模型

Chat Client 最大的错误设计，是把 Runtime 事件直接写进 React 组件。

这样短期能跑，长期会崩：

- `text_delta` 高频触发，组件容易重复渲染。
- `tool_start` 和 `tool_result` 分散在不同 UI 中，状态难以同步。
- 多会话切换时无法复原状态。
- 后续做 Session Timeline、Replay、Transcript 时没有统一数据源。

所以 V1 的第一步是建立单向数据流：

```text
RuntimeEvent
  -> ChatAction
  -> chatReducer
  -> ChatState
  -> selectors
  -> UI
```

## 核心类型

```ts
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "complete" | "error";
  createdAt: number;
};

export type ToolActivity = {
  id: string;
  name: string;
  input?: unknown;
  content?: string;
  diff?: string;
  status: "running" | "success" | "error";
  startedAt: number;
  endedAt?: number;
};

export type ChatState = {
  sessionId: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  currentTurn: number | null;
  isRunning: boolean;
  messages: ChatMessage[];
  activities: ToolActivity[];
  context: {
    beforeTokens: number | null;
    afterTokens: number | null;
  };
  error: string | null;
};
```

## Action 设计

`ChatAction` 不等于 `RuntimeEvent`。它是 UI 状态需要的最小变化。

```ts
export type ChatAction =
  | { type: "user_submitted"; text: string; messageId: string; now: number }
  | { type: "session_received"; sessionId: string; transcriptPath: string; cwd: string }
  | { type: "turn_started"; turn: number }
  | { type: "assistant_delta"; text: string; messageId: string; now: number }
  | { type: "tool_started"; id: string; name: string; now: number }
  | { type: "tool_input_received"; id: string; input: unknown }
  | { type: "tool_finished"; id: string; ok: boolean; content: string; diff?: string; now: number }
  | { type: "context_updated"; beforeTokens: number; afterTokens: number }
  | { type: "turn_completed"; turn: number }
  | { type: "run_completed" }
  | { type: "run_failed"; message: string };
```

这里有一个重要设计：`assistant_delta` 带 `messageId`。

原因是 UI 不能靠“最后一条 assistant 消息”来猜测要追加到哪里。后续多分支、重试、并发会话都会让这个假设失效。

## Reducer 实现

```ts
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "user_submitted":
      return {
        ...state,
        isRunning: true,
        error: null,
        messages: [
          ...state.messages,
          {
            id: action.messageId,
            role: "user",
            content: action.text,
            status: "complete",
            createdAt: action.now,
          },
        ],
      };

    case "assistant_delta":
      return appendAssistantDelta(state, action);

    case "tool_started":
      return {
        ...state,
        activities: [
          ...state.activities,
          {
            id: action.id,
            name: action.name,
            status: "running",
            startedAt: action.now,
          },
        ],
      };

    case "tool_input_received":
      return {
        ...state,
        activities: state.activities.map(activity =>
          activity.id === action.id
            ? { ...activity, input: action.input }
            : activity,
        ),
      };

    case "tool_finished":
      return {
        ...state,
        activities: state.activities.map(activity =>
          activity.id === action.id
            ? {
                ...activity,
                status: action.ok ? "success" : "error",
                content: action.content,
                diff: action.diff,
                endedAt: action.now,
              }
            : activity,
        ),
      };

    case "turn_started":
      return { ...state, currentTurn: action.turn, isRunning: true };

    case "context_updated":
      return {
        ...state,
        context: {
          beforeTokens: action.beforeTokens,
          afterTokens: action.afterTokens,
        },
      };

    case "run_completed":
      return {
        ...state,
        isRunning: false,
        messages: state.messages.map(message =>
          message.status === "streaming"
            ? { ...message, status: "complete" }
            : message,
        ),
      };

    case "run_failed":
      return { ...state, isRunning: false, error: action.message };

    default:
      return state;
  }
}
```

## 流式文本追加

```ts
function appendAssistantDelta(
  state: ChatState,
  action: Extract<ChatAction, { type: "assistant_delta" }>,
): ChatState {
  const existing = state.messages.find(message => message.id === action.messageId);

  if (!existing) {
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: action.messageId,
          role: "assistant",
          content: action.text,
          status: "streaming",
          createdAt: action.now,
        },
      ],
    };
  }

  return {
    ...state,
    messages: state.messages.map(message =>
      message.id === action.messageId
        ? { ...message, content: message.content + action.text }
        : message,
    ),
  };
}
```

## RuntimeEvent 到 ChatAction

```ts
export function runtimeEventToChatAction(
  event: RuntimeEvent,
  context: { assistantMessageId: string; now: () => number },
): ChatAction | null {
  switch (event.type) {
    case "session":
      return {
        type: "session_received",
        sessionId: event.info.sessionId,
        transcriptPath: event.info.transcriptPath,
        cwd: event.info.cwd,
      };

    case "turn_start":
      return { type: "turn_started", turn: event.turn };

    case "text_delta":
      return {
        type: "assistant_delta",
        text: event.text,
        messageId: context.assistantMessageId,
        now: context.now(),
      };

    case "tool_start":
      return {
        type: "tool_started",
        id: event.id,
        name: event.name,
        now: context.now(),
      };

    case "tool_input":
      return {
        type: "tool_input_received",
        id: event.id,
        input: event.input,
      };

    case "tool_result":
      return {
        type: "tool_finished",
        id: event.id,
        ok: event.ok,
        content: event.content,
        diff: event.diff,
        now: context.now(),
      };

    case "context_update":
      return {
        type: "context_updated",
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
      };

    case "done":
      return { type: "run_completed" };

    case "error":
      return { type: "run_failed", message: event.message };

    default:
      return null;
  }
}
```

## 调试验证

本章可以不接真实 Runtime，直接用假事件测试 reducer：

```ts
const state = createInitialChatState();
const next = chatReducer(state, {
  type: "assistant_delta",
  messageId: "a1",
  text: "hello",
  now: Date.now(),
});

expect(next.messages[0]?.content).toBe("hello");
expect(next.messages[0]?.status).toBe("streaming");
```

优先验证：

- 第一段 `text_delta` 会创建 assistant 消息。
- 后续 `text_delta` 会追加到同一条消息。
- `tool_start` 会创建 running activity。
- `tool_result` 会更新 activity 状态。
- `done` 会把 streaming message 变成 complete。

## 本章实操标准

### 本章效果

完成本章后，V1 先不追求完整界面，但必须已经有一条可测试的数据链路：

```text
RuntimeEvent
  -> runtimeEventToChatAction()
  -> chatReducer()
  -> ChatState.messages / ChatState.activities
  -> selectors
```

也就是说，后续 UI 不再直接消费 Runtime event，而是只读 `ChatState`。

### 改动文件

本章只改 renderer 的 chat 状态层：

```text
src/renderer/chat/types.ts
src/renderer/chat/chatReducer.ts
src/renderer/chat/runtimeEventToChatAction.ts
src/renderer/chat/selectors.ts
src/renderer/chat/chatReducer.test.ts
```

如果项目已经有 store 文件，也可以同时创建 `src/renderer/chat/chatStore.ts`，但本章的核心验收仍是 reducer 和 event adapter。

### 实现步骤

1. 在 `types.ts` 定义 `ChatMessage`、`ToolActivity`、`ChatState`、`ChatAction`，确保 assistant message 和 tool activity 都有稳定 id。
2. 在 `chatReducer.ts` 实现 `user_submitted`、`assistant_delta`、`tool_started`、`tool_input_received`、`tool_finished`、`turn_started`、`context_updated`、`run_completed`、`run_failed`。
3. 把 `appendAssistantDelta()` 写成按 `messageId` 追加，不要用“最后一条消息”推断。
4. 在 `runtimeEventToChatAction.ts` 把 V0 的 `session`、`turn_start`、`text_delta`、`tool_start`、`tool_input`、`tool_result`、`context_update`、`done`、`error` 映射成 `ChatAction`。
5. 在 `selectors.ts` 暴露 `selectMessages()`、`selectActivities()`、`selectIsRunning()`、`selectChatHeader()`，供后续 UI 使用。
6. 用 reducer 单测覆盖 streaming 追加、tool 状态更新、done 后 streaming message complete。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

本章跑完测试后应该能确认：

- 第一段 `text_delta` 创建一条 assistant streaming message。
- 第二段 `text_delta` 追加到同一个 `messageId`，不会新建第二条 assistant message。
- `tool_start` 后 `activities[0].status` 是 `running`。
- `tool_result ok: true` 后同一条 activity 变成 `success`，并带上 `content`。
- `tool_result ok: false` 后同一条 activity 变成 `error`。
- `done` 后所有 streaming message 变成 `complete`，`isRunning` 变成 `false`。

### 常见报错

- assistant 内容重复：通常是 `assistantMessageId` 每个 delta 都重新生成了，应该在一次 submit/run scope 内固定。
- tool result 找不到 activity：确认 `tool_start` 和 `tool_result` 使用同一个 `event.id`。
- `session_received` 没更新 header 信息：确认 reducer 写入了 `sessionId`、`transcriptPath`、`cwd`。
- `done` 后输入框仍禁用：确认 `run_completed` 和 `run_failed` 都会把 `isRunning` 设为 `false`。
- 单测里 Set/Date 难比较：本章状态使用 number 时间戳，测试里传固定 `now`。

## 可运行验收

本章完成后先跑：

```bash
pnpm test src/renderer/chat/chatReducer.test.ts
pnpm typecheck
```

如果项目暂时没有对应单测路径，至少要在本章新增 reducer 单测。不要等 UI 完成后再靠手动点页面验证状态模型。

## 当前章节缺陷

本章只做状态，不做 UI。它看不到漂亮界面，但这是必要步骤。

如果状态模型不稳，后面的 Markdown、Tool Activity、Session UI 都会建立在脆弱假设上。

## 下一章预告

下一章会把这些状态渲染成 Streaming Message UI，让用户看到 assistant 文本逐步出现。
