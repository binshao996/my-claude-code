# React Ink 终端交互架构实战

Claude Code 类产品的终端 UI 不是“把文本打印漂亮一点”。它是一个长期运行的交互系统：模型在流式输出，工具在后台执行，权限请求可能随时插入，用户可以中断、恢复、查看 diff、批准 plan、切换会话。

如果没有稳定的 UI 架构，Agent 能力越多，终端体验越容易崩。

这份文档总结 React Ink 交互界面的工程经验，重点不是组件样式，而是状态、焦点、键盘、弹窗、流式渲染、错误兜底和安全信息如何组织。

## 1. 先把 Agent 跑通，再上 Ink

不要在第一个版本就做复杂 Ink UI。

正确顺序是：

```text
CLI skeleton
-> LLM request
-> chat loop
-> streaming
-> tool calling
-> agent loop
-> permission / diff / plan
-> transcript / resume
-> React Ink terminal UI
```

原因很简单：Ink 会引入另一套复杂度：

- React state 更新不是同步可读的。
- stdin 可能被 PromptInput、Permission Dialog、Diff Dialog 同时争用。
- streaming 输出会频繁触发 render。
- stderr 输出可能打乱布局。
- modal、overlay、sticky footer 都需要焦点所有权。

如果 Agent Loop 还没稳定，就上 Ink，调试时会分不清是模型链路错、工具链路错，还是 UI 状态错。

### 错误做法

```text
第一章就搭 React Ink App，把所有聊天、工具、权限、diff 都放进一个 App.tsx。
```

### 正确做法

```text
先用 readline/TTY 文本版跑通协议。
等核心链路稳定后，再把 UI 变成这些模块的投影视图。
```

### 实战经验

前期 CLI 文本版不是临时垃圾代码。它是 Agent 主链路的最小可调试形态。Ink UI 应该消费同一套状态和事件，而不是重写一套执行逻辑。

## 2. UI 组件只消费 ViewModel

React Ink 组件里不要拼业务判断。

终端 UI 应该分三层：

```text
Agent / Tool / Plugin / Policy Event
-> TerminalExperienceState
-> ViewModel Builders
-> Ink Components
```

Ink 组件只负责渲染：

- 传入什么行，就显示什么行。
- 传入什么 action，就显示什么按钮。
- 传入什么 severity，就选择颜色。
- 传入什么 selectedIndex，就高亮哪一项。

不要让组件自己判断“这个 Bash 命令是否危险”“这个插件是否可信”“这个 plan 是否需要 sticky footer”。

### 错误示例

```tsx
function PermissionDialog({ toolName, input }) {
  const dangerous = toolName === "Bash" && input.command.includes("rm -rf");
  const title = dangerous ? "Dangerous command" : "Allow tool?";
  // ...
}
```

### 正确示例

```tsx
type PermissionViewModel = {
  title: string;
  summaryLines: string[];
  riskLines: Array<{ severity: "info" | "warning" | "danger"; text: string }>;
  actions: Array<{ id: string; label: string; dangerous?: boolean }>;
};

function PermissionDialog({ viewModel }: { viewModel: PermissionViewModel }) {
  return (
    <Box flexDirection="column">
      <Text bold>{viewModel.title}</Text>
      {viewModel.summaryLines.map(line => <Text key={line}>{line}</Text>)}
      {viewModel.riskLines.map(line => (
        <Text key={line.text} color={colorForSeverity(line.severity)}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
```

### 为什么正确

ViewModel 可以单元测试。组件逻辑很薄，不需要为了风险判断去 mount Ink。

## 3. TerminalExperienceState 要统一

Claude Code 类 UI 同时有很多 surface：

```text
main messages
prompt input
status line
permission dialog
diff dialog
plan approval
plugin consent
integrity failure
interrupt feedback
background task notice
toast
sticky footer
```

如果每个功能自己管理显示状态，最终会出现：

- 权限弹窗盖住 diff。
- Plan 太长，把确认按钮挤出屏幕。
- PromptInput 还在接收输入，但 modal 也在接收快捷键。
- 插件完整性失败时，仍然显示普通 allow/deny。
- 用户按 Esc，不知道关闭的是 dialog、取消的是请求，还是退出的是输入模式。

### 推荐状态模型

```ts
type ExperienceSurface =
  | "main"
  | "status"
  | "permission"
  | "diff"
  | "plan"
  | "plugin-consent"
  | "integrity-failure"
  | "interrupt"
  | "background-task";

type TerminalExperienceState = {
  activeSurfaces: ExperienceSurface[];
  modal?: ExperienceSurface;
  stickyFooter?: React.ReactNode;
  promptInputMode: PromptInputMode;
  status: StatusLineViewModel;
};
```

### 优先级规则

```text
integrity-failure > permission > plugin-consent > plan > diff > interrupt > status > main
```

完整性失败比普通权限高，因为扩展内容已经不可信。此时不能继续问“是否允许这个插件工具运行”，必须先处理供应链风险。

## 4. PromptInput 是一个状态机

PromptInput 不是一个普通输入框。它至少有这些模式：

```text
normal input
slash command
file mention
agent mention
multiline
history search
completion picker
modal suspended
```

每个模式都拥有不同键盘语义。

### 错误做法

```text
所有 keypress 都在一个 onKeyPress 里 if/else。
```

这种做法一开始快，后面一定崩。因为 Esc、Enter、Tab、Ctrl+C、方向键在不同模式下含义完全不同。

### 正确做法

把输入模式建成显式状态机：

```ts
type PromptInputMode =
  | { type: "normal" }
  | { type: "slash"; query: string; selectedIndex: number }
  | { type: "file"; query: string; selectedIndex: number }
  | { type: "history"; query: string; selectedIndex: number }
  | { type: "suspended"; reason: "modal" | "permission" };
```

然后定义每种模式的 key map：

```text
normal:
  Enter submit
  Shift+Enter newline
  / enter slash mode
  Esc cancel current request

slash:
  Enter accept command
  Esc back to normal
  Up/Down move selection

modal suspended:
  PromptInput ignores text input
```

### 实战经验

PromptInput 必须知道自己什么时候不拥有焦点。权限弹窗、DiffDialog、PlanApproval 打开时，PromptInput 不应该继续消费普通输入。

## 5. 键盘焦点必须有所有权

终端里没有浏览器 DOM focus 那套机制。你必须自己定义焦点所有权。

推荐模型：

```text
active owner:
  prompt-input
  permission-dialog
  diff-dialog
  plan-dialog
  session-picker
  interrupt-confirm
```

每个 key event 只能被一个 owner 消费。

### Esc 优先级

Esc 是最容易混乱的键。建议规则：

```text
1. 如果当前有 modal，Esc 先交给 modal。
2. 如果 PromptInput 在 completion/search 模式，Esc 退出该模式。
3. 如果有 running request，Esc 取消当前请求或 pop queue。
4. 如果都没有，Esc 不做危险操作。
```

第 64 章里提到的重点就是：DiffDialog 拥有 diff navigation，PromptInput 模式退出拥有 Escape 的优先权。这个优先权必须明确写进焦点系统，不要靠组件渲染顺序碰运气。

## 6. Permission Dialog 的核心是风险摘要

权限弹窗不是“Allow / Deny 两个按钮”。

用户真正需要判断的是：

- 这个工具要做什么。
- 会读哪些文件。
- 会写哪些文件。
- 会运行什么命令。
- 是否影响网络、密钥、权限、供应链。
- 允许一次，还是写入规则。

### 推荐 ViewModel

```ts
type PermissionAction = {
  id: string;
  label: string;
  kind: "allow-once" | "allow-rule" | "deny" | "edit";
  dangerous?: boolean;
};

type PermissionViewModel = {
  title: string;
  toolName: string;
  summaryLines: string[];
  riskLines: Array<{ severity: "info" | "warning" | "danger"; text: string }>;
  actions: PermissionAction[];
};
```

### 错误做法

```text
Allow Bash command?
> npm test
```

### 正确做法

```text
Allow Bash command?

Command:
  npm test

Risk:
  Runs project test script.
  No file write detected.

Actions:
  Allow once
  Allow npm test in this project
  Deny
```

### 实战经验

权限 UI 不要展示完整巨型 JSON。给用户的是风险摘要，完整输入应该进入 debug/detail 或 transcript 引用。

## 7. Diff Dialog 要支持 list/detail 两层

Diff 是 Coding Agent 里最重要的 UI 之一。

只打印完整 diff 有几个问题：

- 大文件 diff 会淹没重点。
- 用户无法快速知道改了哪些文件。
- 窄终端换行后很难读。
- 当前 turn diff 和全局 diff 容易混。

推荐两层：

```text
list mode:
  files changed
  added/deleted lines
  risk hints

detail mode:
  selected file hunks
  current hunk navigation
  accept/reject/open actions
```

### ViewModel 原则

Diff parser 输出结构化 hunk，Ink 组件只负责渲染：

```ts
type DiffFileViewModel = {
  path: string;
  added: number;
  deleted: number;
  hunks: DiffHunkViewModel[];
  selected?: boolean;
};
```

### 实战经验

不要在 Ink 组件里解析 patch。解析和风险标注放在 view model 层。组件只处理选中行、滚动窗口和颜色。

## 8. Plan View 必须有 Sticky Footer

Plan 往往很长。如果确认选项跟着内容滚动，用户会陷入两个问题：

- 看不到当前可选动作。
- 为了确认必须滚到底部。

官方级体验应该是：

```text
plan body scrolls
decision actions stay visible
```

也就是 sticky footer：

```text
[Plan content... scrollable]

────────────────────────
Approve  Edit  Reject
```

### 实战经验

Plan approval 是安全交互，不是普通 Markdown 展示。确认动作必须稳定可见。

## 9. StatusLine 要克制

状态栏不能变成信息垃圾场。

建议只显示：

```text
model
context usage
rate limit
cost
cache
permission mode
remote/worktree
background tasks
```

并按终端宽度降级：

```text
窄终端：model + context
中等终端：rate limit + cost
宽终端：cache + remote + worktree + background
```

### 错误做法

```text
把所有 session id、token、cost、cache、rate limit、branch、cwd、provider、debug mode 全都显示。
```

### 正确做法

```text
只显示当前决策有用的信息。
详细信息放 /status、/context、/debug。
```

### 实战经验

状态栏是扫读工具，不是 debug 面板。危险信息用颜色和短标签，不用长句。

## 10. Streaming 渲染要节流

模型 streaming token 如果每个 token 都触发复杂 React render，终端会抖，CPU 会升，布局也容易乱。

推荐策略：

- 文本流可以 buffer 后批量刷新。
- tool_use block 开始和结束时更新结构状态。
- thinking/redacted thinking 不直接展示，但必须保存和回传。
- transcript 不要每个 token 写一行，只在完整 assistant message 完成后写。
- 大工具输出不要进入 UI 主消息流，显示摘要和展开入口。

### 错误做法

```text
每个 token:
  setMessages([...messages, token])
  append transcript line
  rerender whole App
```

### 正确做法

```text
stream buffer:
  collect deltas
  update visible text at interval
  finalize message once stop event arrives
  write transcript once
```

### 实战经验

Streaming UI 要区分“用户需要实时看到的内容”和“协议必须保存的内容”。Thinking block 属于协议状态，不应该被拼进普通文本。

## 11. stderr 会破坏 Ink 布局

Ink 接管终端后，随意写 stderr/stdout 会打乱布局。

规则：

```text
普通错误 -> UI state
可恢复工具错误 -> message/tool_result
debug 信息 -> debug log
审计事件 -> audit/transcript
React render 崩溃 -> stderr + error boundary fallback
```

第 68 章提到的原则很关键：React/Ink 层崩了，用户不能只看到空白终端。但 Error Boundary 写 stderr 是合理的，因为这时 UI 层本身已经不可信。

### Error Boundary 要做什么

```text
1. 不吞掉错误。
2. 不泄露敏感内容。
3. 给用户可理解的 fallback。
4. 把 boundary name 写入日志。
5. 把 component stack 作为诊断线索。
```

## 12. Session Picker / Rewind 是只读交互

第 47 章的 Session Picker 和 Rewind UI 有一个重要经验：preview 不是 resume。

用户只是查看历史时，不应该：

- 改当前 session id。
- 恢复 file history。
- 写 transcript entry。
- 触发权限请求。
- 复用正在运行的工具状态。

### 正确边界

```text
SessionPicker:
  search logs
  preview transcript
  select session

Resume:
  load selected session
  restore message chain
  restore file history if needed
  write resume event
```

### 实战经验

历史浏览 UI 必须只读。否则用户按几次上下键看历史，就可能改变当前运行会话，这是很严重的体验 bug。

## 13. Background Task UI 要显示生命周期

后台任务不是一条日志。

至少要显示：

```text
task id
status: running/completed/failed/killed
started time
last output summary
how to attach/read/kill
```

如果后台 Agent 需要权限，不能随便弹窗抢前台焦点。更稳的策略是：

- 后台 Agent 默认只用预授权工具。
- 需要权限时进入 pending approval queue。
- 前台状态栏提示有待处理审批。
- 用户显式打开审批队列后处理。

## 14. 常见反模式

### 反模式 1：所有 UI 状态都塞进 React state

问题：业务状态和渲染状态混在一起，恢复、调试、测试都困难。

修法：业务状态进 store/transcript/event，React state 只保留局部 UI 状态，如 selectedIndex、scrollOffset。

### 反模式 2：组件里做权限风险判断

问题：风险逻辑无法单测，多个弹窗逻辑不一致。

修法：统一 PermissionViewModel。

### 反模式 3：Dialog 自己抢键盘

问题：Esc/Enter/Tab 行为不可预测。

修法：建立 focus owner 和 key routing。

### 反模式 4：把 StatusLine 当 debug 面板

问题：用户扫不出重点，窄终端布局崩。

修法：状态栏只放短、高价值、当前决策相关的信息。

### 反模式 5：每个 token 都写 transcript

问题：IO 爆炸，resume 时有半条消息，fallback 后难恢复。

修法：完整 assistant message 完成后再写 transcript。

### 反模式 6：Preview 改变会话状态

问题：用户只是查看历史，却影响当前任务。

修法：preview 只读，resume 才改变状态。

## 15. 最小验收清单

做 React Ink 终端 UI 时，至少检查：

- PromptInput 和 modal 不会同时消费键盘。
- Esc 的优先级明确。
- Permission Dialog 展示风险摘要，而不是原始 JSON。
- Diff 支持文件列表和详情视图。
- Plan approval 有 sticky footer。
- StatusLine 在窄终端不溢出。
- Streaming 渲染不会每 token 写 transcript。
- Error Boundary 有 fallback，不泄露敏感信息。
- stderr 不会打乱普通 UI。
- Session preview 不改变当前 session。
- ViewModel builder 有单元测试。

如果这些点没做到，Ink UI 越复杂，越容易拖垮 Agent 体验。
