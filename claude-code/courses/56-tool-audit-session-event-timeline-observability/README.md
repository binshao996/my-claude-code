# 第 56 章：工具审计、会话事件追踪与安全可观测性

第 55 章补完了安全边界：

```txt
permission mode
tool policy
path policy
shell rule
sandbox runtime
remote approval
headless fallback
runner policy
```

这让远程任务不再只是“能执行命令”，而是开始具备：

```txt
哪些操作可以自动执行
哪些操作必须询问
哪些操作必须拒绝
哪些操作必须进入沙箱
```

但安全策略只做判断还不够。

接近官方 Claude Code 的系统，还必须能回答这些问题：

```txt
这一轮为什么卡住？
哪个工具触发了权限请求？
用户允许了什么？
模型请求了什么命令？
命令什么时候开始？
命令什么时候完成？
文件持久化有没有成功？
远程 CCR 有没有收到事件？
worker 当前是 running、idle，还是 requires_action？
Web 控制台看到的状态为什么和 CLI 不一致？
恢复 session 时 transcript 从哪里来？
```

这些不是 UI 小细节，而是 agent 系统的可运维性基础。

官方 Claude Code 不是只把模型输出打印到终端。

它有多条事件通道：

```txt
SDK stream
transcript JSONL
diagnostics JSONL
CCR v2 worker events
CCR v2 internal events
worker state
external metadata
RCS event bus
SSE stream
permission result
file persistence event
```

本章目标：

- 梳理现有审计与事件通道
- 区分 diagnostics、transcript、SDK event、CCR event
- 设计 Mini 的统一 `AuditEvent`
- 给工具调用增加审计包装
- 给权限判断增加审计包装
- 给沙箱执行增加审计包装
- 给 command lifecycle 增加状态映射
- 给 file persistence 增加结果事件
- 给 session state / metadata 增加 timeline 入口
- 给 CCR v2 / RCS SSE 增加可排查 timeline
- 给 Mini 增加本地 JSONL 审计文件
- 给 Mini 增加 timeline CLI 查看命令
- 给审计字段增加脱敏策略
- 补齐测试矩阵

到本章结束，你的 Mini 会具备：

- append-only audit log
- stable event schema
- secret redaction
- command hash
- relative path summary
- permission decision event
- sandbox decision event
- command started / completed event
- tool started / completed / failed event
- file persisted event
- session state event
- remote delivery event
- timeline reader
- timeline CLI
- RCS SSE timeline bridge
- 可测试的可观测性链路

第 55 章解决的是：

```txt
能不能安全执行
```

第 56 章解决的是：

```txt
执行过什么，为什么这样执行，现在卡在哪里
```

## 参考源码

本章参考这些真实模块：

```txt
src/utils/diagLogs.ts
src/utils/commandLifecycle.ts
src/utils/sessionState.ts
src/utils/sdkEventQueue.ts
src/utils/sessionStorage.ts
src/QueryEngine.ts
src/cli/print.ts
src/cli/structuredIO.ts
src/cli/remoteIO.ts
src/cli/transports/ccrClient.ts
src/cli/transports/SerialBatchEventUploader.ts
src/cli/transports/WorkerStateUploader.ts

src/entrypoints/sdk/coreSchemas.ts
src/state/onChangeAppState.ts
src/remote/sdkMessageAdapter.ts
src/remote/remotePermissionBridge.ts

src/utils/filePersistence/filePersistence.ts
src/utils/filePersistence/types.ts

packages/remote-control-server/src/services/transport.ts
packages/remote-control-server/src/transport/event-bus.ts
packages/remote-control-server/src/transport/sse-writer.ts
packages/remote-control-server/src/routes/v2/worker.ts
packages/remote-control-server/src/routes/v2/worker-events.ts
packages/remote-control-server/src/routes/v2/worker-events-stream.ts
packages/remote-control-server/src/types/messages.ts
```

这些模块体现了一个重要设计：

```txt
可观测性不是一个日志函数。
可观测性是一条跨进程、跨传输、跨 UI 的事件链。
```

## 先区分几类事件

很多 Mini 实现会犯一个错误：

```txt
把所有东西都 console.log
```

这会导致四个问题：

```txt
无法被 UI 消费
无法被 session 恢复使用
无法跨远程 worker 传输
无法安全保留，容易泄露 token、prompt、路径、仓库名
```

所以我们先分层。

### Diagnostics

`src/utils/diagLogs.ts` 负责诊断日志。

它的特点：

```txt
写入 CLAUDE_CODE_DIAGNOSTICS_FILE
JSONL
append-only
同步写
不允许包含 PII
用于容器内运行问题排查
```

它明确要求：

```txt
不能写 prompt
不能写文件路径
不能写项目名
不能写仓库名
不能写 token
```

所以 diagnostics 适合记录：

```txt
ccr_init_failed
worker_request_error
hydrate_read_failed
duration_ms
retry_count
status_code
```

不适合记录：

```txt
用户输入
完整命令
完整工具输入
绝对路径
文件内容
```

### Transcript

`src/utils/sessionStorage.ts` 负责 transcript。

真实系统会把 conversation message 写入 session JSONL。

`recordTranscript()` 的职责不是调试，而是：

```txt
支持 --resume
支持 --continue
支持 rewind
支持 compaction boundary
支持 parentUuid chain
支持 CCR v2 internal event 恢复
```

在 CCR v2 下，`RemoteIO` 会注册：

```ts
setInternalEventWriter((eventType, payload, options) =>
  this.ccrClient!.writeInternalEvent(eventType, payload, options),
);

setInternalEventReader(
  () => this.ccrClient!.readInternalEvents(),
  () => this.ccrClient!.readSubagentInternalEvents(),
);
```

这意味着：

```txt
transcript message
  -> sessionStorage
  -> CCR v2 internal event
  -> remote storage
  -> hydrateFromCCRv2InternalEvents
  -> local JSONL
  -> resume
```

internal event 不直接给前端 UI 展示。

它主要服务于恢复。

### SDK Event

`src/entrypoints/sdk/coreSchemas.ts` 定义了 SDK 消息。

本章关心这些：

```txt
tool_progress
system / status
system / files_persisted
system / session_state_changed
result.permission_denials
assistant
user
stream_event
```

`QueryEngine` 已经会收集 permission denial：

```ts
if (result.behavior !== 'allow') {
  this.permissionDenials.push({
    type: 'permission_denial',
    tool_name: sdkCompatToolName(tool.name),
    tool_use_id: toolUseID,
    tool_input: input,
  });
}
```

最后 `result` 消息里会带：

```txt
permission_denials
```

注意：

```txt
这里的 tool_input 可能包含敏感字段。
审计 UI 展示时要先脱敏。
```

### Command Lifecycle

`src/utils/commandLifecycle.ts` 很小，但很关键：

```ts
type CommandLifecycleState = 'started' | 'completed';

export function setCommandLifecycleListener(
  cb: CommandLifecycleListener | null,
): void {
  listener = cb;
}

export function notifyCommandLifecycle(
  uuid: string,
  state: CommandLifecycleState,
): void {
  listener?.(uuid, state);
}
```

在 `RemoteIO` 的 CCR v2 分支里：

```ts
const LIFECYCLE_TO_DELIVERY = {
  started: 'processing',
  completed: 'processed',
} as const;

setCommandLifecycleListener((uuid, state) => {
  this.ccrClient?.reportDelivery(uuid, LIFECYCLE_TO_DELIVERY[state]);
});
```

这个设计说明：

```txt
本地命令生命周期
  -> command uuid
  -> CCR delivery status
  -> received / processing / processed
```

命令生命周期不是单纯为了终端显示。

它还用于远程端知道：

```txt
这个事件已收到
这个事件正在处理
这个事件处理完成
```

### Session State

`src/utils/sessionState.ts` 定义：

```ts
export type SessionState = 'idle' | 'running' | 'requires_action';
```

它还定义 `RequiresActionDetails`：

```ts
export type RequiresActionDetails = {
  tool_name: string;
  action_description: string;
  tool_use_id: string;
  request_id: string;
  input?: Record<string, unknown>;
};
```

这正是远程 UI 需要的最小上下文：

```txt
现在卡住了
卡在什么工具
工具想做什么
对应哪个 tool_use_id
对应哪个 permission request
必要时拿 input 渲染确认 UI
```

`notifySessionStateChanged('requires_action', details)` 会把 pending action 同步到 metadata：

```txt
requires_action
  -> pending_action: details
```

状态回到非阻塞后会清除：

```txt
idle / running
  -> pending_action: null
```

### Worker State

`RemoteIO` 在 CCR v2 下注册：

```ts
setSessionStateChangedListener((state, details) => {
  this.ccrClient?.reportState(state, details);
});

setSessionMetadataChangedListener(
  metadata => {
    this.ccrClient?.reportMetadata(metadata);
  },
  { replayCurrent: true },
);
```

`CCRClient.reportState()` 会发送：

```txt
worker_status
requires_action_details
```

`CCRClient.reportMetadata()` 会发送：

```txt
external_metadata
```

RCS 侧 `routes/v2/worker.ts` 会持久化：

```txt
worker_status
external_metadata
requires_action_details
last_heartbeat_at
```

这就是 Web 控制台能知道 session 状态的来源。

### RCS Event Bus

RCS 的 `EventBus` 维护 per-session 事件：

```ts
export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  direction: 'inbound' | 'outbound';
  seqNum: number;
  createdAt: number;
}
```

发布时会补：

```txt
seqNum
createdAt
```

并保留最多 5000 条。

SSE 输出使用：

```txt
id: <seqNum>
event: message
data: {"type": "...", "payload": ..., "direction": "...", "seqNum": ...}
```

worker 侧的 SSE 使用：

```txt
event: client_event
data: {
  event_id,
  sequence_num,
  event_type,
  source,
  payload,
  created_at
}
```

这给 timeline 提供了天然排序字段：

```txt
seqNum / sequence_num
createdAt / created_at
```

## 统一模型

把上述通道放到一张图里：

```txt
Model output
  -> tool_use
  -> permission pipeline
  -> audit: permission_decision
  -> session state: requires_action?
  -> remote approval?
  -> tool call
  -> audit: tool_started
  -> sandbox decision
  -> audit: sandbox_decision
  -> command lifecycle
  -> audit: command_started / command_completed
  -> SDK event
  -> transcript
  -> CCR client event
  -> RCS event bus
  -> SSE
  -> Web timeline
```

再加 session 恢复：

```txt
transcript
  -> CCR internal event
  -> remote storage
  -> readInternalEvents
  -> hydrate local JSONL
  -> resume
```

所以 Mini 的目标不是简单加一个日志文件。

Mini 要形成这个最小闭环：

```txt
工具执行前后有审计
权限决策有审计
沙箱策略有审计
远程状态有审计
审计可以被排序
审计可以被脱敏
审计可以被测试
```

## 本章 Mini 目录

在你的 `claude-code-mini` 中新增：

```txt
src/observability/
  auditTypes.ts
  redaction.ts
  auditSink.ts
  auditTiming.ts
  timeline.ts
  toolAudit.ts
  sessionAudit.ts
  commandAudit.ts
  filePersistenceAudit.ts
  remoteAudit.ts
  __tests__/
    redaction.test.ts
    auditSink.test.ts
    timeline.test.ts
    toolAudit.test.ts
    sessionAudit.test.ts
```

如果你的 Mini 还没有 remote-control-server，可以先只做本地 JSONL。

如果已经跟到第 50 到 54 章做了 RCS / CCR v2，就继续加远程 timeline。

## 第一步：定义 AuditEvent

新增：

```txt
src/observability/auditTypes.ts
```

写入：

```ts
export type AuditSeverity = 'debug' | 'info' | 'warn' | 'error';

export type AuditSource =
  | 'query'
  | 'tool'
  | 'permission'
  | 'sandbox'
  | 'command'
  | 'session'
  | 'file_persistence'
  | 'remote'
  | 'runner';

export type AuditEventType =
  | 'turn_started'
  | 'turn_completed'
  | 'turn_failed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'permission_requested'
  | 'permission_decision'
  | 'sandbox_decision'
  | 'command_started'
  | 'command_completed'
  | 'command_failed'
  | 'session_state_changed'
  | 'session_metadata_changed'
  | 'file_persistence_started'
  | 'file_persistence_completed'
  | 'remote_event_received'
  | 'remote_event_processing'
  | 'remote_event_processed'
  | 'remote_delivery_failed';

export type AuditEventBase = {
  id: string;
  type: AuditEventType;
  source: AuditSource;
  severity: AuditSeverity;
  sessionId: string;
  occurredAt: string;
  seq: number;
  turnId?: string;
  toolUseId?: string;
  requestId?: string;
  commandId?: string;
  remoteSessionId?: string;
  workerEpoch?: number;
};

export type PermissionDecisionAudit = AuditEventBase & {
  type: 'permission_decision';
  source: 'permission';
  payload: {
    toolName: string;
    behavior: 'allow' | 'deny' | 'ask';
    reason: string;
    mode: string;
    inputSummary: Record<string, unknown>;
  };
};

export type SandboxDecisionAudit = AuditEventBase & {
  type: 'sandbox_decision';
  source: 'sandbox';
  payload: {
    toolName: string;
    required: boolean;
    enabled: boolean;
    reason: string;
  };
};

export type CommandAudit = AuditEventBase & {
  type: 'command_started' | 'command_completed' | 'command_failed';
  source: 'command';
  payload: {
    commandHash: string;
    commandSummary: string;
    exitCode?: number;
    durationMs?: number;
  };
};

export type ToolAudit = AuditEventBase & {
  type: 'tool_started' | 'tool_completed' | 'tool_failed';
  source: 'tool';
  payload: {
    toolName: string;
    inputSummary?: Record<string, unknown>;
    durationMs?: number;
    errorType?: string;
  };
};

export type SessionAudit = AuditEventBase & {
  type: 'session_state_changed' | 'session_metadata_changed';
  source: 'session';
  payload: Record<string, unknown>;
};

export type FilePersistenceAudit = AuditEventBase & {
  type: 'file_persistence_started' | 'file_persistence_completed';
  source: 'file_persistence';
  payload: {
    successCount?: number;
    failureCount?: number;
    failed?: Array<{ filename: string; error: string }>;
    durationMs?: number;
  };
};

export type RemoteAudit = AuditEventBase & {
  type:
    | 'remote_event_received'
    | 'remote_event_processing'
    | 'remote_event_processed'
    | 'remote_delivery_failed';
  source: 'remote';
  payload: {
    eventId: string;
    eventType?: string;
    sequenceNum?: number;
    status?: string;
    reason?: string;
  };
};

export type AuditEvent =
  | PermissionDecisionAudit
  | SandboxDecisionAudit
  | CommandAudit
  | ToolAudit
  | SessionAudit
  | FilePersistenceAudit
  | RemoteAudit
  | (AuditEventBase & { payload: Record<string, unknown> });
```

几个设计点：

```txt
id
  单条 audit event 的唯一 ID

seq
  本进程内单调递增序号

occurredAt
  ISO 时间，方便跨进程查看

sessionId
  所有事件必须绑定 session

turnId
  一轮用户输入的追踪 ID

toolUseId
  对齐模型 tool_use

requestId
  对齐 permission request / control request

commandId
  对齐 command lifecycle

remoteSessionId / workerEpoch
  对齐 CCR / runner
```

不要只依赖时间排序。

同一毫秒内可能产生多条事件。

所以：

```txt
同一进程内用 seq 排序
跨进程用 occurredAt + source + remote sequence 排序
```

## 第二步：脱敏策略

新增：

```txt
src/observability/redaction.ts
```

写入：

```ts
const SECRET_KEY_PATTERN =
  /(token|secret|password|authorization|cookie|api[_-]?key|credential)/i;

const SECRET_VALUE_PATTERN =
  /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9._-]+|api[_-]?key=[^&\s]+)/i;

export function redactAuditValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => redactAuditValue(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }

    output[key] = redactAuditValue(child);
  }

  return output;
}

export function redactString(value: string): string {
  if (SECRET_VALUE_PATTERN.test(value)) {
    return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  }

  return value;
}

export function summarizeToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactAuditValue(input);

  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return {};
  }

  const summary: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(redacted)) {
    if (key === 'content' || key === 'fileContent') {
      summary[key] = '[OMITTED]';
      continue;
    }

    if (typeof value === 'string' && value.length > 240) {
      summary[key] = `${value.slice(0, 240)}...`;
      continue;
    }

    summary[key] = value;
  }

  return summary;
}
```

规则：

```txt
key 像 secret 就直接隐藏
value 像 secret 也隐藏
文件内容不进入 audit
长字符串截断
工具 input 只保留摘要
```

这和 diagnostics 的原则一致：

```txt
可排查，但不泄露
```

## 第三步：命令摘要与 hash

命令最敏感。

不要把完整 shell command 原样写进远程审计。

新增：

```txt
src/observability/commandAudit.ts
```

写入：

```ts
import { createHash } from 'node:crypto';
import { redactString } from './redaction';

export function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex').slice(0, 16);
}

export function summarizeCommand(command: string): string {
  const cleaned = redactString(command).replace(/\s+/g, ' ').trim();

  if (cleaned.length <= 120) {
    return cleaned;
  }

  return `${cleaned.slice(0, 120)}...`;
}
```

注意：

```txt
本地开发者自己的 audit 文件可以更详细
远程 server / diagnostics 只能记录 hash 和短摘要
```

Mini 先统一保守：

```txt
commandHash
commandSummary
```

## 第四步：Append-only Audit Sink

新增：

```txt
src/observability/auditSink.ts
```

写入：

```ts
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuditEvent, AuditEventBase, AuditEventType, AuditSource } from './auditTypes';
import { redactAuditValue } from './redaction';

let seq = 0;

export type AuditSinkOptions = {
  file?: string;
  sessionId: string;
  remoteSessionId?: string;
  workerEpoch?: number;
};

export class AuditSink {
  private readonly file?: string;
  private readonly sessionId: string;
  private readonly remoteSessionId?: string;
  private readonly workerEpoch?: number;

  constructor(options: AuditSinkOptions) {
    this.file = options.file;
    this.sessionId = options.sessionId;
    this.remoteSessionId = options.remoteSessionId;
    this.workerEpoch = options.workerEpoch;
  }

  createBase(
    type: AuditEventType,
    source: AuditSource,
    extra?: Partial<AuditEventBase>,
  ): AuditEventBase {
    return {
      id: randomUUID(),
      type,
      source,
      severity: extra?.severity ?? 'info',
      sessionId: this.sessionId,
      remoteSessionId: this.remoteSessionId,
      workerEpoch: this.workerEpoch,
      occurredAt: new Date().toISOString(),
      seq: ++seq,
      ...extra,
    };
  }

  async write(event: AuditEvent): Promise<void> {
    if (!this.file) {
      return;
    }

    const safeEvent = redactAuditValue(event);
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(safeEvent)}\n`, 'utf8');
  }
}
```

为什么是 JSONL：

```txt
一行一个事件
append 简单
进程崩溃时已写入的行仍可读
可以 tail
可以流式上传
可以增量读取
```

为什么写入失败不直接让主流程崩：

```txt
audit 是可观测性，不应破坏用户任务
但测试环境要能检测写入失败
生产环境可以降级到 diagnostics warn
```

Mini 可以先让 `write()` 抛错，集成时再封装为 best-effort。

## 第五步：审计计时器

新增：

```txt
src/observability/auditTiming.ts
```

写入：

```ts
import type { AuditEventType, AuditSource } from './auditTypes';
import type { AuditSink } from './auditSink';

export async function withAuditTiming<T>({
  sink,
  source,
  startedType,
  completedType,
  failedType,
  base,
  run,
}: {
  sink: AuditSink;
  source: AuditSource;
  startedType: AuditEventType;
  completedType: AuditEventType;
  failedType: AuditEventType;
  base: {
    turnId?: string;
    toolUseId?: string;
    commandId?: string;
    payload?: Record<string, unknown>;
  };
  run: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();

  await sink.write({
    ...sink.createBase(startedType, source, base),
    payload: base.payload ?? {},
  });

  try {
    const result = await run();
    await sink.write({
      ...sink.createBase(completedType, source, base),
      payload: {
        ...(base.payload ?? {}),
        durationMs: Date.now() - startedAt,
      },
    });
    return result;
  } catch (error) {
    await sink.write({
      ...sink.createBase(failedType, source, {
        ...base,
        severity: 'error',
      }),
      payload: {
        ...(base.payload ?? {}),
        durationMs: Date.now() - startedAt,
        errorType: error instanceof Error ? error.name : typeof error,
      },
    });
    throw error;
  }
}
```

这对应真实源码里的 `withDiagnosticsTiming()`。

区别：

```txt
withDiagnosticsTiming
  面向无 PII 诊断

withAuditTiming
  面向本地审计和 timeline
  可以包含脱敏后的工具摘要
```

## 第六步：包装工具调用

第 5 章到第 8 章里，Mini 应该已经有类似：

```ts
export type Tool = {
  name: string;
  call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
};
```

现在新增：

```txt
src/observability/toolAudit.ts
```

写入：

```ts
import type { AuditSink } from './auditSink';
import { summarizeToolInput } from './redaction';

export type AuditableTool = {
  name: string;
  call(
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<unknown>;
};

export function withToolAudit<T extends AuditableTool>(
  tool: T,
  sink: AuditSink,
): T {
  return {
    ...tool,
    async call(input, context) {
      const startedAt = Date.now();
      const toolUseId =
        typeof context.toolUseId === 'string' ? context.toolUseId : undefined;
      const turnId =
        typeof context.turnId === 'string' ? context.turnId : undefined;

      await sink.write({
        ...sink.createBase('tool_started', 'tool', {
          toolUseId,
          turnId,
        }),
        payload: {
          toolName: tool.name,
          inputSummary: summarizeToolInput(input),
        },
      });

      try {
        const result = await tool.call(input, context);
        await sink.write({
          ...sink.createBase('tool_completed', 'tool', {
            toolUseId,
            turnId,
          }),
          payload: {
            toolName: tool.name,
            durationMs: Date.now() - startedAt,
          },
        });
        return result;
      } catch (error) {
        await sink.write({
          ...sink.createBase('tool_failed', 'tool', {
            severity: 'error',
            toolUseId,
            turnId,
          }),
          payload: {
            toolName: tool.name,
            durationMs: Date.now() - startedAt,
            errorType: error instanceof Error ? error.name : typeof error,
          },
        });
        throw error;
      }
    },
  };
}
```

集成到工具注册处：

```ts
import { withToolAudit } from './observability/toolAudit';

export function buildTools(options: { auditSink: AuditSink }) {
  const tools = [
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    bashTool,
  ];

  return tools.map(tool => withToolAudit(tool, options.auditSink));
}
```

这一步以后，每个工具都有：

```txt
tool_started
tool_completed
tool_failed
```

## 第七步：包装权限判断

第 55 章里已经有 `canUseTool` 或类似函数。

现在把它包装起来。

新增：

```txt
src/observability/permissionAudit.ts
```

写入：

```ts
import type { AuditSink } from './auditSink';
import { summarizeToolInput } from './redaction';

export type PermissionDecision = {
  behavior: 'allow' | 'deny' | 'ask';
  reason: string;
};

export type PermissionCheck = (
  toolName: string,
  input: Record<string, unknown>,
  context: {
    mode: string;
    turnId?: string;
    toolUseId?: string;
    requestId?: string;
  },
) => Promise<PermissionDecision>;

export function withPermissionAudit(
  check: PermissionCheck,
  sink: AuditSink,
): PermissionCheck {
  return async (toolName, input, context) => {
    await sink.write({
      ...sink.createBase('permission_requested', 'permission', {
        turnId: context.turnId,
        toolUseId: context.toolUseId,
        requestId: context.requestId,
      }),
      payload: {
        toolName,
        mode: context.mode,
        inputSummary: summarizeToolInput(input),
      },
    });

    const decision = await check(toolName, input, context);

    await sink.write({
      ...sink.createBase('permission_decision', 'permission', {
        severity: decision.behavior === 'deny' ? 'warn' : 'info',
        turnId: context.turnId,
        toolUseId: context.toolUseId,
        requestId: context.requestId,
      }),
      payload: {
        toolName,
        behavior: decision.behavior,
        reason: decision.reason,
        mode: context.mode,
        inputSummary: summarizeToolInput(input),
      },
    });

    return decision;
  };
}
```

真实源码的 `QueryEngine` 已经收集 deny / ask 结果，最后放到 result 里。

Mini 的审计更细：

```txt
permission_requested
permission_decision
```

这样 timeline 能显示：

```txt
10:00:01 permission requested: Bash
10:00:02 decision ask: shell command needs approval
10:00:08 session requires_action cleared
10:00:09 command started
```

## 第八步：记录沙箱决策

第 55 章已经给 Bash 加了 sandbox policy。

现在把决策记下来。

新增：

```txt
src/observability/sandboxAudit.ts
```

写入：

```ts
import type { AuditSink } from './auditSink';

export type SandboxDecision = {
  required: boolean;
  enabled: boolean;
  reason: string;
};

export async function auditSandboxDecision({
  sink,
  toolName,
  decision,
  turnId,
  toolUseId,
}: {
  sink: AuditSink;
  toolName: string;
  decision: SandboxDecision;
  turnId?: string;
  toolUseId?: string;
}): Promise<void> {
  await sink.write({
    ...sink.createBase('sandbox_decision', 'sandbox', {
      severity: decision.required && !decision.enabled ? 'error' : 'info',
      turnId,
      toolUseId,
    }),
    payload: {
      toolName,
      required: decision.required,
      enabled: decision.enabled,
      reason: decision.reason,
    },
  });
}
```

在 Bash tool 中使用：

```ts
const sandboxDecision = decideSandbox(command, policy);

await auditSandboxDecision({
  sink: context.auditSink,
  toolName: 'Bash',
  decision: sandboxDecision,
  turnId: context.turnId,
  toolUseId: context.toolUseId,
});

if (sandboxDecision.required && !sandboxDecision.enabled) {
  throw new Error('Sandbox is required but unavailable');
}
```

这能解释很多远程问题：

```txt
为什么命令没有执行？
因为策略要求沙箱，但 runner 没有可用 sandbox runtime。

为什么某条命令自动执行了？
因为 sandbox enabled 且策略允许 sandboxed command auto allow。
```

## 第九步：记录命令生命周期

真实源码用：

```txt
notifyCommandLifecycle(uuid, 'started')
notifyCommandLifecycle(uuid, 'completed')
```

Mini 也做一个本地版本。

完善：

```txt
src/observability/commandAudit.ts
```

追加：

```ts
import type { AuditSink } from './auditSink';

export async function auditCommandStarted({
  sink,
  command,
  commandId,
  turnId,
  toolUseId,
}: {
  sink: AuditSink;
  command: string;
  commandId: string;
  turnId?: string;
  toolUseId?: string;
}): Promise<void> {
  await sink.write({
    ...sink.createBase('command_started', 'command', {
      commandId,
      turnId,
      toolUseId,
    }),
    payload: {
      commandHash: hashCommand(command),
      commandSummary: summarizeCommand(command),
    },
  });
}

export async function auditCommandCompleted({
  sink,
  command,
  commandId,
  exitCode,
  durationMs,
  turnId,
  toolUseId,
}: {
  sink: AuditSink;
  command: string;
  commandId: string;
  exitCode: number;
  durationMs: number;
  turnId?: string;
  toolUseId?: string;
}): Promise<void> {
  await sink.write({
    ...sink.createBase(
      exitCode === 0 ? 'command_completed' : 'command_failed',
      'command',
      {
        severity: exitCode === 0 ? 'info' : 'warn',
        commandId,
        turnId,
        toolUseId,
      },
    ),
    payload: {
      commandHash: hashCommand(command),
      commandSummary: summarizeCommand(command),
      exitCode,
      durationMs,
    },
  });
}
```

在 Bash tool 执行处：

```ts
const commandId = crypto.randomUUID();
const startedAt = Date.now();

await auditCommandStarted({
  sink: context.auditSink,
  command,
  commandId,
  turnId: context.turnId,
  toolUseId: context.toolUseId,
});

const result = await runShellCommand(command, sandbox);

await auditCommandCompleted({
  sink: context.auditSink,
  command,
  commandId,
  exitCode: result.exitCode,
  durationMs: Date.now() - startedAt,
  turnId: context.turnId,
  toolUseId: context.toolUseId,
});
```

如果你的 Mini 已经有远程 CCR delivery：

```txt
command_started
  -> reportDelivery(eventId, processing)

command_completed
  -> reportDelivery(eventId, processed)
```

这里不要混淆：

```txt
commandId
  本地命令执行 ID

eventId
  远程 client event ID

toolUseId
  模型 tool_use ID
```

三者可以有关联，但不是同一个东西。

## 第十步：记录 session state

新增：

```txt
src/observability/sessionAudit.ts
```

写入：

```ts
import type { AuditSink } from './auditSink';

export type MiniSessionState = 'idle' | 'running' | 'requires_action';

export type MiniRequiresActionDetails = {
  toolName: string;
  actionDescription: string;
  toolUseId: string;
  requestId: string;
  input?: Record<string, unknown>;
};

export async function auditSessionStateChanged({
  sink,
  state,
  details,
}: {
  sink: AuditSink;
  state: MiniSessionState;
  details?: MiniRequiresActionDetails;
}): Promise<void> {
  await sink.write({
    ...sink.createBase('session_state_changed', 'session', {
      severity: state === 'requires_action' ? 'warn' : 'info',
      toolUseId: details?.toolUseId,
      requestId: details?.requestId,
    }),
    payload: {
      state,
      details: details
        ? {
            toolName: details.toolName,
            actionDescription: details.actionDescription,
            toolUseId: details.toolUseId,
            requestId: details.requestId,
          }
        : undefined,
    },
  });
}

export async function auditSessionMetadataChanged({
  sink,
  metadata,
}: {
  sink: AuditSink;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await sink.write({
    ...sink.createBase('session_metadata_changed', 'session'),
    payload: metadata,
  });
}
```

集成位置：

```txt
query loop 开始
  -> running

permission prompt 出现
  -> requires_action

permission prompt 结束
  -> running

turn 结束且 SDK event flush 完成
  -> idle
```

真实源码里 `print.ts` 的顺序很值得参考：

```txt
run starts
  -> notifySessionStateChanged('running')

permission prompt
  -> notifySessionStateChanged('requires_action', details)

finally
  -> flushInternalEvents()
  -> notifySessionStateChanged('idle')
  -> drainSdkEvents()
```

关键点：

```txt
idle 应该在内部事件 flush 后发出
否则 UI 可能看到 idle，但 transcript 或尾部 SDK event 还没落盘
```

## 第十一步：记录 file persistence

真实源码在 BYOC file persistence 完成后会输出：

```txt
system / files_persisted
files
failed
processed_at
uuid
session_id
```

SDK schema 在 `SDKFilesPersistedEventSchema` 中定义。

Mini 也做同样的映射。

新增：

```txt
src/observability/filePersistenceAudit.ts
```

写入：

```ts
import type { AuditSink } from './auditSink';

export type FilePersistenceResult = {
  files: Array<{ filename: string; fileId: string }>;
  failed: Array<{ filename: string; error: string }>;
};

export async function auditFilePersistenceStarted({
  sink,
  turnId,
}: {
  sink: AuditSink;
  turnId?: string;
}): Promise<void> {
  await sink.write({
    ...sink.createBase('file_persistence_started', 'file_persistence', {
      turnId,
    }),
    payload: {},
  });
}

export async function auditFilePersistenceCompleted({
  sink,
  turnId,
  result,
  durationMs,
}: {
  sink: AuditSink;
  turnId?: string;
  result: FilePersistenceResult;
  durationMs: number;
}): Promise<void> {
  await sink.write({
    ...sink.createBase('file_persistence_completed', 'file_persistence', {
      severity: result.failed.length > 0 ? 'warn' : 'info',
      turnId,
    }),
    payload: {
      successCount: result.files.length,
      failureCount: result.failed.length,
      failed: result.failed.map(item => ({
        filename: item.filename,
        error: item.error,
      })),
      durationMs,
    },
  });
}
```

在 BYOC 输出上传后：

```ts
const startedAt = Date.now();
await auditFilePersistenceStarted({ sink, turnId });

const result = await persistOutputFiles();

await auditFilePersistenceCompleted({
  sink,
  turnId,
  result,
  durationMs: Date.now() - startedAt,
});

sdkOutput.enqueue({
  type: 'system',
  subtype: 'files_persisted',
  files: result.files.map(file => ({
    filename: file.filename,
    file_id: file.fileId,
  })),
  failed: result.failed,
  processed_at: new Date().toISOString(),
  uuid: crypto.randomUUID(),
  session_id: sessionId,
});
```

这里有两个事件：

```txt
audit file_persistence_completed
  给 timeline 和排查使用

SDK system/files_persisted
  给 SDK / remote UI 消费
```

不要只发其中一个。

## 第十二步：构建 Timeline Reader

新增：

```txt
src/observability/timeline.ts
```

写入：

```ts
import { readFile } from 'node:fs/promises';
import type { AuditEvent } from './auditTypes';

export type TimelineItem = {
  id: string;
  label: string;
  occurredAt: string;
  seq: number;
  severity: string;
  source: string;
  event: AuditEvent;
};

export async function readAuditEvents(file: string): Promise<AuditEvent[]> {
  const content = await readFile(file, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  });

  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditEvent);
}

export function buildTimeline(events: AuditEvent[]): TimelineItem[] {
  return [...events]
    .sort((a, b) => {
      const byTime =
        new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
      if (byTime !== 0) return byTime;
      return a.seq - b.seq;
    })
    .map(event => ({
      id: event.id,
      label: formatTimelineLabel(event),
      occurredAt: event.occurredAt,
      seq: event.seq,
      severity: event.severity,
      source: event.source,
      event,
    }));
}

export function formatTimelineLabel(event: AuditEvent): string {
  const payload = event.payload ?? {};

  if (event.type === 'permission_decision') {
    return `permission ${payload.behavior} ${payload.toolName}`;
  }

  if (event.type === 'tool_started') {
    return `tool started ${payload.toolName}`;
  }

  if (event.type === 'tool_completed') {
    return `tool completed ${payload.toolName}`;
  }

  if (event.type === 'command_started') {
    return `command started ${payload.commandSummary}`;
  }

  if (event.type === 'command_completed') {
    return `command completed exit=${payload.exitCode}`;
  }

  if (event.type === 'session_state_changed') {
    return `session ${payload.state}`;
  }

  if (event.type === 'file_persistence_completed') {
    return `files persisted ok=${payload.successCount} failed=${payload.failureCount}`;
  }

  return event.type;
}
```

再加一个 CLI 命令：

```txt
src/commands/timeline.ts
```

写入：

```ts
import { buildTimeline, readAuditEvents } from '../observability/timeline';

export async function timelineCommand(file: string): Promise<void> {
  const events = await readAuditEvents(file);
  const timeline = buildTimeline(events);

  for (const item of timeline) {
    const time = item.occurredAt.slice(11, 19);
    console.log(`${time} [${item.severity}] ${item.label}`);
  }
}
```

入口接上：

```ts
if (args[0] === 'timeline') {
  const file = args[1] ?? '.claude-code-mini/audit.jsonl';
  await timelineCommand(file);
  return;
}
```

运行：

```bash
bun run src/entrypoints/cli.tsx timeline .claude-code-mini/audit.jsonl
```

输出类似：

```txt
09:12:01 [info] session running
09:12:02 [info] tool started Bash
09:12:02 [info] permission allow Bash
09:12:02 [info] sandbox_decision
09:12:02 [info] command started bun test
09:12:05 [info] command completed exit=0
09:12:05 [info] tool completed Bash
09:12:05 [info] session idle
```

注意：这里 `bun test` 只是示例命令，不是教程构建命令。

## 第十三步：接入 Query Loop

在 Mini 的 query loop 中，为每轮创建 turnId：

```ts
import { randomUUID } from 'node:crypto';
import { AuditSink } from './observability/auditSink';

const auditSink = new AuditSink({
  file: process.env.CLAUDE_CODE_MINI_AUDIT_FILE ?? '.claude-code-mini/audit.jsonl',
  sessionId,
  remoteSessionId: process.env.CLAUDE_CODE_REMOTE_SESSION_ID,
});

async function runTurn(prompt: string) {
  const turnId = randomUUID();

  await auditSink.write({
    ...auditSink.createBase('turn_started', 'query', { turnId }),
    payload: {},
  });

  try {
    await setSessionState('running');
    const result = await agentLoop({ prompt, turnId, auditSink });
    await auditSink.write({
      ...auditSink.createBase('turn_completed', 'query', { turnId }),
      payload: {},
    });
    return result;
  } catch (error) {
    await auditSink.write({
      ...auditSink.createBase('turn_failed', 'query', {
        severity: 'error',
        turnId,
      }),
      payload: {
        errorType: error instanceof Error ? error.name : typeof error,
      },
    });
    throw error;
  } finally {
    await flushTranscript();
    await flushRemoteEvents();
    await setSessionState('idle');
  }
}
```

这里的顺序很重要：

```txt
turn_started
running
agent loop
turn_completed / turn_failed
flush transcript
flush remote events
idle
```

不要先发 idle 再 flush。

否则 Web UI 会提前显示结束，但恢复数据还没落地。

## 第十四步：接入 Remote Delivery

真实源码的 CCR v2 有三类上传器：

```txt
SerialBatchEventUploader<ClientEvent>
SerialBatchEventUploader<WorkerEvent>
SerialBatchEventUploader<delivery>
WorkerStateUploader
```

职责分别是：

```txt
client event
  worker 输出给远端 client 的 SDK 消息

internal event
  transcript / compaction / resume 使用

delivery
  event received / processing / processed

worker state
  running / idle / requires_action / metadata
```

Mini 可以先做一个简化接口：

```ts
export type RemoteDelivery = {
  reportDelivery(
    eventId: string,
    status: 'received' | 'processing' | 'processed',
  ): void;
};
```

然后把它接到 audit：

```ts
import type { AuditSink } from './auditSink';

export function createAuditedRemoteDelivery(
  remote: RemoteDelivery,
  sink: AuditSink,
): RemoteDelivery {
  return {
    reportDelivery(eventId, status) {
      remote.reportDelivery(eventId, status);

      const type =
        status === 'received'
          ? 'remote_event_received'
          : status === 'processing'
            ? 'remote_event_processing'
            : 'remote_event_processed';

      void sink.write({
        ...sink.createBase(type, 'remote'),
        payload: {
          eventId,
          status,
        },
      });
    },
  };
}
```

这样 timeline 可以显示：

```txt
remote received event abc
remote processing event abc
remote processed event abc
```

这对远程卡住问题非常关键。

例如：

```txt
received 有，processing 没有
  说明 child 没开始处理

processing 有，processed 没有
  说明工具执行中或 child 卡死

processed 有，SDK result 没有
  说明输出上传或 SSE 消费有问题
```

## 第十五步：RCS SSE Timeline

RCS 当前已有：

```txt
publishSessionEvent()
EventBus
createSSEStream()
createWorkerEventStream()
```

`publishSessionEvent()` 会把 payload normalize：

```txt
content
raw
uuid
status
subtype
tool_name
tool_input
request_id
request
approved
updated_input
message
```

这对 UI 足够。

但 timeline 需要更统一的展示。

在 RCS 中新增：

```txt
packages/remote-control-server/src/services/timeline.ts
```

写入：

```ts
import type { SessionEvent } from '../transport/event-bus';

export type RemoteTimelineItem = {
  id: string;
  sessionId: string;
  seqNum: number;
  occurredAt: string;
  direction: 'inbound' | 'outbound';
  type: string;
  label: string;
  payload: unknown;
};

export function toTimelineItem(event: SessionEvent): RemoteTimelineItem {
  return {
    id: event.id,
    sessionId: event.sessionId,
    seqNum: event.seqNum,
    occurredAt: new Date(event.createdAt).toISOString(),
    direction: event.direction,
    type: event.type,
    label: labelEvent(event),
    payload: event.payload,
  };
}

function labelEvent(event: SessionEvent): string {
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};

  if (event.type === 'permission_request') {
    return `permission request ${String(payload.tool_name ?? '')}`;
  }

  if (event.type === 'permission_response') {
    return `permission response approved=${String(payload.approved ?? '')}`;
  }

  if (event.type === 'tool_use') {
    return `tool use ${String(payload.tool_name ?? '')}`;
  }

  if (event.type === 'tool_result') {
    return 'tool result';
  }

  if (event.type === 'status') {
    return `status ${String(payload.status ?? '')}`;
  }

  if (event.type === 'automation_state') {
    return 'automation state';
  }

  return event.type;
}
```

然后增加 route：

```txt
packages/remote-control-server/src/routes/v2/timeline.ts
```

写入：

```ts
import { Hono } from 'hono';
import { sessionIngressAuth, acceptCliHeaders } from '../../auth/middleware';
import { getSession } from '../../services/session';
import { getEventBus } from '../../transport/event-bus';
import { toTimelineItem } from '../../services/timeline';

const app = new Hono();

app.get('/:id/timeline', acceptCliHeaders, sessionIngressAuth, async c => {
  const sessionId = c.req.param('id')!;

  if (!getSession(sessionId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    );
  }

  const fromSeq = c.req.query('from_sequence_num');
  const fromSeqNum = fromSeq ? parseInt(fromSeq, 10) : 0;
  const events = getEventBus(sessionId).getEventsSince(fromSeqNum);

  return c.json(
    {
      data: events.map(toTimelineItem),
      next_sequence_num: getEventBus(sessionId).getLastSeqNum(),
    },
    200,
  );
});

export default app;
```

如果你的 RCS 已经有统一 route index，把这个 route 挂进去。

不要用 timeline 代替 SSE。

两者职责不同：

```txt
SSE
  实时推送

timeline GET
  断线后补查
  页面刷新后重建
  排障导出
```

## 第十六步：Web 控制台如何展示

Timeline UI 不需要复杂。

最小形态：

```txt
time
severity
direction
source/type
label
details button
```

示例：

```txt
09:10:11 inbound  user                 "修复测试"
09:10:13 inbound  assistant            "我会先检查..."
09:10:14 outbound permission_request   Bash
09:10:18 inbound  permission_response  approved=true
09:10:18 inbound  tool_use             Bash
09:10:21 inbound  tool_result          exit=0
09:10:21 inbound  files_persisted      ok=2 failed=0
09:10:21 worker   state                idle
```

不要默认展开 raw payload。

默认只展示摘要。

详情区域也要脱敏：

```txt
authorization -> [REDACTED]
token -> [REDACTED]
cookie -> [REDACTED]
file content -> [OMITTED]
long text -> truncated
```

## 第十七步：权限请求的完整 timeline

现在看一个完整权限请求：

```txt
assistant emits tool_use Bash
  -> tool_started
  -> permission_requested
  -> session_state_changed requires_action
  -> CCR reportState requires_action
  -> RCS worker external_metadata.pending_action
  -> Web permission dialog
  -> permission_response approved
  -> session_state_changed running
  -> permission_decision allow
  -> sandbox_decision enabled
  -> command_started
  -> command_completed
  -> tool_completed
  -> turn_completed
  -> flush internal events
  -> session_state_changed idle
```

如果卡在询问：

```txt
最后一条通常是 requires_action
pending_action 中有 requestId
```

如果用户点了允许但命令没跑：

```txt
permission_response 有
permission_decision allow 没有
```

说明 response 没回到 child 或 requestId 不匹配。

如果命令开始但不结束：

```txt
command_started 有
command_completed 没有
```

说明执行器卡住、进程未退出、超时逻辑缺失，或 sandbox runtime 不返回。

## 第十八步：文件持久化的完整 timeline

BYOC 输出文件链路：

```txt
turn starts
tool writes output file
turn completed
file_persistence_started
scan outputs dir
upload modified files
file_persistence_completed
SDK files_persisted
remote event uploaded
idle
```

排障规则：

```txt
没有 file_persistence_started
  检查 feature、environment kind、remote session id、session access token

started 有，completed 没有
  检查扫描或上传是否卡住

completed failed > 0
  检查上传错误

completed ok > 0，但 Web 不显示
  检查 SDK system/files_persisted 是否上传到 CCR
```

真实源码的启用条件是：

```txt
FILE_PERSISTENCE feature
environment kind = byoc
session ingress token exists
CLAUDE_CODE_REMOTE_SESSION_ID exists
```

Mini 也应该保持同样思路。

## 第十九步：区分本地审计与远程审计

不要把本地所有审计都上传到远程。

推荐分级：

| 事件 | 本地 JSONL | SDK stream | CCR worker | diagnostics |
| --- | --- | --- | --- | --- |
| turn_started | 是 | 可选 | 可选 | 否 |
| tool_started | 是 | 可选 | 可选 | 否 |
| permission_requested | 是 | 控制消息 | 是 | 否 |
| permission_decision | 是 | result 汇总 | 可选 | 否 |
| sandbox_decision | 是 | 否 | 可选摘要 | 可选无 PII |
| command_started | 是 | 否 | delivery processing | 可选无 PII |
| command_completed | 是 | 否 | delivery processed | 可选无 PII |
| files_persisted | 是 | 是 | 是 | 可选无 PII |
| session_state_changed | 是 | 可选 | 是 | 否 |
| worker request failed | 可选 | 否 | 否 | 是 |

核心原则：

```txt
diagnostics 最干净
SDK 给产品功能
CCR 给远程同步
本地 audit 给开发者排查
transcript 给恢复
```

## 第二十步：测试脱敏

新增：

```txt
src/observability/__tests__/redaction.test.ts
```

写入：

```ts
import { describe, expect, test } from 'bun:test';
import { redactAuditValue, summarizeToolInput } from '../redaction';

describe('redaction', () => {
  test('redacts secret-looking keys', () => {
    expect(
      redactAuditValue({
        token: 'abc',
        nested: {
          apiKey: 'def',
        },
      }),
    ).toEqual({
      token: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
      },
    });
  });

  test('omits file content from tool summary', () => {
    expect(
      summarizeToolInput({
        filePath: 'src/index.ts',
        content: 'very long file content',
      }),
    ).toEqual({
      filePath: 'src/index.ts',
      content: '[OMITTED]',
    });
  });

  test('truncates long strings', () => {
    const summary = summarizeToolInput({
      value: 'a'.repeat(300),
    });

    expect(String(summary.value).length).toBeLessThan(260);
  });
});
```

运行：

```bash
bun test src/observability/__tests__/redaction.test.ts
```

## 第二十一步：测试 Audit Sink

新增：

```txt
src/observability/__tests__/auditSink.test.ts
```

写入：

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { AuditSink } from '../auditSink';

describe('AuditSink', () => {
  test('writes one json line per event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mini-audit-'));
    const file = join(dir, 'audit.jsonl');

    try {
      const sink = new AuditSink({
        file,
        sessionId: 'session-1',
      });

      await sink.write({
        ...sink.createBase('turn_started', 'query'),
        payload: {},
      });

      const lines = (await readFile(file, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).sessionId).toBe('session-1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

运行：

```bash
bun test src/observability/__tests__/auditSink.test.ts
```

## 第二十二步：测试 Timeline 排序

新增：

```txt
src/observability/__tests__/timeline.test.ts
```

写入：

```ts
import { describe, expect, test } from 'bun:test';
import { buildTimeline } from '../timeline';
import type { AuditEvent } from '../auditTypes';

function event(seq: number, type: AuditEvent['type']): AuditEvent {
  return {
    id: String(seq),
    type,
    source: 'query',
    severity: 'info',
    sessionId: 'session-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    seq,
    payload: {},
  };
}

describe('buildTimeline', () => {
  test('uses seq when timestamp is equal', () => {
    const timeline = buildTimeline([
      event(2, 'turn_completed'),
      event(1, 'turn_started'),
    ]);

    expect(timeline.map(item => item.seq)).toEqual([1, 2]);
  });
});
```

运行：

```bash
bun test src/observability/__tests__/timeline.test.ts
```

## 第二十三步：测试权限审计

新增：

```txt
src/observability/__tests__/permissionAudit.test.ts
```

写入：

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { AuditSink } from '../auditSink';
import { withPermissionAudit } from '../permissionAudit';

describe('withPermissionAudit', () => {
  test('records request and decision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mini-permission-audit-'));
    const file = join(dir, 'audit.jsonl');

    try {
      const sink = new AuditSink({ file, sessionId: 'session-1' });
      const check = withPermissionAudit(async () => {
        return { behavior: 'deny', reason: 'test rule' };
      }, sink);

      await check(
        'Bash',
        { command: 'echo hello' },
        {
          mode: 'default',
          toolUseId: 'tool-1',
          requestId: 'request-1',
        },
      );

      const events = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));

      expect(events.map(event => event.type)).toEqual([
        'permission_requested',
        'permission_decision',
      ]);
      expect(events[1].payload.behavior).toBe('deny');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

运行：

```bash
bun test src/observability/__tests__/permissionAudit.test.ts
```

## 第二十四步：测试 Session State

新增：

```txt
src/observability/__tests__/sessionAudit.test.ts
```

写入：

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { AuditSink } from '../auditSink';
import { auditSessionStateChanged } from '../sessionAudit';

describe('auditSessionStateChanged', () => {
  test('records requires action details without raw input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mini-session-audit-'));
    const file = join(dir, 'audit.jsonl');

    try {
      const sink = new AuditSink({ file, sessionId: 'session-1' });

      await auditSessionStateChanged({
        sink,
        state: 'requires_action',
        details: {
          toolName: 'Bash',
          actionDescription: 'Run project check',
          toolUseId: 'tool-1',
          requestId: 'request-1',
          input: { command: 'hidden from audit event' },
        },
      });

      const event = JSON.parse((await readFile(file, 'utf8')).trim());
      expect(event.payload.state).toBe('requires_action');
      expect(event.payload.details.toolName).toBe('Bash');
      expect(event.payload.details.input).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

运行：

```bash
bun test src/observability/__tests__/sessionAudit.test.ts
```

## 第二十五步：端到端检查

跑本章相关测试：

```bash
bun test src/observability
```

跑类型检查：

```bash
bun run typecheck
```

跑一个简单 prompt，并指定 audit 文件：

```bash
CLAUDE_CODE_MINI_AUDIT_FILE=.claude-code-mini/audit.jsonl bun run src/entrypoints/cli.tsx -p "列出当前目录"
```

查看 timeline：

```bash
bun run src/entrypoints/cli.tsx timeline .claude-code-mini/audit.jsonl
```

如果你的 Mini 没有 `-p`，就用你自己的 headless 入口。

关键是：

```txt
同一轮能看到 turn_started / running / tool / permission / command / idle
```

## 常见错误

### 错误一：把 diagnostics 当 audit

错误做法：

```txt
diagnostics 写入 tool input
diagnostics 写入完整 command
diagnostics 写入文件路径
```

正确做法：

```txt
diagnostics 只写无 PII 状态
audit 写脱敏摘要
transcript 写会话恢复所需内容
```

### 错误二：只记录失败

只记录失败会导致：

```txt
你知道坏了
但不知道坏之前发生了什么
```

审计必须记录：

```txt
started
completed
failed
decision
state transition
```

### 错误三：没有统一 ID

缺少 ID 会导致 timeline 拼不起来。

至少保留：

```txt
sessionId
turnId
toolUseId
requestId
commandId
eventId
seq
```

### 错误四：idle 发得太早

错误顺序：

```txt
tool completed
idle
flush transcript
flush remote event
```

正确顺序：

```txt
tool completed
flush transcript
flush remote event
idle
```

### 错误五：远程 metadata 和 SDK status 分叉

真实源码通过 `onChangeAppState` 做了一个集中点：

```txt
permission mode 变化
  -> notifySessionMetadataChanged
  -> notifyPermissionModeChanged
```

Mini 也应该避免每个 UI 操作自己随手发事件。

正确做法：

```txt
状态变更统一进 session state store
store diff 统一发 metadata / SDK / audit
```

### 错误六：把 internal event 展示给用户

CCR internal event 是恢复用的。

不要直接展示成聊天消息。

应该展示：

```txt
SDK event
RCS normalized event
audit timeline event
```

internal event 只用于：

```txt
hydrate
resume
debug hidden panel
```

## 本章完成后的能力

现在 Mini 已经不只是“会执行工具”。

它开始具备官方 Claude Code 很重要的一部分工程能力：

```txt
每个工具调用可以追踪
每个权限判断可以解释
每个沙箱决策可以复盘
每个命令开始和结束可以定位
每个远程事件可以查 delivery
每个 session state transition 可以同步到 UI
每个输出文件持久化结果可以回放
每条 timeline 都能脱敏展示
```

这会直接提升三个场景：

```txt
本地调试
  为什么这轮没继续？

远程控制
  Web 端为什么显示 requires_action？

BYOC runner
  为什么任务完成了但输出文件没有出现？
```

## 和官方 Claude Code 的差距

本章 Mini 仍然是简化版。

官方级别还会继续增强：

```txt
事件批量上传与 backpressure
delivery retry 与 drop metrics
worker epoch mismatch 检测
多客户端一致性
session replay 中的 parentUuid 修复
subagent internal event merge
自动化任务 sleep / standby metadata
更细粒度的 tool progress
Web UI 中的 live timeline filter
可导出的 session bundle
```

但从架构上，Mini 已经有了正确骨架：

```txt
emit
redact
persist
upload
stream
replay
render
```

下一章可以继续补 **官方级命令队列、取消、中断与后台任务协同**：把用户 interrupt、tool cancellation、remote stop、daemon work cancellation、session idle 统一成可恢复的控制流。
