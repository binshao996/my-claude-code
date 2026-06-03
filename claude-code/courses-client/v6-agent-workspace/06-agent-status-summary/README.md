# 06 - Agent Status Summary

## 当前章节目标

本章实现 Agent Status Summary。

它回答用户最常问的问题：

```text
Agent 现在在干什么？
```

## Summary 类型

```ts
export type AgentStatusSummary = {
  status: AgentRunStatus;
  currentTurn: number | null;
  runningToolCount: number;
  completedToolCount: number;
  failedToolCount: number;
  pendingPermissionCount: number;
  planProgress: {
    completed: number;
    total: number;
  } | null;
};
```

## Selector

```ts
export function selectAgentStatusSummary(
  state: AgentWorkspaceState,
): AgentStatusSummary {
  return {
    status: state.status,
    currentTurn: getLatestTurn(state.events),
    runningToolCount: state.tools.filter(tool => tool.status === "running").length,
    completedToolCount: state.tools.filter(tool => tool.status === "success").length,
    failedToolCount: state.tools.filter(tool => tool.status === "error").length,
    pendingPermissionCount: state.permissions.filter(
      request => request.status === "pending",
    ).length,
    planProgress: state.plan?.progress ?? null,
  };
}
```

## UI

```tsx
export function AgentStatusSummaryView({
  summary,
}: {
  summary: AgentStatusSummary;
}) {
  return (
    <section className="agent-status-summary">
      <strong>{renderStatusText(summary.status)}</strong>
      {summary.currentTurn ? <span>Turn {summary.currentTurn}</span> : null}
      <span>{summary.runningToolCount} running</span>
      <span>{summary.completedToolCount} completed</span>
      {summary.failedToolCount > 0 ? <span>{summary.failedToolCount} failed</span> : null}
      {summary.pendingPermissionCount > 0 ? (
        <span>{summary.pendingPermissionCount} permission pending</span>
      ) : null}
    </section>
  );
}
```

## 产品设计

Status Summary 应该保持短小。它不是日志，不是 timeline，只是状态摘要。

推荐放在 Agent Workspace 顶部：

```text
Status Summary
Plan View
Tool Timeline
Runtime Timeline
Permission Queue
```

## 本章实操：顶部 StatusSummary 汇总所有面板

### 专属改动文件

```text
src/renderer/agent-workspace/types.ts
src/renderer/agent-workspace/selectors.ts
src/renderer/agent-workspace/agentWorkspaceStore.ts
src/renderer/agent-workspace/fakeRuntimeEvents.ts
src/renderer/components/AgentStatusSummary.tsx
src/renderer/components/AgentWorkspacePanel.tsx
```

### 实现步骤

1. 在 `selectors.ts` 实现 `selectAgentStatusSummary(state)`，从同一份 store 汇总 tools、permissions、plan 和 timeline。
2. `getLatestTurn(events)` 从 RuntimeTimeline 中找最新 `turn_start`，不要在 summary 里另存一份重复状态。
3. reducer 在以下事件中更新 `state.status`：turn start -> `thinking`，tool start -> `acting`，permission pending -> `waiting_permission`，done -> `done`，error -> `error`。
4. `AgentStatusSummaryView` 放在 `AgentWorkspacePanel` 顶部，展示短文本和数字，不渲染长日志。
5. fake events 覆盖完整状态流：idle -> thinking -> acting -> waiting_permission -> acting -> done，以及 error 分支。
6. 给 selector 写单测，确保 running、completed、failed、pending permission 和 plan progress 数字正确。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，Replay fake events 时顶部 summary 会实时变化：`Thinking`、`Acting`、`1 permission pending`、`2 completed`、最终 `Done`。触发 fake error 时 summary 显示 error，Tool Timeline 中失败数量同步增加。

### 常见报错

- Summary 数字和 Timeline 不一致：只从 `state.tools`、`state.permissions`、`state.plan` 计算，不手写第二份计数。
- done 后还有 running tool：Runtime 顺序可能异常，summary 可以显示 done 但 runningToolCount 不为 0，用测试暴露该状态。
- pending permission resolved 后状态仍 waiting：reducer 需要在所有 pending 清空后恢复 `acting` 或 `done`。

## 可运行验收

本章验收：

- Summary 能从 fake event 流显示完整状态变化。
- tool、permission、plan 数字来自 selector。
- error 分支可见。
- `pnpm typecheck` 和 selector 测试通过。

## 当前章节缺陷

V6 的 Summary 不包含 token 成本、模型信息、耗时统计和失败分类。

## 下一版本预告

V7 会实现 Diff & Patch。

Agent Workspace 已经能看到工具产生了 diff，但用户还不能审查和控制这些修改。V7 会实现：

```text
Diff Viewer
  -> hunks
  -> accept / reject
  -> editor refresh
  -> patch audit
```

这会把 Agent 的“修改代码”能力变成可审查、可控制的产品体验。
