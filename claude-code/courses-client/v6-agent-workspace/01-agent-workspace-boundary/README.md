# 01 - Agent Workspace 边界

## 当前章节目标

本章定义 Agent Workspace 的产品边界。

结论：

```text
Agent Workspace 是观察层和轻量控制层，不是新的 Runtime。
```

## 为什么需要 Agent Workspace

V1 中 Tool Activity 只是 Chat 附属组件。随着功能增加，Chat 会变得拥挤：

- Plan 更新。
- Tool start / result。
- Command result。
- Context update。
- Permission prompt。
- Error。

这些信息都重要，但不应该全部塞进对话气泡。

Agent Workspace 的作用是：

```text
让用户看到 Agent 正在如何工作
```

## 输入来源

```ts
export type AgentWorkspaceInput =
  | RuntimeEvent
  | PlanChangedEvent
  | PermissionRequestedEvent
  | CommandObservedEvent;
```

## 状态模型

```ts
export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "acting"
  | "waiting_permission"
  | "done"
  | "error";

export type AgentWorkspaceState = {
  runId: string | null;
  status: AgentRunStatus;
  plan: AgentPlanView | null;
  tools: AgentToolCall[];
  events: AgentTimelineEvent[];
  permissions: PermissionRequestView[];
  error: string | null;
};
```

## 核心原则

### 不直接执行工具

Agent Workspace 可以展示按钮：

```text
Approve
Deny
Open diff
Open file
```

但它不能直接执行工具。工具仍由 Runtime 控制。

### 不替代 Chat

Agent Workspace 不展示完整 assistant 文本，不承担对话功能。

### 不吞掉审计信息

Agent Workspace 可以压缩显示，但原始事件仍应保留在 transcript 或 event log 中。

## 本章实操：RuntimeEvent -> AgentWorkspaceAction

本章先做观察层骨架和事件转换入口。完成后，读者可以用假事件让 Agent Workspace 面板状态变化。

### 专属改动文件

```text
src/renderer/agent-workspace/types.ts
src/renderer/agent-workspace/agentWorkspaceStore.ts
src/renderer/agent-workspace/runtimeEventToAgentAction.ts
src/renderer/agent-workspace/fakeRuntimeEvents.ts
src/renderer/components/AgentWorkspacePanel.tsx
src/renderer/components/AgentStatusSummary.tsx
```

### 实现步骤

1. 在 `types.ts` 定义 `AgentWorkspaceState`、`AgentWorkspaceAction`、`AgentRunStatus` 和各 view model 的最小类型。
2. 在 `runtimeEventToAgentAction.ts` 写转换函数：`turn_start` -> `run_started`，`done` -> `run_done`，`error` -> `run_failed`，未知事件先返回 `null`。
3. 在 `agentWorkspaceStore.ts` 写 reducer 初版，只处理 `run_started`、`run_done`、`run_failed`、`reset`。
4. 新增 `fakeRuntimeEvents.ts`，导出一组最小事件：turn start、context update、tool start、tool result、done。
5. `AgentWorkspacePanel` 渲染 Status Summary 和一个开发按钮 `Replay fake events`；按钮逐个 dispatch fake event 转换后的 action。
6. 把 Agent Workspace panel 接入主布局，位置建议在 Chat 旁边或下方，不覆盖 Editor/Terminal。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，Agent Workspace 面板出现；点击 `Replay fake events`，顶部状态从 `idle` 变为 `thinking`，最终变为 `done`。这证明 V6 已经接入 RuntimeEvent 观察链路。

### 常见报错

- 面板状态不变：确认 fake event 先经过 `runtimeEventToAgentAction`，再 dispatch reducer。
- reducer 里直接执行工具：删除该逻辑，Agent Workspace 只能观察和回传权限结果。
- Chat 文本被搬到 Workspace：本章不处理 assistant message，只处理 Runtime event。

## 可运行验收

本章验收：

- fake `turn_start` 能让 status 变 `thinking`。
- fake `done` 能让 status 变 `done`。
- fake `error` 能显示错误状态。
- reducer 没有工具执行、副作用和 IPC 调用。
- `pnpm typecheck` 通过。

## 当前章节缺陷

本章只定义边界和状态，不实现具体 UI。

## 下一章预告

下一章会实现 Plan View：把 Runtime 中的 `Plan` 渲染成清晰的任务进度。
