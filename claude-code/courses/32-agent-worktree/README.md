# 第 32 章：Agent 工作树隔离与并行改动合并

第三十一章让 Mini 支持了项目级 Agent。现在项目可以在 `.mini/agents/*.md` 里定义自己的 reviewer、runner、investigator。

但还有一个问题没有解决：

```text
多个会写代码的子 Agent 并行运行时，不能都改同一个工作区。
```

例如主 Agent 同时派发三个任务：

- Agent A 修改登录逻辑。
- Agent B 修改接口类型。
- Agent C 修改测试和 fixture。

如果它们都在同一个目录里写文件，就会出现几类风险：

- 后写入的 Agent 覆盖先写入的 Agent。
- 一个 Agent 跑测试时看到另一个 Agent 改了一半的文件。
- 用户无法判断每个 Agent 到底做了哪些改动。
- 取消其中一个 Agent 时，很难只撤销它自己的改动。
- 并行任务的结果无法独立 review。

真实工程解决这个问题的核心手段是：

```text
每个写代码的子 Agent 进入独立 git worktree。
```

worktree 是同一个 Git 仓库的独立工作目录。每个 worktree 可以有自己的分支、自己的文件状态、自己的测试运行环境。这样多个 Agent 可以并行改代码，但不会直接互相覆盖。

本章给 Mini 增加 Agent 级 worktree 隔离。

## 真实工程怎么做

真实工程里 worktree 能力分成两类：

- 会话级 worktree：用户显式进入一个 worktree，整个主会话切换目录。
- Agent 级 worktree：某个子 Agent 临时进入 worktree，主会话目录不变。

本章只做 Agent 级 worktree。

真实工程相关模块：

- `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx`：`Agent` 工具支持 `isolation: "worktree"`，启动前创建 worktree，运行时用 cwd override 包住子 Agent。
- `src/utils/worktree.ts`：创建、复用、清理 worktree，检测是否有改动，复制 `.worktreeinclude`，处理临时分支。
- `src/utils/cwd.ts`：用 `AsyncLocalStorage` 实现当前异步链的 cwd override，让不同 Agent 并发时看到不同 cwd。
- `packages/builtin-tools/src/tools/AgentTool/runAgent.ts`：把 worktree path 写入子 Agent metadata，恢复时可以找回 cwd。
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`：后台 Agent 完成通知里带上 `<worktree>` 信息。
- `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts`：fork 子 Agent 进入 worktree 时，会提醒它把父上下文路径翻译到新 worktree。
- `packages/builtin-tools/src/tools/EnterWorktreeTool/EnterWorktreeTool.ts`：会话级 worktree 创建，作为对照。
- `packages/builtin-tools/src/tools/ExitWorktreeTool/ExitWorktreeTool.ts`：会话级 worktree 保留或删除。
- `src/skills/bundled/batch.ts`：批量任务会要求所有 worker 使用 `isolation: "worktree"` 和 `run_in_background: true`。

真实工程里几个关键点：

- Agent worktree 不修改全局 `process.cwd()`。
- 每个 Agent 用异步上下文覆盖 cwd。
- worktree 没有改动时自动删除。
- worktree 有改动时保留，并把 `worktreePath`、`worktreeBranch` 回传给主 Agent。
- 删除 worktree 时要从主仓库根目录执行，而不是从即将删除的 worktree 目录执行。
- 如果检测改动失败，要保守处理，保留 worktree。

Mini 也采用这套设计。

## 本章目标

完成后，主 Agent 可以这样派发写代码 Agent：

```json
{
  "description": "实现登录校验",
  "subagent_type": "general-purpose",
  "prompt": "在独立 worktree 中实现登录 token 过期校验，并补充相关测试。完成后总结改动文件和验证结果。",
  "run_in_background": true,
  "isolation": "worktree"
}
```

Mini 会：

1. 创建 `.mini/worktrees/agent-<id>`。
2. 创建临时分支 `mini-agent-<id>`。
3. 在该 worktree 里运行子 Agent。
4. 主工作区保持不变。
5. Agent 完成后检测 worktree 是否有改动。
6. 无改动则删除 worktree。
7. 有改动则保留 worktree，把路径和分支告诉主 Agent。
8. 主 Agent 可以查看 diff，并决定是否合并。

本章新增能力：

- Agent 输入支持 `isolation: "worktree"`。
- Agent 定义支持默认 `isolation: "worktree"`。
- 创建 Agent worktree。
- cwd override。
- 文件工具和 Bash 工具使用逻辑 cwd。
- Agent task 记录 worktree 信息。
- 完成后自动清理无改动 worktree。
- 保留有改动 worktree。
- 生成 worktree diff。
- 把 worktree diff 应用回主工作区。

## 推荐目录

新增：

```text
src/worktrees/
  worktreeTypes.ts
  gitExec.ts
  worktreeSlug.ts
  agentWorktree.ts
  cwdOverride.ts
  worktreeMerge.ts

src/commands/
  worktreesCommand.ts
```

修改：

```text
src/agents/agentTypes.ts
src/agents/agentConfigTypes.ts
src/agents/markdownAgentLoader.ts
src/agents/runAgent.ts
src/tools/agentTool.ts
src/tools/fileReadTool.ts
src/tools/fileWriteTool.ts
src/tools/fileEditTool.ts
src/tools/bashTool.ts
src/tasks/taskTypes.ts
src/tasks/localAgentTask.ts
src/tasks/taskNotifications.ts
```

## 基础类型

先定义 worktree 数据结构。

```ts
// src/worktrees/worktreeTypes.ts
export type AgentWorktreeInfo = {
  worktreePath: string;
  worktreeBranch: string;
  headCommit: string;
  gitRoot: string;
};

export type AgentWorktreeCleanupResult =
  | {
      action: "removed";
    }
  | {
      action: "kept";
      worktreePath: string;
      worktreeBranch: string;
    };

export type WorktreeDiffSummary = {
  changedFiles: string[];
  stat: string;
  patch: string;
};
```

`headCommit` 是创建 worktree 时的基线。后面判断是否有改动、生成 patch，都要基于这个 commit。

## Git 执行封装

worktree 操作会频繁调用 Git。先写一个不抛错的执行函数。

```ts
// src/worktrees/gitExec.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function git(args: string[], cwd: string): Promise<GitExecResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
      },
      maxBuffer: 1024 * 1024 * 20,
    });

    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const err = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? String(error),
    };
  }
}

export async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
```

这里显式禁用 Git 交互式凭据提示。后台 Agent 不能卡在 credential prompt 上。

## 找到 Git 根目录

Agent worktree 必须基于 Git 仓库创建。

```ts
// src/worktrees/agentWorktree.ts
import { resolve } from "node:path";
import { gitOrThrow } from "./gitExec";

export async function findGitRoot(cwd: string): Promise<string | null> {
  const result = await gitOrThrow(["rev-parse", "--show-toplevel"], cwd).catch(() => null);
  if (!result) {
    return null;
  }
  return resolve(result.trim());
}

export async function getHeadCommit(cwd: string): Promise<string> {
  return (await gitOrThrow(["rev-parse", "HEAD"], cwd)).trim();
}
```

如果当前目录不是 Git 仓库，Mini 第一版直接报错：

```text
Agent worktree isolation requires a git repository.
```

真实工程还支持 hook-based worktree，用来适配非 Git 的版本控制系统。Mini 暂时不做。

## Slug 和路径

不能把任意字符串塞进分支名或路径。先限制 slug。

```ts
// src/worktrees/worktreeSlug.ts
const WORKTREE_SLUG_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

export function validateWorktreeSlug(slug: string): void {
  if (!WORKTREE_SLUG_REGEX.test(slug)) {
    throw new Error(
      "Worktree slug may only contain letters, numbers, dots, underscores and dashes",
    );
  }
}

export function createAgentWorktreeSlug(agentId: string): string {
  const compact = agentId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  return `agent-${compact}`;
}

export function createAgentWorktreeBranch(slug: string): string {
  validateWorktreeSlug(slug);
  return `mini-${slug}`;
}
```

不要允许 `/`。嵌套 worktree 很容易导致删除父 worktree 时把子 worktree 一起删掉。

## 创建 Agent Worktree

创建路径：

```text
<repo>/.mini/worktrees/<slug>
```

实现：

```ts
// src/worktrees/agentWorktree.ts
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentWorktreeInfo, AgentWorktreeCleanupResult } from "./worktreeTypes";
import { git, gitOrThrow } from "./gitExec";
import {
  createAgentWorktreeBranch,
  createAgentWorktreeSlug,
  validateWorktreeSlug,
} from "./worktreeSlug";

export function getAgentWorktreesDir(repoRoot: string): string {
  return join(repoRoot, ".mini", "worktrees");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function createAgentWorktree(input: {
  cwd: string;
  agentId: string;
}): Promise<AgentWorktreeInfo> {
  const gitRoot = await findGitRoot(input.cwd);
  if (!gitRoot) {
    throw new Error("Agent worktree isolation requires a git repository");
  }

  const slug = createAgentWorktreeSlug(input.agentId);
  validateWorktreeSlug(slug);

  const worktreePath = join(getAgentWorktreesDir(gitRoot), slug);
  const worktreeBranch = createAgentWorktreeBranch(slug);
  const headCommit = await getHeadCommit(gitRoot);

  await mkdir(getAgentWorktreesDir(gitRoot), { recursive: true });

  if (await pathExists(worktreePath)) {
    return {
      worktreePath,
      worktreeBranch,
      headCommit,
      gitRoot,
    };
  }

  await gitOrThrow(
    ["worktree", "add", "-B", worktreeBranch, worktreePath, "HEAD"],
    gitRoot,
  );

  return {
    worktreePath,
    worktreeBranch,
    headCommit,
    gitRoot,
  };
}
```

这里用 `-B` 是为了复用同名临时分支。Mini 当前用 agent id 生成 slug，冲突概率很低，但 `-B` 可以处理上次异常退出后残留的分支。

## 复制本地忽略文件

Git worktree 只会带 tracked files。很多项目还需要一些 gitignored 文件才能跑起来，比如本地配置、测试 fixture 或证书占位文件。

真实工程支持 `.worktreeinclude`。Mini 也做一个简化版：

```text
.worktreeinclude
```

内容：

```text
.env.example
config/local-fixture.json
```

实现：

```ts
// src/worktrees/agentWorktree.ts
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function copyWorktreeIncludeFiles(input: {
  repoRoot: string;
  worktreePath: string;
}): Promise<string[]> {
  let content = "";
  try {
    content = await readFile(join(input.repoRoot, ".worktreeinclude"), "utf8");
  } catch {
    return [];
  }

  const copied: string[] = [];
  const relativePaths = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"));

  for (const relativePath of relativePaths) {
    const source = join(input.repoRoot, relativePath);
    const target = join(input.worktreePath, relativePath);

    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      copied.push(relativePath);
    } catch {
      // Best effort. 不要因为一个本地文件缺失导致 worktree 创建失败。
    }
  }

  return copied;
}
```

然后在 `createAgentWorktree()` 里创建成功后调用：

```ts
await copyWorktreeIncludeFiles({
  repoRoot: gitRoot,
  worktreePath,
});
```

注意不要自动复制真实密钥。需要本地配置时，优先复制模板或无敏感信息的 fixture。

## cwd Override

Agent 级 worktree 和会话级 worktree最大的区别是：

```text
Agent 级 worktree 不能修改全局 cwd。
```

因为主 Agent、Agent A、Agent B 可能同时运行。如果用 `process.chdir()`，所有异步任务都会被影响。

用 `AsyncLocalStorage`：

```ts
// src/worktrees/cwdOverride.ts
import { AsyncLocalStorage } from "node:async_hooks";

const cwdOverrideStorage = new AsyncLocalStorage<string>();

let globalCwd = process.cwd();

export function setGlobalCwd(cwd: string): void {
  globalCwd = cwd;
}

export function getCwd(): string {
  return cwdOverrideStorage.getStore() ?? globalCwd;
}

export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn);
}
```

之后所有文件工具和 Bash 工具都必须用 `getCwd()`，不要直接用 `process.cwd()`。

例如 FileRead：

```ts
// src/tools/fileReadTool.ts
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { getCwd } from "../worktrees/cwdOverride";

export async function readProjectFile(path: string): Promise<string> {
  const absolutePath = resolve(getCwd(), path);
  return await readFile(absolutePath, "utf8");
}
```

Bash：

```ts
// src/tools/bashTool.ts
import { getCwd } from "../worktrees/cwdOverride";

export async function runBashCommand(command: string): Promise<string> {
  return await runShell(command, {
    cwd: getCwd(),
  });
}
```

这一步非常关键。只创建 worktree 不够，工具必须真的在 worktree cwd 下执行。

## 扩展 Agent 配置

第三十一章的 Agent frontmatter 还没有 `isolation` 字段。现在加上：

```ts
// src/agents/agentTypes.ts
export type AgentIsolation = "worktree";

export type AgentDefinition = {
  agentType: string;
  whenToUse: string;
  source: AgentSource;
  tools?: string[];
  disallowedTools?: string[];
  model?: AgentModel;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  background?: boolean;
  isolation?: AgentIsolation;
  filename?: string;
  baseDir?: string;
  getSystemPrompt: () => string;
};
```

解析：

```ts
// src/agents/agentConfigTypes.ts
import type { AgentIsolation } from "./agentTypes";

export function parseIsolation(value: unknown): AgentIsolation | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === "worktree") {
    return "worktree";
  }

  throw new Error(`Invalid isolation: ${String(value)}`);
}
```

接进 markdown loader：

```ts
// src/agents/markdownAgentLoader.ts
import { parseIsolation } from "./agentConfigTypes";

return {
  agentType,
  whenToUse,
  source: input.source,
  filename: basename(input.filePath, ".md"),
  baseDir: input.baseDir,
  tools: parseStringList(frontmatter.tools),
  disallowedTools: parseStringList(frontmatter.disallowedTools),
  model: parseModel(frontmatter.model),
  permissionMode: parsePermissionMode(frontmatter.permissionMode),
  maxTurns: parsePositiveInteger(frontmatter.maxTurns),
  background: parseBoolean(frontmatter.background),
  isolation: parseIsolation(frontmatter.isolation),
  getSystemPrompt: () => systemPrompt,
};
```

现在项目 Agent 可以默认要求 worktree：

```markdown
---
name: feature-worker
description: 在独立 worktree 中实现一个可提交的小功能
tools: [read_file, write_file, edit_file, grep, bash]
model: smart
permissionMode: acceptEdits
background: true
isolation: worktree
maxTurns: 20
---

你是功能实现 Agent。
你必须在当前 worktree 中完成修改。
不要切回主仓库目录。
完成后输出改动文件、测试结果和剩余风险。
```

## 扩展 Agent Tool 输入

`Agent` 工具也支持按次指定 isolation。

```ts
// src/agents/agentTypes.ts
export type AgentToolInput = {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: AgentModel;
  run_in_background?: boolean;
  isolation?: "worktree";
};
```

工具 schema：

```ts
// src/tools/agentTool.ts
inputSchema: {
  type: "object",
  required: ["description", "prompt"],
  properties: {
    description: { type: "string" },
    prompt: { type: "string" },
    subagent_type: { type: "string" },
    model: { type: "string", enum: ["default", "fast", "smart"] },
    run_in_background: { type: "boolean" },
    isolation: {
      type: "string",
      enum: ["worktree"],
      description: "Run the agent in an isolated git worktree",
    },
  },
}
```

生效规则：

```ts
const isolation = args.isolation ?? agent.isolation;
const shouldUseWorktree = isolation === "worktree";
```

参数优先级高于 Agent 定义。这样主 Agent 可以临时给普通 Agent 加 worktree 隔离。

## 运行 Agent 时进入 Worktree

改造 `AgentTool` 的同步和后台分支。

```ts
// src/tools/agentTool.ts
import { createAgentWorktree } from "../worktrees/agentWorktree";
import { runWithCwdOverride } from "../worktrees/cwdOverride";

async function maybeCreateAgentWorktree(input: {
  cwd: string;
  agentId: string;
  useWorktree: boolean;
}) {
  if (!input.useWorktree) {
    return undefined;
  }

  return await createAgentWorktree({
    cwd: input.cwd,
    agentId: input.agentId,
  });
}

function runMaybeInWorktree<T>(
  worktreePath: string | undefined,
  fn: () => T,
): T {
  if (!worktreePath) {
    return fn();
  }

  return runWithCwdOverride(worktreePath, fn);
}
```

同步分支：

```ts
const agentId = createAgentId();
const worktree = await maybeCreateAgentWorktree({
  cwd: context.cwd,
  agentId,
  useWorktree: shouldUseWorktree,
});

try {
  const result = await runMaybeInWorktree(worktree?.worktreePath, () => {
    return runAgent({
      agentId,
      parentSessionId: input.parentSessionId,
      agent,
      prompt: args.prompt,
      model: args.model ?? agent.model ?? "default",
      tools: resolvedTools,
      abortSignal: context.abortSignal,
      worktree,
    });
  });

  const worktreeResult = worktree
    ? await cleanupAgentWorktree(worktree)
    : { action: "removed" as const };

  return {
    ...result,
    ...(worktreeResult.action === "kept"
      ? {
          worktreePath: worktreeResult.worktreePath,
          worktreeBranch: worktreeResult.worktreeBranch,
        }
      : {}),
  };
} catch (error) {
  if (worktree) {
    await keepAgentWorktree(worktree);
  }
  throw error;
}
```

注意：同步 Agent 报错时不要删除 worktree。报错时 worktree 里可能有部分有价值的改动，应该保留给用户检查。

## 后台 Agent Worktree

后台分支需要把 worktree 信息写入 task。

扩展 task 类型：

```ts
// src/tasks/taskTypes.ts
export type LocalAgentTaskState = TaskStateBase & {
  type: "local_agent";
  agentId: string;
  agentType: string;
  prompt: string;
  abortController?: AbortController;
  worktree?: {
    worktreePath: string;
    worktreeBranch: string;
    headCommit: string;
    gitRoot: string;
  };
  result?: {
    content: string;
    totalToolUseCount: number;
    totalDurationMs: number;
    worktreePath?: string;
    worktreeBranch?: string;
  };
  error?: string;
};
```

注册 task：

```ts
// src/tasks/localAgentTask.ts
import type { AgentWorktreeInfo } from "../worktrees/worktreeTypes";

export async function registerLocalAgentTask(input: {
  description: string;
  prompt: string;
  agentType: string;
  toolUseId?: string;
  worktree?: AgentWorktreeInfo;
}): Promise<LocalAgentTaskState> {
  const agentId = input.worktree ? input.worktree.worktreePath.split("/").at(-1)! : createAgentId();
  const outputFile = await createTaskOutputFile(agentId);

  const task: LocalAgentTaskState = {
    id: agentId,
    type: "local_agent",
    status: "running",
    description: input.description,
    toolUseId: input.toolUseId,
    startTime: Date.now(),
    outputFile,
    outputOffset: 0,
    notified: false,
    agentId,
    agentType: input.agentType,
    prompt: input.prompt,
    abortController: new AbortController(),
    worktree: input.worktree,
  };

  registerTask(task);
  return task;
}
```

上面为了展示数据结构，把 agent id 简化处理了。实际代码里更推荐：

```text
先创建 agentId。
再用 agentId 创建 worktree。
最后用同一个 agentId 注册 task。
```

后台启动流程：

```ts
const agentId = createAgentId();
const worktree = await maybeCreateAgentWorktree({
  cwd: context.cwd,
  agentId,
  useWorktree: shouldUseWorktree,
});

const task = await registerLocalAgentTask({
  description: args.description,
  prompt: args.prompt,
  agentType: agent.agentType,
  toolUseId: context.toolUseId,
  worktree,
  agentId,
});

void runMaybeInWorktree(worktree?.worktreePath, () => {
  return runBackgroundAgent({
    taskId: task.id,
    agentId,
    parentSessionId: input.parentSessionId,
    agent,
    prompt: args.prompt,
    model: args.model ?? agent.model ?? "default",
    tools: resolvedTools,
    abortSignal: task.abortController!.signal,
    worktree,
  });
});
```

`runBackgroundAgent()` 结束时负责清理或保留 worktree。

## 检测 Worktree 是否有改动

判断规则：

- `git status --porcelain` 有输出，说明有未提交改动。
- `headCommit..HEAD` 有 commit，说明 Agent 提交过。
- Git 命令失败，保守认为有改动，保留 worktree。

```ts
// src/worktrees/agentWorktree.ts
export async function hasWorktreeChanges(info: AgentWorktreeInfo): Promise<boolean> {
  const status = await git(["status", "--porcelain"], info.worktreePath);
  if (status.code !== 0) {
    return true;
  }

  if (status.stdout.trim().length > 0) {
    return true;
  }

  const commits = await git(
    ["rev-list", "--count", `${info.headCommit}..HEAD`],
    info.worktreePath,
  );

  if (commits.code !== 0) {
    return true;
  }

  return Number.parseInt(commits.stdout.trim(), 10) > 0;
}
```

这是 fail closed 设计。删除工作树之前必须能证明它没有价值。证明不了就保留。

## 删除 Worktree

```ts
// src/worktrees/agentWorktree.ts
export async function removeAgentWorktree(info: AgentWorktreeInfo): Promise<void> {
  await gitOrThrow(
    ["worktree", "remove", "--force", info.worktreePath],
    info.gitRoot,
  );

  await git(["branch", "-D", info.worktreeBranch], info.gitRoot);
}

export async function keepAgentWorktree(
  info: AgentWorktreeInfo,
): Promise<AgentWorktreeCleanupResult> {
  return {
    action: "kept",
    worktreePath: info.worktreePath,
    worktreeBranch: info.worktreeBranch,
  };
}

export async function cleanupAgentWorktree(
  info: AgentWorktreeInfo,
): Promise<AgentWorktreeCleanupResult> {
  if (await hasWorktreeChanges(info)) {
    return await keepAgentWorktree(info);
  }

  await removeAgentWorktree(info);
  return { action: "removed" };
}
```

删除时必须在 `gitRoot` 执行。不要在 worktree 目录里执行删除自己的操作。

## 后台生命周期接入清理

改造第三十章的 `runBackgroundAgent()`。

```ts
// src/agents/runAgent.ts
import type { AgentWorktreeInfo } from "../worktrees/worktreeTypes";
import { cleanupAgentWorktree, keepAgentWorktree } from "../worktrees/agentWorktree";

export async function runBackgroundAgent(input: RunAgentInput & {
  taskId: string;
  worktree?: AgentWorktreeInfo;
}): Promise<void> {
  try {
    const output = await runAgent(input);
    const worktreeResult = input.worktree
      ? await cleanupAgentWorktree(input.worktree)
      : { action: "removed" as const };

    completeAgentTask(input.taskId, {
      ...output,
      ...(worktreeResult.action === "kept"
        ? {
            worktreePath: worktreeResult.worktreePath,
            worktreeBranch: worktreeResult.worktreeBranch,
          }
        : {}),
    });
  } catch (error) {
    if (input.worktree) {
      await keepAgentWorktree(input.worktree);
    }

    const message = error instanceof Error ? error.message : String(error);
    failAgentTask(input.taskId, message);
  } finally {
    killShellTasksForAgent(input.agentId);
  }
}
```

这里保留两个原则：

- 成功但无改动：删除 worktree。
- 失败或有改动：保留 worktree。

失败时保留 worktree 是为了让用户检查半成品和失败现场。

## 完成通知带 Worktree

后台 Agent 完成后，主 Agent 必须知道 worktree 在哪里。

```ts
// src/tasks/taskNotifications.ts
export function buildAgentTaskNotification(task: LocalAgentTaskState): string {
  const result = task.result?.content
    ? `\n<result>${task.result.content}</result>`
    : "";

  const worktree = task.result?.worktreePath
    ? `\n<worktree><worktreePath>${task.result.worktreePath}</worktreePath><worktreeBranch>${task.result.worktreeBranch ?? ""}</worktreeBranch></worktree>`
    : "";

  return `<task_notification>
<task_id>${task.id}</task_id>
<output_file>${task.outputFile}</output_file>
<status>${task.status}</status>
<summary>Agent "${task.description}" ${task.status}</summary>${result}${worktree}
</task_notification>`;
}
```

主 Agent 收到通知后，不应该直接声称“已合并”。它只能说：

```text
Agent 已完成，改动保留在 worktree: <path>
```

是否合并要单独执行。

## 查看 Worktree Diff

用户需要知道某个 Agent 改了什么。

```ts
// src/worktrees/worktreeMerge.ts
import type { AgentWorktreeInfo, WorktreeDiffSummary } from "./worktreeTypes";
import { gitOrThrow } from "./gitExec";

export async function getWorktreeDiff(
  info: AgentWorktreeInfo,
): Promise<WorktreeDiffSummary> {
  const [stat, changedFiles, patch] = await Promise.all([
    gitOrThrow(["diff", "--stat", info.headCommit], info.worktreePath),
    gitOrThrow(["diff", "--name-only", info.headCommit], info.worktreePath),
    gitOrThrow(["diff", "--binary", info.headCommit], info.worktreePath),
  ]);

  return {
    stat,
    changedFiles: changedFiles.split("\n").map(line => line.trim()).filter(Boolean),
    patch,
  };
}
```

注意这里使用 `headCommit` 作为基线。这样无论 Agent 是直接改工作区，还是自己提交了 commit，最终 diff 都能表达出来。

## 合并 Worktree Diff

Mini 第一版不要自动合并所有 Agent 结果。先做显式命令：

```text
/worktrees merge <taskId>
```

合并策略：

1. 主工作区必须干净。
2. 从 worktree 生成 patch。
3. 在主工作区执行 `git apply --3way`。
4. 成功后保留 worktree，等用户确认后再清理。
5. 冲突时不删除 worktree。

实现：

```ts
// src/worktrees/worktreeMerge.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOrThrow } from "./gitExec";
import type { AgentWorktreeInfo } from "./worktreeTypes";

async function assertCleanWorkingTree(cwd: string): Promise<void> {
  const status = await gitOrThrow(["status", "--porcelain"], cwd);
  if (status.trim().length > 0) {
    throw new Error("Main working tree is not clean. Commit or stash changes before merging a worktree.");
  }
}

export async function applyWorktreeDiff(input: {
  info: AgentWorktreeInfo;
  targetCwd: string;
}): Promise<{
  changedFiles: string[];
}> {
  await assertCleanWorkingTree(input.targetCwd);

  const diff = await getWorktreeDiff(input.info);
  if (diff.patch.trim().length === 0) {
    return { changedFiles: [] };
  }

  const patchDir = join(input.targetCwd, ".mini", "tmp", "patches");
  await mkdir(patchDir, { recursive: true });

  const patchPath = join(patchDir, `${input.info.worktreeBranch}.patch`);
  await writeFile(patchPath, diff.patch);

  const apply = await git(["apply", "--3way", patchPath], input.targetCwd);
  if (apply.code !== 0) {
    throw new Error(`Failed to apply worktree patch: ${apply.stderr.trim()}`);
  }

  return {
    changedFiles: diff.changedFiles,
  };
}
```

为什么要求主工作区干净？

因为 Mini 第一版没有复杂的冲突归因能力。主工作区不干净时，合并失败很难判断是 Agent patch 冲突，还是用户已有改动冲突。

先强约束，后续再做更智能的合并体验。

## Worktree 命令

增加一个命令查看和合并 worktree。

```ts
// src/commands/worktreesCommand.ts
import { getTask } from "../tasks/taskStore";
import type { LocalAgentTaskState } from "../tasks/taskTypes";
import { getWorktreeDiff, applyWorktreeDiff } from "../worktrees/worktreeMerge";
import type { AgentWorktreeInfo } from "../worktrees/worktreeTypes";

function getAgentWorktreeInfo(taskId: string): AgentWorktreeInfo {
  const task = getTask(taskId);

  if (!task || task.type !== "local_agent") {
    throw new Error(`Agent task not found: ${taskId}`);
  }

  const agentTask = task as LocalAgentTaskState;
  const worktree = agentTask.worktree;
  if (!worktree) {
    throw new Error(`Agent task has no worktree: ${taskId}`);
  }

  return worktree;
}

export async function renderWorktreeDiff(taskId: string): Promise<string> {
  const info = getAgentWorktreeInfo(taskId);
  const diff = await getWorktreeDiff(info);

  return [
    `worktree: ${info.worktreePath}`,
    `branch: ${info.worktreeBranch}`,
    "",
    diff.stat || "(no changes)",
  ].join("\n");
}

export async function mergeWorktreeTask(input: {
  taskId: string;
  targetCwd: string;
}): Promise<string> {
  const info = getAgentWorktreeInfo(input.taskId);
  const result = await applyWorktreeDiff({
    info,
    targetCwd: input.targetCwd,
  });

  if (result.changedFiles.length === 0) {
    return "No changes to merge.";
  }

  return [
    "Applied worktree patch.",
    "",
    ...result.changedFiles.map(file => `- ${file}`),
  ].join("\n");
}
```

接到 CLI：

```ts
// src/cli.ts
if (process.argv[2] === "worktrees" && process.argv[3] === "diff") {
  const taskId = process.argv[4];
  if (!taskId) {
    throw new Error("Missing task id");
  }
  console.log(await renderWorktreeDiff(taskId));
  return;
}

if (process.argv[2] === "worktrees" && process.argv[3] === "merge") {
  const taskId = process.argv[4];
  if (!taskId) {
    throw new Error("Missing task id");
  }
  console.log(await mergeWorktreeTask({
    taskId,
    targetCwd: process.cwd(),
  }));
  return;
}
```

使用：

```bash
bun run src/cli.ts worktrees diff a_8f13c9
bun run src/cli.ts worktrees merge a_8f13c9
```

## 并行写代码策略

现在主 Agent 可以真正并行派发写代码任务，但它必须会拆任务。

适合并行：

```text
按目录拆：
- packages/api
- packages/web
- packages/cli

按模块拆：
- auth
- billing
- settings

按机械迁移拆：
- 一批文件改 import
- 一批文件改类型
- 一批文件改测试
```

不适合并行：

```text
Agent A 设计接口，Agent B 同时按接口实现。
Agent A 改基础类型，Agent B 同时改依赖这些类型的代码。
多个 Agent 修改同一个核心文件。
```

主 Agent 的拆分原则：

- 每个子 Agent 的文件范围尽量不重叠。
- 每个子 Agent 的 prompt 包含完整上下文。
- 每个子 Agent 都运行自己的验证。
- 先收集每个 worktree 的 diff，再决定合并顺序。
- 基础类型、公共工具、配置文件优先由主 Agent 或单个 Agent 处理。

## Worktree Agent Prompt

项目里可以新增一个专门写代码的 Agent。

```markdown
---
name: worktree-worker
description: 在独立 worktree 中实现可独立合并的小型代码改动
tools:
  - read_file
  - write_file
  - edit_file
  - glob
  - grep
  - bash
model: smart
permissionMode: acceptEdits
background: true
isolation: worktree
maxTurns: 24
---

你是独立 worktree worker。

规则：

1. 只处理 prompt 中分配给你的文件或模块。
2. 不要修改和任务无关的共享配置。
3. 修改前先阅读相关代码。
4. 修改后运行最小相关验证。
5. 如果发现需要改公共基础模块，先停止并说明原因，不要扩大范围。
6. 最终输出：
   - 改动摘要。
   - 改动文件列表。
   - 验证命令和结果。
   - 是否有无法处理的风险。
```

主 Agent 派发时：

```json
{
  "description": "迁移 auth 模块",
  "subagent_type": "worktree-worker",
  "prompt": "只迁移 src/auth 下的旧 API 调用到新 client。不要修改 src/api/client.ts。完成后运行 auth 相关测试并报告结果。",
  "run_in_background": true
}
```

因为 Agent 定义里已经有 `isolation: worktree`，调用时可以不用重复传。

## 与后台任务的关系

worktree 隔离和后台任务是两层能力：

```text
run_in_background: true
  表示主 Agent 不等待子 Agent 完成。

isolation: "worktree"
  表示子 Agent 在独立工作区读写文件。
```

它们可以组合：

```text
同步 + worktree：
主 Agent 等结果，但改动隔离。

后台 + worktree：
主 Agent 继续工作，子 Agent 在独立目录里并行修改。
```

写代码 Agent 通常推荐：

```json
{
  "run_in_background": true,
  "isolation": "worktree"
}
```

但如果主 Agent 必须立刻基于子 Agent 结果决策，可以同步运行 worktree Agent。

## 清理策略

Mini 要避免 `.mini/worktrees` 无限增长。

本章先做“任务结束时清理无改动 worktree”。后续可以加定期清理。

清理规则：

- 无改动：删除 worktree 和临时分支。
- 有改动：保留 worktree。
- Agent 失败：保留 worktree。
- Git 状态无法判断：保留 worktree。
- 合并成功：仍先保留 worktree，等用户确认后再删除。

可以加一个显式清理命令：

```bash
bun run src/cli.ts worktrees remove a_8f13c9
```

删除前必须再次检查：

- patch 已合并，或用户确认丢弃。
- 当前 worktree 没有未保存价值。

不要在本章默认自动删除已产生改动的 worktree。

## 测试 cwd override

```ts
// src/worktrees/__tests__/cwdOverride.test.ts
import { describe, expect, test } from "bun:test";
import { getCwd, runWithCwdOverride, setGlobalCwd } from "../cwdOverride";

describe("cwdOverride", () => {
  test("returns global cwd by default", () => {
    setGlobalCwd("/repo");
    expect(getCwd()).toBe("/repo");
  });

  test("isolates cwd per async context", async () => {
    setGlobalCwd("/repo");

    const [a, b] = await Promise.all([
      runWithCwdOverride("/repo/.mini/worktrees/a", async () => {
        await Promise.resolve();
        return getCwd();
      }),
      runWithCwdOverride("/repo/.mini/worktrees/b", async () => {
        await Promise.resolve();
        return getCwd();
      }),
    ]);

    expect(a).toBe("/repo/.mini/worktrees/a");
    expect(b).toBe("/repo/.mini/worktrees/b");
    expect(getCwd()).toBe("/repo");
  });
});
```

## 测试 slug

```ts
// src/worktrees/__tests__/worktreeSlug.test.ts
import { describe, expect, test } from "bun:test";
import {
  createAgentWorktreeBranch,
  createAgentWorktreeSlug,
  validateWorktreeSlug,
} from "../worktreeSlug";

describe("worktree slug", () => {
  test("creates stable agent slug", () => {
    expect(createAgentWorktreeSlug("a_1234567890")).toBe("agent-a123456789");
  });

  test("rejects nested paths", () => {
    expect(() => validateWorktreeSlug("agent/foo")).toThrow();
  });

  test("creates branch name", () => {
    expect(createAgentWorktreeBranch("agent-a123")).toBe("mini-agent-a123");
  });
});
```

## 集成测试

worktree 功能需要 Git。测试时创建临时仓库。

```ts
// src/worktrees/__tests__/agentWorktree.test.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { gitOrThrow } from "../gitExec";
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from "../agentWorktree";

async function createRepo(): Promise<string> {
  const dir = join(tmpdir(), `mini-wt-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await gitOrThrow(["init"], dir);
  await gitOrThrow(["config", "user.email", "mini@example.com"], dir);
  await gitOrThrow(["config", "user.name", "Mini"], dir);
  await writeFile(join(dir, "README.md"), "hello\n");
  await gitOrThrow(["add", "README.md"], dir);
  await gitOrThrow(["commit", "-m", "init"], dir);
  return dir;
}

describe("agent worktree", () => {
  test("creates and removes worktree", async () => {
    const repo = await createRepo();
    const info = await createAgentWorktree({
      cwd: repo,
      agentId: "a_1234567890",
    });

    expect(info.worktreePath).toContain(".mini/worktrees");
    expect(await hasWorktreeChanges(info)).toBe(false);

    await removeAgentWorktree(info);
  });

  test("detects changed files", async () => {
    const repo = await createRepo();
    const info = await createAgentWorktree({
      cwd: repo,
      agentId: "a_abcdef1234",
    });

    await writeFile(join(info.worktreePath, "README.md"), "changed\n");
    expect(await hasWorktreeChanges(info)).toBe(true);

    await removeAgentWorktree(info);
  });
});
```

运行：

```bash
bun test src/worktrees/__tests__/cwdOverride.test.ts
bun test src/worktrees/__tests__/worktreeSlug.test.ts
bun test src/worktrees/__tests__/agentWorktree.test.ts
bun run typecheck
```

## 验收清单

本章完成后，手动检查：

- `Agent` 工具 schema 支持 `isolation: "worktree"`。
- Agent frontmatter 支持 `isolation: worktree`。
- 启动 worktree Agent 会创建 `.mini/worktrees/agent-...`。
- 子 Agent 的文件读写发生在 worktree 里。
- 主工作区文件不会被子 Agent 直接改动。
- 后台 worktree Agent 完成后通知包含 worktree path。
- 无改动 worktree 会自动删除。
- 有改动 worktree 会保留。
- Agent 失败时 worktree 会保留。
- `worktrees diff <taskId>` 能看到改动统计。
- `worktrees merge <taskId>` 能把 patch 应用到主工作区。
- 主工作区不干净时拒绝合并。
- `bun run typecheck` 通过。

## 常见坑

### 1. 用 `process.chdir()` 切 Agent cwd

这是最危险的实现。多个 Agent 并发时，全局 cwd 会互相覆盖。Agent 级 worktree 必须使用异步上下文隔离。

### 2. 文件工具没有使用 `getCwd()`

只包住 Agent loop 不够。所有读写文件和命令执行工具都必须从 `getCwd()` 取 cwd。

### 3. 无法判断状态时删除 worktree

删除前必须能证明没有改动。Git 状态失败、基线丢失、路径异常，都应该保留 worktree。

### 4. 自动合并所有结果

并行 Agent 的结果应该先 review。Mini 第一版只做显式 merge，不做自动 merge。

### 5. 多个 Agent 修改共享基础文件

worktree 可以防止互相覆盖，但不能保证最终可合并。任务拆分仍然要尽量避免共享文件。

### 6. 忘记复制必要的本地文件

worktree 没有 gitignored 文件。如果测试依赖本地 fixture，可以用 `.worktreeinclude` 明确复制无敏感信息的文件。

### 7. 合并后立即删除 worktree

合并成功不代表用户已经 review 完。先保留，等用户确认后再清理。

## 本章小结

第三十二章给 Mini 的多 Agent 系统补上了真正的并行写代码能力。

现在系统具备了：

- Agent 级 `isolation: "worktree"`。
- 临时 worktree 和临时分支创建。
- 基于 `AsyncLocalStorage` 的 cwd 隔离。
- 文件工具和 Bash 工具在逻辑 cwd 下执行。
- worktree 无改动自动清理。
- worktree 有改动保留并回传路径。
- worktree diff 查看。
- 显式 patch 合并。
- 后台 Agent 与 worktree 隔离组合。

到这里，Mini 已经可以让多个写代码 Agent 并行工作，而不会直接污染主工作区。

下一章可以继续做 **批处理编排与并行任务拆分**：让主 Agent 先规划大任务，再自动拆成多个独立 worktree worker 并行执行。
