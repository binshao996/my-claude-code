# 第 50 章：Remote Control Server 的鉴权、Worker Epoch 与多客户端一致性

上一章我们做出了 Remote Control Server 的开发版：

```txt
session store
event bus
worker events
worker state
SSE stream
archive
remote task polling
```

它已经能跑通远端后台任务，但还不是一个可靠的控制平面。

因为真实远程控制系统会遇到这些问题：

- Web UI、CLI bridge、worker、viewer 同时访问同一个 session
- worker 断线后会重连
- worker 可能被新的 worker 替换
- 浏览器 SSE 会断，需要补发漏掉的事件
- WebSocket 不能总是带自定义 header
- 旧 worker 不能继续写入新 worker 的 session
- token 过期和 auth 失败不能无限重试
- 大量 stream event 不能一条条打爆服务端
- state / metadata 不能被并发更新互相覆盖

官方 Claude Code 解决这些问题的方式，不是简单“加个 token”。

它把 RCS 拆成几条清晰的协议边界：

```txt
management API
  -> API key / web token

session ingress
  -> API key or worker JWT

worker ownership
  -> worker_epoch

event ordering
  -> seqNum / Last-Event-ID / from_sequence_num

state reporting
  -> coalesced PUT /worker

event upload
  -> serial batch POST /worker/events

client fanout
  -> per-session EventBus + SSE
```

本章要把第 49 章的 Mini RCS 升级成更接近官方的版本。

到本章结束，你的 Mini 会新增：

- API key 鉴权
- Web token 鉴权
- worker JWT
- WebSocket subprotocol token 传递
- session ownership
- worker epoch 注册
- stale worker 拒绝
- worker heartbeat
- worker state 合并上报
- event bus sequence number
- SSE 断线续传
- worker stream 只投递 outbound events
- Web stream 投递完整 session events
- event payload normalization
- delivery tracking 的协议占位
- 客户端 SSE transport
- 客户端 CCR worker lifecycle

## 参考源码

本章参考这些真实模块：

```txt
packages/remote-control-server/src/config.ts
packages/remote-control-server/src/auth/api-key.ts
packages/remote-control-server/src/auth/token.ts
packages/remote-control-server/src/auth/jwt.ts
packages/remote-control-server/src/auth/middleware.ts
packages/remote-control-server/src/store.ts
packages/remote-control-server/src/services/session.ts
packages/remote-control-server/src/services/transport.ts
packages/remote-control-server/src/transport/event-bus.ts
packages/remote-control-server/src/transport/sse-writer.ts
packages/remote-control-server/src/transport/client-payload.ts
packages/remote-control-server/src/routes/v2/code-sessions.ts
packages/remote-control-server/src/routes/v2/worker.ts
packages/remote-control-server/src/routes/v2/worker-events.ts
packages/remote-control-server/src/routes/v2/worker-events-stream.ts
packages/remote-control-server/src/transport/ws-handler.ts

src/bridge/workSecret.ts
src/bridge/bridgeMain.ts
src/cli/remoteIO.ts
src/cli/transports/SSETransport.ts
src/cli/transports/ccrClient.ts
src/cli/transports/WorkerStateUploader.ts
src/utils/sessionIngressAuth.ts
```

先说清楚一个边界：

当前源码里服务端已经有 `worker_epoch` 生成，客户端也已经在请求体里携带 `worker_epoch`，并且客户端 `CCRClient` 已经把 `409` 当成 epoch mismatch 处理。

Mini 本章会把服务端校验也补上。

也就是说，本章的 Mini 实现是把源码中已经存在的协议字段和客户端语义补成闭环。

## 本章目标

本章要把 RCS 从“开发版事件总线”升级成“可靠控制平面”。

最终链路是：

```txt
CLI bridge
  -> API key create code session
  -> API key bridge session
  -> RCS increments worker_epoch
  -> RCS issues worker JWT
  -> worker connects with JWT
  -> worker reports state + heartbeat + events
  -> stale epoch returns 409

Web UI
  -> web token or UUID ownership
  -> subscribe session event stream
  -> Last-Event-ID resume
  -> send user / permission / interrupt events

Worker
  -> SSE reads outbound client events
  -> POST writes inbound worker events
  -> delivery ack optional
  -> state uploader coalesces updates
```

这章会改造第 49 章的 RCS 文件。

如果你已经写过上一章代码，本章不是从零替换，而是在原有 `src/rcs/` 上继续增强。

## 最终目录

新增或替换这些文件：

```txt
src/rcs/config.ts
src/rcs/auth/apiKey.ts
src/rcs/auth/token.ts
src/rcs/auth/jwt.ts
src/rcs/auth/middleware.ts
src/rcs/store.ts
src/rcs/sessionService.ts
src/rcs/eventBus.ts
src/rcs/payload.ts
src/rcs/sse.ts
src/rcs/routes.ts
src/rcs/server.ts

src/remote-session/sseTransport.ts
src/remote-session/workerStateUploader.ts
src/remote-session/ccrClient.ts
```

你也可以把它们合并到已有文件。

教程分开写是为了让每层职责更清楚。

## 一、先理解 RCS 的角色

RCS 里至少有四类调用者。

```txt
Web UI
  用户打开网页查看 session、发送输入、点 allow / deny。

CLI bridge
  本地或远端的控制进程，负责创建 code session、领取 worker token。

Worker
  真正跑 Claude Code 的进程，读用户输入，写 assistant/tool/result 事件。

Viewer
  只查看 session 的客户端，可能不应该拥有 interrupt 权限。
```

不同调用者不能共用一种 token。

如果只用一个长 token，会带来两个问题：

1. 泄漏后权限太大。
2. 难以限制 token 只能访问某个 session。

所以官方设计有几条 auth 路径：

```txt
API key
  管理入口，bridge 创建 session、注册 worker。

Web token
  Web UI 登录后拿到短 token，用于网页 API。

Worker JWT
  针对单个 session 的 ingress token，用于 worker 上报事件和读取事件流。

WebSocket subprotocol token
  给不能发 Authorization header 的 WS 客户端使用。
```

Mini 也按这个思路写。

## 二、配置

创建 `src/rcs/config.ts`：

```ts
export const config = {
  version: process.env.MINI_RCS_VERSION ?? "0.1.0",
  port: Number.parseInt(process.env.MINI_RCS_PORT ?? "8787", 10),
  host: process.env.MINI_RCS_HOST ?? "0.0.0.0",
  apiKeys: (process.env.MINI_RCS_API_KEYS ?? "")
    .split(",")
    .map(key => key.trim())
    .filter(Boolean),
  baseUrl: process.env.MINI_RCS_BASE_URL ?? "",
  jwtExpiresIn: Number.parseInt(process.env.MINI_RCS_JWT_EXPIRES_IN ?? "3600", 10),
  heartbeatInterval: Number.parseInt(process.env.MINI_RCS_HEARTBEAT_INTERVAL ?? "20", 10),
  disconnectTimeout: Number.parseInt(process.env.MINI_RCS_DISCONNECT_TIMEOUT ?? "300", 10),
  maxEventsPerSession: Number.parseInt(process.env.MINI_RCS_MAX_EVENTS_PER_SESSION ?? "5000", 10),
  sseKeepaliveMs: Number.parseInt(process.env.MINI_RCS_SSE_KEEPALIVE_MS ?? "15000", 10),
} as const;

export function getBaseUrl(): string {
  const url = config.baseUrl || `http://localhost:${config.port}`;
  return url.replace(/\/+$/, "");
}
```

对应官方配置里比较关键的是：

```txt
RCS_API_KEYS
RCS_JWT_EXPIRES_IN
RCS_HEARTBEAT_INTERVAL
RCS_DISCONNECT_TIMEOUT
RCS_WS_IDLE_TIMEOUT
RCS_WS_KEEPALIVE_INTERVAL
```

Mini 先实现 HTTP/SSE 相关参数。

WebSocket idle timeout 后面章节再补。

## 三、API Key 鉴权

API key 用于管理入口。

比如：

```txt
POST /v1/code/sessions
POST /v1/code/sessions/:id/bridge
POST /v1/code/sessions/:id/worker/register
```

创建 `src/rcs/auth/apiKey.ts`：

```ts
import { createHash, timingSafeEqual } from "crypto";
import { config } from "../config";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function validateApiKey(token: string | undefined): boolean {
  if (!token) return false;

  const tokenHash = sha256(token);
  return config.apiKeys.some(key => {
    const expectedHash = sha256(key);
    if (expectedHash.length !== tokenHash.length) return false;
    return timingSafeEqual(expectedHash, tokenHash);
  });
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
```

这里使用 `timingSafeEqual`。

不要直接：

```ts
token === configuredKey
```

这类比较可能暴露 timing side channel。

Mini 里风险不高，但养成习惯是值得的。

## 四、Web Token

Web UI 不应该直接拿长期 API key。

它应该登录后拿一个短 token。

创建 `src/rcs/auth/token.ts`：

```ts
import { randomBytes } from "crypto";
import { storeCreateToken, storeGetUserByToken } from "../store";

export function issueToken(username: string): { token: string; expires_in: number } {
  const token = `rct_${randomBytes(16).toString("hex")}`;
  storeCreateToken(username, token);
  return {
    token,
    expires_in: 86400,
  };
}

export function resolveToken(token: string | undefined): string | null {
  if (!token) return null;
  const entry = storeGetUserByToken(token);
  return entry?.username ?? null;
}
```

官方源码里 token 格式类似：

```txt
rct_<counter>_<random-hex>
```

Mini 可以不用 counter。

重点是：

```txt
token -> username
```

管理 API 可以接受 web token 并把 username 注入请求上下文。

## 五、Worker JWT

Worker JWT 只用于某一个 session。

创建 `src/rcs/auth/jwt.ts`：

```ts
import { createHmac, timingSafeEqual } from "crypto";

export type WorkerJwtPayload = {
  session_id: string;
  role: "worker";
  iat: number;
  exp: number;
};

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function getSigningKey(): string {
  const key = process.env.MINI_RCS_API_KEYS?.split(",").filter(Boolean)[0];
  if (!key) {
    throw new Error("No API key configured for JWT signing");
  }
  return key;
}

export function generateWorkerJwt(sessionId: string, expiresInSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "HS256",
    typ: "JWT",
  };
  const payload: WorkerJwtPayload = {
    session_id: sessionId,
    role: "worker",
    iat: now,
    exp: now + expiresInSeconds,
  };

  const headerPart = base64url(JSON.stringify(header));
  const payloadPart = base64url(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = createHmac("sha256", getSigningKey()).update(signingInput).digest();

  return `${signingInput}.${base64url(signature)}`;
}

export function verifyWorkerJwt(token: string): WorkerJwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerPart, payloadPart, signaturePart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;
  const expected = createHmac("sha256", getSigningKey()).update(signingInput).digest();
  const actual = Buffer.from(signaturePart.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(base64urlDecode(payloadPart)) as WorkerJwtPayload;
    if (payload.role !== "worker") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
```

这里没有引入外部 JWT 库。

官方 RCS 也是轻量 HMAC-SHA256。

注意：JWT payload 里必须带 `session_id`。

后面的 middleware 会校验：

```txt
JWT.session_id === route session id
```

否则某个 session 的 worker token 可以写入另一个 session。

## 六、鉴权中间件

创建 `src/rcs/auth/middleware.ts`：

```ts
import type { Context, Next } from "hono";
import { validateApiKey } from "./apiKey";
import { verifyWorkerJwt } from "./jwt";
import { resolveToken } from "./token";

const WS_AUTH_PROTOCOL_PREFIX = "rcs.auth.";

export function encodeWebSocketAuthProtocol(token: string): string {
  return `${WS_AUTH_PROTOCOL_PREFIX}${Buffer.from(token, "utf8").toString("base64url")}`;
}

function decodeWebSocketAuthProtocol(protocolHeader: string | undefined): string | undefined {
  if (!protocolHeader) return undefined;

  for (const part of protocolHeader.split(",")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(WS_AUTH_PROTOCOL_PREFIX)) continue;

    const encoded = trimmed.slice(WS_AUTH_PROTOCOL_PREFIX.length);
    if (!encoded) return undefined;

    try {
      const decoded = Buffer.from(encoded, "base64url").toString("utf8");
      return decoded || undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function extractBearerToken(c: Context): string | undefined {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

export function extractWebSocketAuthToken(c: Context): string | undefined {
  return extractBearerToken(c) ?? decodeWebSocketAuthProtocol(c.req.header("Sec-WebSocket-Protocol"));
}

export async function apiKeyAuth(c: Context, next: Next): Promise<Response | void> {
  const token = extractBearerToken(c);

  const username = resolveToken(token);
  if (username) {
    c.set("username", username);
    await next();
    return;
  }

  if (validateApiKey(token)) {
    const headerUsername = c.req.header("X-Username") ?? c.req.query("username");
    if (headerUsername) {
      c.set("username", headerUsername);
    }
    await next();
    return;
  }

  return c.json(
    {
      error: {
        type: "unauthorized",
        message: "Invalid or missing auth token",
      },
    },
    401,
  );
}

export async function sessionIngressAuth(c: Context, next: Next): Promise<Response | void> {
  const token = extractWebSocketAuthToken(c);
  if (!token) {
    return c.json(
      {
        error: {
          type: "unauthorized",
          message: "Missing auth token",
        },
      },
      401,
    );
  }

  if (validateApiKey(token)) {
    await next();
    return;
  }

  const payload = verifyWorkerJwt(token);
  if (payload) {
    const routeSessionId = c.req.param("id") || c.req.param("sessionId");
    if (routeSessionId && payload.session_id !== routeSessionId) {
      return c.json(
        {
          error: {
            type: "forbidden",
            message: "JWT session_id does not match target session",
          },
        },
        403,
      );
    }

    c.set("jwtPayload", payload);
    await next();
    return;
  }

  return c.json(
    {
      error: {
        type: "unauthorized",
        message: "Invalid API key or JWT",
      },
    },
    401,
  );
}

export async function acceptCliHeaders(_c: Context, next: Next): Promise<void> {
  await next();
}
```

这里有两个重点。

第一，`apiKeyAuth` 支持两种身份：

```txt
web token -> username
API key -> optional X-Username
```

第二，`sessionIngressAuth` 支持：

```txt
API key
worker JWT
WebSocket subprotocol token
```

为什么 WebSocket 要用 subprotocol？

因为有些 WebSocket 客户端不能设置 `Authorization` header。

不要把 token 放 query string。

query string 很容易进入日志、代理、浏览器历史。

## 七、Store

创建 `src/rcs/store.ts`：

```ts
import { randomUUID } from "crypto";

export type UserRecord = {
  username: string;
  createdAt: Date;
};

export type SessionRecord = {
  id: string;
  title: string | null;
  status: string;
  source: string;
  permissionMode: string | null;
  workerEpoch: number;
  username: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionWorkerRecord = {
  sessionId: string;
  workerStatus: string | null;
  externalMetadata: Record<string, unknown> | null;
  requiresActionDetails: Record<string, unknown> | null;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const users = new Map<string, UserRecord>();
const tokenToUser = new Map<string, { username: string; createdAt: Date }>();
const sessions = new Map<string, SessionRecord>();
const sessionWorkers = new Map<string, SessionWorkerRecord>();
const sessionOwners = new Map<string, Set<string>>();

export function storeCreateUser(username: string): UserRecord {
  const existing = users.get(username);
  if (existing) return existing;

  const record: UserRecord = {
    username,
    createdAt: new Date(),
  };
  users.set(username, record);
  return record;
}

export function storeCreateToken(username: string, token: string): void {
  tokenToUser.set(token, {
    username,
    createdAt: new Date(),
  });
}

export function storeGetUserByToken(token: string): { username: string; createdAt: Date } | undefined {
  return tokenToUser.get(token);
}

export function storeCreateSession(req: {
  idPrefix?: string;
  title?: string | null;
  source?: string;
  permissionMode?: string | null;
  username?: string | null;
}): SessionRecord {
  const now = new Date();
  const id = `${req.idPrefix ?? "session_"}${randomUUID().replace(/-/g, "")}`;
  const record: SessionRecord = {
    id,
    title: req.title ?? null,
    status: "idle",
    source: req.source ?? "remote-control",
    permissionMode: req.permissionMode ?? null,
    workerEpoch: 0,
    username: req.username ?? null,
    createdAt: now,
    updatedAt: now,
  };

  sessions.set(id, record);
  return record;
}

export function storeGetSession(id: string): SessionRecord | undefined {
  return sessions.get(id);
}

export function storeUpdateSession(
  id: string,
  patch: Partial<Pick<SessionRecord, "title" | "status" | "workerEpoch">>,
): boolean {
  const record = sessions.get(id);
  if (!record) return false;

  Object.assign(record, patch, {
    updatedAt: new Date(),
  });
  return true;
}

export function storeListSessions(): SessionRecord[] {
  return [...sessions.values()];
}

export function storeGetSessionWorker(sessionId: string): SessionWorkerRecord | undefined {
  return sessionWorkers.get(sessionId);
}

export function storeUpsertSessionWorker(
  sessionId: string,
  patch: {
    workerStatus?: string | null;
    externalMetadata?: Record<string, unknown> | null;
    requiresActionDetails?: Record<string, unknown> | null;
    lastHeartbeatAt?: Date | null;
  },
): SessionWorkerRecord {
  const now = new Date();
  const existing = sessionWorkers.get(sessionId);
  const record: SessionWorkerRecord =
    existing ??
    {
      sessionId,
      workerStatus: null,
      externalMetadata: null,
      requiresActionDetails: null,
      lastHeartbeatAt: null,
      createdAt: now,
      updatedAt: now,
    };

  if (patch.workerStatus !== undefined) {
    record.workerStatus = patch.workerStatus;
  }

  if (patch.externalMetadata !== undefined) {
    record.externalMetadata =
      patch.externalMetadata === null
        ? null
        : {
            ...(record.externalMetadata ?? {}),
            ...patch.externalMetadata,
          };
  }

  if (patch.requiresActionDetails !== undefined) {
    record.requiresActionDetails = patch.requiresActionDetails;
  }

  if (patch.lastHeartbeatAt !== undefined) {
    record.lastHeartbeatAt = patch.lastHeartbeatAt;
  }

  record.updatedAt = now;
  sessionWorkers.set(sessionId, record);
  return record;
}

export function storeBindSession(sessionId: string, uuid: string): void {
  const owners = sessionOwners.get(sessionId) ?? new Set<string>();
  owners.add(uuid);
  sessionOwners.set(sessionId, owners);
}

export function storeIsSessionOwner(sessionId: string, uuid: string): boolean {
  return sessionOwners.get(sessionId)?.has(uuid) ?? false;
}

export function storeGetSessionOwners(sessionId: string): Set<string> | undefined {
  return sessionOwners.get(sessionId);
}

export function storeReset(): void {
  users.clear();
  tokenToUser.clear();
  sessions.clear();
  sessionWorkers.clear();
  sessionOwners.clear();
}
```

官方 store 还包含 environment、work item、ACP agent 等。

本章聚焦 code sessions。

重要字段有三个：

```txt
status
workerEpoch
session worker state
```

`workerEpoch` 是防止旧 worker 继续写的关键。

## 八、Session Service

创建 `src/rcs/sessionService.ts`：

```ts
import { randomUUID } from "crypto";
import {
  storeCreateSession,
  storeGetSession,
  storeGetSessionOwners,
  storeIsSessionOwner,
  storeBindSession,
  storeUpdateSession,
  storeListSessions,
  type SessionRecord,
} from "./store";
import { getAllEventBuses, getEventBus, removeEventBus } from "./eventBus";

const CODE_SESSION_PREFIX = "cse_";
const WEB_SESSION_PREFIX = "session_";
const CLOSED_SESSION_STATUSES = new Set(["archived", "inactive"]);

export type SessionResponse = {
  id: string;
  title: string | null;
  status: string;
  source: string;
  permission_mode: string | null;
  worker_epoch: number;
  username: string | null;
  created_at: number;
  updated_at: number;
};

function toResponse(row: SessionRecord): SessionResponse {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source: row.source,
    permission_mode: row.permissionMode,
    worker_epoch: row.workerEpoch,
    username: row.username,
    created_at: row.createdAt.getTime() / 1000,
    updated_at: row.updatedAt.getTime() / 1000,
  };
}

export function toWebSessionId(sessionId: string): string {
  if (!sessionId.startsWith(CODE_SESSION_PREFIX)) return sessionId;
  return `${WEB_SESSION_PREFIX}${sessionId.slice(CODE_SESSION_PREFIX.length)}`;
}

function toCompatibleCodeSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(WEB_SESSION_PREFIX)) return null;
  return `${CODE_SESSION_PREFIX}${sessionId.slice(WEB_SESSION_PREFIX.length)}`;
}

export function createCodeSession(req: {
  title?: string | null;
  source?: string;
  permission_mode?: string | null;
  username?: string | null;
}): SessionResponse {
  const row = storeCreateSession({
    idPrefix: CODE_SESSION_PREFIX,
    title: req.title,
    source: req.source,
    permissionMode: req.permission_mode,
    username: req.username,
  });
  return toResponse(row);
}

export function getSession(sessionId: string): SessionResponse | null {
  const row = storeGetSession(sessionId);
  return row ? toResponse(row) : null;
}

export function resolveExistingSessionId(sessionId: string): string | null {
  if (storeGetSession(sessionId)) return sessionId;

  const compatible = toCompatibleCodeSessionId(sessionId);
  if (compatible && storeGetSession(compatible)) return compatible;

  return null;
}

export function resolveOwnedWebSessionId(sessionId: string, uuid: string): string | null {
  if (storeIsSessionOwner(sessionId, uuid)) return sessionId;

  const compatible = toCompatibleCodeSessionId(sessionId);
  if (compatible && storeIsSessionOwner(compatible, uuid)) return compatible;

  const existing = resolveExistingSessionId(sessionId);
  if (!existing) return null;

  const owners = storeGetSessionOwners(existing);
  if (!owners || owners.size === 0) {
    storeBindSession(existing, uuid);
    return existing;
  }

  return null;
}

export function isSessionClosedStatus(status: string | null | undefined): boolean {
  return Boolean(status && CLOSED_SESSION_STATUSES.has(status));
}

export function updateSessionStatus(sessionId: string, status: string): void {
  storeUpdateSession(sessionId, { status });

  const bus = getAllEventBuses().get(sessionId);
  if (!bus) return;

  bus.publish({
    id: randomUUID(),
    sessionId,
    type: "session_status",
    payload: { status },
    direction: "inbound",
  });
}

export function touchSession(sessionId: string): void {
  storeUpdateSession(sessionId, {});
}

export function archiveSession(sessionId: string): void {
  updateSessionStatus(sessionId, "archived");
  removeEventBus(sessionId);
}

export function incrementEpoch(sessionId: string): number {
  const row = storeGetSession(sessionId);
  if (!row) {
    throw new Error("Session not found");
  }

  const next = row.workerEpoch + 1;
  storeUpdateSession(sessionId, { workerEpoch: next });
  return next;
}

export function assertWorkerEpoch(sessionId: string, value: unknown): Response | null {
  const row = storeGetSession(sessionId);
  if (!row) {
    return Response.json(
      {
        error: {
          type: "not_found",
          message: "Session not found",
        },
      },
      { status: 404 },
    );
  }

  const epoch = typeof value === "string" ? Number(value) : value;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch)) {
    return Response.json(
      {
        error: {
          type: "bad_request",
          message: "Missing or invalid worker_epoch",
        },
      },
      { status: 400 },
    );
  }

  if (epoch !== row.workerEpoch) {
    return Response.json(
      {
        error: {
          type: "epoch_mismatch",
          message: "Worker epoch is stale",
          expected: row.workerEpoch,
          received: epoch,
        },
      },
      { status: 409 },
    );
  }

  return null;
}

export function listSessions(): SessionResponse[] {
  return storeListSessions().map(toResponse);
}

export function ensureSessionOpen(sessionId: string): Response | null {
  const session = getSession(sessionId);
  if (!session) {
    return Response.json({ error: { type: "not_found", message: "Session not found" } }, { status: 404 });
  }

  if (isSessionClosedStatus(session.status)) {
    return Response.json({ error: { type: "conflict", message: "Session is closed" } }, { status: 409 });
  }

  return null;
}
```

这里比上一章多了两个关键函数：

```ts
incrementEpoch(sessionId)
assertWorkerEpoch(sessionId, body.worker_epoch)
```

epoch 的含义是：

```txt
每当 RCS 接受一个新的 worker 绑定，就递增 worker_epoch。
之后所有 worker 写入都必须携带这个 epoch。
如果旧 worker 继续写，服务端返回 409。
客户端收到 409 立刻退出或关闭自己。
```

这就是多 worker 一致性的核心。

## 九、EventBus 升级

上一章 event bus 只保存事件。

本章要加：

- 单调递增 seqNum
- 历史补发
- 事件上限
- close 后拒绝写入
- subscriber error 隔离

创建 `src/rcs/eventBus.ts`：

```ts
import { config } from "./config";

export type SessionEvent = {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  direction: "inbound" | "outbound";
  seqNum: number;
  createdAt: number;
};

type Subscriber = (event: SessionEvent) => void;

export class EventBus {
  private subscribers = new Set<Subscriber>();
  private events: SessionEvent[] = [];
  private seqNum = 0;
  private closed = false;

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  publish(input: Omit<SessionEvent, "seqNum" | "createdAt">): SessionEvent {
    if (this.closed) {
      throw new Error("EventBus is closed");
    }

    const event: SessionEvent = {
      ...input,
      seqNum: ++this.seqNum,
      createdAt: Date.now(),
    };

    this.events.push(event);

    if (this.events.length > config.maxEventsPerSession) {
      this.events = this.events.slice(-Math.floor(config.maxEventsPerSession / 2));
    }

    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        console.error(error);
      }
    }

    return event;
  }

  getLastSeqNum(): number {
    return this.seqNum;
  }

  getEventsSince(seqNum: number): SessionEvent[] {
    const index = this.events.findIndex(event => event.seqNum > seqNum);
    if (index === -1) return [];
    return this.events.slice(index);
  }

  close(): void {
    this.closed = true;
    this.subscribers.clear();
  }
}

const buses = new Map<string, EventBus>();

export function getEventBus(sessionId: string): EventBus {
  let bus = buses.get(sessionId);
  if (!bus) {
    bus = new EventBus();
    buses.set(sessionId, bus);
  }
  return bus;
}

export function removeEventBus(sessionId: string): void {
  const bus = buses.get(sessionId);
  if (bus) {
    bus.close();
    buses.delete(sessionId);
  }
}

export function getAllEventBuses(): Map<string, EventBus> {
  return buses;
}
```

`seqNum` 是多客户端一致性的基础。

每个客户端都可以保存自己看到的最后序号：

```txt
lastSequenceNum = 123
```

断线重连时请求：

```txt
from_sequence_num=123
```

服务端补发：

```txt
seqNum > 123 的事件
```

不要用数组下标当 sequence。

数组可能被裁剪。

sequence 必须独立递增。

## 十、Payload Normalization

worker、Web、bridge 发来的 event 形状可能不一样。

必须在服务端入口统一。

创建 `src/rcs/payload.ts`：

```ts
import { randomUUID } from "crypto";
import type { SessionEvent } from "./eventBus";

function extractContent(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";

  const record = payload as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;

  const message = record.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(block => block && typeof block === "object" && (block as { type?: string }).type === "text")
        .map(block => String((block as { text?: string }).text ?? ""))
        .join("");
    }
  }

  return "";
}

export function normalizePayload(type: string, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return {
      content: typeof payload === "string" ? payload : "",
      raw: payload,
    };
  }

  const record = payload as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    content: extractContent(payload),
    raw: payload,
  };

  if (typeof record.uuid === "string" && record.uuid) normalized.uuid = record.uuid;
  if (typeof record.isSynthetic === "boolean") normalized.isSynthetic = record.isSynthetic;
  if (typeof record.status === "string") normalized.status = record.status;
  if (typeof record.subtype === "string") normalized.subtype = record.subtype;
  if (record.message) normalized.message = record.message;

  if (record.tool_name) normalized.tool_name = record.tool_name;
  if (record.name) normalized.tool_name = record.name;
  if (record.tool_input) normalized.tool_input = record.tool_input;
  if (record.input) normalized.tool_input = record.input;

  if (record.request_id) normalized.request_id = record.request_id;
  if (record.request) normalized.request = record.request;
  if (record.response) normalized.response = record.response;
  if (record.approved !== undefined) normalized.approved = record.approved;
  if (record.updated_input) normalized.updated_input = record.updated_input;

  if (type === "task_state") {
    if (typeof record.task_list_id === "string") normalized.task_list_id = record.task_list_id;
    if (typeof record.taskListId === "string") normalized.taskListId = record.taskListId;
    if (Array.isArray(record.tasks)) normalized.tasks = record.tasks;
  }

  return normalized;
}

export function toClientPayload(event: SessionEvent): Record<string, unknown> {
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  const uuid = typeof payload.uuid === "string" && payload.uuid ? payload.uuid : event.id;

  if (event.type === "user" || event.type === "user_message") {
    return {
      type: "user",
      uuid,
      session_id: event.sessionId,
      ...(payload.isSynthetic === true ? { isSynthetic: true } : {}),
      message: {
        role: "user",
        content: payload.content ?? payload.message ?? "",
      },
    };
  }

  if (event.type === "permission_response" || event.type === "control_response") {
    const existingResponse = payload.response as Record<string, unknown> | undefined;
    if (existingResponse) {
      return {
        type: "control_response",
        response: existingResponse,
      };
    }

    const approved = Boolean(payload.approved);
    return {
      type: "control_response",
      response: approved
        ? {
            subtype: "success",
            request_id: payload.request_id ?? "",
            response: {
              behavior: "allow",
              ...(payload.updated_input ? { updatedInput: payload.updated_input } : {}),
            },
          }
        : {
            subtype: "error",
            request_id: payload.request_id ?? "",
            error: "Permission denied by user",
            response: {
              behavior: "deny",
            },
          },
    };
  }

  if (event.type === "interrupt") {
    return {
      type: "control_request",
      request_id: event.id,
      request: {
        subtype: "interrupt",
      },
    };
  }

  if (event.type === "control_request") {
    return {
      type: "control_request",
      request_id: payload.request_id ?? event.id,
      request: payload.request ?? payload,
    };
  }

  return {
    type: event.type,
    uuid,
    session_id: event.sessionId,
    message: payload,
  };
}

export function publishPayload(input: {
  bus: { publish(event: Omit<SessionEvent, "seqNum" | "createdAt">): SessionEvent };
  sessionId: string;
  type: string;
  payload: unknown;
  direction: "inbound" | "outbound";
}): SessionEvent {
  return input.bus.publish({
    id: randomUUID(),
    sessionId: input.sessionId,
    type: input.type,
    payload: normalizePayload(input.type, input.payload),
    direction: input.direction,
  });
}
```

这层解决一个常见问题：

不同入口传入的事件格式不一致。

比如：

```txt
{ content: "hello" }
{ message: { role: "user", content: "hello" } }
{ message: { content: [{ type: "text", text: "hello" }] } }
```

服务端必须把它们 normalize 成统一 payload。

否则 Web UI、worker、poller 会各写一套解析逻辑。

## 十一、SSE Stream

需要两种 SSE：

```txt
Web stream
  给 Web UI 看完整 session events。

Worker stream
  给 worker 读用户输入、permission response、interrupt。
  只投递 outbound events。
```

创建 `src/rcs/sse.ts`：

```ts
import { config } from "./config";
import { getEventBus, type SessionEvent } from "./eventBus";
import { toClientPayload } from "./payload";

function encodeWebEvent(event: SessionEvent): string {
  const data = JSON.stringify({
    type: event.type,
    payload: event.payload,
    direction: event.direction,
    seqNum: event.seqNum,
  });

  return `id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`;
}

function encodeWorkerEvent(event: SessionEvent): string {
  const data = JSON.stringify({
    event_id: event.id,
    sequence_num: event.seqNum,
    event_type: event.type,
    source: "client",
    payload: toClientPayload(event),
    created_at: new Date(event.createdAt).toISOString(),
  });

  return `id: ${event.seqNum}\nevent: client_event\ndata: ${data}\n\n`;
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export function createWebEventStream(request: Request, sessionId: string, fromSeqNum = 0): Response {
  const bus = getEventBus(sessionId);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      if (fromSeqNum > 0) {
        for (const event of bus.getEventsSince(fromSeqNum)) {
          controller.enqueue(encoder.encode(encodeWebEvent(event)));
        }
      }

      controller.enqueue(encoder.encode(": keepalive\n\n"));

      const unsubscribe = bus.subscribe(event => {
        try {
          controller.enqueue(encoder.encode(encodeWebEvent(event)));
        } catch {
          unsubscribe();
        }
      });

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
          unsubscribe();
        }
      }, config.sseKeepaliveMs);

      request.signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return sseResponse(stream);
}

export function createWorkerEventStream(request: Request, sessionId: string, fromSeqNum = 0): Response {
  const bus = getEventBus(sessionId);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      if (fromSeqNum > 0) {
        for (const event of bus.getEventsSince(fromSeqNum)) {
          if (event.direction === "outbound") {
            controller.enqueue(encoder.encode(encodeWorkerEvent(event)));
          }
        }
      }

      controller.enqueue(encoder.encode(": keepalive\n\n"));

      const unsubscribe = bus.subscribe(event => {
        if (event.direction !== "outbound") return;

        try {
          controller.enqueue(encoder.encode(encodeWorkerEvent(event)));
        } catch {
          unsubscribe();
        }
      });

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
          unsubscribe();
        }
      }, config.sseKeepaliveMs);

      request.signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return sseResponse(stream);
}
```

这里要注意 `direction`。

worker stream 只应该收到 `outbound`。

因为 outbound 表示：

```txt
client -> worker
```

例如：

- user message
- permission response
- interrupt

worker 写回来的 assistant/result/tool event 是 `inbound`，不能再发回 worker，否则会形成回声。

Web stream 可以看完整事件。

## 十二、Routes：Code Sessions

创建或替换 `src/rcs/routes.ts`。

先写 code session 管理入口：

```ts
import { Hono } from "hono";
import { apiKeyAuth, acceptCliHeaders, sessionIngressAuth } from "./auth/middleware";
import { config, getBaseUrl } from "./config";
import { generateWorkerJwt } from "./auth/jwt";
import {
  archiveSession,
  assertWorkerEpoch,
  createCodeSession,
  ensureSessionOpen,
  getSession,
  incrementEpoch,
  touchSession,
  updateSessionStatus,
} from "./sessionService";
import { getEventBus } from "./eventBus";
import { createWebEventStream, createWorkerEventStream } from "./sse";
import { normalizePayload, publishPayload } from "./payload";
import { storeGetSessionWorker, storeUpsertSessionWorker } from "./store";

const app = new Hono();

app.post("/v1/code/sessions", acceptCliHeaders, apiKeyAuth, async c => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    source?: string;
    permission_mode?: string;
  };

  const session = createCodeSession({
    title: body.title ?? "Code session",
    source: body.source ?? "remote-control",
    permission_mode: body.permission_mode ?? null,
    username: c.get("username") ?? null,
  });

  return c.json({ session }, 200);
});

app.post("/v1/code/sessions/:id/bridge", acceptCliHeaders, apiKeyAuth, c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  const epoch = incrementEpoch(sessionId);
  const expiresInSeconds = config.jwtExpiresIn;
  const workerJwt = generateWorkerJwt(sessionId, expiresInSeconds);

  return c.json(
    {
      api_base_url: getBaseUrl(),
      worker_epoch: epoch,
      worker_jwt: workerJwt,
      expires_in: expiresInSeconds,
    },
    200,
  );
});
```

`/bridge` 是关键入口。

它做三件事：

```txt
incrementEpoch(sessionId)
generateWorkerJwt(sessionId)
return api_base_url + worker_epoch + worker_jwt
```

客户端拿到这些之后启动 worker。

worker 后续所有请求都带：

```txt
Authorization: Bearer <worker_jwt>
body.worker_epoch = <epoch>
```

## 十三、Routes：Worker State

继续在 `src/rcs/routes.ts` 里加入 worker state：

```ts
app.get("/v1/code/sessions/:id/worker", acceptCliHeaders, sessionIngressAuth, c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  const worker = storeGetSessionWorker(sessionId);
  return c.json(
    {
      worker: {
        worker_status: worker?.workerStatus ?? session.status,
        external_metadata: worker?.externalMetadata ?? null,
        requires_action_details: worker?.requiresActionDetails ?? null,
        last_heartbeat_at: worker?.lastHeartbeatAt?.toISOString() ?? null,
      },
    },
    200,
  );
});

app.put("/v1/code/sessions/:id/worker", acceptCliHeaders, sessionIngressAuth, async c => {
  const sessionId = c.req.param("id");
  const body = (await c.req.json()) as Record<string, unknown>;

  const epochError = assertWorkerEpoch(sessionId, body.worker_epoch);
  if (epochError) return epochError;

  if (typeof body.worker_status === "string") {
    updateSessionStatus(sessionId, body.worker_status);
  } else {
    touchSession(sessionId);
  }

  const worker = storeUpsertSessionWorker(sessionId, {
    workerStatus: typeof body.worker_status === "string" ? body.worker_status : undefined,
    externalMetadata:
      body.external_metadata && typeof body.external_metadata === "object"
        ? (body.external_metadata as Record<string, unknown>)
        : undefined,
    requiresActionDetails:
      body.requires_action_details && typeof body.requires_action_details === "object"
        ? (body.requires_action_details as Record<string, unknown>)
        : body.requires_action_details === null
          ? null
          : undefined,
  });

  return c.json(
    {
      status: "ok",
      worker: {
        worker_status: worker.workerStatus,
        external_metadata: worker.externalMetadata,
        requires_action_details: worker.requiresActionDetails,
        last_heartbeat_at: worker.lastHeartbeatAt?.toISOString() ?? null,
      },
    },
    200,
  );
});

app.post("/v1/code/sessions/:id/worker/heartbeat", acceptCliHeaders, sessionIngressAuth, async c => {
  const sessionId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const epochError = assertWorkerEpoch(sessionId, body.worker_epoch);
  if (epochError) return epochError;

  const now = new Date();
  storeUpsertSessionWorker(sessionId, {
    lastHeartbeatAt: now,
  });
  touchSession(sessionId);

  return c.json({ status: "ok", last_heartbeat_at: now.toISOString() }, 200);
});
```

这里每个 worker write 都校验 epoch。

`GET /worker` 不校验 epoch。

原因是 worker 启动时需要先读旧 metadata，用于恢复状态。

它只需要 session JWT。

写入才要求 epoch。

## 十四、Routes：Worker Register

继续加入：

```ts
app.post("/v1/code/sessions/:id/worker/register", acceptCliHeaders, apiKeyAuth, c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  const epoch = incrementEpoch(sessionId);
  return c.json({ worker_epoch: epoch }, 200);
});
```

这条 route 和 `/bridge` 有重叠。

差别是：

```txt
/bridge
  返回 worker_epoch + worker_jwt + api_base_url

/worker/register
  只返回 worker_epoch
```

官方源码两个路径都存在。

Mini 保留两个，可以兼容不同启动方式。

## 十五、Routes：Worker Events

worker 把 assistant/result/tool/system event 写回来。

继续加入：

```ts
function extractWorkerEvents(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") return [];

  const record = body as Record<string, unknown>;
  const rawEvents = Array.isArray(record.events) ? record.events : Array.isArray(body) ? body : [body];

  return rawEvents
    .filter((event): event is Record<string, unknown> => Boolean(event && typeof event === "object"))
    .map(event => {
      const wrapped = event.payload;
      if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
        return wrapped as Record<string, unknown>;
      }
      return event;
    });
}

app.post("/v1/code/sessions/:id/worker/events", acceptCliHeaders, sessionIngressAuth, async c => {
  const sessionId = c.req.param("id");
  const body = await c.req.json();

  const epochError = assertWorkerEpoch(sessionId, (body as Record<string, unknown>).worker_epoch);
  if (epochError) return epochError;

  const closed = ensureSessionOpen(sessionId);
  if (closed) return closed;

  const events = extractWorkerEvents(body);
  const bus = getEventBus(sessionId);
  const published = [];

  for (const event of events) {
    const eventType = typeof event.type === "string" ? event.type : "message";
    published.push(
      publishPayload({
        bus,
        sessionId,
        type: eventType,
        payload: event,
        direction: "inbound",
      }),
    );
  }

  touchSession(sessionId);
  return c.json({ status: "ok", count: published.length }, 200);
});
```

`worker/events` 是 inbound。

不要写成 outbound。

方向规则是：

```txt
outbound: server/client -> worker
inbound: worker -> server/client
```

这不是网络方向，而是以 worker 为中心的业务方向。

## 十六、Routes：Client Events

Web UI 或本地 viewer 要向 worker 发送 user input、permission response、interrupt。

继续加入：

```ts
app.post("/v1/sessions/:id/events", acceptCliHeaders, sessionIngressAuth, async c => {
  const sessionId = c.req.param("id");

  const closed = ensureSessionOpen(sessionId);
  if (closed) return closed;

  const body = (await c.req.json()) as Record<string, unknown>;
  const eventType = typeof body.type === "string" ? body.type : "user";

  const event = publishPayload({
    bus: getEventBus(sessionId),
    sessionId,
    type: eventType,
    payload: body,
    direction: "outbound",
  });

  touchSession(sessionId);
  return c.json({ status: "ok", event_id: event.id, seqNum: event.seqNum }, 200);
});

app.post("/v1/sessions/:id/archive", acceptCliHeaders, sessionIngressAuth, c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  archiveSession(sessionId);
  return c.json({ status: "ok" }, 200);
});
```

这里沿用第 49 章的 endpoint。

`archive` 会 close event bus。

archive 之后再写事件应该返回 409。

## 十七、Routes：Streams

继续加入 SSE route：

```ts
function parseFromSeq(c: Parameters<Parameters<typeof app.get>[1]>[0]): number {
  const query = c.req.query("from_sequence_num");
  const header = c.req.header("Last-Event-ID");
  const raw = query ?? header ?? "0";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

app.get("/v1/code/sessions/:id/worker/events/stream", acceptCliHeaders, sessionIngressAuth, c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  return createWorkerEventStream(c.req.raw, sessionId, parseFromSeq(c));
});

app.get("/v1/sessions/:id/events/stream", acceptCliHeaders, sessionIngressAuth, c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  return createWebEventStream(c.req.raw, sessionId, parseFromSeq(c));
});
```

注意：

```txt
Last-Event-ID
from_sequence_num
```

都要支持。

浏览器 EventSource 原生会带 `Last-Event-ID`。

自定义 worker transport 更适合显式传 `from_sequence_num`。

## 十八、Routes：Delivery Tracking

官方 RCS 里 worker 会上报：

```txt
received
processing
processed
```

当前服务端可以先 no-op。

但 endpoint 要保留。

继续加入：

```ts
app.post("/v1/code/sessions/:id/worker/events/delivery", acceptCliHeaders, sessionIngressAuth, async c => {
  const sessionId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const epochError = assertWorkerEpoch(sessionId, body.worker_epoch);
  if (epochError) return epochError;

  if (!getSession(sessionId)) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  return c.json({ status: "ok" }, 200);
});

app.post("/v1/code/sessions/:id/worker/events/:eventId/delivery", acceptCliHeaders, sessionIngressAuth, async c => {
  const sessionId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const epochError = assertWorkerEpoch(sessionId, body.worker_epoch);
  if (epochError) return epochError;

  if (!getSession(sessionId)) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  return c.json({ status: "ok" }, 200);
});

export default app;
```

为什么 no-op 也要做？

因为客户端 `CCRClient` 会上报 delivery ack。

如果服务端没有这个 endpoint，客户端会不断重试，制造噪音。

## 十九、Server 入口

创建 `src/rcs/server.ts`：

```ts
import app from "./routes";
import { config } from "./config";

Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: app.fetch,
});

console.log(`Mini RCS listening on http://${config.host}:${config.port}`);
```

脚本保持：

```json
{
  "scripts": {
    "rcs": "bun run src/rcs/server.ts"
  }
}
```

启动：

```bash
MINI_RCS_API_KEYS=dev-secret bun run rcs
```

## 二十、客户端 SSETransport

服务端有了 worker stream，客户端也要有对应 transport。

创建 `src/remote-session/sseTransport.ts`：

```ts
type SSEFrame = {
  event?: string;
  id?: string;
  data?: string;
};

export type StreamClientEvent = {
  event_id: string;
  sequence_num: number;
  event_type: string;
  source: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export function parseSSEFrames(buffer: string): { frames: SSEFrame[]; remaining: string } {
  const frames: SSEFrame[] = [];
  let position = 0;
  const delimiter = /\r?\n\r?\n/g;

  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(buffer)) !== null) {
    const rawFrame = buffer.slice(position, match.index);
    position = match.index + match[0].length;

    if (!rawFrame.trim()) continue;

    const frame: SSEFrame = {};
    let isComment = false;

    for (const rawLine of rawFrame.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith(":")) {
        isComment = true;
        continue;
      }

      const colon = line.indexOf(":");
      if (colon === -1) continue;

      const field = line.slice(0, colon);
      const value = line[colon + 1] === " " ? line.slice(colon + 2) : line.slice(colon + 1);

      if (field === "event") frame.event = value;
      if (field === "id") frame.id = value;
      if (field === "data") frame.data = frame.data ? `${frame.data}\n${value}` : value;
    }

    if (frame.data || isComment) {
      frames.push(frame);
    }
  }

  return {
    frames,
    remaining: buffer.slice(position),
  };
}

export class SSETransport {
  private abortController: AbortController | null = null;
  private lastSequenceNum = 0;
  private seenSequenceNums = new Set<number>();
  private onData?: (line: string) => void;
  private onEvent?: (event: StreamClientEvent) => void;

  constructor(
    private readonly streamUrl: URL,
    private readonly getAuthHeaders: () => Record<string, string>,
  ) {}

  getLastSequenceNum(): number {
    return this.lastSequenceNum;
  }

  setOnData(callback: (line: string) => void): void {
    this.onData = callback;
  }

  setOnEvent(callback: (event: StreamClientEvent) => void): void {
    this.onEvent = callback;
  }

  async connect(): Promise<void> {
    const url = new URL(this.streamUrl.href);
    if (this.lastSequenceNum > 0) {
      url.searchParams.set("from_sequence_num", String(this.lastSequenceNum));
    }

    const headers = {
      ...this.getAuthHeaders(),
      Accept: "text/event-stream",
      ...(this.lastSequenceNum > 0 ? { "Last-Event-ID": String(this.lastSequenceNum) } : {}),
    };

    this.abortController = new AbortController();
    const response = await fetch(url, {
      headers,
      signal: this.abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connect failed: ${response.status}`);
    }

    await this.readStream(response.body);
  }

  close(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSSEFrames(buffer);
        buffer = parsed.remaining;

        for (const frame of parsed.frames) {
          if (frame.id) {
            const seqNum = Number.parseInt(frame.id, 10);
            if (Number.isFinite(seqNum)) {
              if (!this.seenSequenceNums.has(seqNum)) {
                this.seenSequenceNums.add(seqNum);
              }
              if (seqNum > this.lastSequenceNum) {
                this.lastSequenceNum = seqNum;
              }
            }
          }

          if (frame.event === "client_event" && frame.data) {
            const event = JSON.parse(frame.data) as StreamClientEvent;
            this.onEvent?.(event);

            if (event.payload && typeof event.payload.type === "string") {
              this.onData?.(`${JSON.stringify(event.payload)}\n`);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
```

官方 `SSETransport` 更完整：

- 自动重连
- 永久错误码判断
- liveness timeout
- POST retry
- duplicate sequence 诊断
- buffer 上限
- `from_sequence_num` 高水位续传

Mini 先做到核心：

```txt
parse SSE
track seq
emit payload line
support resume
```

## 二十一、WorkerStateUploader

worker state 更新可能非常频繁。

例如：

```txt
idle
running
requires_action
metadata changed
pending action cleared
```

如果每次变化都立刻 PUT，会造成大量请求。

官方用 coalescing uploader。

创建 `src/remote-session/workerStateUploader.ts`：

```ts
type Config = {
  send: (body: Record<string, unknown>) => Promise<boolean>;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
};

export class WorkerStateUploader {
  private inflight: Promise<void> | null = null;
  private pending: Record<string, unknown> | null = null;
  private closed = false;

  constructor(private readonly config: Config) {}

  enqueue(patch: Record<string, unknown>): void {
    if (this.closed) return;
    this.pending = this.pending ? coalescePatches(this.pending, patch) : patch;
    void this.drain();
  }

  close(): void {
    this.closed = true;
    this.pending = null;
  }

  private async drain(): Promise<void> {
    if (this.inflight || this.closed || !this.pending) return;

    const payload = this.pending;
    this.pending = null;

    this.inflight = this.sendWithRetry(payload).then(() => {
      this.inflight = null;
      if (this.pending && !this.closed) {
        void this.drain();
      }
    });
  }

  private async sendWithRetry(payload: Record<string, unknown>): Promise<void> {
    let current = payload;
    let failures = 0;

    while (!this.closed) {
      const ok = await this.config.send(current);
      if (ok) return;

      failures++;
      await sleep(this.retryDelay(failures));

      if (this.pending && !this.closed) {
        current = coalescePatches(current, this.pending);
        this.pending = null;
      }
    }
  }

  private retryDelay(failures: number): number {
    const exponential = Math.min(this.config.baseDelayMs * 2 ** (failures - 1), this.config.maxDelayMs);
    return exponential + Math.random() * this.config.jitterMs;
  }
}

function coalescePatches(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (
      (key === "external_metadata" || key === "internal_metadata") &&
      merged[key] &&
      typeof merged[key] === "object" &&
      value &&
      typeof value === "object"
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

这个 uploader 的设计目标是：

```txt
最多一个 in-flight
最多一个 pending
失败后指数退避
retry 前吸收 pending
metadata 浅合并
```

这样不会因为 worker 状态频繁变化导致请求无限排队。

## 二十二、CCR Client

现在写 worker 侧生命周期 client。

创建 `src/remote-session/ccrClient.ts`：

```ts
import { randomUUID } from "crypto";
import { SSETransport, type StreamClientEvent } from "./sseTransport";
import { WorkerStateUploader } from "./workerStateUploader";

type RequestResult = {
  ok: boolean;
  retryAfterMs?: number;
};

export class EpochMismatchError extends Error {
  constructor() {
    super("Worker epoch mismatch");
  }
}

export class CCRClient {
  private workerEpoch = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private currentState: string | null = null;
  private readonly sessionBaseUrl: string;
  private readonly workerState: WorkerStateUploader;

  constructor(
    private readonly transport: SSETransport,
    sessionUrl: URL,
    private readonly getAuthHeaders: () => Record<string, string>,
  ) {
    this.sessionBaseUrl = `${sessionUrl.protocol}//${sessionUrl.host}${sessionUrl.pathname.replace(/\/$/, "")}`;
    this.workerState = new WorkerStateUploader({
      send: body =>
        this.request("put", "/worker", {
          worker_epoch: this.workerEpoch,
          ...body,
        }).then(result => result.ok),
      baseDelayMs: 500,
      maxDelayMs: 30000,
      jitterMs: 500,
    });

    this.transport.setOnEvent(event => {
      this.reportDelivery(event.event_id, "received");
    });
  }

  async initialize(epoch?: number): Promise<void> {
    if (epoch === undefined) {
      const raw = process.env.MINI_WORKER_EPOCH;
      epoch = raw ? Number.parseInt(raw, 10) : Number.NaN;
    }

    if (!Number.isSafeInteger(epoch)) {
      throw new Error("missing worker epoch");
    }

    this.workerEpoch = epoch;

    const init = await this.request("put", "/worker", {
      worker_epoch: this.workerEpoch,
      worker_status: "idle",
      external_metadata: {
        pending_action: null,
        task_summary: null,
      },
    });

    if (!init.ok) {
      throw new Error("worker init failed");
    }

    this.currentState = "idle";
    this.startHeartbeat();
  }

  reportState(state: string, details?: Record<string, unknown>): void {
    if (state === this.currentState && !details) return;
    this.currentState = state;

    this.workerState.enqueue({
      worker_status: state,
      requires_action_details: details ?? null,
    });
  }

  reportMetadata(metadata: Record<string, unknown>): void {
    this.workerState.enqueue({
      external_metadata: metadata,
    });
  }

  async writeEvent(message: Record<string, unknown>): Promise<void> {
    const payload = {
      ...message,
      uuid: typeof message.uuid === "string" ? message.uuid : randomUUID(),
    };

    const result = await this.request("post", "/worker/events", {
      worker_epoch: this.workerEpoch,
      events: [{ payload }],
    });

    if (!result.ok) {
      throw new Error("failed to write worker event");
    }
  }

  reportDelivery(eventId: string, status: "received" | "processing" | "processed"): void {
    void this.request("post", "/worker/events/delivery", {
      worker_epoch: this.workerEpoch,
      updates: [
        {
          event_id: eventId,
          status,
        },
      ],
    });
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.workerState.close();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    const tick = async () => {
      if (this.closed) return;
      await this.request("post", "/worker/heartbeat", {
        worker_epoch: this.workerEpoch,
      });
      this.heartbeatTimer = setTimeout(tick, 20000);
    };

    this.heartbeatTimer = setTimeout(tick, 20000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async request(method: "post" | "put", path: string, body: unknown): Promise<RequestResult> {
    const headers = {
      ...this.getAuthHeaders(),
      "content-type": "application/json",
    };

    const response = await fetch(`${this.sessionBaseUrl}${path}`, {
      method: method.toUpperCase(),
      headers,
      body: JSON.stringify(body),
    });

    if (response.status === 409) {
      throw new EpochMismatchError();
    }

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      return {
        ok: false,
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      };
    }

    return {
      ok: response.status >= 200 && response.status < 300,
    };
  }
}
```

官方 `CCRClient` 更强：

- stream event 100ms buffer
- text delta 合并成 full-so-far snapshot
- SerialBatchEventUploader
- internal events 持久化
- delivery batch
- expired JWT 判断
- auth failure threshold
- session activity keepalive

Mini 先保留 worker lifecycle 主干。

## 二十三、Bridge 如何使用

启动 worker 的流程是：

```txt
POST /v1/code/sessions/:id/bridge
  <- api_base_url
  <- worker_epoch
  <- worker_jwt

spawn worker with:
  MINI_SESSION_ACCESS_TOKEN=<worker_jwt>
  MINI_WORKER_EPOCH=<worker_epoch>
  MINI_SESSION_URL=<api_base_url>/v1/code/sessions/<id>
```

示例：

```ts
async function getBridgeInfo(baseUrl: string, sessionId: string, apiKey: string) {
  const response = await fetch(`${baseUrl}/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`bridge failed: ${response.status}`);
  }

  return response.json() as Promise<{
    api_base_url: string;
    worker_epoch: number;
    worker_jwt: string;
    expires_in: number;
  }>;
}
```

worker 里：

```ts
const token = process.env.MINI_SESSION_ACCESS_TOKEN;
const epoch = Number.parseInt(process.env.MINI_WORKER_EPOCH ?? "", 10);
const sessionUrl = new URL(process.env.MINI_SESSION_URL ?? "");

const transport = new SSETransport(
  new URL(`${sessionUrl.href}/worker/events/stream`),
  () => ({
    Authorization: `Bearer ${token}`,
  }),
);

const client = new CCRClient(transport, sessionUrl, () => ({
  Authorization: `Bearer ${token}`,
}));

await client.initialize(epoch);
await transport.connect();
```

官方源码里对应关系是：

```txt
bridge/workSecret.ts
  registerWorker()
  buildCCRv2SdkUrl()

remoteIO.ts
  CCRClient + SSETransport

ccrClient.ts
  initialize(epoch)
  PUT /worker
  POST /worker/heartbeat
  POST /worker/events
```

## 二十四、多客户端一致性的核心规则

到这里，Mini 有了很多接口。

但真正重要的是规则。

### 规则 1：Worker 写入必须带 epoch

所有 worker write：

```txt
PUT /worker
POST /worker/heartbeat
POST /worker/events
POST /worker/events/delivery
```

都必须带：

```json
{
  "worker_epoch": 3
}
```

服务端不匹配就返回：

```txt
409 epoch_mismatch
```

旧 worker 收到 409 立即退出。

### 规则 2：Web / Client 写入不带 epoch

用户输入、permission response、interrupt 是 client event。

它们写到 event bus 的 outbound 方向。

不需要 worker_epoch。

### 规则 3：Worker stream 只收 outbound

worker 不应该收到自己写回来的 assistant/result。

否则可能回声。

### 规则 4：Web stream 看完整 session

Web UI 要展示用户输入、assistant 输出、session status。

所以 Web stream 可以看 inbound + outbound。

### 规则 5：重连用 high-water mark

客户端保存：

```txt
lastSequenceNum
```

重连请求：

```txt
from_sequence_num=<lastSequenceNum>
Last-Event-ID: <lastSequenceNum>
```

服务端补发：

```txt
seqNum > lastSequenceNum
```

### 规则 6：状态更新合并

metadata 更新不要排无限队列。

用 coalescing uploader。

最后值获胜。

metadata 内部浅合并。

### 规则 7：token 不放 URL

Authorization header 优先。

WebSocket 用 subprotocol。

不要把 token 放 query string。

## 二十五、手动验证

启动 RCS：

```bash
MINI_RCS_API_KEYS=dev-secret bun run rcs
```

创建 code session：

```bash
curl -s http://localhost:8787/v1/code/sessions \
  -H 'authorization: Bearer dev-secret' \
  -H 'content-type: application/json' \
  -d '{"title":"Epoch demo"}'
```

领取 bridge 信息：

```bash
curl -s -X POST http://localhost:8787/v1/code/sessions/SESSION_ID/bridge \
  -H 'authorization: Bearer dev-secret'
```

用返回的 `worker_jwt` 和 `worker_epoch` 上报 worker state：

```bash
curl -s -X PUT http://localhost:8787/v1/code/sessions/SESSION_ID/worker \
  -H 'authorization: Bearer WORKER_JWT' \
  -H 'content-type: application/json' \
  -d '{"worker_epoch":1,"worker_status":"idle"}'
```

再次领取 bridge 信息，epoch 会变成 2：

```bash
curl -s -X POST http://localhost:8787/v1/code/sessions/SESSION_ID/bridge \
  -H 'authorization: Bearer dev-secret'
```

旧 epoch 再写应该返回 409：

```bash
curl -i -X PUT http://localhost:8787/v1/code/sessions/SESSION_ID/worker \
  -H 'authorization: Bearer WORKER_JWT' \
  -H 'content-type: application/json' \
  -d '{"worker_epoch":1,"worker_status":"running"}'
```

打开 worker stream：

```bash
curl -N http://localhost:8787/v1/code/sessions/SESSION_ID/worker/events/stream \
  -H 'authorization: Bearer WORKER_JWT'
```

发送用户事件：

```bash
curl -s http://localhost:8787/v1/sessions/SESSION_ID/events \
  -H 'authorization: Bearer WORKER_JWT' \
  -H 'content-type: application/json' \
  -d '{"type":"user","content":"hello worker"}'
```

worker stream 应该收到 `client_event`。

写 worker event：

```bash
curl -s http://localhost:8787/v1/code/sessions/SESSION_ID/worker/events \
  -H 'authorization: Bearer WORKER_JWT' \
  -H 'content-type: application/json' \
  -d '{"worker_epoch":2,"events":[{"payload":{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello user"}]}}}]}'
```

检查 Web stream：

```bash
curl -N 'http://localhost:8787/v1/sessions/SESSION_ID/events/stream?from_sequence_num=0' \
  -H 'authorization: Bearer WORKER_JWT'
```

## 二十六、测试清单

建议补这些测试。

### Auth

```txt
validateApiKey accepts configured key
validateApiKey rejects unknown key
worker JWT verifies valid token
worker JWT rejects expired token
worker JWT rejects wrong signing key
sessionIngressAuth rejects JWT for another session
WebSocket subprotocol can carry token
```

运行：

```bash
bun test src/rcs/auth
```

### Epoch

```txt
create session starts workerEpoch at 0
/bridge increments epoch
/worker/register increments epoch
PUT /worker with current epoch succeeds
PUT /worker with stale epoch returns 409
POST /worker/events with stale epoch returns 409
heartbeat with stale epoch returns 409
GET /worker does not require epoch
```

### EventBus

```txt
first event seqNum is 1
seqNum increments monotonically
getEventsSince returns only newer events
closed bus rejects publish
subscriber error does not block other subscribers
event retention does not reset seqNum
```

### SSE

```txt
SSE response has text/event-stream headers
initial keepalive is emitted
from_sequence_num replays missed events
Last-Event-ID replays missed events
worker stream filters inbound events
web stream includes inbound and outbound
abort unsubscribes listener and clears keepalive
```

### Payload

```txt
normalizes direct content
normalizes message.content string
normalizes message.content text blocks
preserves request_id / request / response
permission_response converts to control_response
interrupt converts to control_request
```

### Client

```txt
SSE parser handles LF and CRLF
SSE parser ignores comments but keeps connection alive
SSETransport tracks lastSequenceNum
SSETransport emits payload line for client_event
WorkerStateUploader coalesces top-level keys
WorkerStateUploader merges external_metadata
CCRClient throws on 409
CCRClient sends worker_epoch on writes
```

整体验证：

```bash
bun test src/rcs src/remote-session
bun run typecheck
```

## 常见坑

### 只签 JWT，不校验 session_id

这会让一个 session 的 worker token 写入另一个 session。

必须校验：

```txt
payload.session_id === route session id
```

### 把 token 放 query string

不要。

query string 容易进入日志和代理。

WebSocket 不能发 header 时，用 subprotocol。

### epoch 只生成，不校验

这样 epoch 没有任何并发保护作用。

服务端必须在 worker write 上校验。

### 旧 worker 收到 409 后继续重试

不能继续。

409 不是普通网络失败。

它表示新的 worker 已接管 session。

旧 worker 应该退出。

### Worker stream 投递 inbound

这会让 worker 收到自己写的 assistant event。

只投递 outbound。

### Web stream 不支持 Last-Event-ID

浏览器断线重连会丢消息。

必须支持 `Last-Event-ID`。

### 重连从 0 开始

这会每次重放全量历史。

长 session 会越来越慢。

客户端必须保存 high-water mark。

### metadata 更新排无限队列

状态频繁变化时会内存增长。

用 coalescing uploader。

### archive 不关闭 event bus

归档后仍然写入事件，会让已关闭 session 继续变化。

archive 时关闭 bus，并让后续写入返回 409。

## 和官方能力的差距

本章 Mini 已经接近官方 RCS 控制平面的主体，但仍有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| Auth | API key、Web token、worker JWT | 组织、用户、环境粒度权限 |
| Worker epoch | 服务端校验 + 409 | worker epoch 与环境调度强绑定 |
| SSE resume | seqNum + Last-Event-ID | catch-up truncated、持久化 cursor |
| EventBus | 内存 ring buffer | 数据库存储、跨进程 fanout |
| Delivery | no-op endpoint | received/processing/processed 状态追踪 |
| Worker state | coalesced PUT | automation_state diff、metadata 删除语义 |
| Client transport | 基础 SSE | liveness timeout、重连预算、永久错误分类 |
| Stream events | 普通事件 | text_delta full-so-far 合并、批量上传 |
| Session ownership | UUID 绑定 | 多用户、多组织、分享权限 |
| Archive | close bus | TTL reaper、资源审计 |

下一步如果继续贴近官方，可以补：

1. WebSocket subscribe endpoint，与 SSE 使用同一套 auth。
2. Web UI 的 session list / detail / event stream。
3. Remote session detail dialog 接 RCS。
4. Internal events 持久化，用于 CCR v2 resume。
5. Daemon supervisor 与环境调度。

## 本章小结

本章把 RCS 从开发版事件总线升级成了远程控制平面。

核心链路变成：

```txt
API key
  -> create code session
  -> bridge
  -> worker_epoch++
  -> worker_jwt

worker_jwt + worker_epoch
  -> worker state
  -> heartbeat
  -> worker events
  -> stale epoch 409

EventBus seqNum
  -> Web SSE
  -> Worker SSE
  -> Last-Event-ID resume
```

最重要的不是 JWT 或 SSE 本身。

关键是三个一致性原则：

```txt
身份隔离
  管理 token、Web token、worker token 分开。

写入所有权
  worker 写入必须匹配当前 epoch。

事件顺序
  所有客户端用 seqNum 做断点续传。
```

到这里，Mini 的远程控制系统已经不只是“能远程跑任务”，而是开始具备官方 Claude Code 远程控制平面的基本可靠性。

下一章可以继续补 **WebSocket Subscribe、Remote Detail Dialog 与 Web 控制台**：让 RCS 的事件流真正进入可视化控制界面。
