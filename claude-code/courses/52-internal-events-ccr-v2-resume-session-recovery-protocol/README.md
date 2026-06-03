# 第 52 章：Internal Events、CCR v2 Resume 与会话恢复协议

第 51 章把 RCS 事件流接到了三种用户入口：

```txt
WebSocket Subscribe
Web Console
Remote Session Detail Dialog
```

用户已经能看见远端 session，也能发送消息、确认权限、打断任务。

但还有一个更底层的问题：

```txt
远端 worker 重启后，怎么恢复完整对话？
浏览器刷新后，怎么不重复事件？
CLI 重新 attach 后，怎么不从头 replay？
compaction 后，怎么只恢复必要历史？
subagent 的 transcript 怎么恢复？
```

第 50 章的 EventBus 可以做实时分发。

第 51 章的 Web UI 可以做可视化控制。

但它们都不是可靠的会话恢复协议。

本章要补的是 CCR v2 的恢复层：

```txt
internal events
  保存 worker 内部 transcript，不展示给 Web 客户端

worker event stream
  用 sequence_num / Last-Event-ID 恢复控制事件

worker state
  保存 external_metadata，恢复模型、权限、自动化状态

compaction boundary
  让 resume 只拉最新压缩边界后的 transcript

subagent internal events
  按 agent_id 分组恢复 sidechain transcript
```

到本章结束，你的 Mini 会具备：

- CCR v2 开关
- SSE read + HTTP write 的 worker transport
- worker 初始化读取 epoch
- worker state 初始化与 heartbeat
- client events 批量上传
- stream_event 100ms 聚合
- text_delta full-so-far snapshot
- internal event 批量上传
- internal event 分页读取
- compaction boundary 过滤
- subagent internal events 读取
- 本地 transcript hydration
- restored worker metadata 恢复
- delivery status 上报
- SSE sequence high-water mark
- restart 后从 `from_sequence_num` 继续
- stale worker epoch 409 退出

这章会比较协议化。

它不是 UI 章节，而是“远程 Claude Code 为什么能像本地一样恢复”的核心。

## 参考源码

本章参考这些真实模块：

```txt
src/cli/remoteIO.ts
src/cli/transports/ccrClient.ts
src/cli/transports/SSETransport.ts
src/cli/transports/SerialBatchEventUploader.ts
src/cli/transports/WorkerStateUploader.ts
src/cli/transports/transportUtils.ts
src/cli/structuredIO.ts
src/utils/sessionStorage.ts
src/cli/print.ts
src/bridge/replBridge.ts
src/bridge/replBridgeTransport.ts
src/bridge/workSecret.ts
src/bridge/codeSessionApi.ts

packages/remote-control-server/src/routes/v2/worker.ts
packages/remote-control-server/src/routes/v2/worker-events.ts
packages/remote-control-server/src/routes/v2/worker-events-stream.ts
packages/remote-control-server/src/transport/sse-writer.ts
packages/remote-control-server/src/transport/event-bus.ts
packages/remote-control-server/src/transport/client-payload.ts
packages/remote-control-server/src/store.ts
packages/remote-control-server/src/services/session.ts
```

这些源码里有几条关键线：

1. `RemoteIO` 在 CCR v2 模式下必须使用 `SSETransport`。
2. `RemoteIO` 创建 `CCRClient` 后才允许 `transport.connect()`，否则早期 SSE frame 的 delivery ack 会丢。
3. `CCRClient` 负责 worker epoch、heartbeat、worker state、client events、internal events、delivery ack。
4. `sessionStorage` 注册 internal event writer 后，transcript 不再走旧 session ingress，而是写 `/worker/internal-events`。
5. `hydrateFromCCRv2InternalEvents()` 从服务端拉 internal events，再写回本地 JSONL。
6. `SSETransport` 用 `from_sequence_num` 和 `Last-Event-ID` 做断点续传。
7. `replBridge` 会把 SSE sequence high-water mark 跨 transport swap 传递。
8. 服务端目前已有 worker state、worker event stream，但 Mini 还需要补 internal-events 存储与读取路由。

这一章就是把这些线串成一个闭环。

## 本章目标

最终链路如下：

```txt
worker process
  -> RemoteIO
  -> SSETransport reads /worker/events/stream
  -> CCRClient writes /worker/events
  -> CCRClient writes /worker/internal-events
  -> CCRClient PUT /worker
  -> CCRClient POST /worker/heartbeat

RCS
  -> EventBus stores client-visible events
  -> InternalEventStore stores transcript events
  -> WorkerStore stores external_metadata
  -> SSE stream replays outbound events by sequence

resume
  -> CCRClient GET /worker/internal-events
  -> hydrate local main transcript
  -> CCRClient GET /worker/internal-events?subagents=true
  -> hydrate subagent transcripts
  -> GET /worker restores external_metadata
  -> SSETransport connects from high-water sequence
```

这套系统里有两条事件流。

第一条是用户可见事件：

```txt
client events
  assistant output
  tool use
  tool result
  status
  errors
```

第二条是 worker 内部事件：

```txt
internal events
  transcript entries
  compact boundary
  sidechain transcript
```

两条流必须分开。

不要把 transcript internal events 推给 Web UI。

原因很简单：

```txt
Web UI 需要渲染正在发生的事。
Resume 需要恢复完整内部状态。
```

这两个目标不一样。

## 最终目录

本章建议新增或扩展这些 Mini 文件：

```txt
src/ccr/types.ts
src/ccr/serialBatchEventUploader.ts
src/ccr/workerStateUploader.ts
src/ccr/sseTransport.ts
src/ccr/ccrClient.ts
src/ccr/remoteIO.ts

src/session/sessionStorage.ts
src/session/ccrHydration.ts

src/rcs/internalEventStore.ts
src/rcs/workerRoutes.ts
src/rcs/workerEventsRoutes.ts
src/rcs/workerEventsStreamRoutes.ts
src/rcs/server.ts
```

如果你前面章节已经有部分文件，直接合并进去。

这章的重点是接口语义，不是文件名。

## 两类事件

先定义通用类型。

新增：

```txt
src/ccr/types.ts
```

```ts
export type WorkerEpoch = number;

export type ClientEventPayload = {
  uuid: string;
  type: string;
  [key: string]: unknown;
};

export type ClientEvent = {
  payload: ClientEventPayload;
  ephemeral?: boolean;
};

export type WorkerInternalEventInput = {
  payload: ClientEventPayload;
  is_compaction?: boolean;
  agent_id?: string;
};

export type InternalEventRecord = {
  event_id: string;
  session_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  event_metadata: Record<string, unknown> | null;
  is_compaction: boolean;
  created_at: string;
  agent_id?: string;
};

export type ListInternalEventsResponse = {
  data: InternalEventRecord[];
  next_cursor?: string;
};

export type StreamClientEvent = {
  event_id: string;
  sequence_num: number;
  event_type: string;
  source: "client";
  payload: Record<string, unknown>;
  created_at: string;
};

export type WorkerStatePayload = {
  worker_status?: string;
  worker_epoch: number;
  requires_action_details?: Record<string, unknown> | null;
  external_metadata?: Record<string, unknown> | null;
};
```

命名上要保持清楚：

```txt
ClientEvent
  worker 写给前端/用户可见流

InternalEventRecord
  worker 写给 resume 使用的内部流

StreamClientEvent
  RCS 通过 worker SSE 推给 worker 的用户控制事件
```

不要把三者混成一个 `Event`。

后面会非常难维护。

## Internal Event Store

服务端先补 internal events 存储。

新增：

```txt
src/rcs/internalEventStore.ts
```

```ts
import { randomUUID } from "node:crypto";
import type { InternalEventRecord, WorkerInternalEventInput } from "../ccr/types";

const MAX_INTERNAL_EVENTS_PER_SESSION = 20_000;
const internalEventsBySession = new Map<string, InternalEventRecord[]>();

export function appendInternalEvents(sessionId: string, events: WorkerInternalEventInput[]) {
  const list = internalEventsBySession.get(sessionId) ?? [];
  const now = new Date().toISOString();

  for (const event of events) {
    const type =
      typeof event.payload.type === "string" && event.payload.type
        ? event.payload.type
        : "transcript";

    list.push({
      event_id: randomUUID(),
      session_id: sessionId,
      event_type: type,
      payload: event.payload,
      event_metadata: null,
      is_compaction: event.is_compaction === true,
      created_at: now,
      ...(event.agent_id ? { agent_id: event.agent_id } : {}),
    });
  }

  if (list.length > MAX_INTERNAL_EVENTS_PER_SESSION) {
    list.splice(0, list.length - MAX_INTERNAL_EVENTS_PER_SESSION);
  }

  internalEventsBySession.set(sessionId, list);
}

export function listInternalEvents(sessionId: string, options: { subagents?: boolean; cursor?: string; limit?: number }) {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const all = internalEventsBySession.get(sessionId) ?? [];
  const filtered = selectCompactedWindow(all, options.subagents === true);
  const start = options.cursor ? Number(options.cursor) : 0;
  const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
  const page = filtered.slice(safeStart, safeStart + limit);
  const next = safeStart + page.length < filtered.length ? String(safeStart + page.length) : undefined;

  return {
    data: page,
    ...(next ? { next_cursor: next } : {}),
  };
}

export function resetInternalEventsForTesting() {
  internalEventsBySession.clear();
}
```

关键是 `selectCompactedWindow()`。

Resume 不应该永远拉全部历史。

它应该从最新 compaction boundary 后开始。

```ts
function selectCompactedWindow(events: InternalEventRecord[], includeSubagents: boolean) {
  if (includeSubagents) {
    return selectSubagentWindows(events);
  }

  const foreground = events.filter((event) => !event.agent_id);
  const lastBoundary = findLastCompactionIndex(foreground);
  return lastBoundary >= 0 ? foreground.slice(lastBoundary) : foreground;
}

function selectSubagentWindows(events: InternalEventRecord[]) {
  const byAgent = new Map<string, InternalEventRecord[]>();

  for (const event of events) {
    if (!event.agent_id) {
      continue;
    }

    const list = byAgent.get(event.agent_id) ?? [];
    list.push(event);
    byAgent.set(event.agent_id, list);
  }

  const result: InternalEventRecord[] = [];

  for (const list of byAgent.values()) {
    const lastBoundary = findLastCompactionIndex(list);
    result.push(...(lastBoundary >= 0 ? list.slice(lastBoundary) : list));
  }

  return result.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function findLastCompactionIndex(events: InternalEventRecord[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.is_compaction) {
      return i;
    }
  }

  return -1;
}
```

为什么 compaction boundary 本身要保留？

因为它通常就是压缩后的 summary message。

如果从 boundary 后一条开始，会丢掉摘要。

正确行为是：

```txt
latest compact summary
  + messages after summary
```

不是只要 summary 后面的消息。

## Internal Events Route

服务端补路由。

扩展：

```txt
src/rcs/workerEventsRoutes.ts
```

新增：

```txt
POST /v1/code/sessions/:id/worker/internal-events
GET  /v1/code/sessions/:id/worker/internal-events
```

```ts
import { Hono } from "hono";
import { appendInternalEvents, listInternalEvents } from "./internalEventStore";
import { getSession } from "./sessionStore";
import { assertWorkerEpoch, sessionIngressAuth } from "./auth";

export function createWorkerEventsRoutes() {
  const app = new Hono();

  app.post("/:id/worker/internal-events", sessionIngressAuth, async (c) => {
    const sessionId = c.req.param("id");
    const session = await getSession(sessionId);

    if (!session) {
      return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
    }

    const body = await c.req.json();
    const epochError = assertWorkerEpoch(sessionId, body.worker_epoch);

    if (epochError) {
      return epochError;
    }

    const events = extractInternalEvents(body);
    appendInternalEvents(sessionId, events);

    return c.json({ status: "ok", count: events.length }, 200);
  });

  app.get("/:id/worker/internal-events", sessionIngressAuth, async (c) => {
    const sessionId = c.req.param("id");
    const session = await getSession(sessionId);

    if (!session) {
      return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
    }

    const subagents = c.req.query("subagents") === "true";
    const cursor = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;

    return c.json(listInternalEvents(sessionId, { subagents, cursor, limit }), 200);
  });

  return app;
}
```

解析 body：

```ts
import type { WorkerInternalEventInput } from "../ccr/types";

function extractInternalEvents(body: unknown): WorkerInternalEventInput[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const record = body as Record<string, unknown>;
  const rawEvents = Array.isArray(record.events) ? record.events : [record];

  return rawEvents.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return [];
    }

    const event = raw as Record<string, unknown>;
    const payload = event.payload;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return [];
    }

    return [
      {
        payload: payload as Record<string, unknown> & { uuid: string; type: string },
        ...(event.is_compaction === true ? { is_compaction: true } : {}),
        ...(typeof event.agent_id === "string" ? { agent_id: event.agent_id } : {}),
      },
    ];
  });
}
```

这里要坚持一个规则：

```txt
internal events 不 publish 到 EventBus
```

它们不进入 Web SSE，不进入 worker event stream，不进入 remote detail log。

它们只服务 resume。

## Worker State Route

第 50 章已经有 worker state。

本章要确认它支持恢复 external metadata。

```txt
GET /v1/code/sessions/:id/worker
PUT /v1/code/sessions/:id/worker
POST /v1/code/sessions/:id/worker/heartbeat
```

Mini 版：

```ts
app.get("/:id/worker", sessionIngressAuth, async (c) => {
  const sessionId = c.req.param("id");
  const session = await getSession(sessionId);

  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  const worker = await getSessionWorker(sessionId);

  return c.json({
    worker: {
      worker_status: worker?.workerStatus ?? session.status,
      external_metadata: worker?.externalMetadata ?? null,
      requires_action_details: worker?.requiresActionDetails ?? null,
      last_heartbeat_at: worker?.lastHeartbeatAt ?? null,
    },
  });
});
```

PUT 要合并 metadata：

```ts
app.put("/:id/worker", sessionIngressAuth, async (c) => {
  const sessionId = c.req.param("id");
  const session = await getSession(sessionId);

  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  const body = await c.req.json();
  const epochError = assertWorkerEpoch(sessionId, body.worker_epoch);

  if (epochError) {
    return epochError;
  }

  const worker = await upsertSessionWorker(sessionId, {
    workerStatus: typeof body.worker_status === "string" ? body.worker_status : undefined,
    requiresActionDetails:
      body.requires_action_details && typeof body.requires_action_details === "object"
        ? body.requires_action_details
        : body.requires_action_details === null
          ? null
          : undefined,
    externalMetadata:
      body.external_metadata && typeof body.external_metadata === "object"
        ? body.external_metadata
        : body.external_metadata === null
          ? null
          : undefined,
  });

  return c.json({
    status: "ok",
    worker: {
      worker_status: worker.workerStatus,
      external_metadata: worker.externalMetadata,
      requires_action_details: worker.requiresActionDetails,
      last_heartbeat_at: worker.lastHeartbeatAt,
    },
  });
});
```

`external_metadata` 的语义是 merge patch。

推荐：

```txt
key: value
  设置或覆盖

key: null
  删除或清空该 key
```

如果只做浅 merge，至少要保留 null。

不要在客户端把 null 过滤掉。

官方源码依赖这个行为清理旧的 pending action。

## SSETransport

客户端读用户控制事件用 SSE。

新增：

```txt
src/ccr/sseTransport.ts
```

先做 SSE parser：

```ts
type SSEFrame = {
  event?: string;
  id?: string;
  data?: string;
};

export function parseSSEFrames(buffer: string): { frames: SSEFrame[]; remaining: string } {
  const frames: SSEFrame[] = [];
  let pos = 0;
  const delimiter = /\r?\n\r?\n/g;
  let match: RegExpExecArray | null;

  while ((match = delimiter.exec(buffer)) !== null) {
    const raw = buffer.slice(pos, match.index);
    pos = match.index + match[0].length;

    if (!raw.trim()) {
      continue;
    }

    const frame: SSEFrame = {};
    let isComment = false;

    for (const rawLine of raw.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line.startsWith(":")) {
        isComment = true;
        continue;
      }

      const colonIndex = line.indexOf(":");

      if (colonIndex === -1) {
        continue;
      }

      const field = line.slice(0, colonIndex);
      const value = line[colonIndex + 1] === " " ? line.slice(colonIndex + 2) : line.slice(colonIndex + 1);

      if (field === "event") {
        frame.event = value;
      } else if (field === "id") {
        frame.id = value;
      } else if (field === "data") {
        frame.data = frame.data ? `${frame.data}\n${value}` : value;
      }
    }

    if (frame.data || isComment) {
      frames.push(frame);
    }
  }

  return { frames, remaining: buffer.slice(pos) };
}
```

Transport 的状态：

```ts
import type { StreamClientEvent } from "./types";

type TransportState = "idle" | "connected" | "reconnecting" | "closing" | "closed";

export class SSETransport {
  private state: TransportState = "idle";
  private abortController: AbortController | null = null;
  private lastSequenceNum = 0;
  private seenSequenceNums = new Set<number>();
  private reconnectAttempts = 0;
  private reconnectStartedAt: number | null = null;
  private reconnectTimer: Timer | null = null;
  private livenessTimer: Timer | null = null;
  private onData?: (line: string) => void;
  private onEvent?: (event: StreamClientEvent) => void;
  private onClose?: () => void;

  constructor(
    private readonly streamUrl: URL,
    private readonly postUrl: URL,
    private readonly getHeaders: () => Record<string, string>,
    initialSequenceNum = 0,
  ) {
    this.lastSequenceNum = initialSequenceNum;
  }

  setOnData(callback: (line: string) => void) {
    this.onData = callback;
  }

  setOnEvent(callback: (event: StreamClientEvent) => void) {
    this.onEvent = callback;
  }

  setOnClose(callback: () => void) {
    this.onClose = callback;
  }

  getLastSequenceNum() {
    return this.lastSequenceNum;
  }
}
```

连接时带上断点：

```ts
const RECONNECT_GIVE_UP_MS = 10 * 60 * 1000;
const LIVENESS_TIMEOUT_MS = 45_000;

async connect() {
  if (this.state !== "idle" && this.state !== "reconnecting") {
    return;
  }

  this.state = "reconnecting";
  const url = new URL(this.streamUrl.href);

  if (this.lastSequenceNum > 0) {
    url.searchParams.set("from_sequence_num", String(this.lastSequenceNum));
  }

  const headers = {
    ...this.getHeaders(),
    Accept: "text/event-stream",
  };

  if (this.lastSequenceNum > 0) {
    headers["Last-Event-ID"] = String(this.lastSequenceNum);
  }

  this.abortController = new AbortController();

  try {
    const response = await fetch(url, {
      headers,
      signal: this.abortController.signal,
    });

    if (!response.ok || !response.body) {
      this.handleConnectionError(response.status);
      return;
    }

    this.state = "connected";
    this.reconnectAttempts = 0;
    this.reconnectStartedAt = null;
    this.resetLivenessTimer();

    await this.readStream(response.body);
  } catch {
    if (!this.abortController.signal.aborted) {
      this.handleConnectionError();
    }
  }
}
```

读 stream：

```ts
private async readStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      if (buffer.length > 1024 * 1024) {
        break;
      }

      const parsed = parseSSEFrames(buffer);
      buffer = parsed.remaining;

      for (const frame of parsed.frames) {
        this.resetLivenessTimer();

        if (frame.id) {
          this.recordSequence(frame.id);
        }

        if (frame.event === "client_event" && frame.data) {
          this.handleClientEvent(frame.data);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (this.state !== "closing" && this.state !== "closed") {
    this.handleConnectionError();
  }
}
```

sequence 处理：

```ts
private recordSequence(raw: string) {
  const seq = Number(raw);

  if (!Number.isFinite(seq)) {
    return;
  }

  if (this.seenSequenceNums.has(seq)) {
    return;
  }

  this.seenSequenceNums.add(seq);

  if (this.seenSequenceNums.size > 1000) {
    const threshold = this.lastSequenceNum - 200;

    for (const value of this.seenSequenceNums) {
      if (value < threshold) {
        this.seenSequenceNums.delete(value);
      }
    }
  }

  if (seq > this.lastSequenceNum) {
    this.lastSequenceNum = seq;
  }
}
```

client event 转给 StructuredIO：

```ts
private handleClientEvent(data: string) {
  const event = JSON.parse(data) as StreamClientEvent;
  const payload = event.payload;

  if (!payload || typeof payload !== "object" || typeof payload.type !== "string") {
    return;
  }

  this.onData?.(`${JSON.stringify(payload)}\n`);
  this.onEvent?.(event);
}
```

重连：

```ts
private handleConnectionError(status?: number) {
  this.clearLivenessTimer();

  if (status === 401 || status === 403 || status === 404) {
    this.state = "closed";
    this.onClose?.();
    return;
  }

  if (this.state === "closing" || this.state === "closed") {
    return;
  }

  this.abortController?.abort();
  this.abortController = null;

  const now = Date.now();
  this.reconnectStartedAt ??= now;

  if (now - this.reconnectStartedAt > RECONNECT_GIVE_UP_MS) {
    this.state = "closed";
    this.onClose?.();
    return;
  }

  this.state = "reconnecting";
  this.reconnectAttempts++;

  const base = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30_000);
  const jitter = base * 0.25 * (2 * Math.random() - 1);
  const delay = Math.max(0, base + jitter);

  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    void this.connect();
  }, delay);
}

private resetLivenessTimer() {
  this.clearLivenessTimer();
  this.livenessTimer = setTimeout(() => {
    this.abortController?.abort();
    this.handleConnectionError();
  }, LIVENESS_TIMEOUT_MS);
}

private clearLivenessTimer() {
  if (this.livenessTimer) {
    clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
  }
}
```

HTTP write：

```ts
async write(message: Record<string, unknown>) {
  const response = await fetch(this.postUrl, {
    method: "POST",
    headers: {
      ...this.getHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok && response.status !== 409) {
    throw new Error(`write failed: ${response.status}`);
  }

  if (response.status === 409) {
    throw new Error("worker epoch mismatch");
  }
}

close() {
  this.state = "closing";
  this.abortController?.abort();

  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
  }

  this.clearLivenessTimer();
  this.state = "closed";
}
```

重点是：

```txt
lastSequenceNum 是 transport 的恢复水位。
client event 的 event_id 是 delivery ack 的业务 ID。
两者不是同一个东西。
```

不要把 `event_id` 当断点。

## Serial Batch Event Uploader

CCRClient 写事件不能每条都立刻 POST。

需要串行批量上传。

新增：

```txt
src/ccr/serialBatchEventUploader.ts
```

```ts
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

type Config<T> = {
  maxBatchSize: number;
  maxBatchBytes?: number;
  maxQueueSize: number;
  send: (batch: T[]) => Promise<void>;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
};

export class SerialBatchEventUploader<T> {
  private pending: T[] = [];
  private draining = false;
  private closed = false;
  private flushResolvers: Array<() => void> = [];
  private backpressureResolvers: Array<() => void> = [];

  constructor(private readonly config: Config<T>) {}

  get pendingCount() {
    return this.pending.length;
  }

  async enqueue(input: T | T[]) {
    if (this.closed) {
      return;
    }

    const items = Array.isArray(input) ? input : [input];

    while (this.pending.length + items.length > this.config.maxQueueSize && !this.closed) {
      await new Promise<void>((resolve) => this.backpressureResolvers.push(resolve));
    }

    if (this.closed) {
      return;
    }

    this.pending.push(...items);
    void this.drain();
  }

  flush() {
    if (this.pending.length === 0 && !this.draining) {
      return Promise.resolve();
    }

    void this.drain();
    return new Promise<void>((resolve) => this.flushResolvers.push(resolve));
  }

  close() {
    this.closed = true;
    this.pending = [];

    for (const resolve of this.flushResolvers) {
      resolve();
    }

    for (const resolve of this.backpressureResolvers) {
      resolve();
    }
  }
}
```

drain：

```ts
private async drain() {
  if (this.draining || this.closed) {
    return;
  }

  this.draining = true;
  let failures = 0;

  try {
    while (this.pending.length > 0 && !this.closed) {
      const batch = this.takeBatch();

      try {
        await this.config.send(batch);
        failures = 0;
        this.releaseBackpressure();
      } catch (error) {
        failures++;
        this.pending = batch.concat(this.pending);
        const retryAfterMs = error instanceof RetryableError ? error.retryAfterMs : undefined;
        await sleep(this.retryDelay(failures, retryAfterMs));
      }
    }
  } finally {
    this.draining = false;

    if (this.pending.length === 0) {
      const resolvers = this.flushResolvers;
      this.flushResolvers = [];

      for (const resolve of resolvers) {
        resolve();
      }
    }
  }
}
```

batch 按数量和字节限制：

```ts
private takeBatch() {
  const { maxBatchSize, maxBatchBytes } = this.config;

  if (maxBatchBytes === undefined) {
    return this.pending.splice(0, maxBatchSize);
  }

  let bytes = 0;
  let count = 0;

  while (count < this.pending.length && count < maxBatchSize) {
    const item = this.pending[count];
    const itemBytes = Buffer.byteLength(JSON.stringify(item));

    if (count > 0 && bytes + itemBytes > maxBatchBytes) {
      break;
    }

    bytes += itemBytes;
    count++;
  }

  return this.pending.splice(0, Math.max(1, count));
}

private retryDelay(failures: number, retryAfterMs?: number) {
  const jitter = Math.random() * this.config.jitterMs;

  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, this.config.baseDelayMs), this.config.maxDelayMs) + jitter;
  }

  return Math.min(this.config.baseDelayMs * 2 ** (failures - 1), this.config.maxDelayMs) + jitter;
}

private releaseBackpressure() {
  const resolvers = this.backpressureResolvers;
  this.backpressureResolvers = [];

  for (const resolve of resolvers) {
    resolve();
  }
}
```

这个 uploader 的核心约束是：

```txt
同一类事件最多一个 POST in-flight。
失败时原 batch 放回队首。
flush 等待队列真正清空。
```

Internal events 尤其需要这个保证。

否则 transcript 恢复顺序会乱。

## Worker State Uploader

worker state 是高频 patch。

它不需要排一个无限队列。

只需要 coalescing。

新增：

```txt
src/ccr/workerStateUploader.ts
```

```ts
type WorkerStateUploaderConfig = {
  send: (body: Record<string, unknown>) => Promise<boolean>;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
};

export class WorkerStateUploader {
  private inflight: Promise<void> | null = null;
  private pending: Record<string, unknown> | null = null;
  private closed = false;

  constructor(private readonly config: WorkerStateUploaderConfig) {}

  enqueue(patch: Record<string, unknown>) {
    if (this.closed) {
      return;
    }

    this.pending = this.pending ? coalescePatches(this.pending, patch) : patch;
    void this.drain();
  }

  close() {
    this.closed = true;
    this.pending = null;
  }

  private async drain() {
    if (this.inflight || this.closed || !this.pending) {
      return;
    }

    const payload = this.pending;
    this.pending = null;

    this.inflight = this.sendWithRetry(payload).finally(() => {
      this.inflight = null;

      if (this.pending && !this.closed) {
        void this.drain();
      }
    });
  }
}
```

merge 规则：

```ts
function coalescePatches(base: Record<string, unknown>, overlay: Record<string, unknown>) {
  const merged = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (
      (key === "external_metadata" || key === "internal_metadata") &&
      merged[key] &&
      typeof merged[key] === "object" &&
      typeof value === "object" &&
      value !== null
    ) {
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      merged[key] = value;
    }
  }

  return merged;
}
```

发送重试：

```ts
private async sendWithRetry(payload: Record<string, unknown>) {
  let current = payload;
  let failures = 0;

  while (!this.closed) {
    const ok = await this.config.send(current);

    if (ok) {
      return;
    }

    failures++;
    await sleep(this.retryDelay(failures));

    if (this.pending && !this.closed) {
      current = coalescePatches(current, this.pending);
      this.pending = null;
    }
  }
}

private retryDelay(failures: number) {
  return Math.min(this.config.baseDelayMs * 2 ** (failures - 1), this.config.maxDelayMs) + Math.random() * this.config.jitterMs;
}
```

这个设计避免状态更新无限堆积。

例如：

```txt
running
requires_action
running
idle
```

网络断了一分钟后，没必要补发中间所有 state。

发最后的 coalesced patch 就够了。

## Stream Event 聚合

assistant streaming 会产生大量 `stream_event`。

如果每个 text_delta 都 POST，会有两个问题：

```txt
请求数量爆炸
中途恢复的客户端只看到片段
```

所以 CCRClient 要做 100ms buffer 和 full-so-far snapshot。

新增：

```txt
src/ccr/streamAccumulator.ts
```

```ts
export type StreamAccumulatorState = {
  byMessage: Map<string, string[][]>;
  scopeToMessage: Map<string, string>;
};

export function createStreamAccumulator(): StreamAccumulatorState {
  return {
    byMessage: new Map(),
    scopeToMessage: new Map(),
  };
}

function scopeKey(message: { session_id: string; parent_tool_use_id?: string | null }) {
  return `${message.session_id}:${message.parent_tool_use_id ?? ""}`;
}
```

聚合：

```ts
export function accumulateStreamEvents(buffer: Record<string, unknown>[], state: StreamAccumulatorState) {
  const out: Record<string, unknown>[] = [];
  const touched = new Map<string[], Record<string, unknown>>();

  for (const message of buffer) {
    const event = message.event as Record<string, unknown> | undefined;

    if (!event || typeof event.type !== "string") {
      out.push(message);
      continue;
    }

    if (event.type === "message_start") {
      const apiMessage = event.message as { id?: string } | undefined;
      const messageId = apiMessage?.id;

      if (messageId) {
        const scope = scopeKey(message as { session_id: string; parent_tool_use_id?: string | null });
        const previous = state.scopeToMessage.get(scope);

        if (previous) {
          state.byMessage.delete(previous);
        }

        state.scopeToMessage.set(scope, messageId);
        state.byMessage.set(messageId, []);
      }

      out.push(message);
      continue;
    }

    if (event.type !== "content_block_delta") {
      out.push(message);
      continue;
    }

    const delta = event.delta as Record<string, unknown> | undefined;

    if (delta?.type !== "text_delta" || typeof delta.text !== "string") {
      out.push(message);
      continue;
    }

    const scope = scopeKey(message as { session_id: string; parent_tool_use_id?: string | null });
    const messageId = state.scopeToMessage.get(scope);
    const blocks = messageId ? state.byMessage.get(messageId) : undefined;

    if (!blocks) {
      out.push(message);
      continue;
    }

    const index = typeof event.index === "number" ? event.index : 0;
    const chunks = (blocks[index] ??= []);
    chunks.push(delta.text);

    const existing = touched.get(chunks);

    if (existing) {
      (existing.event as Record<string, unknown>).delta = {
        type: "text_delta",
        text: chunks.join(""),
      };
      continue;
    }

    const snapshot = {
      ...message,
      event: {
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: chunks.join(""),
        },
      },
    };

    touched.set(chunks, snapshot);
    out.push(snapshot);
  }

  return out;
}
```

assistant 完整消息到达时清理：

```ts
export function clearStreamAccumulatorForMessage(
  state: StreamAccumulatorState,
  assistant: { session_id: string; parent_tool_use_id: string | null; message: { id: string } },
) {
  state.byMessage.delete(assistant.message.id);

  const scope = scopeKey(assistant);

  if (state.scopeToMessage.get(scope) === assistant.message.id) {
    state.scopeToMessage.delete(scope);
  }
}
```

为什么不用 `message_stop` 清理？

因为 abort、error、interrupt 场景可能没有完整 stop event。

完整 assistant message 更可靠。

## CCRClient

新增：

```txt
src/ccr/ccrClient.ts
```

构造函数：

```ts
import { randomUUID } from "node:crypto";
import { SerialBatchEventUploader, RetryableError } from "./serialBatchEventUploader";
import { WorkerStateUploader } from "./workerStateUploader";
import { accumulateStreamEvents, clearStreamAccumulatorForMessage, createStreamAccumulator } from "./streamAccumulator";
import type { ClientEvent, ListInternalEventsResponse, StreamClientEvent, WorkerInternalEventInput } from "./types";

export class CCRClient {
  private workerEpoch = 0;
  private heartbeatTimer: Timer | null = null;
  private heartbeatInFlight = false;
  private closed = false;
  private streamBuffer: Record<string, unknown>[] = [];
  private streamTimer: Timer | null = null;
  private streamAccumulator = createStreamAccumulator();
  private readonly workerState: WorkerStateUploader;
  private readonly eventUploader: SerialBatchEventUploader<ClientEvent>;
  private readonly internalEventUploader: SerialBatchEventUploader<WorkerInternalEventInput>;
  private readonly deliveryUploader: SerialBatchEventUploader<{ eventId: string; status: "received" | "processing" | "processed" }>;

  constructor(
    private readonly sessionBaseUrl: URL,
    private readonly transport: {
      setOnEvent(callback: (event: StreamClientEvent) => void): void;
      getLastSequenceNum(): number;
    },
    private readonly getHeaders: () => Record<string, string>,
    private readonly onEpochMismatch: () => never,
  ) {
    this.workerState = new WorkerStateUploader({
      send: (body) => this.request("PUT", "/worker", { worker_epoch: this.workerEpoch, ...body }).then((result) => result.ok),
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    });

    this.eventUploader = new SerialBatchEventUploader<ClientEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      maxQueueSize: 100_000,
      send: async (batch) => {
        const result = await this.request("POST", "/worker/events", {
          worker_epoch: this.workerEpoch,
          events: batch,
        });

        if (!result.ok) {
          throw new RetryableError("client event upload failed", result.retryAfterMs);
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    });

    this.internalEventUploader = new SerialBatchEventUploader<WorkerInternalEventInput>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      maxQueueSize: 200,
      send: async (batch) => {
        const result = await this.request("POST", "/worker/internal-events", {
          worker_epoch: this.workerEpoch,
          events: batch,
        });

        if (!result.ok) {
          throw new RetryableError("internal event upload failed", result.retryAfterMs);
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    });

    this.deliveryUploader = new SerialBatchEventUploader({
      maxBatchSize: 64,
      maxQueueSize: 64,
      send: async (batch) => {
        const result = await this.request("POST", "/worker/events/delivery", {
          worker_epoch: this.workerEpoch,
          updates: batch.map((item) => ({
            event_id: item.eventId,
            status: item.status,
          })),
        });

        if (!result.ok) {
          throw new RetryableError("delivery upload failed", result.retryAfterMs);
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    });

    this.transport.setOnEvent((event) => {
      this.reportDelivery(event.event_id, "received");
    });
  }
}
```

初始化：

```ts
async initialize(epoch: number) {
  if (!Number.isFinite(epoch)) {
    throw new Error("missing worker epoch");
  }

  this.workerEpoch = epoch;

  const restoredState = this.getWorkerState();

  const registered = await this.request("PUT", "/worker", {
    worker_epoch: this.workerEpoch,
    worker_status: "idle",
    external_metadata: {
      pending_action: null,
      task_summary: null,
      automation_state: null,
    },
  });

  if (!registered.ok) {
    throw new Error("worker init failed");
  }

  this.startHeartbeat();
  return restoredState;
}
```

HTTP request：

```ts
private async request(method: "POST" | "PUT", path: string, body: unknown): Promise<{ ok: true } | { ok: false; retryAfterMs?: number }> {
  const response = await fetch(new URL(this.sessionBaseUrl.pathname.replace(/\/$/, "") + path, this.sessionBaseUrl).href, {
    method,
    headers: {
      ...this.getHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status >= 200 && response.status < 300) {
    return { ok: true };
  }

  if (response.status === 409) {
    this.onEpochMismatch();
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));

    if (Number.isFinite(retryAfter)) {
      return { ok: false, retryAfterMs: retryAfter * 1000 };
    }
  }

  return { ok: false };
}
```

heartbeat：

```ts
private startHeartbeat() {
  this.stopHeartbeat();

  this.heartbeatTimer = setInterval(() => {
    void this.sendHeartbeat();
  }, 20_000);
}

private stopHeartbeat() {
  if (this.heartbeatTimer) {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

private async sendHeartbeat() {
  if (this.heartbeatInFlight) {
    return;
  }

  this.heartbeatInFlight = true;

  try {
    await this.request("POST", "/worker/heartbeat", {
      worker_epoch: this.workerEpoch,
    });
  } finally {
    this.heartbeatInFlight = false;
  }
}
```

写用户可见事件：

```ts
async writeEvent(message: Record<string, unknown>) {
  if (message.type === "stream_event") {
    this.streamBuffer.push(message);

    if (!this.streamTimer) {
      this.streamTimer = setTimeout(() => {
        void this.flushStreamBuffer();
      }, 100);
    }

    return;
  }

  await this.flushStreamBuffer();

  if (message.type === "assistant") {
    clearStreamAccumulatorForMessage(
      this.streamAccumulator,
      message as {
        session_id: string;
        parent_tool_use_id: string | null;
        message: { id: string };
      },
    );
  }

  await this.eventUploader.enqueue(this.toClientEvent(message));
}

private toClientEvent(message: Record<string, unknown>): ClientEvent {
  return {
    payload: {
      ...message,
      uuid: typeof message.uuid === "string" ? message.uuid : randomUUID(),
    } as ClientEvent["payload"],
  };
}
```

flush stream buffer：

```ts
private async flushStreamBuffer() {
  if (this.streamTimer) {
    clearTimeout(this.streamTimer);
    this.streamTimer = null;
  }

  if (this.streamBuffer.length === 0) {
    return;
  }

  const buffered = this.streamBuffer;
  this.streamBuffer = [];

  const payloads = accumulateStreamEvents(buffered, this.streamAccumulator);

  await this.eventUploader.enqueue(
    payloads.map((payload) => ({
      payload: {
        ...payload,
        uuid: typeof payload.uuid === "string" ? payload.uuid : randomUUID(),
      } as ClientEvent["payload"],
      ephemeral: true,
    })),
  );
}
```

写 internal events：

```ts
async writeInternalEvent(
  eventType: string,
  payload: Record<string, unknown>,
  options: { isCompaction?: boolean; agentId?: string } = {},
) {
  await this.internalEventUploader.enqueue({
    payload: {
      type: eventType,
      ...payload,
      uuid: typeof payload.uuid === "string" ? payload.uuid : randomUUID(),
    },
    ...(options.isCompaction ? { is_compaction: true } : {}),
    ...(options.agentId ? { agent_id: options.agentId } : {}),
  });
}

flushInternalEvents() {
  return this.internalEventUploader.flush();
}

get internalEventsPending() {
  return this.internalEventUploader.pendingCount;
}
```

读 internal events：

```ts
async readInternalEvents() {
  return this.paginatedGet("/worker/internal-events", {});
}

async readSubagentInternalEvents() {
  return this.paginatedGet("/worker/internal-events", { subagents: "true" });
}

private async paginatedGet(path: string, params: Record<string, string>) {
  const all = [];
  let cursor: string | undefined;

  do {
    const url = new URL(this.sessionBaseUrl.href.replace(/\/$/, "") + path);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url, {
      headers: this.getHeaders(),
    });

    if (response.status === 409) {
      this.onEpochMismatch();
    }

    if (!response.ok) {
      return null;
    }

    const page = (await response.json()) as ListInternalEventsResponse;
    all.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor);

  return all;
}
```

state 和 delivery：

```ts
reportState(state: string, details?: Record<string, unknown>) {
  this.workerState.enqueue({
    worker_status: state,
    requires_action_details: details ?? null,
  });
}

reportMetadata(metadata: Record<string, unknown>) {
  this.workerState.enqueue({
    external_metadata: metadata,
  });
}

reportDelivery(eventId: string, status: "received" | "processing" | "processed") {
  void this.deliveryUploader.enqueue({
    eventId,
    status,
  });
}

async flush() {
  await this.flushStreamBuffer();
  await this.eventUploader.flush();
}

close() {
  this.closed = true;
  this.stopHeartbeat();

  if (this.streamTimer) {
    clearTimeout(this.streamTimer);
  }

  this.workerState.close();
  this.eventUploader.close();
  this.internalEventUploader.close();
  this.deliveryUploader.close();
}
```

## Session Storage 接入

本地 transcript 现在要支持两种写入方式：

```txt
本地模式
  write JSONL file

CCR v2 模式
  write JSONL file
  write internal event
```

新增：

```txt
src/session/sessionStorage.ts
```

注册 writer：

```ts
type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>;

let internalEventWriter: InternalEventWriter | null = null;

export function setInternalEventWriter(writer: InternalEventWriter) {
  internalEventWriter = writer;
}
```

append transcript 时：

```ts
export async function appendTranscriptEntry(entry: TranscriptEntry) {
  await appendJsonl(getTranscriptPath(entry.sessionId), entry);

  if (internalEventWriter && isTranscriptMessage(entry)) {
    await internalEventWriter("transcript", entry as Record<string, unknown>, {
      ...(isCompactBoundary(entry) ? { isCompaction: true } : {}),
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
    });
  }
}
```

这里有三个关键点：

```txt
本地 JSONL 仍然写
internal event 只写 transcript message
compact boundary 标记 isCompaction
sidechain 标记 agentId
```

不要把所有 UI progress 都写成 internal event。

高频 progress 只会污染 resume。

## CCR Hydration

新增：

```txt
src/session/ccrHydration.ts
```

```ts
type InternalEventReader = () => Promise<{ payload: Record<string, unknown>; agent_id?: string }[] | null>;

let internalEventReader: InternalEventReader | null = null;
let subagentInternalEventReader: InternalEventReader | null = null;

export function setInternalEventReader(reader: InternalEventReader, subagentReader: InternalEventReader) {
  internalEventReader = reader;
  subagentInternalEventReader = subagentReader;
}
```

hydrate 主 transcript：

```ts
export async function hydrateFromCCRv2InternalEvents(sessionId: string) {
  if (!internalEventReader) {
    return false;
  }

  const events = await internalEventReader();

  if (!events) {
    return false;
  }

  await writeJsonl(
    getTranscriptPathForSession(sessionId),
    events.map((event) => event.payload),
  );

  await hydrateSubagentTranscripts();

  return events.length > 0;
}
```

hydrate subagent：

```ts
async function hydrateSubagentTranscripts() {
  if (!subagentInternalEventReader) {
    return;
  }

  const events = await subagentInternalEventReader();

  if (!events || events.length === 0) {
    return;
  }

  const byAgent = new Map<string, Record<string, unknown>[]>();

  for (const event of events) {
    if (!event.agent_id) {
      continue;
    }

    const list = byAgent.get(event.agent_id) ?? [];
    list.push(event.payload);
    byAgent.set(event.agent_id, list);
  }

  for (const [agentId, entries] of byAgent) {
    await writeJsonl(getAgentTranscriptPath(agentId), entries);
  }
}
```

这个过程会把远端 internal events 重新物化成本地 JSONL。

然后原有 `/resume` 或 `--resume` 逻辑就可以复用本地 transcript loader。

这就是源码里的设计：

```txt
远端恢复协议
  -> 先 hydrate 本地 transcript 文件
  -> 再走本地 resume loader
```

不要在 resume loader 里直接读远端事件。

那样会把本地和远端恢复逻辑耦合死。

## RemoteIO 接入

新增：

```txt
src/ccr/remoteIO.ts
```

它负责把 transport、CCRClient、session storage 串起来。

```ts
import { CCRClient } from "./ccrClient";
import { SSETransport } from "./sseTransport";
import { setInternalEventReader, setInternalEventWriter } from "../session/ccrHydration";

export class RemoteIO {
  private readonly transport: SSETransport;
  private readonly ccrClient: CCRClient | null;

  constructor(options: {
    sessionUrl: URL;
    workerEpoch: number;
    token: string;
    onData: (line: string) => void;
    onClose: () => void;
    useCcrV2: boolean;
    initialSequenceNum?: number;
  }) {
    const getHeaders = () => ({
      Authorization: `Bearer ${options.token}`,
    });

    const streamUrl = new URL(options.sessionUrl.href.replace(/\/$/, "") + "/worker/events/stream");
    const postUrl = new URL(options.sessionUrl.href.replace(/\/$/, "") + "/worker/events");

    this.transport = new SSETransport(streamUrl, postUrl, getHeaders, options.initialSequenceNum);
    this.transport.setOnData(options.onData);
    this.transport.setOnClose(options.onClose);

    if (options.useCcrV2) {
      this.ccrClient = new CCRClient(
        options.sessionUrl,
        this.transport,
        getHeaders,
        () => {
          throw new Error("worker epoch mismatch");
        },
      );

      const restoredWorkerState = this.ccrClient.initialize(options.workerEpoch);

      setInternalEventWriter((eventType, payload, eventOptions) =>
        this.ccrClient!.writeInternalEvent(eventType, payload, eventOptions),
      );

      setInternalEventReader(
        () => this.ccrClient!.readInternalEvents(),
        () => this.ccrClient!.readSubagentInternalEvents(),
      );

      void restoredWorkerState;
    } else {
      this.ccrClient = null;
    }

    void this.transport.connect();
  }
}
```

注意顺序：

```txt
1. 创建 transport
2. 设置 onData
3. 创建 CCRClient
4. CCRClient 注册 transport onEvent delivery ack
5. 注册 internal event writer/reader
6. connect transport
```

不要先 connect 再创建 CCRClient。

否则服务端一连上就 replay 的 client_event 可能先到，delivery ack callback 还没装好。

## Resume Flow

print / headless 模式里的 resume 逻辑：

```txt
parse session id
if CCR v2:
  await Promise.all([
    hydrateFromCCRv2InternalEvents(sessionId),
    restoredWorkerState,
  ])
  apply external_metadata
load local transcript
if no messages:
  run SessionStart hooks
else:
  resume conversation
```

Mini 版：

```ts
export async function resumeRemoteSession(options: {
  sessionId: string;
  restoredWorkerState: Promise<Record<string, unknown> | null>;
  useCcrV2: boolean;
}) {
  if (options.useCcrV2) {
    const [, metadata] = await Promise.all([
      hydrateFromCCRv2InternalEvents(options.sessionId),
      options.restoredWorkerState,
    ]);

    if (metadata) {
      restoreAppStateFromExternalMetadata(metadata);
    }
  }

  const loaded = await loadConversationForResume(options.sessionId);

  if (!loaded || loaded.messages.length === 0) {
    return {
      messages: await runSessionStartHooks("startup"),
    };
  }

  return loaded;
}
```

为什么 hydration 和 worker state 并发？

因为它们互不依赖：

```txt
internal events
  恢复 transcript

worker state
  恢复 metadata
```

并发可以缩短 resume 时间。

但 apply metadata 必须在 `loadConversationForResume` 前完成。

例如模型 override、permission mode、automation state 需要先恢复。

## Sequence High-Water Mark

SSE sequence 只属于 worker event stream。

它不属于 internal events。

Bridge/daemon 需要在 transport swap 或进程重启时保留它：

```ts
type BridgeState = {
  sessionId: string;
  lastSSESequenceNum: number;
};

function snapshotBridgeState(handle: { getSSESequenceNum(): number }, sessionId: string): BridgeState {
  return {
    sessionId,
    lastSSESequenceNum: handle.getSSESequenceNum(),
  };
}
```

恢复时：

```ts
const transport = new SSETransport(streamUrl, postUrl, getHeaders, saved.lastSSESequenceNum);
```

但只在同一个 session 上复用。

如果重新创建了新 session，必须清零：

```ts
if (saved.sessionId !== currentSessionId) {
  initialSequenceNum = 0;
}
```

这是源码里很重要的保护。

否则会出现：

```txt
旧 session last seq = 200
新 session event stream 从 1 开始
client 请求 from_sequence_num=200
服务端认为没有 missed events
用户输入被静默跳过
```

所以 sequence 是 session-scoped。

不能跨 session 携带。

## Delivery Status

CCR v2 会上报 client event delivery：

```txt
received
processing
processed
```

Mini 可以先做 no-op endpoint。

服务端：

```ts
app.post("/:id/worker/events/delivery", sessionIngressAuth, async (c) => {
  const sessionId = c.req.param("id");
  const session = await getSession(sessionId);

  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  const body = await c.req.json();
  const epochError = assertWorkerEpoch(sessionId, body.worker_epoch);

  if (epochError) {
    return epochError;
  }

  return c.json({ status: "ok" }, 200);
});
```

客户端：

```ts
transport.setOnEvent((event) => {
  ccrClient.reportDelivery(event.event_id, "received");
});
```

什么时候上报 processing / processed？

```txt
received
  SSETransport 成功解析 client_event

processing
  command lifecycle started

processed
  command lifecycle completed
```

Mini 可以先只实现 received。

但 endpoint 要留好。

## Worker Epoch 规则

本章所有写接口都要校验 epoch：

```txt
PUT  /worker
POST /worker/heartbeat
POST /worker/events
POST /worker/internal-events
POST /worker/events/delivery
```

GET 可以不校验 epoch，但必须鉴权。

为什么？

```txt
新 worker 可以读旧 worker 留下的 internal events 和 external metadata。
旧 worker 不能继续写入新 worker 的 session。
```

所以规则是：

```txt
read = auth
write = auth + current worker_epoch
```

409 的含义是：

```txt
你不是当前 worker。
立刻停止。
```

客户端不要无限重试 409。

## 测试：Internal Event Store

新增：

```txt
src/rcs/__tests__/internalEventStore.test.ts
```

测试列表：

```txt
appendInternalEvents stores payloads in order
listInternalEvents paginates with next_cursor
foreground list excludes subagent events
subagents=true returns only agent events
foreground list starts at latest compaction boundary
subagent list applies compaction boundary per agent
compaction boundary itself is included
resetInternalEventsForTesting clears store
```

伪测试：

```ts
test("foreground resume includes latest compaction boundary", () => {
  appendInternalEvents("s1", [
    { payload: { uuid: "1", type: "transcript", text: "old" } },
    { payload: { uuid: "2", type: "transcript", text: "summary" }, is_compaction: true },
    { payload: { uuid: "3", type: "transcript", text: "new" } },
  ]);

  const page = listInternalEvents("s1", {});

  expect(page.data.map((event) => event.payload.uuid)).toEqual(["2", "3"]);
});
```

Subagent：

```ts
test("subagent resume applies compaction per agent", () => {
  appendInternalEvents("s1", [
    { agent_id: "a1", payload: { uuid: "a1-old", type: "transcript" } },
    { agent_id: "a1", payload: { uuid: "a1-summary", type: "transcript" }, is_compaction: true },
    { agent_id: "a2", payload: { uuid: "a2-old", type: "transcript" } },
  ]);

  const page = listInternalEvents("s1", { subagents: true });

  expect(page.data.map((event) => event.payload.uuid)).toEqual(["a1-summary", "a2-old"]);
});
```

## 测试：Routes

新增：

```txt
src/rcs/__tests__/workerInternalEventsRoutes.test.ts
```

测试列表：

```txt
POST /worker/internal-events rejects missing session
POST /worker/internal-events rejects stale worker_epoch with 409
POST /worker/internal-events stores batch
GET /worker/internal-events returns foreground events
GET /worker/internal-events?subagents=true returns subagent events
GET /worker/internal-events supports cursor pagination
GET does not publish events to EventBus
```

伪测试：

```ts
test("internal events are not visible on EventBus", async () => {
  const app = createTestRcsApp();
  await createSession({ id: "s1", workerEpoch: 1 });

  const response = await app.request("/v1/code/sessions/s1/worker/internal-events", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      worker_epoch: 1,
      events: [
        {
          payload: {
            type: "transcript",
            uuid: "u1",
            message: "hidden",
          },
        },
      ],
    }),
  });

  expect(response.status).toBe(200);
  expect(getEventBus("s1").getEventsSince(0)).toEqual([]);
});
```

## 测试：SSETransport

新增：

```txt
src/ccr/__tests__/sseTransport.test.ts
```

测试列表：

```txt
parseSSEFrames parses event/id/data
parseSSEFrames supports multiple data lines
parseSSEFrames keeps incomplete frame in remaining
connect sends from_sequence_num when initialSequenceNum > 0
connect sends Last-Event-ID when initialSequenceNum > 0
client_event payload is emitted as NDJSON
lastSequenceNum advances from frame id
duplicate sequence is ignored for high-water update
liveness timeout triggers reconnect
401 closes permanently
403 closes permanently
404 closes permanently
```

不要只测 parser。

最容易坏的是断线恢复参数。

## 测试：CCRClient

新增：

```txt
src/ccr/__tests__/ccrClient.test.ts
```

测试列表：

```txt
initialize PUTs worker idle with worker_epoch
initialize reads worker state
heartbeat includes worker_epoch
writeEvent injects uuid
stream_event is buffered
non-stream message flushes stream buffer first
text_delta emits full-so-far snapshot
assistant message clears stream accumulator
writeInternalEvent posts transcript batch
writeInternalEvent marks compaction
writeInternalEvent includes agent_id
readInternalEvents paginates until next_cursor is absent
readSubagentInternalEvents passes subagents=true
reportDelivery batches delivery updates
409 calls onEpochMismatch
429 retry-after is honored by uploader
flushInternalEvents waits until internal queue drains
```

伪测试：

```ts
test("writeInternalEvent marks compaction and agent id", async () => {
  const requests: unknown[] = [];
  const client = createTestCCRClient({
    onRequest(_method, path, body) {
      requests.push({ path, body });
      return { status: 200, body: { ok: true } };
    },
  });

  await client.initialize(1);
  await client.writeInternalEvent(
    "transcript",
    { uuid: "u1", type: "system" },
    { isCompaction: true, agentId: "agent-1" },
  );
  await client.flushInternalEvents();

  expect(JSON.stringify(requests)).toContain("/worker/internal-events");
  expect(JSON.stringify(requests)).toContain('"is_compaction":true');
  expect(JSON.stringify(requests)).toContain('"agent_id":"agent-1"');
});
```

## 测试：Hydration

新增：

```txt
src/session/__tests__/ccrHydration.test.ts
```

测试列表：

```txt
hydrate returns false when no reader registered
hydrate writes foreground transcript file
hydrate writes empty transcript for fresh session
hydrate groups subagent events by agent_id
hydrate ignores subagent events without agent_id
hydrate returns false when reader fails
hydrate keeps event payload exactly
```

伪测试：

```ts
test("hydrate writes foreground payloads to session transcript", async () => {
  setInternalEventReader(
    async () => [
      { payload: { type: "user", uuid: "u1", message: { role: "user", content: "hello" } } },
      { payload: { type: "assistant", uuid: "u2", message: { role: "assistant", content: "hi" } } },
    ],
    async () => [],
  );

  const ok = await hydrateFromCCRv2InternalEvents("s1");

  expect(ok).toBe(true);
  expect(await readTranscript("s1")).toContain('"uuid":"u1"');
});
```

## 手动验证

启动 RCS：

```bash
MINI_RCS_API_KEYS=dev-secret bun run rcs
```

创建 code session：

```bash
curl -X POST http://localhost:8787/v1/code/sessions \
  -H "x-api-key: dev-secret" \
  -H "content-type: application/json" \
  -d '{"title":"CCR v2 resume smoke"}'
```

注册 worker：

```bash
curl -X POST http://localhost:8787/v1/code/sessions/SESSION_ID/worker/register \
  -H "x-api-key: dev-secret"
```

写 internal events：

```bash
curl -X POST http://localhost:8787/v1/code/sessions/SESSION_ID/worker/internal-events \
  -H "x-api-key: dev-secret" \
  -H "content-type: application/json" \
  -d '{"worker_epoch":1,"events":[{"payload":{"type":"transcript","uuid":"u1","message":{"role":"user","content":"hello"}}}]}'
```

读取 foreground：

```bash
curl http://localhost:8787/v1/code/sessions/SESSION_ID/worker/internal-events \
  -H "x-api-key: dev-secret"
```

读取 subagents：

```bash
curl "http://localhost:8787/v1/code/sessions/SESSION_ID/worker/internal-events?subagents=true" \
  -H "x-api-key: dev-secret"
```

验证 worker stream resume：

```bash
curl -N "http://localhost:8787/v1/code/sessions/SESSION_ID/worker/events/stream?from_sequence_num=0" \
  -H "x-api-key: dev-secret"
```

最后跑：

```bash
bun test src/ccr src/rcs src/session
bun run typecheck
```

## 常见问题

### Resume 后没有历史

先查：

```txt
是否注册 internal event reader
是否写了 /worker/internal-events
GET 是否返回 data
payload 是否就是 transcript entry
```

不要只看 EventBus。

Internal events 不在 EventBus 里。

### Web UI 看到了 transcript internal events

说明你把 internal events publish 到 EventBus 了。

修正：

```txt
/worker/events
  publish EventBus

/worker/internal-events
  append InternalEventStore
```

两者分开。

### compaction 后恢复太多历史

检查服务端是否从最新 `is_compaction` 开始返回。

并且 boundary 本身要包含。

正确：

```txt
[old, old, compact-summary, new]
  -> [compact-summary, new]
```

错误：

```txt
[old, old, compact-summary, new]
  -> [new]
```

这样会丢 summary。

### 新 session 收不到事件

检查 SSE sequence 是否跨 session 复用了。

如果 session id 变了，必须：

```txt
lastSequenceNum = 0
```

### 409 后客户端还在重试

409 是 epoch mismatch。

它不是临时错误。

客户端必须停止当前 worker。

继续写只会污染日志，并且永远不会成功。

### stream_event 恢复时只有半句话

检查 text_delta 是否 full-so-far。

错误：

```txt
delta: "llo"
```

正确：

```txt
delta: "hello"
```

每次 flush 的 snapshot 都要自包含。

### internal event flush 太慢

CCR v2 下 session storage flush interval 应该更短。

Mini 可以用：

```txt
10ms
```

但不要每次 append 都阻塞主循环太久。

用 uploader 串行 drain 即可。

## 和官方能力的差距

本章 Mini 已经具备 CCR v2 resume 的核心，但仍有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| Internal event store | 内存数组 | 数据库存储、索引、TTL、审计 |
| Compaction filtering | 最新 boundary | 多种 compact metadata、preserved segment relink |
| Subagent resume | 按 agent_id 分组 | sidechain metadata、agent type、worktree path |
| Worker stream resume | seqNum + Last-Event-ID | catch_up_truncated、持久化 cursor |
| Delivery status | received/no-op | processing/processed、重投递策略 |
| State restore | external_metadata | app state 全量映射、模型 override、权限态 |
| Stream coalescing | text_delta full-so-far | tool input streaming、message boundary 追踪 |
| Epoch mismatch | 409 退出 | parent respawn、in-process graceful close |
| Uploaders | 串行内存队列 | backpressure telemetry、drop policy、server hints |
| Auth | API key / worker token | 短期 JWT、刷新、组织权限 |

不过从“接近官方 Claude Code”的目标看，本章已经补上了最重要的恢复模型。

没有 internal events，远程 session 只能看实时输出。

有了 internal events，远程 session 才能真正恢复成可继续对话的本地状态。

## 本章小结

本章给 Mini 补上了 CCR v2 的恢复协议。

核心链路是：

```txt
user-visible events
  -> /worker/events
  -> EventBus
  -> Web / worker stream

internal transcript events
  -> /worker/internal-events
  -> InternalEventStore
  -> hydrate local JSONL
  -> resume conversation

worker state
  -> /worker
  -> external_metadata
  -> restore app state

SSE stream
  -> sequence_num
  -> Last-Event-ID / from_sequence_num
  -> reconnect without replaying everything
```

这章最重要的原则是：

```txt
实时展示和会话恢复分离。
EventBus 不是 transcript store。
InternalEventStore 不是 UI stream。
SSE sequence 只属于当前 session。
worker_epoch 保护写入所有权。
```

到这里，Mini 已经具备远程 session 长期运行、worker 重启、CLI resume、subagent transcript 恢复的基本闭环。

下一章可以继续补 **Daemon Supervisor、Work Queue、Capacity 与 Heartbeat 调度**：让远程 session 不只是能恢复，还能被一个长期运行的 supervisor 稳定接单、限流和回收。
