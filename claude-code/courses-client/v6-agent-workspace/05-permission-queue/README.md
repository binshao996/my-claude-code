# 05 - Permission Queue

## 当前章节目标

本章实现 Permission Queue。

Runtime 的工具权限仍由 ToolRunner 和 Permission 模块控制。Agent Workspace 只是提供 UI：

```text
Runtime asks
  -> Permission Queue displays
  -> User approves or denies
  -> Result returns to Runtime
```

## PermissionRequestView

```ts
export type PermissionRequestView = {
  id: string;
  toolName: string;
  message: string;
  approvalKey: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  resolvedAt: number | null;
};
```

## PermissionQueue

```tsx
export function PermissionQueue({
  requests,
  onApprove,
  onDeny,
}: {
  requests: PermissionRequestView[];
  onApprove(id: string): void;
  onDeny(id: string): void;
}) {
  const pending = requests.filter(request => request.status === "pending");

  if (pending.length === 0) return null;

  return (
    <section className="permission-queue">
      <h2>Permission Required</h2>
      {pending.map(request => (
        <article key={request.id}>
          <strong>{request.toolName}</strong>
          <p>{request.message}</p>
          <button type="button" onClick={() => onApprove(request.id)}>
            Approve
          </button>
          <button type="button" onClick={() => onDeny(request.id)}>
            Deny
          </button>
        </article>
      ))}
    </section>
  );
}
```

## 与 Runtime 的桥

V0 中 `askUser` 是接口。V6 可以把它接到 UI：

```ts
askUser: async message => {
  return permissionBridge.request({
    toolName,
    message,
    approvalKey,
  });
}
```

返回值仍然由 Runtime 解释，比如：

```text
y
a
n
```

不要让 UI 直接修改 PermissionStore。PermissionStore 仍属于 Runtime。

## 本章实操：PermissionQueue 回传 Runtime

本章唯一允许的控制动作是把用户审批结果回传 Runtime permission bridge；它仍不直接执行工具。

### 专属改动文件

```text
src/renderer/agent-workspace/types.ts
src/renderer/agent-workspace/permissionBridge.ts
src/renderer/agent-workspace/runtimeEventToAgentAction.ts
src/renderer/agent-workspace/agentWorkspaceStore.ts
src/renderer/agent-workspace/fakeRuntimeEvents.ts
src/renderer/components/PermissionQueue.tsx
src/runtime/permissionBridge.ts
```

如果 Runtime permission bridge 已存在，只接入现有 resolver，不新增第二套权限存储。

### 实现步骤

1. 在 `types.ts` 定义 `PermissionRequestView` 和 action：`permission_requested`、`permission_resolved`。
2. Runtime 的 `askUser` 触发时生成 `PermissionRequestedEvent`，包含 `id`、`toolName`、`message`、`approvalKey`。
3. event adapter 把 permission event 写入 AgentWorkspaceStore，并把 status 设为 `waiting_permission`。
4. `PermissionQueue` 只展示 pending 请求，按钮调用 `permissionBridge.resolve(id, "approved" | "denied")`。
5. Runtime bridge resolver 把 approved/denied 转回 Runtime 期待的值，例如 `y` / `n` 或更明确的 enum。
6. fake events 加入一个 `edit_file` permission 请求；点击 Approve/Deny 后队列消失，RuntimeTimeline 追加 resolved 事件。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，点击 fake permission 或触发真实需审批工具，Agent Workspace 顶部状态变为 `waiting_permission`，Permission Queue 出现工具名、说明和 Approve/Deny；点击 Approve 后请求变为 approved 并从 pending 列表消失，Runtime 收到审批结果继续执行。

### 常见报错

- Approve 后 Runtime 没继续：确认 resolver id 与 request id 一致，且 Promise 被 resolve。
- Deny 后工具仍执行：Runtime 必须解释 denied 结果并中止或返回拒绝结果，UI 不能自己决定。
- 多个权限请求错乱：队列按 id resolve，不要只 resolve “当前第一个”。
- 权限结果只改 UI 没回 Runtime：`permission_resolved` action 和 Runtime resolver 都要执行。

## 可运行验收

本章验收：

- pending permission 会让 status 变 `waiting_permission`。
- Approve/Deny 会更新 UI，并 resolve Runtime permission bridge。
- PermissionQueue 不直接调用 tool runner。
- 多个 pending 请求按 id 独立处理。

## 当前章节缺陷

V6 的 Permission Queue 只处理当前请求，不实现企业策略、审批审计和远程审批。

## 下一章预告

下一章会实现 Agent Status Summary：把当前运行状态、工具数量、计划进度、等待审批等信息汇总成顶部状态面板。
