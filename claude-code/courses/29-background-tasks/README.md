# 第 29 章：后台任务与长运行命令

第二十八章把 Bash、文件写入和 MCP 调用放进了执行隔离层。现在 Mini 已经能更安全地执行命令，但还有一个工程问题没有解决：

```text
命令运行很久时，Agent Loop 不能一直卡住。
```

例如：

```bash
bun test --watch
bun run dev
```

这些命令可能持续运行，甚至永远不退出。Coding Agent 如果一直等待它们结束，就会出现几个问题：

- 用户看不到主对话继续响应。
- 模型不能继续执行下一步。
- 输出会持续增长，撑爆内存或上下文。
- 用户无法在对话里查看、停止或复用这个命令。
- 如果会话中断，子进程可能变成孤儿。

真实 Claude Code 不会把所有 Bash 都当成一次性前台命令。它有一套后台任务系统：命令可以在前台跑一会儿，必要时转入后台；输出持续写入文件；完成时通过通知回到对话；用户和模型都可以查看或停止任务。

本章给 Mini 补上这套能力。

## 真实工程怎么做

真实工程的后台任务能力主要分布在：

- `packages/builtin-tools/src/tools/BashTool/BashTool.tsx`：`run_in_background`、前台进度、显式后台化、自动后台化。
- `src/utils/Shell.ts`：创建 shell 子进程，把 stdout/stderr 指向任务输出文件。
- `src/utils/ShellCommand.ts`：封装进程状态、timeout、kill、background、输出大小 watchdog。
- `src/utils/task/TaskOutput.ts`：统一管理 stdout/stderr，支持内存缓冲、磁盘溢出、文件轮询进度。
- `src/utils/task/diskOutput.ts`：任务输出路径、append queue、tail、delta、清理和安全打开文件。
- `src/tasks/LocalShellTask/LocalShellTask.tsx`：注册后台 Bash 任务、完成通知、卡住提示、前台任务后台化。
- `src/tasks/LocalShellTask/killShellTasks.ts`：停止后台 Bash，清理输出和队列。
- `src/tasks/stopTask.ts`：统一停止任务入口。
- `src/utils/task/framework.ts`：注册任务、轮询任务、生成通知、清理终态任务。
- `packages/builtin-tools/src/tools/TaskOutputTool/TaskOutputTool.tsx`：按 task id 读取后台任务输出。
- `packages/builtin-tools/src/tools/TaskStopTool/TaskStopTool.ts`：按 task id 停止后台任务。
- `src/components/tasks/BackgroundTasksDialog.tsx`：UI 里展示和管理后台任务。

真实工程里最重要的设计是：**输出文件是后台任务的事实来源**。

前台渲染、模型读取、完成通知、停止任务和会话恢复，都围绕 task id 和 output file 工作。

## 本章目标

完成后，Mini 应该支持：

```text
> 运行 bun run dev，并放到后台
```

BashTool 返回：

```text
Command running in background.
taskId: b8k2m1q0z
outputFile: .mini/tmp/<sessionId>/tasks/b8k2m1q0z.output
```

用户或模型可以继续：

```text
/tasks
/tasks read b8k2m1q0z
/tasks stop b8k2m1q0z
```

并且具备这些能力：

- Bash 支持 `run_in_background`。
- 长运行前台命令会持续产生 progress。
- 前台命令可以被转入后台。
- 后台任务输出写到文件，不进入主内存。
- 任务有 `pending`、`running`、`completed`、`failed`、`killed` 状态。
- 后台任务完成后产生通知，注入下一轮对话。
- 可以读取任务输出的 tail 或 delta。
- 可以停止后台任务。
- 输出文件有大小上限，超过上限会停止任务。
- 会话结束或 Agent 退出时能清理相关任务。

## 推荐目录

新增：

```text
src/tasks/
  taskTypes.ts
  taskIds.ts
  taskStore.ts
  taskOutput.ts
  diskOutput.ts
  localShellTask.ts
  taskNotifications.ts
  taskPoller.ts
  stopTask.ts

src/tools/
  taskOutputTool.ts
  taskStopTool.ts

src/commands/
  tasksCommand.ts
```

修改：

```text
src/isolation/processRunner.ts
src/isolation/isolatedShell.ts
src/tools/bashTool.ts
src/tools/toolTypes.ts
src/chat/agentLoop.ts
src/state/appState.ts
src/transcript/types.ts
```

本章的主线不是 UI，而是后台任务运行时。UI 可以先用 `/tasks` 命令代替。

## Task 类型

先定义通用任务类型：

```ts
// src/tasks/taskTypes.ts
export type TaskType = "local_bash";

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
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  outputFile: string;
  outputOffset: number;
  notified: boolean;
};

export type LocalShellTaskState = TaskStateBase & {
  type: "local_bash";
  command: string;
  isBackgrounded: boolean;
  agentId?: string;
  result?: {
    code: number | null;
    interrupted: boolean;
  };
};

export type TaskState = LocalShellTaskState;

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}
```

任务不是 todo list。它代表一个真实运行的后台工作单元。

## Task ID

真实工程里任务 id 有类型前缀，例如 Bash 用 `b`。Mini 也保留这个设计：

```ts
// src/tasks/taskIds.ts
import { randomBytes } from "node:crypto";
import type { TaskType } from "./taskTypes";

const PREFIX: Record<TaskType, string> = {
  local_bash: "b",
};

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType): string {
  const bytes = randomBytes(8);
  let id = PREFIX[type] ?? "x";

  for (let index = 0; index < bytes.length; index++) {
    id += ALPHABET[bytes[index]! % ALPHABET.length];
  }

  return id;
}
```

用短 id 是为了让模型和用户都能方便引用。

## 输出目录

任务输出必须按 session 隔离，否则多个会话会互相删除或覆盖输出。

```ts
// src/tasks/diskOutput.ts
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getProjectTempDir } from "../utils/temp";

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;

export function getTaskOutputDir(sessionId: string): string {
  return join(getProjectTempDir(), sessionId, "tasks");
}

export function getTaskOutputPath(sessionId: string, taskId: string): string {
  return join(getTaskOutputDir(sessionId), `${taskId}.output`);
}

export async function initTaskOutput(sessionId: string, taskId: string): Promise<string> {
  await mkdir(getTaskOutputDir(sessionId), { recursive: true, mode: 0o700 });

  const outputPath = getTaskOutputPath(sessionId, taskId);
  const handle = await open(
    outputPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      O_NOFOLLOW,
    0o600,
  );
  await handle.close();

  return outputPath;
}
```

这里的 `O_NOFOLLOW` 和 `O_EXCL` 很关键：

- `O_NOFOLLOW` 防止 output path 被替换成 symlink 后写到任意文件。
- `O_EXCL` 防止复用已存在文件。

Windows 对部分 flag 支持不同。Mini 可以在封装里做兼容，但调用方不应该绕过 `diskOutput.ts`。

## 读取输出

后台任务输出可能非常大。不要整文件读取。

```ts
// src/tasks/diskOutput.ts
export async function getTaskOutputTail(
  sessionId: string,
  taskId: string,
  maxBytes = DEFAULT_MAX_READ_BYTES,
): Promise<string> {
  const outputPath = getTaskOutputPath(sessionId, taskId);
  const info = await stat(outputPath).catch(() => undefined);
  if (!info) {
    return "";
  }

  const start = Math.max(0, info.size - maxBytes);
  const file = Bun.file(outputPath);
  const buffer = await file.slice(start, info.size).arrayBuffer();
  const content = new TextDecoder().decode(buffer);

  if (start > 0) {
    return `[${Math.round(start / 1024)}KB of earlier output omitted]\n${content}`;
  }

  return content;
}

export async function getTaskOutputDelta(input: {
  sessionId: string;
  taskId: string;
  fromOffset: number;
  maxBytes?: number;
}): Promise<{ content: string; newOffset: number }> {
  const outputPath = getTaskOutputPath(input.sessionId, input.taskId);
  const info = await stat(outputPath).catch(() => undefined);
  if (!info || info.size <= input.fromOffset) {
    return { content: "", newOffset: input.fromOffset };
  }

  const end = Math.min(info.size, input.fromOffset + (input.maxBytes ?? DEFAULT_MAX_READ_BYTES));
  const file = Bun.file(outputPath);
  const buffer = await file.slice(input.fromOffset, end).arrayBuffer();

  return {
    content: new TextDecoder().decode(buffer),
    newOffset: end,
  };
}

export async function cleanupTaskOutput(sessionId: string, taskId: string): Promise<void> {
  await unlink(getTaskOutputPath(sessionId, taskId)).catch(() => {});
}
```

读取 tail 用于用户查看。读取 delta 用于系统轮询和通知。

## TaskOutput

第 28 章的 `ProcessRunner` 已经把输出写到文件。现在封装一个 `TaskOutput`，让 BashTool、TaskOutputTool 和 task poller 统一读取。

```ts
// src/tasks/taskOutput.ts
import { getTaskOutputTail } from "./diskOutput";

export type TaskProgress = {
  lastLines: string;
  totalBytes: number;
  isIncomplete: boolean;
};

export class TaskOutput {
  constructor(
    readonly sessionId: string,
    readonly taskId: string,
    readonly path: string,
  ) {}

  async tail(maxBytes?: number): Promise<string> {
    return getTaskOutputTail(this.sessionId, this.taskId, maxBytes);
  }

  async progress(): Promise<TaskProgress> {
    const text = await this.tail(4096);
    const lines = text.trimEnd().split("\n");

    return {
      lastLines: lines.slice(-5).join("\n"),
      totalBytes: new TextEncoder().encode(text).length,
      isIncomplete: text.startsWith("["),
    };
  }
}
```

真实工程的 `TaskOutput` 更复杂：它区分 file mode 和 pipe mode，有内存缓冲、磁盘溢出和共享 poller。Mini 第一版可以先只做 file mode，因为 Bash 输出天然适合写文件。

## TaskStore

任务状态需要集中保存：

```ts
// src/tasks/taskStore.ts
import type { TaskState, TaskStatus } from "./taskTypes";

type Listener = () => void;

export class TaskStore {
  private tasks = new Map<string, TaskState>();
  private listeners = new Set<Listener>();

  list(): TaskState[] {
    return [...this.tasks.values()].sort((left, right) => left.startTime - right.startTime);
  }

  get(id: string): TaskState | undefined {
    return this.tasks.get(id);
  }

  register(task: TaskState): void {
    this.tasks.set(task.id, task);
    this.emit();
  }

  update(id: string, updater: (task: TaskState) => TaskState): void {
    const existing = this.tasks.get(id);
    if (!existing) {
      return;
    }

    this.tasks.set(id, updater(existing));
    this.emit();
  }

  mark(
    id: string,
    status: TaskStatus,
    result?: { code: number | null; interrupted: boolean },
  ): void {
    this.update(id, (task) => ({
      ...task,
      status,
      result,
      endTime: Date.now(),
    }));
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
```

如果你已经有全局 AppState，可以把 `TaskStore` 接进去。关键是所有任务操作都走同一个 registry。

## 扩展 ProcessRunner

第 28 章的 `runProcess()` 是“一次 await 到结束”。后台任务需要拿到可控 handle：

```ts
// src/isolation/processRunner.ts
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { TaskOutput } from "../tasks/taskOutput";
import { MAX_TASK_OUTPUT_BYTES } from "../tasks/diskOutput";

export type RunningProcess = {
  pid?: number;
  output: TaskOutput;
  result: Promise<ProcessRunResult>;
  kill(): void;
};

export async function startProcess(options: ProcessRunOptions & {
  output: TaskOutput;
  shouldAutoBackground?: boolean;
}): Promise<RunningProcess> {
  const outputHandle = await open(
    options.output.path,
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      (fsConstants.O_NOFOLLOW ?? 0),
  );

  const child = spawn(options.cmd[0]!, options.cmd.slice(1), {
    cwd: options.cwd,
    env: sanitizeEnv(options.env),
    stdio: ["ignore", outputHandle.fd, outputHandle.fd],
    windowsHide: true,
  });

  const timeoutId = setTimeout(() => killTree(child), options.timeoutMs);
  const sizeWatchdog = setInterval(() => {
    void stat(options.output.path).then((info) => {
      if (info.size > MAX_TASK_OUTPUT_BYTES) {
        killTree(child);
      }
    }).catch(() => {});
  }, 5_000);

  const abort = () => killTree(child);
  options.signal.addEventListener("abort", abort, { once: true });

  const result = new Promise<ProcessRunResult>((resolve) => {
    child.once("exit", async (code, signal) => {
      clearTimeout(timeoutId);
      clearInterval(sizeWatchdog);
      options.signal.removeEventListener("abort", abort);
      await outputHandle.close().catch(() => {});

      resolve({
        code,
        signal: signal ?? undefined,
        stdout: await options.output.tail(),
        stderr: "",
        timedOut: false,
        outputPath: options.output.path,
      });
    });
  });

  return {
    pid: child.pid,
    output: options.output,
    result,
    kill() {
      killTree(child);
    },
  };
}

function killTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }

  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 500).unref();
}
```

真实工程使用 `tree-kill` 确保子进程树被杀掉。Mini 如果不想加依赖，先用 `child.kill()`，但要在课程里明确它不一定能杀掉孙进程。后续可以把 `killTree()` 替换成更完整实现。

## LocalShellTask

封装后台 Bash 任务：

```ts
// src/tasks/localShellTask.ts
import type { RunningProcess } from "../isolation/processRunner";
import type { TaskStore } from "./taskStore";
import type { LocalShellTaskState } from "./taskTypes";
import { enqueueTaskNotification } from "./taskNotifications";

export function registerLocalShellTask(input: {
  task: LocalShellTaskState;
  process: RunningProcess;
  taskStore: TaskStore;
  sessionId: string;
}): void {
  const { task, process, taskStore, sessionId } = input;

  taskStore.register(task);

  void process.result.then((result) => {
    const status = result.code === 0 ? "completed" : "failed";

    taskStore.update(task.id, (current) => ({
      ...current,
      status,
      result: {
        code: result.code,
        interrupted: result.signal === "SIGKILL",
      },
      endTime: Date.now(),
    }));

    enqueueTaskNotification({
      sessionId,
      taskId: task.id,
      taskType: task.type,
      status,
      description: task.description,
      outputFile: task.outputFile,
      toolUseId: task.toolUseId,
    });
  });
}

export function stopLocalShellTask(input: {
  taskId: string;
  taskStore: TaskStore;
  processes: Map<string, RunningProcess>;
}): void {
  const process = input.processes.get(input.taskId);
  process?.kill();

  input.taskStore.update(input.taskId, (task) => ({
    ...task,
    status: "killed",
    notified: true,
    endTime: Date.now(),
  }));
}
```

这里先把 `RunningProcess` 存在 `processes` map 里。`TaskStore` 保存可序列化状态，`processes` 保存运行时 handle。

## 任务通知

后台任务完成时，模型需要知道。真实工程用类似 XML 的结构塞进 message queue。

Mini 可以这样：

```ts
// src/tasks/taskNotifications.ts
import { escapeXml } from "../utils/xml";
import type { TaskStatus, TaskType } from "./taskTypes";

export type TaskNotification = {
  sessionId: string;
  taskId: string;
  toolUseId?: string;
  taskType: TaskType;
  status: TaskStatus;
  description: string;
  outputFile: string;
};

const pendingNotifications: string[] = [];

export function enqueueTaskNotification(input: TaskNotification): void {
  const toolUseLine = input.toolUseId
    ? `\n<tool_use_id>${escapeXml(input.toolUseId)}</tool_use_id>`
    : "";

  pendingNotifications.push(`<task_notification>
<task_id>${escapeXml(input.taskId)}</task_id>${toolUseLine}
<task_type>${input.taskType}</task_type>
<output_file>${escapeXml(input.outputFile)}</output_file>
<status>${input.status}</status>
<summary>${escapeXml(`Task "${input.description}" ${statusText(input.status)}`)}</summary>
</task_notification>`);
}

export function drainTaskNotifications(): string[] {
  return pendingNotifications.splice(0, pendingNotifications.length);
}

function statusText(status: TaskStatus): string {
  switch (status) {
    case "completed":
      return "completed successfully";
    case "failed":
      return "failed";
    case "killed":
      return "was stopped";
    case "running":
      return "is running";
    case "pending":
      return "is pending";
  }
}
```

Agent Loop 每轮请求模型前，先注入 pending notifications：

```ts
// src/chat/agentLoop.ts
import { drainTaskNotifications } from "../tasks/taskNotifications";

function buildNextUserMessages(userInput: string): ChatMessage[] {
  const notifications = drainTaskNotifications();

  return [
    ...notifications.map((content) => ({
      role: "user" as const,
      content,
      kind: "task-notification" as const,
    })),
    {
      role: "user",
      content: userInput,
    },
  ];
}
```

这样模型不需要主动轮询。任务结束后，下一轮对话自然看到结果位置。

## BashTool 支持后台运行

扩展 Bash input：

```ts
// src/tools/bashTool.ts
const BashInputSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  timeoutMs: z.number().optional(),
  run_in_background: z.boolean().optional(),
});
```

执行时：

```ts
// src/tools/bashTool.ts
import { generateTaskId } from "../tasks/taskIds";
import { initTaskOutput, getTaskOutputPath } from "../tasks/diskOutput";
import { TaskOutput } from "../tasks/taskOutput";
import { registerLocalShellTask } from "../tasks/localShellTask";
import { startProcess } from "../isolation/processRunner";

export async function executeBash(input: BashToolInput, context: ToolExecutionContext) {
  const command = input.command;
  const description = input.description ?? command;

  if (input.run_in_background === true) {
    const taskId = generateTaskId("local_bash");
    const outputFile = await initTaskOutput(context.sessionId, taskId);
    const output = new TaskOutput(context.sessionId, taskId, outputFile);

    const process = await startProcess({
      cmd: [context.shellPath, "-lc", command],
      cwd: context.cwd,
      timeoutMs: input.timeoutMs ?? 120_000,
      signal: context.abortController.signal,
      outputDir: context.outputDir,
      maxOutputBytes: 256_000,
      output,
    });

    context.processes.set(taskId, process);

    registerLocalShellTask({
      sessionId: context.sessionId,
      taskStore: context.taskStore,
      process,
      task: {
        id: taskId,
        type: "local_bash",
        status: "running",
        command,
        description,
        outputFile,
        outputOffset: 0,
        startTime: Date.now(),
        notified: false,
        isBackgrounded: true,
      },
    });

    return {
      ok: true,
      data: {
        backgroundTaskId: taskId,
        outputFile,
        message: "Command running in background.",
      },
    };
  }

  return runForegroundBash(input, context);
}
```

第一版先支持显式 `run_in_background`。后面再加前台转后台和自动后台化。

## 前台进度

前台命令如果超过一个短阈值还没结束，就显示进度。

```ts
// src/tools/bashTool.ts
const PROGRESS_THRESHOLD_MS = 1_000;
const PROGRESS_INTERVAL_MS = 1_000;

async function runForegroundBash(input: BashToolInput, context: ToolExecutionContext) {
  const taskId = generateTaskId("local_bash");
  const outputFile = await initTaskOutput(context.sessionId, taskId);
  const output = new TaskOutput(context.sessionId, taskId, outputFile);

  const process = await startProcess({
    cmd: [context.shellPath, "-lc", input.command],
    cwd: context.cwd,
    timeoutMs: input.timeoutMs ?? 120_000,
    signal: context.abortController.signal,
    outputDir: context.outputDir,
    maxOutputBytes: 256_000,
    output,
  });

  const initial = await Promise.race([
    process.result,
    sleep(PROGRESS_THRESHOLD_MS).then(() => null),
  ]);

  if (initial) {
    return {
      ok: initial.code === 0,
      data: {
        code: initial.code,
        output: initial.stdout,
      },
    };
  }

  const progressTimer = setInterval(() => {
    void output.progress().then((progress) => {
      context.onToolProgress?.({
        type: "bash_progress",
        taskId,
        output: progress.lastLines,
        totalBytes: progress.totalBytes,
      });
    });
  }, PROGRESS_INTERVAL_MS);

  try {
    const result = await process.result;
    return {
      ok: result.code === 0,
      data: {
        code: result.code,
        output: result.stdout,
      },
    };
  } finally {
    clearInterval(progressTimer);
  }
}
```

如果你前面章节的 ToolRunner 已经支持 async generator progress，可以把这里改成 `yield`。核心是不要等命令结束才让用户看到输出。

## 前台转后台

真实工程里用户可以按快捷键把所有前台任务转入后台。Mini 可以先用命令实现：

```text
/tasks background <taskId>
```

但更实用的是：前台命令一旦进入 progress 状态，就注册成“可后台化”的 foreground task。

```ts
// src/tasks/localShellTask.ts
export function registerForegroundShellTask(input: {
  taskId: string;
  command: string;
  description: string;
  outputFile: string;
  taskStore: TaskStore;
}): void {
  input.taskStore.register({
    id: input.taskId,
    type: "local_bash",
    status: "running",
    command: input.command,
    description: input.description,
    outputFile: input.outputFile,
    outputOffset: 0,
    startTime: Date.now(),
    notified: false,
    isBackgrounded: false,
  });
}

export function backgroundForegroundTask(taskId: string, taskStore: TaskStore): boolean {
  const task = taskStore.get(taskId);
  if (!task || task.type !== "local_bash" || task.isBackgrounded) {
    return false;
  }

  taskStore.update(taskId, (current) => ({
    ...current,
    isBackgrounded: true,
  }));

  return true;
}
```

前台转后台后，BashTool 立即返回：

```ts
return {
  ok: true,
  data: {
    backgroundTaskId: taskId,
    outputFile,
    message: "Command moved to background.",
  },
};
```

后续完成通知由 `registerLocalShellTask()` 里的 `process.result.then()` 负责。

## 自动后台化

有些场景不应该让主 Agent 一直等待，例如启动 dev server。Mini 可以加一个保守的自动后台化规则：

```ts
// src/tools/bashTool.ts
const AUTO_BACKGROUND_AFTER_MS = 15_000;
const AUTO_BACKGROUND_DENYLIST = ["sleep", "read"];

function canAutoBackground(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return !AUTO_BACKGROUND_DENYLIST.includes(first);
}
```

前台执行时设置 timer：

```ts
const autoBackgroundTimer = setTimeout(() => {
  if (!canAutoBackground(input.command)) {
    return;
  }

  backgroundForegroundTask(taskId, context.taskStore);
  processMovedToBackground = true;
}, AUTO_BACKGROUND_AFTER_MS);
```

如果 timer 触发，BashTool 返回后台 task id。真实工程还区分 assistant mode 的自动后台化、用户手动后台化、timeout 后台化。Mini 第一版只做一个清晰规则即可。

## TaskOutputTool

模型需要能读取后台任务输出：

```ts
// src/tools/taskOutputTool.ts
import { z } from "zod";
import { getTaskOutputTail } from "../tasks/diskOutput";
import { isTerminalTaskStatus } from "../tasks/taskTypes";
import { sleep } from "../utils/sleep";

export const TaskOutputTool = {
  name: "TaskOutput",
  description: "Read output from a background task",
  inputSchema: z.object({
    task_id: z.string(),
    block: z.boolean().default(true),
    timeoutMs: z.number().default(30_000),
  }),
  isReadOnly() {
    return true;
  },
  async execute(input, context) {
    const task = context.taskStore.get(input.task_id);
    if (!task) {
      return {
        ok: false,
        error: `No task found: ${input.task_id}`,
      };
    }

    if (input.block) {
      await waitForTask(task.id, context, input.timeoutMs);
    }

    const latest = context.taskStore.get(task.id);
    const output = await getTaskOutputTail(context.sessionId, task.id);

    return {
      ok: true,
      data: {
        retrieval_status:
          latest && isTerminalTaskStatus(latest.status) ? "success" : "not_ready",
        task: latest,
        output,
      },
    };
  },
};

async function waitForTask(taskId: string, context: ToolExecutionContext, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = context.taskStore.get(taskId);
    if (!task || isTerminalTaskStatus(task.status)) {
      return;
    }
    await sleep(100);
  }
}
```

真实工程现在更推荐直接用 Read 工具读取 output file，因为任务结果里已经给了路径。但 Mini 保留 TaskOutputTool，有助于读者理解后台任务闭环。

## TaskStopTool

停止任务：

```ts
// src/tools/taskStopTool.ts
import { z } from "zod";
import { stopTask } from "../tasks/stopTask";

export const TaskStopTool = {
  name: "TaskStop",
  description: "Stop a running background task",
  inputSchema: z.object({
    task_id: z.string(),
  }),
  async execute(input, context) {
    const result = await stopTask(input.task_id, {
      taskStore: context.taskStore,
      processes: context.processes,
    });

    return {
      ok: true,
      data: result,
    };
  },
};
```

统一停止逻辑：

```ts
// src/tasks/stopTask.ts
import { cleanupTaskOutput } from "./diskOutput";
import { isTerminalTaskStatus } from "./taskTypes";

export async function stopTask(
  taskId: string,
  context: {
    taskStore: TaskStore;
    processes: Map<string, RunningProcess>;
    sessionId: string;
  },
): Promise<{ taskId: string; status: "killed"; description: string }> {
  const task = context.taskStore.get(taskId);
  if (!task) {
    throw new Error(`No task found with ID: ${taskId}`);
  }

  if (isTerminalTaskStatus(task.status)) {
    throw new Error(`Task ${taskId} is not running.`);
  }

  context.processes.get(taskId)?.kill();
  context.processes.delete(taskId);

  context.taskStore.update(taskId, (current) => ({
    ...current,
    status: "killed",
    notified: true,
    endTime: Date.now(),
  }));

  await cleanupTaskOutput(context.sessionId, taskId);

  return {
    taskId,
    status: "killed",
    description: task.description,
  };
}
```

真实工程对 Bash stop 会抑制多余的完成通知，避免模型同时收到“停止成功”和“退出码 137”。Mini 也通过 `notified: true` 做这个控制。

## `/tasks` 命令

给用户一个本地管理入口：

```ts
// src/commands/tasksCommand.ts
export const tasksCommand: LocalCommand = {
  type: "local",
  name: "tasks",
  description: "List, read, or stop background tasks",
  source: "builtin",
  async run(args, context) {
    const [action, taskId] = args.trim().split(/\s+/);

    if (!action) {
      const tasks = context.taskStore.list();
      if (tasks.length === 0) {
        return { type: "text", text: "No background tasks." };
      }

      return {
        type: "text",
        text: tasks
          .map((task) => `${task.id} [${task.status}] ${task.description}\n  ${task.outputFile}`)
          .join("\n"),
      };
    }

    if (action === "read" && taskId) {
      const output = await getTaskOutputTail(context.sessionId, taskId);
      return { type: "text", text: output || "(No output)" };
    }

    if (action === "stop" && taskId) {
      const result = await stopTask(taskId, {
        sessionId: context.sessionId,
        taskStore: context.taskStore,
        processes: context.processes,
      });
      return { type: "text", text: `Stopped ${result.taskId}: ${result.description}` };
    }

    return {
      type: "text",
      text: "Usage: /tasks | /tasks read <taskId> | /tasks stop <taskId>",
    };
  },
};
```

这里的 `/tasks` 是运行时后台任务，不是第 13 章 planner 的 todo。

## 轮询任务状态

后台任务完成时已经有 `process.result.then()`。轮询主要用于：

- 发现新输出 delta。
- UI 显示任务还在跑。
- 清理已经通知过的终态任务。

```ts
// src/tasks/taskPoller.ts
import { getTaskOutputDelta } from "./diskOutput";
import { isTerminalTaskStatus } from "./taskTypes";

export function startTaskPoller(context: {
  sessionId: string;
  taskStore: TaskStore;
  onOutputDelta?: (input: {
    taskId: string;
    content: string;
    outputFile: string;
  }) => void;
}): () => void {
  const timer = setInterval(() => {
    void pollTasks(context);
  }, 1_000);

  timer.unref();
  return () => clearInterval(timer);
}

async function pollTasks(context: {
  sessionId: string;
  taskStore: TaskStore;
  onOutputDelta?: (input: {
    taskId: string;
    content: string;
    outputFile: string;
  }) => void;
}): Promise<void> {
  for (const task of context.taskStore.list()) {
    if (task.status === "running") {
      const delta = await getTaskOutputDelta({
        sessionId: context.sessionId,
        taskId: task.id,
        fromOffset: task.outputOffset,
      });

      if (delta.content) {
        context.taskStore.update(task.id, (current) => ({
          ...current,
          outputOffset: delta.newOffset,
        }));
        context.onOutputDelta?.({
          taskId: task.id,
          content: delta.content,
          outputFile: task.outputFile,
        });
      }
    }

    if (isTerminalTaskStatus(task.status) && task.notified) {
      context.taskStore.remove(task.id);
    }
  }
}
```

第一版可以不把 delta 注入模型，只给 UI 或日志使用。完成通知才是模型可见事件。

## 卡住检测

后台命令可能停在交互式提示：

```text
Overwrite? (y/n)
Press Enter to continue
```

真实工程会在输出停止增长后检查 tail，看起来像 prompt 时发通知。

Mini 版：

```ts
// src/tasks/localShellTask.ts
const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;

const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

export function looksLikePrompt(outputTail: string): boolean {
  const lastLine = outputTail.trimEnd().split("\n").at(-1) ?? "";
  return PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}
```

注册任务后启动 watchdog：

```ts
function startStallWatchdog(task: LocalShellTaskState, context: TaskContext): () => void {
  let lastSize = 0;
  let lastGrowth = Date.now();

  const timer = setInterval(() => {
    void stat(task.outputFile).then(async (info) => {
      if (info.size > lastSize) {
        lastSize = info.size;
        lastGrowth = Date.now();
        return;
      }

      if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) {
        return;
      }

      const tail = await getTaskOutputTail(context.sessionId, task.id, 1024);
      if (!looksLikePrompt(tail)) {
        lastGrowth = Date.now();
        return;
      }

      enqueueTaskNotification({
        sessionId: context.sessionId,
        taskId: task.id,
        taskType: task.type,
        status: "running",
        description: `${task.description} appears to be waiting for interactive input`,
        outputFile: task.outputFile,
      });
    }).catch(() => {});
  }, STALL_CHECK_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
```

这不是为了自动回答交互提示，而是提醒模型或用户重新用非交互参数执行。

## Agent 退出清理

如果子 Agent 启动了后台 Bash，Agent 结束时要杀掉它们，否则会留下孤儿进程。

```ts
// src/tasks/localShellTask.ts
export function stopTasksForOwner(input: {
  agentId: string;
  taskStore: TaskStore;
  processes: Map<string, RunningProcess>;
}): void {
  for (const task of input.taskStore.list()) {
    if (task.agentId === input.agentId && task.status === "running") {
      input.processes.get(task.id)?.kill();
      input.taskStore.update(task.id, (current) => ({
        ...current,
        status: "killed",
        notified: true,
        endTime: Date.now(),
      }));
    }
  }
}
```

如果 Mini 还没有子 Agent，可以先在会话退出时清理所有 running task：

```ts
export function stopAllRunningTasks(context: TaskRuntimeContext): void {
  for (const task of context.taskStore.list()) {
    if (task.status === "running") {
      context.processes.get(task.id)?.kill();
    }
  }
}
```

## Transcript 事件

后台任务要进入 transcript：

```ts
// src/transcript/types.ts
export type TranscriptEventName =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_killed"
  | "task_notification";
```

注册任务时：

```ts
await recordTranscriptEvent({
  event: "task_started",
  data: {
    taskId,
    type: "local_bash",
    description,
    outputFile,
    command,
  },
});
```

结束任务时：

```ts
await recordTranscriptEvent({
  event: result.code === 0 ? "task_completed" : "task_failed",
  data: {
    taskId,
    exitCode: result.code,
    outputFile,
  },
});
```

这样恢复会话时，即使不恢复进程，也能知道历史上发生过什么。

## 测试

建议新增：

```ts
// src/tasks/__tests__/taskIds.test.ts
describe("generateTaskId", () => {
  test("uses task type prefix", () => {});
  test("generates unique IDs", () => {});
});

// src/tasks/__tests__/diskOutput.test.ts
describe("disk task output", () => {
  test("creates output file under session task directory", async () => {});
  test("reads tail without loading full file", async () => {});
  test("reads delta from offset", async () => {});
});

// src/tasks/__tests__/localShellTask.test.ts
describe("local shell task", () => {
  test("registers running task", async () => {});
  test("marks task completed when process exits with zero", async () => {});
  test("marks task failed when process exits non-zero", async () => {});
  test("stops running process", async () => {});
});

// src/tools/__tests__/taskOutputTool.test.ts
describe("TaskOutputTool", () => {
  test("returns not_ready for running task with block false", async () => {});
  test("waits for completion with block true", async () => {});
});

// src/commands/__tests__/tasksCommand.test.ts
describe("/tasks", () => {
  test("lists tasks", async () => {});
  test("reads task output", async () => {});
  test("stops task", async () => {});
});
```

对应命令：

```bash
bun test src/tasks/__tests__/taskIds.test.ts
bun test src/tasks/__tests__/diskOutput.test.ts
bun test src/tasks/__tests__/localShellTask.test.ts
bun test src/tools/__tests__/taskOutputTool.test.ts
bun test src/commands/__tests__/tasksCommand.test.ts
bun run typecheck
```

## 常见问题

### 为什么不让模型一直等命令结束？

长运行命令可能永远不结束。后台化能让主对话继续推进，同时保留输出和停止能力。

### 为什么输出要写文件？

后台任务输出没有天然上限。写文件可以避免撑爆内存，也方便后续用 Read 或 TaskOutputTool 按需读取。

### 为什么任务完成要发通知？

模型不应该一直轮询任务。完成通知让下一轮对话自然获得任务状态和 output file 路径。

### 为什么 stop 后要 suppress 后续完成通知？

用户已经知道自己停止了任务。如果进程随后以 137 或类似退出码结束，再发一条失败通知会制造噪音。任务状态里用 `notified` 控制这一点。

### 为什么前台任务也要注册？

因为用户可能在命令运行中途决定后台化。只有先注册成 foreground task，后续才能原地切换到 background，而不是重新启动同一个命令。

### TaskOutputTool 和 Read output file 哪个更好？

真实工程更推荐直接 Read output file，因为 task notification 已经带了路径。Mini 保留 TaskOutputTool，是为了让模型能用 task id 完成闭环，也方便测试。

## 本章完成标准

完成后应满足：

- Mini 有统一 `TaskState` 类型。
- Task id 带类型前缀，Bash task 以 `b` 开头。
- 后台任务输出写入 session 隔离目录。
- 输出文件创建时避免跟随 symlink。
- BashTool 支持 `run_in_background`。
- BashTool 返回 `backgroundTaskId` 和 `outputFile`。
- 前台长命令能产生 progress。
- 前台长命令可以转入后台。
- 后台任务完成后更新状态为 `completed` 或 `failed`。
- 后台任务完成后产生 task notification。
- Agent Loop 会在下一轮请求前注入 task notification。
- TaskOutputTool 可以读取任务输出。
- TaskStopTool 可以停止 running task。
- `/tasks` 可以 list/read/stop。
- 输出读取使用 tail/delta，不整文件读入内存。
- 输出过大时会停止任务或截断读取。
- 会话退出或 Agent 退出时会清理 running task。
- task started/completed/failed/killed 写入 transcript。
- `bun run typecheck` 通过。

第二十九章到这里，Mini 已经能处理长运行命令，不再被 dev server、watch mode 和持续日志卡住。下一章可以继续做多 Agent：把大型任务拆给子 Agent，让主 Agent 负责协调、收集结果和管理后台执行。
