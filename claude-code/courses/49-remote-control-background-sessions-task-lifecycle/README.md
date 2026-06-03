# 第 49 章：远程控制、Background Sessions 与任务生命周期

前一章已经把 Mini 的 session 能力扩展到跨项目、跨 worktree、Teleport Resume 和 session share。

但这还只是“能把远端会话接回来”。

如果目标是接近官方 Claude Code，还需要再往前走一步：

```txt
remote session
  -> live control
  -> background task
  -> progress view
  -> permission bridge
  -> notification
  -> restore after resume
  -> stop / archive
```

官方 Claude Code 里的远程能力不是单个 API。

它更像一个任务生命周期系统。

本章要实现的就是这套系统的 Mini 版本。

到本章结束，你的 Claude Code Mini 会具备：

- 本地后台任务注册表
- 统一 task state
- task output 文件
- 远端 session 实时连接
- 远端权限请求回传到本地确认 UI
- 远端后台任务注册
- 远端任务轮询
- sidecar 持久化
- resume 后恢复远端任务
- kill / archive
- CLI daemon 管理命令
- RCS worker event / state / stream 的最小服务端接口

这章内容会比较工程化。

因为官方能力的差异不在“能不能发一条远端请求”，而在“长期运行时不会丢状态、不会重复通知、不会误杀任务、不会把用户困在一个黑盒里”。

## 参考源码

本章参考当前项目里的这些真实模块：

```txt
src/Task.ts
src/tasks/types.ts
src/utils/task/framework.ts
src/utils/task/diskOutput.ts
src/tasks/RemoteAgentTask/RemoteAgentTask.tsx
src/remote/RemoteSessionManager.ts
src/remote/SessionsWebSocket.ts
src/hooks/useRemoteSession.ts
src/components/tasks/BackgroundTasksDialog.tsx
src/components/tasks/RemoteSessionDetailDialog.tsx
src/cli/bg.ts
src/commands/daemon/daemon.tsx
src/daemon/main.ts
packages/remote-control-server/src/routes/v2/worker.ts
packages/remote-control-server/src/routes/v2/worker-events.ts
packages/remote-control-server/src/routes/v2/worker-events-stream.ts
packages/remote-control-server/src/services/transport.ts
```

这些源码里最关键的设计点有几个：

1. `Task.ts` 定义所有任务共享的 `TaskStateBase`、`TaskStatus`、`TaskHandle`。
2. `utils/task/framework.ts` 提供 `registerTask()` 和 `updateTaskState()`，并把 task 生命周期同步成 SDK system event。
3. `utils/task/diskOutput.ts` 把长输出写到磁盘，避免 AppState 被大日志撑爆。
4. `RemoteAgentTask.tsx` 把一个远端 CCR session 包装成后台任务。
5. `RemoteSessionManager.ts` 把 WebSocket、HTTP POST、权限确认桥接到一起。
6. `SessionsWebSocket.ts` 负责远端事件订阅、重连、ping、control request。
7. `useRemoteSession.ts` 把远端 SDK message 转成本地 REPL 消息，并处理 echo dedupe、权限队列、compaction timeout。
8. `BackgroundTasksDialog.tsx` 把本地 shell、agent、remote agent 等任务合并展示。
9. `daemon/main.ts` 把后台 session 的 CLI 管理命令统一到 `daemon` 命名空间。
10. RCS 的 worker routes 提供远端 worker 状态、事件写入、SSE stream。

## 本章目标

本章不追求完整复制官方所有远程控制能力。

Mini 版本只做必要闭环：

```txt
1. 创建一个远端 session
2. 注册为 remote_agent task
3. 本地可在 background task 列表看到它
4. 轮询远端 session events
5. 把增量输出写入 task output
6. 根据 result / archived / stable idle 判断完成
7. 完成后注入通知
8. resume 后从 sidecar 恢复还在运行的 remote task
9. 用户 stop 时 archive 远端 session
10. CLI daemon 可以 list / logs / attach / kill 本地后台 session
```

为了让这章可跟做，我们会把实现拆成两个层次。

第一层是 CLI 进程内的后台任务系统。

第二层是远程控制和 RCS 接口。

先看最终结构。

## 最终目录

在 Mini 项目里新增这些文件：

```txt
src/tasks/types.ts
src/tasks/ids.ts
src/tasks/output.ts
src/tasks/registry.ts
src/tasks/notifications.ts
src/tasks/backgroundDialog.ts

src/remote-session/types.ts
src/remote-session/websocket.ts
src/remote-session/manager.ts
src/remote-session/runtime.ts

src/remote-tasks/types.ts
src/remote-tasks/metadata.ts
src/remote-tasks/register.ts
src/remote-tasks/poller.ts
src/remote-tasks/restore.ts
src/remote-tasks/kill.ts

src/daemon/bg.ts
src/daemon/main.ts

src/rcs/eventBus.ts
src/rcs/sessions.ts
src/rcs/routes.ts
```

如果你前面章节已经有部分同名能力，可以直接合并。

本章代码偏“骨架 + 可运行逻辑”。

重点是让数据流闭合，而不是把 UI 做得和官方完全一样。

## 先理解官方的数据流

官方远程后台任务大致是这样流动的：

```txt
User command
  -> create remote session
  -> registerRemoteAgentTask()
  -> AppState.tasks[taskId]
  -> task_started system event
  -> start polling remote session events
  -> append task output file
  -> update task state
  -> task_notification
  -> evict output writer
  -> remove sidecar
```

远端实时控制则是另一条链：

```txt
REPL
  -> RemoteSessionManager
  -> SessionsWebSocket subscribe
  -> SDKMessage stream
  -> convert to local message

User input
  -> HTTP send event
  -> remote worker receives input
  -> remote worker echoes SDK user message
  -> local echo dedupe drops duplicate
```

权限请求是一条控制消息链：

```txt
remote worker wants to use tool
  -> control_request can_use_tool
  -> local permission queue
  -> user allow / deny
  -> control_response
  -> remote worker resumes
```

任务停止是一条资源释放链：

```txt
user stop task
  -> local task.status = killed
  -> task terminated SDK event
  -> archiveRemoteSession(sessionId)
  -> evict output writer
  -> remove sidecar
```

这些链路看起来多，但底层只有几个原则：

- task state 放内存
- task output 放磁盘
- task identity 放 sidecar
- live message 走 WebSocket
- user input 走 HTTP POST
- completion 由轮询器判断
- stop 必须释放远端资源

## 第一步：定义 Task 基础类型

先建立所有后台任务共享的类型。

创建 `src/tasks/types.ts`：

```ts
export type TaskType =
  | "local_bash"
  | "local_agent"
  | "remote_agent"
  | "local_workflow"
  | "monitor";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export type TaskStateBase = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  startTime: number;
  endTime?: number;
  toolUseId?: string;
  outputFile: string;
  outputOffset: number;
  notified: boolean;
};

export type TaskContext<AppState> = {
  abortController: AbortController;
  getAppState: () => AppState;
  setAppState: (updater: (prev: AppState) => AppState) => void;
};

export type Task<AppState> = {
  name: string;
  type: TaskType;
  kill(taskId: string, setAppState: (updater: (prev: AppState) => AppState) => void): Promise<void>;
};

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}
```

官方源码里的 `TaskStatus` 也是这几个状态。

这里有一个很重要的约束：

`pending` 和 `running` 是活跃状态。

`completed`、`failed`、`killed` 是终态。

轮询器、UI、通知、GC 都要围绕这个状态机写。

不要把远端 session 的状态直接塞进本地任务状态。

远端可能是：

```txt
idle
running
requires_action
archived
```

本地 task 应该还是自己的状态机：

```txt
pending
running
completed
failed
killed
```

这两个状态机之间由 poller 做映射。

## 第二步：生成 Task ID

创建 `src/tasks/ids.ts`：

```ts
import { randomBytes } from "crypto";
import type { TaskType } from "./types";

const PREFIX: Record<TaskType, string> = {
  local_bash: "b",
  local_agent: "a",
  remote_agent: "r",
  local_workflow: "w",
  monitor: "m",
};

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType): string {
  const bytes = randomBytes(8);
  let id = PREFIX[type] ?? "x";

  for (const byte of bytes) {
    id += ALPHABET[byte % ALPHABET.length];
  }

  return id;
}
```

官方实现用不同前缀区分任务类型。

这样做不是为了美观，而是为了排查问题时一眼知道：

```txt
rxxxxxxx -> remote_agent
bxxxxxxx -> local_bash
axxxxxxx -> local_agent
```

后面 background dialog、日志、通知里都会出现 task id。

## 第三步：建立磁盘输出层

后台任务不能把全部输出放在 React state 里。

一个远端任务跑半小时，输出可能非常大。

如果每次增量都塞进 AppState：

- UI 会频繁重渲染
- 内存会持续增长
- resume 后无法定位增量
- 任务完成后也不好释放

官方做法是把输出写进 task output 文件。

Mini 版先做一个简单实现。

创建 `src/tasks/output.ts`：

```ts
import { mkdir, open, readFile, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";

const MAX_READ_BYTES = 128 * 1024;

export function getTaskOutputPath(taskId: string): string {
  return join(process.cwd(), ".mini", "task-output", `${taskId}.log`);
}

export async function initTaskOutput(taskId: string): Promise<string> {
  const outputPath = getTaskOutputPath(taskId);
  await mkdir(dirname(outputPath), { recursive: true });

  const file = await open(outputPath, "wx").catch(async error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await writeFile(outputPath, "");
      return open(outputPath, "r+");
    }
    throw error;
  });

  await file.close();
  return outputPath;
}

export async function appendTaskOutput(taskId: string, content: string): Promise<void> {
  const outputPath = getTaskOutputPath(taskId);
  await mkdir(dirname(outputPath), { recursive: true });
  const file = await open(outputPath, "a");
  try {
    await file.write(content);
  } finally {
    await file.close();
  }
}

export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes = MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }> {
  const outputPath = getTaskOutputPath(taskId);
  const fileStat = await stat(outputPath).catch(() => null);

  if (!fileStat || fileStat.size <= fromOffset) {
    return { content: "", newOffset: fromOffset };
  }

  const raw = await readFile(outputPath);
  const end = Math.min(fileStat.size, fromOffset + maxBytes);
  const slice = raw.subarray(fromOffset, end);

  return {
    content: slice.toString("utf8"),
    newOffset: end,
  };
}

export async function getTaskOutputTail(taskId: string, maxBytes = MAX_READ_BYTES): Promise<string> {
  const outputPath = getTaskOutputPath(taskId);
  const raw = await readFile(outputPath).catch(() => null);
  if (!raw) return "";

  if (raw.length <= maxBytes) {
    return raw.toString("utf8");
  }

  const omitted = raw.length - maxBytes;
  return `[${Math.round(omitted / 1024)}KB of earlier output omitted]\n${raw.subarray(raw.length - maxBytes).toString("utf8")}`;
}

export async function evictTaskOutput(taskId: string): Promise<void> {
  const outputPath = getTaskOutputPath(taskId);
  await unlink(outputPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}
```

官方实现更严谨：

- 用输出 writer map 避免频繁打开文件
- 用 `O_NOFOLLOW` 防御软链攻击
- 支持异步写队列 flush
- 支持读取 range
- 完成后只 evict writer，不一定删除文件

Mini 版先保留核心思想：

```txt
task state: 小而热
task output: 大而冷
```

这条边界很关键。

## 第四步：建立 Task Registry

创建 `src/tasks/registry.ts`：

```ts
import type { TaskStateBase } from "./types";

export type AppStateWithTasks = {
  tasks: Record<string, TaskStateBase>;
  messages: Array<{ type: string; content: string }>;
};

export type SetAppState<T extends AppStateWithTasks> = (updater: (prev: T) => T) => void;

export function registerTask<T extends AppStateWithTasks>(task: TaskStateBase, setAppState: SetAppState<T>): void {
  setAppState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      [task.id]: task,
    },
    messages: [
      ...prev.messages,
      {
        type: "system",
        content: `<task_started task_id="${task.id}" task_type="${task.type}">${task.description}</task_started>`,
      },
    ],
  }));
}

export function updateTaskState<TTask extends TaskStateBase, TAppState extends AppStateWithTasks>(
  taskId: string,
  setAppState: SetAppState<TAppState>,
  updater: (task: TTask) => TTask,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId] as TTask | undefined;
    if (!task) return prev;

    const nextTask = updater(task);
    if (nextTask === task) return prev;

    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: nextTask,
      },
    };
  });
}

export function removeTask<T extends AppStateWithTasks>(taskId: string, setAppState: SetAppState<T>): void {
  setAppState(prev => {
    if (!prev.tasks[taskId]) return prev;
    const { [taskId]: _removed, ...rest } = prev.tasks;
    return {
      ...prev,
      tasks: rest,
    };
  });
}
```

官方 `registerTask()` 还有一个重要行为：

注册任务时会发出 SDK system event：

```txt
system / task_started
```

远端 viewer 会根据这个事件更新“远端后台任务数量”。

Mini 版先用普通 system message 表示。

后续如果你已经实现了 SDK event queue，可以把它替换为：

```ts
enqueueSdkEvent({
  type: "system",
  subtype: "task_started",
  task_id: task.id,
  task_type: task.type,
  description: task.description,
});
```

## 第五步：任务通知

任务完成时，不应该只改状态。

本地 agent loop 需要知道：

```txt
后台任务完成了
输出在哪里
最终状态是什么
```

创建 `src/tasks/notifications.ts`：

```ts
import type { TaskStatus, TaskType } from "./types";

export type TaskNotification = {
  taskId: string;
  taskType: TaskType;
  status: Extract<TaskStatus, "completed" | "failed" | "killed">;
  summary: string;
  outputFile?: string;
  toolUseId?: string;
};

export function formatTaskNotification(notification: TaskNotification): string {
  const lines = [
    `<task_notification>`,
    `  <task_id>${notification.taskId}</task_id>`,
    `  <task_type>${notification.taskType}</task_type>`,
    `  <status>${notification.status}</status>`,
    `  <summary>${notification.summary}</summary>`,
  ];

  if (notification.outputFile) {
    lines.push(`  <output_file>${notification.outputFile}</output_file>`);
  }

  if (notification.toolUseId) {
    lines.push(`  <tool_use_id>${notification.toolUseId}</tool_use_id>`);
  }

  lines.push(`</task_notification>`);
  return lines.join("\n");
}
```

官方实现里，任务通知是写进 message queue 的。

它不只是 UI 提示。

它会成为下一轮模型可见的上下文。

这很重要。

比如远端 bug hunt 完成后，官方实现会把 review 结果注入本地主会话，让本地主模型可以继续处理。

## 第六步：定义 Remote Session 协议类型

远程控制有两类消息：

1. SDK message：对话、工具调用、结果、系统状态
2. control message：权限请求、中断、取消权限请求

创建 `src/remote-session/types.ts`：

```ts
export type SDKTextBlock = {
  type: "text";
  text: string;
};

export type SDKToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type SDKToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

export type SDKMessage =
  | {
      type: "user";
      uuid?: string;
      message: {
        role: "user";
        content: string | Array<SDKTextBlock | SDKToolResultBlock>;
      };
    }
  | {
      type: "assistant";
      message: {
        role: "assistant";
        content: Array<SDKTextBlock | SDKToolUseBlock>;
      };
    }
  | {
      type: "system";
      subtype: string;
      [key: string]: unknown;
    }
  | {
      type: "result";
      subtype: "success" | "error";
      [key: string]: unknown;
    };

export type ControlPermissionRequest = {
  subtype: "can_use_tool";
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  description?: string;
  permission_suggestions?: unknown[];
};

export type ControlRequest =
  | {
      type: "control_request";
      request_id: string;
      request: ControlPermissionRequest | { subtype: string; [key: string]: unknown };
    };

export type ControlResponse = {
  type: "control_response";
  response:
    | {
        subtype: "success";
        request_id: string;
        response: {
          behavior: "allow";
          updatedInput: Record<string, unknown>;
        } | {
          behavior: "deny";
          message: string;
        };
      }
    | {
        subtype: "error";
        request_id: string;
        error: string;
      };
};

export type ControlCancelRequest = {
  type: "control_cancel_request";
  request_id: string;
  tool_use_id?: string;
};

export type SessionsMessage = SDKMessage | ControlRequest | ControlResponse | ControlCancelRequest;
```

这套类型刻意保守。

真实 SDK message 很多。

Mini 不要一开始就把全部协议建全。

先保证下面这些可以跑通：

- assistant text
- assistant tool_use
- user tool_result
- result success / error
- system status
- system task_started
- system task_notification
- control can_use_tool
- control interrupt

## 第七步：实现 WebSocket 订阅

创建 `src/remote-session/websocket.ts`：

```ts
import { randomUUID } from "crypto";
import type { ControlRequest, ControlResponse, SessionsMessage } from "./types";

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;
const PING_INTERVAL_MS = 30000;

type State = "connecting" | "connected" | "closed";

export type SessionsWebSocketCallbacks = {
  onMessage: (message: SessionsMessage) => void;
  onConnected?: () => void;
  onClose?: () => void;
  onReconnecting?: () => void;
  onError?: (error: Error) => void;
};

function isSessionsMessage(value: unknown): value is SessionsMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export class SessionsWebSocket {
  private ws: WebSocket | null = null;
  private state: State = "closed";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly getAccessToken: () => string,
    private readonly callbacks: SessionsWebSocketCallbacks,
  ) {}

  connect(): void {
    if (this.state === "connecting") return;

    this.state = "connecting";
    const token = this.getAccessToken();
    const ws = new WebSocket(this.url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    } as unknown as string[]);

    this.ws = ws;

    ws.addEventListener("open", () => {
      this.state = "connected";
      this.reconnectAttempts = 0;
      this.startPing();
      this.callbacks.onConnected?.();
    });

    ws.addEventListener("message", event => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      this.handleMessage(raw);
    });

    ws.addEventListener("error", () => {
      this.callbacks.onError?.(new Error("Remote session WebSocket error"));
    });

    ws.addEventListener("close", event => {
      this.handleClose(event.code);
    });
  }

  sendControlResponse(response: ControlResponse): void {
    if (!this.ws || this.state !== "connected") return;
    this.ws.send(JSON.stringify(response));
  }

  sendControlRequest(request: ControlRequest["request"]): void {
    if (!this.ws || this.state !== "connected") return;

    this.ws.send(
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request,
      }),
    );
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  reconnect(): void {
    this.reconnectAttempts = 0;
    this.close();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 500);
  }

  close(): void {
    this.state = "closed";
    this.stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.ws?.close();
    this.ws = null;
  }

  private handleMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isSessionsMessage(parsed)) {
        this.callbacks.onMessage(parsed);
      }
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleClose(closeCode: number): void {
    this.stopPing();
    if (this.state === "closed") return;

    const previousState = this.state;
    this.state = "closed";
    this.ws = null;

    if (closeCode === 4003) {
      this.callbacks.onClose?.();
      return;
    }

    if (previousState === "connected" && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      this.callbacks.onReconnecting?.();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, RECONNECT_DELAY_MS);
      return;
    }

    this.callbacks.onClose?.();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.state === "connected") {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
```

这里有三个真实工程里的关键点。

第一，重连不是无限重连。

无限重连会在 auth 错误、session 不存在、服务端拒绝时制造噪音。

第二，关闭后要清理 timer。

否则用户退出 REPL 后，后台 timer 仍然可能把 WebSocket 拉起来。

第三，WebSocket 只负责 transport。

它不应该知道 permission UI、REPL message、task state。

那些应该放在 manager / runtime 层。

## 第八步：实现 RemoteSessionManager

创建 `src/remote-session/manager.ts`：

```ts
import type {
  ControlCancelRequest,
  ControlPermissionRequest,
  ControlRequest,
  ControlResponse,
  SDKMessage,
  SessionsMessage,
} from "./types";
import { SessionsWebSocket } from "./websocket";

export type RemotePermissionResponse =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
    }
  | {
      behavior: "deny";
      message: string;
    };

export type RemoteSessionConfig = {
  sessionId: string;
  websocketUrl: string;
  sendEventUrl: string;
  getAccessToken: () => string;
  viewerOnly?: boolean;
};

export type RemoteSessionCallbacks = {
  onMessage: (message: SDKMessage) => void;
  onPermissionRequest: (request: ControlPermissionRequest, requestId: string) => void;
  onPermissionCancelled?: (requestId: string, toolUseId?: string) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onReconnecting?: () => void;
  onError?: (error: Error) => void;
};

function isSDKMessage(message: SessionsMessage): message is SDKMessage {
  return (
    message.type !== "control_request" &&
    message.type !== "control_response" &&
    message.type !== "control_cancel_request"
  );
}

export class RemoteSessionManager {
  private websocket: SessionsWebSocket | null = null;
  private pendingPermissions = new Map<string, ControlPermissionRequest>();

  constructor(
    private readonly config: RemoteSessionConfig,
    private readonly callbacks: RemoteSessionCallbacks,
  ) {}

  connect(): void {
    this.websocket = new SessionsWebSocket(this.config.websocketUrl, this.config.getAccessToken, {
      onMessage: message => this.handleMessage(message),
      onConnected: () => this.callbacks.onConnected?.(),
      onClose: () => this.callbacks.onDisconnected?.(),
      onReconnecting: () => this.callbacks.onReconnecting?.(),
      onError: error => this.callbacks.onError?.(error),
    });

    this.websocket.connect();
  }

  async sendMessage(content: unknown, opts?: { uuid?: string }): Promise<boolean> {
    const response = await fetch(this.config.sendEventUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.getAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: this.config.sessionId,
        uuid: opts?.uuid,
        content,
      }),
    });

    return response.ok;
  }

  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;

    this.pendingPermissions.delete(requestId);

    const response: ControlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response:
          result.behavior === "allow"
            ? {
                behavior: "allow",
                updatedInput: result.updatedInput,
              }
            : {
                behavior: "deny",
                message: result.message,
              },
      },
    };

    this.websocket?.sendControlResponse(response);
  }

  cancelSession(): void {
    if (this.config.viewerOnly) return;
    this.websocket?.sendControlRequest({ subtype: "interrupt" });
  }

  reconnect(): void {
    this.websocket?.reconnect();
  }

  disconnect(): void {
    this.websocket?.close();
    this.websocket = null;
    this.pendingPermissions.clear();
  }

  private handleMessage(message: SessionsMessage): void {
    if (message.type === "control_request") {
      this.handleControlRequest(message);
      return;
    }

    if (message.type === "control_cancel_request") {
      const cancel = message as ControlCancelRequest;
      const pending = this.pendingPermissions.get(cancel.request_id);
      this.pendingPermissions.delete(cancel.request_id);
      this.callbacks.onPermissionCancelled?.(cancel.request_id, pending?.tool_use_id ?? cancel.tool_use_id);
      return;
    }

    if (message.type === "control_response") {
      return;
    }

    if (isSDKMessage(message)) {
      this.callbacks.onMessage(message);
    }
  }

  private handleControlRequest(message: ControlRequest): void {
    const requestId = message.request_id;
    const inner = message.request;

    if (inner.subtype === "can_use_tool") {
      const permissionRequest = inner as ControlPermissionRequest;
      this.pendingPermissions.set(requestId, permissionRequest);
      this.callbacks.onPermissionRequest(permissionRequest, requestId);
      return;
    }

    this.websocket?.sendControlResponse({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: `Unsupported control request subtype: ${inner.subtype}`,
      },
    });
  }
}
```

这层是本章最核心的 remote control。

它做了四件事：

1. 连接 WebSocket
2. 用 HTTP POST 发送用户输入
3. 把远端权限请求转成本地回调
4. 把本地 allow / deny 转回 control response

注意 `viewerOnly`。

官方实现里，viewer-only 会禁止本地 Ctrl+C 中断远端 agent。

原因很简单：

有些 attach 场景只是查看会话，不应该拥有控制权。

Mini 可以先支持这个字段。

## 第九步：实现远端 REPL Runtime

如果你已经有 React/Ink REPL，可以把这一层做成 hook。

为了更容易跟做，本章先写一个普通 runtime。

创建 `src/remote-session/runtime.ts`：

```ts
import { randomUUID } from "crypto";
import { RemoteSessionManager, type RemoteSessionConfig, type RemotePermissionResponse } from "./manager";
import type { ControlPermissionRequest, SDKMessage } from "./types";

const RESPONSE_TIMEOUT_MS = 60000;
const COMPACTION_TIMEOUT_MS = 180000;

class BoundedUuidSet {
  private readonly set = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly limit: number) {}

  add(uuid: string): void {
    if (this.set.has(uuid)) return;
    this.set.add(uuid);
    this.order.push(uuid);
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest) this.set.delete(oldest);
    }
  }

  has(uuid: string): boolean {
    return this.set.has(uuid);
  }
}

export type RemoteRuntimeCallbacks = {
  onMessage: (message: SDKMessage) => void;
  onPermissionRequest: (
    request: ControlPermissionRequest,
    handlers: {
      allow: (updatedInput: Record<string, unknown>) => void;
      deny: (message: string) => void;
      abort: () => void;
    },
  ) => void;
  onConnectionStatus?: (status: "connected" | "reconnecting" | "disconnected") => void;
  onWarning?: (message: string) => void;
  onRemoteTaskCount?: (count: number) => void;
};

export class RemoteSessionRuntime {
  private manager: RemoteSessionManager;
  private sentUUIDs = new BoundedUuidSet(50);
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private isCompacting = false;
  private runningRemoteTaskIds = new Set<string>();

  constructor(
    config: RemoteSessionConfig,
    private readonly callbacks: RemoteRuntimeCallbacks,
  ) {
    this.manager = new RemoteSessionManager(config, {
      onMessage: message => this.handleSDKMessage(message),
      onPermissionRequest: (request, requestId) => this.handlePermissionRequest(request, requestId),
      onPermissionCancelled: requestId => {
        this.callbacks.onWarning?.(`Remote permission request cancelled: ${requestId}`);
      },
      onConnected: () => this.callbacks.onConnectionStatus?.("connected"),
      onReconnecting: () => {
        this.runningRemoteTaskIds.clear();
        this.callbacks.onRemoteTaskCount?.(0);
        this.callbacks.onConnectionStatus?.("reconnecting");
      },
      onDisconnected: () => {
        this.runningRemoteTaskIds.clear();
        this.callbacks.onRemoteTaskCount?.(0);
        this.callbacks.onConnectionStatus?.("disconnected");
      },
      onError: error => this.callbacks.onWarning?.(error.message),
    });
  }

  connect(): void {
    this.manager.connect();
  }

  async sendUserText(text: string): Promise<boolean> {
    const uuid = randomUUID();
    this.sentUUIDs.add(uuid);
    this.startResponseTimeout();

    return this.manager.sendMessage(
      {
        type: "user",
        message: {
          role: "user",
          content: text,
        },
      },
      { uuid },
    );
  }

  cancel(): void {
    this.clearResponseTimeout();
    this.manager.cancelSession();
  }

  disconnect(): void {
    this.clearResponseTimeout();
    this.manager.disconnect();
  }

  private handleSDKMessage(message: SDKMessage): void {
    this.clearResponseTimeout();

    if (message.type === "user" && message.uuid && this.sentUUIDs.has(message.uuid)) {
      return;
    }

    if (message.type === "system") {
      if (message.subtype === "task_started" && typeof message.task_id === "string") {
        this.runningRemoteTaskIds.add(message.task_id);
        this.callbacks.onRemoteTaskCount?.(this.runningRemoteTaskIds.size);
        return;
      }

      if (message.subtype === "task_notification" && typeof message.task_id === "string") {
        this.runningRemoteTaskIds.delete(message.task_id);
        this.callbacks.onRemoteTaskCount?.(this.runningRemoteTaskIds.size);
        return;
      }

      if (message.subtype === "status") {
        this.isCompacting = message.status === "compacting";
      }

      if (message.subtype === "compact_boundary") {
        this.isCompacting = false;
      }
    }

    this.callbacks.onMessage(message);
  }

  private handlePermissionRequest(request: ControlPermissionRequest, requestId: string): void {
    this.clearResponseTimeout();

    this.callbacks.onPermissionRequest(request, {
      allow: updatedInput => {
        const response: RemotePermissionResponse = {
          behavior: "allow",
          updatedInput,
        };
        this.manager.respondToPermissionRequest(requestId, response);
        this.startResponseTimeout();
      },
      deny: message => {
        this.manager.respondToPermissionRequest(requestId, {
          behavior: "deny",
          message,
        });
      },
      abort: () => {
        this.manager.respondToPermissionRequest(requestId, {
          behavior: "deny",
          message: "User aborted",
        });
      },
    });
  }

  private startResponseTimeout(): void {
    this.clearResponseTimeout();

    const timeoutMs = this.isCompacting ? COMPACTION_TIMEOUT_MS : RESPONSE_TIMEOUT_MS;
    this.responseTimer = setTimeout(() => {
      this.callbacks.onWarning?.("Remote session may be unresponsive. Attempting to reconnect.");
      this.manager.reconnect();
    }, timeoutMs);
  }

  private clearResponseTimeout(): void {
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
  }
}
```

这个 runtime 还原了官方 `useRemoteSession.ts` 的几个关键点：

- 本地发出的 user message 会通过 WebSocket echo 回来，必须按 uuid 去重。
- compaction 期间响应时间更长，不能用普通 60 秒误判断连。
- 远端 subagent 的 `task_started` / `task_notification` 是状态信号，不应该渲染成普通对话。
- WebSocket 断开重连时，远端后台任务计数宁愿清零，也不要一直虚高。

如果没有 echo dedupe，你会看到每条用户输入重复出现。

如果没有 compaction timeout，远端压缩上下文时很容易被误判为卡死。

## 第十步：定义 Remote Task 类型

创建 `src/remote-tasks/types.ts`：

```ts
import type { SDKMessage } from "../remote-session/types";
import type { TaskStateBase } from "../tasks/types";

export type RemoteTaskType =
  | "remote-agent"
  | "remote-review"
  | "background-pr"
  | "autofix-pr"
  | "ultraplan";

export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

export type RemoteTaskMetadata = {
  repository?: string;
  branch?: string;
  pullRequestUrl?: string;
  [key: string]: unknown;
};

export type RemoteAgentTaskState = TaskStateBase & {
  type: "remote_agent";
  remoteTaskType: RemoteTaskType;
  sessionId: string;
  command: string;
  title: string;
  todoList: TodoItem[];
  log: SDKMessage[];
  pollStartedAt: number;
  isRemoteReview?: boolean;
  isLongRunning?: boolean;
  isUltraplan?: boolean;
  remoteTaskMetadata?: RemoteTaskMetadata;
};

export type PollRemoteSessionResponse = {
  newEvents: SDKMessage[];
  lastEventId: string | null;
  sessionStatus?: "idle" | "running" | "requires_action" | "archived";
  branch?: string;
};
```

`remoteTaskType` 和 `type` 不一样。

`type` 是统一任务框架里的类型：

```txt
remote_agent
```

`remoteTaskType` 是业务场景：

```txt
remote-agent
remote-review
background-pr
autofix-pr
ultraplan
```

为什么要拆开？

因为它们共用一套后台任务 UI、kill、output、sidecar，但是 completion 规则不同。

比如：

- 普通 remote-agent 可以看 `result success`
- long-running monitor 不能看到一次 result 就结束
- ultraplan 的完成由 plan scanner 决定
- remote-review 可能需要解析特定 review tag

## 第十一步：实现 sidecar metadata

远端任务必须能在本地 `resume` 后恢复。

内存里的 AppState 没了，但远端 session 可能还在跑。

所以注册任务时要写 sidecar。

创建 `src/remote-tasks/metadata.ts`：

```ts
import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import type { RemoteTaskMetadata, RemoteTaskType } from "./types";

export type PersistedRemoteTask = {
  taskId: string;
  remoteTaskType: RemoteTaskType;
  sessionId: string;
  title: string;
  command: string;
  spawnedAt: number;
  toolUseId?: string;
  isRemoteReview?: boolean;
  isLongRunning?: boolean;
  isUltraplan?: boolean;
  remoteTaskMetadata?: RemoteTaskMetadata;
};

function metadataDir(sessionId: string): string {
  return join(process.cwd(), ".mini", "sessions", sessionId, "remote-agents");
}

export async function persistRemoteTaskMetadata(localSessionId: string, task: PersistedRemoteTask): Promise<void> {
  const dir = metadataDir(localSessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${task.taskId}.json`), JSON.stringify(task, null, 2));
}

export async function listRemoteTaskMetadata(localSessionId: string): Promise<PersistedRemoteTask[]> {
  const dir = metadataDir(localSessionId);
  const files = await readdir(dir).catch(() => []);
  const result: PersistedRemoteTask[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(join(dir, file), "utf8").catch(() => null);
    if (!raw) continue;

    try {
      result.push(JSON.parse(raw) as PersistedRemoteTask);
    } catch {
      // ignore corrupt sidecar
    }
  }

  return result;
}

export async function removeRemoteTaskMetadata(localSessionId: string, taskId: string): Promise<void> {
  await unlink(join(metadataDir(localSessionId), `${taskId}.json`)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}
```

这里的 `localSessionId` 是本地主会话 id。

一个本地主会话下可以挂多个远端任务。

sidecar 目录类似：

```txt
.mini/
  sessions/
    local-session-001/
      remote-agents/
        rabc123.json
        rdef456.json
```

不要只把 sidecar 放在项目根目录。

否则不同主会话之间会互相污染。

## 第十二步：注册 Remote Agent Task

创建 `src/remote-tasks/register.ts`：

```ts
import { generateTaskId } from "../tasks/ids";
import { initTaskOutput, getTaskOutputPath } from "../tasks/output";
import { registerTask, type AppStateWithTasks, type SetAppState } from "../tasks/registry";
import type { TaskContext } from "../tasks/types";
import { persistRemoteTaskMetadata } from "./metadata";
import { startRemoteTaskPolling } from "./poller";
import type { RemoteAgentTaskState, RemoteTaskMetadata, RemoteTaskType } from "./types";

export type RegisterRemoteTaskOptions<TAppState extends AppStateWithTasks> = {
  localSessionId: string;
  remoteTaskType: RemoteTaskType;
  remoteSession: {
    id: string;
    title: string;
  };
  command: string;
  context: TaskContext<TAppState>;
  toolUseId?: string;
  isRemoteReview?: boolean;
  isLongRunning?: boolean;
  isUltraplan?: boolean;
  remoteTaskMetadata?: RemoteTaskMetadata;
};

export async function registerRemoteAgentTask<TAppState extends AppStateWithTasks>(
  options: RegisterRemoteTaskOptions<TAppState>,
): Promise<{ taskId: string; sessionId: string; cleanup: () => void }> {
  const taskId = generateTaskId("remote_agent");
  await initTaskOutput(taskId);

  const task: RemoteAgentTaskState = {
    id: taskId,
    type: "remote_agent",
    status: "running",
    description: options.remoteSession.title,
    toolUseId: options.toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(taskId),
    outputOffset: 0,
    notified: false,
    remoteTaskType: options.remoteTaskType,
    sessionId: options.remoteSession.id,
    command: options.command,
    title: options.remoteSession.title,
    todoList: [],
    log: [],
    pollStartedAt: Date.now(),
    isRemoteReview: options.isRemoteReview,
    isLongRunning: options.isLongRunning,
    isUltraplan: options.isUltraplan,
    remoteTaskMetadata: options.remoteTaskMetadata,
  };

  registerTask(task, options.context.setAppState as SetAppState<TAppState>);

  await persistRemoteTaskMetadata(options.localSessionId, {
    taskId,
    remoteTaskType: options.remoteTaskType,
    sessionId: options.remoteSession.id,
    title: options.remoteSession.title,
    command: options.command,
    spawnedAt: Date.now(),
    toolUseId: options.toolUseId,
    isRemoteReview: options.isRemoteReview,
    isLongRunning: options.isLongRunning,
    isUltraplan: options.isUltraplan,
    remoteTaskMetadata: options.remoteTaskMetadata,
  });

  const cleanup = startRemoteTaskPolling({
    localSessionId: options.localSessionId,
    taskId,
    context: options.context,
  });

  return {
    taskId,
    sessionId: options.remoteSession.id,
    cleanup,
  };
}
```

官方源码里 `registerRemoteAgentTask()` 做的事情和这里很接近：

```txt
generate task id
init output file
create RemoteAgentTaskState
registerTask()
persist sidecar
start polling
return cleanup
```

这里有个容易漏掉的细节：

先创建 output file，再注册 task。

因为 UI 或 TaskOutput 工具可能在注册后立刻读取 output path。

如果文件还没创建，读者会遇到偶发空结果或 ENOENT。

## 第十三步：实现 pollRemoteSessionEvents

实际项目会请求 Anthropic Sessions API 或你自己的 RCS。

Mini 版先封装成一个函数。

创建 `src/remote-tasks/api.ts`：

```ts
import type { PollRemoteSessionResponse } from "./types";

export async function pollRemoteSessionEvents(
  baseUrl: string,
  sessionId: string,
  afterId: string | null,
  token: string,
): Promise<PollRemoteSessionResponse> {
  const url = new URL(`/v1/sessions/${sessionId}/events`, baseUrl);
  if (afterId) {
    url.searchParams.set("after_id", afterId);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to poll remote session events: ${response.status}`);
  }

  const body = (await response.json()) as {
    data?: unknown[];
    last_id?: string | null;
    session_status?: PollRemoteSessionResponse["sessionStatus"];
  };

  const events = Array.isArray(body.data)
    ? body.data.filter(event => {
        if (!event || typeof event !== "object") return false;
        if (!("type" in event)) return false;
        if (event.type === "env_manager_log") return false;
        if (event.type === "control_response") return false;
        return true;
      })
    : [];

  return {
    newEvents: events as PollRemoteSessionResponse["newEvents"],
    lastEventId: body.last_id ?? afterId,
    sessionStatus: body.session_status,
  };
}

export async function archiveRemoteSession(baseUrl: string, sessionId: string, token: string): Promise<void> {
  const response = await fetch(new URL(`/v1/sessions/${sessionId}/archive`, baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok && response.status !== 409) {
    throw new Error(`Failed to archive remote session: ${response.status}`);
  }
}
```

官方 `pollRemoteSessionEvents()` 有两个细节值得保留：

第一，使用 `after_id` 做增量拉取。

不要每秒全量拉 transcript。

第二，对事件分页要有上限。

官方实现里有 `MAX_EVENT_PAGES` 防止 stuck cursor 无限循环。

Mini 版如果后面加分页，可以这么写：

```ts
const MAX_EVENT_PAGES = 50;

for (let page = 0; page < MAX_EVENT_PAGES; page++) {
  // fetch one page
  // update cursor
  // break if has_more is false
}
```

## 第十四步：实现 Remote Task Poller

这是本章最关键的后台任务生命周期。

创建 `src/remote-tasks/poller.ts`：

```ts
import { appendTaskOutput, evictTaskOutput } from "../tasks/output";
import { updateTaskState, type AppStateWithTasks } from "../tasks/registry";
import type { TaskContext } from "../tasks/types";
import { formatTaskNotification } from "../tasks/notifications";
import { removeRemoteTaskMetadata } from "./metadata";
import { pollRemoteSessionEvents } from "./api";
import type { RemoteAgentTaskState, RemoteTaskMetadata, RemoteTaskType } from "./types";

const POLL_INTERVAL_MS = 1000;
const STABLE_IDLE_POLLS = 5;
const REMOTE_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

export type RemoteCompletionChecker = (metadata: RemoteTaskMetadata | undefined) => Promise<string | null>;

const completionCheckers = new Map<RemoteTaskType, RemoteCompletionChecker>();

export function registerRemoteCompletionChecker(type: RemoteTaskType, checker: RemoteCompletionChecker): void {
  completionCheckers.set(type, checker);
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(block => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map(block => String((block as { text?: string }).text ?? ""))
    .join("\n");
}

function extractTodoList(_events: unknown[]): RemoteAgentTaskState["todoList"] {
  return [];
}

function enqueueTaskMessage<TAppState extends AppStateWithTasks>(
  context: TaskContext<TAppState>,
  content: string,
): void {
  context.setAppState(prev => ({
    ...prev,
    messages: [...prev.messages, { type: "system", content }],
  }));
}

export function startRemoteTaskPolling<TAppState extends AppStateWithTasks>(options: {
  localSessionId: string;
  taskId: string;
  context: TaskContext<TAppState>;
}): () => void {
  let isRunning = true;
  let lastEventId: string | null = null;
  let accumulatedLog: RemoteAgentTaskState["log"] = [];
  let consecutiveIdlePolls = 0;

  const poll = async (): Promise<void> => {
    if (!isRunning) return;

    try {
      const appState = options.context.getAppState();
      const task = appState.tasks[options.taskId] as RemoteAgentTaskState | undefined;

      if (!task || task.status !== "running") {
        return;
      }

      const token = process.env.MINI_REMOTE_TOKEN;
      const baseUrl = process.env.MINI_REMOTE_BASE_URL;
      if (!token || !baseUrl) {
        throw new Error("Missing remote session configuration");
      }

      const response = await pollRemoteSessionEvents(baseUrl, task.sessionId, lastEventId, token);
      lastEventId = response.lastEventId;

      const logGrew = response.newEvents.length > 0;

      if (logGrew) {
        accumulatedLog = [...accumulatedLog, ...response.newEvents];
        const deltaText = response.newEvents.map(extractAssistantText).filter(Boolean).join("\n");
        if (deltaText) {
          await appendTaskOutput(options.taskId, `${deltaText}\n`);
        }
      }

      if (response.sessionStatus === "archived") {
        completeTask(options.localSessionId, options.taskId, task, "completed", options.context);
        return;
      }

      const checker = completionCheckers.get(task.remoteTaskType);
      if (checker) {
        const completionSummary = await checker(task.remoteTaskMetadata);
        if (completionSummary) {
          completeTask(options.localSessionId, options.taskId, task, "completed", options.context, completionSummary);
          return;
        }
      }

      const result =
        task.isLongRunning || task.isUltraplan
          ? undefined
          : accumulatedLog.findLast(event => event.type === "result");

      const hasAnyOutput = accumulatedLog.some(event => event.type === "assistant" || event.type === "system");

      if (response.sessionStatus === "idle" && !logGrew && hasAnyOutput) {
        consecutiveIdlePolls++;
      } else {
        consecutiveIdlePolls = 0;
      }

      const stableIdle = consecutiveIdlePolls >= STABLE_IDLE_POLLS;
      const reviewTimedOut = Boolean(task.isRemoteReview && Date.now() - task.pollStartedAt > REMOTE_REVIEW_TIMEOUT_MS);

      const finalStatus = result
        ? result.subtype === "success"
          ? "completed"
          : "failed"
        : stableIdle || reviewTimedOut
          ? "completed"
          : null;

      let raceTerminated = false;

      updateTaskState<RemoteAgentTaskState, TAppState>(options.taskId, options.context.setAppState, previous => {
        if (previous.status !== "running") {
          raceTerminated = true;
          return previous;
        }

        if (!logGrew && !finalStatus) {
          return previous;
        }

        return {
          ...previous,
          status: finalStatus ?? "running",
          log: accumulatedLog,
          todoList: logGrew ? extractTodoList(accumulatedLog) : previous.todoList,
          endTime: finalStatus ? Date.now() : undefined,
        };
      });

      if (raceTerminated) return;

      if (finalStatus) {
        completeTask(options.localSessionId, options.taskId, task, finalStatus, options.context);
        return;
      }
    } catch (error) {
      console.error(error);
      consecutiveIdlePolls = 0;
    }

    if (isRunning) {
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  void poll();

  return () => {
    isRunning = false;
  };
}

function completeTask<TAppState extends AppStateWithTasks>(
  localSessionId: string,
  taskId: string,
  task: RemoteAgentTaskState,
  status: "completed" | "failed",
  context: TaskContext<TAppState>,
  summary = task.title,
): void {
  updateTaskState<RemoteAgentTaskState, TAppState>(taskId, context.setAppState, previous => {
    if (previous.status !== "running") return previous;
    return {
      ...previous,
      status,
      notified: true,
      endTime: Date.now(),
    };
  });

  enqueueTaskMessage(
    context,
    formatTaskNotification({
      taskId,
      taskType: "remote_agent",
      status,
      summary,
      outputFile: task.outputFile,
      toolUseId: task.toolUseId,
    }),
  );

  void evictTaskOutput(taskId);
  void removeRemoteTaskMetadata(localSessionId, taskId);
}
```

这里要重点理解 `stableIdle`。

远端 session 可能会在工具调用之间短暂进入 idle。

如果一看到 idle 就认为任务完成，会误结束长任务。

官方实现要求：

```txt
sessionStatus === idle
and no log growth
and has output
and consecutive idle polls >= 5
```

这就是 `STABLE_IDLE_POLLS = 5` 的意义。

另外注意两个跳过 result completion 的场景：

```ts
task.isLongRunning || task.isUltraplan
```

long-running task 可能每个周期都有 result。

ultraplan 的 result 也不能直接代表最终完成。

这些都要交给具体业务 checker 或 scanner。

## 第十五步：恢复 Remote Task

创建 `src/remote-tasks/restore.ts`：

```ts
import { getTaskOutputPath, initTaskOutput } from "../tasks/output";
import { registerTask, type AppStateWithTasks, type SetAppState } from "../tasks/registry";
import type { TaskContext } from "../tasks/types";
import { listRemoteTaskMetadata, removeRemoteTaskMetadata } from "./metadata";
import { startRemoteTaskPolling } from "./poller";
import type { RemoteAgentTaskState, RemoteTaskType } from "./types";

type RemoteSessionInfo = {
  id: string;
  session_status: "idle" | "running" | "requires_action" | "archived";
};

async function fetchRemoteSession(baseUrl: string, sessionId: string, token: string): Promise<RemoteSessionInfo> {
  const response = await fetch(new URL(`/v1/sessions/${sessionId}`, baseUrl), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 404) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch session: ${response.status}`);
  }

  return response.json() as Promise<RemoteSessionInfo>;
}

function isRemoteTaskType(value: string): value is RemoteTaskType {
  return value === "remote-agent" || value === "remote-review" || value === "background-pr" || value === "autofix-pr" || value === "ultraplan";
}

export async function restoreRemoteAgentTasks<TAppState extends AppStateWithTasks>(
  localSessionId: string,
  context: TaskContext<TAppState>,
): Promise<void> {
  const persisted = await listRemoteTaskMetadata(localSessionId);
  if (persisted.length === 0) return;

  const token = process.env.MINI_REMOTE_TOKEN;
  const baseUrl = process.env.MINI_REMOTE_BASE_URL;
  if (!token || !baseUrl) return;

  for (const meta of persisted) {
    let remoteStatus: RemoteSessionInfo["session_status"];

    try {
      const remote = await fetchRemoteSession(baseUrl, meta.sessionId, token);
      remoteStatus = remote.session_status;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Session not found:")) {
        await removeRemoteTaskMetadata(localSessionId, meta.taskId);
      }
      continue;
    }

    if (remoteStatus === "archived") {
      await removeRemoteTaskMetadata(localSessionId, meta.taskId);
      continue;
    }

    await initTaskOutput(meta.taskId).catch(() => undefined);

    const task: RemoteAgentTaskState = {
      id: meta.taskId,
      type: "remote_agent",
      status: "running",
      description: meta.title,
      toolUseId: meta.toolUseId,
      startTime: meta.spawnedAt,
      outputFile: getTaskOutputPath(meta.taskId),
      outputOffset: 0,
      notified: false,
      remoteTaskType: isRemoteTaskType(meta.remoteTaskType) ? meta.remoteTaskType : "remote-agent",
      sessionId: meta.sessionId,
      command: meta.command,
      title: meta.title,
      todoList: [],
      log: [],
      pollStartedAt: Date.now(),
      isRemoteReview: meta.isRemoteReview,
      isLongRunning: meta.isLongRunning,
      isUltraplan: meta.isUltraplan,
      remoteTaskMetadata: meta.remoteTaskMetadata,
    };

    registerTask(task, context.setAppState as SetAppState<TAppState>);
    startRemoteTaskPolling({
      localSessionId,
      taskId: meta.taskId,
      context,
    });
  }
}
```

恢复逻辑有一个工程判断：

只有 404 和 archived 可以删除 sidecar。

认证失败、网络失败、服务端暂时不可用，都不应该删除。

官方源码里也是类似策略：

```txt
404 -> remote session is gone -> remove sidecar
archived -> remote session ended -> remove sidecar
auth/network error -> keep sidecar, user login or retry later
```

这是长期任务系统里非常重要的容错边界。

## 第十六步：停止 Remote Task

创建 `src/remote-tasks/kill.ts`：

```ts
import { evictTaskOutput } from "../tasks/output";
import { updateTaskState, type AppStateWithTasks } from "../tasks/registry";
import type { TaskContext } from "../tasks/types";
import { formatTaskNotification } from "../tasks/notifications";
import { archiveRemoteSession } from "./api";
import { removeRemoteTaskMetadata } from "./metadata";
import type { RemoteAgentTaskState } from "./types";

export async function killRemoteAgentTask<TAppState extends AppStateWithTasks>(
  localSessionId: string,
  taskId: string,
  context: TaskContext<TAppState>,
): Promise<void> {
  let sessionId: string | undefined;
  let title = "Remote task";
  let outputFile: string | undefined;

  updateTaskState<RemoteAgentTaskState, TAppState>(taskId, context.setAppState, task => {
    if (task.status !== "running") return task;
    sessionId = task.sessionId;
    title = task.title;
    outputFile = task.outputFile;

    return {
      ...task,
      status: "killed",
      notified: true,
      endTime: Date.now(),
    };
  });

  context.setAppState(prev => ({
    ...prev,
    messages: [
      ...prev.messages,
      {
        type: "system",
        content: formatTaskNotification({
          taskId,
          taskType: "remote_agent",
          status: "killed",
          summary: title,
          outputFile,
        }),
      },
    ],
  }));

  if (sessionId) {
    const token = process.env.MINI_REMOTE_TOKEN;
    const baseUrl = process.env.MINI_REMOTE_BASE_URL;
    if (token && baseUrl) {
      await archiveRemoteSession(baseUrl, sessionId, token).catch(error => {
        console.error(error);
      });
    }
  }

  await evictTaskOutput(taskId).catch(() => undefined);
  await removeRemoteTaskMetadata(localSessionId, taskId).catch(() => undefined);
}
```

为什么 kill 要 archive？

因为本地把任务标记 killed 只影响本地 UI。

远端 session 仍然可能继续消耗资源。

官方实现会调用 `archiveRemoteSession(sessionId)`。

它的语义是：

```txt
best-effort archive
reject future events
let remote stop on next write
failure allowed, later TTL reaper cleanup
```

kill 不能因为 archive 失败就把本地状态回滚成 running。

那会让用户无法关闭坏任务。

正确策略是：

```txt
local state first
remote cleanup best effort
sidecar cleanup
```

## 第十七步：后台任务列表 UI

如果你还没有 Ink UI，可以先做纯文本版本。

创建 `src/tasks/backgroundDialog.ts`：

```ts
import type { TaskStateBase } from "./types";

export function isBackgroundTask(task: TaskStateBase): boolean {
  return task.status === "pending" || task.status === "running";
}

export function sortBackgroundTasks(tasks: TaskStateBase[]): TaskStateBase[] {
  return [...tasks].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    return b.startTime - a.startTime;
  });
}

export function renderBackgroundTaskList(tasks: Record<string, TaskStateBase>): string {
  const visible = sortBackgroundTasks(Object.values(tasks).filter(isBackgroundTask));

  if (visible.length === 0) {
    return "No tasks currently running";
  }

  const groups = new Map<string, TaskStateBase[]>();
  for (const task of visible) {
    const list = groups.get(task.type) ?? [];
    list.push(task);
    groups.set(task.type, list);
  }

  const lines: string[] = [];
  for (const [type, items] of groups) {
    lines.push(`${type} (${items.length})`);
    for (const item of items) {
      lines.push(`  ${item.id}  ${item.status}  ${item.description}`);
    }
  }

  return lines.join("\n");
}
```

官方 UI 会把任务分组：

```txt
Agents
Shells
Monitors
Remote agents
Workflows
```

并支持：

- 上下选择
- Enter 查看详情
- x 停止
- Back 返回
- 单任务时直接进入详情
- foregrounded local agent 不显示在 background list

Mini 版先做到：

```txt
running first
newer first
group by type
show id/status/description
```

## 第十八步：Remote Session Detail

后台列表只能看到一行摘要。

远端任务需要 detail view。

Mini 先做文本版。

创建 `src/remote-tasks/detail.ts`：

```ts
import { getTaskOutputTail } from "../tasks/output";
import type { RemoteAgentTaskState } from "./types";

export function getRemoteTaskSessionUrl(sessionId: string): string {
  const base = process.env.MINI_REMOTE_WEB_URL ?? "http://localhost:8787";
  return `${base}/sessions/${encodeURIComponent(sessionId)}`;
}

export async function renderRemoteTaskDetail(task: RemoteAgentTaskState): Promise<string> {
  const output = await getTaskOutputTail(task.id);
  const lines = [
    `Remote task: ${task.title}`,
    `Status: ${task.status}`,
    `Session: ${task.sessionId}`,
    `URL: ${getRemoteTaskSessionUrl(task.sessionId)}`,
    `Command: ${task.command}`,
    "",
    "Todo:",
    ...task.todoList.map(todo => `  [${todo.status}] ${todo.content}`),
    "",
    "Output:",
    output || "  No output yet",
  ];

  return lines.join("\n");
}
```

官方 detail dialog 会做得更细：

- tool use summary
- review pipeline stage
- ultraplan phase
- session URL
- stop / back / review in web
- telemetry metadata

但 Mini 必须先提供可观测性。

长期任务最怕变成“我知道它在跑，但不知道它在干嘛”。

## 第十九步：Daemon 背景会话命令

远端 task 是 app 内的后台任务。

还有另一类 background session：

把整个 CLI 进程放到后台。

官方项目里有：

```txt
claude daemon status
claude daemon bg
claude daemon attach
claude daemon logs
claude daemon kill
```

Mini 版也做一个最小实现。

创建 `src/daemon/bg.ts`：

```ts
import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";

export type SessionEntry = {
  pid: number;
  sessionId: string;
  kind: "background";
  cwd: string;
  startedAt: number;
  name?: string;
  logPath: string;
  status?: string;
};

function sessionsDir(): string {
  return join(process.cwd(), ".mini", "sessions-live");
}

function logsDir(): string {
  return join(process.cwd(), ".mini", "session-logs");
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function listLiveSessions(): Promise<SessionEntry[]> {
  const dir = sessionsDir();
  const files = await readdir(dir).catch(() => []);
  const result: SessionEntry[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const raw = await readFile(join(dir, file), "utf8").catch(() => null);
    if (!raw) continue;

    const entry = JSON.parse(raw) as SessionEntry;
    if (!(await isProcessRunning(entry.pid))) {
      await unlink(join(dir, file)).catch(() => undefined);
      continue;
    }

    result.push(entry);
  }

  return result;
}

export async function startBackgroundSession(args: string[]): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true });
  await mkdir(logsDir(), { recursive: true });

  const sessionId = `bg-${Date.now().toString(36)}`;
  const logPath = join(logsDir(), `${sessionId}.log`);
  const out = await import("fs").then(fs => fs.openSync(logPath, "a"));

  const child = spawn(process.execPath, ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      MINI_BACKGROUND_SESSION_ID: sessionId,
    },
  });

  child.unref();

  const entry: SessionEntry = {
    pid: child.pid ?? 0,
    sessionId,
    kind: "background",
    cwd: process.cwd(),
    startedAt: Date.now(),
    logPath,
    status: "running",
  };

  await writeFile(join(sessionsDir(), `${entry.pid}.json`), JSON.stringify(entry, null, 2));

  console.log(`Background session started: ${sessionId}`);
  console.log(`  PID: ${entry.pid}`);
  console.log(`  Log: ${logPath}`);
}

export async function showSessions(): Promise<void> {
  const sessions = await listLiveSessions();
  if (sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }

  for (const session of sessions) {
    console.log(`${session.sessionId} PID=${session.pid} CWD=${session.cwd}`);
    console.log(`  Log: ${session.logPath}`);
  }
}

export async function showLogs(target?: string): Promise<void> {
  const sessions = await listLiveSessions();
  const session = target ? sessions.find(item => item.sessionId === target || String(item.pid) === target) : sessions[0];

  if (!session) {
    console.error("Session not found.");
    return;
  }

  const raw = await readFile(session.logPath, "utf8").catch(() => "");
  process.stdout.write(raw);
}

export async function killSession(target?: string): Promise<void> {
  const sessions = await listLiveSessions();
  const session = target ? sessions.find(item => item.sessionId === target || String(item.pid) === target) : undefined;

  if (!session) {
    console.error("Session not found.");
    return;
  }

  process.kill(session.pid, "SIGTERM");
  await unlink(join(sessionsDir(), `${session.pid}.json`)).catch(() => undefined);
  console.log(`Killed ${session.sessionId}`);
}
```

注意这里的 `process.execPath`。

在 Bun 运行时，它通常指向当前运行时二进制。

所以命令写成：

```txt
bun run src/cli.ts ...
```

在子进程里等价于：

```ts
spawn(process.execPath, ["run", "src/cli.ts", ...args])
```

教程里用户执行仍然使用 Bun 命令。

## 第二十步：Daemon Main

创建 `src/daemon/main.ts`：

```ts
import { killSession, showLogs, showSessions, startBackgroundSession } from "./bg";

export async function daemonMain(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "status";

  if (subcommand === "status" || subcommand === "ps") {
    await showSessions();
    return;
  }

  if (subcommand === "bg") {
    await startBackgroundSession(args.slice(1));
    return;
  }

  if (subcommand === "logs") {
    await showLogs(args[1]);
    return;
  }

  if (subcommand === "kill") {
    await killSession(args[1]);
    return;
  }

  if (subcommand === "help" || subcommand === "--help") {
    console.log(`Mini daemon

USAGE
  mini daemon status
  mini daemon bg -p "prompt"
  mini daemon logs <session>
  mini daemon kill <session>
`);
    return;
  }

  console.error(`Unknown daemon subcommand: ${subcommand}`);
}
```

然后在 CLI 入口加快速路径：

```ts
const args = process.argv.slice(2);

if (args[0] === "daemon") {
  const { daemonMain } = await import("./daemon/main");
  await daemonMain(args.slice(1));
  process.exit(0);
}

if (args.includes("--bg")) {
  const { startBackgroundSession } = await import("./daemon/bg");
  await startBackgroundSession(args.filter(arg => arg !== "--bg"));
  process.exit(0);
}
```

官方源码里还有 daemon supervisor。

它会长期运行 worker，worker crash 后指数退避重启。

Mini 可以后续补。

本章先确保用户能：

```bash
bun run src/cli.ts daemon status
bun run src/cli.ts daemon bg -p "analyze this repo"
bun run src/cli.ts daemon logs bg-xxx
bun run src/cli.ts daemon kill bg-xxx
```

## 第二十一步：RCS Event Bus

到这里，本地 CLI 已经能管理后台任务。

但 Remote Control Server 还需要服务端事件总线。

Mini 先做内存版。

创建 `src/rcs/eventBus.ts`：

```ts
import { randomUUID } from "crypto";

export type SessionEvent = {
  id: string;
  sequence: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  direction: "inbound" | "outbound";
  createdAt: number;
};

export class EventBus {
  private events: SessionEvent[] = [];
  private sequence = 0;
  private listeners = new Set<(event: SessionEvent) => void>();

  publish(input: Omit<SessionEvent, "id" | "sequence" | "createdAt">): SessionEvent {
    const event: SessionEvent = {
      ...input,
      id: randomUUID(),
      sequence: ++this.sequence,
      createdAt: Date.now(),
    };

    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  listAfter(sequence: number): SessionEvent[] {
    return this.events.filter(event => event.sequence > sequence);
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
```

官方 RCS 里也有类似 event bus。

差别是官方要考虑：

- 多 worker
- Web UI
- ACP link
- SSE resume
- delivery tracking
- worker epoch
- persistence

Mini 先保留内存。

## 第二十二步：RCS Session Store

创建 `src/rcs/sessions.ts`：

```ts
import { randomUUID } from "crypto";

export type RemoteControlSession = {
  id: string;
  title: string;
  status: "idle" | "running" | "requires_action" | "archived";
  createdAt: number;
  updatedAt: number;
};

const sessions = new Map<string, RemoteControlSession>();

export function createSession(title: string): RemoteControlSession {
  const now = Date.now();
  const session: RemoteControlSession = {
    id: randomUUID(),
    title,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(sessionId: string): RemoteControlSession | null {
  return sessions.get(sessionId) ?? null;
}

export function updateSessionStatus(sessionId: string, status: RemoteControlSession["status"]): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.status = status;
  session.updatedAt = Date.now();
}

export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.updatedAt = Date.now();
  }
}

export function archiveSession(sessionId: string): void {
  updateSessionStatus(sessionId, "archived");
}
```

这只是开发版。

正式实现至少要加：

- 鉴权
- DB 持久化
- session owner
- org / workspace
- TTL reaper
- archived 之后拒绝写入
- event pagination

但 Mini 现在先跑通协议。

## 第二十三步：RCS Routes

如果你前面章节已经用 Hono，可以继续用 Hono。

创建 `src/rcs/routes.ts`：

```ts
import { Hono } from "hono";
import { archiveSession, createSession, getSession, touchSession, updateSessionStatus } from "./sessions";
import { getEventBus } from "./eventBus";

const app = new Hono();

function normalizePayload(type: string, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return {
      content: typeof payload === "string" ? payload : "",
      raw: payload,
    };
  }

  const record = payload as Record<string, unknown>;
  return {
    content: typeof record.content === "string" ? record.content : "",
    raw: payload,
    type,
    uuid: typeof record.uuid === "string" ? record.uuid : undefined,
    status: typeof record.status === "string" ? record.status : undefined,
    subtype: typeof record.subtype === "string" ? record.subtype : undefined,
    message: record.message,
    request_id: record.request_id,
    request: record.request,
  };
}

app.post("/v1/sessions", async c => {
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const session = createSession(body.title ?? "Remote session");
  return c.json(session);
});

app.get("/v1/sessions/:id", c => {
  const session = getSession(c.req.param("id"));
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({
    id: session.id,
    title: session.title,
    session_status: session.status,
  });
});

app.get("/v1/sessions/:id/events", c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const afterId = c.req.query("after_id");
  const afterSequence = afterId ? Number(afterId) : 0;
  const events = getEventBus(sessionId).listAfter(Number.isFinite(afterSequence) ? afterSequence : 0);

  return c.json({
    data: events.map(event => ({
      id: String(event.sequence),
      session_id: event.sessionId,
      type: event.type,
      ...event.payload,
    })),
    last_id: events.length > 0 ? String(events[events.length - 1]!.sequence) : afterId ?? null,
    session_status: session.status,
    has_more: false,
  });
});

app.post("/v1/sessions/:id/events", async c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  if (session.status === "archived") {
    return c.json({ error: "Session archived" }, 409);
  }

  const body = await c.req.json();
  const eventType = typeof body.type === "string" ? body.type : "message";
  const event = getEventBus(sessionId).publish({
    sessionId,
    type: eventType,
    payload: normalizePayload(eventType, body),
    direction: "outbound",
  });

  touchSession(sessionId);
  return c.json({ status: "ok", id: event.id });
});

app.post("/v1/sessions/:id/archive", c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  archiveSession(sessionId);
  return c.json({ status: "ok" });
});

app.post("/v1/code/sessions/:id/worker/events", async c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const body = await c.req.json();
  const events = Array.isArray(body.events) ? body.events : Array.isArray(body) ? body : [body];

  for (const raw of events) {
    const event = raw && typeof raw === "object" && "payload" in raw ? (raw as { payload: unknown }).payload : raw;
    const type = event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
      ? String((event as { type: string }).type)
      : "message";

    getEventBus(sessionId).publish({
      sessionId,
      type,
      payload: normalizePayload(type, event),
      direction: "inbound",
    });
  }

  touchSession(sessionId);
  return c.json({ status: "ok", count: events.length });
});

app.put("/v1/code/sessions/:id/worker/state", async c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const body = (await c.req.json()) as { status?: string; worker_status?: string };
  const status = body.worker_status ?? body.status;

  if (status === "idle" || status === "running" || status === "requires_action" || status === "archived") {
    updateSessionStatus(sessionId, status);
  } else {
    touchSession(sessionId);
  }

  return c.json({ status: "ok" });
});

app.get("/v1/code/sessions/:id/worker/events/stream", c => {
  const sessionId = c.req.param("id");
  const session = getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const from = Number(c.req.query("from_sequence_num") ?? c.req.header("Last-Event-ID") ?? 0);
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      for (const event of getEventBus(sessionId).listAfter(Number.isFinite(from) ? from : 0)) {
        controller.enqueue(encoder.encode(`id: ${event.sequence}\n`));
        controller.enqueue(encoder.encode(`event: ${event.type}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      const unsubscribe = getEventBus(sessionId).subscribe(event => {
        controller.enqueue(encoder.encode(`id: ${event.sequence}\n`));
        controller.enqueue(encoder.encode(`event: ${event.type}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      });

      c.req.raw.signal.addEventListener("abort", () => {
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});

export default app;
```

这个 routes 文件覆盖了官方 RCS 的三个关键入口：

```txt
worker state
worker events
worker events stream
```

对应真实源码：

```txt
packages/remote-control-server/src/routes/v2/worker.ts
packages/remote-control-server/src/routes/v2/worker-events.ts
packages/remote-control-server/src/routes/v2/worker-events-stream.ts
```

Mini 版的实现很小，但协议形态已经对了。

## 第二十四步：启动 RCS

创建 `src/rcs/server.ts`：

```ts
import app from "./routes";

Bun.serve({
  port: Number(process.env.MINI_RCS_PORT ?? 8787),
  fetch: app.fetch,
});

console.log(`Mini RCS listening on http://localhost:${process.env.MINI_RCS_PORT ?? 8787}`);
```

在 `package.json` 里加入脚本：

```json
{
  "scripts": {
    "rcs": "bun run src/rcs/server.ts"
  }
}
```

启动：

```bash
bun run rcs
```

创建 session：

```bash
curl -s http://localhost:8787/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"Background task"}'
```

写入 worker event：

```bash
curl -s http://localhost:8787/v1/code/sessions/SESSION_ID/worker/events \
  -H 'content-type: application/json' \
  -d '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello from worker"}]}}'
```

读取 events：

```bash
curl -s http://localhost:8787/v1/sessions/SESSION_ID/events
```

## 第二十五步：把 Remote Task 接到命令

假设前面章节已经有 slash command 或 CLI command。

新增一个命令：

```txt
/remote "do something in background"
```

命令流程：

```txt
check preconditions
create remote session
send initial prompt
register remote task
return task id
```

示例代码：

```ts
import { registerRemoteAgentTask } from "../remote-tasks/register";
import type { AppStateWithTasks } from "../tasks/registry";
import type { TaskContext } from "../tasks/types";

async function createRemoteSession(title: string): Promise<{ id: string; title: string }> {
  const baseUrl = process.env.MINI_REMOTE_BASE_URL ?? "http://localhost:8787";
  const response = await fetch(new URL("/v1/sessions", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create remote session: ${response.status}`);
  }

  return response.json() as Promise<{ id: string; title: string }>;
}

async function sendInitialPrompt(sessionId: string, prompt: string): Promise<void> {
  const baseUrl = process.env.MINI_REMOTE_BASE_URL ?? "http://localhost:8787";
  const response = await fetch(new URL(`/v1/sessions/${sessionId}/events`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: prompt,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to send initial prompt: ${response.status}`);
  }
}

export async function startRemoteCommand<TAppState extends AppStateWithTasks>(options: {
  localSessionId: string;
  prompt: string;
  context: TaskContext<TAppState>;
}): Promise<string> {
  const session = await createRemoteSession("Remote background task");
  await sendInitialPrompt(session.id, options.prompt);

  const task = await registerRemoteAgentTask({
    localSessionId: options.localSessionId,
    remoteTaskType: "remote-agent",
    remoteSession: session,
    command: options.prompt,
    context: options.context,
  });

  return task.taskId;
}
```

真实官方实现里，创建远端 session 前会做 eligibility check。

包括：

- 是否已登录
- 是否有 remote environment
- 是否在 Git repo
- 是否有 Git remote
- GitHub App 是否安装
- policy 是否允许 remote sessions
- bundle seed gate 是否开启

Mini 可以先做一个简化版。

## 第二十六步：Precondition Check

创建 `src/remote-tasks/preconditions.ts`：

```ts
import { existsSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type RemoteTaskPrecondition =
  | { type: "not_logged_in" }
  | { type: "no_remote_environment" }
  | { type: "not_in_git_repo" }
  | { type: "no_git_remote" }
  | { type: "policy_blocked" };

export async function checkRemoteTaskEligibility(): Promise<RemoteTaskPrecondition[]> {
  const errors: RemoteTaskPrecondition[] = [];

  if (process.env.MINI_DISABLE_REMOTE_TASKS === "1") {
    return [{ type: "policy_blocked" }];
  }

  if (!process.env.MINI_REMOTE_TOKEN) {
    errors.push({ type: "not_logged_in" });
  }

  if (!process.env.MINI_REMOTE_BASE_URL) {
    errors.push({ type: "no_remote_environment" });
  }

  if (!existsSync(join(process.cwd(), ".git"))) {
    errors.push({ type: "not_in_git_repo" });
    return errors;
  }

  const remote = await execFileAsync("git", ["remote"]).catch(() => ({ stdout: "" }));
  if (!remote.stdout.trim()) {
    errors.push({ type: "no_git_remote" });
  }

  return errors;
}

export function formatPreconditionError(error: RemoteTaskPrecondition): string {
  switch (error.type) {
    case "not_logged_in":
      return "Remote tasks require a remote auth token.";
    case "no_remote_environment":
      return "Remote tasks require MINI_REMOTE_BASE_URL.";
    case "not_in_git_repo":
      return "Remote tasks require a Git repository.";
    case "no_git_remote":
      return "Remote tasks require a Git remote.";
    case "policy_blocked":
      return "Remote tasks are disabled by policy.";
  }
}
```

把它加到命令入口：

```ts
const errors = await checkRemoteTaskEligibility();
if (errors.length > 0) {
  throw new Error(errors.map(formatPreconditionError).join("\n"));
}
```

官方有 GitHub App 检查和 GrowthBook / policy。

Mini 不需要一开始就做，但要保留 precondition 层。

不要把这些检查散落在 command 里。

## 第二十七步：权限桥接 UI

Mini 如果已有 tool permission UI，可以把 remote permission 变成同一类确认项。

最小数据结构：

```ts
export type PermissionConfirm = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  allow(updatedInput: Record<string, unknown>): void;
  deny(message?: string): void;
  abort(): void;
};
```

接入 runtime：

```ts
const runtime = new RemoteSessionRuntime(config, {
  onMessage(message) {
    appendMessage(convertSDKMessage(message));
  },
  onPermissionRequest(request, handlers) {
    enqueuePermissionConfirm({
      id: request.tool_use_id,
      toolName: request.tool_name,
      input: request.input,
      description: request.description ?? `${request.tool_name} requires permission`,
      allow: handlers.allow,
      deny: handlers.deny,
      abort: handlers.abort,
    });
  },
});
```

官方实现里还有一个小技巧：

如果本地没有对应 Tool 对象，会创建一个 stub tool。

这样远端新工具不会让本地权限 UI 崩溃。

Mini 也可以做：

```ts
function createToolStub(name: string) {
  return {
    name,
    description: `${name} requires permission`,
  };
}
```

权限桥接最容易出错的地方是 request id。

你必须用 `control_request.request_id` 回 control response。

不要用 `tool_use_id` 当 response request id。

`tool_use_id` 用于 UI 删除确认项。

`request_id` 用于协议回复。

## 第二十八步：消息转换

远端 SDK message 不能直接塞进本地 UI。

你需要一个转换层。

创建 `src/remote-session/convert.ts`：

```ts
import type { SDKMessage } from "./types";

export type LocalMessage =
  | { type: "assistant"; text: string }
  | { type: "user"; text: string }
  | { type: "system"; text: string }
  | { type: "ignored" };

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map(block => {
      if (!block || typeof block !== "object") return "";
      if ((block as { type?: string }).type === "text") {
        return String((block as { text?: string }).text ?? "");
      }
      if ((block as { type?: string }).type === "tool_use") {
        return `[tool_use ${(block as { name?: string }).name ?? "unknown"}]`;
      }
      if ((block as { type?: string }).type === "tool_result") {
        return `[tool_result ${(block as { tool_use_id?: string }).tool_use_id ?? "unknown"}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function convertSDKMessage(message: SDKMessage): LocalMessage {
  if (message.type === "assistant") {
    return {
      type: "assistant",
      text: blocksToText(message.message.content),
    };
  }

  if (message.type === "user") {
    return {
      type: "user",
      text: blocksToText(message.message.content),
    };
  }

  if (message.type === "system") {
    if (message.subtype === "task_started" || message.subtype === "task_notification") {
      return { type: "ignored" };
    }

    return {
      type: "system",
      text: message.subtype,
    };
  }

  if (message.type === "result") {
    return {
      type: "system",
      text: `remote result: ${message.subtype}`,
    };
  }

  return { type: "ignored" };
}
```

官方转换层要复杂得多。

它还会处理：

- streaming delta
- tool_use in-progress
- tool_result 渲染
- viewerOnly 下是否展示 user text
- session end message
- compact boundary

但原则一样：

```txt
transport message
  -> protocol message
  -> local UI message
```

不要让 UI 直接读 WebSocket raw JSON。

## 第二十九步：测试任务注册

创建 `src/tasks/registry.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { registerTask, updateTaskState, type AppStateWithTasks } from "./registry";

function makeState(): AppStateWithTasks {
  return {
    tasks: {},
    messages: [],
  };
}

test("registerTask stores task and appends task_started message", () => {
  let state = makeState();
  const setAppState = (updater: (prev: AppStateWithTasks) => AppStateWithTasks) => {
    state = updater(state);
  };

  registerTask(
    {
      id: "r123",
      type: "remote_agent",
      status: "running",
      description: "remote task",
      startTime: 1,
      outputFile: "/tmp/out",
      outputOffset: 0,
      notified: false,
    },
    setAppState,
  );

  expect(state.tasks.r123?.description).toBe("remote task");
  expect(state.messages[0]?.content).toContain("task_started");
});

describe("updateTaskState", () => {
  test("updates existing task", () => {
    let state = makeState();
    state.tasks.r123 = {
      id: "r123",
      type: "remote_agent",
      status: "running",
      description: "remote task",
      startTime: 1,
      outputFile: "/tmp/out",
      outputOffset: 0,
      notified: false,
    };

    const setAppState = (updater: (prev: AppStateWithTasks) => AppStateWithTasks) => {
      state = updater(state);
    };

    updateTaskState("r123", setAppState, task => ({
      ...task,
      status: "completed",
    }));

    expect(state.tasks.r123?.status).toBe("completed");
  });
});
```

运行：

```bash
bun test src/tasks/registry.test.ts
```

## 第三十步：测试 RemoteSessionManager

核心测试点：

```txt
control_request can_use_tool -> onPermissionRequest
respond allow -> control_response success
respond deny -> control_response success
unknown control subtype -> control_response error
control_cancel_request -> remove pending
SDK message -> onMessage
```

伪测试：

```ts
import { describe, expect, test } from "bun:test";
import { RemoteSessionManager } from "./manager";

describe("RemoteSessionManager", () => {
  test("surfaces permission request", () => {
    let seenTool = "";
    const manager = new RemoteSessionManager(
      {
        sessionId: "s1",
        websocketUrl: "ws://example.invalid",
        sendEventUrl: "http://example.invalid/events",
        getAccessToken: () => "token",
      },
      {
        onMessage() {},
        onPermissionRequest(request) {
          seenTool = request.tool_name;
        },
      },
    );

    const handle = manager as unknown as {
      handleMessage(message: unknown): void;
    };

    handle.handleMessage({
      type: "control_request",
      request_id: "req1",
      request: {
        subtype: "can_use_tool",
        tool_use_id: "tool1",
        tool_name: "Edit",
        input: {},
      },
    });

    expect(seenTool).toBe("Edit");
  });
});
```

生产代码不建议测试 private 方法。

真正项目里可以把 control request handling 抽成纯函数。

本教程先强调测试场景。

## 第三十一步：测试 Poller

poller 是最应该测的地方。

至少覆盖：

- first poll 有新事件，写入 output
- `lastEventId` 会传给下一次
- archived 变 completed
- result error 变 failed
- stable idle 达到 5 次才 completed
- long-running 忽略 result
- completion checker 可以完成 task
- task 已经 killed 时 poller 不覆盖状态
- poll API 抛错时不结束任务

测试技巧：

把 `pollRemoteSessionEvents()` 注入，而不是在 poller 里直接 import。

可以把 poller 改成：

```ts
export function createRemoteTaskPoller(deps: {
  pollRemoteSessionEvents: typeof pollRemoteSessionEvents;
  appendTaskOutput: typeof appendTaskOutput;
  now: () => number;
  setTimeout: typeof setTimeout;
}) {
  return function startRemoteTaskPolling(...) {
    // use deps
  };
}
```

官方源码因为历史原因有不少真实依赖。

Mini 从一开始可以做得更好测试。

## 第三十二步：测试 Restore

restore 的重点不是“恢复成功”。

重点是错误策略。

测试清单：

```txt
sidecar empty -> no-op
remote status running -> register task and start poll
remote status archived -> remove sidecar
fetch 404 -> remove sidecar
fetch auth error -> keep sidecar
corrupt sidecar -> skip
```

示例：

```ts
test("keeps sidecar on recoverable fetch error", async () => {
  // mock fetchRemoteSession to throw 401-like error
  // assert removeRemoteTaskMetadata is not called
});
```

这里不要把所有错误都当成删除。

否则用户一旦断网，本地就丢掉正在跑的远端任务入口。

## 第三十三步：测试 Kill

kill 的测试点：

```txt
running -> killed
terminal -> no-op
archive called with session id
output evicted
sidecar removed
notification emitted once
archive failure does not rollback local killed state
```

这类测试可以用依赖注入写得很干净。

比如：

```ts
const deps = {
  archiveRemoteSession: async () => {
    throw new Error("network down");
  },
  evictTaskOutput: async () => {},
  removeRemoteTaskMetadata: async () => {},
};
```

然后断言：

```txt
state.tasks[taskId].status === killed
```

## 第三十四步：手动验证

先启动 RCS：

```bash
bun run rcs
```

开另一个终端创建 session：

```bash
curl -s http://localhost:8787/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"Manual remote task"}'
```

写入 assistant event：

```bash
curl -s http://localhost:8787/v1/code/sessions/SESSION_ID/worker/events \
  -H 'content-type: application/json' \
  -d '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"step 1 complete"}]}}'
```

轮询：

```bash
curl -s http://localhost:8787/v1/sessions/SESSION_ID/events
```

归档：

```bash
curl -s -X POST http://localhost:8787/v1/sessions/SESSION_ID/archive
```

CLI 后台 session：

```bash
bun run src/cli.ts daemon bg -p "summarize this repo"
bun run src/cli.ts daemon status
bun run src/cli.ts daemon logs bg-xxxx
bun run src/cli.ts daemon kill bg-xxxx
```

项目检查：

```bash
bun test src/tasks src/remote-session src/remote-tasks
bun run typecheck
```

## 常见坑

### 一看到 idle 就完成任务

这是最常见错误。

远端 session 在工具调用之间可能短暂 idle。

必须使用 stable idle。

建议至少 5 次连续 idle 且无 log growth。

### result 事件误结束 long-running task

长期监控任务可能每轮都有 result。

`isLongRunning` 必须跳过 result completion。

### kill 只改本地状态

这会泄漏远端资源。

kill 后应该 best-effort archive。

### archive 失败后回滚 killed

不要回滚。

本地用户已经明确停止任务。

远端清理失败应该记录日志，不能让本地 UI 回到 running。

### sidecar 遇到任意错误都删除

不能这么做。

只有远端 404 或 archived 才能删除。

网络、认证、服务暂不可用都要保留。

### WebSocket echo 导致重复用户消息

发送 user message 时记录 uuid。

收到同 uuid 的 user message 时丢弃。

同一个 uuid 可能 echo 多次，所以不要命中一次就删除。

使用 bounded set。

### 权限 response 用错 id

control response 必须使用 `request_id`。

不是 `tool_use_id`。

### WebSocket 断开后任务计数虚高

断线期间可能错过 task_notification。

重连时可以清空远端 task count。

宁愿短暂低估，不要一直虚高。

### task output 放 AppState

不要。

大输出必须放磁盘。

AppState 只放 output path 和 offset。

### poller race 覆盖 killed 状态

poll API in-flight 时用户可能 kill。

poll 回来后必须检查 previous status。

如果不是 running，就不能覆盖。

## 和官方能力的差距

本章 Mini 已经接近官方 Claude Code 的后台远程任务骨架，但仍然有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| Task framework | AppState + output file | SDK event queue、lazy GC、panel retain |
| Remote session live | WebSocket + HTTP POST | streaming delta、tool spinner、viewerOnly 细粒度模式 |
| Permission bridge | allow / deny / abort | permission suggestions、blocked path、tool stub、classifier hooks |
| Polling | after id + stable idle | pagination、branch/status metadata、review tag parser |
| Restore | sidecar + status fetch | session scoped sidecar、auth recover、metadata migration |
| Kill | local killed + archive | terminal SDK event、TTL reaper、cloud resource audit |
| Daemon | detached process | supervisor、worker registry、crash backoff、capacity |
| RCS | in-memory routes | auth、DB、SSE resume、delivery tracking、worker epoch |
| Detail UI | text view | task-specific detail dialogs、web link、progress pipeline |

如果你的目标是更接近官方，下一步应该补：

1. RCS 鉴权和 worker epoch。
2. WebSocket subscribe endpoint。
3. Remote session detail dialog。
4. TaskOutput 工具读取后台任务输出。
5. Remote review / ultraplan 的专用 completion checker。
6. Daemon supervisor 和 worker crash backoff。

## 本章小结

本章把 Mini 从“能恢复远端 session”推进到了“能管理远端后台任务”。

最终链路是：

```txt
remote session
  -> RemoteSessionManager
  -> RemoteSessionRuntime
  -> registerRemoteAgentTask
  -> sidecar metadata
  -> pollRemoteSessionEvents
  -> task output file
  -> task notification
  -> restoreRemoteAgentTasks
  -> killRemoteAgentTask
  -> archiveRemoteSession
```

这章的关键不是某个函数。

关键是生命周期边界：

```txt
live control 用 WebSocket
user input 用 HTTP POST
task state 放 AppState
long output 放磁盘
identity 放 sidecar
completion 由 poller 决定
cleanup 用 archive
```

到这里，Mini 已经具备官方 Claude Code 很核心的一类能力：

把一个长时间运行的远端 agent 变成可观察、可恢复、可停止、可通知的后台任务。

下一章可以继续补 **Remote Control Server 的鉴权、Worker Epoch 与多客户端一致性**：让 RCS 从开发版事件总线升级成更接近官方的可靠远程控制平面。
