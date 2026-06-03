# 第 34 章：验证 Agent 与交付门禁

第三十三章已经把 Mini 做到了一个很关键的位置：

```text
主 Agent 可以把大型任务拆成多个 worktree worker，并行执行。
```

但这里还缺最后一道闸门。

worker 说“完成了”，不等于真的完成。主 Agent 自己读一遍 diff，也不等于验证过。

原因很简单：

```text
实现者天然会相信自己的实现。
```

尤其是 Coding Agent，最容易出现三类问题：

- 只检查代码结构，没有真正运行。
- 只跑 happy path，没有试边界和错误路径。
- 看到测试通过，就忽略真实功能可能没连上。

所以真实系统里需要一个独立角色：

```text
验证 Agent。
```

它不是继续写代码的人，而是专门找问题的人。

本章给 Mini 加上验证门禁：

```text
实现完成后，必须把原始需求、改动文件、diff、测试结果交给一个只读 verifier。
verifier 独立运行命令，输出 PASS / FAIL / PARTIAL。
主 Agent 只能基于 verifier 的 verdict 决定是否交付。
```

这会让 Mini 从“能自动写代码”进一步变成“能更可靠地交付代码”。

## 真实工程怎么做

当前源码里验证能力分布在几层：

- `packages/builtin-tools/src/tools/AgentTool/built-in/verificationAgent.ts`：内置 verification Agent。它的系统提示非常强，核心要求是“不要确认实现看起来正确，而是尝试打破它”。
- `packages/builtin-tools/src/tools/AgentTool/builtInAgents.ts`：在 `VERIFICATION_AGENT` feature 开启时注册内置验证 Agent。
- `packages/builtin-tools/src/tools/AgentTool/constants.ts`：定义 `verification` 这个 agent type。
- `src/constants/prompts.ts`：给主线程注入会话级验证契约。非平凡实现完成后，必须调用 verification Agent；主线程不能自己给 PARTIAL。
- `packages/builtin-tools/src/tools/TodoWriteTool/TodoWriteTool.ts`：当主线程关闭 3 个以上 todo 且没有验证步骤时，工具结果会追加验证提醒。
- `packages/builtin-tools/src/tools/TaskUpdateTool/TaskUpdateTool.ts`：任务系统也有类似提醒，防止完成所有任务后直接总结。
- `packages/builtin-tools/src/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.ts`：计划模式结束后有一个轻量的 plan 执行确认工具。
- `src/commands/init-verifiers.ts`：生成项目级 verifier skill，比如 UI verifier、CLI verifier、API verifier。
- `src/coordinator/coordinatorMode.ts`：多 worker 场景下明确要求验证要用新 worker，不要复用实现 worker 的上下文。
- `src/services/api/claude.ts`：把 `verification_agent` 当成 agentic query source 处理。

真实 verification Agent 的几个重点值得直接照搬：

```text
1. 验证 Agent 只读，不能改项目文件。
2. 它必须运行命令，不能只读代码。
3. 每个检查都要有 Command run 和 Output observed。
4. PASS 前必须至少有一个对抗性 probe。
5. 结尾必须是精确的 VERDICT: PASS / FAIL / PARTIAL。
```

注意，`PARTIAL` 不是“我不确定”。

`PARTIAL` 只用于环境限制，比如缺少服务、工具不可用、无法启动依赖。只要检查能运行，就必须给 `PASS` 或 `FAIL`。

## 本章目标

完成后，Mini 支持：

```bash
bun run src/cli.ts verify --task agent-a1
```

也支持批处理门禁：

```bash
bun run src/cli.ts batch status <runId>
bun run src/cli.ts batch verify <runId>
```

Mini 会做到：

1. 收集待验证目标的原始需求、改动文件、diff、测试记录和 worktree 信息。
2. 启动一个只读 verification Agent。
3. 要求 verification Agent 独立运行命令。
4. 解析 `VERDICT: PASS | FAIL | PARTIAL`。
5. 把验证记录持久化到 `.mini/verification-runs/`。
6. 普通任务完成前，如果属于非平凡改动，要求先有验证 verdict。
7. batch unit 合并前必须先通过验证。

本章不是做一个复杂 CI 系统。

我们先做一个足够实用的本地交付门禁：

```text
实现者负责写。
验证者负责证明。
主线程负责决策。
```

## 推荐目录

新增：

```text
src/verification/
  verificationTypes.ts
  verificationAgent.ts
  verificationPrompt.ts
  verificationEvidence.ts
  verificationVerdict.ts
  verificationRunStore.ts
  verifyTool.ts
  deliveryGate.ts

src/commands/
  verifyCommand.ts
```

修改：

```text
src/agents/builtInAgents.ts
src/tools/toolRegistry.ts
src/cli.ts
src/batch/batchTypes.ts
src/batch/batchStatus.ts
src/batch/batchRunStore.ts
```

如果你前面章节的文件名略有不同，按你自己的 Mini 项目结构放就行。

关键不是文件名，而是边界：

```text
verificationEvidence 负责收集证据。
verificationPrompt 负责组织 verifier 输入。
verificationAgent 负责定义只读 Agent。
verifyTool 负责串联一次验证。
deliveryGate 负责判断是否允许交付或合并。
```

## 验证类型

先定义验证记录。

```ts
// src/verification/verificationTypes.ts
export type VerificationVerdict = "pass" | "fail" | "partial";

export type VerificationTargetType = "working_tree" | "agent_task" | "batch_unit";

export type VerificationTarget = {
  type: VerificationTargetType;
  id: string;
  cwd: string;
  worktreePath?: string;
  originalRequest: string;
  implementationSummary: string;
  changedFiles: string[];
  recommendedCommands: string[];
};

export type VerificationEvidence = {
  target: VerificationTarget;
  gitStatus: string;
  diffStat: string;
  diffPatch: string;
  testOutput?: string;
  taskOutput?: string;
  collectedAt: number;
};

export type VerificationRunStatus = "running" | "completed" | "failed";

export type VerificationRun = {
  id: string;
  target: VerificationTarget;
  status: VerificationRunStatus;
  createdAt: number;
  updatedAt: number;
  verdict?: VerificationVerdict;
  report?: string;
  error?: string;
};
```

这里把 `target` 和 `evidence` 分开。

`target` 是“要验证什么”。

`evidence` 是“启动 verifier 前，主线程已经能收集到什么”。

验证 Agent 不能只依赖这些证据，它还必须自己运行命令。

但这些证据可以帮助它快速定位：

- 改了哪些文件。
- 需求是什么。
- 实现者声称做了什么。
- 推荐从哪些命令开始验证。
- worktree 在哪里。

## 内置验证 Agent

第 31 章已经做过 Agent 配置。现在新增一个内置 Agent。

```ts
// src/verification/verificationAgent.ts
import type { AgentDefinition } from "../agents/agentTypes";

export const VERIFICATION_AGENT_TYPE = "verification";

export function createVerificationAgent(): AgentDefinition {
  return {
    agentType: VERIFICATION_AGENT_TYPE,
    source: "built-in",
    whenToUse:
      "Use this agent to verify implementation work before reporting completion.",
    model: "inherit",
    permissionMode: "readOnly",
    background: false,
    disallowedTools: [
      "file_edit",
      "file_write",
      "notebook_edit",
      "agent",
      "exit_plan_mode",
    ],
    getSystemPrompt: () => VERIFICATION_SYSTEM_PROMPT,
  };
}

const VERIFICATION_SYSTEM_PROMPT = `
You are a verification specialist.

Your job is not to confirm that the implementation looks correct.
Your job is to try to break it.

You are strictly prohibited from modifying project files.
You may run read-only commands.
You may write temporary scripts only under /tmp when a command needs a small harness.

You will receive:
- Original user request
- Changed files
- Implementation summary
- Diff or diff location
- Recommended commands

Verification rules:
1. Read project instructions first when available.
2. Run build, tests, typecheck, or focused checks when configured.
3. Do not treat passing tests as enough by itself.
4. Exercise the changed behavior directly.
5. Run at least one adversarial probe before PASS.
6. Every check must include command and observed output.
7. Do not write code or edit files.

Output format:

### Check: <what you verified>
**Command run:**
  <exact command>
**Output observed:**
  <actual output>
**Result: PASS**

End with exactly one of:

VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL

Use FAIL when a runnable check proves incorrect behavior.
Use PARTIAL only when environment or missing tools prevent a required check.
`.trim();
```

这里的重点不是提示词写得长，而是边界强：

```text
只读。
必须运行。
必须给证据。
必须给 verdict。
```

如果允许 verifier 修改文件，它就会变成第二个实现者。那验证就失去意义了。

## 注册内置 Agent

在内置 Agent 列表中加入 verification。

```ts
// src/agents/builtInAgents.ts
import type { AgentDefinition } from "./agentTypes";
import { createVerificationAgent } from "../verification/verificationAgent";

export function getBuiltInAgents(): AgentDefinition[] {
  return [
    createGeneralAgent(),
    createWorktreeWorkerAgent(),
    createVerificationAgent(),
  ];
}
```

真实工程里 verification Agent 是 feature-gated 的。

Mini 先不加 feature flag，直接启用。等系统越来越复杂后，再考虑做 `MINI_VERIFICATION_AGENT=0` 这种开关。

## 收集验证证据

接下来做证据收集。

验证前，主线程应该把最基础的信息准备好：

- `git status --short`
- `git diff --stat`
- `git diff`
- changed files
- task 输出文件
- 推荐验证命令

```ts
// src/verification/verificationEvidence.ts
import { $ } from "bun";
import { readFile } from "node:fs/promises";
import type { VerificationEvidence, VerificationTarget } from "./verificationTypes";

const MAX_DIFF_CHARS = 40_000;
const MAX_TASK_OUTPUT_CHARS = 20_000;

export async function collectVerificationEvidence(
  target: VerificationTarget,
): Promise<VerificationEvidence> {
  const cwd = target.worktreePath ?? target.cwd;

  const gitStatus = await runGit(cwd, ["status", "--short"]);
  const diffStat = await runGit(cwd, ["diff", "--stat"]);
  const diffPatchRaw = await runGit(cwd, ["diff", "--"]);

  const taskOutput = target.type === "agent_task"
    ? await readOptionalTaskOutput(target.id)
    : undefined;

  return {
    target,
    gitStatus,
    diffStat,
    diffPatch: truncate(diffPatchRaw, MAX_DIFF_CHARS),
    taskOutput,
    collectedAt: Date.now(),
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await $`git -C ${cwd} ${args}`.quiet().nothrow();

  const stdout = await result.text();
  const stderr = result.stderr ? await new Response(result.stderr).text() : "";

  if (result.exitCode !== 0) {
    return [
      `$ git -C ${cwd} ${args.join(" ")}`,
      `exitCode: ${result.exitCode}`,
      stdout,
      stderr,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return stdout.trim();
}

async function readOptionalTaskOutput(taskId: string): Promise<string | undefined> {
  const filePath = `.mini/tasks/${taskId}.md`;

  try {
    const raw = await readFile(filePath, "utf8");
    return truncate(raw, MAX_TASK_OUTPUT_CHARS);
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}
```

如果你之前任务输出不是放在 `.mini/tasks/`，这里改成你自己的路径。

重点是不要把超大 diff 全塞进 prompt。

Mini 先用简单截断。真实系统还可以做：

- diff 分块。
- 只传 changed files + patch 文件路径。
- 让 verifier 按需读取文件。
- 对大文件只传关键 hunks。

## 生成验证 Prompt

现在把 evidence 变成 verifier 能执行的任务。

```ts
// src/verification/verificationPrompt.ts
import type { VerificationEvidence } from "./verificationTypes";

export function buildVerificationPrompt(evidence: VerificationEvidence): string {
  const { target } = evidence;
  const cwd = target.worktreePath ?? target.cwd;

  return `
Verify the implementation below.

You are verifying from cwd:

${cwd}

Original user request:

${target.originalRequest}

Implementation summary:

${target.implementationSummary}

Changed files:

${target.changedFiles.length === 0 ? "(none detected)" : target.changedFiles.map(file => `- ${file}`).join("\n")}

Recommended commands:

${formatCommands(target.recommendedCommands)}

Git status:

\`\`\`text
${evidence.gitStatus || "(clean)"}
\`\`\`

Diff stat:

\`\`\`text
${evidence.diffStat || "(no diff stat)"}
\`\`\`

Diff excerpt:

\`\`\`diff
${evidence.diffPatch || "(no diff)"}
\`\`\`

Task output:

\`\`\`text
${evidence.taskOutput ?? "(not available)"}
\`\`\`

Instructions:

1. Do not modify project files.
2. Read project instructions if they exist.
3. Run the recommended commands when relevant.
4. Exercise the changed behavior directly.
5. Run at least one adversarial probe before PASS.
6. Include command and observed output for every check.
7. End with exactly one VERDICT line.
`.trim();
}

function formatCommands(commands: string[]): string {
  if (commands.length === 0) {
    return "- Decide the smallest useful verification commands from the project.";
  }

  return commands.map(command => `- ${command}`).join("\n");
}
```

这里有一个刻意设计：

```text
recommendedCommands 只是建议，不是 verifier 的全部工作。
```

验证 Agent 可以从 `bun run typecheck` 开始，但不能只停在那里。

如果改的是 CLI 参数，它应该实际运行 CLI。

如果改的是 API，它应该启动服务并请求接口。

如果改的是 UI，它应该打开页面、点击、看控制台和资源请求。

## 解析 Verdict

verifier 的最后一行必须可解析。

写一个非常小的解析器。

```ts
// src/verification/verificationVerdict.ts
import type { VerificationVerdict } from "./verificationTypes";

export function parseVerificationVerdict(report: string): VerificationVerdict {
  const match = report.match(/(?:^|\n)VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/m);

  if (!match) {
    throw new Error(
      "Verification report must end with VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL",
    );
  }

  const raw = match[1];

  if (raw === "PASS") {
    return "pass";
  }

  if (raw === "FAIL") {
    return "fail";
  }

  return "partial";
}

export function hasCommandEvidence(report: string): boolean {
  return report.includes("**Command run:**") && report.includes("**Output observed:**");
}
```

这里先做最小规则：

- 没有 verdict，直接失败。
- 没有命令证据，不允许 PASS。

可以再加一个门禁函数。

```ts
// src/verification/verificationVerdict.ts
export function assertValidVerificationReport(report: string): void {
  const verdict = parseVerificationVerdict(report);

  if (verdict === "pass" && !hasCommandEvidence(report)) {
    throw new Error("PASS verification requires command evidence");
  }
}
```

真实系统会更严格：

- 检查每个 `### Check` 都有 command。
- 检查 PASS 前是否包含 adversarial probe。
- 主线程复跑 verifier 报告中的 2 到 3 个命令。
- 对 `PARTIAL` 要求说明环境限制。

Mini 先把主链路跑通。

## 验证记录持久化

验证结果要能追踪。

```ts
// src/verification/verificationRunStore.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VerificationRun } from "./verificationTypes";

const VERIFICATION_DIR = ".mini/verification-runs";

export async function saveVerificationRun(
  cwd: string,
  run: VerificationRun,
): Promise<void> {
  const dir = join(cwd, VERIFICATION_DIR);
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, `${run.id}.json`),
    `${JSON.stringify(run, null, 2)}\n`,
    "utf8",
  );
}

export async function loadVerificationRun(
  cwd: string,
  runId: string,
): Promise<VerificationRun> {
  const filePath = join(cwd, VERIFICATION_DIR, `${runId}.json`);
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as VerificationRun;
}
```

这不是为了做漂亮报表，而是为了两个实际需求：

```text
1. 主 Agent 可以引用某次验证结果。
2. 用户可以回头看 verifier 到底跑了什么。
```

## Verify 工具

现在把证据收集、prompt、Agent 启动、verdict 解析串起来。

```ts
// src/verification/verifyTool.ts
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../tools/toolTypes";
import type { AgentToolInput, AgentToolOutput } from "../agents/agentTypes";
import { VERIFICATION_AGENT_TYPE } from "./verificationAgent";
import { collectVerificationEvidence } from "./verificationEvidence";
import { buildVerificationPrompt } from "./verificationPrompt";
import {
  assertValidVerificationReport,
  parseVerificationVerdict,
} from "./verificationVerdict";
import { saveVerificationRun } from "./verificationRunStore";
import type {
  VerificationRun,
  VerificationTarget,
} from "./verificationTypes";

export type VerifyInput = {
  target: VerificationTarget;
};

export type VerifyOutput = {
  runId: string;
  verdict: "pass" | "fail" | "partial";
  report: string;
};

export type VerifyAgentLauncher = (
  input: AgentToolInput,
) => Promise<AgentToolOutput & { outputText?: string }>;

export function createVerifyTool(input: {
  cwd: string;
  launchAgent: VerifyAgentLauncher;
}): ToolDefinition<VerifyInput, VerifyOutput> {
  return {
    name: "verify",
    description: "Run independent read-only verification before delivery",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: {
          type: "object",
          required: [
            "type",
            "id",
            "cwd",
            "originalRequest",
            "implementationSummary",
            "changedFiles",
            "recommendedCommands",
          ],
          properties: {
            type: { type: "string" },
            id: { type: "string" },
            cwd: { type: "string" },
            worktreePath: { type: "string" },
            originalRequest: { type: "string" },
            implementationSummary: { type: "string" },
            changedFiles: { type: "array", items: { type: "string" } },
            recommendedCommands: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async call(args) {
      const evidence = await collectVerificationEvidence(args.target);
      const prompt = buildVerificationPrompt(evidence);

      const now = Date.now();
      const run: VerificationRun = {
        id: randomUUID(),
        target: args.target,
        status: "running",
        createdAt: now,
        updatedAt: now,
      };

      await saveVerificationRun(input.cwd, run);

      try {
        const output = await input.launchAgent({
          description: `Verify ${args.target.id}`,
          subagent_type: VERIFICATION_AGENT_TYPE,
          prompt,
          run_in_background: false,
        });

        const report = output.outputText ?? "";
        assertValidVerificationReport(report);

        const verdict = parseVerificationVerdict(report);

        const completedRun: VerificationRun = {
          ...run,
          status: "completed",
          verdict,
          report,
          updatedAt: Date.now(),
        };

        await saveVerificationRun(input.cwd, completedRun);

        return {
          runId: completedRun.id,
          verdict,
          report,
        };
      } catch (error) {
        const failedRun: VerificationRun = {
          ...run,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        };

        await saveVerificationRun(input.cwd, failedRun);
        throw error;
      }
    },
  };
}
```

这里先让验证同步执行。

原因是交付门禁通常要立刻知道结果：

```text
没有 verdict，就不能说完成。
```

如果后面要做长时间 E2E，可以扩展成后台验证：

- `run_in_background: true`
- 记录 verifier task id
- `verify status <runId>`
- verifier 完成通知更新记录

但本章先做同步版本，工程复杂度低很多。

## Agent 输出文本

如果你前面章节的 `AgentToolOutput` 没有 `outputText`，需要补上。

```ts
// src/agents/agentTypes.ts
export type AgentToolOutput =
  | {
      status: "completed";
      agentId: string;
      outputText: string;
    }
  | {
      status: "async_launched";
      agentId: string;
      outputFile: string;
    }
  | {
      status: "failed";
      agentId?: string;
      error: string;
    };
```

同步 Agent 调用完成时，必须把最终 assistant 文本返回给调用方。

否则 `verifyTool` 没法解析 verdict。

## 工具注册

把 verify 工具加进 registry。

```ts
// src/tools/toolRegistry.ts
import { createVerifyTool } from "../verification/verifyTool";

export function createDefaultToolRegistry(input: {
  cwd: string;
  launchAgent: AgentLauncher;
}) {
  const registry = createToolRegistry();

  registry.register(createFileReadTool(input.cwd));
  registry.register(createFileWriteTool(input.cwd));
  registry.register(createBashTool(input.cwd));
  registry.register(createAgentTool({ cwd: input.cwd }));
  registry.register(
    createVerifyTool({
      cwd: input.cwd,
      launchAgent: input.launchAgent,
    }),
  );

  return registry;
}
```

注意依赖方向：

```text
VerifyTool 依赖 AgentTool 的启动能力。
AgentTool 不需要知道 VerifyTool。
```

这样 verification 只是一个编排层，不会污染普通 Agent 执行。

## CLI 命令

现在做一个用户可以直接运行的命令。

```ts
// src/commands/verifyCommand.ts
import { $ } from "bun";
import type { VerificationTarget } from "../verification/verificationTypes";
import type { VerifyAgentLauncher } from "../verification/verifyTool";
import { createVerifyTool } from "../verification/verifyTool";

export async function handleVerifyCommand(input: {
  cwd: string;
  taskId?: string;
  originalRequest: string;
  implementationSummary: string;
  launchAgent: VerifyAgentLauncher;
}): Promise<string> {
  const changedFiles = await getChangedFiles(input.cwd);

  const target: VerificationTarget = {
    type: input.taskId ? "agent_task" : "working_tree",
    id: input.taskId ?? "working-tree",
    cwd: input.cwd,
    originalRequest: input.originalRequest,
    implementationSummary: input.implementationSummary,
    changedFiles,
    recommendedCommands: ["bun run typecheck"],
  };

  const tool = createVerifyTool({
    cwd: input.cwd,
    launchAgent: input.launchAgent,
  });

  const result = await tool.call({ target });

  return [
    `Verification run: ${result.runId}`,
    `Verdict: ${result.verdict.toUpperCase()}`,
    "",
    result.report,
  ].join("\n");
}

async function getChangedFiles(cwd: string): Promise<string[]> {
  const result = await $`git -C ${cwd} diff --name-only`.quiet().nothrow();
  const text = await result.text();

  return text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}
```

接到 `cli.ts`。

```ts
// src/cli.ts
if (process.argv[2] === "verify") {
  const taskId = readFlagValue(process.argv, "--task");
  const request = readFlagValue(process.argv, "--request") ?? "Verify current changes";
  const summary = readFlagValue(process.argv, "--summary") ?? "Current working tree changes";

  const output = await handleVerifyCommand({
    cwd: process.cwd(),
    taskId,
    originalRequest: request,
    implementationSummary: summary,
    launchAgent,
  });

  console.log(output);
  process.exit(0);
}
```

这里的 CLI 参数先保持朴素。

真实交互里，主 Agent 调 `verify` 工具时会传更完整的上下文：

- 原始用户需求。
- 计划文件路径。
- 所有改动文件。
- 实现摘要。
- 测试结果。
- worktree path。

命令行直接验证当前工作区只是一个调试入口。

## 交付门禁

现在做核心门禁：

```text
什么时候必须验证？
什么时候允许交付？
```

先定义“非平凡改动”。

```ts
// src/verification/deliveryGate.ts
import type { VerificationRun } from "./verificationTypes";

export type DeliveryChangeSummary = {
  changedFiles: string[];
  touchedBackend: boolean;
  touchedInfrastructure: boolean;
  touchedPublicApi: boolean;
  usedBatchOrWorktree: boolean;
};

export function requiresVerification(summary: DeliveryChangeSummary): boolean {
  if (summary.changedFiles.length >= 3) {
    return true;
  }

  if (summary.touchedBackend || summary.touchedInfrastructure) {
    return true;
  }

  if (summary.touchedPublicApi || summary.usedBatchOrWorktree) {
    return true;
  }

  return false;
}

export function assertCanDeliver(input: {
  summary: DeliveryChangeSummary;
  verificationRun?: VerificationRun;
}): void {
  if (!requiresVerification(input.summary)) {
    return;
  }

  if (!input.verificationRun) {
    throw new Error("Delivery blocked: verification is required");
  }

  if (input.verificationRun.status !== "completed") {
    throw new Error("Delivery blocked: verification has not completed");
  }

  if (input.verificationRun.verdict === "fail") {
    throw new Error("Delivery blocked: verification failed");
  }

  if (input.verificationRun.verdict === "partial") {
    throw new Error("Delivery blocked: verification is partial");
  }
}
```

这个策略和真实工程里的提示契约一致：

```text
非平凡实现必须独立验证。
实现者自己的检查不算 verifier verdict。
PARTIAL 不能被主线程自己编造。
```

为什么 `PARTIAL` 也拦截交付？

因为 `PARTIAL` 的意思是：

```text
有些关键检查因为环境限制没有完成。
```

这时不能直接说“已完成且验证通过”。

主线程应该告诉用户：

- 已经验证了什么。
- 没验证什么。
- 缺少什么环境。
- 当前是否建议合并。

如果用户明确接受风险，可以人工继续。

但系统默认不能把 `PARTIAL` 当 `PASS`。

## 改动分类

门禁需要知道改动类型。

先用路径启发式。

```ts
// src/verification/deliveryGate.ts
export function summarizeChangedFiles(input: {
  changedFiles: string[];
  usedBatchOrWorktree?: boolean;
}): DeliveryChangeSummary {
  return {
    changedFiles: input.changedFiles,
    usedBatchOrWorktree: input.usedBatchOrWorktree ?? false,
    touchedBackend: input.changedFiles.some(file =>
      [
        "server/",
        "api/",
        "routes/",
        "src/services/",
        "src/server/",
      ].some(prefix => file.startsWith(prefix)),
    ),
    touchedInfrastructure: input.changedFiles.some(file =>
      [
        ".github/",
        "Dockerfile",
        "docker-compose",
        "infra/",
        "scripts/",
      ].some(prefix => file.startsWith(prefix)),
    ),
    touchedPublicApi: input.changedFiles.some(file =>
      [
        "src/api/",
        "src/types/",
        "packages/",
      ].some(prefix => file.startsWith(prefix)),
    ),
  };
}
```

这不完美，但够实用。

后续可以扩展成项目配置：

```json
{
  "verification": {
    "alwaysVerify": ["src/api/**", "packages/**", ".github/**"],
    "defaultCommands": ["bun run typecheck", "bun test"]
  }
}
```

但不要一开始就做配置系统。

先让默认规则发挥作用。

## 主线程如何使用门禁

当 Agent 准备向用户总结“完成”时，应该先检查门禁。

在 Mini 里可以放在最终回复前的一个小钩子：

```ts
// src/chat/finalizeTurn.ts
import {
  assertCanDeliver,
  summarizeChangedFiles,
} from "../verification/deliveryGate";
import type { VerificationRun } from "../verification/verificationTypes";

export async function assertTurnCanFinish(input: {
  changedFiles: string[];
  usedBatchOrWorktree: boolean;
  latestVerificationRun?: VerificationRun;
}): Promise<void> {
  const summary = summarizeChangedFiles({
    changedFiles: input.changedFiles,
    usedBatchOrWorktree: input.usedBatchOrWorktree,
  });

  assertCanDeliver({
    summary,
    verificationRun: input.latestVerificationRun,
  });
}
```

如果抛错，不是直接崩溃给用户。

而是把错误转成下一轮模型提示：

```text
You are about to report completion, but verification is required.
Run the verify tool before final response.
```

这类“结构性提醒”非常重要。

真实工程里 `TodoWriteTool` 和 `TaskUpdateTool` 做的就是这个动作：

```text
当 3 个以上任务全部完成且没有验证步骤时，工具结果提醒主线程调用 verification Agent。
```

它不是靠模型自觉，而是在循环退出点插入提醒。

Mini 可以先在最终总结前做拦截，后续再把提醒下沉到 todo/task 工具。

## Todo 完成提醒

如果你前面已经做了 todo 工具，可以加一个轻量提醒。

```ts
// src/tools/todoTool.ts
function shouldNudgeVerification(todos: TodoItem[]): boolean {
  const allDone = todos.length >= 3 && todos.every(todo => todo.status === "completed");
  const hasVerificationStep = todos.some(todo => /verif|验证/i.test(todo.content));

  return allDone && !hasVerificationStep;
}
```

在工具结果里追加：

```ts
const verificationNudge = shouldNudgeVerification(todos)
  ? [
      "",
      "NOTE: You completed 3+ tasks without a verification step.",
      'Before final response, run the "verify" tool.',
      "Do not assign PASS or PARTIAL yourself.",
    ].join("\n")
  : "";
```

这类提醒的位置很关键。

它应该发生在模型最容易“顺手总结”的地方。

也就是：

```text
最后一个 todo 被标记完成之后。
```

## 批处理类型扩展

第 33 章的 batch unit 只有执行状态。

现在加验证状态。

```ts
// src/batch/batchTypes.ts
import type { VerificationVerdict } from "../verification/verificationTypes";

export type BatchUnitVerification = {
  status: "not_started" | "running" | "completed" | "failed";
  runId?: string;
  verdict?: VerificationVerdict;
  reportFile?: string;
  error?: string;
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
  verification?: BatchUnitVerification;
};
```

新增状态后，batch status 就不只看 worker 是否完成。

它还要看 verification verdict。

```text
completed + pass     -> 可以考虑 merge
completed + fail     -> 不能 merge，回到 worker 修
completed + partial  -> 需要人工判断或补环境
completed + none     -> 还没过门禁
```

## Batch Verify 命令

给 batch 加一个验证命令：

```bash
bun run src/cli.ts batch verify <runId>
```

它会遍历所有完成的 unit，对每个 unit 的 worktree 启动 verifier。

```ts
// src/batch/batchVerify.ts
import { createVerifyTool } from "../verification/verifyTool";
import type { VerifyAgentLauncher } from "../verification/verifyTool";
import type { BatchRun, BatchWorkerUnit } from "./batchTypes";
import { saveBatchRun } from "./batchRunStore";

export async function verifyBatchRun(input: {
  cwd: string;
  run: BatchRun;
  launchAgent: VerifyAgentLauncher;
}): Promise<BatchRun> {
  const tool = createVerifyTool({
    cwd: input.cwd,
    launchAgent: input.launchAgent,
  });

  for (const unit of input.run.units) {
    if (!shouldVerifyUnit(unit)) {
      continue;
    }

    unit.verification = { status: "running" };
    await saveBatchRun(input.cwd, input.run);

    try {
      const result = await tool.call({
        target: {
          type: "batch_unit",
          id: `${input.run.id}:${unit.id}`,
          cwd: input.cwd,
          worktreePath: unit.worktreePath,
          originalRequest: input.run.instruction,
          implementationSummary: unit.result ?? unit.prompt,
          changedFiles: [],
          recommendedCommands: [
            input.run.verificationRecipe,
            "bun run typecheck",
          ],
        },
      });

      unit.verification = {
        status: "completed",
        runId: result.runId,
        verdict: result.verdict,
      };
    } catch (error) {
      unit.verification = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await saveBatchRun(input.cwd, input.run);
  }

  return input.run;
}

function shouldVerifyUnit(unit: BatchWorkerUnit): boolean {
  if (unit.status !== "completed") {
    return false;
  }

  if (!unit.worktreePath) {
    return false;
  }

  return unit.verification?.status !== "completed";
}
```

这里有个小问题：

```ts
changedFiles: []
```

为什么先传空？

因为 batch unit 的 worktree diff 可以由 `collectVerificationEvidence` 在 worktree 里重新计算。

如果你想显示更友好，可以写一个 `getChangedFiles(worktreePath)` 再填进去。

## Batch 状态表

更新状态渲染。

```ts
// src/batch/batchStatus.ts
import type { BatchRun, BatchWorkerUnit } from "./batchTypes";

export function renderBatchStatus(run: BatchRun): string {
  const lines = [
    `Batch: ${run.id}`,
    `Status: ${run.status}`,
    "",
    "| ID | Title | Worker | Verification | Worktree |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const unit of run.units) {
    lines.push(
      [
        `| ${unit.id}`,
        unit.title,
        unit.status,
        renderVerification(unit),
        unit.worktreePath ?? "-",
        "|",
      ].join(" | "),
    );
  }

  return lines.join("\n");
}

function renderVerification(unit: BatchWorkerUnit): string {
  const verification = unit.verification;

  if (!verification) {
    return "not_started";
  }

  if (verification.status !== "completed") {
    return verification.status;
  }

  return verification.verdict ?? "completed";
}
```

示例：

```text
Batch: batch-123
Status: running

| ID | Title | Worker | Verification | Worktree |
| --- | --- | --- | --- | --- |
| 1 | 迁移 auth 模块 | completed | pass | .mini/worktrees/agent-a1 |
| 2 | 迁移 billing 模块 | completed | fail | .mini/worktrees/agent-a2 |
| 3 | 迁移 settings 模块 | running | not_started | .mini/worktrees/agent-a3 |
```

这样用户一眼能看到：

- 哪些 worker 完成了。
- 哪些通过验证。
- 哪些不能合并。

## Merge 门禁

第 32 章做过 worktree merge。

现在要加规则：

```text
batch unit 没有 verification pass，不允许自动 merge。
```

```ts
// src/batch/batchMergeGate.ts
import type { BatchWorkerUnit } from "./batchTypes";

export function assertBatchUnitCanMerge(unit: BatchWorkerUnit): void {
  if (unit.status !== "completed") {
    throw new Error(`Unit ${unit.id} is not completed`);
  }

  if (!unit.worktreePath) {
    throw new Error(`Unit ${unit.id} has no worktree path`);
  }

  if (unit.verification?.status !== "completed") {
    throw new Error(`Unit ${unit.id} has not been verified`);
  }

  if (unit.verification.verdict !== "pass") {
    throw new Error(
      `Unit ${unit.id} cannot merge because verification is ${unit.verification.verdict}`,
    );
  }
}
```

这条规则应该只拦自动化 merge。

用户当然可以手动查看 worktree，再自己决定是否合并。

但 Mini 作为 Agent 系统，不能在没有验证通过时替用户自动合并。

## FAIL 后怎么处理

验证失败不是终点。

正确流程是：

```text
verifier FAIL
主 Agent 读取失败报告
把失败报告交回实现 worker 或新 worker
修复后再次验证
直到 PASS 或用户接受 PARTIAL
```

在 batch 场景下，通常用同一个 worktree 修复。

因为失败报告指向的就是那个 worktree 的改动。

可以加一个修复 prompt：

```ts
// src/batch/batchRepairPrompt.ts
import type { BatchWorkerUnit } from "./batchTypes";

export function buildBatchRepairPrompt(unit: BatchWorkerUnit): string {
  return `
Your previous work for this batch unit did not pass verification.

Unit:

${unit.title}

Original unit prompt:

${unit.prompt}

Verification report:

${unit.verification?.error ?? "See verification report file."}

Fix the root cause in this worktree.
Run the relevant checks.
Do not merge.
Report what changed and which commands you ran.
`.trim();
}
```

如果你保留了 verifier 的完整 `reportFile`，这里应该传 report 内容，而不是只传 error。

本章先把重试策略留在提示层：

```text
FAIL 后，不要总结完成；先修再验。
```

后续可以做 `batch repair <runId> <unitId>`。

## 项目级 Verifier

真实工程有 `/init-verifiers` 命令，用来创建项目级 verifier skills。

Mini 可以做一个轻量版目录：

```text
.mini/verifiers/
  verifier-cli.md
  verifier-api.md
  verifier-ui.md
```

约定：

```text
文件名包含 verifier。
内容是给 verification Agent 的项目特定执行说明。
```

示例：

```markdown
# verifier-cli

Use this verifier for CLI changes.

Commands:

- bun run typecheck
- bun test
- bun run src/cli.ts --help

For CLI argument changes, run the command with:

- no input
- malformed input
- a normal representative input

Report stdout, stderr, and exit code.
```

加载函数：

```ts
// src/verification/projectVerifiers.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadProjectVerifierNotes(cwd: string): Promise<string> {
  const dir = join(cwd, ".mini/verifiers");

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return "";
  }

  const verifierFiles = names.filter(name => /verifier/i.test(name));
  const parts: string[] = [];

  for (const name of verifierFiles) {
    const raw = await readFile(join(dir, name), "utf8");
    parts.push(`## ${name}\n\n${raw.trim()}`);
  }

  return parts.join("\n\n");
}
```

然后把它拼进 `buildVerificationPrompt`：

```ts
Project verifier notes:

${projectVerifierNotes || "(none)"}
```

项目级 verifier 的价值是把“怎么验证这个项目”沉淀下来。

比如：

- UI 要访问哪个本地地址。
- CLI 的典型命令是什么。
- API 的健康检查路径是什么。
- 哪些环境变量必须由用户提供。

不要把真实密钥写进去。

只写变量名和使用方式。

## 推荐命令策略

Mini 可以给不同改动生成默认命令。

```ts
// src/verification/recommendedCommands.ts
export function getRecommendedCommands(changedFiles: string[]): string[] {
  const commands = ["bun run typecheck"];

  if (changedFiles.some(file => file.endsWith(".test.ts"))) {
    commands.push("bun test");
  }

  if (changedFiles.some(file => file.startsWith("src/cli"))) {
    commands.push("bun run src/cli.ts --help");
  }

  if (changedFiles.some(file => file.startsWith("src/tools/"))) {
    commands.push("bun test src/tools");
  }

  return [...new Set(commands)];
}
```

这不是替代 verifier 判断。

它只是减少 verifier 起步成本。

真正的 verifier 仍然要根据 diff 决定是否需要更多检查。

## 测试 Verdict 解析

先测最容易出错的部分。

```ts
// src/verification/__tests__/verificationVerdict.test.ts
import { describe, expect, test } from "bun:test";
import {
  assertValidVerificationReport,
  parseVerificationVerdict,
} from "../verificationVerdict";

describe("parseVerificationVerdict", () => {
  test("parses pass", () => {
    expect(parseVerificationVerdict("ok\nVERDICT: PASS")).toBe("pass");
  });

  test("parses fail", () => {
    expect(parseVerificationVerdict("bad\nVERDICT: FAIL")).toBe("fail");
  });

  test("parses partial", () => {
    expect(parseVerificationVerdict("limited\nVERDICT: PARTIAL")).toBe("partial");
  });

  test("rejects missing verdict", () => {
    expect(() => parseVerificationVerdict("PASS")).toThrow("Verification report");
  });
});

describe("assertValidVerificationReport", () => {
  test("rejects pass without command evidence", () => {
    expect(() => assertValidVerificationReport("looks good\nVERDICT: PASS")).toThrow(
      "command evidence",
    );
  });

  test("accepts pass with command evidence", () => {
    expect(() =>
      assertValidVerificationReport(
        [
          "### Check: typecheck",
          "**Command run:**",
          "  bun run typecheck",
          "**Output observed:**",
          "  ok",
          "**Result: PASS**",
          "VERDICT: PASS",
        ].join("\n"),
      ),
    ).not.toThrow();
  });
});
```

运行：

```bash
bun test src/verification/__tests__/verificationVerdict.test.ts
```

## 测试门禁

```ts
// src/verification/__tests__/deliveryGate.test.ts
import { describe, expect, test } from "bun:test";
import {
  assertCanDeliver,
  requiresVerification,
  summarizeChangedFiles,
} from "../deliveryGate";

describe("requiresVerification", () => {
  test("requires verification for 3 or more files", () => {
    expect(
      requiresVerification({
        changedFiles: ["a.ts", "b.ts", "c.ts"],
        touchedBackend: false,
        touchedInfrastructure: false,
        touchedPublicApi: false,
        usedBatchOrWorktree: false,
      }),
    ).toBe(true);
  });

  test("requires verification for batch work", () => {
    expect(
      requiresVerification({
        changedFiles: ["a.ts"],
        touchedBackend: false,
        touchedInfrastructure: false,
        touchedPublicApi: false,
        usedBatchOrWorktree: true,
      }),
    ).toBe(true);
  });
});

describe("assertCanDeliver", () => {
  test("blocks non-trivial changes without verification", () => {
    const summary = summarizeChangedFiles({
      changedFiles: ["a.ts", "b.ts", "c.ts"],
    });

    expect(() => assertCanDeliver({ summary })).toThrow("verification is required");
  });

  test("allows pass verdict", () => {
    const summary = summarizeChangedFiles({
      changedFiles: ["a.ts", "b.ts", "c.ts"],
    });

    expect(() =>
      assertCanDeliver({
        summary,
        verificationRun: {
          id: "v1",
          status: "completed",
          verdict: "pass",
          createdAt: 1,
          updatedAt: 2,
          target: {
            type: "working_tree",
            id: "working-tree",
            cwd: "/tmp/project",
            originalRequest: "test",
            implementationSummary: "test",
            changedFiles: ["a.ts", "b.ts", "c.ts"],
            recommendedCommands: [],
          },
        },
      }),
    ).not.toThrow();
  });
});
```

运行：

```bash
bun test src/verification/__tests__/deliveryGate.test.ts
```

## 手工验证流程

完成本章代码后，可以这样试。

先做一个小改动，让工作区有 diff。

然后运行：

```bash
bun run src/cli.ts verify \
  --request "验证当前改动" \
  --summary "当前工作区包含一处示例改动"
```

预期输出类似：

```text
Verification run: 8c2d...
Verdict: PASS

### Check: typecheck
**Command run:**
  bun run typecheck
**Output observed:**
  ...
**Result: PASS**

VERDICT: PASS
```

如果 verifier 没有输出 `VERDICT`，工具应该失败。

如果 verifier 输出 `PASS` 但没有命令证据，工具也应该失败。

这两个失败都不是坏事。

它们说明门禁在工作。

## 和普通自检的区别

实现 Agent 自己跑：

```bash
bun run typecheck
```

这叫自检。

验证 Agent 跑：

```bash
bun run typecheck
```

这叫验证的一部分。

两者命令可能一样，但语义不同。

自检的目的：

```text
实现者确认自己没有明显搞坏。
```

验证的目的：

```text
独立角色尝试证明实现真的满足需求。
```

所以 verifier 不能只是复述实现者跑过的命令。

它至少要补一个独立 probe。

例如：

- CLI 改动：再跑一个非法参数。
- API 改动：再请求一个边界输入。
- UI 改动：再点一次取消、刷新或空状态。
- 文件工具改动：再试不存在路径和权限错误。

## 常见坑

### 1. 让 verifier 能写文件

不要这么做。

verifier 一旦能改项目文件，它就会顺手修问题。修完以后再 PASS，你就不知道原实现到底有没有通过。

允许写 `/tmp` 可以。

允许改项目不行。

### 2. 只跑全量测试

全量测试通过只是底线。

它不能证明新功能真的可用。

新功能必须被直接执行。

### 3. 把 PARTIAL 当 PASS

`PARTIAL` 表示关键验证没完成。

主线程可以报告它，但不能把它说成通过。

### 4. 让实现 worker 自己出 verdict

实现 worker 可以说：

```text
我跑了 bun run typecheck。
```

但不能说：

```text
VERDICT: PASS
```

verdict 只属于 verification Agent。

### 5. Batch 完成后直接 merge

worker 完成只代表它停止了。

不代表改动正确。

Batch unit 至少要有 verification `pass` 才能进入自动 merge。

### 6. 忽略 verifier 的 FAIL

FAIL 报告要当成输入继续修。

不要把失败压缩成一句“有些测试没过”。

应该把具体命令、输出、失败现象交回实现 worker。

## 本章小结

本章给 Mini 加了一道真正的交付门禁：

- 内置只读 verification Agent。
- 验证证据收集。
- verification prompt。
- verdict 解析。
- 验证记录持久化。
- `verify` 工具。
- 非平凡改动交付门禁。
- todo 完成提醒。
- batch unit 验证状态。
- batch merge 门禁。

Mini 现在不只是“会写代码”，还开始具备“交付前独立验证”的能力。

下一章可以继续做 **项目级规则与配置系统**：把模型、工具权限、验证命令、目录策略、默认沙箱模式都收敛到一个可持久化配置里，让 Mini 从 demo 变成可长期使用的本地 Agent 工具。
