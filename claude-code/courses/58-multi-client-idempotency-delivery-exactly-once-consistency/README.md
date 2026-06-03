# 第 58 章：多客户端协同、事件幂等与 exactly-once 体验

第 57 章把控制流补到了可以中断、取消、后台化：

```txt
queue
abort signal
interrupt
control_request
control_response
background task
flush before idle
```

但只要进入远程协同，新的问题立刻出现：

```txt
同一个 session 同时被 Web、CLI、移动端打开
Web 断线后重连，服务端重放历史事件
worker 断线后重连，旧 worker 还在发 heartbeat
用户重复点击 Allow，permission response 发送两次
网络超时后客户端重试，服务端收到两份 user message
SSE reconnect 同时带 Last-Event-ID 和 query cursor
桥接 transport 重建时，新消息和历史 flush 交错
移动端迟到的 permission response 抵达时，工具早已被 hook deny
后台 worker 发送 partial stream delta 后断线
多个客户端看到不同的 pending_action
```

如果只靠“消息来了就执行”，Agent 很快会坏成这样：

```txt
同一条用户消息跑两轮
同一个 tool_use 被 approve 两次
assistant message 重复进入 transcript
API 报 tool_use ids must be unique
旧 worker 把新 worker 状态覆盖成 idle
Web 端重新连接后看见旧 permission prompt
Stop 已经处理，但重放消息又触发一次 interrupt
stream 文本丢了前半段
result 先到，assistant delta 后到
```

官方级体验不是“网络刚好不重复”。

真实目标是：

```txt
传输层可以至少一次
服务端可以重放
客户端可以重试
worker 可以重启
但用户看到的是 exactly-once effect
```

也就是说：

```txt
同一件事只产生一次业务效果
同一条消息只进入一次 transcript
同一份权限只决策一次
同一个 worker epoch 只有一个活跃写入者
同一段 stream 重放后仍然能还原完整文本
同一条 delivery 状态可以重复上报，但状态只能前进
```

本章目标：

- 梳理多客户端协同里的事件身份
- 梳理 delivery ack 的语义
- 梳理 sequence replay 与 SSE reconnect
- 梳理 worker epoch 如何隔离旧 worker
- 梳理 permission response 迟到与重复处理
- 梳理 stream delta 的 full-so-far 快照
- 梳理 bridge flush gate 防止历史和实时消息交错
- 梳理 client / worker / server 三侧 dedup
- 给 Mini 增加一套 exactly-once effect 层

到本章结束，你的 Mini 会具备：

- event id
- idempotency key
- monotonic sequence
- replay cursor
- bounded event log
- delivery state machine
- worker epoch guard
- session owner guard
- pending permission registry
- late response ignore
- control cancel propagation
- stream snapshot coalescer
- bridge flush gate
- client reducer dedup
- multi-client consistency test matrix

第 57 章回答：

```txt
中断、取消、后台任务完成时，控制流如何保持一致
```

第 58 章回答：

```txt
多个客户端、断线重连、重复 delivery、迟到响应同时发生时，系统如何只产生一次业务效果
```

## 参考源码

本章参考这些真实模块：

```txt
packages/remote-control-server/src/transport/event-bus.ts
packages/remote-control-server/src/transport/sse-writer.ts
packages/remote-control-server/src/services/transport.ts
packages/remote-control-server/src/services/session.ts
packages/remote-control-server/src/store.ts
packages/remote-control-server/src/routes/v2/worker.ts
packages/remote-control-server/src/routes/v2/worker-events.ts
packages/remote-control-server/src/routes/v2/worker-events-stream.ts
src/cli/transports/ccrClient.ts
src/cli/transports/SSETransport.ts
src/cli/transports/SerialBatchEventUploader.ts
src/cli/transports/WorkerStateUploader.ts
src/cli/structuredIO.ts
src/remote/RemoteSessionManager.ts
src/remote/SessionsWebSocket.ts
src/bridge/remoteBridgeCore.ts
src/bridge/flushGate.ts
packages/acp-link/src/server.ts
packages/acp-link/src/rcs-upstream.ts
packages/remote-control-server/src/__tests__/event-bus.test.ts
packages/remote-control-server/src/__tests__/sse-writer.test.ts
packages/remote-control-server/src/__tests__/routes.test.ts
```

这些模块共同说明一件事：

```txt
可靠协同不是单点功能
它是事件身份、重放、去重、状态机和所有权的组合
```

## 先定义边界

本章使用三个层次的可靠性词汇。

第一层是 transport delivery：

```txt
event 从 A 发送到 B
B 是否收到
```

第二层是 protocol processing：

```txt
B 是否开始处理
B 是否处理完成
```

第三层是 business effect：

```txt
这个事件是否真的改变了 session
这个改变是否只发生一次
```

不要把三层混在一起。

例如：

```txt
Web permission response 被 worker 收到了两次
```

传输层效果：

```txt
received twice
```

协议层效果：

```txt
第二次被识别为 duplicate
```

业务层效果：

```txt
tool permission 只 resolve 一次
```

这就是 exactly-once effect。

不是 exactly-once delivery。

真正系统里很难保证每条网络消息只到达一次。

但可以保证：

```txt
重复到达不重复生效
乱序到达不越权生效
迟到到达不污染新状态
重连重放不破坏 transcript
```

## 事件身份矩阵

先列出所有容易混淆的 ID：

```txt
session_id
event_id
uuid
sequence_num
request_id
tool_use_id
worker_epoch
owner_uuid
agent_id
```

每个 ID 的职责不同。

```txt
session_id:
  会话边界
  所有事件都归属于它

event_id:
  单条 server event 的身份
  delivery ack 应该围绕它

uuid:
  SDK message / transcript message 的身份
  echo dedup 和 transcript dedup 依赖它

sequence_num:
  同一 session 内事件日志的单调位置
  replay cursor 依赖它

request_id:
  一次 control_request 和 control_response 的配对身份
  permission prompt 等待表依赖它

tool_use_id:
  模型发起的工具调用身份
  duplicate permission response 的业务去重依赖它

worker_epoch:
  当前 worker 代际
  防止旧 worker 写入

owner_uuid:
  Web 用户或客户端所有者
  防止其他客户端控制不属于自己的 session

agent_id:
  多 agent / ACP 场景下的 worker 身份
  子 agent 事件归属依赖它
```

很多 bug 来自拿错 ID。

错误示例：

```txt
用 request_id 去重 assistant message
用 sequence_num 判断 permission 是否重复
用 uuid 判断 worker 是否过期
用 event_id 当 transcript message id
```

正确做法：

```txt
事件日志看 event_id 和 sequence_num
消息回声看 uuid
权限等待看 request_id
权限业务去重看 tool_use_id
worker 写入看 worker_epoch
Web 控制看 owner_uuid
```

## 当前源码里的可靠性骨架

RCS 的 `EventBus` 是最小事件日志：

```txt
publish(event)
  -> seqNum 自增
  -> createdAt 记录
  -> append 到 bounded history
  -> broadcast 给 subscribers

getEventsSince(seqNum)
  -> 返回 seqNum 之后的事件
```

这个结构解决的是：

```txt
客户端断线后从哪里继续
```

`createWorkerEventStream` 只把 outbound 事件发给 worker：

```txt
direction === outbound
```

因为 worker 需要消费的是：

```txt
用户输入
权限响应
interrupt
control_request
```

worker 自己产生的 assistant / result / state 是 inbound，应该给 Web 展示，不应该再喂回 worker。

`SSETransport` 维护本地高水位：

```txt
lastSequenceNum
seenSequenceNums
```

重连时发送：

```txt
from_sequence_num=<lastSequenceNum>
Last-Event-ID: <lastSequenceNum>
```

这让 worker 不需要从头扫整个 session。

`CCRClient` 收到每个 SSE client_event 后会报告：

```txt
received
```

处理流程还可以继续报告：

```txt
processing
processed
```

当前本地 RCS 的 delivery endpoint 仍是 no-op。

这说明 Mini 目前具备接口形状，但还没有完整 delivery ledger。

第 58 章要补的就是这层。

## exactly-once effect 的核心原则

原则一：

```txt
所有外部输入都要有 idempotency key
```

如果调用方没给，就在入口生成并返回。

不要在内部每次重试都重新生成。

原则二：

```txt
先记录，再执行
```

如果先执行再记录，进程崩溃后无法知道是否已经执行。

原则三：

```txt
重复请求返回第一次结果
```

不要简单返回 conflict。

用户重试通常是因为没收到响应。

原则四：

```txt
delivery 状态只能前进
```

`processed` 不能被迟到的 `received` 覆盖。

原则五：

```txt
旧 worker 不能写新 session 状态
```

所有 worker 写入都必须带 worker_epoch。

服务端必须校验 epoch。

原则六：

```txt
权限响应既按 request_id 配对，也按 tool_use_id 去重
```

request 可能已经消失。

但 tool_use_id 可以告诉你这个工具调用是否已经被解决。

原则七：

```txt
stream 重连用快照，不依赖缺失 delta
```

文本 delta 可以累计成 full-so-far。

断线后任意一次重放都能恢复当前文本。

原则八：

```txt
历史 flush 和实时写入不能交错
```

Bridge 启动时先 flush history。

flush 期间的新消息进入 gate。

history 成功后再 drain live messages。

## Mini 的目录

本章只讲可靠性层，建议放在：

```txt
src/reliability/ids.ts
src/reliability/eventLog.ts
src/reliability/idempotencyStore.ts
src/reliability/deliveryLedger.ts
src/reliability/workerEpoch.ts
src/reliability/permissionTracker.ts
src/reliability/streamCoalescer.ts
src/reliability/flushGate.ts
src/reliability/clientReducer.ts
src/reliability/__tests__/eventLog.test.ts
src/reliability/__tests__/idempotencyStore.test.ts
src/reliability/__tests__/deliveryLedger.test.ts
src/reliability/__tests__/workerEpoch.test.ts
src/reliability/__tests__/permissionTracker.test.ts
src/reliability/__tests__/streamCoalescer.test.ts
```

如果你的 Mini 还没有 `src/reliability`，可以新建。

## 统一事件类型

先定义事件层。

```ts
export type EventDirection = "client_to_worker" | "worker_to_client";

export type SessionEvent = {
  id: string;
  sessionId: string;
  type: string;
  direction: EventDirection;
  payload: Record<string, unknown>;
  seq: number;
  createdAt: number;
  idempotencyKey?: string;
  sourceClientId?: string;
  workerEpoch?: number;
};

export type PublishInput = {
  id?: string;
  sessionId: string;
  type: string;
  direction: EventDirection;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  sourceClientId?: string;
  workerEpoch?: number;
};
```

注意：

```txt
id 是事件身份
idempotencyKey 是调用身份
seq 是日志位置
```

它们不是同一个东西。

## ID 工具

Mini 可以先用 `crypto.randomUUID()`。

```ts
import { randomUUID } from "node:crypto";

export function createEventId(): string {
  return `evt_${randomUUID()}`;
}

export function createMessageUuid(): string {
  return randomUUID();
}

export function createRequestId(): string {
  return `req_${randomUUID()}`;
}

export function normalizeIdempotencyKey(input: {
  sessionId: string;
  sourceClientId?: string;
  idempotencyKey?: string;
  fallbackUuid?: string;
}): string {
  if (input.idempotencyKey) {
    return `${input.sessionId}:${input.idempotencyKey}`;
  }

  if (input.fallbackUuid) {
    return `${input.sessionId}:uuid:${input.fallbackUuid}`;
  }

  return `${input.sessionId}:generated:${randomUUID()}`;
}
```

这里故意把 `sessionId` 放进 key。

否则两个 session 的客户端都发：

```txt
idempotency-key: submit-1
```

会互相污染。

## 事件日志

Mini 的事件日志需要做四件事：

```txt
分配 seq
保存 bounded history
按 seq replay
按 idempotency key 返回已有事件
```

实现：

```ts
import { createEventId, normalizeIdempotencyKey } from "./ids";
import type { PublishInput, SessionEvent } from "./types";

export class EventLog {
  private seq = 0;
  private events: SessionEvent[] = [];
  private readonly byIdempotencyKey = new Map<string, SessionEvent>();
  private readonly subscribers = new Set<(event: SessionEvent) => void>();

  constructor(private readonly maxEvents = 5000) {}

  publish(input: PublishInput): SessionEvent {
    const normalizedKey = normalizeIdempotencyKey({
      sessionId: input.sessionId,
      sourceClientId: input.sourceClientId,
      idempotencyKey: input.idempotencyKey,
      fallbackUuid:
        typeof input.payload.uuid === "string" ? input.payload.uuid : undefined,
    });

    const existing = this.byIdempotencyKey.get(normalizedKey);
    if (existing) {
      return existing;
    }

    const event: SessionEvent = {
      id: input.id ?? createEventId(),
      sessionId: input.sessionId,
      type: input.type,
      direction: input.direction,
      payload: input.payload,
      seq: ++this.seq,
      createdAt: Date.now(),
      idempotencyKey: normalizedKey,
      sourceClientId: input.sourceClientId,
      workerEpoch: input.workerEpoch,
    };

    this.events.push(event);
    this.byIdempotencyKey.set(normalizedKey, event);
    this.trim();

    for (const subscriber of this.subscribers) {
      subscriber(event);
    }

    return event;
  }

  getSince(seq: number, direction?: SessionEvent["direction"]): SessionEvent[] {
    return this.events.filter(event => {
      if (event.seq <= seq) return false;
      if (direction && event.direction !== direction) return false;
      return true;
    });
  }

  getLastSeq(): number {
    return this.seq;
  }

  subscribe(callback: (event: SessionEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private trim(): void {
    if (this.events.length <= this.maxEvents) return;
    const keepFrom = Math.floor(this.maxEvents / 2);
    const removed = this.events.splice(0, this.events.length - keepFrom);
    for (const event of removed) {
      if (event.idempotencyKey) {
        this.byIdempotencyKey.delete(event.idempotencyKey);
      }
    }
  }
}
```

这个实现是内存版。

生产版需要持久化。

但内存版足够说明语义。

## bounded history 的取舍

真实服务不能无限保存事件。

所以 `EventBus` 会保留 bounded history。

这带来一个边界：

```txt
客户端带 seq=10 重连
服务端最早只剩 seq=200
```

这时不能假装正常 replay。

应该返回一个特殊信号：

```txt
catch_up_truncated
```

或者要求客户端全量刷新 session snapshot。

Mini 可以先加这个方法：

```ts
export type ReplayResult =
  | { ok: true; events: SessionEvent[] }
  | { ok: false; reason: "cursor_too_old"; firstAvailableSeq: number };

export class ReplayableEventLog extends EventLog {
  replayFrom(seq: number): ReplayResult {
    const events = this.getSince(seq);
    const first = events[0];

    if (seq > 0 && first && first.seq > seq + 1) {
      return {
        ok: false,
        reason: "cursor_too_old",
        firstAvailableSeq: first.seq,
      };
    }

    return { ok: true, events };
  }
}
```

更严谨的做法是记录：

```txt
firstAvailableSeq
lastSeq
```

而不是从返回事件推断。

## SSE replay

SSE 帧要带 `id`。

```ts
export function encodeSseFrame(event: SessionEvent): string {
  const data = JSON.stringify({
    event_id: event.id,
    sequence_num: event.seq,
    event_type: event.type,
    source: event.direction,
    payload: event.payload,
    created_at: new Date(event.createdAt).toISOString(),
  });

  return `id: ${event.seq}\nevent: client_event\ndata: ${data}\n\n`;
}
```

服务端读取 cursor：

```ts
export function parseReplayCursor(headers: Headers, url: URL): number {
  const fromQuery = url.searchParams.get("from_sequence_num");
  const fromHeader = headers.get("Last-Event-ID");
  const raw = fromQuery ?? fromHeader ?? "0";
  const seq = Number.parseInt(raw, 10);

  if (!Number.isFinite(seq) || seq < 0) {
    return 0;
  }

  return seq;
}
```

注意优先级。

如果客户端同时传 query 和 header，Mini 应该明确选择一种。

官方实现里两者都支持，目的是兼容不同 SSE 客户端。

## worker SSE stream

worker stream 只应该推送 client-to-worker 方向。

```ts
export function createWorkerReplay(
  log: EventLog,
  fromSeq: number,
): SessionEvent[] {
  return log.getSince(fromSeq, "client_to_worker");
}
```

原因：

```txt
worker_to_client 是 worker 自己写出来的结果
重放给 worker 会造成回声
```

常见错误：

```txt
worker 连接后收到自己上一轮 assistant message
StructuredIO 把它当用户输入
下一轮模型上下文重复
```

## client stream

Web / mobile client stream 通常需要两个方向：

```txt
worker_to_client:
  assistant
  stream_event
  result
  session_status
  automation_state

client_to_worker:
  user echo
  permission_response echo
  interrupt echo
```

是否显示 echo 要看客户端 reducer。

如果客户端已经本地 optimistic insert 了 user message，服务端 echo 到达时必须按 uuid dedup。

## 客户端 reducer 去重

UI reducer 不应该只 append。

它应该维护：

```txt
seenEventIds
seenMessageUuids
lastSeq
```

实现：

```ts
type ClientState = {
  lastSeq: number;
  seenEventIds: Set<string>;
  seenMessageUuids: Set<string>;
  messages: Array<Record<string, unknown>>;
};

export function applyRemoteEvent(
  state: ClientState,
  event: {
    event_id: string;
    sequence_num: number;
    payload: Record<string, unknown>;
  },
): ClientState {
  if (state.seenEventIds.has(event.event_id)) {
    return state;
  }

  const uuid =
    typeof event.payload.uuid === "string" ? event.payload.uuid : undefined;

  if (uuid && state.seenMessageUuids.has(uuid)) {
    return {
      ...state,
      lastSeq: Math.max(state.lastSeq, event.sequence_num),
      seenEventIds: new Set([...state.seenEventIds, event.event_id]),
    };
  }

  return {
    lastSeq: Math.max(state.lastSeq, event.sequence_num),
    seenEventIds: new Set([...state.seenEventIds, event.event_id]),
    seenMessageUuids: uuid
      ? new Set([...state.seenMessageUuids, uuid])
      : state.seenMessageUuids,
    messages: [...state.messages, event.payload],
  };
}
```

两个去重集合都需要。

`event_id` 解决：

```txt
同一个 server event 被 replay 两次
```

`uuid` 解决：

```txt
同一条 SDK message 通过两个 event 回声回来
```

## delivery ledger

`CCRClient` 已经会上报 delivery。

Mini 需要把 no-op endpoint 改成 ledger。

状态枚举：

```ts
export type DeliveryStatus = "received" | "processing" | "processed";

const deliveryRank: Record<DeliveryStatus, number> = {
  received: 1,
  processing: 2,
  processed: 3,
};

export type DeliveryRecord = {
  sessionId: string;
  eventId: string;
  workerEpoch: number;
  status: DeliveryStatus;
  updatedAt: number;
};
```

状态只能前进：

```ts
export class DeliveryLedger {
  private readonly records = new Map<string, DeliveryRecord>();

  update(input: {
    sessionId: string;
    eventId: string;
    workerEpoch: number;
    status: DeliveryStatus;
  }): DeliveryRecord {
    const key = `${input.sessionId}:${input.eventId}`;
    const existing = this.records.get(key);

    if (existing) {
      if (deliveryRank[input.status] <= deliveryRank[existing.status]) {
        return existing;
      }

      const next: DeliveryRecord = {
        ...existing,
        workerEpoch: input.workerEpoch,
        status: input.status,
        updatedAt: Date.now(),
      };
      this.records.set(key, next);
      return next;
    }

    const record: DeliveryRecord = {
      sessionId: input.sessionId,
      eventId: input.eventId,
      workerEpoch: input.workerEpoch,
      status: input.status,
      updatedAt: Date.now(),
    };

    this.records.set(key, record);
    return record;
  }

  get(sessionId: string, eventId: string): DeliveryRecord | undefined {
    return this.records.get(`${sessionId}:${eventId}`);
  }
}
```

这样重复上报不会污染状态。

例如：

```txt
received
processing
processed
received
```

最终仍然是：

```txt
processed
```

## delivery 不等于业务完成

`processed` 的含义必须定义清楚。

建议：

```txt
received:
  worker 从 stream 读到事件

processing:
  worker 已经把事件交给 StructuredIO 或 command queue

processed:
  worker 已经完成该事件的同步处理边界
```

对于 user message，`processed` 不一定表示模型已经回复完。

它只表示：

```txt
这条 user event 已进入 worker 的命令队列
不会因为 replay 再次入队
```

如果要表达模型 turn 完成，用另一个事件：

```txt
result
turn_completed
session_status idle
```

不要把 delivery ledger 当 turn ledger。

## idempotency store

事件日志的 `byIdempotencyKey` 是短期去重。

更通用的是 idempotency store：

```ts
export type IdempotencyRecord<T> = {
  key: string;
  status: "in_progress" | "completed" | "failed";
  result?: T;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export class IdempotencyStore<T> {
  private readonly records = new Map<string, IdempotencyRecord<T>>();

  begin(key: string): IdempotencyRecord<T> {
    const existing = this.records.get(key);
    if (existing) return existing;

    const record: IdempotencyRecord<T> = {
      key,
      status: "in_progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.records.set(key, record);
    return record;
  }

  complete(key: string, result: T): IdempotencyRecord<T> {
    const existing = this.records.get(key);
    const record: IdempotencyRecord<T> = {
      key,
      status: "completed",
      result,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.records.set(key, record);
    return record;
  }

  fail(key: string, error: string): IdempotencyRecord<T> {
    const existing = this.records.get(key);
    const record: IdempotencyRecord<T> = {
      key,
      status: "failed",
      error,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.records.set(key, record);
    return record;
  }

  get(key: string): IdempotencyRecord<T> | undefined {
    return this.records.get(key);
  }
}
```

再包装一个 helper：

```ts
export async function runOnce<T>(
  store: IdempotencyStore<T>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = store.get(key);

  if (existing?.status === "completed" && existing.result !== undefined) {
    return existing.result;
  }

  if (existing?.status === "in_progress") {
    throw new Error("request already in progress");
  }

  store.begin(key);

  try {
    const result = await fn();
    store.complete(key, result);
    return result;
  } catch (error) {
    store.fail(key, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
```

这个简单版本遇到 concurrent duplicate 会抛错。

更好的版本会等待同一个 promise。

## in-flight singleflight

同一个 key 并发到达时，不应该执行两次。

```ts
export class Singleflight {
  private readonly flights = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.flights.delete(key);
    });

    this.flights.set(key, promise);
    return promise;
  }
}
```

把它和 idempotency store 合起来：

```ts
export async function runOnceSingleflight<T>(
  store: IdempotencyStore<T>,
  flights: Singleflight,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = store.get(key);
  if (existing?.status === "completed" && existing.result !== undefined) {
    return existing.result;
  }

  return flights.run(key, async () => {
    const current = store.get(key);
    if (current?.status === "completed" && current.result !== undefined) {
      return current.result;
    }

    store.begin(key);
    const result = await fn();
    store.complete(key, result);
    return result;
  });
}
```

这适合：

```txt
POST /web/sessions/:id/messages
POST /web/sessions/:id/control
POST /worker/events
```

## worker epoch

源码里 `/worker/register` 会递增 epoch。

`CCRClient` 初始化时必须拿到 epoch。

之后每次 worker 写入都带：

```txt
worker_epoch
```

遇到 409 时，CLI worker 认为自己已经被替换，应该退出。

Mini 服务端也要补 epoch guard。

```ts
export type WorkerEpochState = {
  currentEpoch: number;
};

export class WorkerEpochStore {
  private readonly sessions = new Map<string, WorkerEpochState>();

  register(sessionId: string): number {
    const current = this.sessions.get(sessionId)?.currentEpoch ?? 0;
    const next = current + 1;
    this.sessions.set(sessionId, { currentEpoch: next });
    return next;
  }

  assertCurrent(sessionId: string, epoch: number): void {
    const current = this.sessions.get(sessionId)?.currentEpoch ?? 0;
    if (epoch !== current) {
      throw new StaleWorkerEpochError(sessionId, epoch, current);
    }
  }
}

export class StaleWorkerEpochError extends Error {
  constructor(
    readonly sessionId: string,
    readonly receivedEpoch: number,
    readonly currentEpoch: number,
  ) {
    super(
      `stale worker epoch for ${sessionId}: got ${receivedEpoch}, current ${currentEpoch}`,
    );
  }
}
```

路由里：

```ts
try {
  workerEpochStore.assertCurrent(sessionId, body.worker_epoch);
} catch (error) {
  if (error instanceof StaleWorkerEpochError) {
    return Response.json(
      {
        error: {
          type: "epoch_mismatch",
          message: "worker epoch is stale",
          current_epoch: error.currentEpoch,
        },
      },
      { status: 409 },
    );
  }

  throw error;
}
```

这条 guard 应该覆盖：

```txt
PUT /worker
POST /worker/heartbeat
POST /worker/events
POST /worker/internal-events
POST /worker/events/delivery
```

否则旧 worker 仍然可能：

```txt
把 session_status 写回 idle
把 stale assistant event 发给 Web
把 delivery 状态覆盖
继续 heartbeat 导致 Web 误以为旧 worker 还健康
```

## 为什么 epoch 不是 lock

epoch 不是互斥锁。

它是代际 fencing token。

区别：

```txt
lock:
  谁拿到锁谁写
  锁可能超时
  锁释放后别人写

epoch:
  新 worker 注册后 epoch 增加
  老 worker 即使还活着，也永远写不进去
  写入时服务端校验 epoch
```

这更适合分布式 worker。

因为旧 worker 可能：

```txt
网络分区
进程卡住
定时器延迟
恢复后继续发送旧请求
```

epoch guard 可以挡住它。

## session owner

Web 多客户端还需要 owner guard。

源码里的 `resolveOwnedWebSessionId` 会处理：

```txt
session_ 前缀
cse_ 前缀
owner uuid
orphan session auto-bind
```

Mini 可以实现：

```ts
export class SessionOwnerStore {
  private readonly owners = new Map<string, string>();

  bindIfEmpty(sessionId: string, ownerUuid: string): void {
    const existing = this.owners.get(sessionId);
    if (!existing) {
      this.owners.set(sessionId, ownerUuid);
      return;
    }

    if (existing !== ownerUuid) {
      throw new Error("session belongs to another owner");
    }
  }

  assertOwner(sessionId: string, ownerUuid: string): void {
    const existing = this.owners.get(sessionId);
    if (!existing) {
      this.owners.set(sessionId, ownerUuid);
      return;
    }

    if (existing !== ownerUuid) {
      throw new Error("forbidden");
    }
  }
}
```

所有 Web 控制接口都要调用：

```txt
message
control
interrupt
archive
resume
```

否则一个客户端只要知道 session id，就能影响别人的 session。

## permission tracker

`StructuredIO` 的做法很关键：

```txt
pendingRequests: request_id -> resolver
resolvedToolUseIds: bounded set
```

正常响应：

```txt
request_id 命中 pending
resolve
delete pending
track tool_use_id
```

迟到响应：

```txt
request_id 已不存在
检查 tool_use_id 是否已经 resolved
如果已 resolved，忽略
```

Mini 实现：

```ts
export type PermissionRequest = {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: number;
};

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

export class PermissionTracker {
  private readonly pending = new Map<string, PermissionRequest>();
  private readonly resolvedToolUseIds = new Set<string>();

  add(request: Omit<PermissionRequest, "createdAt">): PermissionRequest {
    const full = { ...request, createdAt: Date.now() };
    this.pending.set(request.requestId, full);
    return full;
  }

  resolve(
    requestId: string,
    decision: PermissionDecision,
  ):
    | { ok: true; request: PermissionRequest; decision: PermissionDecision }
    | { ok: false; reason: "duplicate" | "unknown" } {
    const request = this.pending.get(requestId);

    if (!request) {
      return { ok: false, reason: "unknown" };
    }

    this.pending.delete(requestId);
    this.resolvedToolUseIds.add(request.toolUseId);

    return { ok: true, request, decision };
  }

  markResolvedToolUse(toolUseId: string): void {
    this.resolvedToolUseIds.add(toolUseId);
  }

  isResolvedToolUse(toolUseId: string): boolean {
    return this.resolvedToolUseIds.has(toolUseId);
  }

  cancel(requestId: string): PermissionRequest | undefined {
    const request = this.pending.get(requestId);
    if (!request) return undefined;
    this.pending.delete(requestId);
    this.resolvedToolUseIds.add(request.toolUseId);
    return request;
  }
}
```

实际处理 response 时：

```ts
export function handlePermissionResponse(input: {
  tracker: PermissionTracker;
  requestId: string;
  toolUseId?: string;
  decision: PermissionDecision;
}): "resolved" | "duplicate" | "unknown" {
  const result = input.tracker.resolve(input.requestId, input.decision);

  if (result.ok) {
    return "resolved";
  }

  if (input.toolUseId && input.tracker.isResolvedToolUse(input.toolUseId)) {
    return "duplicate";
  }

  return "unknown";
}
```

为什么还要返回 `unknown`？

因为真正未知可能意味着：

```txt
客户端响应了一个不存在的 request
服务端和 worker 状态不同步
恶意客户端伪造 request_id
```

这不应该静默当成功。

## control cancel

权限有两个方向的取消。

方向一：

```txt
SDK host 决策了
bridge 要取消 Web 上的 prompt
```

方向二：

```txt
Web 决策了
StructuredIO 要取消 SDK host 的 prompt
```

源码里 `injectControlResponse` 会写：

```txt
control_cancel_request
```

原因：

```txt
否则 SDK consumer 的 canUseTool callback 会一直挂着
```

Mini 的规则：

```txt
只要某一侧赢得 permission race
另一侧必须收到 cancel
```

实现：

```ts
export type ControlCancelRequest = {
  type: "control_cancel_request";
  request_id: string;
};

export function createControlCancelRequest(
  requestId: string,
): ControlCancelRequest {
  return {
    type: "control_cancel_request",
    request_id: requestId,
  };
}
```

客户端收到 cancel：

```ts
export function applyPermissionCancel(
  pending: Map<string, PermissionRequest>,
  requestId: string,
): PermissionRequest | undefined {
  const request = pending.get(requestId);
  if (!request) return undefined;
  pending.delete(requestId);
  return request;
}
```

UI 必须关闭弹窗。

如果用户随后点击旧弹窗按钮，response 应该被 ignored。

## stream full-so-far

普通 stream delta 是脆弱的。

例如：

```txt
delta: "hel"
delta: "lo"
```

如果客户端只收到第二个：

```txt
"lo"
```

文本就坏了。

源码里的 `accumulateStreamEvents` 会把 text delta 合并成 full-so-far 快照。

Mini 可以实现：

```ts
type TextDeltaEvent = {
  type: "stream_event";
  message_id: string;
  content_block_index: number;
  delta: { type: "text_delta"; text: string };
};

type TextSnapshotEvent = {
  type: "stream_event";
  message_id: string;
  content_block_index: number;
  delta: { type: "text_delta"; text: string };
  snapshot: true;
};

export class StreamCoalescer {
  private readonly textByBlock = new Map<string, string>();

  coalesce(event: TextDeltaEvent): TextSnapshotEvent {
    const key = `${event.message_id}:${event.content_block_index}`;
    const previous = this.textByBlock.get(key) ?? "";
    const next = previous + event.delta.text;
    this.textByBlock.set(key, next);

    return {
      ...event,
      delta: {
        type: "text_delta",
        text: next,
      },
      snapshot: true,
    };
  }

  clearMessage(messageId: string): void {
    for (const key of this.textByBlock.keys()) {
      if (key.startsWith(`${messageId}:`)) {
        this.textByBlock.delete(key);
      }
    }
  }
}
```

下游 reducer 收到 snapshot 后应该 replace，而不是 append。

```ts
export function applyTextSnapshot(
  blocks: Map<string, string>,
  event: TextSnapshotEvent,
): void {
  const key = `${event.message_id}:${event.content_block_index}`;
  blocks.set(key, event.delta.text);
}
```

这样即使 replay 只带最后一条：

```txt
snapshot: "hello"
```

客户端仍然能恢复完整文本。

## ordered uploader

`SerialBatchEventUploader` 的设计是：

```txt
pending queue
single in-flight POST
batch
retry
backpressure
flush
close drops pending
```

这解决：

```txt
assistant event 与 result event 顺序
stream flush 与 non-stream message 顺序
shutdown 前尽量 drain
```

Mini 不要让多个 POST 并发写同一个 session event log。

否则可能出现：

```txt
result seq=10
assistant final seq=11
```

UI 会先看到 turn 结束，再看到最终 assistant。

简单 uploader：

```ts
export class OrderedUploader<T> {
  private pending: T[] = [];
  private draining = false;

  constructor(
    private readonly sendBatch: (items: T[]) => Promise<void>,
    private readonly maxBatchSize = 20,
  ) {}

  enqueue(item: T): void {
    this.pending.push(item);
    void this.drain();
  }

  async flush(): Promise<void> {
    while (this.pending.length > 0 || this.draining) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0, this.maxBatchSize);
        await this.sendBatch(batch);
      }
    } finally {
      this.draining = false;
    }
  }
}
```

生产版需要：

```txt
retry with backoff
max queue size
flush waiters
close behavior
batch byte limit
drop diagnostics
```

但最重要的是：

```txt
同一 session 同一方向，只允许一个 in-flight write
```

## state uploader

worker 状态更新不需要排队所有历史。

它需要 coalesce。

例如：

```txt
running
requires_action
running
idle
```

如果网络很慢，发送中间所有状态不一定有意义。

但 metadata merge 必须安全。

Mini 可以这样：

```ts
export function mergeWorkerPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (
      key === "external_metadata" &&
      value &&
      typeof value === "object" &&
      merged.external_metadata &&
      typeof merged.external_metadata === "object"
    ) {
      merged.external_metadata = {
        ...(merged.external_metadata as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
      continue;
    }

    merged[key] = value;
  }

  return merged;
}
```

注意 null 的语义。

如果约定：

```txt
null means delete
```

那就不能在 merge 时过滤 null。

源码里保留 null，让服务端决定删除。

## bridge flush gate

Bridge 启动时会做历史 flush。

期间如果用户又输入了新消息，不能直接 POST。

否则服务端可能看到：

```txt
live message
old history
```

正确顺序是：

```txt
old history
live message
```

Mini 的 flush gate：

```ts
export class FlushGate<T> {
  private active = false;
  private pending: T[] = [];

  start(): void {
    this.active = true;
  }

  enqueue(...items: T[]): boolean {
    if (!this.active) return false;
    this.pending.push(...items);
    return true;
  }

  end(): T[] {
    this.active = false;
    return this.pending.splice(0);
  }

  drop(): T[] {
    this.active = false;
    return this.pending.splice(0);
  }
}
```

使用：

```ts
const gate = new FlushGate<Message>();

async function startBridge(history: Message[]): Promise<void> {
  gate.start();
  try {
    await writeBatch(history);
  } finally {
    const queued = gate.end();
    if (queued.length > 0) {
      await writeBatch(queued);
    }
  }
}

function writeLive(messages: Message[]): void {
  if (gate.enqueue(...messages)) {
    return;
  }

  void writeBatch(messages);
}
```

transport 重建时也要 gate。

原因：

```txt
旧 transport epoch 即将失效
写到旧 transport 可能 silently drop
```

所以 rebuild 开始时：

```txt
gate.start()
close old transport
create new transport with last seq
connect
drain gate through new transport
```

## echo dedup

Bridge POST 出去的消息会从读流回来。

如果不 dedup，CLI 会看到自己的消息。

源码使用 bounded UUID set：

```txt
recentPostedUUIDs
initialMessageUUIDs
recentInboundUUIDs
```

Mini 实现：

```ts
export class BoundedSet {
  private readonly values = new Set<string>();

  constructor(private readonly maxSize: number) {}

  add(value: string): void {
    if (this.values.has(value)) {
      return;
    }

    this.values.add(value);

    if (this.values.size > this.maxSize) {
      const first = this.values.values().next().value;
      if (typeof first === "string") {
        this.values.delete(first);
      }
    }
  }

  has(value: string): boolean {
    return this.values.has(value);
  }
}
```

使用：

```ts
const recentPosted = new BoundedSet(2000);

function writeMessage(message: { uuid: string }): void {
  recentPosted.add(message.uuid);
  send(message);
}

function onRemoteMessage(message: { uuid?: string }): void {
  if (message.uuid && recentPosted.has(message.uuid)) {
    return;
  }

  applyMessage(message);
}
```

为什么 initialMessageUUIDs 不用 bounded？

因为历史 flush 的初始消息很重要。

它们可能在长会话里被 bounded set 淘汰。

保留一份 unbounded 初始集合可以防御初始化回声。

Mini 可以先不做这个优化，但要知道原因。

## 多客户端 command race

一个常见场景：

```txt
Web A 打开 permission prompt
Web B 也打开同一个 session
A 点击 Allow
B 也点击 Allow
```

服务端会收到两份 response。

正确结果：

```txt
第一份 resolve
第二份返回 duplicate 或 ignored
worker 只收到一个有效 control_response
UI 两边都关闭 prompt
```

服务端处理策略：

```ts
export class PermissionDecisionLedger {
  private readonly decisions = new Map<string, PermissionDecision>();

  decide(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ): { first: boolean; decision: PermissionDecision } {
    const key = `${sessionId}:${requestId}`;
    const existing = this.decisions.get(key);

    if (existing) {
      return { first: false, decision: existing };
    }

    this.decisions.set(key, decision);
    return { first: true, decision };
  }
}
```

路由：

```ts
const result = permissionDecisionLedger.decide(
  sessionId,
  body.request_id,
  body.decision,
);

if (!result.first) {
  return Response.json({
    status: "duplicate",
    decision: result.decision,
  });
}

eventLog.publish({
  sessionId,
  type: "permission_response",
  direction: "client_to_worker",
  payload: body,
  idempotencyKey: `permission:${body.request_id}`,
});
```

这让重复点击不重复入 event log。

## interrupt 幂等

Stop 按钮也会重复。

interrupt 的业务效果是：

```txt
取消当前 turn
```

如果当前 turn 已经取消，重复 interrupt 应该 no-op。

不要让重复 interrupt 取消下一轮。

所以 interrupt 需要绑定 turn id。

```ts
export type InterruptPayload = {
  type: "interrupt";
  turnId: string;
  reason?: string;
};
```

处理：

```ts
export class InterruptLedger {
  private readonly interruptedTurns = new Set<string>();

  interrupt(turnId: string): "first" | "duplicate" {
    if (this.interruptedTurns.has(turnId)) {
      return "duplicate";
    }

    this.interruptedTurns.add(turnId);
    return "first";
  }
}
```

如果你的 Mini 还没有 turn id，可以用当前 run id。

不要只用 session id。

否则一次 Stop 会影响后续 turn。

## reconnect 策略

`SSETransport` 的策略包括：

```txt
permanent HTTP code 直接关闭
临时错误进入 reconnect
指数退避
jitter
总时间预算
liveness timeout
Last-Event-ID
seenSequenceNums
```

Mini 的简化策略：

```ts
export type ReconnectPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  maxElapsedMs: number;
  jitterRatio: number;
};

export function computeReconnectDelay(
  attempt: number,
  policy: ReconnectPolicy,
): number {
  const base = Math.min(
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
    policy.maxDelayMs,
  );

  const jitter = base * policy.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
```

建议默认：

```txt
baseDelayMs: 1000
maxDelayMs: 30000
maxElapsedMs: 600000
jitterRatio: 0.25
```

这些数值不是魔法。

它们表达的是：

```txt
短暂网络抖动快速恢复
长时间断网不要热循环
多客户端同时恢复不要一起打爆服务端
```

## WebSocket viewer 重连

`SessionsWebSocket` 是远程 viewer 侧。

它维护：

```txt
connected
closed
reconnectAttempts
sessionNotFoundRetries
ping interval
permanent close code
```

要点：

```txt
临时 close 尝试重连
unauthorized 直接终止
session not found 有小重试窗口
close 时清理 ping 和 reconnect timer
```

Mini 的 WebSocket viewer 可以不做完整协议。

但至少要有：

```txt
fresh auth per reconnect
bounded reconnect attempts
ping or liveness
pending permission 清理
```

否则 viewer 看起来在线，实际已经收不到事件。

## ACP pending permission

ACP link 的权限请求也有同样模式：

```txt
pendingPermissions map
timeout
response resolve
disconnect cancel
cancel request cancel
```

Mini 可以抽象成通用 pending request table：

```ts
export type PendingRequest<T> = {
  id: string;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class PendingRequestTable<T> {
  private readonly pending = new Map<string, PendingRequest<T>>();

  add(id: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("request timed out"));
      }, timeoutMs);

      this.pending.set(id, { id, resolve, reject, timeout });
    });
  }

  resolve(id: string, value: T): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.resolve(value);
    return true;
  }

  cancelAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }

    this.pending.clear();
  }
}
```

用在：

```txt
permission prompt
elicitation
hook callback
remote request-response
```

## 服务端路由设计

Mini 的关键路由：

```txt
POST /sessions/:id/events
GET  /sessions/:id/events/stream
GET  /sessions/:id/worker/events/stream
POST /sessions/:id/worker/events
POST /sessions/:id/worker/events/delivery
POST /sessions/:id/worker/register
PUT  /sessions/:id/worker
POST /sessions/:id/worker/heartbeat
POST /sessions/:id/control
POST /sessions/:id/interrupt
```

每个路由需要的 guard：

```txt
Web routes:
  session owner
  idempotency key
  request schema

Worker write routes:
  worker auth
  worker epoch
  request schema

Stream routes:
  auth
  cursor parse
  direction filter
```

路由不是业务逻辑的家。

路由只做：

```txt
parse
auth
guard
delegate
format response
```

幂等、epoch、delivery、permission 都应该在 service 层。

## POST user message

Web 发送用户消息：

```ts
export async function postUserMessage(input: {
  eventLog: EventLog;
  ownerStore: SessionOwnerStore;
  sessionId: string;
  ownerUuid: string;
  content: string;
  uuid: string;
  idempotencyKey?: string;
}): Promise<SessionEvent> {
  input.ownerStore.assertOwner(input.sessionId, input.ownerUuid);

  return input.eventLog.publish({
    sessionId: input.sessionId,
    type: "user",
    direction: "client_to_worker",
    idempotencyKey: input.idempotencyKey ?? `user:${input.uuid}`,
    sourceClientId: input.ownerUuid,
    payload: {
      type: "user",
      uuid: input.uuid,
      message: {
        role: "user",
        content: input.content,
      },
    },
  });
}
```

重复提交同一个 uuid：

```txt
返回第一次 event
不追加第二条 event
不触发第二轮 worker drain
```

## POST worker events

worker 写 assistant event：

```ts
export async function postWorkerEvents(input: {
  eventLog: EventLog;
  epochStore: WorkerEpochStore;
  sessionId: string;
  workerEpoch: number;
  events: Array<Record<string, unknown>>;
}): Promise<SessionEvent[]> {
  input.epochStore.assertCurrent(input.sessionId, input.workerEpoch);

  return input.events.map(event => {
    const type = typeof event.type === "string" ? event.type : "message";
    const uuid = typeof event.uuid === "string" ? event.uuid : undefined;

    return input.eventLog.publish({
      sessionId: input.sessionId,
      type,
      direction: "worker_to_client",
      workerEpoch: input.workerEpoch,
      idempotencyKey: uuid ? `worker:${uuid}` : undefined,
      payload: event,
    });
  });
}
```

注意：

```txt
没有 uuid 的 worker event 仍然可以被 event_id 去重
但重试时无法稳定幂等
```

所以 `CCRClient.toClientEvent` 会给消息注入 uuid。

Mini 也应该这样做。

## worker delivery endpoint

```ts
export function postDeliveryUpdates(input: {
  ledger: DeliveryLedger;
  epochStore: WorkerEpochStore;
  sessionId: string;
  workerEpoch: number;
  updates: Array<{ event_id: string; status: DeliveryStatus }>;
}): DeliveryRecord[] {
  input.epochStore.assertCurrent(input.sessionId, input.workerEpoch);

  return input.updates.map(update =>
    input.ledger.update({
      sessionId: input.sessionId,
      workerEpoch: input.workerEpoch,
      eventId: update.event_id,
      status: update.status,
    }),
  );
}
```

建议响应：

```json
{
  "status": "ok",
  "updated": 3
}
```

不要把 delivery 更新再作为普通 session event 广播给 worker。

它是 observability / control plane 数据。

## sequence 与 idempotency 的关系

重复请求返回已有 event 时，不能分配新 seq。

例如：

```txt
POST user message uuid=a
  -> event seq=10

client timeout

POST user message uuid=a again
  -> return event seq=10
```

如果第二次返回 seq=11，就已经破坏 exactly-once effect。

所以 idempotency 检查必须在 `++seq` 之前。

这也是为什么事件日志要有：

```txt
byIdempotencyKey
```

而不是 publish 后再去重。

## replay cursor 的语义

`from_sequence_num=10` 的含义应该是：

```txt
返回 seq > 10 的事件
```

不是：

```txt
返回 seq >= 10 的事件
```

因为客户端已经确认自己看到 10。

SSE 的 `Last-Event-ID` 也是这个语义：

```txt
最后成功处理的 id
```

不是下一条要读的 id。

如果实现错成 `>=`，客户端会频繁看到重复最后一条。

客户端可以 dedup，但服务端语义仍然应该正确。

## sequence gap

客户端看到：

```txt
seq=10
seq=12
```

说明中间缺了 11。

可能原因：

```txt
服务端 bug
历史被截断
客户端过滤方向
```

对于 worker stream，过滤方向可能导致 gap。

例如：

```txt
seq=10 outbound
seq=11 inbound
seq=12 outbound
```

worker 只收到：

```txt
10, 12
```

这不是丢包。

所以 gap 检查必须知道 stream 类型。

Web 全量 stream 可以要求连续。

worker filtered stream 不能要求连续。

它只能维护：

```txt
last seen global seq
```

重连时从最后 seen 的 global seq 继续。

## exactly-once transcript

transcript 最怕重复 assistant message。

`StructuredIO` 注释里提到一个典型错误：

```txt
duplicate control_response
  -> duplicate assistant messages
  -> API 400 because tool_use ids must be unique
```

Mini 的 transcript append 必须检查 message uuid：

```ts
export class Transcript {
  private readonly messages: Array<Record<string, unknown>> = [];
  private readonly seenUuids = new Set<string>();

  append(message: Record<string, unknown>): "appended" | "duplicate" {
    const uuid = typeof message.uuid === "string" ? message.uuid : undefined;

    if (uuid && this.seenUuids.has(uuid)) {
      return "duplicate";
    }

    if (uuid) {
      this.seenUuids.add(uuid);
    }

    this.messages.push(message);
    return "appended";
  }

  list(): Array<Record<string, unknown>> {
    return this.messages;
  }
}
```

对于没有 uuid 的老消息，可以用内容 hash。

但 hash 去重有风险。

更好的做法是入口强制补 uuid。

## permission response 格式

Web permission response 最终要转成 SDK control_response：

```ts
export function toControlResponse(input: {
  requestId: string;
  approved: boolean;
  updatedInput?: Record<string, unknown>;
  message?: string;
}): Record<string, unknown> {
  if (input.approved) {
    return {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: input.requestId,
        response: {
          behavior: "allow",
          ...(input.updatedInput ? { updatedInput: input.updatedInput } : {}),
        },
      },
    };
  }

  return {
    type: "control_response",
    response: {
      subtype: "error",
      request_id: input.requestId,
      error: "Permission denied by user",
      response: {
        behavior: "deny",
      },
      ...(input.message ? { message: input.message } : {}),
    },
  };
}
```

注意字段名。

SDK 侧通常使用：

```txt
updatedInput
```

Web 或服务端内部可能使用：

```txt
updated_input
```

边界层统一转换。

不要让两套字段混进核心逻辑。

## metadata consistency

多客户端 UI 依赖 metadata：

```txt
worker_status
requires_action_details
external_metadata.pending_action
external_metadata.automation_state
last_heartbeat_at
```

这些状态容易被乱序写覆盖。

原则：

```txt
worker_status 由当前 epoch worker 写
requires_action_details 必须带 request_id
permission resolved 后清空
automation_state 使用 patch merge
heartbeat 只更新时间，不改变业务状态
```

状态恢复时：

```txt
worker 启动 PUT idle
同时 GET previous worker state
清掉旧 pending_action
恢复可恢复 metadata
```

源码里 `CCRClient.initialize` 会清 stale pending action。

Mini 也应该做。

否则 worker 崩溃后，Web 端可能永远显示：

```txt
Waiting for permission
```

## stale pending action 清理

worker 初始化：

```ts
export function buildWorkerInitPatch(workerEpoch: number): Record<string, unknown> {
  return {
    worker_status: "idle",
    worker_epoch: workerEpoch,
    external_metadata: {
      pending_action: null,
      task_summary: null,
      automation_state: null,
    },
  };
}
```

这里的 null 很重要。

它表达：

```txt
删除旧值
```

不是：

```txt
保留旧 pending action
```

## auth refresh 与 epoch

Bridge 里有一个关键注释：

```txt
每次重新获取 bridge credentials 会 bump epoch
不能只换 JWT
必须重建 transport
```

原因：

```txt
旧 transport 带旧 epoch
下次 heartbeat 或 write 会 409
```

Mini 如果实现 token refresh，要记住：

```txt
credentials = token + epoch
```

它们是一组。

不要只刷新 token。

## duplicate sequence on client

`SSETransport` 维护 `seenSequenceNums`。

这不是主要业务去重。

它是诊断和轻量防御。

因为真正业务去重应该靠：

```txt
event_id
uuid
request_id
tool_use_id
```

但是 seen sequence 仍有价值：

```txt
发现服务端 replay 边界错误
发现代理重复发送帧
避免本地高水位倒退
```

Mini 可以维护 bounded sequence set：

```ts
export class SequenceTracker {
  private lastSeq = 0;
  private readonly seen = new Set<number>();

  observe(seq: number): "new" | "duplicate" {
    if (this.seen.has(seq)) {
      return "duplicate";
    }

    this.seen.add(seq);
    if (seq > this.lastSeq) {
      this.lastSeq = seq;
    }

    if (this.seen.size > 1000) {
      const threshold = this.lastSeq - 200;
      for (const value of this.seen) {
        if (value < threshold) {
          this.seen.delete(value);
        }
      }
    }

    return "new";
  }

  getLastSeq(): number {
    return this.lastSeq;
  }
}
```

## protocol state diagram

一个 user message 的官方级路径：

```txt
Web submit
  -> owner guard
  -> idempotency check
  -> event log publish seq=101
  -> worker SSE replay sees seq=101
  -> worker delivery received
  -> StructuredIO enqueue
  -> delivery processing
  -> command queue accepted
  -> delivery processed
  -> model turn starts
  -> assistant stream snapshots
  -> result
  -> session idle
```

断线重连时：

```txt
worker had lastSeq=100
connection drops
Web submits seq=101
worker reconnects with from_sequence_num=100
server replays seq=101
worker processes once
```

重复提交时：

```txt
Web submit uuid=a timeout
Web retry uuid=a
server returns existing seq=101
worker still processes once
```

## permission race diagram

```txt
worker emits control_request request_id=r1 tool_use_id=t1
server publishes requires_action
Web A sees prompt
Web B sees prompt
hook locally denies first
worker sends control_cancel_request r1
server clears prompt
Web A late Allow arrives
server sees r1 already closed
worker sees tool_use_id t1 resolved
late response ignored
```

如果 Web A 先赢：

```txt
Web A Allow r1
server publish control_response r1
worker resolves pending request
worker sends control_cancel_request to SDK side
Web B late Allow r1
server idempotency returns duplicate
```

关键点：

```txt
request_id 配对
tool_use_id 防迟到
cancel request 关闭输家
decision ledger 防重复点击
```

## 该持久化什么

内存版本容易理解。

但接近官方体验时，下面这些最好持久化：

```txt
session event log
last seq
idempotency records
delivery records
worker epoch
session owner
internal transcript events
compaction boundaries
permission decision ledger
```

不一定都进同一张表。

但必须能回答：

```txt
这个 request 是否处理过
这个 worker 是否过期
这个 event 是否已经被 worker processed
这个 client 从 seq=N 重连时缺什么
这个 session 属于哪个 owner
```

## 不该持久化什么

有些状态适合短期内存：

```txt
current SSE subscribers
current WebSocket connection
in-flight promise
local AbortController
transport reconnect timer
flush gate pending messages
bounded recent uuid cache
```

这些是进程内控制结构。

重启后应该通过持久事件重建。

不要把 AbortController 这类对象塞进数据库。

## 测试：事件日志幂等

```ts
import { describe, expect, test } from "bun:test";
import { EventLog } from "../eventLog";

describe("EventLog", () => {
  test("returns the same event for duplicate idempotency key", () => {
    const log = new EventLog();

    const first = log.publish({
      sessionId: "s1",
      type: "user",
      direction: "client_to_worker",
      idempotencyKey: "u1",
      payload: { uuid: "m1", content: "hello" },
    });

    const second = log.publish({
      sessionId: "s1",
      type: "user",
      direction: "client_to_worker",
      idempotencyKey: "u1",
      payload: { uuid: "m1", content: "hello again" },
    });

    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(log.getSince(0)).toHaveLength(1);
  });
});
```

运行：

```bash
bun test src/reliability/__tests__/eventLog.test.ts
```

## 测试：replay cursor

```ts
test("replays events after cursor", () => {
  const log = new EventLog();

  log.publish({
    sessionId: "s1",
    type: "user",
    direction: "client_to_worker",
    idempotencyKey: "a",
    payload: { content: "a" },
  });

  log.publish({
    sessionId: "s1",
    type: "user",
    direction: "client_to_worker",
    idempotencyKey: "b",
    payload: { content: "b" },
  });

  const replay = log.getSince(1);

  expect(replay).toHaveLength(1);
  expect(replay[0]?.seq).toBe(2);
});
```

## 测试：delivery 只能前进

```ts
import { describe, expect, test } from "bun:test";
import { DeliveryLedger } from "../deliveryLedger";

describe("DeliveryLedger", () => {
  test("does not downgrade status", () => {
    const ledger = new DeliveryLedger();

    ledger.update({
      sessionId: "s1",
      eventId: "e1",
      workerEpoch: 1,
      status: "processed",
    });

    ledger.update({
      sessionId: "s1",
      eventId: "e1",
      workerEpoch: 1,
      status: "received",
    });

    expect(ledger.get("s1", "e1")?.status).toBe("processed");
  });
});
```

运行：

```bash
bun test src/reliability/__tests__/deliveryLedger.test.ts
```

## 测试：worker epoch

```ts
import { describe, expect, test } from "bun:test";
import { StaleWorkerEpochError, WorkerEpochStore } from "../workerEpoch";

describe("WorkerEpochStore", () => {
  test("rejects stale worker writes", () => {
    const store = new WorkerEpochStore();

    const first = store.register("s1");
    const second = store.register("s1");

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(() => store.assertCurrent("s1", 1)).toThrow(
      StaleWorkerEpochError,
    );
    expect(() => store.assertCurrent("s1", 2)).not.toThrow();
  });
});
```

## 测试：permission duplicate

```ts
import { describe, expect, test } from "bun:test";
import { PermissionTracker, handlePermissionResponse } from "../permissionTracker";

describe("PermissionTracker", () => {
  test("ignores duplicate response for resolved tool use", () => {
    const tracker = new PermissionTracker();

    tracker.add({
      requestId: "r1",
      toolUseId: "t1",
      toolName: "Bash",
      input: {},
    });

    const first = handlePermissionResponse({
      tracker,
      requestId: "r1",
      toolUseId: "t1",
      decision: { behavior: "allow" },
    });

    const second = handlePermissionResponse({
      tracker,
      requestId: "r1",
      toolUseId: "t1",
      decision: { behavior: "allow" },
    });

    expect(first).toBe("resolved");
    expect(second).toBe("duplicate");
  });
});
```

## 测试：stream snapshot

```ts
import { describe, expect, test } from "bun:test";
import { StreamCoalescer } from "../streamCoalescer";

describe("StreamCoalescer", () => {
  test("emits full-so-far text snapshots", () => {
    const coalescer = new StreamCoalescer();

    const first = coalescer.coalesce({
      type: "stream_event",
      message_id: "m1",
      content_block_index: 0,
      delta: { type: "text_delta", text: "hel" },
    });

    const second = coalescer.coalesce({
      type: "stream_event",
      message_id: "m1",
      content_block_index: 0,
      delta: { type: "text_delta", text: "lo" },
    });

    expect(first.delta.text).toBe("hel");
    expect(second.delta.text).toBe("hello");
  });
});
```

## 测试：client reducer

```ts
import { describe, expect, test } from "bun:test";
import { applyRemoteEvent } from "../clientReducer";

describe("client reducer", () => {
  test("deduplicates by message uuid", () => {
    const initial = {
      lastSeq: 0,
      seenEventIds: new Set<string>(),
      seenMessageUuids: new Set<string>(),
      messages: [],
    };

    const first = applyRemoteEvent(initial, {
      event_id: "e1",
      sequence_num: 1,
      payload: { uuid: "m1", content: "hello" },
    });

    const second = applyRemoteEvent(first, {
      event_id: "e2",
      sequence_num: 2,
      payload: { uuid: "m1", content: "hello" },
    });

    expect(second.messages).toHaveLength(1);
    expect(second.lastSeq).toBe(2);
  });
});
```

## 测试矩阵

最小矩阵：

```txt
duplicate user submit:
  same idempotency key returns same seq

duplicate worker event:
  same uuid returns same event

SSE reconnect:
  from seq returns only later events

worker filtered stream:
  only client_to_worker events delivered

delivery downgrade:
  processed cannot become received

stale worker:
  old epoch write returns 409

permission duplicate:
  second response ignored

permission cancel:
  pending prompt removed and late response ignored

stream snapshot:
  second delta includes full text

bridge flush gate:
  live messages wait until history flush completes

owner guard:
  wrong owner cannot post control

viewer reconnect:
  pending permission is not duplicated in UI
```

建议先写这些。

不要急着做完整数据库。

可靠性语义先用内存测清楚。

## 和当前本地 RCS 的差距

当前本地实现已经具备：

```txt
event bus seqNum
bounded history
SSE Last-Event-ID / from_sequence_num
worker outbound filter
worker register epoch increment
CCRClient epoch mismatch handling
SSETransport high-water mark
delivery endpoint shape
StructuredIO pending request map
resolved tool_use duplicate ignore
RemoteSessionManager pending permission map
Bridge recent uuid dedup
FlushGate
ACP pending permission timeout and disconnect cancel
```

还缺：

```txt
服务端 worker epoch guard 覆盖所有 worker writes
delivery endpoint 持久记录状态
delivery 状态只能前进
server-side idempotency ledger
permission decision ledger
interrupt turn id
cursor truncated 信号
event log 持久化
Web client reducer 明确按 event_id / uuid 去重
worker event POST 基于 uuid 去重
```

这些缺口不是小功能。

它们决定远程控制能不能在真实网络环境下稳定。

## 常见错误

错误一：

```txt
只在客户端去重
```

服务端仍然会执行两次。

正确：

```txt
入口、事件日志、业务 handler、客户端 reducer 多层去重
```

错误二：

```txt
delivery processed 表示模型回复完成
```

正确：

```txt
delivery processed 表示这个 event 被 worker 接纳
turn 完成用 result / idle 表示
```

错误三：

```txt
worker heartbeat 不校验 epoch
```

旧 worker 会把 session 看起来维持在线。

错误四：

```txt
permission request_id 找不到就报错弹窗
```

迟到 duplicate 很常见。

先查 tool_use_id 是否已 resolved。

错误五：

```txt
stream delta 只存增量
```

断线后无法恢复完整文本。

错误六：

```txt
历史 flush 时继续直接写 live message
```

会产生 transcript 顺序错乱。

错误七：

```txt
用 seq gap 判断 worker stream 丢包
```

worker stream 过滤了 inbound，天然可能有 global seq gap。

## 最小落地顺序

建议按这个顺序补 Mini：

```txt
1. EventLog + idempotency key
2. SSE replay cursor
3. client reducer event_id / uuid dedup
4. worker epoch guard
5. delivery ledger
6. permission tracker duplicate ignore
7. stream full-so-far snapshot
8. flush gate
9. owner guard
10. persisted event log
```

为什么先 EventLog？

因为后面的能力都依赖它：

```txt
delivery 要指向 event_id
replay 要用 seq
dedup 要返回 old event
client reducer 要消费 event shape
```

## 本章完成后的能力

现在 Mini 的远程协同模型应该从：

```txt
消息来了就 append
断线了就重连
重复了靠运气
```

升级成：

```txt
事件有稳定身份
写入有幂等 key
日志有单调 seq
重连有 replay cursor
worker 有 epoch fencing
delivery 有状态机
permission 有 pending table 和 late response ignore
stream 有 full-so-far 快照
bridge 有 flush gate
client reducer 有 dedup
```

这就是官方级体验的底层质感：

```txt
网络可以重复
客户端可以重连
用户可以连点
worker 可以重启
但 session 仍然像一条连续、可靠、只执行一次的对话
```

## 和官方 Claude Code 的差距

Mini 仍然简化了很多细节：

```txt
持久化事件表 schema
跨进程 singleflight
多 region replay cursor
server-side delivery retry policy
dead letter event
catch_up_truncated UI 恢复
权限响应审计
worker lease 与 epoch 的组合
subagent event stream 分区
internal event compaction boundary
mobile offline outbox
批量事件 byte limit
auth refresh 与 epoch refresh 原子化
```

但核心骨架已经正确：

```txt
idempotency key
event_id
uuid
sequence_num
request_id
tool_use_id
worker_epoch
owner_uuid
delivery status
bounded replay
duplicate ignore
```

下一章可以继续补 **持久化事件存储、会话快照与 replay truncation 恢复**：让事件日志从内存模型升级成重启后仍可恢复的 session timeline。
