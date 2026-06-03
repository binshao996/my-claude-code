# 第 60 章：远程权限决策审计、审批队列与安全回放

第 59 章把 session timeline 从内存模型升级成持久化模型：

```txt
append-only event store
session snapshot
internal events
replay truncation
latest compaction resume
delivery ledger
worker cursor
```

有了持久化之后，权限系统就不能只停留在：

```txt
弹窗问一下
用户点 allow
worker 继续执行
```

官方级远程 Agent 必须能回答更难的问题：

```txt
谁批准了这个工具？
批准时看到的 tool input 是什么？
批准理由来自规则、模式、hook、classifier，还是用户？
用户有没有改过 input？
批准是否写入了持久权限规则？
同一个 request 被两个客户端同时批准，谁赢了？
迟到的 approval 为什么没有生效？
permission prompt 消失是因为被批准、拒绝、超时、取消，还是 worker 重启？
事后如何回放这次审批并证明执行的是当时批准的内容？
```

如果没有这层，远程权限会出现非常危险的坏状态：

```txt
Web A 批准了旧 input，worker 执行了新 input
Web B 重放了旧 approval，下一轮工具被误放行
hook 已经拒绝，移动端迟到 allow 又把工具放行
updatedPermissions 未经校验写入 settings
permission prompt 超时了，但 session 仍显示 requires_action
审计里只有 allow/deny，没有 reason 和 input hash
用户问“刚才为什么允许删除文件”，系统答不上来
```

本章目标：

- 梳理权限请求的审计字段
- 梳理 pending approval queue
- 梳理 decision ledger
- 梳理 permission response 的安全回放
- 梳理 updatedInput 与 input hash
- 梳理 updatedPermissions 的落库边界
- 梳理 hook / SDK / Web 多方 race
- 梳理 orphaned permission 恢复
- 梳理 cancel / timeout / stale worker 的审计
- 给 Mini 增加可追责的远程权限安全层

到本章结束，你的 Mini 会具备：

- permission request audit record
- approval queue
- first-decision-wins ledger
- input hash verification
- decision classification
- actor identity
- request expiry
- response replay protection
- cancel reason
- updated permissions validation
- audit timeline
- orphaned approval recovery
- approval snapshot in session detail
- security replay tests

第 59 章回答：

```txt
历史被持久化、截断、压缩后，session 如何恢复
```

第 60 章回答：

```txt
权限被远程批准、拒绝、取消、迟到、重放后，系统如何证明它只按安全决策执行了一次
```

## 参考源码

本章参考这些真实模块：

```txt
packages/remote-control-server/src/routes/web/control.ts
packages/remote-control-server/src/transport/client-payload.ts
packages/remote-control-server/src/types/messages.ts
src/remote/RemoteSessionManager.ts
src/remote/remotePermissionBridge.ts
src/cli/structuredIO.ts
src/bridge/remoteBridgeCore.ts
src/utils/permissions/permissions.ts
src/utils/permissions/PermissionPromptToolResultSchema.ts
src/utils/permissions/PermissionUpdate.ts
src/utils/permissions/PermissionUpdateSchema.ts
src/types/permissions.ts
src/utils/hooks.ts
src/utils/queryHelpers.ts
src/cli/print.ts
packages/acp-link/src/server.ts
packages/remote-control-server/src/transport/sse-writer.ts
```

这些源码说明：

```txt
权限不是一个布尔值
它是一条可审计的状态机
```

## 权限决策不是 allow/deny

权限结果至少包含：

```txt
behavior:
  allow
  deny
  ask

reason:
  rule
  mode
  hook
  classifier
  safetyCheck
  sandboxOverride
  workingDir
  permissionPromptTool
  asyncAgent

input:
  original input
  updated input
  input hash

persistence:
  session only
  local settings
  project settings
  user settings

actor:
  local user
  remote web client
  mobile client
  hook
  classifier
  system timeout
```

所以 Mini 不要把 permission 写成：

```ts
type Permission = boolean;
```

至少要写成：

```ts
export type PermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      actor: PermissionActor;
      reason: PermissionDecisionReason;
    }
  | {
      behavior: "deny";
      message: string;
      actor: PermissionActor;
      reason: PermissionDecisionReason;
      interrupt?: boolean;
    }
  | {
      behavior: "cancelled";
      actor: PermissionActor;
      reason: PermissionCancelReason;
    };
```

## 审计记录

权限请求记录：

```ts
export type PermissionRequestAudit = {
  id: string;
  sessionId: string;
  requestId: string;
  toolUseId: string;
  toolName: string;
  agentId?: string;
  originalInput: Record<string, unknown>;
  originalInputHash: string;
  promptMessage?: string;
  decisionReason?: PermissionDecisionReason;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "decided" | "cancelled" | "expired";
  workerEpoch: number;
};
```

权限决策记录：

```ts
export type PermissionDecisionAudit = {
  id: string;
  sessionId: string;
  requestId: string;
  toolUseId: string;
  behavior: "allow" | "deny" | "cancelled";
  actor: PermissionActor;
  reason: PermissionDecisionReason | PermissionCancelReason;
  originalInputHash: string;
  updatedInputHash?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
  decisionClassification?: "user_temporary" | "user_permanent" | "user_reject";
  decidedAt: string;
  sourceEventId?: string;
  workerEpoch: number;
};
```

actor：

```ts
export type PermissionActor =
  | { type: "web"; ownerUuid: string; clientId?: string }
  | { type: "mobile"; ownerUuid: string; deviceId?: string }
  | { type: "sdk_host"; host: string }
  | { type: "hook"; hookName: string }
  | { type: "classifier"; classifier: string }
  | { type: "system"; reason: "timeout" | "disconnect" | "worker_replaced" };
```

取消原因：

```ts
export type PermissionCancelReason =
  | { type: "timeout" }
  | { type: "control_cancel_request" }
  | { type: "turn_aborted" }
  | { type: "session_closed" }
  | { type: "worker_epoch_replaced" }
  | { type: "client_disconnect" };
```

## input hash

审计最关键的是 input hash。

用户批准的是：

```txt
tool_name + input + tool_use_id + request_id
```

worker 执行前必须确认：

```txt
执行 input 与批准 input 一致
```

如果用户修改了 input，则记录：

```txt
originalInputHash
updatedInputHash
updatedInput
```

hash 要用稳定 JSON。

```ts
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );

  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(",")}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  return sha256Hex(
    stableStringify({
      toolName,
      input,
    }),
  );
}
```

不要把 secret 原文写进审计。

如果 input 里可能有敏感字段，审计里可以存：

```txt
redacted input preview
full hash
```

## redaction

权限审计需要可追责，但不能泄漏敏感值。

```ts
const SECRET_KEY_PATTERN = /token|secret|password|api[_-]?key|credential/i;

export function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactForAudit);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactForAudit(val);
  }

  return out;
}
```

审计记录里建议同时保存：

```txt
input_preview_redacted
input_hash
```

不要保存：

```txt
原始凭证
环境变量值
私钥内容
```

## approval queue

pending prompt 应该是队列，不是单个字段。

因为并发 tool use 可能同时请求多个权限。

```ts
export type ApprovalQueueItem = PermissionRequestAudit & {
  visibleTo: Array<{ ownerUuid: string }>;
  priority: "normal" | "high";
};

export class ApprovalQueue {
  private readonly pending = new Map<string, ApprovalQueueItem>();

  add(item: ApprovalQueueItem): void {
    this.pending.set(item.requestId, item);
  }

  get(requestId: string): ApprovalQueueItem | undefined {
    return this.pending.get(requestId);
  }

  list(sessionId: string): ApprovalQueueItem[] {
    return [...this.pending.values()]
      .filter(item => item.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  remove(requestId: string): ApprovalQueueItem | undefined {
    const item = this.pending.get(requestId);
    if (!item) return undefined;
    this.pending.delete(requestId);
    return item;
  }
}
```

session snapshot 里只放当前需要展示的摘要。

完整队列通过：

```txt
GET /web/sessions/:id/approvals
```

读取。

## first decision wins

多客户端审批必须是 first-decision-wins。

```ts
export class PermissionDecisionLedger {
  private readonly decisions = new Map<string, PermissionDecisionAudit>();

  decide(decision: PermissionDecisionAudit): {
    accepted: boolean;
    decision: PermissionDecisionAudit;
  } {
    const key = `${decision.sessionId}:${decision.requestId}`;
    const existing = this.decisions.get(key);
    if (existing) {
      return { accepted: false, decision: existing };
    }

    this.decisions.set(key, decision);
    return { accepted: true, decision };
  }

  get(sessionId: string, requestId: string): PermissionDecisionAudit | undefined {
    return this.decisions.get(`${sessionId}:${requestId}`);
  }
}
```

重复提交时返回第一次决策。

不要让第二个客户端覆盖。

```json
{
  "status": "duplicate",
  "decision": {
    "behavior": "allow",
    "decided_at": "..."
  }
}
```

## pending request 生命周期

状态机：

```txt
created
  -> pending
  -> decided
  -> delivered
  -> consumed

pending
  -> cancelled

pending
  -> expired

pending
  -> worker_replaced
```

审计事件：

```ts
export type PermissionAuditEvent =
  | { type: "permission_requested"; request: PermissionRequestAudit }
  | { type: "permission_decided"; decision: PermissionDecisionAudit }
  | { type: "permission_cancelled"; sessionId: string; requestId: string; reason: PermissionCancelReason }
  | { type: "permission_delivered"; sessionId: string; requestId: string; eventId: string }
  | { type: "permission_consumed"; sessionId: string; requestId: string; toolUseId: string }
  | { type: "permission_duplicate_ignored"; sessionId: string; requestId: string; actor: PermissionActor }
  | { type: "permission_replay_rejected"; sessionId: string; requestId: string; reason: string };
```

这类 audit event 应该进入：

```txt
control ledger
```

也可以投影到 UI timeline。

但不要让它自动触发 worker 工具执行。

## 建立请求

worker 发送 `control_request`：

```txt
subtype: can_use_tool
tool_name
input
permission_suggestions
blocked_path
decision_reason
tool_use_id
agent_id
```

Mini 接收时：

```ts
export async function createPermissionRequest(input: {
  sessionId: string;
  workerEpoch: number;
  requestId: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id: string;
    agent_id?: string;
    permission_suggestions?: PermissionUpdate[];
    blocked_path?: string;
    decision_reason?: PermissionDecisionReason;
  };
  ownerUuid: string;
  queue: ApprovalQueue;
  audit: PermissionAuditWriter;
}): Promise<PermissionRequestAudit> {
  const originalInputHash = await hashToolInput(
    input.request.tool_name,
    input.request.input,
  );

  const record: PermissionRequestAudit = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    requestId: input.requestId,
    toolUseId: input.request.tool_use_id,
    toolName: input.request.tool_name,
    agentId: input.request.agent_id,
    originalInput: redactForAudit(input.request.input) as Record<string, unknown>,
    originalInputHash,
    decisionReason: input.request.decision_reason,
    suggestions: input.request.permission_suggestions,
    blockedPath: input.request.blocked_path,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    status: "pending",
    workerEpoch: input.workerEpoch,
  };

  input.queue.add({
    ...record,
    visibleTo: [{ ownerUuid: input.ownerUuid }],
    priority: input.request.blocked_path ? "high" : "normal",
  });

  await input.audit.write({ type: "permission_requested", request: record });

  return record;
}
```

## 提交审批

Web 提交：

```txt
POST /web/sessions/:id/approvals/:requestId/decision
```

请求体：

```ts
export type SubmitPermissionDecisionBody =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      decisionClassification?: "user_temporary" | "user_permanent";
      responseInputHash?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      decisionClassification?: "user_reject";
      responseInputHash?: string;
    };
```

处理：

```ts
export async function submitPermissionDecision(input: {
  sessionId: string;
  requestId: string;
  actor: PermissionActor;
  body: SubmitPermissionDecisionBody;
  queue: ApprovalQueue;
  ledger: PermissionDecisionLedger;
  audit: PermissionAuditWriter;
  publishToWorker: (payload: Record<string, unknown>) => Promise<{ eventId: string }>;
}): Promise<{ status: "accepted" | "duplicate"; decision: PermissionDecisionAudit }> {
  const pending = input.queue.get(input.requestId);
  if (!pending) {
    const existing = input.ledger.get(input.sessionId, input.requestId);
    if (existing) return { status: "duplicate", decision: existing };
    throw new Error("approval request not found");
  }

  const updatedInput =
    input.body.behavior === "allow" ? input.body.updatedInput : undefined;
  const approvedInputHash = updatedInput
    ? await hashToolInput(pending.toolName, updatedInput)
    : pending.originalInputHash;

  if (
    input.body.responseInputHash &&
    input.body.responseInputHash !== pending.originalInputHash
  ) {
    await input.audit.write({
      type: "permission_replay_rejected",
      sessionId: input.sessionId,
      requestId: input.requestId,
      reason: "input hash mismatch",
    });
    throw new Error("permission input hash mismatch");
  }

  const decision: PermissionDecisionAudit = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    requestId: input.requestId,
    toolUseId: pending.toolUseId,
    behavior: input.body.behavior,
    actor: input.actor,
    reason:
      input.body.behavior === "allow"
        ? { type: "user_approved" }
        : { type: "user_denied", message: input.body.message },
    originalInputHash: pending.originalInputHash,
    updatedInputHash: approvedInputHash,
    updatedInput: updatedInput ? (redactForAudit(updatedInput) as Record<string, unknown>) : undefined,
    updatedPermissions:
      input.body.behavior === "allow"
        ? input.body.updatedPermissions
        : undefined,
    decisionClassification: input.body.decisionClassification,
    decidedAt: new Date().toISOString(),
    workerEpoch: pending.workerEpoch,
  };

  const result = input.ledger.decide(decision);
  if (!result.accepted) {
    await input.audit.write({
      type: "permission_duplicate_ignored",
      sessionId: input.sessionId,
      requestId: input.requestId,
      actor: input.actor,
    });
    return { status: "duplicate", decision: result.decision };
  }

  input.queue.remove(input.requestId);
  const event = await input.publishToWorker(toControlResponsePayload(pending, input.body));
  decision.sourceEventId = event.eventId;

  await input.audit.write({ type: "permission_decided", decision });

  return { status: "accepted", decision };
}
```

这里用到的 reason 类型可以在 Mini 内部定义。

真实项目里要和 `PermissionDecisionReason` 对齐。

## control_response payload

服务端最终发给 worker 的 shape：

```ts
export function toControlResponsePayload(
  pending: PermissionRequestAudit,
  body: SubmitPermissionDecisionBody,
): Record<string, unknown> {
  if (body.behavior === "allow") {
    return {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: pending.requestId,
        response: {
          behavior: "allow",
          updatedInput: body.updatedInput ?? {},
          toolUseID: pending.toolUseId,
          ...(body.updatedPermissions
            ? { updatedPermissions: body.updatedPermissions }
            : {}),
          ...(body.decisionClassification
            ? { decisionClassification: body.decisionClassification }
            : {}),
        },
      },
    };
  }

  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: pending.requestId,
      response: {
        behavior: "deny",
        message: body.message,
        toolUseID: pending.toolUseId,
        interrupt: body.interrupt,
        decisionClassification: body.decisionClassification ?? "user_reject",
      },
    },
  };
}
```

注意：

```txt
deny 也可以放在 success response 里
因为 protocol 层成功传达了一个 deny decision
```

如果用 `subtype: error`，worker 可能把它当协议错误，而不是用户拒绝。

本地 RCS 当前对 `permission_response approved=false` 会转成 `subtype:error`。

Mini 如果追求更贴近 SDK schema，建议改成：

```txt
subtype success + response.behavior deny
```

但要和现有 StructuredIO schema 保持一致。

## updatedPermissions 安全边界

`PermissionPromptToolResultSchema` 支持：

```txt
updatedPermissions
decisionClassification
```

这非常敏感。

因为它可能把一次临时 allow 变成持久 allow rule。

Mini 必须校验：

```txt
只有 allow 决策可以带 updatedPermissions
只有用户明确选择 permanent 才能持久化
远程客户端不能请求比服务端允许范围更高的 destination
projectSettings 需要额外确认
policySettings 永远不能由用户写
```

校验函数：

```ts
export function validatePermissionUpdatesForRemote(input: {
  updates: PermissionUpdate[] | undefined;
  classification: string | undefined;
  actor: PermissionActor;
}): PermissionUpdate[] | undefined {
  if (!input.updates?.length) return undefined;

  if (input.classification !== "user_permanent") {
    throw new Error("persistent permission updates require permanent approval");
  }

  for (const update of input.updates) {
    if (update.destination === "cliArg") {
      throw new Error("remote approvals cannot write cliArg permissions");
    }

    if (update.destination === "projectSettings") {
      throw new Error("project settings updates require local confirmation");
    }
  }

  return input.updates;
}
```

更严格的版本可以只允许：

```txt
session
localSettings
```

远程移动端默认只允许：

```txt
session
```

## permission mode request

ACP link 有一个重要策略：

```txt
客户端请求 bypassPermissions 时，只有本地默认已经是 bypassPermissions 才允许
```

这是正确的。

远程客户端不能单方面提升权限模式。

Mini 的规则：

```ts
export function resolveRemotePermissionMode(
  requested: PermissionMode | undefined,
  localDefault: PermissionMode,
): PermissionMode {
  if (!requested) return localDefault;

  if (requested === "bypassPermissions" && localDefault !== "bypassPermissions") {
    throw new Error("remote client cannot elevate to bypassPermissions");
  }

  return requested;
}
```

同理：

```txt
远程 approval 不能把 deny rule 删除
远程 approval 不能绕过 safetyCheck
远程 approval 不能修改 policy settings
```

## hook / SDK / Web race

`StructuredIO.createCanUseTool` 做了一个关键 race：

```txt
PermissionRequest hooks
SDK permission prompt
```

谁先给出决定，谁赢。

如果 hook 赢：

```txt
abort SDK request
发送 control_cancel_request
忽略迟到 SDK response
```

如果 SDK 赢：

```txt
使用 SDK response
hook 后续结果忽略
```

远程 Web 也应该加入同一个 race。

抽象：

```txt
decision sources:
  hook
  local SDK host
  Web client
  mobile client
  timeout
  abort
```

统一进：

```txt
PermissionDecisionLedger
```

first-decision-wins。

所有输家都写 audit：

```txt
permission_duplicate_ignored
```

## cancel propagation

取消不是静默删除。

要写审计，也要通知所有可见客户端。

```ts
export async function cancelPermission(input: {
  sessionId: string;
  requestId: string;
  reason: PermissionCancelReason;
  queue: ApprovalQueue;
  audit: PermissionAuditWriter;
  publishUiEvent: (event: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  const item = input.queue.remove(input.requestId);
  if (!item) return;

  await input.audit.write({
    type: "permission_cancelled",
    sessionId: input.sessionId,
    requestId: input.requestId,
    reason: input.reason,
  });

  await input.publishUiEvent({
    type: "permission_cancelled",
    request_id: input.requestId,
    reason: input.reason.type,
  });
}
```

StructuredIO 里的 `control_cancel_request` 是 worker / host 之间的取消。

Web UI 也需要自己的 cancellation event。

不要只让弹窗“自然消失”。

## timeout

ACP link 里 pending permission 有 5 分钟超时。

Mini 也应该有。

```ts
export class PermissionExpiryWorker {
  constructor(
    private readonly queue: ApprovalQueue,
    private readonly cancel: (requestId: string) => Promise<void>,
  ) {}

  async tick(now = new Date()): Promise<void> {
    for (const item of this.queue.all()) {
      if (new Date(item.expiresAt).getTime() <= now.getTime()) {
        await this.cancel(item.requestId);
      }
    }
  }
}
```

超时行为建议：

```txt
deny by default
reason timeout
do not persist permission updates
notify worker with cancellation or deny response
```

如果 worker 等待 `control_response`，最好发一个 deny：

```txt
behavior deny
message Permission request timed out
```

否则 worker promise 可能挂住。

## orphaned permission

orphaned permission 是远程场景里非常关键的恢复机制。

场景：

```txt
worker 发出 permission request
客户端断线
response 迟到
StructuredIO 已经没有 pending request
但 transcript 里还有 unresolved tool_use
```

`handleOrphanedPermissionResponse` 会：

```txt
从 control_response 提取 toolUseID
检查是否已处理过
查 transcript 里 unresolved tool_use
重新 enqueue orphaned permission
```

Mini 的审计要记录：

```txt
orphaned_response_received
orphaned_response_replayed
orphaned_response_duplicate_ignored
orphaned_response_no_unresolved_tool_use
```

实现骨架：

```ts
export async function handleOrphanedApproval(input: {
  decision: PermissionDecisionAudit;
  transcript: TranscriptReader;
  alreadyHandledToolUses: Set<string>;
  enqueue: (item: { toolUseId: string; decision: PermissionDecisionAudit }) => void;
  audit: PermissionAuditWriter;
}): Promise<boolean> {
  if (input.alreadyHandledToolUses.has(input.decision.toolUseId)) {
    await input.audit.write({
      type: "permission_duplicate_ignored",
      sessionId: input.decision.sessionId,
      requestId: input.decision.requestId,
      actor: input.decision.actor,
    });
    return false;
  }

  const unresolved = await input.transcript.findUnresolvedToolUse(
    input.decision.toolUseId,
  );

  if (!unresolved) {
    await input.audit.write({
      type: "permission_replay_rejected",
      sessionId: input.decision.sessionId,
      requestId: input.decision.requestId,
      reason: "no unresolved tool use",
    });
    return false;
  }

  input.alreadyHandledToolUses.add(input.decision.toolUseId);
  input.enqueue({ toolUseId: input.decision.toolUseId, decision: input.decision });
  return true;
}
```

## requires_action snapshot

远程 UI 的 session detail 需要显示：

```txt
当前是否等待审批
等待哪个 tool
request_id
tool_use_id
输入摘要
过期时间
```

不要只写：

```txt
status: requires_action
```

snapshot：

```ts
export type RequiresActionSnapshot = {
  requestId: string;
  toolUseId: string;
  toolName: string;
  actionDescription: string;
  inputPreview: unknown;
  createdAt: string;
  expiresAt: string;
};
```

worker state 里已经有类似：

```txt
requires_action_details
```

Mini 应该把它和 approval queue 对齐。

如果 queue 为空，就不能继续显示 requires_action。

## UI history

权限审计也要能在 Web history 里看。

建议 UI timeline 显示摘要：

```txt
Permission requested: Bash
Approved by web user
Denied by hook
Cancelled: timeout
Duplicate approval ignored
```

但详细 input 只在展开时显示 redacted preview。

不要默认把完整 input 展示在消息流里。

## replay-safe response

回放 approval 时需要验证四件事：

```txt
request_id 存在或有 ledger
tool_use_id 匹配
input hash 匹配
worker epoch 未过期
```

```ts
export function validateReplay(input: {
  pending: PermissionRequestAudit | undefined;
  decision: PermissionDecisionAudit;
  currentWorkerEpoch: number;
}): "ok" | "duplicate" | "stale_epoch" | "missing_request" | "input_mismatch" {
  if (!input.pending) {
    return "missing_request";
  }

  if (input.pending.workerEpoch !== input.currentWorkerEpoch) {
    return "stale_epoch";
  }

  if (input.pending.toolUseId !== input.decision.toolUseId) {
    return "input_mismatch";
  }

  if (input.pending.originalInputHash !== input.decision.originalInputHash) {
    return "input_mismatch";
  }

  return "ok";
}
```

不要只靠 request_id。

request_id 是协议配对。

input hash 才能证明用户批准的内容和执行内容一致。

## sandbox network permission

`StructuredIO.createSandboxAskCallback` 把网络访问也包装成 `can_use_tool`：

```txt
tool_name: SandboxNetworkAccess
input: { host }
```

这很好。

因为它让所有审批走同一套：

```txt
request_id
tool_use_id
control_response
audit
timeout
cancel
```

Mini 不要为 sandbox 网络单独写一条“特殊弹窗通道”。

特殊通道通常会绕过审计。

## permission audit store

最小接口：

```ts
export interface PermissionAuditStore {
  write(event: PermissionAuditEvent): Promise<void>;
  listBySession(sessionId: string): Promise<PermissionAuditEvent[]>;
  listByRequest(sessionId: string, requestId: string): Promise<PermissionAuditEvent[]>;
}
```

内存实现：

```ts
export class InMemoryPermissionAuditStore implements PermissionAuditStore {
  private readonly events: PermissionAuditEvent[] = [];

  async write(event: PermissionAuditEvent): Promise<void> {
    this.events.push(event);
  }

  async listBySession(sessionId: string): Promise<PermissionAuditEvent[]> {
    return this.events.filter(event => "sessionId" in event && event.sessionId === sessionId);
  }

  async listByRequest(
    sessionId: string,
    requestId: string,
  ): Promise<PermissionAuditEvent[]> {
    return this.events.filter(
      event =>
        "sessionId" in event &&
        event.sessionId === sessionId &&
        "requestId" in event &&
        event.requestId === requestId,
    );
  }
}
```

生产版要 append-only。

不要允许更新历史审计行。

## API 设计

新增 Web API：

```txt
GET  /web/sessions/:id/approvals
GET  /web/sessions/:id/approvals/:requestId
POST /web/sessions/:id/approvals/:requestId/decision
POST /web/sessions/:id/approvals/:requestId/cancel
GET  /web/sessions/:id/permission-audit
```

worker / internal API：

```txt
POST /v1/code/sessions/:id/worker/permissions/requested
POST /v1/code/sessions/:id/worker/permissions/consumed
```

也可以不加 worker permissions endpoints，直接从 `control_request` 和 `control_response` 事件投影。

Mini 建议先投影，减少协议面。

## 和现有 /control 的关系

当前 RCS 有：

```txt
POST /web/sessions/:id/control
```

它直接 publish `control_request` 或 `permission_response`。

这太宽。

第 60 章之后建议拆分：

```txt
/events:
  user messages

/interrupt:
  interrupt

/approvals/:requestId/decision:
  permission decisions

/control:
  保留兼容，但内部转发到明确 handler
```

不要让任意 Web body 直接进入 worker control channel。

## 测试：first decision wins

```ts
import { describe, expect, test } from "bun:test";
import { PermissionDecisionLedger } from "../permissionAudit";

describe("PermissionDecisionLedger", () => {
  test("keeps the first decision", () => {
    const ledger = new PermissionDecisionLedger();

    const first = makeDecision({ behavior: "allow", requestId: "r1" });
    const second = makeDecision({ behavior: "deny", requestId: "r1" });

    expect(ledger.decide(first).accepted).toBe(true);
    const duplicate = ledger.decide(second);

    expect(duplicate.accepted).toBe(false);
    expect(duplicate.decision.behavior).toBe("allow");
  });
});
```

运行：

```bash
bun test src/reliability/__tests__/permissionAudit.test.ts
```

## 测试：input hash mismatch

```ts
test("rejects replay with mismatched input hash", async () => {
  const pending = await makePendingRequest({
    toolName: "Bash",
    input: { command: "echo hello" },
  });

  const decision = makeDecision({
    requestId: pending.requestId,
    toolUseId: pending.toolUseId,
    originalInputHash: await hashToolInput("Bash", {
      command: "rm -rf important",
    }),
  });

  expect(
    validateReplay({
      pending,
      decision,
      currentWorkerEpoch: pending.workerEpoch,
    }),
  ).toBe("input_mismatch");
});
```

## 测试：updatedPermissions 需要永久批准

```ts
test("rejects persistent permission updates without permanent approval", () => {
  expect(() =>
    validatePermissionUpdatesForRemote({
      classification: "user_temporary",
      actor: { type: "web", ownerUuid: "u1" },
      updates: [
        {
          type: "addRules",
          behavior: "allow",
          destination: "localSettings",
          rules: [{ toolName: "Bash", ruleContent: "git status:*" }],
        },
      ],
    }),
  ).toThrow("persistent permission updates require permanent approval");
});
```

## 测试：timeout cancels pending prompt

```ts
test("expires pending approval", async () => {
  const queue = new ApprovalQueue();
  const cancelled: string[] = [];

  queue.add(makeQueueItem({ requestId: "r1", expiresAt: "2000-01-01T00:00:00.000Z" }));

  const worker = new PermissionExpiryWorker(queue, async requestId => {
    cancelled.push(requestId);
  });

  await worker.tick(new Date("2000-01-01T00:00:01.000Z"));

  expect(cancelled).toEqual(["r1"]);
});
```

## 测试：orphaned approval duplicate

```ts
test("does not enqueue duplicate orphaned approval", async () => {
  const handled = new Set<string>(["tool-1"]);
  const enqueued: string[] = [];

  const result = await handleOrphanedApproval({
    decision: makeDecision({ toolUseId: "tool-1" }),
    transcript: fakeTranscriptWithToolUse("tool-1"),
    alreadyHandledToolUses: handled,
    enqueue: item => enqueued.push(item.toolUseId),
    audit: new InMemoryPermissionAuditStore(),
  });

  expect(result).toBe(false);
  expect(enqueued).toEqual([]);
});
```

## 测试：remote cannot elevate bypass

```ts
test("remote client cannot elevate to bypass mode", () => {
  expect(() =>
    resolveRemotePermissionMode("bypassPermissions", "default"),
  ).toThrow("remote client cannot elevate");

  expect(resolveRemotePermissionMode("bypassPermissions", "bypassPermissions")).toBe(
    "bypassPermissions",
  );
});
```

## 审计查询示例

一次正常 allow 的审计链：

```txt
permission_requested
permission_decided
permission_delivered
permission_consumed
```

一次重复点击：

```txt
permission_requested
permission_decided
permission_duplicate_ignored
```

一次 hook 抢先拒绝：

```txt
permission_requested
permission_cancelled reason=control_cancel_request
permission_decided actor=hook behavior=deny
```

一次超时：

```txt
permission_requested
permission_cancelled reason=timeout
permission_decided actor=system behavior=deny
```

一次重放攻击：

```txt
permission_requested
permission_replay_rejected reason=input hash mismatch
```

## 安全回放

安全回放不是重新执行工具。

它是重放审批状态机，证明当时的行为正确。

输入：

```txt
permission request audit
permission decision audit
tool execution record
session event log
worker epoch
input hash
```

输出：

```txt
approved input hash matches executed input hash
decision was first for request
request was pending at decision time
worker epoch matched
decision source was authorized
updatedPermissions were allowed by classification
```

函数：

```ts
export function replayPermissionDecision(input: {
  request: PermissionRequestAudit;
  decision: PermissionDecisionAudit;
  executedInputHash: string;
  firstDecision: PermissionDecisionAudit;
}): { ok: true } | { ok: false; reason: string } {
  if (input.firstDecision.id !== input.decision.id) {
    return { ok: false, reason: "decision was not first" };
  }

  if (input.request.originalInputHash !== input.decision.originalInputHash) {
    return { ok: false, reason: "request hash mismatch" };
  }

  const approvedHash =
    input.decision.updatedInputHash ?? input.decision.originalInputHash;

  if (approvedHash !== input.executedInputHash) {
    return { ok: false, reason: "executed input was not approved" };
  }

  if (input.request.workerEpoch !== input.decision.workerEpoch) {
    return { ok: false, reason: "worker epoch mismatch" };
  }

  return { ok: true };
}
```

## 最小落地顺序

建议按这个顺序补 Mini：

```txt
1. PermissionRequestAudit / PermissionDecisionAudit 类型
2. ApprovalQueue
3. PermissionDecisionLedger
4. input hash + redaction
5. /approvals/:requestId/decision
6. first-decision-wins tests
7. updatedPermissions validation
8. timeout / cancel audit
9. orphaned approval handling
10. permission audit query endpoint
11. security replay helper
```

不要先做复杂 UI。

先把服务端语义和测试写稳。

## 和当前本地实现的差距

当前已经有：

```txt
StructuredIO pendingRequests
resolvedToolUseIds duplicate ignore
hook 与 SDK prompt race
control_cancel_request
RemoteSessionManager pendingPermissionRequests
RCS /web/sessions/:id/control
RCS permission_response -> control_response 转换
PermissionDecisionReason 类型
PermissionUpdate schema
updatedPermissions schema
orphaned permission recovery
ACP pending permission timeout
ACP bypassPermissions elevation guard
```

还缺：

```txt
服务端 approval queue
permission request audit record
permission decision ledger
first-decision-wins endpoint
input hash verification
updatedPermissions remote policy
permission audit store
permission timeout audit
orphaned permission audit
security replay helper
/permission-audit query
requires_action 与 approval queue 强一致投影
```

## 常见错误

错误一：

```txt
Web body 直接 publish 到 control channel
```

应该走 typed approval handler。

错误二：

```txt
只按 request_id 判断 approval 有效
```

还要校验 tool_use_id、input hash、worker epoch。

错误三：

```txt
allow 后无条件持久化 updatedPermissions
```

必须要求永久批准和 destination policy。

错误四：

```txt
prompt timeout 只从 UI 删除
```

worker 也要收到 deny 或 cancel，审计也要记录。

错误五：

```txt
hook 赢了但不取消 Web prompt
```

用户稍后点击旧 prompt 会产生迟到 approval。

错误六：

```txt
审计里保存完整敏感 input
```

保存 redacted preview + hash。

错误七：

```txt
重放审批时重新执行工具
```

安全回放只验证，不执行。

## 本章完成后的能力

现在 Mini 的权限系统从：

```txt
弹窗审批
```

升级成：

```txt
可排队、可审计、可回放验证的安全决策系统
```

它具备：

```txt
pending approval queue
permission audit store
decision ledger
input hash
redacted preview
first-decision-wins
timeout / cancel audit
updatedPermissions policy
orphaned approval recovery
remote mode elevation guard
security replay
```

这让远程 Claude Code 更接近官方体验：

```txt
多端审批不会重复执行
迟到审批不会误放行
永久权限不会被悄悄写入
每次 tool 执行都有可解释来源
事后可以证明执行内容就是被批准的内容
```

## 和官方 Claude Code 的差距

Mini 仍然简化了很多细节：

```txt
enterprise policy settings
managed permission source
classifier cost telemetry
classifier fail-closed refresh
safetyCheck classifierApprovable
subcommand-level Bash approval
visual diff approval
file path safety policy
remote mobile push approval
approval notification revocation
multi-org actor identity
signed audit export
tamper-evident audit chain
```

但核心骨架已经正确：

```txt
permission request 是事实
permission decision 是账本
control_response 是投递
tool execution 要匹配批准 hash
审计只能追加，不能篡改
```

下一章可以继续补 **策略引擎、规则匹配 DSL 与企业托管权限**：让 allow / deny / ask 规则、路径安全、MCP 工具和组织策略形成统一的 policy layer。
