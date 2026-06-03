# 第 57 章：命令队列、取消、中断与后台任务协同

第 56 章补完了可观测性：

```txt
audit event
timeline
permission decision
sandbox decision
command lifecycle
file persistence
CCR delivery
session state
SSE replay
```

有了 timeline 之后，一个更底层的问题会暴露出来：

```txt
用户连续输入时，命令怎么排队？
远程 interrupt 到达时，正在跑的 turn 怎么停？
工具被取消后，缺失的 tool_result 怎么补？
后台任务完成后，结果怎么重新喂给模型？
用户取消一条未执行的 async message，队列里怎么移除？
模型想停止后台任务，应该杀哪个 task？
远程 Web 点击 Stop，应该发 control_request 还是直接改状态？
daemon 停止时，worker 和子 session 怎么收尾？
什么时候才能把 session 标记为 idle？
```

这些问题如果处理不好，Agent 会出现非常典型的坏状态：

```txt
UI 显示 idle，但后台任务还没通知模型
用户按 Stop 后模型继续输出
工具被中断后缺少 tool_result，下一轮 API 报错
远程 permission 弹窗已经消失，但 worker 还停在 requires_action
后台命令完成了，但结果没有进入下一轮上下文
daemon 停止后 child process 残留
```

官方 Claude Code 的交互质量，很大一部分来自这条控制流：

```txt
input
  -> queue
  -> drain
  -> abort signal
  -> tool execution
  -> task registry
  -> task notification
  -> SDK event
  -> transcript flush
  -> remote delivery
  -> idle
```

本章目标：

- 梳理统一命令队列
- 梳理 `now / next / later` 优先级
- 梳理 prompt batching
- 梳理 queue operation transcript
- 梳理 interrupt / end_session / cancel_async_message
- 梳理 AbortController 生命周期
- 梳理 streaming abort 与 tools abort
- 梳理 missing tool_result 补齐
- 梳理 Bash foreground / background / progress
- 梳理 Ctrl+B 后台化
- 梳理后台 task notification
- 梳理 TaskStop 与 SDK `stop_task`
- 梳理 RCS Web interrupt
- 梳理 daemon supervisor stop
- 给 Mini 增加一套可恢复的控制流

到本章结束，你的 Mini 会具备：

- module-level command queue
- priority dequeue
- queue subscriber
- prompt command batching
- command lifecycle event
- per-turn abort controller
- child abort controller
- user interrupt
- remote interrupt
- end session
- cancel queued async message
- stop task control request
- task registry
- background shell task
- background task notification
- held-back result
- flush-before-idle
- daemon worker stop
- 控制流测试矩阵

第 56 章回答：

```txt
发生了什么
```

第 57 章回答：

```txt
发生中断、取消、后台完成时，系统如何保持状态一致
```

## 参考源码

本章参考这些真实模块：

```txt
src/types/textInputTypes.ts
src/types/command.ts
src/utils/messageQueueManager.ts
src/utils/queueProcessor.ts
src/utils/autonomyQueueLifecycle.ts
src/cli/print.ts
src/cli/structuredIO.ts
src/cli/remoteIO.ts

src/query.ts
src/QueryEngine.ts
src/utils/abortController.ts
src/utils/combinedAbortSignal.ts
src/utils/gracefulShutdown.ts

packages/builtin-tools/src/tools/BashTool/BashTool.tsx
packages/builtin-tools/src/tools/BashTool/UI.tsx
src/tasks.ts
src/tasks/types.ts
src/tasks/stopTask.ts
src/tasks/LocalShellTask/LocalShellTask.tsx
src/tasks/LocalShellTask/killShellTasks.ts
src/tasks/LocalAgentTask/LocalAgentTask.tsx
src/tasks/RemoteAgentTask/RemoteAgentTask.tsx
packages/builtin-tools/src/tools/TaskStopTool/TaskStopTool.ts

src/remote/RemoteSessionManager.ts
src/remote/SessionsWebSocket.ts
src/bridge/remoteInterruptHandling.ts
packages/remote-control-server/src/routes/web/control.ts
packages/remote-control-server/src/transport/client-payload.ts
packages/remote-control-server/src/transport/sse-writer.ts

src/daemon/main.ts
src/daemon/state.ts
src/daemon/workerRegistry.ts
packages/acp-link/src/server.ts
```

这些源码体现了一个原则：

```txt
取消不是一个 boolean。
取消是一条跨 queue、turn、tool、task、remote、daemon 的控制流。
```

## 总体模型

先看完整链路：

```txt
user input / remote event / scheduled task / task notification
  -> enqueue QueuedCommand
  -> queue subscriber wakes run loop
  -> drainCommandQueue
  -> batch prompt commands
  -> create fresh AbortController
  -> ask / query loop
  -> stream model output
  -> execute tools
  -> spawn background tasks if needed
  -> collect task notifications
  -> flush SDK events
  -> flush transcript / CCR internal events
  -> mark session idle
```

中断链路：

```txt
local escape / remote interrupt / end_session / daemon stop
  -> abort active controller
  -> query sees aborted signal
  -> streaming/tool execution stops
  -> missing tool_result blocks are synthesized
  -> task cleanup runs
  -> SDK result or control response is emitted
  -> run loop reaches finally
  -> flush
  -> idle or shutdown
```

后台任务链路：

```txt
Bash / Agent decides background
  -> register task
  -> return backgroundTaskId to model
  -> task continues out-of-turn
  -> task completes / fails / stops
  -> enqueue task-notification command
  -> run loop drains notification
  -> model sees result
  -> held-back result is released
```

远程链路：

```txt
Web POST interrupt
  -> RCS publishes outbound interrupt
  -> worker SSE emits control_request interrupt
  -> CLI structured input receives interrupt
  -> active abortController aborts
  -> child turn stops
  -> worker state returns idle
```

## 命令队列是什么

官方实现里，`src/utils/messageQueueManager.ts` 是 module-level queue。

它不是 React state。

原因是：

```txt
REPL UI 需要订阅队列变化
headless print loop 需要直接读队列
remote input 不一定经过 React
task notification 可能来自后台 async callback
scheduled task 可能在输入流关闭后触发
```

所以队列必须独立于 UI。

核心形态：

```txt
commandQueue: QueuedCommand[]
snapshot: readonly QueuedCommand[]
subscribeToCommandQueue
enqueue
dequeue
peek
dequeueAllMatching
remove
removeByFilter
clearCommandQueue
```

每次变更都会：

```txt
更新 frozen snapshot
通知 subscriber
记录 queue operation
```

真实源码还会把 queue operation 写入 transcript：

```txt
enqueue
dequeue
remove
```

这不是为了聊天展示，而是为了排查：

```txt
为什么消息丢了？
为什么远程消息没有被处理？
为什么某个 async message 被取消后没有继续？
```

## QueuedCommand 字段

`src/types/textInputTypes.ts` 中的 `QueuedCommand` 很关键。

精简后可以理解为：

```ts
export type QueuePriority = 'now' | 'next' | 'later';

export type QueuedCommand = {
  value: string | Array<ContentBlockParam>;
  mode: PromptInputMode;
  priority?: QueuePriority;
  uuid?: string;
  skipSlashCommands?: boolean;
  bridgeOrigin?: boolean;
  isMeta?: boolean;
  workload?: string;
  agentId?: string;
  orphanedPermission?: OrphanedPermission;
  autonomy?: {
    runId: string;
    rootDir?: string;
    trigger: 'scheduled-task' | 'proactive-tick' | 'managed-flow-step';
    sourceId?: string;
    sourceLabel?: string;
    flowId?: string;
    flowStepId?: string;
    flowStepName?: string;
  };
};
```

字段含义：

| 字段 | 作用 |
| --- | --- |
| `value` | 真正要进入模型或本地命令的内容 |
| `mode` | prompt、bash、task-notification、orphaned-permission 等 |
| `priority` | 决定何时被 drain |
| `uuid` | 对齐 remote event / replay / delivery |
| `skipSlashCommands` | 远程消息默认不要触发本地 slash command |
| `bridgeOrigin` | 远程桥接来的 slash command 需要做 bridge-safe 过滤 |
| `isMeta` | 对模型可见，但 UI transcript 可隐藏 |
| `workload` | 跨异步边界保留任务归因 |
| `agentId` | 子 agent 的 notification 不泄漏到 main thread |
| `orphanedPermission` | 恢复晚到的 permission response |
| `autonomy` | 自动化 run 的持久化生命周期 |

这说明 queue 不是简单的 string list。

它承载了：

```txt
权限恢复
远程安全
子 agent 隔离
自动化生命周期
计费归因
delivery ack
```

## 优先级语义

真实优先级：

```txt
now
next
later
```

可以理解为：

```txt
now
  打断当前等待，尽快处理

next
  普通用户输入，下一轮处理

later
  后台通知、自动化后续步骤，不抢用户输入
```

第 54 到 56 章里出现的很多“状态不一致”，都能用优先级解释。

例如：

```txt
task notification 默认 later
  防止后台任务完成消息打断用户刚输入的新 prompt

interactive prompt stall notification 可以 next
  因为它需要模型尽快处理被卡住的命令

remote immediate command 可以 now
  因为用户正在远端明确要求取消或接管
```

Mini 不要一开始就做十几种模式。

但至少保留：

```txt
now > next > later
同优先级 FIFO
```

## 第一步：实现 Mini Command Queue

新增：

```txt
src/control/commandQueue.ts
```

写入：

```ts
export type QueuePriority = 'now' | 'next' | 'later';

export type CommandMode =
  | 'prompt'
  | 'task-notification'
  | 'orphaned-permission'
  | 'bash';

export type QueuedCommand = {
  value: string;
  mode: CommandMode;
  priority?: QueuePriority;
  uuid?: string;
  skipSlashCommands?: boolean;
  bridgeOrigin?: boolean;
  isMeta?: boolean;
  agentId?: string;
  workload?: string;
};

type Subscriber = () => void;

const queue: QueuedCommand[] = [];
const subscribers = new Set<Subscriber>();

const priorityOrder: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
};

function normalize(command: QueuedCommand): QueuedCommand {
  return {
    ...command,
    priority: command.priority ?? 'next',
  };
}

function notify(): void {
  for (const subscriber of subscribers) {
    subscriber();
  }
}

export function subscribeToCommandQueue(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function enqueue(command: QueuedCommand): void {
  queue.push(normalize(command));
  notify();
}

export function hasCommandsInQueue(): boolean {
  return queue.length > 0;
}

export function peek(
  filter?: (command: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const index = findBestIndex(filter);
  return index === -1 ? undefined : queue[index];
}

export function dequeue(
  filter?: (command: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const index = findBestIndex(filter);
  if (index === -1) {
    return undefined;
  }

  const [command] = queue.splice(index, 1);
  notify();
  return command;
}

export function dequeueAllMatching(
  predicate: (command: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = [];
  const remaining: QueuedCommand[] = [];

  for (const command of queue) {
    if (predicate(command)) {
      matched.push(command);
    } else {
      remaining.push(command);
    }
  }

  if (matched.length === 0) {
    return [];
  }

  queue.length = 0;
  queue.push(...remaining);
  notify();
  return matched.sort(comparePriority);
}

export function removeByUuid(uuid: string): QueuedCommand[] {
  const removed: QueuedCommand[] = [];

  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index]?.uuid === uuid) {
      removed.unshift(queue.splice(index, 1)[0]!);
    }
  }

  if (removed.length > 0) {
    notify();
  }

  return removed;
}

export function clearCommandQueue(): void {
  if (queue.length === 0) {
    return;
  }

  queue.length = 0;
  notify();
}

export function resetCommandQueueForTests(): void {
  queue.length = 0;
  subscribers.clear();
}

function findBestIndex(
  filter?: (command: QueuedCommand) => boolean,
): number {
  let bestIndex = -1;
  let bestPriority = Number.POSITIVE_INFINITY;

  for (let index = 0; index < queue.length; index++) {
    const command = queue[index]!;
    if (filter && !filter(command)) {
      continue;
    }

    const priority = priorityOrder[command.priority ?? 'next'];
    if (priority < bestPriority) {
      bestIndex = index;
      bestPriority = priority;
    }
  }

  return bestIndex;
}

function comparePriority(a: QueuedCommand, b: QueuedCommand): number {
  return priorityOrder[a.priority ?? 'next'] - priorityOrder[b.priority ?? 'next'];
}
```

这个实现保留了关键能力：

```txt
优先级
过滤
批量移除
订阅
测试重置
```

后续再接 transcript audit。

## 第二步：实现 Control Request

新增：

```txt
src/control/controlTypes.ts
```

写入：

```ts
export type ControlRequest =
  | {
      type: 'control_request';
      request_id: string;
      request: { subtype: 'interrupt' };
    }
  | {
      type: 'control_request';
      request_id: string;
      request: { subtype: 'end_session'; reason?: string };
    }
  | {
      type: 'control_request';
      request_id: string;
      request: { subtype: 'cancel_async_message'; message_uuid: string };
    }
  | {
      type: 'control_request';
      request_id: string;
      request: { subtype: 'stop_task'; task_id: string };
    };

export type ControlResponse =
  | {
      type: 'control_response';
      response: {
        subtype: 'success';
        request_id: string;
        response?: Record<string, unknown>;
      };
    }
  | {
      type: 'control_response';
      response: {
        subtype: 'error';
        request_id: string;
        error: string;
      };
    };

export function successResponse(
  request: ControlRequest,
  response?: Record<string, unknown>,
): ControlResponse {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: request.request_id,
      response,
    },
  };
}

export function errorResponse(
  request: ControlRequest,
  error: string,
): ControlResponse {
  return {
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: request.request_id,
      error,
    },
  };
}
```

真实源码里 control request 很多。

Mini 先实现四个：

```txt
interrupt
end_session
cancel_async_message
stop_task
```

它们覆盖了主要取消场景。

## 第三步：AbortController 工具

新增：

```txt
src/control/abort.ts
```

写入：

```ts
export function createTurnAbortController(): AbortController {
  return new AbortController();
}

export function createChildAbortController(
  parent: AbortController,
): AbortController {
  const child = new AbortController();

  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
    return child;
  }

  const abortChild = () => {
    child.abort(parent.signal.reason);
  };

  parent.signal.addEventListener('abort', abortChild, { once: true });
  child.signal.addEventListener(
    'abort',
    () => parent.signal.removeEventListener('abort', abortChild),
    { once: true },
  );

  return child;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'APIUserAbortError')
  );
}
```

设计规则：

```txt
每个 turn 一个 controller
每个子任务可以有 child controller
父 abort 会传给子
子 abort 不影响父
turn 结束后必须丢弃旧 controller
下一轮必须创建新的 controller
```

真实 `QueryEngine` 也有：

```txt
interrupt()
  abort current controller

resetAbortController()
  next submitMessage 使用 fresh signal
```

Mini 也要坚持：

```txt
被 abort 的 controller 不可复用
```

## 第四步：Task Registry

新增：

```txt
src/tasks/taskTypes.ts
```

写入：

```ts
export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export type TaskStateBase = {
  id: string;
  type: string;
  description: string;
  status: TaskStatus;
  toolUseId?: string;
  startedAt: number;
  endedAt?: number;
  notified?: boolean;
  isBackgrounded?: boolean;
};

export type TaskImplementation = {
  type: string;
  kill(taskId: string): Promise<void> | void;
};
```

新增：

```txt
src/tasks/taskRegistry.ts
```

写入：

```ts
import type { TaskImplementation, TaskStateBase } from './taskTypes';

const states = new Map<string, TaskStateBase>();
const implementations = new Map<string, TaskImplementation>();

export function registerTaskImplementation(impl: TaskImplementation): void {
  implementations.set(impl.type, impl);
}

export function registerTask(task: TaskStateBase): void {
  states.set(task.id, task);
}

export function updateTask(
  taskId: string,
  update: (task: TaskStateBase) => TaskStateBase,
): void {
  const current = states.get(taskId);
  if (!current) {
    return;
  }

  states.set(taskId, update(current));
}

export function getTask(taskId: string): TaskStateBase | undefined {
  return states.get(taskId);
}

export function getRunningTasks(): TaskStateBase[] {
  return [...states.values()].filter(task => task.status === 'running');
}

export function getTaskImplementation(
  type: string,
): TaskImplementation | undefined {
  return implementations.get(type);
}

export function resetTasksForTests(): void {
  states.clear();
  implementations.clear();
}
```

再新增：

```txt
src/tasks/stopTask.ts
```

写入：

```ts
import {
  getTask,
  getTaskImplementation,
  updateTask,
} from './taskRegistry';

export class StopTaskError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  ) {
    super(message);
    this.name = 'StopTaskError';
  }
}

export async function stopTask(taskId: string): Promise<{
  taskId: string;
  taskType: string;
  description: string;
}> {
  const task = getTask(taskId);
  if (!task) {
    throw new StopTaskError(`No task found with ID: ${taskId}`, 'not_found');
  }

  if (task.status !== 'running') {
    throw new StopTaskError(
      `Task ${taskId} is not running`,
      'not_running',
    );
  }

  const impl = getTaskImplementation(task.type);
  if (!impl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    );
  }

  await impl.kill(taskId);

  updateTask(taskId, current => ({
    ...current,
    status: 'killed',
    endedAt: Date.now(),
    notified: true,
  }));

  return {
    taskId,
    taskType: task.type,
    description: task.description,
  };
}
```

真实实现也是这个思路：

```txt
stopTask
  -> lookup appState.tasks
  -> validate running
  -> get task impl by type
  -> taskImpl.kill
  -> suppress duplicate notification if needed
  -> emit SDK terminal event if notification was suppressed
```

## 第五步：Session Runtime

新增：

```txt
src/control/sessionRuntime.ts
```

写入：

```ts
import { randomUUID } from 'node:crypto';
import {
  dequeue,
  enqueue,
  hasCommandsInQueue,
  peek,
  removeByUuid,
  type QueuedCommand,
} from './commandQueue';
import {
  type ControlRequest,
  type ControlResponse,
  successResponse,
  errorResponse,
} from './controlTypes';
import { createTurnAbortController } from './abort';
import { getRunningTasks } from '../tasks/taskRegistry';
import { stopTask } from '../tasks/stopTask';

export type SessionRuntimeOptions = {
  ask(input: {
    value: string;
    uuid?: string;
    abortController: AbortController;
  }): Promise<void>;
  writeControlResponse(response: ControlResponse): void;
  writeEvent(event: Record<string, unknown>): void;
  flush(): Promise<void>;
};

export class SessionRuntime {
  private running = false;
  private inputClosed = false;
  private abortController: AbortController | null = null;

  constructor(private readonly options: SessionRuntimeOptions) {}

  enqueuePrompt(value: string): void {
    enqueue({
      mode: 'prompt',
      value,
      uuid: randomUUID(),
      priority: 'next',
    });
    void this.run();
  }

  async handleControlRequest(request: ControlRequest): Promise<void> {
    const subtype = request.request.subtype;

    if (subtype === 'interrupt') {
      this.abortController?.abort('interrupt');
      this.options.writeControlResponse(successResponse(request));
      return;
    }

    if (subtype === 'end_session') {
      this.inputClosed = true;
      this.abortController?.abort('end_session');
      this.options.writeControlResponse(successResponse(request));
      return;
    }

    if (subtype === 'cancel_async_message') {
      const removed = removeByUuid(request.request.message_uuid);
      this.options.writeControlResponse(
        successResponse(request, { cancelled: removed.length > 0 }),
      );
      return;
    }

    if (subtype === 'stop_task') {
      try {
        await stopTask(request.request.task_id);
        this.options.writeControlResponse(successResponse(request));
      } catch (error) {
        this.options.writeControlResponse(
          errorResponse(
            request,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      return;
    }
  }

  async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.options.writeEvent({ type: 'session_state_changed', state: 'running' });

    try {
      do {
        await this.drainCommandQueue();

        const hasBackgroundWork = getRunningTasks().some(
          task => task.isBackgrounded !== false,
        );
        const hasMainQueued = peek(command => command.agentId === undefined);

        if (hasBackgroundWork && !hasMainQueued) {
          await sleep(100);
        }
      } while (
        !this.inputClosed &&
        (hasCommandsInQueue() ||
          getRunningTasks().some(task => task.isBackgrounded !== false))
      );
    } finally {
      await this.options.flush();
      this.options.writeEvent({ type: 'session_state_changed', state: 'idle' });
      this.abortController = null;
      this.running = false;
    }
  }

  private async drainCommandQueue(): Promise<void> {
    let command: QueuedCommand | undefined;
    const isMainThread = (candidate: QueuedCommand) =>
      candidate.agentId === undefined;

    while ((command = dequeue(isMainThread))) {
      if (command.mode === 'task-notification') {
        this.options.writeEvent({
          type: 'task_notification_received',
          uuid: command.uuid,
        });
      }

      const batch =
        command.mode === 'prompt' ? collectPromptBatch(command) : [command];
      const merged = mergePromptBatch(batch);

      this.options.writeEvent({
        type: 'command_started',
        uuids: batch.map(item => item.uuid).filter(Boolean),
      });

      this.abortController = createTurnAbortController();

      try {
        await this.options.ask({
          value: merged.value,
          uuid: merged.uuid,
          abortController: this.abortController,
        });
      } finally {
        this.options.writeEvent({
          type: 'command_completed',
          uuids: batch.map(item => item.uuid).filter(Boolean),
        });
      }
    }
  }
}

function collectPromptBatch(first: QueuedCommand): QueuedCommand[] {
  const batch = [first];

  while (true) {
    const next = peek(
      command =>
        command.agentId === undefined &&
        command.mode === 'prompt' &&
        command.workload === first.workload,
    );

    if (!next) {
      return batch;
    }

    batch.push(dequeue(command => command === next)!);
  }
}

function mergePromptBatch(batch: QueuedCommand): QueuedCommand;
function mergePromptBatch(batch: QueuedCommand[]): QueuedCommand;
function mergePromptBatch(batch: QueuedCommand | QueuedCommand[]): QueuedCommand {
  if (!Array.isArray(batch)) {
    return batch;
  }

  if (batch.length === 1) {
    return batch[0]!;
  }

  return {
    ...batch[0]!,
    value: batch.map(command => command.value).join('\n\n'),
    uuid: batch.findLast(command => command.uuid)?.uuid,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

这个版本是 Mini 化的。

真实 `print.ts` 做得更多：

```txt
register MCP elicitation handlers
rebuild dynamic tools
flush SDK task progress before queue
claim autonomy commands
hold back result while background agents run
generate prompt suggestion
flush CCR internal events
drain session_state_changed SDK event
start idle timer
```

但 Mini 先要抓住骨架：

```txt
run mutex
drain queue
fresh abort controller
batch prompt
background wait
flush before idle
```

## 第六步：Query Loop 处理中断

你的 Mini query loop 应该接收 `AbortSignal`。

示例：

```ts
export async function runAgentTurn({
  prompt,
  abortController,
}: {
  prompt: string;
  abortController: AbortController;
}): Promise<void> {
  const assistantToolUses: Array<{ id: string }> = [];

  try {
    for await (const event of streamModel(prompt, abortController.signal)) {
      if (abortController.signal.aborted) {
        break;
      }

      if (event.type === 'tool_use') {
        assistantToolUses.push({ id: event.id });
        await executeToolUse(event, abortController.signal);
      }
    }
  } finally {
    if (abortController.signal.aborted) {
      for (const toolUse of assistantToolUses) {
        await appendSyntheticToolResult({
          toolUseId: toolUse.id,
          content: 'Interrupted by user',
          isError: true,
        });
      }
    }
  }
}
```

真实 `query.ts` 分两种中断：

```txt
aborted_streaming
  模型还在 streaming 或刚产出 tool_use，工具还没完整执行

aborted_tools
  已经进入 tool calls，中途收到 abort
```

两种都要做一件事：

```txt
补齐 tool_result
```

Anthropic Messages API 要求：

```txt
每个 assistant tool_use
必须有对应 user tool_result
```

如果中断后少了 tool_result，下一轮就会因为 transcript 不合法而失败。

所以 Mini 必须生成 synthetic result：

```txt
Interrupted by user
is_error: true
tool_use_id: <id>
```

## 第七步：Tool Execution 先检查 abort

工具执行入口要先看 signal：

```ts
export async function executeToolUse(
  toolUse: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  },
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    await appendSyntheticToolResult({
      toolUseId: toolUse.id,
      content: 'Interrupted by user',
      isError: true,
    });
    return;
  }

  const tool = findTool(toolUse.name);
  if (!tool) {
    await appendSyntheticToolResult({
      toolUseId: toolUse.id,
      content: `No such tool: ${toolUse.name}`,
      isError: true,
    });
    return;
  }

  await tool.call(toolUse.input, { signal });
}
```

真实 `toolExecution.ts` 也是先判断：

```txt
abortController.signal.aborted
  -> log tool_use_cancelled
  -> create stop tool_result
  -> return
```

工具内部也要传 signal。

例如 Bash：

```txt
exec(command, abortController.signal)
```

远程 fetch：

```txt
fetch(url, { signal })
```

子 agent：

```txt
createChildAbortController(parent)
```

## 第八步：Bash 前台、进度与后台

真实 Bash tool 的策略：

```txt
短命令
  直接等待结果

超过 progress threshold
  注册 foreground task
  显示 progress
  用户可按 Ctrl+B 后台化

模型显式 run_in_background
  直接注册 background task
  立即返回 backgroundTaskId

长期阻塞
  可自动后台化
```

Mini 先实现三态：

```txt
foreground running
background running
terminal
```

新增：

```txt
src/tasks/localShellTask.ts
```

写入：

```ts
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  registerTask,
  updateTask,
  getTask,
  registerTaskImplementation,
} from './taskRegistry';

export function registerLocalShellTaskImplementation(): void {
  registerTaskImplementation({
    type: 'local_shell',
    kill(taskId) {
      const task = shellProcesses.get(taskId);
      task?.kill();
      shellProcesses.delete(taskId);
    },
  });
}

const shellProcesses = new Map<string, ReturnType<typeof spawn>>();

export async function runShellCommand({
  command,
  signal,
  background,
  onNotification,
}: {
  command: string;
  signal: AbortSignal;
  background?: boolean;
  onNotification: (message: string) => void;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  interrupted: boolean;
  backgroundTaskId?: string;
}> {
  const taskId = randomUUID();
  const child = spawn(command, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  shellProcesses.set(taskId, child);

  const killOnAbort = () => {
    child.kill();
  };
  signal.addEventListener('abort', killOnAbort, { once: true });

  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', chunk => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', chunk => {
    stderr += String(chunk);
  });

  if (background) {
    registerTask({
      id: taskId,
      type: 'local_shell',
      description: command,
      status: 'running',
      startedAt: Date.now(),
      isBackgrounded: true,
    });

    child.on('exit', code => {
      shellProcesses.delete(taskId);
      updateTask(taskId, task => ({
        ...task,
        status: code === 0 ? 'completed' : 'failed',
        endedAt: Date.now(),
      }));
      onNotification(
        `<task-notification><task-id>${taskId}</task-id><status>${
          code === 0 ? 'completed' : 'failed'
        }</status><summary>Background command finished</summary></task-notification>`,
      );
    });

    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      interrupted: false,
      backgroundTaskId: taskId,
    };
  }

  return await new Promise(resolve => {
    child.on('exit', code => {
      signal.removeEventListener('abort', killOnAbort);
      shellProcesses.delete(taskId);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        interrupted: signal.aborted,
      });
    });
  });
}

export function backgroundShellTask(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task || task.type !== 'local_shell' || task.status !== 'running') {
    return false;
  }

  updateTask(taskId, current => ({
    ...current,
    isBackgrounded: true,
  }));
  return true;
}
```

这个 Mini 版本没有完整 progress poller。

但已经表达了关键：

```txt
background task 有 taskId
task 完成后 enqueue notification
stopTask 可以 kill
abort signal 可以 kill foreground child
```

真实实现还做了：

```txt
TaskOutput 文件落盘
progress 每秒上报
foreground task 注册
Ctrl+B 背景化
stall watchdog
大输出持久化
后台完成 XML notification
SDK task_started / task_notification
```

## 第九步：后台通知进入队列

后台任务不能直接把结果塞进当前模型调用。

它可能在 turn 之外完成。

正确做法：

```txt
task completes
  -> enqueue task-notification
  -> run loop wake
  -> task notification becomes next model input
```

接入：

```ts
import { enqueue } from '../control/commandQueue';

function enqueueTaskNotification(message: string): void {
  enqueue({
    mode: 'task-notification',
    value: message,
    priority: 'later',
  });
}
```

传给 shell：

```ts
await runShellCommand({
  command,
  signal,
  background: input.run_in_background === true,
  onNotification: enqueueTaskNotification,
});
```

为什么是 `later`：

```txt
用户输入优先于后台通知
后台通知不能抢掉用户刚发的 prompt
```

但如果通知表示“命令卡住，需要处理”，可以用：

```txt
priority: next
```

真实源码的 stall watchdog 就是这种思路。

## 第十步：held-back result

真实 `print.ts` 有一个重要逻辑：

```txt
如果 result 到了，但后台 agent 还在跑
  先 hold result
等 background agent 完成并发出 notification
  再释放 result
```

为什么？

因为 SDK 消费者通常把 `result` 当成：

```txt
这一轮完成
```

如果提前发 result：

```txt
客户端会认为 turn 结束
但后台 agent 后面又发 task_notification
UI 状态会抖动
```

Mini 可以实现：

```ts
let heldBackResult: Record<string, unknown> | null = null;

function emitResultOrHold(result: Record<string, unknown>): void {
  const hasBackgroundWork = getRunningTasks().some(
    task => task.isBackgrounded !== false,
  );

  if (hasBackgroundWork) {
    heldBackResult = result;
    return;
  }

  writeEvent(result);
}

function releaseHeldBackResult(): void {
  if (!heldBackResult) {
    return;
  }

  writeEvent(heldBackResult);
  heldBackResult = null;
}
```

在 run loop 等待后台任务结束后：

```ts
releaseHeldBackResult();
```

这个小细节很影响远程 UI 的稳定性。

## 第十一步：Control Request 接入 Structured Input

如果你的 Mini 已经有 NDJSON 输入：

```txt
{"type":"user","content":"..."}
{"type":"control_request","request_id":"...","request":{"subtype":"interrupt"}}
```

处理方式：

```ts
for await (const message of structuredInput) {
  if (message.type === 'control_request') {
    await runtime.handleControlRequest(message);
    continue;
  }

  if (message.type === 'user') {
    runtime.enqueuePrompt(message.content);
  }
}
```

不要把 control request 放进 prompt queue。

原因：

```txt
interrupt 要立刻生效
end_session 要立刻关闭输入
cancel_async_message 要操作队列
stop_task 要操作 task registry
```

这些都是控制面事件，不是模型输入。

## 第十二步：RCS Web Interrupt

真实 RCS 路由：

```txt
POST /web/sessions/:id/interrupt
  -> check ownership
  -> publish outbound interrupt
  -> update session status idle
```

worker SSE 会把 outbound interrupt 转成：

```txt
control_request
request.subtype = interrupt
```

Mini RCS 可以加：

```ts
app.post('/web/sessions/:id/interrupt', async c => {
  const sessionId = c.req.param('id');

  publishSessionEvent(
    sessionId,
    'interrupt',
    { action: 'interrupt' },
    'outbound',
  );

  updateSessionStatus(sessionId, 'idle');
  return c.json({ status: 'ok' }, 200);
});
```

SSE 转换：

```ts
function toWorkerClientPayload(event: SessionEvent) {
  if (event.type === 'interrupt') {
    return {
      type: 'control_request',
      request_id: event.id,
      request: { subtype: 'interrupt' },
    };
  }

  return event.payload;
}
```

注意：

```txt
RCS 更新 idle 是 UI 侧的乐观状态
真正的 worker 仍然要收到 interrupt 并 abort
worker 完成 finally 后还会 report idle
```

不要只改 server 状态，不发 interrupt。

## 第十三步：RemoteSessionManager 取消

本地 attach 到远程 session 时，用户按 Stop：

```txt
RemoteSessionManager.cancelSession()
  -> SessionsWebSocket.sendControlRequest({ subtype: 'interrupt' })
```

Mini 可以这样写：

```ts
export class RemoteSessionManager {
  constructor(
    private readonly socket: {
      send(message: unknown): void;
    },
  ) {}

  cancelSession(): void {
    this.socket.send({
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }
}
```

这和 Web interrupt 方向相反：

```txt
Web interrupt
  Web -> RCS -> worker

local remote manager cancel
  local attach client -> remote session
```

两者都用相同语义：

```txt
control_request interrupt
```

## 第十四步：cancel_async_message

`cancel_async_message` 不是中断当前 turn。

它取消的是：

```txt
还在队列里，尚未被处理的 message
```

真实 `print.ts`：

```txt
dequeueAllMatching(cmd => cmd.uuid === targetUuid)
send { cancelled: removed.length > 0 }
```

Mini 已在 `removeByUuid()` 实现。

语义：

```txt
如果消息还在 queue
  remove
  cancelled = true

如果消息已经开始处理
  remove 不到
  cancelled = false
  需要 interrupt 才能停止当前 turn
```

这两个控制面不能混用：

```txt
cancel_async_message
  队列取消

interrupt
  当前执行取消
```

## 第十五步：stop_task

`stop_task` 是停止后台 task。

真实实现有两条入口：

```txt
TaskStopTool
  模型调用工具停止任务

control_request stop_task
  SDK / remote client 请求停止任务
```

两条都进入：

```txt
src/tasks/stopTask.ts
```

Mini 也应该这样：

```txt
TaskStopTool.call
  -> stopTask(taskId)

runtime.handleControlRequest(stop_task)
  -> stopTask(taskId)
```

工具实现：

```ts
export const TaskStopTool = {
  name: 'TaskStop',
  async call(input: { task_id: string }) {
    const result = await stopTask(input.task_id);
    return {
      message: `Stopped task ${result.taskId}`,
      task_id: result.taskId,
      task_type: result.taskType,
      description: result.description,
    };
  },
};
```

为什么要统一入口：

```txt
统一校验 not_found / not_running / unsupported_type
统一调用 task implementation
统一关闭 SDK task_started bookend
统一避免重复 notification
```

## 第十六步：daemon stop

真实 daemon supervisor：

```txt
daemon stop
  -> read state file
  -> send SIGTERM
  -> wait
  -> SIGKILL fallback
  -> remove state file
```

supervisor 自己收到 signal：

```txt
controller.abort()
clear restart timers
SIGTERM workers
wait workers exit
SIGKILL after grace period
remove state
```

worker 进程：

```txt
create AbortController
SIGTERM / SIGINT -> controller.abort()
runBridgeHeadless(opts, signal)
finally remove signal handlers
```

Mini daemon 不需要一开始做完整 supervisor。

但要保留三个层次：

```txt
state file
graceful stop
force stop fallback
```

示例：

```ts
export async function stopProcessByPid(
  pid: number,
  timeoutMs = 10_000,
): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await sleep(200);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

注意：

```txt
daemon stop 是进程级取消
interrupt 是 turn 级取消
stop_task 是 task 级取消
cancel_async_message 是 queue 级取消
```

这四个层级不能混在一起。

## 第十七步：状态机

现在 Mini 至少有四个状态机。

### Queue 状态

```txt
queued
dequeued
removed
```

### Turn 状态

```txt
idle
running
requires_action
aborting
finished
```

### Tool 状态

```txt
pending
running
completed
failed
cancelled
```

### Task 状态

```txt
running
backgrounded
completed
failed
killed
notified
```

不要试图用一个 `status` 表达所有层级。

例如：

```txt
session idle
不代表 background task 都被删除

task killed
不代表 turn 被 interrupt

queue removed
不代表已经执行的工具被取消
```

## 第十八步：和第 56 章 timeline 结合

第 56 章已经有 audit event。

本章可以补这些事件：

```txt
queue_enqueued
queue_dequeued
queue_removed
turn_abort_requested
turn_aborted_streaming
turn_aborted_tools
control_request_received
control_response_sent
task_registered
task_backgrounded
task_stop_requested
task_stopped
task_notification_enqueued
daemon_stop_requested
daemon_worker_terminated
```

最重要的排查序列：

```txt
control_request_received interrupt
turn_abort_requested
turn_aborted_tools
synthetic_tool_result_created
flush_internal_events
session_state_changed idle
```

如果少了 `synthetic_tool_result_created`：

```txt
下一轮 transcript 可能非法
```

如果少了 `flush_internal_events`：

```txt
远程 resume 可能丢尾部消息
```

如果少了 `session_state_changed idle`：

```txt
远程 UI 会一直显示 running
```

## 第十九步：测试 Command Queue

新增：

```txt
src/control/__tests__/commandQueue.test.ts
```

写入：

```ts
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  dequeue,
  enqueue,
  peek,
  removeByUuid,
  resetCommandQueueForTests,
} from '../commandQueue';

describe('commandQueue', () => {
  beforeEach(() => {
    resetCommandQueueForTests();
  });

  test('dequeues by priority and keeps fifo within priority', () => {
    enqueue({ mode: 'prompt', value: 'later', priority: 'later', uuid: '1' });
    enqueue({ mode: 'prompt', value: 'next-a', priority: 'next', uuid: '2' });
    enqueue({ mode: 'prompt', value: 'now', priority: 'now', uuid: '3' });
    enqueue({ mode: 'prompt', value: 'next-b', priority: 'next', uuid: '4' });

    expect(dequeue()?.value).toBe('now');
    expect(dequeue()?.value).toBe('next-a');
    expect(dequeue()?.value).toBe('next-b');
    expect(dequeue()?.value).toBe('later');
  });

  test('peek respects filter without removing', () => {
    enqueue({ mode: 'prompt', value: 'agent', agentId: 'agent-1' });
    enqueue({ mode: 'prompt', value: 'main' });

    expect(peek(command => command.agentId === undefined)?.value).toBe('main');
    expect(dequeue()?.value).toBe('agent');
  });

  test('removes queued command by uuid', () => {
    enqueue({ mode: 'prompt', value: 'a', uuid: 'a' });
    enqueue({ mode: 'prompt', value: 'b', uuid: 'b' });

    expect(removeByUuid('a')).toHaveLength(1);
    expect(dequeue()?.value).toBe('b');
  });
});
```

运行：

```bash
bun test src/control/__tests__/commandQueue.test.ts
```

## 第二十步：测试 Control Request

新增：

```txt
src/control/__tests__/sessionRuntime.test.ts
```

写入：

```ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { enqueue, resetCommandQueueForTests } from '../commandQueue';
import { SessionRuntime } from '../sessionRuntime';

describe('SessionRuntime control requests', () => {
  beforeEach(() => {
    resetCommandQueueForTests();
  });

  test('cancel_async_message removes queued command', async () => {
    const responses: unknown[] = [];
    const runtime = new SessionRuntime({
      ask: async () => {},
      writeControlResponse: response => responses.push(response),
      writeEvent: () => {},
      flush: async () => {},
    });

    enqueue({ mode: 'prompt', value: 'hello', uuid: 'msg-1' });

    await runtime.handleControlRequest({
      type: 'control_request',
      request_id: 'request-1',
      request: {
        subtype: 'cancel_async_message',
        message_uuid: 'msg-1',
      },
    });

    expect(JSON.stringify(responses[0])).toContain('"cancelled":true');
  });

  test('interrupt aborts active turn', async () => {
    const responses: unknown[] = [];
    let signal: AbortSignal | undefined;

    const runtime = new SessionRuntime({
      ask: async input => {
        signal = input.abortController.signal;
        await runtime.handleControlRequest({
          type: 'control_request',
          request_id: 'request-1',
          request: { subtype: 'interrupt' },
        });
      },
      writeControlResponse: response => responses.push(response),
      writeEvent: () => {},
      flush: async () => {},
    });

    runtime.enqueuePrompt('hello');
    await runtime.run();

    expect(signal?.aborted).toBe(true);
    expect(JSON.stringify(responses[0])).toContain('"success"');
  });
});
```

运行：

```bash
bun test src/control/__tests__/sessionRuntime.test.ts
```

## 第二十一步：测试 stopTask

新增：

```txt
src/tasks/__tests__/stopTask.test.ts
```

写入：

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  registerTask,
  registerTaskImplementation,
  resetTasksForTests,
} from '../taskRegistry';
import { stopTask, StopTaskError } from '../stopTask';

describe('stopTask', () => {
  beforeEach(() => {
    resetTasksForTests();
  });

  test('kills a running task through implementation', async () => {
    let killed = false;

    registerTaskImplementation({
      type: 'local_shell',
      kill() {
        killed = true;
      },
    });

    registerTask({
      id: 'task-1',
      type: 'local_shell',
      description: 'Run check',
      status: 'running',
      startedAt: Date.now(),
    });

    const result = await stopTask('task-1');
    expect(killed).toBe(true);
    expect(result.taskId).toBe('task-1');
  });

  test('rejects missing task', async () => {
    await expect(stopTask('missing')).rejects.toBeInstanceOf(StopTaskError);
  });
});
```

运行：

```bash
bun test src/tasks/__tests__/stopTask.test.ts
```

## 第二十二步：测试中断补 tool_result

如果你的 Mini 已经有 transcript builder，增加：

```txt
src/query/__tests__/interrupt.test.ts
```

写入：

```ts
import { describe, expect, test } from 'bun:test';
import { runAgentTurn } from '../runAgentTurn';

describe('interrupt handling', () => {
  test('creates synthetic tool result for interrupted tool use', async () => {
    const controller = new AbortController();
    const results: Array<{ toolUseId: string; content: string }> = [];

    await runAgentTurn({
      prompt: 'run tool',
      abortController: controller,
      streamModel: async function* () {
        yield { type: 'tool_use', id: 'tool-1', name: 'SlowTool', input: {} };
        controller.abort('interrupt');
      },
      executeToolUse: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      },
      appendSyntheticToolResult: async result => {
        results.push(result);
      },
    });

    expect(results).toEqual([
      {
        toolUseId: 'tool-1',
        content: 'Interrupted by user',
      },
    ]);
  });
});
```

这个测试表达的是协议要求。

你可以根据自己的 Mini 函数签名调整。

重点不是函数名，而是断言：

```txt
interrupt 后每个 tool_use 都有 tool_result
```

## 第二十三步：端到端验证

跑本章新增测试：

```bash
bun test src/control src/tasks
```

跑类型检查：

```bash
bun run typecheck
```

手动验证队列：

```bash
bun run src/entrypoints/cli.tsx -p "连续发送两个短任务，确认它们按顺序处理"
```

手动验证 interrupt：

```bash
bun run src/entrypoints/cli.tsx -p "运行一个长时间命令，然后发送 interrupt"
```

手动验证后台任务：

```bash
bun run src/entrypoints/cli.tsx -p "启动一个后台命令，并在完成后读取它的结果"
```

如果你的 Mini 还没有 remote server，就先跳过 RCS interrupt。

如果已经做到第 50 章之后，则验证：

```txt
Web 点击 interrupt
  -> RCS event bus 出现 interrupt
  -> worker SSE 收到 control_request
  -> CLI abort 当前 turn
  -> session 回到 idle
```

## 常见错误

### 错误一：把 interrupt 放进 prompt queue

错误：

```txt
interrupt
  -> enqueue prompt
  -> 等当前 turn 结束才处理
```

正确：

```txt
interrupt
  -> 立即 abort active controller
```

### 错误二：复用 aborted controller

错误：

```txt
controller.abort()
下一轮继续用 controller.signal
```

结果：

```txt
下一轮一开始就 aborted
```

正确：

```txt
每轮新建 controller
interrupt 后 reset
```

### 错误三：取消队列消息等同于 interrupt

错误：

```txt
cancel_async_message
  -> abort current turn
```

正确：

```txt
cancel_async_message
  只移除还没执行的 uuid

interrupt
  才中断当前 turn
```

### 错误四：后台任务直接写当前 messages

错误：

```txt
task completes
  -> push message into current conversation
```

问题：

```txt
可能当前 turn 正在 streaming
可能 parentUuid 错
可能 UI 和 transcript 不一致
```

正确：

```txt
task completes
  -> enqueue task-notification
  -> 下一轮由 run loop 处理
```

### 错误五：idle 发得太早

错误：

```txt
ask returned result
  -> idle
  -> flush events
  -> background notification
```

正确：

```txt
ask returned result
  -> wait/drain background notifications
  -> flush internal events
  -> idle
```

### 错误六：stop_task 只支持一种 task

错误：

```txt
if task.type === 'shell' kill shell
else throw
```

正确：

```txt
Task registry
  local_shell.kill
  local_agent.kill
  remote_agent.kill
  workflow.kill
```

统一入口才方便扩展。

### 错误七：daemon stop 只删 state file

错误：

```txt
remove daemon json
```

这不会停止进程。

正确：

```txt
SIGTERM
wait
SIGKILL fallback
remove state
```

## 本章完成后的能力

现在 Mini 已经具备一条更接近官方 Claude Code 的控制流：

```txt
输入可以排队
队列可以按优先级 drain
远程消息可以安全过滤 slash command
当前 turn 可以被 interrupt
未处理 async message 可以取消
后台 task 可以停止
工具中断可以补齐 synthetic tool_result
后台任务完成可以回到队列
result 可以等后台任务收尾后再释放
flush 完成后才进入 idle
daemon 可以优雅停止 worker
```

这章的价值不在于某个 API。

而在于把 Agent 从：

```txt
一次性脚本
```

升级成：

```txt
长期运行、可中断、可恢复、可远程控制的系统
```

## 和官方 Claude Code 的差距

Mini 仍然简化了很多细节：

```txt
REPL 与 headless 两套 queue drain 的差异
orphaned permission response 恢复
autonomy run ledger
scheduled task dedup claim
subagent queue isolation
in-process teammate current-work abort
foreground task progress poller
stall watchdog
large output disk persistence
remote permission cancel request
worker epoch 冲突后的退出
multi-client interrupt 一致性
```

但核心骨架已经正确：

```txt
queue
run mutex
fresh abort signal
synthetic tool_result
task registry
notification re-entry
flush before idle
process-level graceful stop
```

下一章可以继续补 **多客户端协同、事件幂等与 exactly-once 体验**：让 Web、CLI、移动端、worker 在断线重连、重复 delivery、权限响应迟到时仍然保持一致。
