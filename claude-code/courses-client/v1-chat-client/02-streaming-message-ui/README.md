# 02 - 流式消息渲染

## 当前章节目标

本章把上一章的 `ChatState.messages` 渲染成基础 Chat UI。

完成后，用户可以看到：

- 自己提交的 prompt。
- assistant 正在逐字追加。
- 当前是否仍在运行。
- 运行失败时的错误提示。

## 为什么流式渲染重要

AI Coding Agent 的任务通常比普通聊天更长。用户不能等几十秒才看到结果。

流式渲染带来三个产品价值：

- 让用户确认 Agent 已经开始工作。
- 让用户提前发现模型是否理解错方向。
- 为后续 Stop / Interrupt 提供交互基础。

## 组件结构

```text
ChatScreen
  -> ChatTimeline
    -> MessageBubble
      -> MarkdownView
  -> PromptComposer
```

V1 不做复杂布局。先让信息稳定、可读、可扩展。

## ChatScreen

```tsx
type ChatScreenProps = {
  state: ChatState;
  onSubmit(text: string): void;
};

export function ChatScreen({ state, onSubmit }: ChatScreenProps) {
  return (
    <main className="chat-screen">
      <header className="chat-header">
        <div>
          <strong>Claude Code Client</strong>
          {state.cwd ? <span>{state.cwd}</span> : null}
        </div>
        {state.currentTurn ? <span>Turn {state.currentTurn}</span> : null}
      </header>

      <ChatTimeline messages={state.messages} isRunning={state.isRunning} />

      {state.error ? <div className="chat-error">{state.error}</div> : null}

      <PromptComposer disabled={state.isRunning} onSubmit={onSubmit} />
    </main>
  );
}
```

## ChatTimeline

```tsx
type ChatTimelineProps = {
  messages: ChatMessage[];
  isRunning: boolean;
};

export function ChatTimeline({ messages, isRunning }: ChatTimelineProps) {
  return (
    <section className="chat-timeline" aria-live="polite">
      {messages.map(message => (
        <MessageBubble key={message.id} message={message} />
      ))}
      {isRunning ? <div className="typing-indicator">Agent is working</div> : null}
    </section>
  );
}
```

`aria-live="polite"` 是一个小细节。它让辅助技术能感知流式内容变化，但不会像 `assertive` 一样打断用户。

## MessageBubble

```tsx
type MessageBubbleProps = {
  message: ChatMessage;
};

export function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <article className={`message-bubble message-bubble-${message.role}`}>
      <div className="message-role">
        {message.role === "user" ? "You" : "Agent"}
        {message.status === "streaming" ? <span>Streaming</span> : null}
      </div>
      <MarkdownView content={message.content} />
    </article>
  );
}
```

## PromptComposer

```tsx
type PromptComposerProps = {
  disabled: boolean;
  onSubmit(text: string): void;
};

export function PromptComposer({ disabled, onSubmit }: PromptComposerProps) {
  const [text, setText] = useState("");

  function submit() {
    const value = text.trim();
    if (!value || disabled) return;

    onSubmit(value);
    setText("");
  }

  return (
    <form
      className="prompt-composer"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        value={text}
        disabled={disabled}
        placeholder="Ask the agent to inspect, explain, or change code"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            submit();
          }
        }}
      />
      <button type="submit" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}
```

## 连接 Runtime

```ts
async function submitPrompt(text: string) {
  const assistantMessageId = crypto.randomUUID();

  dispatch({
    type: "user_submitted",
    text,
    messageId: crypto.randomUUID(),
    now: Date.now(),
  });

  for await (const event of runtime.send({ text })) {
    const action = runtimeEventToChatAction(event, {
      assistantMessageId,
      now: Date.now,
    });

    if (action) {
      dispatch(action);
    }
  }
}
```

这里先使用单次提交对应一个 `assistantMessageId`。后续如果支持 retry、branch、parallel run，可以把 `assistantMessageId` 提升为 run scope 的一部分。

## 样式原则

V1 的 UI 应该克制：

- 信息密度高，但不拥挤。
- 不做营销式 hero。
- 不使用夸张渐变和装饰背景。
- Prompt 输入区稳定贴底。
- 消息宽度适中，代码块可横向滚动。

示例 CSS：

```css
.chat-screen {
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  height: 100vh;
  background: #111111;
  color: #f4f1ed;
}

.chat-header {
  display: flex;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #2f2a25;
}

.chat-timeline {
  overflow: auto;
  padding: 20px 24px;
}

.message-bubble {
  max-width: 860px;
  margin: 0 auto 16px;
  line-height: 1.6;
}

.message-bubble-user {
  color: #f8e7dc;
}

.message-bubble-assistant {
  color: #f4f1ed;
}

.prompt-composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #2f2a25;
}
```

## 调试验证

手动验证：

- 输入一条短 prompt，用户消息立即出现。
- assistant 文本不是一次性出现，而是随着事件追加。
- 运行中输入框被禁用，避免并发提交。
- `done` 后输入框恢复。
- `error` 后错误信息可见，输入框恢复。

## 本章实操标准

### 本章效果

完成本章后，上一章的 `ChatState.messages` 必须接到真实页面：

```text
chatStore
  -> selectors
  -> ChatScreen
  -> ChatTimeline
  -> MessageBubble
  -> PromptComposer
  -> runtime.send()
```

用户提交 prompt 后，不需要刷新页面就能看到自己的消息和 assistant streaming 气泡。

### 改动文件

本章改动集中在 renderer chat store 和 UI：

```text
src/renderer/chat/chatStore.ts
src/renderer/chat/selectors.ts
src/renderer/components/ChatScreen.tsx
src/renderer/components/ChatTimeline.tsx
src/renderer/components/MessageBubble.tsx
src/renderer/components/PromptComposer.tsx
```

如果 V0 已经有 Runtime bridge，本章只调用既有 `runtime.send({ text })`，不要新增第二套 Runtime API。

### 实现步骤

1. 在 `chatStore.ts` 用 `useReducer`、Zustand 或项目现有 store 包装 `chatReducer`，暴露 `dispatch` 和 selectors。
2. 在 `ChatScreen.tsx` 读取 `selectMessages()`、`selectIsRunning()`、`selectChatHeader()`，把 `cwd`、`currentTurn`、`error` 显示出来。
3. 在 `PromptComposer.tsx` 实现提交：先 dispatch `user_submitted`，再为本轮创建一个固定 `assistantMessageId`。
4. 在提交函数里遍历 `runtime.send({ text })` 的 async iterator，把每个 Runtime event 交给 `runtimeEventToChatAction()`，再 dispatch action。
5. 在 `ChatTimeline.tsx` 用 `aria-live="polite"` 渲染 messages，并在 `isRunning` 时展示 `Agent is working`。
6. 在 `MessageBubble.tsx` 渲染 role、status 和最小 `MarkdownView`；Markdown 的完整能力留到下一章。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 `pnpm dev` 后手动验证：

- 页面顶部显示 `Claude Code Client`，如果收到 session event，旁边能看到当前 `cwd`。
- 输入 `用一句话解释这个项目` 并提交，用户消息立即出现。
- assistant 回答不是一次性出现，而是随着 `text_delta` 逐段增长。
- streaming 期间输入框和 Send 按钮禁用，timeline 底部显示 `Agent is working`。
- Runtime 返回 `done` 后 streaming 标记消失，输入框恢复可提交。
- Runtime 返回 `error` 后错误信息显示在输入框上方，并允许用户再次提交。

### 常见报错

- UI 没有实时刷新：确认组件订阅的是 store state，而不是 submit 前闭包里的旧 state。
- assistant 每个 delta 都变成新气泡：确认一次提交只创建一个 `assistantMessageId`。
- 输入框一直禁用：确认 `done`、`error` 两类 Runtime event 都会 dispatch 到 reducer。
- 点击 Send 后页面跳转或刷新：确认 form submit 里调用了 `event.preventDefault()`。
- 运行中还能重复提交：确认 `PromptComposer` 的 `disabled` 来自 `selectIsRunning()`。

## 可运行验收

本章完成后执行：

```bash
pnpm dev
pnpm typecheck
```

本章不要求 Tool Activity 可见，但要求 streaming chat 已经从真实 Runtime event 进入 UI。

## 当前章节缺陷

本章没有做自动滚动策略、虚拟列表和中断按钮。

这些不是忘了，而是避免 V1 过早复杂化。长会话性能和中断控制会在后续版本完善。

## 下一章预告

下一章会实现 Markdown 与 Code Block，让 assistant 输出具备可读的代码展示能力。
