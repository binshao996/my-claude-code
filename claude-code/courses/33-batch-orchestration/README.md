# 第 33 章：批处理编排与并行任务拆分

第三十二章解决了一个关键问题：写代码的子 Agent 可以在独立 worktree 中运行，不会直接污染主工作区。

现在可以继续往上做一层：

```text
让主 Agent 把大型任务拆成多个独立 worktree worker，并行执行。
```

这类任务很常见：

- 大规模重命名。
- 多目录迁移。
- 批量替换旧 API。
- 给一批模块补类型。
- 给一批组件补测试。
- 把同一套模式推广到多个 package。

如果主 Agent 自己串行做，容易慢、容易丢上下文，也很难在一个上下文窗口里同时关注几十个文件。

更合理的流程是：

```text
主 Agent 先研究和拆分。
每个 worker 只拿一个明确 work unit。
所有 worker 都在独立 worktree 中后台运行。
主 Agent 收集结果，生成状态表，再决定合并顺序。
```

本章给 Mini 增加一个 `/batch` 能力：把大型任务变成一批可并行执行的 worktree Agent。

## 真实工程怎么做

真实工程里批处理相关能力分布在几层：

- `src/skills/bundled/batch.ts`：内置 `/batch` skill。它不是普通脚本，而是一段强约束 prompt：要求主 Agent 先进入 Plan Mode，研究影响范围，拆成独立 work units，然后每个 unit 用 `Agent` 工具后台启动，并强制 `isolation: "worktree"`。
- `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx`：真正启动 worker Agent，支持 `run_in_background` 和 `isolation: "worktree"`。
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`：后台 worker 完成后产生通知，包含输出文件、状态、结果和 worktree 信息。
- `packages/builtin-tools/src/tools/WorkflowTool/WorkflowTool.ts`：用户级 workflow 工具。它把 workflow run 持久化到 `.claude/workflow-runs/`，支持 start、advance、status、cancel、list。
- `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`：后台 workflow task，记录 workflow 名称、文件、摘要、agent 数量、输出、取消、skip、retry。
- `packages/builtin-tools/src/tools/TaskCreateTool/TaskCreateTool.ts`、`TaskUpdateTool`、`TaskListTool`、`TaskGetTool`：结构化任务列表，适合团队和多 Agent 协作时跟踪状态。
- `src/utils/generators.ts`：提供带并发上限的 async generator 合并能力。
- `src/components/tasks/BackgroundTasksDialog.tsx`：UI 里展示后台 Agent、workflow 和其他任务。

真实 `/batch` 的核心不是“启动很多 Agent”这么简单，而是三段式：

```text
1. Research and Plan
   先研究影响范围，找出拆分方式和验证方式。

2. Spawn Workers
   计划确认后，一次性启动多个后台 worktree Agent。

3. Track Progress
   根据后台完成通知更新状态表，汇总成功、失败和结果链接。
```

Mini 也采用这个结构，但先实现得轻一点。

## 本章目标

完成后，Mini 支持：

```bash
bun run src/cli.ts batch "把旧的 requestClient 调用迁移到 newApiClient"
```

它会先把用户请求转换成批处理规划 prompt，让主 Agent 做研究和拆分。

当计划确认后，主 Agent 可以调用一个 `BatchLaunch` 工具：

```json
{
  "instruction": "把旧的 requestClient 调用迁移到 newApiClient",
  "verificationRecipe": "每个 worker 修改后运行相关测试；如果找不到更小范围测试，运行 bun run typecheck。",
  "units": [
    {
      "title": "迁移 auth 模块",
      "scope": ["src/auth"],
      "prompt": "只迁移 src/auth 下的 requestClient 调用，不要修改公共 client。"
    },
    {
      "title": "迁移 billing 模块",
      "scope": ["src/billing"],
      "prompt": "只迁移 src/billing 下的 requestClient 调用，不要修改公共 client。"
    }
  ]
}
```

Mini 会：

1. 创建一个 batch run。
2. 为每个 unit 启动一个后台 Agent。
3. 强制每个 worker 使用 `isolation: "worktree"`。
4. 强制每个 worker 使用 `run_in_background: true`。
5. 持久化每个 worker 的 task id、agent id、worktree path 和状态。
6. 后台 Agent 完成时更新 batch run。
7. 提供 `batch status <runId>` 查看状态表。
8. 提供每个 unit 的 worktree diff 和 merge 入口。

本章要实现：

- `/batch` prompt 命令。
- `BatchLaunch` 工具。
- batch run 持久化。
- worker prompt 模板。
- batch 状态更新。
- 完成通知解析。
- 状态表渲染。
- 失败、取消、重试的最小策略。

## 推荐目录

新增：

```text
src/batch/
  batchTypes.ts
  batchPrompt.ts
  batchRunStore.ts
  batchWorkerPrompt.ts
  batchLaunchTool.ts
  batchStatus.ts
  batchNotifications.ts

src/commands/
  batchCommand.ts
```

修改：

```text
src/cli.ts
src/tools/toolRegistry.ts
src/tasks/taskTypes.ts
src/tasks/taskNotifications.ts
src/tasks/localAgentTask.ts
```

第三十二章已经实现的 worktree diff 和 merge 命令会继续复用。

## Batch 类型

先定义 batch run 的结构。

```ts
// src/batch/batchTypes.ts
export type BatchUnitStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type BatchWorkUnitInput = {
  title: string;
  scope: string[];
  prompt: string;
};

export type BatchWorkerUnit = BatchWorkUnitInput & {
  id: string;
  status: BatchUnitStatus;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
};

export type BatchRunStatus =
  | "planning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type BatchRun = {
  id: string;
  instruction: string;
  verificationRecipe: string;
  status: BatchRunStatus;
  createdAt: number;
  updatedAt: number;
  units: BatchWorkerUnit[];
};

export type BatchLaunchInput = {
  instruction: string;
  verificationRecipe: string;
  units: BatchWorkUnitInput[];
  workerAgentType?: string;
};
```

`scope` 是这个 unit 的文件或目录范围。它不只是展示字段，后面会用来检查拆分质量。

## Batch Run Store

和 workflow run 一样，batch run 需要落盘。

```ts
// src/batch/batchRunStore.ts
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BatchRun } from "./batchTypes";

const BATCH_RUNS_DIR = ".mini/batch-runs";

export function batchRunPath(cwd: string, runId: string): string {
  return join(cwd, BATCH_RUNS_DIR, `${runId}.json`);
}

export async function saveBatchRun(cwd: string, run: BatchRun): Promise<void> {
  await mkdir(join(cwd, BATCH_RUNS_DIR), { recursive: true });
  await writeFile(batchRunPath(cwd, run.id), JSON.stringify(run, null, 2) + "\n");
}

export async function readBatchRun(
  cwd: string,
  runId: string,
): Promise<BatchRun | null> {
  try {
    return JSON.parse(await readFile(batchRunPath(cwd, runId), "utf8")) as BatchRun;
  } catch {
    return null;
  }
}

export async function listBatchRuns(cwd: string): Promise<BatchRun[]> {
  let files: string[] = [];
  try {
    files = await readdir(join(cwd, BATCH_RUNS_DIR));
  } catch {
    return [];
  }

  const runs = await Promise.all(
    files
      .filter(file => file.endsWith(".json"))
      .map(file => readBatchRun(cwd, file.slice(0, -".json".length))),
  );

  return runs
    .filter((run): run is BatchRun => run !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
```

状态落盘有两个好处：

- CLI 重启后还能看 batch 状态。
- 后台 worker 完成通知可以增量更新 run。

## `/batch` Prompt

真实工程的 `/batch` 是一个内置 skill，本质上是把用户输入转成一段强 prompt。Mini 也先这么做。

```ts
// src/batch/batchPrompt.ts
export function buildBatchPlanningPrompt(instruction: string): string {
  return `# Batch: 并行任务编排

你正在编排一个大型代码改动。

用户需求：

${instruction}

请按下面流程执行。

## Phase 1: 研究和规划

1. 先理解需求影响范围。
2. 使用只读工具或 explorer Agent 查找相关文件、模块、测试和约定。
3. 判断这个任务是否适合并行拆分。
4. 如果不适合并行，说明原因，并改为普通实现流程。

## Phase 2: 拆分 work units

如果适合并行，把任务拆成 2-8 个独立 work units。

每个 unit 必须满足：

- 可以在独立 worktree 中实现。
- 文件范围尽量不和其他 unit 重叠。
- 不依赖其他 unit 先完成。
- 可以单独验证。
- 范围不能过大，也不能只是一个无意义的小文件。

每个 unit 输出：

- title：短标题。
- scope：文件或目录列表。
- prompt：完整 worker 指令。

## Phase 3: 验证方案

写出每个 worker 都能执行的验证方案。
优先选择最小相关验证。
如果找不到更小范围验证，使用 bun run typecheck。

## Phase 4: 等待确认

向用户展示计划。
用户确认后，调用 BatchLaunch 工具启动 workers。

BatchLaunch 要求：

- 每个 worker 必须 run_in_background。
- 每个 worker 必须 isolation: "worktree"。
- worker prompt 必须完整，不依赖当前对话上下文。
`;
}
```

接入 CLI：

```ts
// src/commands/batchCommand.ts
import { buildBatchPlanningPrompt } from "../batch/batchPrompt";
import { findGitRoot } from "../worktrees/agentWorktree";

export async function handleBatchCommand(input: {
  cwd: string;
  instruction: string;
}): Promise<string> {
  if (!input.instruction.trim()) {
    return "Usage: batch <instruction>";
  }

  const gitRoot = await findGitRoot(input.cwd);
  if (!gitRoot) {
    return "Batch mode requires a git repository because workers run in isolated worktrees.";
  }

  return buildBatchPlanningPrompt(input.instruction.trim());
}
```

在 `cli.ts` 里：

```ts
if (process.argv[2] === "batch") {
  const instruction = process.argv.slice(3).join(" ");
  const prompt = await handleBatchCommand({
    cwd: process.cwd(),
    instruction,
  });

  await startChatLoop({
    initialPrompt: prompt,
  });
  return;
}
```

这一步完成后，`batch` 命令已经能驱动主 Agent 进入批处理规划流程。

## 拆分质量校验

不要让模型拆出明显冲突的 units。先写一个简单校验函数。

```ts
// src/batch/batchLaunchTool.ts
import type { BatchWorkUnitInput } from "./batchTypes";

export function validateBatchUnits(units: BatchWorkUnitInput[]): void {
  if (units.length < 2) {
    throw new Error("Batch requires at least 2 work units");
  }

  if (units.length > 8) {
    throw new Error("Mini batch supports at most 8 work units");
  }

  const seenScopes = new Map<string, string>();

  for (const unit of units) {
    if (!unit.title.trim()) {
      throw new Error("Batch unit title is required");
    }

    if (!unit.prompt.trim()) {
      throw new Error(`Batch unit "${unit.title}" has empty prompt`);
    }

    if (unit.scope.length === 0) {
      throw new Error(`Batch unit "${unit.title}" must declare scope`);
    }

    for (const scope of unit.scope) {
      const normalized = scope.replace(/\/+$/, "");
      const existing = seenScopes.get(normalized);
      if (existing) {
        throw new Error(
          `Scope "${scope}" is used by both "${existing}" and "${unit.title}"`,
        );
      }
      seenScopes.set(normalized, unit.title);
    }
  }
}
```

这只是第一层校验。真实冲突还可能发生在共享基础文件上，所以 worker prompt 也要明确：

```text
如果你发现必须修改 unit scope 外的公共文件，停止并报告原因。
```

## Worker Prompt

每个 worker 都必须拿到完整上下文。不要写“按计划第 3 项做”这种 prompt。

```ts
// src/batch/batchWorkerPrompt.ts
import type { BatchWorkUnitInput } from "./batchTypes";

export function buildBatchWorkerPrompt(input: {
  instruction: string;
  verificationRecipe: string;
  unit: BatchWorkUnitInput;
}): string {
  return `# Batch Worker

你是一个独立 worktree worker。

## 总目标

${input.instruction}

## 你的 work unit

标题：${input.unit.title}

范围：
${input.unit.scope.map(item => `- ${item}`).join("\n")}

任务：

${input.unit.prompt}

## 硬规则

- 只处理本 work unit 范围内的文件或模块。
- 不要修改和本 unit 无关的共享基础文件。
- 如果必须修改 scope 外文件，停止并说明原因。
- 修改前先阅读相关代码。
- 修改后运行验证。
- 不要切换回主工作区。
- 不要删除 worktree。

## 验证方案

${input.verificationRecipe}

## 最终输出格式

请用下面格式结束：

RESULT: done | failed
SUMMARY: <一段简短摘要>
FILES:
- <changed file>
VALIDATION:
- <command>: <result>
RISK:
- <remaining risk or none>
`;
}
```

这个 prompt 要非常具体。worker 没有主 Agent 的全部思考过程，所以必须把目标、范围、验证方式和输出格式写进去。

## BatchLaunch Tool

`BatchLaunch` 是 Mini 版批处理的执行入口。

它不负责规划，只负责把已确认的 work units 启动成后台 worktree Agent。

```ts
// src/batch/batchLaunchTool.ts
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../tools/toolTypes";
import type { AgentToolInput, AgentToolOutput } from "../agents/agentTypes";
import type { BatchLaunchInput, BatchRun } from "./batchTypes";
import { buildBatchWorkerPrompt } from "./batchWorkerPrompt";
import { saveBatchRun } from "./batchRunStore";

export type AgentLauncher = (input: AgentToolInput) => Promise<AgentToolOutput>;

export function createBatchLaunchTool(input: {
  cwd: string;
  launchAgent: AgentLauncher;
}): ToolDefinition<BatchLaunchInput, { runId: string; status: string }> {
  return {
    name: "batch_launch",
    description: "Launch multiple background worktree agents for an approved batch plan",
    inputSchema: {
      type: "object",
      required: ["instruction", "verificationRecipe", "units"],
      properties: {
        instruction: { type: "string" },
        verificationRecipe: { type: "string" },
        workerAgentType: { type: "string" },
        units: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "scope", "prompt"],
            properties: {
              title: { type: "string" },
              scope: { type: "array", items: { type: "string" } },
              prompt: { type: "string" },
            },
          },
        },
      },
    },
    async call(args) {
      validateBatchUnits(args.units);

      const now = Date.now();
      const run: BatchRun = {
        id: randomUUID(),
        instruction: args.instruction,
        verificationRecipe: args.verificationRecipe,
        status: "running",
        createdAt: now,
        updatedAt: now,
        units: args.units.map((unit, index) => ({
          id: String(index + 1),
          ...unit,
          status: "pending",
        })),
      };

      await saveBatchRun(input.cwd, run);

      for (const unit of run.units) {
        unit.status = "running";
        unit.startedAt = Date.now();

        const output = await input.launchAgent({
          description: unit.title,
          subagent_type: args.workerAgentType ?? "worktree-worker",
          prompt: buildBatchWorkerPrompt({
            instruction: args.instruction,
            verificationRecipe: args.verificationRecipe,
            unit,
          }),
          run_in_background: true,
          isolation: "worktree",
        });

        if (output.status !== "async_launched") {
          throw new Error(`Expected async agent launch for unit "${unit.title}"`);
        }

        unit.agentId = output.agentId;
        unit.taskId = output.agentId;
        unit.outputFile = output.outputFile;
      }

      run.updatedAt = Date.now();
      await saveBatchRun(input.cwd, run);

      return {
        runId: run.id,
        status: renderBatchStatus(run),
      };
    },
  };
}
```

这里有一个重要选择：worker 启动失败时，本章先直接抛错。更完整的实现可以允许部分启动成功，然后把失败 unit 标成 `failed`。

Mini 第一版保持简单。

## 工具注册

`BatchLaunch` 需要调用 `Agent` 工具。不要让它复制 Agent 启动逻辑。

在工具注册时组合：

```ts
// src/tools/toolRegistry.ts
import { createBatchLaunchTool } from "../batch/batchLaunchTool";

export async function createToolRegistry(input: {
  cwd: string;
  parentSessionId: string;
}) {
  const baseTools = [
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
    createTaskOutputTool(),
    createTaskStopTool(),
  ];

  const agentTool = createAgentTool({
    registry: agentRegistry,
    availableTools: baseTools,
    parentSessionId: input.parentSessionId,
  });

  const batchLaunchTool = createBatchLaunchTool({
    cwd: input.cwd,
    launchAgent: args => agentTool.call(args, {
      cwd: input.cwd,
      toolUseId: `batch-${Date.now()}`,
      abortSignal: new AbortController().signal,
    }),
  });

  return {
    tools: [...baseTools, agentTool, batchLaunchTool],
    agentDefinitions,
  };
}
```

具体 `call` 的参数要按你前面章节的 Tool 接口调整。重点是依赖方向：

```text
BatchLaunch 依赖 AgentTool。
AgentTool 不知道 BatchLaunch。
```

这样多 Agent 能力仍然保持单一入口。

## 状态表渲染

批处理必须有一个状态表。否则用户只会看到一堆后台通知，无法判断全局进度。

```ts
// src/batch/batchStatus.ts
import type { BatchRun } from "./batchTypes";

export function renderBatchStatus(run: BatchRun): string {
  const lines: string[] = [];

  lines.push(`Batch run: ${run.id}`);
  lines.push(`Status: ${run.status}`);
  lines.push("");
  lines.push("| # | Unit | Status | Worktree |");
  lines.push("|---|------|--------|----------|");

  for (const unit of run.units) {
    const worktree = unit.worktreePath ? unit.worktreePath : "-";
    lines.push(`| ${unit.id} | ${unit.title} | ${unit.status} | ${worktree} |`);
  }

  const completed = run.units.filter(unit => unit.status === "completed").length;
  const failed = run.units.filter(unit => unit.status === "failed").length;
  const running = run.units.filter(unit => unit.status === "running").length;

  lines.push("");
  lines.push(`Summary: ${completed} completed, ${running} running, ${failed} failed`);

  return lines.join("\n");
}
```

命令：

```ts
// src/commands/batchCommand.ts
import { listBatchRuns, readBatchRun } from "../batch/batchRunStore";
import { renderBatchStatus } from "../batch/batchStatus";

export async function handleBatchStatus(input: {
  cwd: string;
  runId?: string;
}): Promise<string> {
  if (input.runId) {
    const run = await readBatchRun(input.cwd, input.runId);
    return run ? renderBatchStatus(run) : `Batch run not found: ${input.runId}`;
  }

  const runs = await listBatchRuns(input.cwd);
  if (runs.length === 0) {
    return "No batch runs found.";
  }

  return runs
    .slice(0, 20)
    .map(run => `${run.id} | ${run.status} | units=${run.units.length} | updated=${new Date(run.updatedAt).toLocaleString()}`)
    .join("\n");
}
```

CLI：

```ts
if (process.argv[2] === "batch" && process.argv[3] === "status") {
  console.log(await handleBatchStatus({
    cwd: process.cwd(),
    runId: process.argv[4],
  }));
  return;
}
```

使用：

```bash
bun run src/cli.ts batch status
bun run src/cli.ts batch status <runId>
```

## 接收 Worker 完成通知

第三十章和第三十二章已经让后台 Agent 完成时产生 task notification。现在需要把这个通知同步到 batch run。

最简单的入口是在 drain task notification 时：

```ts
// src/batch/batchNotifications.ts
import type { LocalAgentTaskState } from "../tasks/taskTypes";
import { listBatchRuns, saveBatchRun } from "./batchRunStore";

export async function updateBatchRunsFromAgentTask(input: {
  cwd: string;
  task: LocalAgentTaskState;
}): Promise<void> {
  const runs = await listBatchRuns(input.cwd);

  for (const run of runs) {
    const unit = run.units.find(item => item.agentId === input.task.agentId);
    if (!unit) {
      continue;
    }

    if (input.task.status === "completed") {
      unit.status = "completed";
      unit.result = input.task.result?.content;
      unit.worktreePath = input.task.result?.worktreePath;
      unit.worktreeBranch = input.task.result?.worktreeBranch;
      unit.completedAt = Date.now();
    } else if (input.task.status === "failed" || input.task.status === "killed") {
      unit.status = input.task.status === "killed" ? "cancelled" : "failed";
      unit.error = input.task.error ?? input.task.status;
      unit.completedAt = Date.now();
    }

    run.updatedAt = Date.now();

    if (run.units.every(item => item.status === "completed")) {
      run.status = "completed";
    } else if (run.units.some(item => item.status === "failed")) {
      run.status = "failed";
    } else if (run.units.some(item => item.status === "running")) {
      run.status = "running";
    }

    await saveBatchRun(input.cwd, run);
  }
}
```

接入任务通知：

```ts
// src/tasks/taskNotifications.ts
import { updateBatchRunsFromAgentTask } from "../batch/batchNotifications";

if (task.type === "local_agent" && task.status !== "running") {
  await updateBatchRunsFromAgentTask({
    cwd: getProjectRoot(),
    task,
  });
}
```

这一步让 batch status 自动更新，不需要主 Agent 手动维护表格。

## Worker 结果解析

worker prompt 要求最终输出 `RESULT`、`SUMMARY`、`FILES`、`VALIDATION`、`RISK`。可以先做轻量解析。

```ts
// src/batch/batchNotifications.ts
export type ParsedWorkerResult = {
  result: "done" | "failed" | "unknown";
  summary?: string;
  files: string[];
  validation: string[];
  risk: string[];
};

export function parseWorkerResult(text: string | undefined): ParsedWorkerResult {
  if (!text) {
    return {
      result: "unknown",
      files: [],
      validation: [],
      risk: [],
    };
  }

  const resultMatch = text.match(/^RESULT:\s*(done|failed)/im);
  const summaryMatch = text.match(/^SUMMARY:\s*(.+)$/im);

  return {
    result: resultMatch?.[1] === "done" ? "done" : resultMatch?.[1] === "failed" ? "failed" : "unknown",
    summary: summaryMatch?.[1],
    files: extractSectionList(text, "FILES"),
    validation: extractSectionList(text, "VALIDATION"),
    risk: extractSectionList(text, "RISK"),
  };
}

function extractSectionList(text: string, title: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `${title}:`);
  if (start === -1) {
    return [];
  }

  const result: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (/^[A-Z_]+:/.test(line)) {
      break;
    }
    if (line.startsWith("- ")) {
      result.push(line.slice(2).trim());
    }
  }
  return result;
}
```

这个解析只用于状态展示，不应该替代人工 review。真正合并前仍然看 diff。

## 失败和重试

Mini 第一版支持最小重试：

```bash
bun run src/cli.ts batch retry <runId> <unitId>
```

实现：

```ts
// src/batch/batchLaunchTool.ts
export async function retryBatchUnit(input: {
  cwd: string;
  runId: string;
  unitId: string;
  launchAgent: AgentLauncher;
}): Promise<string> {
  const run = await readBatchRun(input.cwd, input.runId);
  if (!run) {
    throw new Error(`Batch run not found: ${input.runId}`);
  }

  const unit = run.units.find(item => item.id === input.unitId);
  if (!unit) {
    throw new Error(`Batch unit not found: ${input.unitId}`);
  }

  unit.status = "running";
  unit.error = undefined;
  unit.result = undefined;
  unit.startedAt = Date.now();
  unit.completedAt = undefined;

  const output = await input.launchAgent({
    description: unit.title,
    subagent_type: "worktree-worker",
    prompt: buildBatchWorkerPrompt({
      instruction: run.instruction,
      verificationRecipe: run.verificationRecipe,
      unit,
    }),
    run_in_background: true,
    isolation: "worktree",
  });

  if (output.status !== "async_launched") {
    throw new Error("Retry worker did not start in background");
  }

  unit.agentId = output.agentId;
  unit.taskId = output.agentId;
  unit.outputFile = output.outputFile;
  run.status = "running";
  run.updatedAt = Date.now();

  await saveBatchRun(input.cwd, run);
  return renderBatchStatus(run);
}
```

重试应该启动新的 worktree。不要复用失败 worker 的 worktree，否则旧改动会污染新尝试。

## 取消 Batch

取消 batch 不是删除 worktree。它只是停止还在运行的 worker。

```ts
// src/batch/batchStatus.ts
import { stopTask } from "../tasks/stopTask";

export async function cancelBatchRun(input: {
  cwd: string;
  runId: string;
}): Promise<string> {
  const run = await readBatchRun(input.cwd, input.runId);
  if (!run) {
    return `Batch run not found: ${input.runId}`;
  }

  for (const unit of run.units) {
    if (unit.status !== "running" || !unit.taskId) {
      continue;
    }

    await stopTask(unit.taskId).catch(() => undefined);
    unit.status = "cancelled";
    unit.completedAt = Date.now();
  }

  run.status = "cancelled";
  run.updatedAt = Date.now();
  await saveBatchRun(input.cwd, run);

  return renderBatchStatus(run);
}
```

取消后已经产生改动的 worktree 仍然保留，交给用户确认是否删除。

## 合并策略

第三十二章已经有：

```bash
bun run src/cli.ts worktrees diff <taskId>
bun run src/cli.ts worktrees merge <taskId>
```

Batch 不应该自动合并所有 worker。

推荐合并流程：

1. `batch status <runId>` 看哪些 unit 完成。
2. 对每个完成 unit 查看 diff。
3. 先合并基础依赖最少的 unit。
4. 每合并一个 unit 后运行验证。
5. 冲突时暂停后续合并。
6. 所有 unit 合并后跑完整验证。

可以提供一个辅助命令列出 merge 候选：

```ts
// src/batch/batchStatus.ts
export function renderBatchMergeCandidates(run: BatchRun): string {
  const completed = run.units.filter(unit => {
    return unit.status === "completed" && unit.taskId && unit.worktreePath;
  });

  if (completed.length === 0) {
    return "No completed worktree units to merge.";
  }

  return completed
    .map(unit => {
      return `${unit.id}. ${unit.title}\n   task: ${unit.taskId}\n   worktree: ${unit.worktreePath}`;
    })
    .join("\n");
}
```

使用：

```bash
bun run src/cli.ts batch merge-candidates <runId>
```

真正 merge 仍然走 worktree 命令。

## 状态展示示例

`batch status` 输出：

```text
Batch run: 4b612aa0-8a51-4a10-a2cb-f2f16a7f8aa7
Status: running

| # | Unit | Status | Worktree |
|---|------|--------|----------|
| 1 | 迁移 auth 模块 | completed | .mini/worktrees/agent-a1 |
| 2 | 迁移 billing 模块 | running | - |
| 3 | 迁移 settings 模块 | failed | .mini/worktrees/agent-a3 |

Summary: 1 completed, 1 running, 1 failed
```

主 Agent 给用户总结时，不要隐藏失败：

```text
当前 3 个 worker：1 个完成、1 个运行中、1 个失败。
完成的 auth 模块改动保留在 worktree X。
失败的 settings 模块保留在 worktree Y，可查看失败输出后重试。
```

## 与 Workflow 的关系

Batch 和 Workflow 有重叠，但目标不同：

```text
Workflow：
  用户预先定义一串步骤，适合重复流程。

Batch：
  针对当前大型需求，动态研究、拆分并启动多个 worktree worker。
```

Mini 当前的 Batch 更像真实 `/batch` skill：由主 Agent 动态规划。

如果后续要做更强的 workflow，可以把 batch run 也纳入统一 task 系统，像真实工程的 `LocalWorkflowTask` 一样显示在后台任务面板里。

## 测试 Worker Prompt

```ts
// src/batch/__tests__/batchWorkerPrompt.test.ts
import { describe, expect, test } from "bun:test";
import { buildBatchWorkerPrompt } from "../batchWorkerPrompt";

describe("buildBatchWorkerPrompt", () => {
  test("includes instruction, scope and verification", () => {
    const prompt = buildBatchWorkerPrompt({
      instruction: "migrate client",
      verificationRecipe: "run bun run typecheck",
      unit: {
        title: "auth",
        scope: ["src/auth"],
        prompt: "migrate auth only",
      },
    });

    expect(prompt).toContain("migrate client");
    expect(prompt).toContain("src/auth");
    expect(prompt).toContain("migrate auth only");
    expect(prompt).toContain("run bun run typecheck");
    expect(prompt).toContain("RESULT:");
  });
});
```

## 测试 Unit 校验

```ts
// src/batch/__tests__/batchLaunchTool.test.ts
import { describe, expect, test } from "bun:test";
import { validateBatchUnits } from "../batchLaunchTool";

describe("validateBatchUnits", () => {
  test("rejects duplicated scope", () => {
    expect(() => {
      validateBatchUnits([
        { title: "a", scope: ["src/auth"], prompt: "a" },
        { title: "b", scope: ["src/auth"], prompt: "b" },
      ]);
    }).toThrow();
  });

  test("accepts independent units", () => {
    expect(() => {
      validateBatchUnits([
        { title: "auth", scope: ["src/auth"], prompt: "auth" },
        { title: "billing", scope: ["src/billing"], prompt: "billing" },
      ]);
    }).not.toThrow();
  });
});
```

## 测试 Batch Store

```ts
// src/batch/__tests__/batchRunStore.test.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { readBatchRun, saveBatchRun } from "../batchRunStore";

describe("batchRunStore", () => {
  test("saves and reads batch run", async () => {
    const cwd = join(tmpdir(), `mini-batch-${Date.now()}`);
    await mkdir(cwd, { recursive: true });

    await saveBatchRun(cwd, {
      id: "run1",
      instruction: "test",
      verificationRecipe: "bun run typecheck",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      units: [],
    });

    const run = await readBatchRun(cwd, "run1");
    expect(run?.instruction).toBe("test");
  });
});
```

## 测试 Launch

用 mock `launchAgent`，不要真的调用模型。

```ts
// src/batch/__tests__/batchLaunch.integration.test.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createBatchLaunchTool } from "../batchLaunchTool";
import { readBatchRun } from "../batchRunStore";

describe("BatchLaunch", () => {
  test("launches each unit as background worktree agent", async () => {
    const cwd = join(tmpdir(), `mini-batch-${Date.now()}`);
    await mkdir(cwd, { recursive: true });

    const launched: unknown[] = [];
    const tool = createBatchLaunchTool({
      cwd,
      async launchAgent(input) {
        launched.push(input);
        return {
          status: "async_launched",
          agentId: `agent-${launched.length}`,
          description: input.description,
          prompt: input.prompt,
          outputFile: `.mini/tasks/agent-${launched.length}.output`,
        };
      },
    });

    const result = await tool.call({
      instruction: "migrate",
      verificationRecipe: "bun run typecheck",
      units: [
        { title: "auth", scope: ["src/auth"], prompt: "auth" },
        { title: "billing", scope: ["src/billing"], prompt: "billing" },
      ],
    });

    expect(result.runId).toBeTruthy();
    expect(launched).toHaveLength(2);
    expect(launched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_in_background: true,
          isolation: "worktree",
        }),
      ]),
    );

    const run = await readBatchRun(cwd, result.runId);
    expect(run?.units.map(unit => unit.status)).toEqual(["running", "running"]);
  });
});
```

运行：

```bash
bun test src/batch/__tests__/batchWorkerPrompt.test.ts
bun test src/batch/__tests__/batchLaunchTool.test.ts
bun test src/batch/__tests__/batchRunStore.test.ts
bun test src/batch/__tests__/batchLaunch.integration.test.ts
bun run typecheck
```

## 验收清单

本章完成后，手动检查：

- `batch <instruction>` 会进入批处理规划 prompt。
- 非 Git 仓库会拒绝 batch。
- 主 Agent 会先研究和拆分，而不是直接启动 worker。
- `BatchLaunch` 要求 2-8 个 work units。
- work unit 必须有 title、scope、prompt。
- 重复 scope 会被拒绝。
- 每个 worker 都以 `run_in_background: true` 启动。
- 每个 worker 都以 `isolation: "worktree"` 启动。
- batch run 会写入 `.mini/batch-runs/`。
- `batch status` 能展示运行状态。
- worker 完成通知能更新 batch run。
- 失败 worker 会标记 failed，并保留错误。
- 完成 worker 会记录 worktree path。
- `batch retry` 能重新启动失败 unit。
- `batch cancel` 能停止运行中的 worker。
- `bun run typecheck` 通过。

## 常见坑

### 1. 没有先研究就拆分

批处理最怕“按文件夹随便切”。主 Agent 必须先查调用关系、公共模块和验证方式，再拆 units。

### 2. worker prompt 太短

worker 没有主 Agent 的完整上下文。每个 prompt 必须包含总目标、unit 范围、验证方式、限制和输出格式。

### 3. units 互相依赖

如果 B 必须等 A 改完才能做，就不能并行。先让 A 单独完成，再根据结果拆下一批。

### 4. 自动合并所有 worktree

worktree 隔离解决并行写入，不解决语义冲突。Batch 只能收集结果，合并仍要显式 review。

### 5. 忘记持久化 run 状态

后台 worker 可能几分钟后才完成。只把状态存在内存里，CLI 重启后就无法汇总。

### 6. 取消时删除 worktree

取消代表停止执行，不代表丢弃结果。已经产生改动的 worktree 应保留，等用户确认。

### 7. 没有全局状态表

多个后台通知会很散。Batch 必须提供状态表，让用户能看清每个 unit 的进展。

## 本章小结

第三十三章把 Mini 的多 Agent 能力从“单个 worktree worker”升级成了“批处理编排器”。

现在系统具备了：

- `/batch` 规划 prompt。
- 批处理 work unit 拆分约束。
- `BatchLaunch` 工具。
- 多个后台 worktree worker 并行启动。
- batch run 持久化。
- worker 完成通知同步到 batch run。
- `batch status` 状态表。
- 失败、取消、重试的最小策略。
- 和 worktree diff / merge 的衔接。

到这里，Mini 已经可以处理大规模、可拆分的代码迁移任务。

下一章可以继续做 **验证 Agent 与交付门禁**：让批处理或普通任务完成后，由独立 verifier 检查 diff、测试结果和风险，再决定是否可以交付。
