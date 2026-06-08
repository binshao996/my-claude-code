# 01 - Session 边界

## 当前章节目标

本章定义 Session 的产品边界。

结论：

```text
Session 是项目级运行历史，不只是 Chat history。
```

## Session 包含什么

一个 AI Coding Agent session 至少包含：

- metadata。
- messages。
- plan。
- tool timeline。
- context updates。
- permission decisions。
- diff decisions。

Runtime 当前 transcript 已经包含：

```text
metadata
message
plan
```

Client 可以在此基础上扩展 UI history。

## Session 不是什么

Session 不应该包含：

- 当前窗口布局。
- 未保存 editor buffer。
- terminal 正在运行的进程。
- 临时 hover / selection 状态。

这些是 UI state 或 process state，不是可稳定 resume 的会话历史。

## 新建、Resume、Continue

| 动作 | 含义 |
| --- | --- |
| New | 创建全新 session |
| Resume | 恢复指定 session |
| Continue | 恢复当前项目最新 session |

这个语义和当前 CLI 的 `--resume` / `--continue` 对齐。

## 本章交付

本章交付 Session 的产品边界、入口动作和一个 fake list preview。完整列表在 03 章展开，但本章写完后已经能在 UI 看到 Session Header 和三个动作入口。

Client 必须把三个动作拆开：

- `New Session`：创建当前 workspace 的全新 Runtime session。
- `Resume Session`：按用户选择的 session id 恢复。
- `Continue Latest`：只恢复当前 workspace 最新 session。

边界状态要能展示在 Session Header：

```text
workspace name
session id
mode: new | resumed | continued
recoverable: messages / plan / tool timeline / diff decisions
not recoverable: terminal process / dirty editor buffer
```

## Feature PR Skeleton

本章写完后，UI 至少新增 `SessionHeader` 和三种入口动作。这里先用 fake event 证明边界，而不是接真实 SessionStore：

```ts
export type SessionMode = "new" | "resumed" | "continued";

export type SessionBoundaryView = {
  workspaceName: string;
  sessionId: string;
  mode: SessionMode;
  recoverable: Array<"messages" | "plan" | "tool timeline" | "diff decisions">;
  notRecoverable: Array<"terminal process" | "dirty editor buffer">;
};

export const fakeSessionBoundary: SessionBoundaryView = {
  workspaceName: "claude-code-client",
  sessionId: "sess_v8_boundary",
  mode: "new",
  recoverable: ["messages", "plan", "tool timeline", "diff decisions"],
  notRecoverable: ["terminal process", "dirty editor buffer"],
};
```

```tsx
export function SessionHeader({ boundary }: { boundary: SessionBoundaryView }) {
  return (
    <header className="session-header">
      <strong>{boundary.workspaceName}</strong>
      <span>{boundary.mode}</span>
      <code>{boundary.sessionId}</code>
      <p>Recoverable: {boundary.recoverable.join(", ")}</p>
      <p>Not restored: {boundary.notRecoverable.join(", ")}</p>
    </header>
  );
}
```

入口动作先通过 fake action event 驱动 Header：

```ts
export type SessionActionEvent =
  | { type: "session:new_clicked"; workspaceId: string }
  | { type: "session:resume_clicked"; workspaceId: string; sessionId: string }
  | { type: "session:continue_clicked"; workspaceId: string };

export const fakeBoundaryEvents: SessionActionEvent[] = [
  { type: "session:new_clicked", workspaceId: "workspace-client" },
  {
    type: "session:resume_clicked",
    workspaceId: "workspace-client",
    sessionId: "sess_v8_boundary",
  },
  { type: "session:continue_clicked", workspaceId: "workspace-client" },
];
```

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

启动后应该看到：

- Session Header 显示当前 workspace 和 session mode。
- Header 中显示 `Recoverable` 和 `Not restored` 两行。
- 点击 New 后生成新的 session id。
- Resume 和 Continue 是两个不同入口，文案不混用。
- UI 明确提示 terminal process 和未保存 editor buffer 不会被恢复。
- 任意 session action 都不能直接接受 renderer 传入的裸 `cwd`。

## 当前章节缺陷

本章只定义边界，不实现数据模型。

## 下一章预告

下一章会定义 Session 数据模型：metadata、messages、plan、timeline、diff decisions。
