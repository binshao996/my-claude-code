# 第 53 章：Daemon Supervisor、Work Queue、Capacity 与 Heartbeat 调度

第 52 章补完了 CCR v2 resume：

```txt
internal events
worker state
SSE sequence resume
subagent transcript hydration
worker_epoch
```

这让远程 session 能恢复。

但要接近官方 Claude Code，还差一个长期运行的调度层。

真实远程控制不是“用户点一下，进程跑一下”。

它需要：

```txt
daemon supervisor
  长期运行，崩溃重启 worker

environment registration
  告诉 RCS 这台机器可以接单

work queue
  Web / remote session 创建后进入队列

capacity
  同一台机器最多跑几个 session

heartbeat
  at-capacity 时仍然续租 work item

reconnect
  token 过期、环境重连、worker 丢失后重新派发

cleanup
  session 完成后 stop work、archive、移除 worktree
```

第 50 章和第 52 章解决的是“一个 worker 怎么可靠地和 RCS 通信”。

本章解决的是：

```txt
谁来长期接单？
接单后什么时候 ack？
满载时怎么不丢活？
worker 崩了怎么恢复？
环境断了怎么回收？
```

到本章结束，你的 Mini 会具备：

- daemon supervisor
- supervisor state file
- daemon status / stop
- daemon worker registry
- remoteControl worker
- headless bridge loop
- environment register / deregister / reconnect
- work item create / poll / ack / stop / heartbeat
- long-poll work queue
- capacity-aware poll loop
- at-capacity heartbeat loop
- capacity wake primitive
- token refresh re-dispatch
- existing session token update
- session timeout watchdog
- worktree cleanup hook位
- disconnect monitor
- stale environment 标记
- stale session inactive 标记
- worker rapid crash parking

这章会把远程控制从“一个 session 能跑”升级成“一个本机 daemon 能长期稳定服务多个远程 session”。

## 参考源码

本章参考这些真实模块：

```txt
src/daemon/main.ts
src/daemon/workerRegistry.ts
src/daemon/state.ts

src/bridge/bridgeMain.ts
src/bridge/bridgeApi.ts
src/bridge/types.ts
src/bridge/workSecret.ts
src/bridge/capacityWake.ts
src/bridge/pollConfig.ts
src/bridge/pollConfigDefaults.ts
src/bridge/replBridge.ts
src/bridge/replBridgeTransport.ts

packages/remote-control-server/src/store.ts
packages/remote-control-server/src/services/environment.ts
packages/remote-control-server/src/services/work-dispatch.ts
packages/remote-control-server/src/services/disconnect-monitor.ts
packages/remote-control-server/src/routes/v1/environments.ts
packages/remote-control-server/src/routes/v1/environments.work.ts
packages/remote-control-server/src/routes/v1/sessions.ts
packages/remote-control-server/src/routes/web/sessions.ts
packages/remote-control-server/src/routes/v2/code-sessions.ts
packages/remote-control-server/src/routes/v2/worker.ts
```

源码里有几个关键设计：

1. `daemonMain()` 管理 supervisor 和 background sessions 的统一入口。
2. supervisor 只负责拉起 worker、监听退出、指数退避、快速失败后 parking。
3. `runDaemonWorker("remoteControl")` 运行 headless bridge。
4. `runBridgeHeadless()` 注册 environment，然后进入 `runBridgeLoop()`。
5. RCS environment 表示“可接单机器”，work item 表示“待执行 session”。
6. session 创建时如果带 `environment_id`，RCS 会创建 work item。
7. bridge 长轮询 `/work/poll`，拿到 work 后才 spawn session。
8. bridge 在真正决定处理 work 后才 ack。
9. at capacity 时不接新 session，但仍要 heartbeat 当前 work。
10. 401/403 heartbeat 通常表示 session token 失效，需要 reconnectSession 重新派发。

第 53 章的 Mini 目标是复刻这套主体流程。

## 总体架构

最终链路如下：

```txt
daemon supervisor
  -> spawn remoteControl worker
  -> restart on transient crash
  -> park on permanent crash
  -> write daemon state

remoteControl worker
  -> register environment
  -> optional create initial session
  -> poll work queue
  -> spawn session child
  -> heartbeat active work
  -> stop/archive on done

RCS
  -> environment store
  -> session store
  -> work item store
  -> dispatch work to environment
  -> detect disconnected environments
```

用图表示：

```txt
Web Console / API
  -> POST /sessions { environment_id }
  -> RCS creates session
  -> RCS creates work item

Daemon remoteControl worker
  -> GET /environments/:id/work/poll
  <- work item
  -> ACK after commit to spawn
  -> spawn child Claude Code
  -> heartbeat while running
  -> stop work when child exits
```

本章要守住一个重要边界：

```txt
RCS 负责排队和租约。
daemon supervisor 负责长期进程。
bridge loop 负责容量和本地 child 生命周期。
worker child 负责 CCR v2 协议和真正执行。
```

不要让 RCS 直接控制本机进程。

也不要让 child 进程直接承担 supervisor 职责。

## 最终目录

Mini 中建议新增或扩展：

```txt
src/daemon/state.ts
src/daemon/main.ts
src/daemon/workerRegistry.ts

src/bridge/types.ts
src/bridge/workSecret.ts
src/bridge/bridgeApi.ts
src/bridge/capacityWake.ts
src/bridge/pollConfig.ts
src/bridge/headlessBridge.ts
src/bridge/sessionSpawner.ts

src/rcs/store.ts
src/rcs/environmentService.ts
src/rcs/workDispatch.ts
src/rcs/disconnectMonitor.ts
src/rcs/environmentRoutes.ts
src/rcs/workRoutes.ts
src/rcs/sessionRoutes.ts
```

如果前面章节已有同名文件，继续扩展即可。

## 概念模型

本章有四个核心对象：

```txt
Environment
  一台已注册的本机 daemon/bridge，可接收 work。

Session
  一个远程 Claude Code 会话。

WorkItem
  把某个 session 派给某个 environment 的任务。

DaemonWorker
  本机 supervisor 拉起的长期 worker 进程。
```

关系如下：

```txt
Environment 1 --- N Session
Environment 1 --- N WorkItem
Session     1 --- N WorkItem
Daemon      1 --- N DaemonWorker
```

为什么 session 和 work item 不是一对一？

因为重连时可能重新派发同一个 session：

```txt
session s1
  work w1 -> token expired
  work w2 -> fresh token
```

所以 worker child 不能只记 work id。

它必须以 session id 为主。

## RCS Store

先补服务端数据结构。

新增或扩展：

```txt
src/rcs/store.ts
```

```ts
export type EnvironmentRecord = {
  id: string;
  secret: string;
  machineName: string | null;
  directory: string | null;
  branch: string | null;
  gitRepoUrl: string | null;
  maxSessions: number;
  workerType: string;
  bridgeId: string | null;
  capabilities: Record<string, unknown> | null;
  status: "active" | "disconnected" | "deregistered";
  username: string | null;
  lastPollAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionRecord = {
  id: string;
  environmentId: string | null;
  title: string | null;
  status: "idle" | "running" | "completed" | "failed" | "archived" | "inactive";
  source: string;
  permissionMode: string | null;
  workerEpoch: number;
  username: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkItemRecord = {
  id: string;
  environmentId: string;
  sessionId: string;
  state: "pending" | "dispatched" | "acked" | "completed" | "failed";
  secret: string;
  createdAt: Date;
  updatedAt: Date;
};
```

Store：

```ts
const environments = new Map<string, EnvironmentRecord>();
const sessions = new Map<string, SessionRecord>();
const workItems = new Map<string, WorkItemRecord>();
```

创建 environment：

```ts
import { randomUUID } from "node:crypto";

export function storeCreateEnvironment(input: {
  secret: string;
  machineName?: string;
  directory?: string;
  branch?: string;
  gitRepoUrl?: string | null;
  maxSessions?: number;
  workerType?: string;
  bridgeId?: string;
  username?: string | null;
  capabilities?: Record<string, unknown>;
}) {
  const now = new Date();
  const record: EnvironmentRecord = {
    id: `env_${randomUUID().replace(/-/g, "")}`,
    secret: input.secret,
    machineName: input.machineName ?? null,
    directory: input.directory ?? null,
    branch: input.branch ?? null,
    gitRepoUrl: input.gitRepoUrl ?? null,
    maxSessions: input.maxSessions ?? 1,
    workerType: input.workerType ?? "claude_code",
    bridgeId: input.bridgeId ?? null,
    capabilities: input.capabilities ?? null,
    status: "active",
    username: input.username ?? null,
    lastPollAt: now,
    createdAt: now,
    updatedAt: now,
  };

  environments.set(record.id, record);
  return record;
}
```

创建 work item：

```ts
export function storeCreateWorkItem(input: {
  environmentId: string;
  sessionId: string;
  secret: string;
}) {
  const now = new Date();
  const record: WorkItemRecord = {
    id: `work_${randomUUID().replace(/-/g, "")}`,
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    state: "pending",
    secret: input.secret,
    createdAt: now,
    updatedAt: now,
  };

  workItems.set(record.id, record);
  return record;
}
```

查询 pending work：

```ts
export function storeGetPendingWorkItem(environmentId: string) {
  for (const item of workItems.values()) {
    if (item.environmentId === environmentId && item.state === "pending") {
      return item;
    }
  }

  return undefined;
}
```

更新 work：

```ts
export function storeUpdateWorkItem(id: string, patch: Partial<Pick<WorkItemRecord, "state" | "updatedAt">>) {
  const record = workItems.get(id);

  if (!record) {
    return false;
  }

  Object.assign(record, patch, { updatedAt: new Date() });
  return true;
}
```

这里先用内存 Map。

真实实现要换成数据库或 Redis-like queue。

## Work Secret

Work item 里有一个 `secret`。

它不是给用户看的。

它告诉 daemon worker：

```txt
怎么连接 session
用什么 token
是否使用 CCR v2
API base URL 是什么
```

Mini 版：

```ts
export type WorkSecret = {
  version: 1;
  session_ingress_token: string;
  api_base_url: string;
  sources: Array<{
    type: string;
    git_info?: Record<string, unknown>;
  }>;
  auth: Array<{ type: string; token: string }>;
  claude_code_args?: Record<string, string> | null;
  environment_variables?: Record<string, string> | null;
  use_code_sessions?: boolean;
};
```

编码：

```ts
function encodeWorkSecret(input: WorkSecret) {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

export function decodeWorkSecret(secret: string): WorkSecret {
  const parsed = JSON.parse(Buffer.from(secret, "base64url").toString("utf8")) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid work secret");
  }

  const record = parsed as Record<string, unknown>;

  if (record.version !== 1) {
    throw new Error("unsupported work secret version");
  }

  if (typeof record.session_ingress_token !== "string" || !record.session_ingress_token) {
    throw new Error("missing session ingress token");
  }

  if (typeof record.api_base_url !== "string") {
    throw new Error("missing api base url");
  }

  return record as WorkSecret;
}
```

不要把 secret 打到日志。

如果需要调试，只打印：

```txt
workId
sessionId
secret version
token prefix hash
```

不要打印完整 token。

## Environment Service

新增：

```txt
src/rcs/environmentService.ts
```

```ts
import { storeCreateEnvironment, storeGetEnvironment, storeUpdateEnvironment, storeListActiveEnvironments } from "./store";

export function registerEnvironment(input: {
  machine_name?: string;
  directory?: string;
  branch?: string;
  git_repo_url?: string | null;
  max_sessions?: number;
  worker_type?: string;
  bridge_id?: string;
  capabilities?: Record<string, unknown>;
  username?: string | null;
}) {
  const record = storeCreateEnvironment({
    secret: createEnvironmentSecret(),
    machineName: input.machine_name,
    directory: input.directory,
    branch: input.branch,
    gitRepoUrl: input.git_repo_url,
    maxSessions: input.max_sessions,
    workerType: input.worker_type,
    bridgeId: input.bridge_id,
    capabilities: input.capabilities,
    username: input.username,
  });

  return {
    environment_id: record.id,
    environment_secret: record.secret,
    status: "active" as const,
  };
}

export function deregisterEnvironment(environmentId: string) {
  storeUpdateEnvironment(environmentId, {
    status: "deregistered",
    updatedAt: new Date(),
  });
}

export function reconnectEnvironment(environmentId: string) {
  storeUpdateEnvironment(environmentId, {
    status: "active",
    updatedAt: new Date(),
  });
}

export function updatePollTime(environmentId: string) {
  storeUpdateEnvironment(environmentId, {
    lastPollAt: new Date(),
    updatedAt: new Date(),
  });
}

export function getEnvironment(environmentId: string) {
  return storeGetEnvironment(environmentId);
}

export function listActiveEnvironments() {
  return storeListActiveEnvironments();
}
```

`createEnvironmentSecret()` 在 Mini 可以直接用 API key。

更合理的版本：

```ts
import { randomBytes } from "node:crypto";

function createEnvironmentSecret() {
  return `envsec_${randomBytes(24).toString("base64url")}`;
}
```

正式系统里 environment secret 应该独立于用户 token。

## Environment Routes

新增：

```txt
src/rcs/environmentRoutes.ts
```

```ts
import { Hono } from "hono";
import { apiKeyAuth } from "./auth";
import { deregisterEnvironment, reconnectEnvironment, registerEnvironment } from "./environmentService";
import { reconnectWorkForEnvironment } from "./workDispatch";

export function createEnvironmentRoutes() {
  const app = new Hono();

  app.post("/bridge", apiKeyAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = registerEnvironment({
      machine_name: body.machine_name,
      directory: body.directory,
      branch: body.branch,
      git_repo_url: body.git_repo_url,
      max_sessions: body.max_sessions,
      worker_type: body.worker_type ?? body.metadata?.worker_type,
      bridge_id: body.bridge_id,
      capabilities: body.capabilities,
      username: c.get("username"),
    });

    return c.json(result, 200);
  });

  app.delete("/bridge/:id", apiKeyAuth, async (c) => {
    deregisterEnvironment(c.req.param("id"));
    return c.json({ status: "ok" }, 200);
  });

  app.post("/:id/bridge/reconnect", apiKeyAuth, async (c) => {
    const environmentId = c.req.param("id");
    reconnectEnvironment(environmentId);
    await reconnectWorkForEnvironment(environmentId);
    return c.json({ status: "ok" }, 200);
  });

  return app;
}
```

`bridge/reconnect` 的语义：

```txt
这个 environment 回来了。
把这个 environment 下可恢复的 idle sessions 重新放回 work queue。
```

后面可以按 body 里的 `session_id` 只重派单个 session。

Mini 先重派全部 idle sessions。

## Work Dispatch Service

新增：

```txt
src/rcs/workDispatch.ts
```

创建 work item：

```ts
import { getBaseUrl } from "./config";
import {
  storeCreateWorkItem,
  storeGetEnvironment,
  storeGetPendingWorkItem,
  storeGetWorkItem,
  storeListSessionsByEnvironment,
  storeUpdateWorkItem,
} from "./store";

function encodeWorkSecretForSession(input: { token: string; useCodeSessions?: boolean }) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      session_ingress_token: input.token,
      api_base_url: getBaseUrl(),
      sources: [],
      auth: [],
      use_code_sessions: input.useCodeSessions === true,
    }),
  ).toString("base64url");
}

export async function createWorkItem(environmentId: string, sessionId: string) {
  const environment = storeGetEnvironment(environmentId);

  if (!environment) {
    throw new Error(`Environment ${environmentId} not found`);
  }

  if (environment.status !== "active") {
    throw new Error(`Environment ${environmentId} is not active`);
  }

  const secret = encodeWorkSecretForSession({
    token: environment.secret,
    useCodeSessions: true,
  });

  const record = storeCreateWorkItem({
    environmentId,
    sessionId,
    secret,
  });

  return record.id;
}
```

long poll：

```ts
export async function pollWork(environmentId: string, timeoutSeconds: number) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const item = storeGetPendingWorkItem(environmentId);

    if (item) {
      storeUpdateWorkItem(item.id, { state: "dispatched" });

      return {
        id: item.id,
        type: "work" as const,
        environment_id: environmentId,
        state: "dispatched",
        data: {
          type: "session" as const,
          id: item.sessionId,
        },
        secret: item.secret,
        created_at: item.createdAt.toISOString(),
      };
    }

    await sleep(500);
  }

  return null;
}
```

ack / stop / heartbeat：

```ts
export function ackWork(workId: string) {
  storeUpdateWorkItem(workId, { state: "acked" });
}

export function stopWork(workId: string) {
  storeUpdateWorkItem(workId, { state: "completed" });
}

export function heartbeatWork(workId: string) {
  storeUpdateWorkItem(workId, {});
  const item = storeGetWorkItem(workId);
  const now = new Date();

  return {
    lease_extended: true,
    state: item?.state ?? "acked",
    last_heartbeat: now.toISOString(),
    ttl_seconds: 40,
  };
}
```

重派：

```ts
export async function reconnectWorkForEnvironment(environmentId: string) {
  const sessions = storeListSessionsByEnvironment(environmentId).filter((session) => session.status === "idle");
  const workIds: string[] = [];

  for (const session of sessions) {
    workIds.push(await createWorkItem(environmentId, session.id));
  }

  return workIds;
}
```

真实实现里还要有：

```txt
reclaim stale dispatched work
visibility timeout
per-environment pending dedupe
work item lease
dead-letter queue
```

Mini 先保留状态机。

## Work Routes

新增：

```txt
src/rcs/workRoutes.ts
```

```ts
import { Hono } from "hono";
import { apiKeyAuth } from "./auth";
import { ackWork, heartbeatWork, pollWork, stopWork } from "./workDispatch";
import { updatePollTime } from "./environmentService";

export function createWorkRoutes() {
  const app = new Hono();

  app.get("/:id/work/poll", apiKeyAuth, async (c) => {
    const environmentId = c.req.param("id");
    updatePollTime(environmentId);

    const work = await pollWork(environmentId, 8);

    if (!work) {
      return c.body(null, 204);
    }

    return c.json(work, 200);
  });

  app.post("/:id/work/:workId/ack", apiKeyAuth, async (c) => {
    ackWork(c.req.param("workId"));
    return c.json({ status: "ok" }, 200);
  });

  app.post("/:id/work/:workId/stop", apiKeyAuth, async (c) => {
    stopWork(c.req.param("workId"));
    return c.json({ status: "ok" }, 200);
  });

  app.post("/:id/work/:workId/heartbeat", apiKeyAuth, async (c) => {
    return c.json(heartbeatWork(c.req.param("workId")), 200);
  });

  return app;
}
```

注意 `/work/poll` 空队列返回 `204`。

客户端应该把它当成：

```txt
no work
```

不是错误。

## Session 创建触发 Work

RCS session route 里，当 body 带 `environment_id` 时创建 work item。

```ts
app.post("/sessions", apiKeyAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const session = createSession({
    environment_id: body.environment_id,
    title: body.title,
    permission_mode: body.permission_mode,
    source: body.source ?? "remote-control",
  });

  if (body.environment_id) {
    try {
      await createWorkItem(body.environment_id, session.id);
    } catch (error) {
      logError(`Failed to create work item: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return c.json(session, 200);
});
```

这里有一个刻意设计：

```txt
session 创建成功
work item 创建失败
```

不一定要回滚 session。

因为用户仍然可以看到 session 创建出来了，后续 environment 恢复后可以 reconnect。

但你要把失败状态暴露给 Web UI，否则用户会以为任务正在排队。

Mini 可以先记录日志。

## Disconnect Monitor

RCS 还需要定期扫描断开的 environment 和 stale session。

新增：

```txt
src/rcs/disconnectMonitor.ts
```

```ts
import { storeListActiveEnvironments, storeListSessions, storeUpdateEnvironment } from "./store";
import { updateSessionStatus } from "./sessionService";

export function runDisconnectMonitorSweep(now = Date.now()) {
  const environmentTimeoutMs = 300_000;

  for (const environment of storeListActiveEnvironments()) {
    if (!environment.lastPollAt) {
      continue;
    }

    if (now - environment.lastPollAt.getTime() > environmentTimeoutMs) {
      storeUpdateEnvironment(environment.id, {
        status: "disconnected",
      });
    }
  }

  for (const session of storeListSessions()) {
    if (session.status !== "running" && session.status !== "idle") {
      continue;
    }

    if (now - session.updatedAt.getTime() > environmentTimeoutMs * 2) {
      updateSessionStatus(session.id, "inactive");
    }
  }
}

export function startDisconnectMonitor() {
  const timer = setInterval(() => runDisconnectMonitorSweep(), 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

为什么 session timeout 是 environment timeout 的 2 倍？

因为 environment poll 断了不代表 session 马上死。

可能只是：

```txt
机器睡眠
网络短暂断开
token refresh 正在重派
```

先标 environment disconnected，再延迟标 session inactive，更符合用户预期。

## Capacity Wake

bridge 满载时不能忙轮询。

但如果某个 session 完成，要立刻醒来接新 work。

新增：

```txt
src/bridge/capacityWake.ts
```

```ts
export type CapacityWake = {
  signal: () => { signal: AbortSignal; cleanup: () => void };
  wake: () => void;
};

export function createCapacityWake(outerSignal: AbortSignal): CapacityWake {
  let wakeController = new AbortController();

  function wake() {
    wakeController.abort();
    wakeController = new AbortController();
  }

  function signal() {
    const merged = new AbortController();
    const abort = () => merged.abort();

    if (outerSignal.aborted || wakeController.signal.aborted) {
      merged.abort();
      return {
        signal: merged.signal,
        cleanup() {},
      };
    }

    const currentWakeSignal = wakeController.signal;
    outerSignal.addEventListener("abort", abort, { once: true });
    currentWakeSignal.addEventListener("abort", abort, { once: true });

    return {
      signal: merged.signal,
      cleanup() {
        outerSignal.removeEventListener("abort", abort);
        currentWakeSignal.removeEventListener("abort", abort);
      },
    };
  }

  return { signal, wake };
}
```

用法：

```ts
const capacityWake = createCapacityWake(loopSignal);

// session done
capacityWake.wake();

// at capacity sleep
const cap = capacityWake.signal();
await sleep(heartbeatIntervalMs, cap.signal);
cap.cleanup();
```

这个小工具很关键。

没有它，满载时 sleep 10 分钟，期间一个 session 结束也不会立刻接新任务。

## Poll Config

新增：

```txt
src/bridge/pollConfig.ts
```

```ts
export type PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: number;
  poll_interval_ms_at_capacity: number;
  non_exclusive_heartbeat_interval_ms: number;
  multisession_poll_interval_ms_not_at_capacity: number;
  multisession_poll_interval_ms_partial_capacity: number;
  multisession_poll_interval_ms_at_capacity: number;
  reclaim_older_than_ms: number;
  session_keepalive_interval_v2_ms: number;
};

export const DEFAULT_POLL_CONFIG: PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: 2000,
  poll_interval_ms_at_capacity: 600_000,
  non_exclusive_heartbeat_interval_ms: 0,
  multisession_poll_interval_ms_not_at_capacity: 2000,
  multisession_poll_interval_ms_partial_capacity: 2000,
  multisession_poll_interval_ms_at_capacity: 600_000,
  reclaim_older_than_ms: 5000,
  session_keepalive_interval_v2_ms: 120_000,
};

export function getPollIntervalConfig() {
  return DEFAULT_POLL_CONFIG;
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `not_at_capacity` | 没有满载时快速找活 |
| `partial_capacity` | 有 session 但还没满时继续找活 |
| `at_capacity` | 满载时慢速 poll，作为 liveness |
| `non_exclusive_heartbeat_interval_ms` | 满载时独立 heartbeat |
| `reclaim_older_than_ms` | 请求服务端回收 stale work |
| `session_keepalive_interval_v2_ms` | bridge 空闲时给 ingress 发 keep_alive |

有个安全约束：

```txt
at-capacity 必须至少有一种 liveness：
  heartbeat > 0
  或 at_capacity poll > 0
```

否则满载后可能既不 poll，也不 heartbeat。

## Bridge API Client

新增：

```txt
src/bridge/bridgeApi.ts
```

Mini 需要这些方法：

```ts
export type BridgeApiClient = {
  registerBridgeEnvironment(config: BridgeConfig): Promise<{
    environment_id: string;
    environment_secret: string;
  }>;
  pollForWork(environmentId: string, environmentSecret: string, signal?: AbortSignal, reclaimOlderThanMs?: number): Promise<WorkResponse | null>;
  acknowledgeWork(environmentId: string, workId: string, sessionToken: string): Promise<void>;
  stopWork(environmentId: string, workId: string, force: boolean): Promise<void>;
  heartbeatWork(environmentId: string, workId: string, sessionToken: string): Promise<{ lease_extended: boolean; state: string }>;
  reconnectSession(environmentId: string, sessionId: string): Promise<void>;
  deregisterEnvironment(environmentId: string): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
};
```

注册 environment：

```ts
async function registerBridgeEnvironment(config: BridgeConfig) {
  const response = await fetch(`${baseUrl}/v1/environments/bridge`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      machine_name: config.machineName,
      directory: config.dir,
      branch: config.branch,
      git_repo_url: config.gitRepoUrl,
      max_sessions: config.maxSessions,
      metadata: {
        worker_type: config.workerType,
      },
      bridge_id: config.bridgeId,
    }),
  });

  if (!response.ok) {
    throw new Error(`registration failed: ${response.status}`);
  }

  return response.json();
}
```

Poll：

```ts
async function pollForWork(environmentId: string, environmentSecret: string, signal?: AbortSignal, reclaimOlderThanMs?: number) {
  const url = new URL(`${baseUrl}/v1/environments/${environmentId}/work/poll`);

  if (reclaimOlderThanMs !== undefined) {
    url.searchParams.set("reclaim_older_than_ms", String(reclaimOlderThanMs));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${environmentSecret}`,
    },
    signal,
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`poll failed: ${response.status}`);
  }

  return response.json();
}
```

Ack：

```ts
async function acknowledgeWork(environmentId: string, workId: string, sessionToken: string) {
  const response = await fetch(`${baseUrl}/v1/environments/${environmentId}/work/${workId}/ack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`ack failed: ${response.status}`);
  }
}
```

Stop：

```ts
async function stopWork(environmentId: string, workId: string, force: boolean) {
  const response = await fetch(`${baseUrl}/v1/environments/${environmentId}/work/${workId}/stop`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ force }),
  });

  if (!response.ok) {
    throw new Error(`stop failed: ${response.status}`);
  }
}
```

Heartbeat：

```ts
async function heartbeatWork(environmentId: string, workId: string, sessionToken: string) {
  const response = await fetch(`${baseUrl}/v1/environments/${environmentId}/work/${workId}/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`heartbeat failed: ${response.status}`);
  }

  return response.json();
}
```

这里有一个细节：

```txt
ack / heartbeat 用 session ingress token
stop / deregister / archive 用用户级 token
```

Mini 可以先统一 API key。

但设计上要分清。

## Daemon State

新增：

```txt
src/daemon/state.ts
```

```ts
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DaemonStateData = {
  pid: number;
  cwd: string;
  startedAt: string;
  workerKinds: string[];
  lastStatus: "running" | "stopped" | "error";
};

export function getDaemonStateFilePath(name = "remote-control") {
  return join(getConfigHome(), "daemon", `${name}.json`);
}

export function writeDaemonState(state: DaemonStateData, name = "remote-control") {
  const file = getDaemonStateFilePath(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

export function readDaemonState(name = "remote-control") {
  try {
    return JSON.parse(readFileSync(getDaemonStateFilePath(name), "utf8")) as DaemonStateData;
  } catch {
    return null;
  }
}

export function removeDaemonState(name = "remote-control") {
  try {
    unlinkSync(getDaemonStateFilePath(name));
  } catch {
    // already gone
  }
}
```

PID 探测：

```ts
function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function queryDaemonStatus(name = "remote-control") {
  const state = readDaemonState(name);

  if (!state) {
    return { status: "stopped" as const };
  }

  if (isProcessAlive(state.pid)) {
    return { status: "running" as const, state };
  }

  removeDaemonState(name);
  return { status: "stale" as const };
}
```

停止 daemon：

```ts
export async function stopDaemonByPid(name = "remote-control", timeoutMs = 10_000) {
  const state = readDaemonState(name);

  if (!state) {
    return false;
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    removeDaemonState(name);
    return false;
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) {
      removeDaemonState(name);
      return true;
    }

    await sleep(200);
  }

  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    // already dead
  }

  removeDaemonState(name);
  return true;
}
```

state file 只负责让另一个 CLI 进程能 status / stop。

不要把 session runtime 状态塞进去。

session runtime 状态应该在 RCS 和 background task registry。

## Daemon Supervisor

新增：

```txt
src/daemon/main.ts
```

入口：

```ts
export async function daemonMain(args: string[]) {
  const subcommand = args[0] ?? "status";

  switch (subcommand) {
    case "start":
      await runSupervisor(args.slice(1));
      break;
    case "stop":
      await handleDaemonStop();
      break;
    case "status":
    case "ps":
      await showDaemonStatus();
      break;
    default:
      printDaemonHelp();
  }
}
```

Worker 状态：

```ts
type WorkerState = {
  kind: "remoteControl";
  process: Bun.Subprocess | null;
  backoffMs: number;
  failureCount: number;
  parked: boolean;
  lastStartTime: number;
  restartTimer: Timer | null;
};

const EXIT_CODE_PERMANENT = 78;
const BACKOFF_INITIAL_MS = 2000;
const BACKOFF_CAP_MS = 120_000;
const MAX_RAPID_FAILURES = 5;
```

运行 supervisor：

```ts
async function runSupervisor(args: string[]) {
  const config = parseSupervisorArgs(args);
  const dir = config.dir ?? process.cwd();
  const controller = new AbortController();

  const workers: WorkerState[] = [
    {
      kind: "remoteControl",
      process: null,
      backoffMs: BACKOFF_INITIAL_MS,
      failureCount: 0,
      parked: false,
      lastStartTime: 0,
      restartTimer: null,
    },
  ];

  writeDaemonState({
    pid: process.pid,
    cwd: dir,
    startedAt: new Date().toISOString(),
    workerKinds: workers.map((worker) => worker.kind),
    lastStatus: "running",
  });

  const shutdown = () => {
    controller.abort();
    removeDaemonState();

    for (const worker of workers) {
      if (worker.restartTimer) {
        clearTimeout(worker.restartTimer);
      }

      worker.process?.kill("SIGTERM");
    }
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  for (const worker of workers) {
    spawnWorker(worker, dir, config, controller.signal);
  }

  await waitForAbort(controller.signal);
  await waitForWorkersToExit(workers, 30_000);
}
```

Spawn worker：

```ts
function spawnWorker(worker: WorkerState, dir: string, config: Record<string, string>, signal: AbortSignal) {
  if (signal.aborted || worker.parked) {
    return;
  }

  worker.lastStartTime = Date.now();

  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "src/entrypoints/cli.tsx",
      `--daemon-worker=${worker.kind}`,
    ],
    cwd: dir,
    env: {
      ...process.env,
      DAEMON_WORKER_DIR: dir,
      DAEMON_WORKER_NAME: config.name,
      DAEMON_WORKER_SPAWN_MODE: config.spawnMode ?? "same-dir",
      DAEMON_WORKER_CAPACITY: config.capacity ?? "4",
      DAEMON_WORKER_PERMISSION: config.permissionMode,
      DAEMON_WORKER_SANDBOX: config.sandbox ?? "0",
      DAEMON_WORKER_CREATE_SESSION: "1",
      CLAUDE_CODE_SESSION_KIND: "daemon-worker",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  worker.process = child;

  void pipeWithPrefix(child.stdout, "  ");
  void pipeWithPrefix(child.stderr, "  ");

  child.exited.then((code) => {
    worker.process = null;

    if (signal.aborted) {
      return;
    }

    if (code === EXIT_CODE_PERMANENT) {
      worker.parked = true;
      return;
    }

    const runDuration = Date.now() - worker.lastStartTime;

    if (runDuration < 10_000) {
      worker.failureCount++;

      if (worker.failureCount >= MAX_RAPID_FAILURES) {
        worker.parked = true;
        return;
      }
    } else {
      worker.failureCount = 0;
      worker.backoffMs = BACKOFF_INITIAL_MS;
    }

    worker.restartTimer = setTimeout(() => {
      worker.restartTimer = null;
      spawnWorker(worker, dir, config, signal);
    }, worker.backoffMs);

    worker.backoffMs = Math.min(worker.backoffMs * 2, BACKOFF_CAP_MS);
  });
}
```

为什么 rapid failure 要 parking？

因为有些错误重试无意义：

```txt
未登录
未信任 workspace
worktree 不可用
配置错误
```

如果 supervisor 无限重启，会刷屏、耗电、污染服务端环境。

## Daemon Worker Registry

新增：

```txt
src/daemon/workerRegistry.ts
```

```ts
const EXIT_CODE_PERMANENT = 78;
const EXIT_CODE_TRANSIENT = 1;

export async function runDaemonWorker(kind?: string) {
  if (!kind) {
    process.exitCode = EXIT_CODE_PERMANENT;
    return;
  }

  switch (kind) {
    case "remoteControl":
      await runRemoteControlWorker();
      break;
    default:
      process.exitCode = EXIT_CODE_PERMANENT;
  }
}
```

remoteControl worker：

```ts
async function runRemoteControlWorker() {
  const dir = process.env.DAEMON_WORKER_DIR ?? process.cwd();
  const capacity = Number(process.env.DAEMON_WORKER_CAPACITY ?? 4);
  const spawnMode = process.env.DAEMON_WORKER_SPAWN_MODE === "worktree" ? "worktree" : "same-dir";
  const sandbox = process.env.DAEMON_WORKER_SANDBOX === "1";
  const createSessionOnStart = process.env.DAEMON_WORKER_CREATE_SESSION !== "0";

  const controller = new AbortController();
  const onSignal = () => controller.abort();

  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    await runBridgeHeadless(
      {
        dir,
        name: process.env.DAEMON_WORKER_NAME,
        capacity,
        spawnMode,
        sandbox,
        createSessionOnStart,
        permissionMode: process.env.DAEMON_WORKER_PERMISSION,
        getAccessToken: () => getAccessToken(),
        onAuth401: async () => Boolean(getAccessToken()),
        log: (line) => console.log(`[remoteControl] ${line}`),
      },
      controller.signal,
    );
  } catch (error) {
    if (error instanceof BridgeHeadlessPermanentError) {
      process.exitCode = EXIT_CODE_PERMANENT;
    } else {
      process.exitCode = EXIT_CODE_TRANSIENT;
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
```

worker 不应该自己 fork supervisor。

worker 的职责只是：

```txt
读取 env
运行 headless bridge
把永久/临时错误映射成 exit code
```

## Headless Bridge

新增：

```txt
src/bridge/headlessBridge.ts
```

Headless bridge 的工作：

```txt
1. 校验 workspace trust
2. 校验 auth
3. 校验 worktree mode 可用
4. 注册 environment
5. 可选预创建 session
6. 进入 runBridgeLoop
```

```ts
export type HeadlessBridgeOpts = {
  dir: string;
  name?: string;
  spawnMode: "same-dir" | "worktree";
  capacity: number;
  permissionMode?: string;
  sandbox: boolean;
  sessionTimeoutMs?: number;
  createSessionOnStart: boolean;
  getAccessToken: () => string | undefined;
  onAuth401: (failedToken: string) => Promise<boolean>;
  log: (line: string) => void;
};

export class BridgeHeadlessPermanentError extends Error {}
```

实现：

```ts
export async function runBridgeHeadless(opts: HeadlessBridgeOpts, signal: AbortSignal) {
  process.chdir(opts.dir);

  if (!checkWorkspaceTrusted(opts.dir)) {
    throw new BridgeHeadlessPermanentError(`Workspace not trusted: ${opts.dir}`);
  }

  if (!opts.getAccessToken()) {
    throw new Error("not logged in");
  }

  if (opts.spawnMode === "worktree" && !canCreateWorktree(opts.dir)) {
    throw new BridgeHeadlessPermanentError(`Worktree mode requires a git repository: ${opts.dir}`);
  }

  const baseUrl = getBridgeBaseUrl();
  const bridgeId = crypto.randomUUID();
  const config: BridgeConfig = {
    dir: opts.dir,
    machineName: getMachineName(),
    branch: await getBranch(),
    gitRepoUrl: await getRemoteUrl(),
    maxSessions: opts.capacity,
    spawnMode: opts.spawnMode,
    verbose: false,
    sandbox: opts.sandbox,
    bridgeId,
    workerType: "claude_code",
    environmentId: crypto.randomUUID(),
    apiBaseUrl: baseUrl,
    sessionIngressUrl: baseUrl,
    sessionTimeoutMs: opts.sessionTimeoutMs,
  };

  const api = createBridgeApiClient({
    baseUrl,
    getAccessToken: opts.getAccessToken,
    onAuth401: opts.onAuth401,
  });

  const registration = await api.registerBridgeEnvironment(config);
  const environmentId = registration.environment_id;
  const environmentSecret = registration.environment_secret;

  let initialSessionId: string | undefined;

  if (opts.createSessionOnStart) {
    initialSessionId = await createBridgeSession({
      environmentId,
      title: opts.name,
      permissionMode: opts.permissionMode,
    });
  }

  await runBridgeLoop(config, environmentId, environmentSecret, api, createSessionSpawner(opts), createHeadlessLogger(opts.log), signal, initialSessionId);
}
```

在 Mini 中，很多函数可以是简化版。

但控制流要对。

## Bridge Loop 状态

`runBridgeLoop()` 是本章最重要的函数。

它需要这些状态：

```ts
const activeSessions = new Map<string, SessionHandle>();
const sessionStartTimes = new Map<string, number>();
const sessionWorkIds = new Map<string, string>();
const sessionIngressTokens = new Map<string, string>();
const completedWorkIds = new Set<string>();
const sessionTimers = new Map<string, Timer>();
const timedOutSessions = new Set<string>();
const v2Sessions = new Set<string>();
const pendingCleanups = new Set<Promise<unknown>>();
const capacityWake = createCapacityWake(loopSignal);
```

字段含义：

| 状态 | 用途 |
| --- | --- |
| `activeSessions` | 当前本机正在跑的 child |
| `sessionWorkIds` | session 对应最新 work id |
| `sessionIngressTokens` | heartbeat / ack 用的 session token |
| `completedWorkIds` | 防止 stale work 重复 spawn |
| `sessionTimers` | per-session timeout watchdog |
| `v2Sessions` | token refresh 时选择 reconnectSession |
| `pendingCleanups` | shutdown 前等待 stopWork / worktree cleanup |
| `capacityWake` | session done 时打断 at-capacity sleep |

不要只用一个数组。

调度层需要按 session id 快速更新 token、work id、timer、cleanup。

## Heartbeat Active Work

满载时，如果一直不 poll，work item 租约会过期。

所以 bridge loop 要 heartbeat 当前 active work。

```ts
async function heartbeatActiveWorkItems(): Promise<"ok" | "auth_failed" | "fatal" | "failed"> {
  let anySuccess = false;
  let anyFatal = false;
  const authFailedSessions: string[] = [];

  for (const [sessionId] of activeSessions) {
    const workId = sessionWorkIds.get(sessionId);
    const token = sessionIngressTokens.get(sessionId);

    if (!workId || !token) {
      continue;
    }

    try {
      await api.heartbeatWork(environmentId, workId, token);
      anySuccess = true;
    } catch (error) {
      if (isAuthFailure(error)) {
        authFailedSessions.push(sessionId);
      } else if (isFatalWorkError(error)) {
        anyFatal = true;
      }
    }
  }

  for (const sessionId of authFailedSessions) {
    await api.reconnectSession(environmentId, sessionId).catch(() => {});
  }

  if (anyFatal) {
    return "fatal";
  }

  if (authFailedSessions.length > 0) {
    return "auth_failed";
  }

  return anySuccess ? "ok" : "failed";
}
```

`auth_failed` 时为什么 reconnect？

因为 session ingress token 过期后，旧 work 可能已经 ack。

如果不重新派发，poll 可能永远拿不到新 token。

正确做法是：

```txt
heartbeat 401/403
  -> reconnectSession
  -> server re-queues work
  -> next poll returns fresh secret
  -> existingHandle.updateAccessToken()
```

## Poll Loop 主体

主循环结构：

```ts
while (!loopSignal.aborted) {
  const pollConfig = getPollIntervalConfig();

  try {
    const work = await api.pollForWork(
      environmentId,
      environmentSecret,
      loopSignal,
      pollConfig.reclaim_older_than_ms,
    );

    if (!work) {
      await sleepAccordingToCapacity(pollConfig);
      continue;
    }

    await handleWork(work, pollConfig);
  } catch (error) {
    await handlePollError(error);
  }
}
```

空 poll 后按容量 sleep：

```ts
async function sleepAccordingToCapacity(pollConfig: PollIntervalConfig) {
  const atCapacity = activeSessions.size >= config.maxSessions;

  if (!atCapacity) {
    const interval =
      activeSessions.size > 0
        ? pollConfig.multisession_poll_interval_ms_partial_capacity
        : pollConfig.multisession_poll_interval_ms_not_at_capacity;

    await sleep(interval, loopSignal);
    return;
  }

  const atCapacityPollMs = pollConfig.multisession_poll_interval_ms_at_capacity;

  if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
    const pollDeadline = atCapacityPollMs > 0 ? Date.now() + atCapacityPollMs : null;

    while (
      !loopSignal.aborted &&
      activeSessions.size >= config.maxSessions &&
      (pollDeadline === null || Date.now() < pollDeadline)
    ) {
      const cap = capacityWake.signal();
      const result = await heartbeatActiveWorkItems();

      if (result === "auth_failed" || result === "fatal") {
        cap.cleanup();
        break;
      }

      await sleep(pollConfig.non_exclusive_heartbeat_interval_ms, cap.signal);
      cap.cleanup();
    }

    return;
  }

  if (atCapacityPollMs > 0) {
    const cap = capacityWake.signal();
    await sleep(atCapacityPollMs, cap.signal);
    cap.cleanup();
  }
}
```

这个逻辑有点长，但核心只有一句：

```txt
没满就快 poll，满了就 heartbeat 或慢 poll，并且 capacity 释放时立刻醒。
```

## Ack 时机

处理 work 最容易犯错的是 ack 太早。

错误：

```txt
poll returns work
ack immediately
发现 at capacity
不 spawn
work 永久丢失
```

正确：

```txt
poll returns work
decode secret
如果 existing session -> update token -> ack
如果 at capacity -> 不 ack，稍后重取
如果决定 spawn -> ack
spawn 成功 -> activeSessions.set()
```

Mini handler：

```ts
async function handleSessionWork(work: WorkResponse) {
  const sessionId = work.data.id;

  if (completedWorkIds.has(work.id)) {
    await throttleAfterStaleWork();
    return;
  }

  let secret: WorkSecret;

  try {
    secret = decodeWorkSecret(work.secret);
  } catch {
    completedWorkIds.add(work.id);
    await stopWorkWithRetry(work.id);
    return;
  }

  const existing = activeSessions.get(sessionId);

  if (existing) {
    existing.updateAccessToken(secret.session_ingress_token);
    sessionIngressTokens.set(sessionId, secret.session_ingress_token);
    sessionWorkIds.set(sessionId, work.id);
    await api.acknowledgeWork(environmentId, work.id, secret.session_ingress_token);
    return;
  }

  if (activeSessions.size >= config.maxSessions) {
    return;
  }

  await api.acknowledgeWork(environmentId, work.id, secret.session_ingress_token);
  await spawnSessionForWork(work, secret);
}
```

这里 `at capacity` 分支不 ack。

服务端可以在 reclaim window 后重新投递。

如果你的服务端没有 reclaim，至少不要把 work 标成 completed。

## Spawn Session

spawn 时需要决定 v1 / CCR v2。

```ts
async function spawnSessionForWork(work: WorkResponse, secret: WorkSecret) {
  const sessionId = work.data.id;
  let sdkUrl: string;
  let useCcrV2 = false;
  let workerEpoch: number | undefined;

  if (secret.use_code_sessions === true) {
    sdkUrl = buildCCRv2SdkUrl(config.apiBaseUrl, sessionId);
    workerEpoch = await registerWorker(sdkUrl, secret.session_ingress_token);
    useCcrV2 = true;
  } else {
    sdkUrl = buildSdkUrl(config.sessionIngressUrl, sessionId);
  }

  const sessionDir = await resolveSessionDir(sessionId);
  const handle = spawner.spawn(
    {
      sessionId,
      sdkUrl,
      accessToken: secret.session_ingress_token,
      useCcrV2,
      workerEpoch,
    },
    sessionDir,
  );

  activeSessions.set(sessionId, handle);
  sessionWorkIds.set(sessionId, work.id);
  sessionIngressTokens.set(sessionId, secret.session_ingress_token);
  sessionStartTimes.set(sessionId, Date.now());

  if (useCcrV2) {
    v2Sessions.add(sessionId);
  }

  const timer = setTimeout(() => {
    timedOutSessions.add(sessionId);
    handle.kill();
  }, config.sessionTimeoutMs ?? 24 * 60 * 60 * 1000);

  sessionTimers.set(sessionId, timer);

  void handle.done.then((status) => onSessionDone(sessionId, status, handle));
}
```

SessionSpawner 可以先很简单：

```ts
export type SessionHandle = {
  done: Promise<"completed" | "failed" | "interrupted">;
  kill: () => void;
  updateAccessToken: (token: string) => void;
  currentActivity?: { type: string; summary: string };
};
```

真实源码会把 stdout/stderr、debug file、current activity、worktree 都挂进去。

## Session Done Cleanup

child 退出后必须清理：

```txt
activeSessions
work id map
token map
timeout timer
token refresh timer
worktree
server work item
session archive
capacity wake
```

Mini：

```ts
function onSessionDone(sessionId: string, rawStatus: SessionDoneStatus, handle: SessionHandle) {
  const workId = sessionWorkIds.get(sessionId);

  activeSessions.delete(sessionId);
  sessionWorkIds.delete(sessionId);
  sessionIngressTokens.delete(sessionId);
  sessionStartTimes.delete(sessionId);
  v2Sessions.delete(sessionId);

  const timer = sessionTimers.get(sessionId);

  if (timer) {
    clearTimeout(timer);
    sessionTimers.delete(sessionId);
  }

  capacityWake.wake();

  const wasTimedOut = timedOutSessions.delete(sessionId);
  const status = wasTimedOut && rawStatus === "interrupted" ? "failed" : rawStatus;

  if (status !== "interrupted" && workId) {
    completedWorkIds.add(workId);
    trackCleanup(stopWorkWithRetry(workId));
  }

  if (status !== "interrupted" && config.spawnMode !== "single-session") {
    trackCleanup(api.archiveSession(sessionId).catch(() => {}));
  }

  if (status !== "interrupted" && config.spawnMode === "single-session") {
    controller.abort();
  }
}
```

为什么 interrupted 不一定 stopWork？

因为 interrupted 可能来自：

```txt
server requested interrupt
bridge shutting down
```

这些场景服务端可能已经知道状态。

Mini 可以简化，但要避免重复 stop 导致误报。

## stopWork With Retry

网络抖动时，child 已退出但 stopWork 失败。

要重试几次：

```ts
async function stopWorkWithRetry(workId: string) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await api.stopWork(environmentId, workId, false);
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
```

不要无限重试 stopWork。

如果一直失败，disconnect monitor 和 stale work reclaim 应该兜底。

## Token Refresh 与 Re-dispatch

v2 session 的 token 刷新不是直接把新 OAuth token 塞给 child。

因为 CCR worker endpoint 要的是 session JWT。

所以 v2 做法是：

```txt
timer before token expiry
  -> reconnectSession(environmentId, sessionId)
  -> server creates new work item with fresh session token
  -> poll returns same sessionId
  -> existingHandle.updateAccessToken(fresh token)
```

Mini 可以先不实现 JWT 解析，只做手动定时：

```ts
function scheduleTokenRefresh(sessionId: string, token: string) {
  const delay = readJwtRefreshDelay(token) ?? 55 * 60 * 1000;

  const timer = setTimeout(() => {
    if (v2Sessions.has(sessionId)) {
      void api.reconnectSession(environmentId, sessionId);
      return;
    }

    const handle = activeSessions.get(sessionId);
    const fresh = getAccessToken();

    if (handle && fresh) {
      handle.updateAccessToken(fresh);
    }
  }, delay);

  tokenRefreshTimers.set(sessionId, timer);
}
```

关键不是 timer 算法。

关键是 v2 和 v1 的刷新路径不同。

## Worktree Mode

多 session 同时运行时，同目录模式可能互相踩文件。

所以官方有 worktree mode。

Mini 可以先保留接口：

```ts
async function resolveSessionDir(sessionId: string) {
  if (config.spawnMode !== "worktree") {
    return config.dir;
  }

  const worktree = await createAgentWorktree(`bridge-${safeFilenameId(sessionId)}`);
  sessionWorktrees.set(sessionId, worktree);
  return worktree.worktreePath;
}
```

完成后清理：

```ts
async function cleanupSessionWorktree(sessionId: string) {
  const worktree = sessionWorktrees.get(sessionId);

  if (!worktree) {
    return;
  }

  sessionWorktrees.delete(sessionId);
  await removeAgentWorktree(worktree.worktreePath, worktree.worktreeBranch, worktree.gitRoot);
}
```

如果你还没有 worktree helper，可以先写 no-op。

但调度层要预留这个边界。

## Poll Error Recovery

poll 失败分几类：

```txt
401 / 403
  fatal，auth 或权限问题

404 / 410
  environment expired，fatal 或 reconnect

network / 5xx
  transient，指数退避

sleep wake
  如果两次错误间隔远大于 backoff，重置错误预算
```

Mini：

```ts
let connectionErrorStartedAt: number | null = null;
let connectionBackoffMs = 1000;

async function handlePollError(error: unknown) {
  if (isFatalBridgeError(error)) {
    throw error;
  }

  const now = Date.now();

  if (!connectionErrorStartedAt) {
    connectionErrorStartedAt = now;
  }

  const elapsed = now - connectionErrorStartedAt;

  if (elapsed > 15 * 60 * 1000) {
    throw new Error("server unreachable for too long");
  }

  await sleep(connectionBackoffMs, loopSignal);
  connectionBackoffMs = Math.min(connectionBackoffMs * 2, 60_000);
}
```

恢复成功后重置：

```ts
connectionErrorStartedAt = null;
connectionBackoffMs = 1000;
```

不要在 transient 失败时清空 active sessions。

child 可以继续跑，heartbeat/poll 后续恢复即可。

## Shutdown

bridge loop 退出时：

```txt
kill child sessions
stop active work force=true
archive sessions if needed
wait pending cleanups
deregister environment
```

Mini：

```ts
async function shutdownBridgeLoop() {
  for (const [sessionId, handle] of activeSessions) {
    handle.kill();

    const workId = sessionWorkIds.get(sessionId);

    if (workId) {
      await api.stopWork(environmentId, workId, true).catch(() => {});
    }
  }

  await Promise.allSettled([...pendingCleanups]);
  await api.deregisterEnvironment(environmentId).catch(() => {});
}
```

注意顺序：

```txt
先停止本地 child
再 stopWork
最后 deregister environment
```

如果先 deregister，后续 stopWork 可能找不到 environment。

## Server 入口挂载

RCS server：

```ts
const app = new Hono();

const environmentRoutes = createEnvironmentRoutes();
const workRoutes = createWorkRoutes();

app.route("/v1/environments", environmentRoutes);
app.route("/v1/environments", workRoutes);
app.route("/v1/sessions", createSessionRoutes());
app.route("/v1/code/sessions", createCodeSessionRoutes());
```

启动 disconnect monitor：

```ts
const stopDisconnectMonitor = startDisconnectMonitor();

const server = Bun.serve({
  port: 8787,
  fetch: app.fetch,
});

process.once("SIGTERM", () => {
  stopDisconnectMonitor();
  server.stop(true);
});
```

## CLI 入口

在 CLI entrypoint 中：

```ts
if (args[0] === "daemon") {
  const { daemonMain } = await import("./daemon/main");
  await daemonMain(args.slice(1));
  return;
}

const daemonWorker = args.find((arg) => arg.startsWith("--daemon-worker="));

if (daemonWorker) {
  const kind = daemonWorker.slice("--daemon-worker=".length);
  const { runDaemonWorker } = await import("./daemon/workerRegistry");
  await runDaemonWorker(kind);
  return;
}
```

这两个路径必须在完整 CLI 加载前处理。

daemon worker 应该尽量少加载交互 UI。

## 测试：RCS Work Dispatch

新增：

```txt
src/rcs/__tests__/workDispatch.test.ts
```

测试列表：

```txt
createWorkItem creates pending work for active environment
createWorkItem rejects missing environment
createWorkItem rejects inactive environment
work secret decodes to version 1 payload
pollWork returns null on timeout
pollWork returns pending work and marks dispatched
pollWork does not return work for another environment
ackWork marks acked
stopWork marks completed
heartbeatWork bumps updatedAt and returns lease info
reconnectWorkForEnvironment queues idle sessions
reconnectWorkForEnvironment skips running/completed sessions
```

伪测试：

```ts
test("pollWork returns pending work and marks dispatched", async () => {
  const env = storeCreateEnvironment({ secret: "env-secret" });
  const session = storeCreateSession({ environmentId: env.id });
  const workId = await createWorkItem(env.id, session.id);

  const work = await pollWork(env.id, 1);

  expect(work?.id).toBe(workId);
  expect(work?.data.id).toBe(session.id);
  expect(storeGetWorkItem(workId)?.state).toBe("dispatched");
});
```

## 测试：RCS Routes

新增：

```txt
src/rcs/__tests__/environmentRoutes.test.ts
```

测试列表：

```txt
POST /v1/environments/bridge registers environment
DELETE /v1/environments/bridge/:id deregisters environment
POST /v1/environments/:id/bridge/reconnect marks active and creates work
GET /v1/environments/:id/work/poll returns 204 when no work
GET /v1/environments/:id/work/poll updates lastPollAt
work lifecycle create -> poll -> ack -> heartbeat -> stop
POST /v1/sessions with environment_id creates work item
POST /web/sessions with environment_id creates work item
```

伪测试：

```ts
test("work lifecycle create poll ack stop", async () => {
  const app = createTestApp();
  const environment = await registerTestEnvironment(app);
  const session = await createTestSession(app, { environment_id: environment.environment_id });

  const pollResponse = await app.request(`/v1/environments/${environment.environment_id}/work/poll`, {
    headers: authHeaders,
  });

  expect(pollResponse.status).toBe(200);
  const work = await pollResponse.json();
  expect(work.data.id).toBe(session.id);

  expect(
    await app.request(`/v1/environments/${environment.environment_id}/work/${work.id}/ack`, {
      method: "POST",
      headers: authHeaders,
    }),
  ).toHaveStatus(200);

  expect(
    await app.request(`/v1/environments/${environment.environment_id}/work/${work.id}/stop`, {
      method: "POST",
      headers: authHeaders,
    }),
  ).toHaveStatus(200);
});
```

## 测试：Disconnect Monitor

新增：

```txt
src/rcs/__tests__/disconnectMonitor.test.ts
```

测试列表：

```txt
active environment stays active before timeout
environment becomes disconnected after poll timeout
running session becomes inactive after double timeout
completed session is not changed
archived session is not changed
```

伪测试：

```ts
test("environment becomes disconnected after timeout", () => {
  const env = storeCreateEnvironment({ secret: "s" });
  storeUpdateEnvironment(env.id, {
    lastPollAt: new Date(Date.now() - 301_000),
  });

  runDisconnectMonitorSweep(Date.now());

  expect(storeGetEnvironment(env.id)?.status).toBe("disconnected");
});
```

## 测试：Capacity Wake

新增：

```txt
src/bridge/__tests__/capacityWake.test.ts
```

测试列表：

```txt
signal aborts when outer signal aborts
signal aborts when wake is called
wake creates a fresh controller for next wait
cleanup removes listeners
```

伪测试：

```ts
test("wake aborts current capacity signal only", () => {
  const outer = new AbortController();
  const wake = createCapacityWake(outer.signal);
  const first = wake.signal();

  wake.wake();

  expect(first.signal.aborted).toBe(true);

  const second = wake.signal();
  expect(second.signal.aborted).toBe(false);

  first.cleanup();
  second.cleanup();
});
```

## 测试：Daemon Supervisor

新增：

```txt
src/daemon/__tests__/supervisor.test.ts
```

测试列表：

```txt
writeDaemonState writes status file
queryDaemonStatus returns stopped with no file
queryDaemonStatus removes stale file
stopDaemonByPid returns false when no daemon
supervisor parks worker on permanent exit code
supervisor restarts worker on transient exit
supervisor parks worker after rapid failures
shutdown clears restart timers
```

Supervisor 测试尽量把 spawn 抽象成注入函数。

不要在单元测试里真拉长驻进程。

## 测试：Bridge Loop

新增：

```txt
src/bridge/__tests__/bridgeLoop.test.ts
```

测试列表：

```txt
poll null below capacity sleeps not_at_capacity interval
poll null partial capacity sleeps partial interval
at capacity sends heartbeat
at capacity wake exits sleep when session completes
work is not acked when at capacity
work is acked after deciding to spawn
existing session work updates token and acks
decode secret failure stops work
completed work id is skipped
session done stops work
session done wakes capacity
single-session mode aborts loop after completion
CCR v2 work registers worker before spawn
heartbeat auth failure reconnects session
```

最重要的测试是 ack 时机：

```ts
test("does not ack new work while at capacity", async () => {
  const api = createFakeBridgeApi();
  const spawner = createFakeSpawner();
  const active = createAlreadyActiveSession();

  api.queueWork(createSessionWork("s2"));

  await runBridgeLoopForOneIteration({
    maxSessions: 1,
    activeSessions: [active],
    api,
    spawner,
  });

  expect(api.acknowledgedWorkIds).toEqual([]);
  expect(spawner.spawned).toHaveLength(0);
});
```

如果这个测试失败，生产里就会丢任务。

## 手动验证

启动 RCS：

```bash
MINI_RCS_API_KEYS=dev-secret bun run rcs
```

启动 daemon：

```bash
bun run src/entrypoints/cli.tsx daemon start --dir . --spawn-mode same-dir --capacity 2
```

查看状态：

```bash
bun run src/entrypoints/cli.tsx daemon status
```

注册 environment 后，用 API 创建 session：

```bash
curl -X POST http://localhost:8787/v1/sessions \
  -H "x-api-key: dev-secret" \
  -H "content-type: application/json" \
  -d '{"environment_id":"ENV_ID","title":"daemon smoke"}'
```

手动 poll：

```bash
curl http://localhost:8787/v1/environments/ENV_ID/work/poll \
  -H "x-api-key: dev-secret"
```

heartbeat：

```bash
curl -X POST http://localhost:8787/v1/environments/ENV_ID/work/WORK_ID/heartbeat \
  -H "x-api-key: dev-secret"
```

停止 daemon：

```bash
bun run src/entrypoints/cli.tsx daemon stop
```

检查：

```bash
bun test src/rcs src/bridge src/daemon
bun run typecheck
```

## 常见问题

### work 丢了

先查 ack 时机。

如果在 at capacity 前已经 ack，就会丢。

正确顺序：

```txt
decode secret
existing session token refresh
capacity check
决定 spawn
ack
spawn
```

### 满载后很久不接新任务

检查 capacity wake。

session done 后必须调用：

```ts
capacityWake.wake();
```

否则 at-capacity sleep 会一直睡到 poll deadline。

### token 过期后 session 静默不动

检查 heartbeat auth failure。

401/403 不能只记录日志。

应当：

```txt
reconnectSession(environmentId, sessionId)
```

让服务端重新派发 fresh work secret。

### daemon 一直重启刷屏

检查永久错误是否用了 exit code 78。

典型永久错误：

```txt
workspace 未信任
worktree mode 但不是 git repo
base URL 不安全
未知 daemon worker kind
```

这些应该 parking，而不是无限重启。

### environment 显示 disconnected

检查 `/work/poll` 是否更新 `lastPollAt`。

即使没有 work，也要更新。

因为空 poll 也是 liveness。

### session 一直留在 running

检查 child 退出后是否：

```txt
stopWork
archiveSession
updateSessionStatus
```

至少要做 stopWork。

Web UI 是否隐藏已完成 session，可以单独由 archive 决定。

### stop daemon 后还有 child

检查 shutdown：

```txt
SIGTERM child
wait grace period
SIGKILL child
remove daemon state
```

不要只删除 state file。

## 和官方能力的差距

本章 Mini 已经具备 daemon 调度主体，但仍有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| Work queue | 内存 pending/dispatched | Redis stream、visibility timeout、XAUTOCLAIM |
| Environment auth | API key / secret | OAuth、环境密钥、权限 scope |
| Capacity | bridge 本地控制 | 服务端 capacity 感知、Web picker 禁用 |
| Heartbeat | work item lease | worker lease、session lease、token TTL 联动 |
| Reconnect | 重派 idle sessions | 单 session 精确 reconnect、fresh JWT |
| Daemon supervisor | 单 remoteControl worker | 多 worker kind、AuthManager、配置文件 |
| Crash handling | backoff + parking | crash reason 分类、诊断日志 |
| Worktree | 预留接口 | hook-based worktree、分支管理、清理审计 |
| Disconnect monitor | 定时 sweep | TTL reaper、inactive reason、通知 |
| Poll config | 静态默认值 | 远程动态配置、schema 校验 |

但从目标看，这章已经补上了官方远程控制里最关键的调度骨架：

```txt
长期 daemon
环境注册
work queue
容量控制
心跳续租
重派恢复
子进程监督
```

## 本章小结

本章把远程控制从“session 协议”推进到了“长期调度系统”。

核心链路是：

```txt
daemon supervisor
  -> spawn remoteControl worker
  -> crash backoff
  -> permanent parking

remoteControl worker
  -> register environment
  -> poll work
  -> capacity guard
  -> spawn session child
  -> heartbeat active work
  -> stop/archive cleanup

RCS
  -> environment store
  -> work item queue
  -> session dispatch
  -> reconnect work
  -> disconnect monitor
```

本章最重要的原则：

```txt
ack 只能发生在决定处理 work 之后。
capacity 满载不能丢 work。
heartbeat 失败要触发 reconnect。
session done 必须 wake capacity sleep。
supervisor 只管 worker，不管 session 细节。
```

到这里，Mini 已经具备接近官方 Claude Code 的远程 daemon / work queue / capacity 调度闭环。

下一章可以继续补 **Environment Runner、BYOC 与远程工作区调度**：把 daemon 接单扩展到可配置运行环境、仓库准备、环境变量注入和远程 workspace 生命周期。
