# 第 59 章：持久化事件存储、会话快照与 replay truncation 恢复

第 58 章把远程协同的内存模型补齐了：

```txt
event_id
idempotency key
sequence_num
delivery status
worker_epoch
owner_uuid
request_id
tool_use_id
full-so-far stream snapshot
client reducer dedup
```

这些能让一个活着的进程在网络抖动、重复提交、重连重放时保持 exactly-once effect。

但只要进程重启，内存模型就不够了。

新的问题会出现：

```txt
RCS 重启后 event bus 为空
worker 重启后不知道最后处理到哪个 event
Web 从旧 sequence reconnect，但服务端 history 已被截断
session detail 可以恢复，但 timeline 丢了
local transcript 有 compact boundary，remote internal events 没有
subagent transcript 写在独立文件，远程 resume 不知道如何分组
metadata 在文件尾部，event store 里没有 snapshot
delivery ledger 重启后丢失，worker 会重复处理旧 user event
large transcript 全量读导致内存暴涨
compaction 前的事件被删了，但 Web 还拿着旧 cursor
```

第 58 章的结论是：

```txt
网络可以至少一次
业务效果要 exactly once
```

第 59 章要继续补：

```txt
进程可以重启
历史可以截断
客户端可以拿旧 cursor
但 session 仍然能恢复成一致的 timeline
```

本章目标：

- 设计持久化事件表
- 设计 session snapshot 表
- 设计 replay cursor 与 truncation 语义
- 设计 internal events 服务端存储
- 设计 compaction boundary 恢复
- 设计 transcript hydration
- 设计 metadata last-wins snapshot
- 设计 delivery ledger 持久化
- 设计 subagent event 分区
- 设计大 transcript 的增量读取
- 给 Mini 增加重启后可恢复的 session timeline

到本章结束，你的 Mini 会具备：

- append-only event store
- monotonic sequence allocator
- idempotency unique index
- internal event store
- compaction boundary marker
- latest snapshot pointer
- session snapshot projection
- replay cursor validation
- catch-up truncated response
- local transcript hydration
- subagent transcript grouping
- delivery ledger restore
- metadata last-wins restore
- large log chunked load
- persistence test matrix

第 58 章回答：

```txt
重复 delivery 和多客户端协同时，如何只产生一次业务效果
```

第 59 章回答：

```txt
事件日志被持久化、截断、压缩、重放时，系统如何恢复一致的会话状态
```

## 参考源码

本章参考这些真实模块：

```txt
src/utils/sessionStorage.ts
src/utils/sessionStoragePortable.ts
src/cli/RemoteIO.ts
src/cli/transports/ccrClient.ts
src/services/api/sessionIngress.ts
src/QueryEngine.ts
src/query.ts
src/types/logs.ts
src/utils/sessionRestore.ts
packages/remote-control-server/src/transport/event-bus.ts
packages/remote-control-server/src/transport/sse-writer.ts
packages/remote-control-server/src/routes/web/sessions.ts
packages/remote-control-server/src/routes/v1/session-ingress.ts
packages/remote-control-server/src/routes/v2/worker-events.ts
packages/remote-control-server/src/routes/v2/worker-events-stream.ts
packages/remote-control-server/src/store.ts
packages/remote-control-server/src/__tests__/routes.test.ts
packages/remote-control-server/src/__tests__/sse-writer.test.ts
```

这些模块展示了两套现实：

```txt
本地 CLI transcript:
  append-only JSONL
  parentUuid chain
  compact boundary
  tail metadata
  large-file chunked read
  UUID dedup

远程 RCS timeline:
  in-memory EventBus
  seqNum replay
  SSE Last-Event-ID
  Web history endpoint
  worker event stream
  internal-event client protocol exists
  local RCS server internal-event store 尚未补齐
```

本章要把它们统一成一个 Mini 可以落地的持久化模型。

## 三种历史

先区分三种历史。

第一种是 UI timeline：

```txt
用户看到的事件流
user
assistant
stream_event
tool_use
tool_result
permission prompt
task_state
session_status
automation_state
```

第二种是 model transcript：

```txt
恢复模型上下文需要的消息链
user
assistant
attachment
system compact_boundary
content replacement
file history snapshot
attribution snapshot
context collapse commit
```

第三种是 control ledger：

```txt
幂等和恢复需要的控制状态
idempotency record
delivery record
worker epoch
permission decision
last processed sequence
session owner
metadata snapshot
```

不要把三者塞进同一个数组里直接渲染。

正确做法：

```txt
event store:
  保存原始事件和顺序

snapshot store:
  保存投影后的当前状态

internal event store:
  保存 resume 需要的 transcript 事件

ledger store:
  保存幂等、delivery、epoch、decision
```

## append-only 是底线

session 历史最重要的属性：

```txt
append-only
```

不要在正常路径里原地改历史事件。

原因：

```txt
重放 cursor 依赖 seq 不变
客户端 dedup 依赖 event_id 不变
审计依赖原始事件不消失
compaction 依赖 boundary 明确
resume 依赖消息链可追溯
```

需要“修改”时，写一个新事件：

```txt
message_added
message_tombstoned
metadata_updated
snapshot_written
compact_boundary
delivery_updated
permission_decided
```

本地 transcript 里也类似：

```txt
custom-title:
  后写的 title 覆盖旧 title

tag:
  后写的 tag 覆盖旧 tag

worktree-state:
  enter 写对象
  exit 写 null

marble-origami-snapshot:
  last wins
```

这就是 append-only 上的 last-wins 投影。

## 最小数据库模型

Mini 可以先用内存实现接口。

但 schema 要按持久化设计。

核心表：

```txt
sessions
session_events
session_snapshots
internal_events
idempotency_records
delivery_records
worker_epochs
permission_decisions
```

每张表职责：

```txt
sessions:
  session 基本信息

session_events:
  面向 UI 和 worker stream 的事件日志

session_snapshots:
  面向 detail/history 快速恢复的投影快照

internal_events:
  面向 model resume 的 transcript 事件

idempotency_records:
  外部请求去重

delivery_records:
  worker 对 client event 的处理进度

worker_epochs:
  worker fencing token

permission_decisions:
  request_id 的 first decision
```

## session_events

事件表字段：

```ts
export type StoredSessionEvent = {
  id: string;
  sessionId: string;
  seq: number;
  direction: "client_to_worker" | "worker_to_client";
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  sourceClientId?: string;
  workerEpoch?: number;
  createdAt: string;
};
```

唯一约束：

```txt
unique(session_id, seq)
unique(session_id, id)
unique(session_id, idempotency_key) where idempotency_key is not null
```

索引：

```txt
session_id + seq
session_id + direction + seq
session_id + created_at
```

为什么 seq 不能全局唯一？

因为 replay cursor 是按 session 的。

```txt
session A seq=10
session B seq=10
```

完全合理。

## sequence allocator

sequence 必须在持久化层分配。

不要让 worker 或 Web 自己传。

```ts
export class SequenceAllocator {
  private readonly nextSeq = new Map<string, number>();

  next(sessionId: string): number {
    const current = this.nextSeq.get(sessionId) ?? 0;
    const next = current + 1;
    this.nextSeq.set(sessionId, next);
    return next;
  }

  restore(sessionId: string, lastSeq: number): void {
    const current = this.nextSeq.get(sessionId) ?? 0;
    if (lastSeq > current) {
      this.nextSeq.set(sessionId, lastSeq);
    }
  }
}
```

真实数据库里应该用事务：

```txt
BEGIN
  read sessions.last_seq
  last_seq = last_seq + 1
  insert event(seq=last_seq)
COMMIT
```

不要：

```txt
select max(seq) + 1
```

并发写入时会冲突。

如果 Mini 先做单进程内存版，可以用 mutex。

## event store 接口

接口要表达持久化语义，而不是暴露 Map。

```ts
export type AppendEventInput = {
  sessionId: string;
  direction: StoredSessionEvent["direction"];
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  sourceClientId?: string;
  workerEpoch?: number;
};

export type ReplayEventsResult =
  | {
      ok: true;
      events: StoredSessionEvent[];
      lastSeq: number;
      firstAvailableSeq: number;
    }
  | {
      ok: false;
      reason: "cursor_too_old";
      requestedSeq: number;
      firstAvailableSeq: number;
      snapshotSeq: number;
    };

export interface SessionEventStore {
  append(input: AppendEventInput): Promise<StoredSessionEvent>;
  getSince(input: {
    sessionId: string;
    afterSeq: number;
    direction?: StoredSessionEvent["direction"];
    limit?: number;
  }): Promise<ReplayEventsResult>;
  getLastSeq(sessionId: string): Promise<number>;
}
```

`afterSeq` 表达：

```txt
返回 seq > afterSeq
```

不要命名成 `fromSeq` 后又实现成 `>=`。

## in-memory 实现

先实现内存版，测试语义。

```ts
import { randomUUID } from "node:crypto";

export class InMemorySessionEventStore implements SessionEventStore {
  private readonly eventsBySession = new Map<string, StoredSessionEvent[]>();
  private readonly idempotency = new Map<string, StoredSessionEvent>();
  private readonly lastSeq = new Map<string, number>();

  constructor(private readonly maxEventsPerSession = 5000) {}

  async append(input: AppendEventInput): Promise<StoredSessionEvent> {
    const idemKey = input.idempotencyKey
      ? `${input.sessionId}:${input.idempotencyKey}`
      : undefined;

    if (idemKey) {
      const existing = this.idempotency.get(idemKey);
      if (existing) return existing;
    }

    const seq = (this.lastSeq.get(input.sessionId) ?? 0) + 1;
    this.lastSeq.set(input.sessionId, seq);

    const event: StoredSessionEvent = {
      id: `evt_${randomUUID()}`,
      sessionId: input.sessionId,
      seq,
      direction: input.direction,
      type: input.type,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      sourceClientId: input.sourceClientId,
      workerEpoch: input.workerEpoch,
      createdAt: new Date().toISOString(),
    };

    const list = this.eventsBySession.get(input.sessionId) ?? [];
    list.push(event);
    this.eventsBySession.set(input.sessionId, list);
    if (idemKey) this.idempotency.set(idemKey, event);

    this.trim(input.sessionId);
    return event;
  }

  async getSince(input: {
    sessionId: string;
    afterSeq: number;
    direction?: StoredSessionEvent["direction"];
    limit?: number;
  }): Promise<ReplayEventsResult> {
    const list = this.eventsBySession.get(input.sessionId) ?? [];
    const firstAvailableSeq = list[0]?.seq ?? (this.lastSeq.get(input.sessionId) ?? 0);
    const lastSeq = this.lastSeq.get(input.sessionId) ?? 0;

    if (input.afterSeq > 0 && list.length > 0 && input.afterSeq < firstAvailableSeq - 1) {
      return {
        ok: false,
        reason: "cursor_too_old",
        requestedSeq: input.afterSeq,
        firstAvailableSeq,
        snapshotSeq: Math.max(0, firstAvailableSeq - 1),
      };
    }

    const events = list
      .filter(event => event.seq > input.afterSeq)
      .filter(event => !input.direction || event.direction === input.direction)
      .slice(0, input.limit ?? 1000);

    return {
      ok: true,
      events,
      lastSeq,
      firstAvailableSeq,
    };
  }

  async getLastSeq(sessionId: string): Promise<number> {
    return this.lastSeq.get(sessionId) ?? 0;
  }

  private trim(sessionId: string): void {
    const list = this.eventsBySession.get(sessionId);
    if (!list || list.length <= this.maxEventsPerSession) return;

    const removed = list.splice(0, list.length - Math.floor(this.maxEventsPerSession / 2));
    for (const event of removed) {
      if (event.idempotencyKey) {
        this.idempotency.delete(`${event.sessionId}:${event.idempotencyKey}`);
      }
    }
  }
}
```

这个实现仍然是内存版。

但接口已经为数据库做好准备。

## truncation 是协议事件

当客户端 cursor 太旧，服务端不能简单返回空数组。

空数组表示：

```txt
没有新事件
```

而 cursor 太旧表示：

```txt
你缺了一段历史
```

这两者完全不同。

建议响应：

```json
{
  "type": "catch_up_truncated",
  "requested_seq": 120,
  "first_available_seq": 900,
  "snapshot_seq": 899
}
```

客户端收到后应该：

```txt
停止增量 replay
拉取 session snapshot
重建本地状态
从 snapshot_seq 继续订阅
```

这就是 replay truncation recovery。

## session snapshot

snapshot 是 event log 的投影。

它不是 event log 的替代。

字段：

```ts
export type SessionSnapshot = {
  sessionId: string;
  seq: number;
  title?: string;
  status: "idle" | "running" | "requires_action" | "archived";
  messages: Array<Record<string, unknown>>;
  pendingPermission?: {
    requestId: string;
    toolUseId?: string;
    toolName: string;
    actionDescription?: string;
  };
  taskState?: Record<string, unknown>;
  automationState?: Record<string, unknown>;
  worker?: {
    epoch: number;
    status: string;
    lastHeartbeatAt?: string;
  };
  metadata: Record<string, unknown>;
  updatedAt: string;
};
```

snapshot 的 key：

```txt
session_id
seq
```

常用读取：

```txt
latest snapshot by session_id
```

所以需要：

```txt
sessions.latest_snapshot_seq
```

或者单独表：

```txt
session_latest_snapshots
```

## snapshot builder

snapshot builder 从事件流投影当前状态。

```ts
export function applyEventToSnapshot(
  snapshot: SessionSnapshot,
  event: StoredSessionEvent,
): SessionSnapshot {
  const next: SessionSnapshot = {
    ...snapshot,
    seq: Math.max(snapshot.seq, event.seq),
    updatedAt: event.createdAt,
  };

  switch (event.type) {
    case "user":
    case "assistant":
    case "result":
      next.messages = appendMessageOnce(next.messages, event.payload);
      return next;

    case "session_status":
      return {
        ...next,
        status:
          typeof event.payload.status === "string"
            ? (event.payload.status as SessionSnapshot["status"])
            : next.status,
      };

    case "permission_request":
    case "control_request":
      next.pendingPermission = extractPendingPermission(event.payload);
      if (next.pendingPermission) {
        next.status = "requires_action";
      }
      return next;

    case "permission_response":
    case "control_response":
    case "control_cancel_request":
      return {
        ...next,
        pendingPermission: undefined,
        status: next.status === "requires_action" ? "running" : next.status,
      };

    case "task_state":
      return {
        ...next,
        taskState: event.payload,
      };

    case "automation_state":
      return {
        ...next,
        automationState: event.payload,
      };

    default:
      return next;
  }
}
```

辅助：

```ts
function appendMessageOnce(
  messages: Array<Record<string, unknown>>,
  payload: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const uuid = typeof payload.uuid === "string" ? payload.uuid : undefined;
  if (uuid && messages.some(message => message.uuid === uuid)) {
    return messages;
  }

  return [...messages, payload];
}

function extractPendingPermission(
  payload: Record<string, unknown>,
): SessionSnapshot["pendingPermission"] | undefined {
  const request = payload.request;
  if (!request || typeof request !== "object") return undefined;
  const inner = request as Record<string, unknown>;
  if (inner.subtype !== "can_use_tool") return undefined;

  return {
    requestId:
      typeof payload.request_id === "string" ? payload.request_id : "",
    toolUseId:
      typeof inner.tool_use_id === "string" ? inner.tool_use_id : undefined,
    toolName:
      typeof inner.tool_name === "string" ? inner.tool_name : "unknown",
    actionDescription:
      typeof inner.action_description === "string"
        ? inner.action_description
        : undefined,
  };
}
```

## snapshot cadence

不要每条事件都写完整 snapshot。

建议：

```txt
每 N 条事件
每次 status 变成 idle
每次 compaction boundary
每次 requires_action
进程退出前
```

Mini 可以先：

```txt
每 100 条事件写一次
idle 时写一次
truncation 前保证有 snapshot
```

实现：

```ts
export class SnapshotProjector {
  private current: SessionSnapshot;
  private eventsSinceSnapshot = 0;

  constructor(
    initial: SessionSnapshot,
    private readonly writeSnapshot: (snapshot: SessionSnapshot) => Promise<void>,
    private readonly everyEvents = 100,
  ) {
    this.current = initial;
  }

  async apply(event: StoredSessionEvent): Promise<void> {
    this.current = applyEventToSnapshot(this.current, event);
    this.eventsSinceSnapshot++;

    if (
      this.eventsSinceSnapshot >= this.everyEvents ||
      this.current.status === "idle" ||
      this.current.status === "requires_action"
    ) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    await this.writeSnapshot(this.current);
    this.eventsSinceSnapshot = 0;
  }

  getCurrent(): SessionSnapshot {
    return this.current;
  }
}
```

## 恢复路径

服务端启动时：

```txt
load sessions
load last seq per session
load latest snapshot per session
load worker epochs
load idempotency keys not expired
load delivery records
```

不要全量加载所有事件到内存。

事件按需分页读。

内存里只需要：

```txt
live subscribers
hot session cache
current worker epochs
last seq cache
recent idempotency cache
```

## replay with snapshot

客户端重连流程：

```txt
GET /events/stream with Last-Event-ID=120
server detects firstAvailableSeq=900
server sends catch_up_truncated
client GET /snapshot
client replaces local state with snapshot seq=899
client reconnects with Last-Event-ID=899
server replays seq > 899
```

注意：

```txt
snapshot seq 必须小于等于 firstAvailableSeq - 1
```

否则仍然会缺事件。

如果最新 snapshot 太新，也可以直接用最新 snapshot，然后从它的 seq 继续。

语义：

```txt
snapshot 覆盖到 seq=S
replay 返回 seq>S
```

## SSE 发送 truncation

SSE 里可以发送特殊事件：

```ts
export function encodeTruncatedFrame(input: {
  requestedSeq: number;
  firstAvailableSeq: number;
  snapshotSeq: number;
}): string {
  const data = JSON.stringify({
    requested_seq: input.requestedSeq,
    first_available_seq: input.firstAvailableSeq,
    snapshot_seq: input.snapshotSeq,
  });

  return `event: catch_up_truncated\ndata: ${data}\n\n`;
}
```

客户端收到后不要继续处理后续 event。

```txt
close stream
fetch snapshot
reconnect from snapshot seq
```

如果服务端在 truncation 后继续发普通事件，客户端可能会把缺失上下文上的增量错误套到旧状态上。

## internal_events

`CCRClient.writeInternalEvent` 已经定义了客户端协议：

```txt
POST /worker/internal-events
event_type
payload
is_compaction
agent_id
```

`readInternalEvents` 期望：

```txt
GET /worker/internal-events
data[]
next_cursor
```

`readSubagentInternalEvents` 期望：

```txt
GET /worker/internal-events?subagents=true
```

当前本地 RCS 没有这组路由。

所以 Mini 要补服务端。

存储类型：

```ts
export type InternalEvent = {
  id: string;
  sessionId: string;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  isCompaction: boolean;
  agentId?: string;
  createdAt: string;
};
```

索引：

```txt
session_id + seq
session_id + agent_id + seq
session_id + is_compaction + seq
```

## internal event append

```ts
export class InternalEventStore {
  private readonly events = new Map<string, InternalEvent[]>();
  private readonly lastSeq = new Map<string, number>();

  append(input: {
    sessionId: string;
    eventType: string;
    payload: Record<string, unknown>;
    isCompaction?: boolean;
    agentId?: string;
  }): InternalEvent {
    const seq = (this.lastSeq.get(input.sessionId) ?? 0) + 1;
    this.lastSeq.set(input.sessionId, seq);

    const event: InternalEvent = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      seq,
      eventType: input.eventType,
      payload: input.payload,
      isCompaction: input.isCompaction ?? false,
      agentId: input.agentId,
      createdAt: new Date().toISOString(),
    };

    const list = this.events.get(input.sessionId) ?? [];
    list.push(event);
    this.events.set(input.sessionId, list);
    return event;
  }
}
```

正式实现同样需要事务。

## latest compaction boundary

session resume 不应该读整个 internal event log。

`CCRClient.readInternalEvents` 的注释要求：

```txt
Returns transcript entries from the last compaction boundary
```

所以服务端要找到最新 compaction：

```ts
export function eventsFromLatestCompaction(
  events: InternalEvent[],
  agentId?: string,
): InternalEvent[] {
  const filtered = events.filter(event =>
    agentId === undefined ? !event.agentId : event.agentId === agentId,
  );

  const lastBoundaryIndex = filtered.findLastIndex(event => event.isCompaction);
  if (lastBoundaryIndex < 0) {
    return filtered;
  }

  return filtered.slice(lastBoundaryIndex);
}
```

为什么保留 boundary 本身？

因为 boundary 是 resume 的锚点。

它告诉 loader：

```txt
之前的上下文已经被 summary 替代
不要再把旧消息链全部加载回来
```

## pagination cursor

internal event GET 要分页。

不要一次返回所有。

cursor 可以简单用 seq。

```ts
export type InternalEventPage = {
  data: InternalEvent[];
  next_cursor?: string;
};

export function pageInternalEvents(
  events: InternalEvent[],
  cursor: string | undefined,
  limit: number,
): InternalEventPage {
  const afterSeq = cursor ? Number.parseInt(cursor, 10) : 0;
  const page = events.filter(event => event.seq > afterSeq).slice(0, limit);
  const last = page.at(-1);
  const hasMore =
    last !== undefined && events.some(event => event.seq > last.seq);

  return {
    data: page,
    ...(hasMore && last ? { next_cursor: String(last.seq) } : {}),
  };
}
```

不要用数组 offset。

原因：

```txt
compaction / retention 后 offset 会漂移
seq cursor 更稳定
```

## POST /worker/internal-events

路由语义：

```txt
auth worker
assert worker epoch
append events
return count
```

示例：

```ts
export async function postInternalEvents(input: {
  store: InternalEventStore;
  epochStore: WorkerEpochStore;
  sessionId: string;
  workerEpoch: number;
  events: Array<{
    event_type?: string;
    payload: Record<string, unknown>;
    is_compaction?: boolean;
    agent_id?: string;
  }>;
}): Promise<{ count: number }> {
  input.epochStore.assertCurrent(input.sessionId, input.workerEpoch);

  for (const event of input.events) {
    input.store.append({
      sessionId: input.sessionId,
      eventType: event.event_type ?? "transcript",
      payload: event.payload,
      isCompaction: event.is_compaction,
      agentId: event.agent_id,
    });
  }

  return { count: input.events.length };
}
```

注意：

```txt
internal event 不直接广播给 Web timeline
```

它用于 resume。

如果 Web 需要看到 assistant message，worker 还会写普通 session event。

## GET /worker/internal-events

```ts
export async function getInternalEvents(input: {
  store: InternalEventStore;
  sessionId: string;
  subagents?: boolean;
  cursor?: string;
  limit?: number;
}): Promise<InternalEventPage> {
  const all = input.store.list(input.sessionId);

  const scoped = input.subagents
    ? all.filter(event => event.agentId)
    : all.filter(event => !event.agentId);

  const compacted = input.subagents
    ? eventsFromLatestCompactionPerAgent(scoped)
    : eventsFromLatestCompaction(scoped);

  return pageInternalEvents(compacted, input.cursor, input.limit ?? 100);
}
```

subagent 要按 agent 分组找 latest compaction。

不能用全局最后一个 compaction。

```ts
export function eventsFromLatestCompactionPerAgent(
  events: InternalEvent[],
): InternalEvent[] {
  const byAgent = new Map<string, InternalEvent[]>();

  for (const event of events) {
    if (!event.agentId) continue;
    const list = byAgent.get(event.agentId) ?? [];
    list.push(event);
    byAgent.set(event.agentId, list);
  }

  return [...byAgent.values()].flatMap(list =>
    eventsFromLatestCompaction(list, list[0]?.agentId),
  );
}
```

最后返回前要按 `(agentId, seq)` 或 `createdAt` 排序。

客户端会再按 agent 分组写本地文件。

## local transcript 写入

本地 transcript 的设计有几个关键点。

第一，先写用户消息再进 query loop。

`QueryEngine` 里这么做是为了：

```txt
用户消息已被接收
进程在 API 响应前被杀
resume 仍然能看到这条用户消息
```

这对远程也成立。

用户提交后，只要 worker 接收并入队，就应该持久化。

第二，写入要按 session 串行。

`sessionIngress.appendSessionLog` 有 per-session sequential wrapper。

目的：

```txt
防止 parentUuid chain 被并发写乱
```

第三，写入要按 UUID 去重。

`recordTranscript` 会加载已写 UUID set，避免重复追加。

第四，compact boundary 会重置 parent chain。

`insertMessageChain` 对 compact boundary 写：

```txt
parentUuid = null
logicalParentUuid = previous parent
```

这让 resume 从 boundary 后继续。

## transcript entry 类型

`src/types/logs.ts` 里 entry 类型可以分几组。

消息链：

```txt
user
assistant
attachment
system
```

元数据：

```txt
summary
custom-title
ai-title
last-prompt
tag
agent-name
agent-color
agent-setting
mode
worktree-state
pr-link
task-summary
```

快照：

```txt
file-history-snapshot
attribution-snapshot
content-replacement
marble-origami-commit
marble-origami-snapshot
```

控制记录：

```txt
queue-operation
speculation-accept
```

Mini 不需要一口气实现全部。

但至少要支持：

```txt
TranscriptMessage
custom-title
last-prompt
file-history-snapshot
content-replacement
compact_boundary
```

## compact boundary

compaction 后，模型上下文不再需要所有旧消息。

但日志里仍然可能保留旧消息。

boundary 的作用是：

```txt
告诉 loader 从哪里恢复
告诉 UI 哪里发生了压缩
告诉 parent chain 重新锚定
```

Mini boundary：

```ts
export type CompactBoundaryPayload = {
  type: "system";
  subtype: "compact_boundary";
  uuid: string;
  compactMetadata: {
    summaryUuid: string;
    preCompactTokenCount?: number;
    postCompactTokenCount?: number;
    preservedSegment?: {
      headUuid: string;
      tailUuid: string;
      anchorUuid: string;
    };
  };
};
```

写入时：

```txt
boundary parentUuid = null
boundary logicalParentUuid = previous parent
summary message follows boundary
messagesToKeep 不推进旧 parent
```

第 59 章不要求 Mini 完整实现 preservedSegment。

但要保留字段。

否则之后很难补。

## 大 transcript 读取

本地 `readTranscriptForLoad` 的思路：

```txt
小文件直接读
大文件 chunk scan
找到最新 compact_boundary
丢弃 boundary 前的大段旧内容
保留必要 metadata
跳过超大的 attribution snapshot
只解析恢复需要的 buffer
```

Mini 可以实现一个简化版：

```ts
import { readFile } from "node:fs/promises";

export async function readTranscriptAfterLastBoundary(
  filePath: string,
): Promise<string> {
  const text = await readFile(filePath, "utf8");
  const lines = text.split("\n").filter(Boolean);
  let boundaryIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes('"compact_boundary"')) {
      boundaryIndex = i;
    }
  }

  return lines.slice(Math.max(0, boundaryIndex)).join("\n") + "\n";
}
```

这是教学版。

生产版不要对大文件 `text()` 全量读。

但 Mini 先把语义写对。

## metadata tail re-append

本地 transcript 会在退出或 compaction 前把关键 metadata 重新写到尾部。

原因：

```txt
resume 列表只读 head/tail
大文件不能每次全量解析
metadata 如果埋在中间，就会消失在 lite view 里
```

Mini 的 session snapshot 可以解决这个问题。

但如果你继续用 JSONL transcript，也要做：

```txt
last-prompt
custom-title
tag
agent-setting
mode
worktree-state
pr-link
```

尾部重写是 append，不是修改旧行。

last-wins loader 会取最后一条。

## snapshot 与 metadata 的关系

两者都存在时：

```txt
snapshot:
  Web detail 快速显示
  replay truncation 恢复

transcript metadata:
  local resume picker
  离线调试
  CLI 本地恢复
```

不要只保留 snapshot。

原因：

```txt
snapshot 是投影，可能有 bug
append-only transcript 是审计源
```

也不要只保留 transcript。

原因：

```txt
Web detail 不能每次扫大日志
replay truncation 需要快速替换状态
```

## session ingress 旧路径

`sessionIngress.appendSessionLog` 体现了一个重要旧协议：

```txt
Last-Uuid optimistic concurrency
per-session sequential append
409 adopt server last uuid
retry with backoff
```

这个设计保护的是 transcript parent chain。

Mini 如果实现远程 transcript append，可以这样：

```txt
client sends Last-Uuid
server checks last stored uuid
if mismatch:
  return 409 + x-last-uuid
client adopts x-last-uuid
client retries
```

但 CCR v2 internal events 更适合：

```txt
server allocates seq
client sends payload
compaction filtering happens server-side on read
```

两条路径不要混用同一个 endpoint。

## event store 与 internal event store 的差异

session_events：

```txt
给 Web 和 worker stream
关注 direction / sequence replay / delivery
可以截断后由 snapshot 恢复 UI
```

internal_events：

```txt
给 resume
关注 transcript payload / compaction boundary / agent_id
不能随便丢最新 compaction 后的内容
```

同一条 assistant message 通常会写两份：

```txt
session event:
  给 Web 展示

internal event:
  给 model resume
```

它们可以共享 uuid。

但不要假设一张表能满足所有查询。

## hydration

`hydrateFromCCRv2InternalEvents` 的流程：

```txt
switchSession(sessionId)
reader() foreground events
write local session jsonl
subagentReader() subagent events
group by agent_id
write each agent transcript file
return true if foreground events exist
```

Mini 需要实现同样语义：

```ts
export async function hydrateTranscriptFromInternalEvents(input: {
  sessionId: string;
  foreground: Array<{ payload: Record<string, unknown> }>;
  subagents: Array<{ agent_id?: string; payload: Record<string, unknown> }>;
  writeSessionFile: (sessionId: string, lines: string) => Promise<void>;
  writeAgentFile: (agentId: string, lines: string) => Promise<void>;
}): Promise<void> {
  await input.writeSessionFile(
    input.sessionId,
    input.foreground.map(event => JSON.stringify(event.payload)).join("\n") + "\n",
  );

  const byAgent = new Map<string, Record<string, unknown>[]>();
  for (const event of input.subagents) {
    if (!event.agent_id) continue;
    const list = byAgent.get(event.agent_id) ?? [];
    list.push(event.payload);
    byAgent.set(event.agent_id, list);
  }

  for (const [agentId, entries] of byAgent) {
    await input.writeAgentFile(
      agentId,
      entries.map(entry => JSON.stringify(entry)).join("\n") + "\n",
    );
  }
}
```

这会覆盖本地文件。

所以调用前必须确认：

```txt
这是 remote hydration
本地文件不是更权威的新版本
```

## conflict policy

持久化恢复一定会遇到冲突：

```txt
本地 transcript 有 A
远程 internal events 有 B
```

Mini 可以先采用：

```txt
remote hydrate 覆盖 local
local append 之后继续写 remote
```

但要记录：

```txt
hydrated_at
source
remote_last_seq
local_file_mtime_before_hydrate
```

更完整的策略：

```txt
如果 local 比 remote 新，提示用户选择
如果 remote 比 local 新，覆盖 local
如果两边都新增，fork session
```

本章先实现第一种。

## delivery restore

delivery ledger 持久化后，worker 重启可以知道哪些事件已处理。

但注意：

```txt
worker 进程自己的 command queue 已经没了
```

所以 `processed` 的恢复意义是：

```txt
这个 event 已经被旧 worker 接纳过
```

是否要重新执行，取决于事件类型。

建议：

```txt
user event:
  如果已经产生 assistant/result，不能重新执行
  如果只有 received/processing，没有 result，可以恢复为 pending

permission_response:
  如果 request 已关闭，忽略
  如果 pending request 仍在 snapshot，重新投递

interrupt:
  如果 turn 已结束，忽略
  如果 turn 仍 running，重新应用
```

这需要 turn ledger。

Mini 可以先保守：

```txt
重启后从 snapshot 恢复 current status
只 replay snapshotSeq 之后的 events
已在 snapshot 内的事件不再投递给 worker
```

## worker last processed seq

比 per-event delivery 更高效的是记录 worker high-water mark。

```ts
export type WorkerCursor = {
  sessionId: string;
  workerEpoch: number;
  lastReceivedSeq: number;
  lastProcessedSeq: number;
  updatedAt: string;
};
```

更新：

```txt
received event seq=N:
  lastReceivedSeq = max(lastReceivedSeq, N)

processed event seq=N:
  lastProcessedSeq = max(lastProcessedSeq, N) only if all previous relevant events processed
```

注意 filtered worker stream。

worker 只接收 `client_to_worker`。

所以 `lastProcessedSeq` 是 global seq high-water，但它可能跳过 inbound。

这没问题。

重连仍然用 global seq。

## durable worker resume

worker 重启流程：

```txt
register worker -> epoch++
GET worker state snapshot
GET internal events -> hydrate transcript
open SSE from last known worker cursor or snapshot seq
process client_to_worker events after cursor
```

如果没有 worker cursor：

```txt
从 snapshot seq 开始
```

如果没有 snapshot：

```txt
从 0 开始
```

如果 cursor 太旧：

```txt
fetch snapshot
start from snapshot seq
```

## Web history endpoint

当前 RCS `/web/sessions/:id/history` 直接返回 `bus.getEventsSince(0)`。

持久化后应该改为：

```txt
GET /history?after_seq=&limit=
GET /snapshot
GET /events stream
```

history 响应：

```ts
export type HistoryResponse =
  | {
      ok: true;
      events: StoredSessionEvent[];
      last_seq: number;
      first_available_seq: number;
    }
  | {
      ok: false;
      error: {
        type: "cursor_too_old";
        requested_seq: number;
        first_available_seq: number;
        snapshot_seq: number;
      };
    };
```

不要默认返回整个历史。

Web 初次打开建议：

```txt
GET snapshot
GET history after snapshot.seq
open SSE from last seq
```

这样大 session 不会卡死。

## snapshot first UI

Web detail 加载顺序：

```txt
1. GET /snapshot
2. render current messages/status/tasks
3. GET /history?after_seq=snapshot.seq
4. merge missed events
5. open SSE Last-Event-ID=lastSeq
```

如果没有 snapshot：

```txt
GET /history?after_seq=0&limit=initial
build local state
open SSE
```

如果 history truncates：

```txt
GET /snapshot
replace state
reconnect
```

## compaction and snapshot

compaction boundary 应该触发 snapshot。

原因：

```txt
boundary 前的事件可以被截断
snapshot seq 刚好覆盖旧上下文
resume 从 boundary 后开始
Web 从 snapshot 恢复 UI
```

流程：

```txt
worker emits compact_boundary internal event
worker emits corresponding session event or status
server stores internal compaction marker
snapshot projector flushes snapshot
retention can delete events <= snapshot.seq - retention window
```

不要先删事件再写 snapshot。

正确顺序：

```txt
append boundary
project snapshot
durably flush snapshot
then retention
```

## retention policy

保留策略：

```txt
always keep latest snapshot
always keep events after latest snapshot seq
keep some window before snapshot for debugging
keep internal events after latest compaction boundary
keep permission decisions until session archived + grace period
keep delivery records until event retention passes
```

示例：

```ts
export type RetentionPolicy = {
  keepEventsAfterLatestSnapshot: true;
  keepEventsBeforeSnapshot: number;
  keepInternalEventsAfterCompaction: true;
  archivedSessionGraceDays: number;
};
```

Mini 可以先不自动删。

但要实现 truncation 协议。

因为一旦未来加 retention，客户端不会坏。

## tombstone

`query.ts` 在 streaming fallback 时会 yield tombstone。

原因：

```txt
部分 assistant message 有无效 thinking signature
不能留在 transcript
否则 resume 或下轮 API 会失败
```

本地 `removeMessageByUuid` 会尝试从 transcript 删除。

持久化 event store 里更推荐 append tombstone：

```ts
export type TombstoneEventPayload = {
  targetUuid: string;
  reason: "streaming_fallback" | "orphaned_message" | "user_rewind";
};
```

UI snapshot projector 收到 tombstone：

```txt
messages remove targetUuid
```

internal transcript 怎么办？

两种策略：

```txt
小文件:
  直接重写删除行

append-only:
  写 transcript_tombstone internal event
  hydrate 时过滤 targetUuid
```

Mini 建议用第二种。

因为它适合远程存储。

## content replacement

大 tool result 或大内容块不能无限进上下文。

本地 transcript 里有 `content-replacement` entry。

含义：

```txt
某些 content block 在上下文中被替换成小 stub
原始内容另存
resume 时要重放替换决策
```

Mini 可以先实现简化：

```ts
export type ContentReplacementEntry = {
  type: "content-replacement";
  sessionId: string;
  replacements: Array<{
    messageUuid: string;
    blockIndex: number;
    replacementText: string;
    originalRef: string;
  }>;
};
```

这不是 UI timeline。

它是 resume metadata。

应该写 internal event 或 transcript 文件。

## file history snapshot

官方级代码 Agent 的 resume 不只恢复对话。

还要恢复：

```txt
文件历史
rewind checkpoint
attribution state
worktree state
agent setting
todo state
```

第 59 章的 Mini 至少要知道：

```txt
session snapshot 是 UI 状态
file history snapshot 是代码状态
```

不要混在一起。

类型示例：

```ts
export type FileHistorySnapshotEntry = {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: {
    files: Record<string, { contentHash: string; mtime: number }>;
  };
  isSnapshotUpdate: boolean;
};
```

resume 时按 messageId 合并。

## restore pipeline

完整恢复路径：

```txt
resolve session id
hydrate remote internal events if remote
load local transcript file
read compact boundary aware segment
parse transcript messages
apply tombstones / snip removals
build parent chain
select leaf
restore file history
restore attribution
restore context collapse store
restore todos
restore agent setting
adopt resumed session file
continue writing append-only
```

Mini 可以先：

```txt
load internal events
write local transcript
load transcript after latest compact boundary
restore messages
restore snapshots
```

## parentUuid chain

transcript 不是简单数组。

每条 message 有：

```txt
uuid
parentUuid
logicalParentUuid
```

作用：

```txt
支持 resume 到 leaf
支持 fork
支持 rewind
支持 compact boundary reset
```

Mini 如果暂时不做 fork，也建议保留字段。

```ts
export type TranscriptEntry = {
  type: "user" | "assistant" | "attachment" | "system";
  uuid: string;
  parentUuid: string | null;
  logicalParentUuid?: string | null;
  sessionId: string;
  timestamp: string;
  message?: unknown;
  subtype?: string;
};
```

append 时：

```ts
export function assignParent(
  previous: TranscriptEntry | undefined,
  entry: TranscriptEntry,
): TranscriptEntry {
  if (entry.type === "system" && entry.subtype === "compact_boundary") {
    return {
      ...entry,
      parentUuid: null,
      logicalParentUuid: previous?.uuid ?? null,
    };
  }

  return {
    ...entry,
    parentUuid: previous?.uuid ?? null,
  };
}
```

## build conversation chain

从消息 Map 里恢复当前链：

```ts
export function buildConversationChain(
  messages: Map<string, TranscriptEntry>,
  leafUuid: string,
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current = messages.get(leafUuid);

  while (current) {
    if (seen.has(current.uuid)) {
      throw new Error("parent cycle");
    }

    seen.add(current.uuid);
    out.push(current);

    if (!current.parentUuid) break;
    current = messages.get(current.parentUuid);
  }

  return out.reverse();
}
```

如果遇到 dangling parent：

```txt
不要崩溃
记录诊断
从当前可用链恢复
```

官方实现里 preserved segment relink 就是在处理更复杂的链修复。

## first prompt 和 lite session list

`sessionStoragePortable` 用 head/tail 读 session metadata。

目的：

```txt
/resume 列表不能全量解析所有大文件
```

Mini session list 应该直接从 `sessions` 表或 snapshot 表读。

如果只有 JSONL 文件，也可以：

```txt
读 head 找 first prompt
读 tail 找 title/tag/last prompt
stat 得到 modified time 和 size
```

不要每次 `/resume` 扫全文件。

## persistence boundaries

什么时候必须 flush？

```txt
用户消息 accepted 后
compact boundary 后
result 发给宿主前
进程 graceful shutdown 前
worker state idle 前
snapshot before retention
```

`QueryEngine` 在 result 前 flush 的原因：

```txt
desktop app 收到 result 后可能立刻杀进程
未 flush 的 transcript 会丢
```

Mini 也要这样做。

```ts
async function finishTurn(input: {
  flushTranscript: () => Promise<void>;
  flushEvents: () => Promise<void>;
  sendResult: () => Promise<void>;
}): Promise<void> {
  await input.flushTranscript();
  await input.flushEvents();
  await input.sendResult();
}
```

不要先发 result 再慢慢 flush。

## crash windows

设计时列出崩溃窗口。

窗口一：

```txt
user submitted
event not persisted
process crashes
```

结果：

```txt
用户消息丢
```

修复：

```txt
先 append event，再 ack submit
```

窗口二：

```txt
event persisted
worker processed
delivery not persisted
process crashes
```

结果：

```txt
可能重复处理
```

修复：

```txt
业务 handler 自身幂等
result/event uuid 去重
```

窗口三：

```txt
compact boundary persisted
snapshot not persisted
retention deletes old events
```

结果：

```txt
cursor truncation 无法恢复
```

修复：

```txt
snapshot flush 成功后才 retention
```

窗口四：

```txt
internal event persisted
session event not persisted
```

结果：

```txt
resume 可恢复，但 Web timeline 缺展示事件
```

修复：

```txt
同一事务写两类事件
或用 reconciler 补投影
```

教学版可以接受短窗口。

但要知道边界。

## transactional append

如果你用真实数据库，写 user event 最好是一个事务：

```txt
BEGIN
  assert owner
  check idempotency
  allocate seq
  insert session_event
  insert idempotency record
  update session last_seq
  update snapshot projection or enqueue projector
COMMIT
```

worker event：

```txt
BEGIN
  assert worker epoch
  check idempotency by uuid
  allocate seq
  insert session_event
  insert internal_event if transcript
  update snapshot projection
COMMIT
```

不要在事务外分配 seq。

## background projector

snapshot 可以同步写，也可以后台投影。

同步写优点：

```txt
强一致
truncation 立即有 snapshot
```

后台写优点：

```txt
append latency 低
```

Mini 推荐先同步。

后续再改后台 projector。

如果改后台，需要 checkpoint：

```ts
export type ProjectorCheckpoint = {
  projectorName: string;
  sessionId: string;
  lastProjectedSeq: number;
  updatedAt: string;
};
```

后台 projector 启动后：

```txt
read checkpoint
load events seq > checkpoint
apply
write snapshot
advance checkpoint
```

## dead letter

投影失败不能阻塞所有事件。

建议写 dead letter：

```ts
export type DeadLetterEvent = {
  id: string;
  sessionId: string;
  eventId: string;
  seq: number;
  consumer: string;
  error: string;
  createdAt: string;
};
```

Mini 可以先 log。

但接口上要留位置。

## tests: event store idempotency

```ts
import { describe, expect, test } from "bun:test";
import { InMemorySessionEventStore } from "../eventStore";

describe("SessionEventStore", () => {
  test("returns existing event for duplicate idempotency key", async () => {
    const store = new InMemorySessionEventStore();

    const first = await store.append({
      sessionId: "s1",
      direction: "client_to_worker",
      type: "user",
      idempotencyKey: "user:m1",
      payload: { uuid: "m1", content: "hello" },
    });

    const second = await store.append({
      sessionId: "s1",
      direction: "client_to_worker",
      type: "user",
      idempotencyKey: "user:m1",
      payload: { uuid: "m1", content: "hello again" },
    });

    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
  });
});
```

运行：

```bash
bun test src/reliability/__tests__/eventStore.test.ts
```

## tests: cursor truncation

```ts
test("reports cursor_too_old when requested seq fell out of retention", async () => {
  const store = new InMemorySessionEventStore(4);

  for (let i = 0; i < 10; i++) {
    await store.append({
      sessionId: "s1",
      direction: "worker_to_client",
      type: "assistant",
      idempotencyKey: `m${i}`,
      payload: { uuid: `m${i}` },
    });
  }

  const result = await store.getSince({
    sessionId: "s1",
    afterSeq: 1,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("cursor_too_old");
  }
});
```

## tests: snapshot recovery

```ts
test("rebuilds state from snapshot then replays later events", async () => {
  const snapshot = {
    sessionId: "s1",
    seq: 5,
    status: "idle" as const,
    messages: [{ uuid: "m1", content: "old" }],
    metadata: {},
    updatedAt: new Date().toISOString(),
  };

  const later = {
    id: "e6",
    sessionId: "s1",
    seq: 6,
    direction: "worker_to_client" as const,
    type: "assistant",
    payload: { uuid: "m2", content: "new" },
    createdAt: new Date().toISOString(),
  };

  const restored = applyEventToSnapshot(snapshot, later);

  expect(restored.seq).toBe(6);
  expect(restored.messages).toHaveLength(2);
});
```

## tests: internal events latest compaction

```ts
test("returns foreground internal events from latest compaction boundary", () => {
  const events = [
    { seq: 1, isCompaction: false, payload: { uuid: "old" } },
    { seq: 2, isCompaction: true, payload: { uuid: "boundary" } },
    { seq: 3, isCompaction: false, payload: { uuid: "new" } },
  ] as InternalEvent[];

  const result = eventsFromLatestCompaction(events);

  expect(result.map(event => event.seq)).toEqual([2, 3]);
});
```

## tests: subagent compaction scope

```ts
test("finds latest compaction per agent", () => {
  const events = [
    { seq: 1, agentId: "a", isCompaction: true, payload: {} },
    { seq: 2, agentId: "a", isCompaction: false, payload: { uuid: "a1" } },
    { seq: 3, agentId: "b", isCompaction: false, payload: { uuid: "b0" } },
    { seq: 4, agentId: "b", isCompaction: true, payload: {} },
    { seq: 5, agentId: "b", isCompaction: false, payload: { uuid: "b1" } },
  ] as InternalEvent[];

  const result = eventsFromLatestCompactionPerAgent(events);

  expect(result.map(event => event.seq)).toEqual([1, 2, 4, 5]);
});
```

## tests: metadata last wins

```ts
test("uses latest title metadata", () => {
  const entries = [
    { type: "custom-title", sessionId: "s1", customTitle: "old" },
    { type: "custom-title", sessionId: "s1", customTitle: "new" },
  ];

  const title = readLatestMetadata(entries, "custom-title", "customTitle");

  expect(title).toBe("new");
});
```

## tests: flush before result

```ts
test("flushes persistence before result is emitted", async () => {
  const calls: string[] = [];

  await finishTurn({
    flushTranscript: async () => {
      calls.push("flushTranscript");
    },
    flushEvents: async () => {
      calls.push("flushEvents");
    },
    sendResult: async () => {
      calls.push("sendResult");
    },
  });

  expect(calls).toEqual(["flushTranscript", "flushEvents", "sendResult"]);
});
```

## 测试矩阵

最小矩阵：

```txt
duplicate append:
  same idempotency key returns same event and seq

sequence restore:
  server restart restores last seq and next append increments

cursor replay:
  after_seq returns only later events

cursor too old:
  returns catch_up_truncated with snapshot seq

snapshot recover:
  client replaces state then replays later events

internal latest compaction:
  resume reads from last compaction boundary

subagent compaction:
  latest boundary is scoped per agent

metadata last wins:
  latest custom-title/tag/mode wins

flush before result:
  result waits for persistence flush

worker epoch persists:
  stale worker after restart still gets rejected

delivery persists:
  processed status survives restart

tombstone:
  target message is removed from projected snapshot

large transcript:
  loader skips pre-boundary stale content
```

运行：

```bash
bun test src/reliability/__tests__
bun run typecheck
```

## 本章落地顺序

推荐顺序：

```txt
1. SessionEventStore interface
2. append + idempotency + seq tests
3. getSince + cursor_too_old tests
4. SessionSnapshot projector
5. Web /snapshot endpoint
6. SSE catch_up_truncated frame
7. InternalEventStore
8. /worker/internal-events POST/GET
9. latest compaction filtering
10. hydrate transcript from internal events
11. delivery ledger persistence
12. retention policy
```

不要先做复杂数据库迁移。

先让内存 store 通过所有恢复语义测试。

然后替换底层实现。

## 和当前本地 RCS 的差距

当前已经有：

```txt
EventBus seqNum
getEventsSince
Web history endpoint
SSE Last-Event-ID
worker stream from_sequence_num
worker register epoch increment
local transcript JSONL
compact-boundary aware load
CCR v2 internal event writer client
CCR v2 internal event reader client
hydrateFromCCRv2InternalEvents client flow
session ingress Last-Uuid 旧路径
per-session sequential transcript append
```

还缺：

```txt
durable session_events store
durable internal_events store
/worker/internal-events routes
snapshot store
/web/sessions/:id/snapshot
catch_up_truncated SSE event
server-side idempotency table
delivery records table
worker cursor table
permission decision table
retention policy
restart bootstrap that restores last seq
truncation-aware Web client recovery
```

第 59 章就是这些缺口的设计图。

## 常见错误

错误一：

```txt
用 snapshot 替代 event log
```

snapshot 只是投影。

需要审计、replay、debug 时仍要 event log。

错误二：

```txt
cursor 太旧时返回空 events
```

这会让客户端以为状态是最新的。

正确是 catch_up_truncated。

错误三：

```txt
internal events 和 UI events 混用
```

UI timeline 可以截断后用 snapshot 恢复。

model transcript resume 需要 compaction boundary 语义。

错误四：

```txt
compaction 后立刻删旧 events
```

必须先写 snapshot。

错误五：

```txt
subagent resume 用全局 latest compaction
```

每个 agent 要独立边界。

错误六：

```txt
result 先发，transcript 后 flush
```

宿主可能收到 result 后杀进程。

错误七：

```txt
大 session list 全量解析 JSONL
```

应该读 snapshot 或 head/tail metadata。

## 本章完成后的能力

现在 Mini 的可靠性模型从：

```txt
进程活着时可靠
```

升级为：

```txt
进程重启后仍可恢复
```

它具备：

```txt
append-only session event store
durable sequence
durable idempotency
snapshot projection
replay truncation protocol
internal transcript events
latest compaction resume
subagent scoped history
metadata last-wins
flush-before-result
large transcript load strategy
```

这一步非常关键。

因为接近官方 Claude Code 的远程能力，不只是：

```txt
能连上
```

而是：

```txt
断了能回来
重启能恢复
历史被压缩后还能解释
多端拿旧 cursor 也不会错
```

## 和官方 Claude Code 的差距

Mini 仍然简化了很多细节：

```txt
真实数据库事务
跨进程 sequence allocator
多 region replication
event retention job
dead letter replay
snapshot schema migration
preservedSegment relink
snip removal
content block external blob store
large attribution snapshot optimization
remote/local conflict UI
fork branch leaf selection
rewind checkpoint integration
mobile offline outbox merge
```

但核心骨架已经正确：

```txt
event log 是源
snapshot 是投影
internal events 服务 resume
ledger 服务幂等
cursor 截断显式恢复
compaction boundary 是恢复锚点
```

下一章可以继续补 **远程权限决策审计、审批队列与安全回放**：让权限 prompt、审批历史、策略解释和重放审计形成一套可追责的安全层。
