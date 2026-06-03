# 第 51 章：WebSocket Subscribe、Remote Detail Dialog 与 Web 控制台

第 50 章把 Remote Control Server 做成了一个可靠控制平面：

```txt
API key / web token / worker JWT
worker_epoch
heartbeat
worker state
event bus seqNum
SSE resume
archive
```

但它还偏“后端”。

真实的 Claude Code 远程控制能力必须让用户看见、操作、恢复、打断一个远端 session。

这章继续补三块：

```txt
WebSocket Subscribe
  bridge / worker / legacy client 的双向事件通道

Remote Detail Dialog
  终端里的 remote task 详情面板

Web Console
  浏览器里的 session list / detail / chat / permission / interrupt
```

到本章结束，你的 Mini 会具备：

- session ingress WebSocket 订阅端点
- WebSocket auth token 从 header / query / subprotocol 中解析
- 同 session 只保留一个活跃 WebSocket
- WebSocket 打开时重放 session history
- live outbound events 自动推送给 WebSocket client
- client 通过 NDJSON 写入 user / permission / control / interrupt events
- keep_alive 与 idle timeout
- Web 端 session list
- Web 端 session detail
- Web 端 history 拉取
- Web 端 SSE 实时订阅
- Web 端 chat adapter
- Web 端 permission approval / rejection
- Web 端 interrupt
- 终端 remote session detail dialog
- task progress / recent logs / session URL / teleport / stop

这章不是“给 RCS 加一个页面”。

它是在做一件更重要的事：

```txt
让同一份 session event log 同时服务三种入口：

1. worker / bridge 的协议连接
2. 终端内的任务详情
3. 浏览器里的远程控制台
```

如果这层做错，后面补 daemon、环境调度、多客户端控制都会变成重复造轮子。

## 参考源码

本章参考这些真实模块：

```txt
packages/remote-control-server/src/index.ts
packages/remote-control-server/src/routes/v1/session-ingress.ts
packages/remote-control-server/src/routes/web/sessions.ts
packages/remote-control-server/src/routes/web/control.ts
packages/remote-control-server/src/transport/ws-handler.ts
packages/remote-control-server/src/transport/ws-payload.ts
packages/remote-control-server/src/transport/ws-shared.ts
packages/remote-control-server/src/transport/event-bus.ts
packages/remote-control-server/src/transport/sse-writer.ts
packages/remote-control-server/src/transport/client-payload.ts

packages/remote-control-server/web/src/api/client.ts
packages/remote-control-server/web/src/api/sse.ts
packages/remote-control-server/web/src/lib/rcs-chat-adapter.ts
packages/remote-control-server/web/src/lib/rcs-transport.ts
packages/remote-control-server/web/src/pages/Dashboard.tsx
packages/remote-control-server/web/src/pages/SessionDetail.tsx
packages/remote-control-server/web/src/components/SessionList.tsx
packages/remote-control-server/web/src/components/PermissionViews.tsx
packages/remote-control-server/web/src/components/TaskPanel.tsx

src/remote/SessionsWebSocket.ts
src/remote/RemoteSessionManager.ts
src/hooks/useRemoteSession.ts
src/components/tasks/RemoteSessionDetailDialog.tsx
src/components/tasks/RemoteSessionProgress.tsx
```

源码里有几个关键事实：

1. RCS 的 `/v1/session_ingress/ws/:sessionId` 是面向 bridge / worker 的 WebSocket。
2. WebSocket 打开时会从 EventBus 里重放 history。
3. WebSocket live subscribe 只把 outbound events 推给 client。
4. Web 控制台不直接使用这个 WebSocket，而是走 `/web/sessions/:id/events` SSE。
5. Web 控制台写入 user message 走 `/web/sessions/:id/events`。
6. Web 控制台写入 permission / control response 走 `/web/sessions/:id/control`。
7. Web 控制台打断走 `/web/sessions/:id/interrupt`。
8. 终端 `RemoteSessionDetailDialog` 不是 chat 页面，它是 background task 的详情视图。

所以本章 Mini 的原则是：

```txt
协议连接用 WebSocket
浏览器展示用 SSE
控制写入用 HTTP
终端详情读 task state
```

不要强行让三者共用同一个连接类型。

## 本章目标

最终形态如下：

```txt
                 ┌────────────────────────────┐
                 │       RCS EventBus          │
                 │  seqNum + session events    │
                 └─────────────┬──────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
       WebSocket Subscribe   Web SSE       HTTP History
       bridge / worker       browser       initial render
              │                │                │
              │                ▼                │
              │          Web Console           │
              │       chat / permission        │
              │       interrupt / task panel   │
              │                                 │
              ▼                                 ▼
       Remote worker                    Terminal Dialog
       outbound stream                  task state view
```

数据方向要分清：

```txt
inbound
  worker / bridge / web 把事件写进 RCS

outbound
  RCS 把用户消息、权限结果、interrupt 推给 worker

web stream
  浏览器看到完整 session 事件

detail view
  终端看到 task 摘要和最近日志
```

这一章会把 Mini 拆成四层：

```txt
src/rcs/wsPayload.ts
src/rcs/wsHandler.ts
src/rcs/webRoutes.ts
src/rcs/server.ts

src/web/api/client.ts
src/web/api/sse.ts
src/web/lib/rcsChatAdapter.ts
src/web/pages/Dashboard.tsx
src/web/pages/SessionDetail.tsx

src/remote/SessionsWebSocket.ts
src/remote/RemoteSessionManager.ts

src/tasks/RemoteSessionDetailDialog.tsx
src/tasks/RemoteSessionProgress.tsx
```

如果你的 Mini 前面章节文件名不完全一样，按现有结构合并即可。

核心不是路径，而是边界。

## 协议边界

先定义一份通用事件。

第 50 章已经有 `SessionEvent`，这里补足 WebSocket 和 Web console 需要的字段。

```ts
export type SessionEventDirection = "inbound" | "outbound";

export type SessionEventType =
  | "assistant"
  | "user"
  | "system"
  | "partial"
  | "tool_use"
  | "tool_result"
  | "control_request"
  | "control_response"
  | "permission_request"
  | "permission_response"
  | "session_status"
  | "task_state"
  | "automation_state"
  | "interrupt"
  | "error"
  | "result"
  | "keep_alive";

export type SessionEvent = {
  id: string;
  sessionId: string;
  seqNum: number;
  direction: SessionEventDirection;
  type: SessionEventType;
  timestamp: string;
  payload: Record<string, unknown>;
};
```

WebSocket 收到的 payload 不应该直接信任。

Mini 要做一层归一化：

```txt
raw websocket message
  -> decode string
  -> split by newline
  -> parse JSON
  -> size guard
  -> normalize event type
  -> publish inbound event
```

Web 控制台走 HTTP 写入时也要走同样的归一化逻辑。

否则会出现一种很难查的问题：

```txt
WebSocket 写入的 user event
和 HTTP 写入的 user event
字段长得不一样
```

后面的 adapter 就会到处写兼容分支。

## WebSocket Payload

新增：

```txt
src/rcs/wsPayload.ts
```

```ts
const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type DecodedWsPayload =
  | {
      ok: true;
      lines: string[];
    }
  | {
      ok: false;
      code: 1003 | 1009;
      reason: string;
    };

export function decodeWsMessage(message: string | ArrayBuffer | Uint8Array): DecodedWsPayload {
  let text: string;

  if (typeof message === "string") {
    text = message;
  } else if (message instanceof ArrayBuffer) {
    if (message.byteLength > MAX_WS_PAYLOAD_BYTES) {
      return { ok: false, code: 1009, reason: "payload too large" };
    }
    text = new TextDecoder().decode(message);
  } else {
    if (message.byteLength > MAX_WS_PAYLOAD_BYTES) {
      return { ok: false, code: 1009, reason: "payload too large" };
    }
    text = new TextDecoder().decode(message);
  }

  const size = new TextEncoder().encode(text).byteLength;

  if (size > MAX_WS_PAYLOAD_BYTES) {
    return { ok: false, code: 1009, reason: "payload too large" };
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return { ok: true, lines };
}
```

为什么用 NDJSON？

因为真实 stream 中一个网络包可能包含多条事件：

```txt
{"type":"user","content":"hello"}\n
{"type":"permission_response","approved":true}\n
```

如果只按一次 message 解析一次 JSON，批量写入会丢事件。

也不要把 WebSocket 当作“每条业务事件一个 frame”的强假设。

## 事件归一化

新增：

```txt
src/rcs/eventNormalize.ts
```

```ts
import type { SessionEventType } from "./types";

export type NormalizedIngressEvent = {
  type: SessionEventType;
  payload: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeIngressPayload(raw: unknown): NormalizedIngressEvent {
  if (!isRecord(raw)) {
    return {
      type: "error",
      payload: {
        message: "invalid payload",
        raw,
      },
    };
  }

  const explicitType = asString(raw.type);

  if (explicitType === "keep_alive") {
    return {
      type: "keep_alive",
      payload: raw,
    };
  }

  if (explicitType === "interrupt") {
    return {
      type: "interrupt",
      payload: raw,
    };
  }

  if (explicitType === "permission_response") {
    return {
      type: "permission_response",
      payload: raw,
    };
  }

  if (explicitType === "control_response") {
    return {
      type: "control_response",
      payload: raw,
    };
  }

  if (explicitType === "control_request") {
    return {
      type: "control_request",
      payload: raw,
    };
  }

  if (explicitType === "tool_use" || explicitType === "tool_result") {
    return {
      type: explicitType,
      payload: raw,
    };
  }

  const message = raw.message;

  if (isRecord(message)) {
    const role = asString(message.role);

    if (role === "assistant" || role === "user" || role === "system") {
      return {
        type: role,
        payload: raw,
      };
    }
  }

  const role = asString(raw.role);

  if (role === "assistant" || role === "user" || role === "system") {
    return {
      type: role,
      payload: raw,
    };
  }

  if (explicitType) {
    return {
      type: explicitType as SessionEventType,
      payload: raw,
    };
  }

  return {
    type: "system",
    payload: raw,
  };
}
```

这里不要太聪明。

归一化的目标不是理解所有 SDK message，而是把 event type 稳定下来。

复杂内容解析留给 Web adapter 和终端 renderer。

## WebSocket Handler

新增：

```txt
src/rcs/wsHandler.ts
```

核心职责有五个：

```txt
1. 同 session 替换旧连接
2. 打开时 replay history
3. live subscribe outbound events
4. 收 inbound NDJSON
5. keep_alive / idle cleanup
```

先写连接状态：

```ts
import type { ServerWebSocket } from "bun";
import { decodeWsMessage } from "./wsPayload";
import { normalizeIngressPayload } from "./eventNormalize";
import { getEventBus, publishSessionEvent } from "./eventBus";
import type { SessionEvent } from "./types";

type RcsWsData = {
  sessionId: string;
};

type RcsSocket = ServerWebSocket<RcsWsData>;

type ActiveConnection = {
  sessionId: string;
  socket: RcsSocket;
  unsubscribe: () => void;
  keepAliveTimer: Timer;
  lastSeenAt: number;
};

const activeBySession = new Map<string, ActiveConnection>();
const activeSockets = new Set<RcsSocket>();

const KEEP_ALIVE_INTERVAL_MS = 15_000;
const CLIENT_IDLE_MS = KEEP_ALIVE_INTERVAL_MS * 3;
```

发送统一走一个函数。

```ts
function sendEvent(socket: RcsSocket, event: SessionEvent) {
  const payload = {
    type: event.type,
    session_id: event.sessionId,
    seq_num: event.seqNum,
    timestamp: event.timestamp,
    direction: event.direction,
    payload: event.payload,
  };

  socket.send(`${JSON.stringify(payload)}\n`);
}

function sendKeepAlive(socket: RcsSocket) {
  socket.send(
    `${JSON.stringify({
      type: "keep_alive",
      timestamp: new Date().toISOString(),
    })}\n`,
  );
}
```

打开连接：

```ts
export function handleWebSocketOpen(socket: RcsSocket) {
  const { sessionId } = socket.data;

  const previous = activeBySession.get(sessionId);

  if (previous) {
    cleanupConnection(previous, 1000, "replaced by a newer connection");
  }

  const bus = getEventBus(sessionId);

  for (const event of bus.getEventsSince(0)) {
    sendEvent(socket, event);
  }

  const connection: ActiveConnection = {
    sessionId,
    socket,
    lastSeenAt: Date.now(),
    unsubscribe: bus.subscribe((event) => {
      if (event.direction === "outbound") {
        sendEvent(socket, event);
      }
    }),
    keepAliveTimer: setInterval(() => {
      const now = Date.now();

      if (now - connection.lastSeenAt > CLIENT_IDLE_MS) {
        cleanupConnection(connection, 1001, "client idle timeout");
        return;
      }

      sendKeepAlive(socket);
    }, KEEP_ALIVE_INTERVAL_MS),
  };

  activeBySession.set(sessionId, connection);
  activeSockets.add(socket);
}
```

注意这里有一个容易误解的点。

打开连接时 replay history 可以重放全部事件。

但 live subscribe 只转发 outbound。

原因是 WebSocket 订阅对象通常是 worker / bridge。

它们需要拿到用户输入、权限响应、interrupt 这些 outbound 控制事件。

如果把 inbound assistant output 再推回给 worker，很容易造成 echo 或重复处理。

收到消息：

```ts
export async function handleWebSocketMessage(socket: RcsSocket, message: string | ArrayBuffer | Uint8Array) {
  const connection = activeBySession.get(socket.data.sessionId);

  if (connection) {
    connection.lastSeenAt = Date.now();
  }

  const decoded = decodeWsMessage(message);

  if (!decoded.ok) {
    socket.close(decoded.code, decoded.reason);
    return;
  }

  for (const line of decoded.lines) {
    let raw: unknown;

    try {
      raw = JSON.parse(line);
    } catch {
      await publishSessionEvent(socket.data.sessionId, "inbound", "error", {
        message: "invalid json from websocket",
        line,
      });
      continue;
    }

    const normalized = normalizeIngressPayload(raw);

    if (normalized.type === "keep_alive") {
      continue;
    }

    await publishSessionEvent(socket.data.sessionId, "inbound", normalized.type, normalized.payload);
  }
}
```

关闭连接：

```ts
function cleanupConnection(connection: ActiveConnection, code?: number, reason?: string) {
  connection.unsubscribe();
  clearInterval(connection.keepAliveTimer);
  activeBySession.delete(connection.sessionId);
  activeSockets.delete(connection.socket);

  try {
    connection.socket.close(code, reason);
  } catch {
    // ignore close races
  }
}

export function handleWebSocketClose(socket: RcsSocket) {
  const connection = activeBySession.get(socket.data.sessionId);

  if (connection?.socket === socket) {
    cleanupConnection(connection);
  }
}

export function closeAllWebSockets() {
  for (const connection of activeBySession.values()) {
    cleanupConnection(connection, 1001, "server shutting down");
  }

  activeBySession.clear();
  activeSockets.clear();
}
```

这里有两个测试必须补：

```txt
同一个 session 新连接打开时，旧连接会被关闭
旧连接 close 事件晚到时，不能误删新连接
```

第二个场景非常常见。

所以 `handleWebSocketClose()` 里必须检查 `connection.socket === socket`。

## Session Ingress Route

新增或扩展：

```txt
src/rcs/sessionIngressRoutes.ts
```

Mini 版只保留两类 endpoint：

```txt
POST /v1/session_ingress/session/:sessionId/events
GET  /v1/session_ingress/ws/:sessionId

POST /v2/session_ingress/session/:sessionId/events
GET  /v2/session_ingress/ws/:sessionId
```

v1 / v2 可以先共用同一套实现。

```ts
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { authenticateSessionIngress } from "./auth";
import { getSession } from "./store";
import { handleWebSocketClose, handleWebSocketMessage, handleWebSocketOpen } from "./wsHandler";
import { normalizeIngressPayload } from "./eventNormalize";
import { publishSessionEvent } from "./eventBus";

export function createSessionIngressRoutes() {
  const app = new Hono();

  app.post("/session/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const auth = await authenticateSessionIngress(c.req.raw, sessionId);

    if (!auth.ok) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const session = await getSession(sessionId);

    if (!session) {
      return c.json({ error: "session not found" }, 404);
    }

    const body = await c.req.json();
    const events = Array.isArray(body.events) ? body.events : [body];

    for (const raw of events) {
      const normalized = normalizeIngressPayload(raw);

      if (normalized.type === "keep_alive") {
        continue;
      }

      await publishSessionEvent(sessionId, "inbound", normalized.type, normalized.payload);
    }

    return c.json({ ok: true });
  });

  app.get(
    "/ws/:sessionId",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("sessionId");

      return {
        async onOpen(_event, socket) {
          const auth = await authenticateSessionIngress(c.req.raw, sessionId);

          if (!auth.ok) {
            socket.close(4003, "unauthorized");
            return;
          }

          const session = await getSession(sessionId);

          if (!session) {
            socket.close(4001, "session not found");
            return;
          }

          socket.raw!.data = { sessionId };
          handleWebSocketOpen(socket.raw!);
        },
        async onMessage(event, socket) {
          await handleWebSocketMessage(socket.raw!, event.data);
        },
        onClose(_event, socket) {
          handleWebSocketClose(socket.raw!);
        },
      };
    }),
  );

  return app;
}
```

如果你的 Hono wrapper 拿不到 `socket.raw`，就把 `sessionId` 放到闭包里。

Mini 的重点不是框架写法，而是这三个行为：

```txt
unauthorized -> close 4003
missing session -> close 4001
authorized -> open + replay + subscribe
```

## WebSocket Auth

WebSocket 最大的问题是：

```txt
浏览器和一些运行环境不方便设置 Authorization header
```

所以源码支持多种 token 入口：

```txt
Authorization: Bearer xxx
X-Api-Key: xxx
?token=xxx
Sec-WebSocket-Protocol: token.xxx
```

Mini 可以实现一个足够清晰的版本。

```ts
export function extractWebSocketToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");

  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  const apiKey = request.headers.get("x-api-key");

  if (apiKey) {
    return apiKey;
  }

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");

  if (queryToken) {
    return queryToken;
  }

  const protocol = request.headers.get("sec-websocket-protocol");

  if (!protocol) {
    return undefined;
  }

  for (const part of protocol.split(",")) {
    const value = part.trim();

    if (value.startsWith("token.")) {
      return value.slice("token.".length);
    }
  }

  return undefined;
}
```

不要把 token 写进日志。

auth 失败时只返回：

```txt
unauthorized
```

不要输出 token 值，也不要输出完整 header。

## Web Routes

Web 控制台不走 session ingress WebSocket。

它需要这些路由：

```txt
POST /web/sessions
GET  /web/sessions
GET  /web/sessions/all
GET  /web/sessions/:id
GET  /web/sessions/:id/history
GET  /web/sessions/:id/events
POST /web/sessions/:id/events
POST /web/sessions/:id/control
POST /web/sessions/:id/interrupt
```

把它们放到：

```txt
src/rcs/webRoutes.ts
```

先做 ownership helper：

```ts
import type { Context } from "hono";
import { getSession, listSessions, updateSession } from "./store";

function getUuid(c: Context): string | undefined {
  const url = new URL(c.req.url);
  return url.searchParams.get("uuid") ?? c.req.header("x-rcs-uuid") ?? undefined;
}

function isClosedStatus(status: string | undefined) {
  return status === "archived" || status === "failed" || status === "completed";
}

async function resolveOwnedSession(c: Context, sessionId: string) {
  const uuid = getUuid(c);

  if (!uuid) {
    return { ok: false as const, status: 401, error: "missing uuid" };
  }

  const session = await getSession(sessionId);

  if (!session) {
    return { ok: false as const, status: 404, error: "session not found" };
  }

  if (session.ownerUuid !== uuid) {
    return { ok: false as const, status: 403, error: "forbidden" };
  }

  return { ok: true as const, uuid, session };
}
```

创建和列表：

```ts
import { Hono } from "hono";
import { createSSEStream } from "./sseWriter";
import { getEventBus, publishSessionEvent } from "./eventBus";

export function createWebRoutes() {
  const app = new Hono();

  app.post("/sessions", async (c) => {
    const uuid = getUuid(c);

    if (!uuid) {
      return c.json({ error: "missing uuid" }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const session = await createSession({
      ownerUuid: uuid,
      title: typeof body.title === "string" ? body.title : "New session",
      status: "idle",
    });

    return c.json({ session });
  });

  app.get("/sessions", async (c) => {
    const uuid = getUuid(c);

    if (!uuid) {
      return c.json({ error: "missing uuid" }, 401);
    }

    const sessions = await listSessions({ ownerUuid: uuid });
    return c.json({ sessions });
  });

  app.get("/sessions/all", async (c) => {
    const uuid = getUuid(c);

    if (!uuid) {
      return c.json({ error: "missing uuid" }, 401);
    }

    const sessions = await listSessions({ ownerUuid: uuid });
    return c.json({ sessions });
  });

  return app;
}
```

详情和历史：

```ts
app.get("/sessions/:id", async (c) => {
  const resolved = await resolveOwnedSession(c, c.req.param("id"));

  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status);
  }

  return c.json({ session: resolved.session });
});

app.get("/sessions/:id/history", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveOwnedSession(c, sessionId);

  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status);
  }

  const events = getEventBus(sessionId).getEventsSince(0);
  return c.json({ events });
});
```

SSE stream：

```ts
app.get("/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveOwnedSession(c, sessionId);

  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status);
  }

  if (isClosedStatus(resolved.session.status)) {
    return c.json({ error: "session is closed" }, 409);
  }

  const lastEventId = c.req.header("last-event-id");
  const fromSeqNum = lastEventId ? Number(lastEventId) : 0;

  return createSSEStream(sessionId, Number.isFinite(fromSeqNum) ? fromSeqNum : 0);
});
```

用户消息写入：

```ts
app.post("/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveOwnedSession(c, sessionId);

  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status);
  }

  if (isClosedStatus(resolved.session.status)) {
    return c.json({ error: "session is closed" }, 409);
  }

  const body = await c.req.json();
  const normalized = normalizeIngressPayload(body);

  await publishSessionEvent(sessionId, "outbound", normalized.type, normalized.payload);

  return c.json({ ok: true });
});
```

这里 direction 是 `outbound`。

从 Web 用户视角看它是“发出去”。

从 RCS 视角看，它是要推给 worker 的控制输入。

所以它必须进入 outbound stream。

权限和控制响应：

```ts
app.post("/sessions/:id/control", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveOwnedSession(c, sessionId);

  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status);
  }

  if (isClosedStatus(resolved.session.status)) {
    return c.json({ error: "session is closed" }, 409);
  }

  const body = await c.req.json();
  const normalized = normalizeIngressPayload(body);

  await publishSessionEvent(sessionId, "outbound", normalized.type, normalized.payload);

  return c.json({ ok: true });
});
```

打断：

```ts
app.post("/sessions/:id/interrupt", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveOwnedSession(c, sessionId);

  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status);
  }

  if (isClosedStatus(resolved.session.status)) {
    return c.json({ error: "session is closed" }, 409);
  }

  await publishSessionEvent(sessionId, "outbound", "interrupt", {
    reason: "user_interrupt",
  });

  await updateSession(sessionId, {
    status: "idle",
    updatedAt: new Date().toISOString(),
  });

  return c.json({ ok: true });
});
```

这三个写入 endpoint 的差异很小。

但建议保留分开的路径。

因为它们代表不同权限：

```txt
events
  普通用户消息

control
  权限确认、问题回答、计划更新

interrupt
  中断执行
```

以后做组织权限时可以分别收敛。

## Server 入口

在：

```txt
src/rcs/server.ts
```

挂载路由：

```ts
import { Hono } from "hono";
import { createSessionIngressRoutes } from "./sessionIngressRoutes";
import { createWebRoutes } from "./webRoutes";
import { closeAllWebSockets } from "./wsHandler";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

const sessionIngress = createSessionIngressRoutes();
const webRoutes = createWebRoutes();

app.route("/v1/session_ingress", sessionIngress);
app.route("/v2/session_ingress", sessionIngress);
app.route("/web", webRoutes);

const server = Bun.serve({
  port: Number(process.env.RCS_PORT ?? 8787),
  fetch: app.fetch,
  websocket,
  idleTimeout: 120,
});

process.on("SIGTERM", () => {
  closeAllWebSockets();
  server.stop(true);
});

process.on("SIGINT", () => {
  closeAllWebSockets();
  server.stop(true);
});
```

真实源码还会挂：

```txt
/code/*
/v1/code/sessions
/v1/code/worker
/v1/code/worker/events
/v1/code/worker/events/stream
/acp
```

Mini 可以后面补。

本章只要求 WebSocket subscribe 与 Web console 闭环。

## Web API Client

现在做浏览器端。

新增：

```txt
src/web/api/client.ts
```

浏览器端需要一个稳定 UUID。

它不是安全凭证，只是开发版 ownership 标识。

```ts
let activeApiToken: string | undefined;

export function setActiveApiToken(token: string | undefined) {
  activeApiToken = token;
}

export function getUuid() {
  const key = "mini_rcs_uuid";
  const existing = window.localStorage.getItem(key);

  if (existing) {
    return existing;
  }

  const value = crypto.randomUUID();
  window.localStorage.setItem(key, value);
  return value;
}

async function apiFetch(path: string, init: RequestInit = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("uuid", getUuid());

  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");

  if (activeApiToken) {
    headers.set("authorization", `Bearer ${activeApiToken}`);
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `request failed: ${response.status}`);
  }

  return response.json();
}

export async function apiFetchSessions() {
  const data = await apiFetch("/web/sessions/all");
  return data.sessions;
}

export async function apiFetchSession(sessionId: string) {
  const data = await apiFetch(`/web/sessions/${sessionId}`);
  return data.session;
}

export async function apiFetchSessionHistory(sessionId: string) {
  const data = await apiFetch(`/web/sessions/${sessionId}/history`);
  return data.events;
}

export async function apiSendEvent(sessionId: string, event: Record<string, unknown>) {
  await apiFetch(`/web/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify(event),
  });
}

export async function apiSendControl(sessionId: string, event: Record<string, unknown>) {
  await apiFetch(`/web/sessions/${sessionId}/control`, {
    method: "POST",
    body: JSON.stringify(event),
  });
}

export async function apiInterrupt(sessionId: string) {
  await apiFetch(`/web/sessions/${sessionId}/interrupt`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
```

注意：

```txt
localStorage UUID 不能当真正 auth
```

它只适合本课程 Mini 的本地开发。

正式系统要用登录态、组织、用户、环境权限。

## Web SSE Client

新增：

```txt
src/web/api/sse.ts
```

```ts
import { getUuid } from "./client";

export type SSESubscription = {
  close: () => void;
};

export function connectSessionSSE(
  sessionId: string,
  onEvent: (event: Record<string, unknown>) => void,
  onError?: (error: Event) => void,
): SSESubscription {
  const url = new URL(`/web/sessions/${sessionId}/events`, window.location.origin);
  url.searchParams.set("uuid", getUuid());

  let lastSeqNum = 0;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (message) => {
    const event = JSON.parse(message.data) as Record<string, unknown>;
    const seqNum = typeof event.seqNum === "number" ? event.seqNum : 0;

    if (seqNum <= lastSeqNum) {
      return;
    }

    lastSeqNum = seqNum;
    onEvent(event);
  };

  eventSource.onerror = (error) => {
    onError?.(error);
  };

  return {
    close() {
      eventSource.close();
    },
  };
}
```

真实浏览器会自动带 `Last-Event-ID`。

但前端仍然要做 seq 去重。

原因是：

```txt
断线重连
服务端 replay
浏览器缓存
多 tab 快速切换
```

都会让相同事件再次出现。

去重成本很低，收益很高。

## Web Chat Adapter

新增：

```txt
src/web/lib/rcsChatAdapter.ts
```

Web UI 不应该直接渲染原始 `SessionEvent`。

它需要一个 adapter：

```txt
SessionEvent
  -> ChatEntry
  -> React components
```

定义 UI entry：

```ts
export type ToolCallState = "running" | "waiting_for_confirmation" | "complete" | "rejected" | "canceled";

export type ToolCallEntry = {
  id: string;
  name: string;
  input?: unknown;
  result?: unknown;
  state: ToolCallState;
};

export type ChatEntry =
  | {
      id: string;
      role: "user" | "assistant" | "system";
      text: string;
      createdAt: string;
    }
  | {
      id: string;
      role: "tool";
      tool: ToolCallEntry;
      createdAt: string;
    }
  | {
      id: string;
      role: "error";
      text: string;
      createdAt: string;
    };
```

提取文本：

```ts
function readTextFromPayload(payload: Record<string, unknown>) {
  if (typeof payload.content === "string") {
    return payload.content;
  }

  const message = payload.message;

  if (typeof message === "object" && message !== null && "content" in message) {
    const content = (message as { content?: unknown }).content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "object" && block !== null && "text" in block) {
            return typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "";
          }

          return "";
        })
        .filter(Boolean)
        .join("");
    }
  }

  return "";
}
```

Adapter 主体：

```ts
import { apiFetchSessionHistory, apiInterrupt, apiSendControl, apiSendEvent } from "../api/client";
import { connectSessionSSE, type SSESubscription } from "../api/sse";

type AdapterOptions = {
  onStatusChange?: (status: string) => void;
  onPermissionRequest?: (request: Record<string, unknown>) => void;
  onError?: (error: string) => void;
};

export class RCSChatAdapter {
  private subscription?: SSESubscription;

  constructor(
    private readonly sessionId: string,
    private readonly setEntries: (updater: (entries: ChatEntry[]) => ChatEntry[]) => void,
    private readonly options: AdapterOptions = {},
  ) {}

  async init() {
    const history = await apiFetchSessionHistory(this.sessionId);

    for (const event of history) {
      this.handleEvent(event);
    }

    this.subscription = connectSessionSSE(
      this.sessionId,
      (event) => this.handleEvent(event),
      () => this.options.onError?.("stream disconnected"),
    );
  }

  dispose() {
    this.subscription?.close();
  }

  async sendMessage(text: string) {
    const localId = crypto.randomUUID();

    this.setEntries((entries) => [
      ...entries,
      {
        id: localId,
        role: "user",
        text,
        createdAt: new Date().toISOString(),
      },
    ]);

    await apiSendEvent(this.sessionId, {
      type: "user",
      content: text,
      message: {
        role: "user",
        content: text,
      },
    });
  }

  async respondPermission(requestId: string, approved: boolean, extra: Record<string, unknown> = {}) {
    this.setEntries((entries) =>
      entries.map((entry) => {
        if (entry.role !== "tool") {
          return entry;
        }

        if (entry.tool.id !== requestId) {
          return entry;
        }

        return {
          ...entry,
          tool: {
            ...entry.tool,
            state: approved ? "running" : "rejected",
          },
        };
      }),
    );

    await apiSendControl(this.sessionId, {
      type: "permission_response",
      request_id: requestId,
      approved,
      ...extra,
    });
  }

  async interrupt() {
    this.setEntries((entries) =>
      entries.map((entry) => {
        if (entry.role !== "tool") {
          return entry;
        }

        if (entry.tool.state !== "running" && entry.tool.state !== "waiting_for_confirmation") {
          return entry;
        }

        return {
          ...entry,
          tool: {
            ...entry.tool,
            state: "canceled",
          },
        };
      }),
    );

    await apiInterrupt(this.sessionId);
  }

  private handleEvent(event: Record<string, unknown>) {
    const type = event.type;
    const payload = (event.payload ?? event) as Record<string, unknown>;
    const id = typeof event.id === "string" ? event.id : crypto.randomUUID();
    const createdAt = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();

    if (type === "session_status") {
      const status = typeof payload.status === "string" ? payload.status : undefined;

      if (status) {
        this.options.onStatusChange?.(status);
      }

      return;
    }

    if (type === "assistant" || type === "user" || type === "system") {
      const text = readTextFromPayload(payload);

      if (!text) {
        return;
      }

      this.setEntries((entries) => [
        ...entries,
        {
          id,
          role: type,
          text,
          createdAt,
        },
      ]);

      return;
    }

    if (type === "tool_use") {
      const toolId = typeof payload.id === "string" ? payload.id : id;
      const name = typeof payload.name === "string" ? payload.name : "tool";

      this.setEntries((entries) => [
        ...entries,
        {
          id,
          role: "tool",
          createdAt,
          tool: {
            id: toolId,
            name,
            input: payload.input,
            state: "running",
          },
        },
      ]);

      return;
    }

    if (type === "tool_result") {
      const toolId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined;

      if (!toolId) {
        return;
      }

      this.setEntries((entries) =>
        entries.map((entry) => {
          if (entry.role !== "tool" || entry.tool.id !== toolId) {
            return entry;
          }

          return {
            ...entry,
            tool: {
              ...entry.tool,
              result: payload.content ?? payload,
              state: "complete",
            },
          };
        }),
      );

      return;
    }

    if (type === "control_request" || type === "permission_request") {
      const requestId =
        typeof payload.request_id === "string"
          ? payload.request_id
          : typeof payload.tool_use_id === "string"
            ? payload.tool_use_id
            : id;

      this.setEntries((entries) =>
        entries.map((entry) => {
          if (entry.role !== "tool" || entry.tool.id !== requestId) {
            return entry;
          }

          return {
            ...entry,
            tool: {
              ...entry.tool,
              state: "waiting_for_confirmation",
            },
          };
        }),
      );

      this.options.onPermissionRequest?.({
        ...payload,
        request_id: requestId,
      });

      return;
    }

    if (type === "error") {
      this.setEntries((entries) => [
        ...entries,
        {
          id,
          role: "error",
          text: typeof payload.message === "string" ? payload.message : "Unknown error",
          createdAt,
        },
      ]);
    }
  }
}
```

这里故意没有把 `partial` 事件做得很复杂。

Mini 可以先把 assistant full text 当作最终文本渲染。

官方能力会进一步处理：

```txt
text_delta
tool input streaming
message_start / content_block_delta / message_delta
result event
compaction state
```

这些放后面章节补。

## Dashboard

新增：

```txt
src/web/pages/Dashboard.tsx
```

页面只做三件事：

```txt
1. 拉 sessions
2. 每 10 秒刷新
3. 点击进入 session detail
```

```tsx
import { useEffect, useState } from "react";
import { apiFetchSessions } from "../api/client";
import { SessionList } from "../components/SessionList";

export type WebSessionSummary = {
  id: string;
  title?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  source?: string;
};

export function Dashboard() {
  const [sessions, setSessions] = useState<WebSessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const next = await apiFetchSessions();

        if (alive) {
          setSessions(next);
          setError(null);
        }
      } catch (unknownError) {
        if (alive) {
          setError(unknownError instanceof Error ? unknownError.message : "failed to load sessions");
        }
      }
    }

    void load();
    const timer = setInterval(load, 10_000);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1>Remote sessions</h1>
          <p>Live coding sessions running through the remote control server.</p>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <SessionList sessions={sessions} />
    </main>
  );
}
```

SessionList：

```tsx
import type { WebSessionSummary } from "../pages/Dashboard";

function formatTime(value?: string) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleString();
}

export function SessionList({ sessions }: { sessions: WebSessionSummary[] }) {
  const sorted = [...sessions].sort((a, b) => {
    const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return right - left;
  });

  return (
    <div className="session-list">
      {sorted.map((session) => (
        <a className="session-row" href={`/code/${session.id}`} key={session.id}>
          <div className="session-main">
            <div className="session-title">{session.title || session.id}</div>
            <div className="session-meta">{formatTime(session.updatedAt || session.createdAt)}</div>
          </div>
          <span className={`status-badge status-${session.status || "unknown"}`}>{session.status || "unknown"}</span>
        </a>
      ))}
    </div>
  );
}
```

不要把 Dashboard 做成营销页。

它是控制台。

应该优先信息密度和可扫描性。

## Session Detail

新增：

```txt
src/web/pages/SessionDetail.tsx
```

它需要这些状态：

```txt
session
status
entries
pendingPermissions
input
isLoading
taskPanelOpen
showMeta
```

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetchSession, apiSendControl } from "../api/client";
import { RCSChatAdapter, type ChatEntry } from "../lib/rcsChatAdapter";
import { PermissionPanel } from "../components/PermissionPanel";
import { TaskPanel } from "../components/TaskPanel";

type PendingPermission = {
  request_id: string;
  name?: string;
  input?: unknown;
};

export function SessionDetail({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState("unknown");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const adapterRef = useRef<RCSChatAdapter | null>(null);

  const isClosed = status === "completed" || status === "failed" || status === "archived";

  useEffect(() => {
    let alive = true;
    const adapter = new RCSChatAdapter(sessionId, setEntries, {
      onStatusChange(nextStatus) {
        setStatus(nextStatus);
      },
      onPermissionRequest(request) {
        const requestId = typeof request.request_id === "string" ? request.request_id : crypto.randomUUID();

        setPendingPermissions((current) => [
          ...current.filter((item) => item.request_id !== requestId),
          {
            request_id: requestId,
            name: typeof request.name === "string" ? request.name : undefined,
            input: request.input,
          },
        ]);
      },
      onError(message) {
        setEntries((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "error",
            text: message,
            createdAt: new Date().toISOString(),
          },
        ]);
      },
    });

    adapterRef.current = adapter;

    async function load() {
      const loadedSession = await apiFetchSession(sessionId);

      if (!alive) {
        return;
      }

      setSession(loadedSession);
      setStatus(typeof loadedSession.status === "string" ? loadedSession.status : "unknown");
      await adapter.init();

      if (alive) {
        setIsLoading(false);
      }
    }

    void load().catch((error) => {
      if (alive) {
        setIsLoading(false);
        setEntries([
          {
            id: crypto.randomUUID(),
            role: "error",
            text: error instanceof Error ? error.message : "failed to load session",
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    });

    return () => {
      alive = false;
      adapter.dispose();
    };
  }, [sessionId]);

  async function submit() {
    const text = input.trim();

    if (!text || isClosed) {
      return;
    }

    setInput("");
    await adapterRef.current?.sendMessage(text);
  }

  async function approvePermission(requestId: string) {
    await adapterRef.current?.respondPermission(requestId, true);
    setPendingPermissions((current) => current.filter((item) => item.request_id !== requestId));
  }

  async function rejectPermission(requestId: string) {
    await adapterRef.current?.respondPermission(requestId, false);
    setPendingPermissions((current) => current.filter((item) => item.request_id !== requestId));
  }

  async function answerQuestion(requestId: string, text: string) {
    await apiSendControl(sessionId, {
      type: "control_response",
      request_id: requestId,
      response: text,
    });

    setPendingPermissions((current) => current.filter((item) => item.request_id !== requestId));
  }

  async function interrupt() {
    await adapterRef.current?.interrupt();
    setStatus("idle");
  }

  const title = useMemo(() => {
    if (!session) {
      return sessionId;
    }

    return typeof session.title === "string" && session.title ? session.title : sessionId;
  }, [session, sessionId]);

  return (
    <main className="session-detail">
      <header className="session-header">
        <a href="/code">Back</a>
        <div>
          <h1>{title}</h1>
          <span className={`status-badge status-${status}`}>{status}</span>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => setTaskPanelOpen(true)}>
            Tasks
          </button>
          <button type="button" disabled={isClosed} onClick={interrupt}>
            Interrupt
          </button>
        </div>
      </header>

      <section className="chat-scroll">
        {isLoading ? <div className="loading">Loading session...</div> : null}

        {entries.map((entry) => (
          <div className={`chat-entry chat-${entry.role}`} key={entry.id}>
            {entry.role === "tool" ? (
              <pre>{JSON.stringify(entry.tool, null, 2)}</pre>
            ) : (
              <div className="chat-text">{entry.text}</div>
            )}
          </div>
        ))}
      </section>

      {pendingPermissions.map((permission) => (
        <PermissionPanel
          key={permission.request_id}
          permission={permission}
          onApprove={() => approvePermission(permission.request_id)}
          onReject={() => rejectPermission(permission.request_id)}
          onAnswer={(text) => answerQuestion(permission.request_id, text)}
        />
      ))}

      <form
        className="chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea disabled={isClosed} value={input} onChange={(event) => setInput(event.currentTarget.value)} />
        <button type="submit" disabled={isClosed || !input.trim()}>
          Send
        </button>
      </form>

      <TaskPanel open={taskPanelOpen} onClose={() => setTaskPanelOpen(false)} sessionId={sessionId} />
    </main>
  );
}
```

这个页面的边界要守住：

```txt
SessionDetail 不直接解析所有 event
解析放在 RCSChatAdapter

SessionDetail 不直接拼 control URL
请求放在 api/client

SessionDetail 不保存原始 event log
只保存 UI entries 和 pending permission
```

这样后面替换成更完整的 AI SDK transport 时不会重写页面。

## Permission Panel

新增：

```txt
src/web/components/PermissionPanel.tsx
```

```tsx
type PermissionPanelProps = {
  permission: {
    request_id: string;
    name?: string;
    input?: unknown;
  };
  onApprove: () => void;
  onReject: () => void;
  onAnswer: (text: string) => void;
};

export function PermissionPanel({ permission, onApprove, onReject, onAnswer }: PermissionPanelProps) {
  const isQuestion = permission.name === "AskUserQuestion";

  if (isQuestion) {
    return (
      <section className="permission-panel">
        <h2>Question</h2>
        <pre>{JSON.stringify(permission.input, null, 2)}</pre>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const answer = String(form.get("answer") ?? "");
            onAnswer(answer);
          }}
        >
          <input name="answer" />
          <button type="submit">Reply</button>
        </form>
      </section>
    );
  }

  return (
    <section className="permission-panel">
      <h2>Tool permission</h2>
      <div className="permission-name">{permission.name || "Tool"}</div>
      <pre>{JSON.stringify(permission.input, null, 2)}</pre>
      <div className="permission-actions">
        <button type="button" onClick={onReject}>
          Reject
        </button>
        <button type="button" onClick={onApprove}>
          Approve
        </button>
      </div>
    </section>
  );
}
```

官方 UI 对 permission 的类型更细：

```txt
can_use_tool
AskUserQuestion
ExitPlanMode
updated_permissions
```

Mini 先把它们收敛到一个面板。

后续可以按 request subtype 拆组件。

## Task Panel

新增：

```txt
src/web/components/TaskPanel.tsx
```

```tsx
type TaskPanelProps = {
  open: boolean;
  sessionId: string;
  onClose: () => void;
};

export function TaskPanel({ open, sessionId, onClose }: TaskPanelProps) {
  if (!open) {
    return null;
  }

  return (
    <aside className="task-panel">
      <header>
        <h2>Tasks</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="task-panel-body">
        <div className="muted">No active task details for {sessionId}.</div>
      </div>
    </aside>
  );
}
```

这一版 TaskPanel 可以是占位。

但它必须有，因为官方控制台里 session detail 不只是 chat。

后面补 daemon supervisor 和 environment runner 时，任务状态会进这里。

## Web 样式原则

这章不是设计完整 UI，但要避免几个错误：

```txt
不要做 landing page
不要用大 hero
不要把控制台做成营销页面
不要在 chat 外再套多层 card
不要让 status / title / actions 在窄屏重叠
```

控制台第一屏应该直接是工作界面：

```txt
left / top navigation
session status
message stream
permission panel
input
task drawer
```

最小 CSS 可以这样：

```css
.page,
.session-detail {
  min-height: 100vh;
  background: #f7f3ee;
  color: #191714;
}

.page-header,
.session-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px;
  border-bottom: 1px solid #ded6cc;
}

.session-list {
  display: grid;
  gap: 1px;
  border-top: 1px solid #ded6cc;
}

.session-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  padding: 12px 24px;
  color: inherit;
  text-decoration: none;
  background: #fffaf4;
  border-bottom: 1px solid #ded6cc;
}

.chat-scroll {
  height: calc(100vh - 190px);
  overflow: auto;
  padding: 24px;
}

.chat-entry {
  max-width: 920px;
  margin-bottom: 14px;
  white-space: pre-wrap;
}

.chat-user {
  margin-left: auto;
  color: #2c241f;
}

.chat-assistant {
  color: #191714;
}

.chat-tool {
  font-size: 13px;
  color: #51483f;
}

.permission-panel {
  border-top: 1px solid #ded6cc;
  padding: 16px 24px;
  background: #fff5ea;
}

.chat-input {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid #ded6cc;
  background: #fffaf4;
}

.chat-input textarea {
  min-height: 48px;
  max-height: 160px;
  resize: vertical;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: #ebe2d8;
  font-size: 12px;
}
```

这里用了温暖中性色，不要铺满一个单一暗蓝或紫色主题。

它应该像一个工程控制台，不是展示页。

## 终端 Remote Session Detail Dialog

Web 控制台解决浏览器入口。

终端里还需要 background task 的详情弹窗。

新增：

```txt
src/tasks/RemoteSessionProgress.tsx
src/tasks/RemoteSessionDetailDialog.tsx
```

先定义 task state：

```ts
export type RemoteTaskStatus = "queued" | "running" | "idle" | "completed" | "failed" | "archived";

export type RemoteTaskLogEntry = {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "error";
  text: string;
  timestamp: string;
};

export type RemoteTaskState = {
  id: string;
  sessionId: string;
  title: string;
  status: RemoteTaskStatus;
  startedAt: string;
  updatedAt: string;
  sessionUrl?: string;
  progress?: {
    completed: number;
    total: number;
    label?: string;
  };
  log: RemoteTaskLogEntry[];
};
```

Progress：

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { RemoteTaskState } from "./types";

export function RemoteSessionProgress({ task }: { task: RemoteTaskState }) {
  if (task.status === "completed") {
    return <Text color="green">Completed</Text>;
  }

  if (task.status === "failed") {
    return <Text color="red">Failed</Text>;
  }

  if (task.status === "archived") {
    return <Text color="gray">Archived</Text>;
  }

  if (!task.progress) {
    return <Text color="yellow">{task.status}</Text>;
  }

  const { completed, total, label } = task.progress;
  const width = 20;
  const ratio = total > 0 ? Math.min(1, completed / total) : 0;
  const filled = Math.round(width * ratio);
  const bar = `${"=".repeat(filled)}${"-".repeat(width - filled)}`;

  return (
    <Box>
      <Text color="cyan">[{bar}]</Text>
      <Text> {completed}/{total}</Text>
      {label ? <Text color="gray"> {label}</Text> : null}
    </Box>
  );
}
```

详情弹窗：

```tsx
import React from "react";
import { Box, Text, useInput } from "ink";
import { RemoteSessionProgress } from "./RemoteSessionProgress";
import type { RemoteTaskState } from "./types";

type RemoteSessionDetailDialogProps = {
  task: RemoteTaskState;
  onBack: () => void;
  onClose: () => void;
  onOpenWeb: (url: string) => void;
  onTeleport: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
};

function formatRuntime(startedAt: string) {
  const started = Date.parse(startedAt);

  if (!Number.isFinite(started)) {
    return "unknown";
  }

  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return `${minutes}m ${rest}s`;
}

export function RemoteSessionDetailDialog({
  task,
  onBack,
  onClose,
  onOpenWeb,
  onTeleport,
  onStop,
}: RemoteSessionDetailDialogProps) {
  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.leftArrow) {
      onBack();
      return;
    }

    if (input === "w" && task.sessionUrl) {
      onOpenWeb(task.sessionUrl);
      return;
    }

    if (input === "t") {
      onTeleport(task.sessionId);
      return;
    }

    if (input === "s") {
      onStop(task.sessionId);
    }
  });

  const recentLog = task.log.slice(-3);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1} width={90}>
      <Box justifyContent="space-between">
        <Text bold>{task.title}</Text>
        <Text color="gray">{task.status}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Session: {task.sessionId}</Text>
        <Text color="gray">Runtime: {formatRuntime(task.startedAt)}</Text>
        {task.sessionUrl ? <Text color="blue">{task.sessionUrl}</Text> : null}
      </Box>

      <Box marginTop={1}>
        <RemoteSessionProgress task={task} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Recent activity</Text>
        {recentLog.length === 0 ? <Text color="gray">No activity yet</Text> : null}
        {recentLog.map((entry) => (
          <Box key={entry.id}>
            <Text color="gray">{entry.role}: </Text>
            <Text>{entry.text}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">w open web · t teleport · s stop · left back · esc close</Text>
      </Box>
    </Box>
  );
}
```

这不是 chat 页面。

它应该让用户快速回答几个问题：

```txt
这个远端任务是谁？
现在是什么状态？
跑了多久？
有无 Web URL？
最近输出是什么？
能否回到完整 session？
能否停止？
```

官方源码里还有 ultrareview / ultraplan 的专用详情态。

Mini 先保留通用 `remote_agent` 视图。

## RemoteSessionManager 与 WebSocket Client

终端侧需要一个订阅类。

真实源码里是：

```txt
src/remote/SessionsWebSocket.ts
src/remote/RemoteSessionManager.ts
```

Mini 可以这样做。

```ts
type RemoteSessionMessageHandler = (event: Record<string, unknown>) => void;

export class SessionsWebSocket {
  private socket?: WebSocket;
  private reconnectTimer?: Timer;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly onMessage: RemoteSessionMessageHandler,
  ) {}

  connect() {
    this.closed = false;

    const socket = new WebSocket(this.url, [`token.${this.token}`]);
    this.socket = socket;

    socket.onmessage = (message) => {
      const text = typeof message.data === "string" ? message.data : "";

      for (const line of text.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) {
          continue;
        }

        const event = JSON.parse(trimmed) as Record<string, unknown>;

        if (event.type === "keep_alive") {
          continue;
        }

        this.onMessage(event);
      }
    };

    socket.onclose = () => {
      if (this.closed) {
        return;
      }

      this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    };
  }

  send(event: Record<string, unknown>) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.socket.send(`${JSON.stringify(event)}\n`);
    return true;
  }

  close() {
    this.closed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.socket?.close(1000, "client closed");
  }
}
```

Manager：

```ts
import { SessionsWebSocket } from "./SessionsWebSocket";

type RemoteSessionManagerOptions = {
  baseUrl: string;
  token: string;
  sessionId: string;
  onEvent: (event: Record<string, unknown>) => void;
};

export class RemoteSessionManager {
  private readonly socket: SessionsWebSocket;

  constructor(options: RemoteSessionManagerOptions) {
    const wsBaseUrl = options.baseUrl.replace(/^http/, "ws");
    const url = `${wsBaseUrl}/v1/session_ingress/ws/${options.sessionId}`;

    this.socket = new SessionsWebSocket(url, options.token, options.onEvent);
  }

  start() {
    this.socket.connect();
  }

  sendUserMessage(content: string) {
    return this.socket.send({
      type: "user",
      content,
      message: {
        role: "user",
        content,
      },
    });
  }

  approvePermission(requestId: string) {
    return this.socket.send({
      type: "permission_response",
      request_id: requestId,
      approved: true,
    });
  }

  rejectPermission(requestId: string) {
    return this.socket.send({
      type: "permission_response",
      request_id: requestId,
      approved: false,
    });
  }

  interrupt() {
    return this.socket.send({
      type: "interrupt",
      reason: "user_interrupt",
    });
  }

  stop() {
    this.socket.close();
  }
}
```

这里还有一个设计选择：

```txt
Web UI 写入走 HTTP
终端 manager 写入可以走 WebSocket
```

这是合理的。

终端 manager 本来就持有长连接。

浏览器 UI 使用 HTTP 写入更容易处理失败、权限、重试和审计。

## Event Direction 规则

本章最容易错的是 direction。

记住这张表：

| 来源 | 写入 endpoint | direction | 谁会收到 |
| --- | --- | --- | --- |
| worker assistant output | session ingress POST / WS | inbound | Web SSE、history、terminal log |
| worker tool result | session ingress POST / WS | inbound | Web SSE、history、terminal log |
| Web 用户消息 | `/web/sessions/:id/events` | outbound | worker WebSocket / worker SSE |
| Web 权限响应 | `/web/sessions/:id/control` | outbound | worker WebSocket / worker SSE |
| Web interrupt | `/web/sessions/:id/interrupt` | outbound | worker WebSocket / worker SSE |
| terminal 用户消息 | WebSocket send | inbound 或 outbound 取决于连接角色 | 建议走 control API 保持一致 |

最后一行需要解释。

如果 `RemoteSessionManager` 是 worker 端，它发出的 assistant output 应该是 inbound。

如果它是用户控制端，它发出的 user input 应该是 outbound。

所以 Mini 最好把角色分开：

```txt
WorkerSessionClient
  写 inbound

RemoteControlClient
  写 outbound
```

如果暂时只有一个类，也至少在方法名里体现语义。

不要让调用方自己传 direction。

## 与第 50 章 EventBus 的集成

第 50 章的 EventBus 应该已经有：

```ts
type SessionEventBus = {
  publish: (event: SessionEvent) => void;
  subscribe: (listener: (event: SessionEvent) => void) => () => void;
  getEventsSince: (seqNum: number) => SessionEvent[];
  close: () => void;
};
```

本章只需要补一个 helper：

```ts
export async function publishSessionEvent(
  sessionId: string,
  direction: SessionEventDirection,
  type: SessionEventType,
  payload: Record<string, unknown>,
) {
  const bus = getEventBus(sessionId);
  const event = {
    id: crypto.randomUUID(),
    sessionId,
    seqNum: bus.nextSeqNum(),
    direction,
    type,
    payload,
    timestamp: new Date().toISOString(),
  };

  bus.publish(event);
  await appendSessionEvent(sessionId, event);
  return event;
}
```

如果你的第 50 章 EventBus 是在 `publish()` 内部分配 seqNum，就不要重复分配。

关键是：

```txt
seqNum 必须由服务端生成
client 传来的 seq_num 只能作为 payload
```

不要信任客户端传来的顺序号。

## Web Console 与 WebSocket 的差异

为什么 Web 控制台不直接连 `/v1/session_ingress/ws/:id`？

因为这两个流的目标不同。

WebSocket subscribe：

```txt
面向 worker / bridge
主要接收 outbound
允许写 inbound
连接是控制协议的一部分
```

Web SSE：

```txt
面向浏览器
读取完整 session event log
写入通过 HTTP
更容易做权限和审计
```

浏览器也可以用 WebSocket。

但那会让 UI 直接暴露底层协议，后续很难做：

```txt
多 tab 去重
权限分级
历史回放
只读分享
审计日志
断线恢复
```

所以 Mini 跟源码保持一致：

```txt
browser read = SSE
browser write = HTTP
worker read/write = WebSocket or worker SSE
```

## 测试：WebSocket

新增：

```txt
src/rcs/__tests__/wsHandler.test.ts
```

测试列表：

```txt
decodeWsMessage accepts string
decodeWsMessage accepts ArrayBuffer
decodeWsMessage rejects oversized payload
decodeWsMessage splits NDJSON lines
normalizeIngressPayload maps assistant message
normalizeIngressPayload maps user message
normalizeIngressPayload maps permission_response
normalizeIngressPayload maps interrupt
handleWebSocketOpen replays history
handleWebSocketOpen replaces existing connection
live subscription forwards outbound event
live subscription does not forward inbound event
handleWebSocketMessage ignores keep_alive
handleWebSocketMessage publishes valid NDJSON events
handleWebSocketClose cleans only matching socket
closeAllWebSockets closes active sockets
```

伪测试：

```ts
test("live subscription forwards outbound events only", async () => {
  const socket = createFakeSocket({ sessionId: "s1" });

  handleWebSocketOpen(socket);

  await publishSessionEvent("s1", "inbound", "assistant", {
    content: "hidden from worker live stream",
  });

  await publishSessionEvent("s1", "outbound", "user", {
    content: "visible to worker",
  });

  expect(socket.sent.join("\n")).not.toContain("hidden from worker live stream");
  expect(socket.sent.join("\n")).toContain("visible to worker");
});
```

再测替换连接：

```ts
test("new websocket replaces old websocket for the same session", () => {
  const first = createFakeSocket({ sessionId: "s1" });
  const second = createFakeSocket({ sessionId: "s1" });

  handleWebSocketOpen(first);
  handleWebSocketOpen(second);

  expect(first.closed).toBe(true);
  expect(second.closed).toBe(false);
});
```

还有 auth route：

```txt
GET /ws/:sessionId without token closes 4003
GET /ws/:sessionId for missing session closes 4001
GET /ws/:sessionId with valid token opens and replays
```

WebSocket 的 route 测试不一定要真起浏览器。

Bun 的测试里可以用本地 server + WebSocket client 跑集成测试。

## 测试：Web Routes

新增：

```txt
src/rcs/__tests__/webRoutes.test.ts
```

测试列表：

```txt
GET /web/sessions/all requires uuid
GET /web/sessions/all returns only owned sessions
GET /web/sessions/:id rejects non-owner with 403
GET /web/sessions/:id/history returns ordered events
GET /web/sessions/:id/events rejects archived session with 409
GET /web/sessions/:id/events replays Last-Event-ID
POST /web/sessions/:id/events publishes outbound user event
POST /web/sessions/:id/control publishes outbound permission_response
POST /web/sessions/:id/interrupt publishes outbound interrupt and sets idle
closed session rejects events / control / interrupt
```

伪测试：

```ts
test("web user message becomes outbound event", async () => {
  const app = createTestRcsApp();
  await createSession({ id: "s1", ownerUuid: "u1", status: "running" });

  const response = await app.request("/web/sessions/s1/events?uuid=u1", {
    method: "POST",
    body: JSON.stringify({
      type: "user",
      content: "hello",
    }),
  });

  expect(response.status).toBe(200);

  const events = getEventBus("s1").getEventsSince(0);
  expect(events[0]?.direction).toBe("outbound");
  expect(events[0]?.type).toBe("user");
});
```

再测 closed：

```ts
test("closed sessions reject web control writes", async () => {
  const app = createTestRcsApp();
  await createSession({ id: "s1", ownerUuid: "u1", status: "archived" });

  const response = await app.request("/web/sessions/s1/control?uuid=u1", {
    method: "POST",
    body: JSON.stringify({
      type: "permission_response",
      approved: true,
    }),
  });

  expect(response.status).toBe(409);
});
```

这些测试要比页面测试更重要。

因为 UI bug 通常只是显示错。

direction 错了会让 worker 永远收不到用户输入。

## 测试：Web Adapter

新增：

```txt
src/web/lib/__tests__/rcsChatAdapter.test.ts
```

测试列表：

```txt
init loads history before subscribing SSE
assistant event appends assistant entry
user event appends user entry
tool_use creates running tool entry
tool_result completes matching tool entry
control_request marks tool waiting_for_confirmation
permission response updates local tool state
interrupt cancels running tool entries
session_status calls onStatusChange
error creates error entry
duplicate SSE event is ignored by connectSessionSSE
```

这里可以 mock `api/client` 和 `api/sse`。

但不要 mock adapter 内部纯函数。

核心断言是 UI state。

```ts
test("tool_result completes matching tool call", () => {
  const entries: ChatEntry[] = [
    {
      id: "e1",
      role: "tool",
      createdAt: "2026-01-01T00:00:00.000Z",
      tool: {
        id: "tool-1",
        name: "Read",
        state: "running",
      },
    },
  ];

  const setEntries = (updater: (entries: ChatEntry[]) => ChatEntry[]) => {
    entries.splice(0, entries.length, ...updater(entries));
  };

  const adapter = new RCSChatAdapter("s1", setEntries);

  adapter.handleEventForTest({
    type: "tool_result",
    payload: {
      tool_use_id: "tool-1",
      content: "done",
    },
  });

  expect(entries[0]?.role).toBe("tool");
  expect(entries[0]?.tool.state).toBe("complete");
});
```

为了测试可以暴露一个仅测试方法：

```ts
handleEventForTest(event: Record<string, unknown>) {
  this.handleEvent(event);
}
```

或者把 `mapEventToEntries()` 抽成纯函数。

更推荐抽纯函数，因为 adapter 会持有订阅生命周期。

## 测试：终端 Detail Dialog

新增：

```txt
src/tasks/__tests__/RemoteSessionDetailDialog.test.tsx
```

测试列表：

```txt
renders title / status / session id
renders session URL when available
renders recent 3 log entries
renders empty activity state
w opens web URL
t triggers teleport
s triggers stop
left triggers back
escape closes dialog
progress renders completed state
progress renders failed state
progress renders todo progress
```

Ink 组件测试可以按你项目已有测试工具做。

如果 Mini 暂时没有 Ink test harness，先测纯函数：

```txt
formatRuntime
recentLog selection
progress label formatting
```

UI 快捷键可以放到后面补。

## 手动验证

启动 RCS：

```bash
MINI_RCS_API_KEYS=dev-secret bun run rcs
```

健康检查：

```bash
curl http://localhost:8787/health
```

创建 Web session：

```bash
curl -X POST "http://localhost:8787/web/sessions?uuid=dev-user" \
  -H "content-type: application/json" \
  -d '{"title":"Web console smoke test"}'
```

写入一条 worker 侧 assistant event：

```bash
curl -X POST "http://localhost:8787/v1/session_ingress/session/SESSION_ID/events" \
  -H "x-api-key: dev-secret" \
  -H "content-type: application/json" \
  -d '{"type":"assistant","content":"hello from worker"}'
```

拉 history：

```bash
curl "http://localhost:8787/web/sessions/SESSION_ID/history?uuid=dev-user"
```

打开 Web 控制台：

```txt
http://localhost:8787/code
```

进入 session detail 后验证：

```txt
1. 能看到 assistant message
2. 输入 user message 后 worker stream 能收到 outbound event
3. permission_request 会出现确认面板
4. Approve 会写 permission_response
5. Interrupt 会写 interrupt event
6. archive 后写入返回 409
```

最后跑检查：

```bash
bun test src/rcs src/web src/tasks
bun run typecheck
```

## 常见问题

### WebSocket 收不到用户消息

先查 direction。

Web 用户消息必须是：

```txt
direction = outbound
```

如果写成 inbound，Web 自己能看到 history，但 worker 不会收到。

### Web 页面重复显示同一条消息

检查两处：

```txt
history load 是否已经渲染
SSE replay 是否又发了一次
```

解决方式：

```txt
用 seqNum 去重
或者 history 后从最后 seqNum 开始订阅
```

真实源码里浏览器 EventSource 会处理 `Last-Event-ID`，前端也做本地 seq 去重。

### 旧 WebSocket close 后新连接也没了

检查 close handler。

必须判断：

```ts
if (connection?.socket === socket) {
  cleanupConnection(connection);
}
```

不能只按 sessionId 删除。

### permission 面板出现但工具状态没变

检查 request id。

不同事件里可能叫：

```txt
request_id
tool_use_id
id
```

adapter 要统一成一个 `request_id`。

### 终端 detail 没有最近日志

检查 remote task 是否把 session events 同步进 task state。

推荐只保留最近 N 条：

```txt
task.log = [...task.log, next].slice(-50)
```

不要把完整 event log 放进 AppState。

完整历史应该留在 RCS EventBus / store。

### WebSocket auth 在浏览器里失败

浏览器 WebSocket 不能随意加自定义 header。

用 subprotocol：

```ts
new WebSocket(url, [`token.${token}`]);
```

服务端从 `Sec-WebSocket-Protocol` 解析 token。

不要把 token 打到控制台。

## 和官方能力的差距

本章 Mini 已经有了远程控制可视化入口，但离官方还有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| WebSocket subscribe | 单 session 单连接 | 多 client、client id、能力协商 |
| WebSocket auth | API key / token | 组织权限、环境权限、短期 worker token |
| Replay | 内存 history | 持久化 cursor、截断提示 |
| Web SSE | EventSource + seq 去重 | 重连预算、错误分类、后台恢复 |
| Web adapter | 基础 chat / tool / permission | AI SDK UIMessage、streaming delta、artifact |
| Permission UI | 通用 approve / reject | can_use_tool、AskUserQuestion、ExitPlanMode 专用视图 |
| Task panel | 占位 | daemon jobs、environment runner、automation state |
| Terminal detail | task 摘要 | ultrareview / ultraplan 专用进度 |
| Interrupt | 写 interrupt event | worker 确认、cancel reason、清理远端进程 |
| Static web | 简单 `/code` | 资源缓存、SPA fallback、部署前缀 |

这章补完后，Mini 的远程能力已经从“后台能跑”变成“用户能看、能控、能恢复”。

## 本章小结

本章把第 50 章的可靠 RCS 控制平面接到了用户界面。

核心新增链路是：

```txt
Worker / bridge
  -> WebSocket subscribe
  -> replay history
  -> live outbound controls
  -> inbound event ingestion

Browser
  -> session list
  -> session detail
  -> history
  -> SSE stream
  -> HTTP writes
  -> permission / interrupt

Terminal
  -> remote task detail dialog
  -> progress
  -> recent log
  -> open web / teleport / stop
```

这章最关键的设计不是页面长什么样，而是 event log 的分发模型：

```txt
EventBus 是唯一事实来源。
WebSocket 是 worker / bridge 协议通道。
SSE 是浏览器实时视图。
HTTP 是浏览器控制写入。
终端 detail 读 task state，不抢 chat 职责。
```

到这里，Mini 已经具备接近官方 Claude Code 远程控制体验的主体骨架。

下一章可以继续补 **Internal Events、CCR v2 Resume 与会话恢复协议**：让远程 session 在 worker 重启、浏览器刷新、CLI 恢复之后仍能继续接上同一条执行链。
