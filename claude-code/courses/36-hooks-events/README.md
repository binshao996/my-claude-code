# 第 36 章：Hooks 与事件系统

第三十五章把 Mini 的行为收敛到了配置系统。

现在用户已经可以用 `.mini/settings.json` 声明：

- 默认模型。
- 权限规则。
- 验证命令。
- worktree 策略。
- sandbox 策略。

但真实项目里，经常还需要把 Agent 接进团队现有流程。

例如：

- 每次 `bash` 执行前检查危险命令。
- 每次文件写入后自动跑格式检查。
- 验证失败时发一条本地通知。
- 任务完成时写入审计日志。
- 会话开始时加载项目约定。
- 会话结束时保存本轮摘要。

这些逻辑不能全写死在 Mini 里。

它们应该由用户通过配置挂接。

这就是 Hooks 系统。

本章给 Mini 增加一套最小可用的事件系统：

```text
事件发生 -> 找到匹配 hook -> 执行脚本 -> 解析输出 -> 决定继续、阻塞、补充上下文或记录结果
```

第一版只实现 command hooks。

也就是：

```text
Mini 把 hook input JSON 通过 stdin 传给用户脚本。
用户脚本通过 stdout JSON 返回决策。
```

这已经足够覆盖大多数本地工程自动化。

## 真实工程怎么做

真实工程的 hooks 系统比 Mini 第一版复杂很多，主要分布在这些文件里：

- `src/schemas/hooks.ts`：定义 hooks 配置 schema。支持 `command`、`prompt`、`http`、`agent` 四类 hook。
- `src/entrypoints/sdk/coreSchemas.ts`：定义所有 hook event 和每种 hook input/output schema。
- `src/utils/settings/types.ts`：把 `HooksSchema` 接入 settings schema。
- `src/utils/hooks.ts`：核心执行器。负责匹配、并发执行、超时、信任检查、输出解析、阻塞语义、补充上下文、权限决策。
- `src/services/tools/toolHooks.ts`：把 `PreToolUse`、`PostToolUse`、`PostToolUseFailure` 接入工具执行链路。
- `src/query/stopHooks.ts`：在每轮回复结束时执行 `Stop` / `SubagentStop` hooks，并允许 hook 阻止继续总结。
- `src/utils/hooks/execHttpHook.ts`：HTTP hook 执行器，包含 header 环境变量插值、URL allowlist、SSRF 防护、sandbox proxy。
- `src/utils/hooks/hooksSettings.ts`：把不同来源的 hooks 汇总给 UI 展示。
- `src/utils/hooks/sessionHooks.ts`：支持 session 级临时 hook，避免不同 Agent 的 hook 泄漏。
- `src/components/hooks/`：交互式 hooks 配置界面。

真实工程里有几个关键设计：

```text
1. hooks 来自 settings，可以按事件和 matcher 分组。
2. hooks 执行前必须检查工作区信任，因为项目配置可以执行任意命令。
3. hooks 默认并发执行，每个 hook 有独立超时。
4. stdout 如果是 JSON，就按 hook output 协议解析；否则当作普通输出。
5. exit code 2 表示 blocking feedback。
6. PreToolUse hook 可以 deny / ask / allow / 改写 input。
7. hook allow 不能绕过 settings deny 规则。
8. HTTP hook 必须防 SSRF，不能让项目配置访问云 metadata 或内网。
```

Mini 本章先做这条主线：

```text
settings hooks -> matcher -> command execution -> JSON output -> tool/session/task/verification 集成
```

## 本章目标

完成后，Mini 支持在 `.mini/settings.json` 里写：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "bash",
          "hooks": [
            {
              "type": "command",
              "command": "bun scripts/hooks/block-dangerous-bash.ts",
              "timeoutMs": 3000
            }
          ]
        }
      ],
      "VerificationFailed": [
        {
          "matcher": "*",
          "hooks": [
            {
              "type": "command",
              "command": "bun scripts/hooks/on-verification-failed.ts",
              "timeoutMs": 3000
            }
          ]
        }
      ]
    }
  }
}
```

当模型准备执行 `bash` 工具时，Mini 会向脚本发送：

```json
{
  "hookEventName": "PreToolUse",
  "sessionId": "session-123",
  "cwd": "/path/to/project",
  "toolName": "bash",
  "toolInput": {
    "command": "git push origin main"
  },
  "toolUseId": "tool-456"
}
```

脚本可以返回：

```json
{
  "decision": "block",
  "reason": "Do not push from Mini automatically"
}
```

Mini 收到后会阻止工具执行。

本章要实现：

- hooks 类型和 schema。
- hooks 配置接入第三十五章 settings。
- matcher 匹配。
- command hook 执行器。
- hook output 解析。
- hook 批处理结果聚合。
- `PreToolUse`、`PostToolUse`、`PostToolUseFailure` 接入工具执行。
- `SessionStart`、`SessionEnd`、`Stop` 接入会话。
- `TaskCompleted`、`VerificationFailed` 接入任务和验证门禁。
- hooks 测试。

## 推荐目录

新增：

```text
src/hooks/
  hookTypes.ts
  hookSchema.ts
  hookMatcher.ts
  hookInput.ts
  hookOutput.ts
  commandHookRunner.ts
  hookExecutor.ts
  toolHookBridge.ts
  sessionHookBridge.ts
  taskHookBridge.ts
  verificationHookBridge.ts
```

修改：

```text
src/config/configTypes.ts
src/config/configDefaults.ts
src/config/configSchema.ts
src/tools/toolExecution.ts
src/session/sessionLifecycle.ts
src/tasks/taskNotifications.ts
src/verification/verifyTool.ts
```

如果你前面章节文件名不同，把代码放到相同职责的位置即可。

## Mini 的事件列表

真实工程有二十多个 hook event。

Mini 第一版保留最常用的 10 个：

```ts
// src/hooks/hookTypes.ts
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "Notification",
  "TaskCompleted",
  "VerificationFailed",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
```

对应含义：

| Event | 触发时机 | 是否可阻塞 |
| --- | --- | --- |
| `PreToolUse` | 工具执行前 | 可以 |
| `PostToolUse` | 工具成功后 | 一般不阻塞 |
| `PostToolUseFailure` | 工具失败后 | 一般不阻塞 |
| `UserPromptSubmit` | 用户输入提交后，送模型前 | 可以补充上下文 |
| `SessionStart` | 会话启动、恢复或清空时 | 可以补充上下文 |
| `SessionEnd` | 会话退出前 | 不建议阻塞 |
| `Stop` | 每轮 assistant 准备结束时 | 可以阻止结束 |
| `Notification` | Mini 产生通知时 | 不阻塞 |
| `TaskCompleted` | 后台任务完成时 | 可以阻止任务被标记完成 |
| `VerificationFailed` | 第 34 章 verifier 返回 fail 时 | 不阻塞，但可通知或记录 |

`VerificationFailed` 是 Mini 为第 34 章新增的明确事件。

真实工程里可以通过 `TaskCompleted`、`Stop` 或通知类 hook 实现类似效果。Mini 这里单独列出来，是为了让验证门禁和团队流程更容易接上。

## Hook 配置类型

第一版只实现 command hook。

```ts
// src/hooks/hookTypes.ts
export type CommandHook = {
  type: "command";
  command: string;
  timeoutMs?: number;
  statusMessage?: string;
  once?: boolean;
  async?: boolean;
};

export type HookCommand = CommandHook;

export type HookMatcher = {
  matcher?: string;
  hooks: HookCommand[];
};

export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>;

export type HooksConfig = {
  enabled: boolean;
  requireTrust: boolean;
  events: HooksSettings;
};
```

为什么这里把真实工程的 `prompt`、`http`、`agent` hook 先去掉？

因为 command hook 是最基础、最容易验证、最贴近本地工程自动化的版本。

等 command hook 稳定后，再扩展：

- `http`：把 hook input POST 到外部服务。
- `prompt`：让小模型判断是否补充上下文。
- `agent`：让一个子 Agent 做复杂检查。

但第一版不要一次做太大。

## Hook Input

所有 hook 都共享一组基础字段。

```ts
// src/hooks/hookInput.ts
import type { HookEvent } from "./hookTypes";

export type BaseHookInput = {
  hookEventName: HookEvent;
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  permissionMode?: string;
  agentId?: string;
  agentType?: string;
};
```

再定义具体事件。

```ts
// src/hooks/hookInput.ts
export type PreToolUseHookInput = BaseHookInput & {
  hookEventName: "PreToolUse";
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
};

export type PostToolUseHookInput = BaseHookInput & {
  hookEventName: "PostToolUse";
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  toolUseId: string;
};

export type PostToolUseFailureHookInput = BaseHookInput & {
  hookEventName: "PostToolUseFailure";
  toolName: string;
  toolInput: unknown;
  error: string;
  toolUseId: string;
};

export type UserPromptSubmitHookInput = BaseHookInput & {
  hookEventName: "UserPromptSubmit";
  prompt: string;
};

export type SessionStartHookInput = BaseHookInput & {
  hookEventName: "SessionStart";
  source: "startup" | "resume" | "clear";
  model: string;
};

export type SessionEndHookInput = BaseHookInput & {
  hookEventName: "SessionEnd";
  reason: "exit" | "interrupt" | "error";
};

export type StopHookInput = BaseHookInput & {
  hookEventName: "Stop";
  lastAssistantMessage?: string;
};

export type NotificationHookInput = BaseHookInput & {
  hookEventName: "Notification";
  notificationType: string;
  title?: string;
  message: string;
};

export type TaskCompletedHookInput = BaseHookInput & {
  hookEventName: "TaskCompleted";
  taskId: string;
  taskTitle: string;
  status: "completed" | "failed" | "cancelled";
};

export type VerificationFailedHookInput = BaseHookInput & {
  hookEventName: "VerificationFailed";
  runId: string;
  targetId: string;
  report: string;
};

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | NotificationHookInput
  | TaskCompletedHookInput
  | VerificationFailedHookInput;
```

字段命名可以用 camelCase。

真实工程 SDK schema 用 snake_case。Mini 只要内部统一即可。

## Hook Output

hook 脚本可以什么都不输出。

也可以输出 JSON。

Mini 支持这些字段：

```ts
// src/hooks/hookOutput.ts
export type HookDecision = "approve" | "block";

export type PermissionDecision = "allow" | "deny" | "ask";

export type HookSpecificOutput =
  | {
      hookEventName: "PreToolUse";
      permissionDecision?: PermissionDecision;
      permissionDecisionReason?: string;
      updatedInput?: Record<string, unknown>;
      additionalContext?: string;
    }
  | {
      hookEventName: "PostToolUse";
      additionalContext?: string;
    }
  | {
      hookEventName: "PostToolUseFailure";
      additionalContext?: string;
    }
  | {
      hookEventName: "UserPromptSubmit";
      additionalContext?: string;
    }
  | {
      hookEventName: "SessionStart";
      additionalContext?: string;
      initialUserMessage?: string;
    }
  | {
      hookEventName: "TaskCompleted";
      additionalContext?: string;
    };

export type HookJsonOutput = {
  decision?: HookDecision;
  reason?: string;
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: HookSpecificOutput;
};

export type HookParsedOutput =
  | {
      type: "json";
      value: HookJsonOutput;
    }
  | {
      type: "text";
      value: string;
    };
```

核心语义：

```text
decision: "block"       -> 阻塞当前动作。
continue: false         -> 阻止当前轮继续。
systemMessage           -> 注入系统提示。
additionalContext       -> 注入补充上下文。
updatedInput            -> 改写工具输入。
permissionDecision      -> 影响工具权限决策。
```

再写解析函数。

```ts
// src/hooks/hookOutput.ts
export function parseHookOutput(stdout: string): HookParsedOutput {
  const trimmed = stdout.trim();

  if (!trimmed.startsWith("{")) {
    return {
      type: "text",
      value: stdout,
    };
  }

  const value = JSON.parse(trimmed) as HookJsonOutput;

  return {
    type: "json",
    value,
  };
}
```

第一版先只做 `JSON.parse`。

后面可以用 `zod` 给 output 做严格校验。

## Hook Schema

把 hooks 接进第 35 章的配置 schema。

```ts
// src/hooks/hookSchema.ts
import { z } from "zod";
import { HOOK_EVENTS } from "./hookTypes";

export const commandHookSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    statusMessage: z.string().optional(),
    once: z.boolean().optional(),
    async: z.boolean().optional(),
  })
  .strict();

export const hookMatcherSchema = z
  .object({
    matcher: z.string().optional(),
    hooks: z.array(commandHookSchema),
  })
  .strict();

export const hooksConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireTrust: z.boolean().optional(),
    events: z.partialRecord(z.enum(HOOK_EVENTS), z.array(hookMatcherSchema)).optional(),
  })
  .strict();
```

然后修改第三十五章的 settings schema：

```ts
// src/config/configSchema.ts
import { hooksConfigSchema } from "../hooks/hookSchema";

export const miniSettingsSchema = z
  .object({
    // ...
    hooks: hooksConfigSchema.optional(),
  })
  .strict();
```

修改类型：

```ts
// src/config/configTypes.ts
import type { HooksConfig } from "../hooks/hookTypes";

export type MiniSettings = {
  // ...
  hooks?: Partial<HooksConfig>;
};

export type EffectiveSettings = Required<{
  // ...
  hooks: HooksConfig;
}>;
```

默认值：

```ts
// src/config/configDefaults.ts
export const DEFAULT_SETTINGS: EffectiveSettings = {
  // ...
  hooks: {
    enabled: true,
    requireTrust: true,
    events: {},
  },
};
```

合并时记得合并事件数组：

```ts
// src/config/configMerge.ts
function mergeHooks(
  base: HooksConfig,
  patch: Partial<HooksConfig> | undefined,
): HooksConfig {
  if (!patch) {
    return base;
  }

  return {
    enabled: patch.enabled ?? base.enabled,
    requireTrust: patch.requireTrust ?? base.requireTrust,
    events: mergeHookEvents(base.events, patch.events),
  };
}

function mergeHookEvents(
  base: HooksSettings,
  patch: HooksSettings | undefined,
): HooksSettings {
  if (!patch) {
    return base;
  }

  const result: HooksSettings = { ...base };

  for (const [event, matchers] of Object.entries(patch)) {
    const key = event as HookEvent;
    result[key] = [...(result[key] ?? []), ...(matchers ?? [])];
  }

  return result;
}
```

读取时多个来源的 hooks 会叠加。

这和真实工程一致。

## Matcher 匹配

hook matcher 用来决定某个事件是否命中。

Mini 支持三种：

```text
*                 匹配全部。
bash              精确匹配。
read|write        多个精确匹配。
^file_.*          正则匹配。
```

```ts
// src/hooks/hookMatcher.ts
export function matchesHookPattern(input: {
  value: string;
  matcher?: string;
}): boolean {
  const matcher = input.matcher;

  if (!matcher || matcher === "*") {
    return true;
  }

  if (/^[a-zA-Z0-9_|-]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      return matcher.split("|").some(part => part.trim() === input.value);
    }

    return matcher === input.value;
  }

  try {
    return new RegExp(matcher).test(input.value);
  } catch {
    return false;
  }
}
```

然后根据事件选择 match query。

```ts
// src/hooks/hookMatcher.ts
import type { HookInput } from "./hookInput";

export function getHookMatchValue(input: HookInput): string {
  switch (input.hookEventName) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      return input.toolName;
    case "Notification":
      return input.notificationType;
    case "SessionStart":
      return input.source;
    case "SessionEnd":
      return input.reason;
    case "TaskCompleted":
      return input.status;
    case "VerificationFailed":
      return "failed";
    case "UserPromptSubmit":
    case "Stop":
      return "*";
  }
}
```

真实工程对 matcher 做了更多兼容：

- 旧工具名归一。
- regex fallback。
- `if` 条件用权限规则语法进一步过滤。
- plugin / skill / session hook 去重。

Mini 先不做这些。

## 找到匹配 Hooks

```ts
// src/hooks/hookExecutor.ts
import type { EffectiveSettings } from "../config/configTypes";
import type { HookCommand } from "./hookTypes";
import type { HookInput } from "./hookInput";
import { getHookMatchValue, matchesHookPattern } from "./hookMatcher";

export function getMatchingHooks(input: {
  settings: EffectiveSettings;
  hookInput: HookInput;
}): HookCommand[] {
  if (!input.settings.hooks.enabled) {
    return [];
  }

  const matchers = input.settings.hooks.events[input.hookInput.hookEventName] ?? [];
  const matchValue = getHookMatchValue(input.hookInput);

  return matchers
    .filter(matcher =>
      matchesHookPattern({
        value: matchValue,
        matcher: matcher.matcher,
      }),
    )
    .flatMap(matcher => matcher.hooks);
}
```

先不去重。

如果用户在 user 和 project 都配置了同一个 hook，它会执行两次。

后面可以加：

```text
相同 command + 相同 matcher 只执行优先级最高的一条。
```

第一版保持简单。

## Command Hook 执行器

hook 脚本通过 stdin 收到 JSON。

stdout 如果是 JSON，Mini 解析为决策。

stderr 用于错误展示。

```ts
// src/hooks/commandHookRunner.ts
import type { CommandHook } from "./hookTypes";

export type CommandHookRawResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export async function runCommandHook(input: {
  cwd: string;
  hook: CommandHook;
  hookInput: unknown;
}): Promise<CommandHookRawResult> {
  const startedAt = Date.now();
  const timeoutMs = input.hook.timeoutMs ?? 10_000;
  const json = JSON.stringify(input.hookInput);

  const proc = Bun.spawn(["bash", "-lc", input.hook.command], {
    cwd: input.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MINI_HOOK_EVENT: String((input.hookInput as { hookEventName?: string }).hookEventName ?? ""),
    },
  });

  proc.stdin.write(new TextEncoder().encode(json));
  proc.stdin.end();

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timeout);

  return {
    command: input.hook.command,
    exitCode,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - startedAt,
  };
}
```

这里用 `bash -lc` 是为了让 hook command 和用户平时在终端里写的一致。

如果你要支持 Windows，可以在配置里加 `shell` 字段。真实工程就支持不同 shell。

## Hook Result 聚合

把 raw result 转成 Mini 能理解的结构。

```ts
// src/hooks/hookExecutor.ts
import { runCommandHook } from "./commandHookRunner";
import { parseHookOutput } from "./hookOutput";

export type HookBatchResult = {
  blockingError?: string;
  preventContinuation?: boolean;
  stopReason?: string;
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContexts: string[];
  systemMessages: string[];
  errors: string[];
};

export async function executeHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  hookInput: HookInput;
}): Promise<HookBatchResult> {
  const hooks = getMatchingHooks({
    settings: input.settings,
    hookInput: input.hookInput,
  });

  const result: HookBatchResult = {
    additionalContexts: [],
    systemMessages: [],
    errors: [],
  };

  if (hooks.length === 0) {
    return result;
  }

  const rawResults = await Promise.all(
    hooks.map(hook =>
      runCommandHook({
        cwd: input.cwd,
        hook,
        hookInput: input.hookInput,
      }),
    ),
  );

  for (const raw of rawResults) {
    mergeRawHookResult(result, raw);
  }

  return result;
}
```

处理单个结果：

```ts
// src/hooks/hookExecutor.ts
import type { CommandHookRawResult } from "./commandHookRunner";

function mergeRawHookResult(
  batch: HookBatchResult,
  raw: CommandHookRawResult,
): void {
  if (raw.timedOut) {
    batch.errors.push(`Hook timed out: ${raw.command}`);
    return;
  }

  if (raw.exitCode === 2) {
    batch.blockingError = raw.stderr || raw.stdout || `Hook blocked: ${raw.command}`;
    return;
  }

  if (raw.exitCode !== 0) {
    batch.errors.push(raw.stderr || `Hook failed with exit code ${raw.exitCode}: ${raw.command}`);
    return;
  }

  if (!raw.stdout.trim()) {
    return;
  }

  const parsed = parseHookOutput(raw.stdout);

  if (parsed.type === "text") {
    batch.additionalContexts.push(parsed.value);
    return;
  }

  mergeJsonOutput(batch, parsed.value);
}
```

JSON 输出聚合：

```ts
// src/hooks/hookExecutor.ts
import type { HookJsonOutput } from "./hookOutput";

function mergeJsonOutput(batch: HookBatchResult, json: HookJsonOutput): void {
  if (json.decision === "block") {
    batch.blockingError = json.reason ?? "Blocked by hook";
  }

  if (json.continue === false) {
    batch.preventContinuation = true;
    batch.stopReason = json.stopReason ?? json.reason;
  }

  if (json.systemMessage) {
    batch.systemMessages.push(json.systemMessage);
  }

  const specific = json.hookSpecificOutput;

  if (!specific) {
    return;
  }

  if ("additionalContext" in specific && specific.additionalContext) {
    batch.additionalContexts.push(specific.additionalContext);
  }

  if (specific.hookEventName === "PreToolUse") {
    if (specific.permissionDecision) {
      batch.permissionDecision = strongestPermissionDecision(
        batch.permissionDecision,
        specific.permissionDecision,
      );
    }

    if (specific.permissionDecisionReason) {
      batch.permissionDecisionReason = specific.permissionDecisionReason;
    }

    if (specific.updatedInput) {
      batch.updatedInput = specific.updatedInput;
    }
  }
}

function strongestPermissionDecision(
  current: "allow" | "deny" | "ask" | undefined,
  next: "allow" | "deny" | "ask",
): "allow" | "deny" | "ask" {
  const weight = {
    deny: 3,
    ask: 2,
    allow: 1,
  };

  if (!current) {
    return next;
  }

  return weight[next] > weight[current] ? next : current;
}
```

这里采用和权限系统一致的原则：

```text
deny > ask > allow
```

如果多个 hook 给出不同意见，最保守的结果获胜。

## PreToolUse 接入

现在把 hook 接到工具执行前。

假设你前面有类似：

```ts
const permission = await canUseTool(tool, input);
const result = await tool.call(input);
```

改成：

```ts
// src/hooks/toolHookBridge.ts
import { randomUUID } from "node:crypto";
import type { EffectiveSettings } from "../config/configTypes";
import { executeHooks } from "./hookExecutor";

export async function runPreToolUseHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  permissionMode: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}): Promise<{
  allowed: boolean;
  toolInput: Record<string, unknown>;
  forcePermissionDecision?: "allow" | "deny" | "ask";
  reason?: string;
  additionalContexts: string[];
}> {
  const toolUseId = randomUUID();

  const result = await executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "PreToolUse",
      sessionId: input.sessionId,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolUseId,
    },
  });

  if (result.blockingError || result.permissionDecision === "deny") {
    return {
      allowed: false,
      toolInput: input.toolInput,
      reason: result.blockingError ?? result.permissionDecisionReason,
      additionalContexts: result.additionalContexts,
    };
  }

  return {
    allowed: true,
    toolInput: result.updatedInput ?? input.toolInput,
    forcePermissionDecision: result.permissionDecision,
    reason: result.permissionDecisionReason,
    additionalContexts: result.additionalContexts,
  };
}
```

在工具执行链路中使用：

```ts
const preHook = await runPreToolUseHooks({
  settings,
  cwd,
  sessionId,
  permissionMode,
  toolName: tool.name,
  toolInput: input,
});

if (!preHook.allowed) {
  return {
    ok: false,
    error: `Blocked by PreToolUse hook: ${preHook.reason ?? "no reason"}`,
  };
}

const permission = await canUseTool(tool, preHook.toolInput, {
  forceDecision: preHook.forcePermissionDecision,
});

if (!permission.allowed) {
  return {
    ok: false,
    error: permission.reason,
  };
}

const result = await tool.call(preHook.toolInput);
```

关键规则：

```text
hook deny 可以直接拦工具。
hook ask 可以强制进入权限询问。
hook allow 只能跳过普通确认，但不能覆盖 deny 规则。
```

如果你的 `canUseTool` 还没有 `forceDecision` 参数，可以先只处理 deny 和 updatedInput。

## PostToolUse 接入

工具成功后执行 `PostToolUse`。

```ts
// src/hooks/toolHookBridge.ts
export async function runPostToolUseHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  permissionMode: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  toolUseId: string;
}): Promise<HookBatchResult> {
  return executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "PostToolUse",
      sessionId: input.sessionId,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolResponse: input.toolResponse,
      toolUseId: input.toolUseId,
    },
  });
}
```

失败时执行 `PostToolUseFailure`：

```ts
// src/hooks/toolHookBridge.ts
export async function runPostToolUseFailureHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  permissionMode: string;
  toolName: string;
  toolInput: unknown;
  error: string;
  toolUseId: string;
}): Promise<HookBatchResult> {
  return executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "PostToolUseFailure",
      sessionId: input.sessionId,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      toolName: input.toolName,
      toolInput: input.toolInput,
      error: input.error,
      toolUseId: input.toolUseId,
    },
  });
}
```

在工具执行器里：

```ts
try {
  const response = await tool.call(finalInput);

  await runPostToolUseHooks({
    settings,
    cwd,
    sessionId,
    permissionMode,
    toolName: tool.name,
    toolInput: finalInput,
    toolResponse: response,
    toolUseId,
  });

  return response;
} catch (error) {
  await runPostToolUseFailureHooks({
    settings,
    cwd,
    sessionId,
    permissionMode,
    toolName: tool.name,
    toolInput: finalInput,
    error: error instanceof Error ? error.message : String(error),
    toolUseId,
  });

  throw error;
}
```

Post hooks 失败默认不要让主工具失败。

否则一个日志脚本坏了，会导致代码写入工具也失败。

只有 `PreToolUse` 和 `Stop` 这类本来就设计为门禁的事件，才适合阻塞主流程。

## UserPromptSubmit 接入

用户输入提交后，可以让 hook 补充上下文。

例如把 issue id 转成任务说明。

```ts
// src/hooks/sessionHookBridge.ts
import { executeHooks } from "./hookExecutor";

export async function runUserPromptSubmitHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  permissionMode: string;
  prompt: string;
}): Promise<{
  prompt: string;
  additionalContexts: string[];
}> {
  const result = await executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "UserPromptSubmit",
      sessionId: input.sessionId,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      prompt: input.prompt,
    },
  });

  return {
    prompt: input.prompt,
    additionalContexts: result.additionalContexts,
  };
}
```

在 chat loop 里：

```ts
const promptHooks = await runUserPromptSubmitHooks({
  settings,
  cwd,
  sessionId,
  permissionMode,
  prompt: userInput,
});

const userMessage = [
  promptHooks.prompt,
  ...promptHooks.additionalContexts.map(context => `\n\n[Hook context]\n${context}`),
].join("");
```

不要让 hook 静默替换用户输入。

第一版只允许追加上下文。

这样更容易排查。

## SessionStart 和 SessionEnd

会话开始时执行：

```ts
// src/hooks/sessionHookBridge.ts
export async function runSessionStartHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  source: "startup" | "resume" | "clear";
  model: string;
}): Promise<HookBatchResult> {
  return executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "SessionStart",
      sessionId: input.sessionId,
      cwd: input.cwd,
      source: input.source,
      model: input.model,
    },
  });
}
```

会话结束时执行：

```ts
// src/hooks/sessionHookBridge.ts
export async function runSessionEndHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  reason: "exit" | "interrupt" | "error";
}): Promise<void> {
  await executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "SessionEnd",
      sessionId: input.sessionId,
      cwd: input.cwd,
      reason: input.reason,
    },
  });
}
```

`SessionEnd` 要有短超时。

退出时不能被一个 hook 卡住很久。

真实工程里 `SessionEnd` 的默认超时比普通工具 hook 短很多。Mini 可以把这类 hook 的 `timeoutMs` 推荐设置在 1000 到 3000ms。

## Stop Hook

`Stop` 是一类非常有用的 hook。

它在 assistant 准备结束本轮前触发。

用途：

- 检查最后回复里有没有缺少测试结果。
- 检查是否提到了验证结果。
- 阻止没有完成门禁的总结。
- 追加最终摘要到日志。

```ts
// src/hooks/sessionHookBridge.ts
export async function runStopHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  permissionMode: string;
  lastAssistantMessage: string;
}): Promise<HookBatchResult> {
  return executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "Stop",
      sessionId: input.sessionId,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      lastAssistantMessage: input.lastAssistantMessage,
    },
  });
}
```

在 chat loop 准备 `return assistantText` 前：

```ts
const stopHook = await runStopHooks({
  settings,
  cwd,
  sessionId,
  permissionMode,
  lastAssistantMessage: assistantText,
});

if (stopHook.blockingError || stopHook.preventContinuation) {
  appendSystemMessage([
    "Stop hook blocked final response.",
    stopHook.blockingError ?? stopHook.stopReason ?? "",
  ].join("\n"));

  continue;
}

return assistantText;
```

这和第 34 章 verification gate 很适合搭配：

```text
如果本轮有非平凡改动，但最终回复没有 verifier verdict，Stop hook 可以阻止结束。
```

当然，这种核心门禁最好还是写在 Mini 自身逻辑里。

hook 更适合做项目特定规则。

## TaskCompleted Hook

后台任务完成后触发。

```ts
// src/hooks/taskHookBridge.ts
import type { EffectiveSettings } from "../config/configTypes";
import { executeHooks } from "./hookExecutor";

export async function runTaskCompletedHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  taskId: string;
  taskTitle: string;
  status: "completed" | "failed" | "cancelled";
}): Promise<HookBatchResult> {
  return executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "TaskCompleted",
      sessionId: input.sessionId,
      cwd: input.cwd,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      status: input.status,
    },
  });
}
```

接到第 29 章后台任务完成通知：

```ts
await runTaskCompletedHooks({
  settings,
  cwd,
  sessionId,
  taskId: task.id,
  taskTitle: task.title,
  status: task.status,
});
```

如果 hook 阻塞任务完成，可以把任务状态改回 `running` 或 `failed`。

第一版建议只记录错误，不反向改任务状态。

等 hooks 稳定后再允许阻塞任务状态转换。

## VerificationFailed Hook

第 34 章 verifier 返回 fail 时触发。

```ts
// src/hooks/verificationHookBridge.ts
import type { EffectiveSettings } from "../config/configTypes";
import { executeHooks } from "./hookExecutor";

export async function runVerificationFailedHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  runId: string;
  targetId: string;
  report: string;
}): Promise<HookBatchResult> {
  return executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "VerificationFailed",
      sessionId: input.sessionId,
      cwd: input.cwd,
      runId: input.runId,
      targetId: input.targetId,
      report: input.report,
    },
  });
}
```

接到 `verifyTool`：

```ts
if (verdict === "fail") {
  await runVerificationFailedHooks({
    settings,
    cwd: input.cwd,
    sessionId,
    runId: completedRun.id,
    targetId: args.target.id,
    report,
  });
}
```

这个 hook 很适合：

- 写入 `.mini/verification-failures.log`。
- 发本地通知。
- 自动创建一个 repair 任务。
- 把失败报告同步到团队系统。

第一版不要让它自动改代码。

它应该只通知、记录、排队。

## Notification Hook

Notification hook 是一个通用出口。

```ts
// src/hooks/sessionHookBridge.ts
export async function runNotificationHooks(input: {
  settings: EffectiveSettings;
  cwd: string;
  sessionId: string;
  notificationType: string;
  title?: string;
  message: string;
}): Promise<void> {
  await executeHooks({
    settings: input.settings,
    cwd: input.cwd,
    hookInput: {
      hookEventName: "Notification",
      sessionId: input.sessionId,
      cwd: input.cwd,
      notificationType: input.notificationType,
      title: input.title,
      message: input.message,
    },
  });
}
```

例如后台任务完成：

```ts
await runNotificationHooks({
  settings,
  cwd,
  sessionId,
  notificationType: "task_completed",
  title: "Mini task completed",
  message: `${task.title} finished with ${task.status}`,
});
```

然后用户可以配置：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "Notification": [
        {
          "matcher": "task_completed|verification_failed",
          "hooks": [
            {
              "type": "command",
              "command": "bun scripts/hooks/notify.ts"
            }
          ]
        }
      ]
    }
  }
}
```

## 示例：阻止危险 Bash

创建脚本：

```ts
// scripts/hooks/block-dangerous-bash.ts
type HookInput = {
  hookEventName: "PreToolUse";
  toolName: string;
  toolInput: {
    command?: string;
  };
};

const input = (await Bun.stdin.json()) as HookInput;
const command = input.toolInput.command ?? "";

const blocked = [
  "git push",
  "rm -rf",
  "chmod -R 777",
].some(pattern => command.includes(pattern));

if (blocked) {
  console.log(
    JSON.stringify({
      decision: "block",
      reason: `Blocked dangerous command: ${command}`,
    }),
  );
}
```

配置：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "bash",
          "hooks": [
            {
              "type": "command",
              "command": "bun scripts/hooks/block-dangerous-bash.ts"
            }
          ]
        }
      ]
    }
  }
}
```

现在模型尝试执行：

```bash
git push origin main
```

会被 hook 拦住。

## 示例：工具失败后追加上下文

脚本：

```ts
// scripts/hooks/post-tool-failure-context.ts
type HookInput = {
  hookEventName: "PostToolUseFailure";
  toolName: string;
  error: string;
};

const input = (await Bun.stdin.json()) as HookInput;

if (input.toolName === "bash" && input.error.includes("tsc")) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext:
          "Typecheck failed. Prefer fixing the first TypeScript error before rerunning all checks.",
      },
    }),
  );
}
```

配置：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PostToolUseFailure": [
        {
          "matcher": "bash",
          "hooks": [
            {
              "type": "command",
              "command": "bun scripts/hooks/post-tool-failure-context.ts"
            }
          ]
        }
      ]
    }
  }
}
```

这类 hook 不应该阻塞工具。

它只是给模型下一步修复提供更好的提示。

## 示例：验证失败写日志

```ts
// scripts/hooks/on-verification-failed.ts
import { appendFile } from "node:fs/promises";

type HookInput = {
  hookEventName: "VerificationFailed";
  runId: string;
  targetId: string;
  report: string;
};

const input = (await Bun.stdin.json()) as HookInput;

await appendFile(
  ".mini/verification-failures.log",
  [
    `run: ${input.runId}`,
    `target: ${input.targetId}`,
    input.report,
    "",
  ].join("\n"),
  "utf8",
);
```

配置：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "VerificationFailed": [
        {
          "matcher": "*",
          "hooks": [
            {
              "type": "command",
              "command": "bun scripts/hooks/on-verification-failed.ts"
            }
          ]
        }
      ]
    }
  }
}
```

注意：

```text
这个 hook 写的是项目内日志文件。
它是用户显式配置的脚本，不是 verifier 自己改代码。
```

## Trust Gate

hooks 最大的风险是：

```text
项目配置可以执行任意命令。
```

所以项目 hooks 必须有信任门槛。

第一版可以用 local settings 明确确认：

```json
{
  "hooks": {
    "enabled": true,
    "requireTrust": true
  },
  "security": {
    "trustedProject": true
  }
}
```

类型里补上：

```ts
// src/config/configTypes.ts
export type MiniSettings = {
  // ...
  security?: {
    trustedProject?: boolean;
  };
};
```

默认值：

```ts
security: {
  trustedProject: false,
}
```

执行前检查：

```ts
// src/hooks/hookExecutor.ts
function canRunHooks(settings: EffectiveSettings): boolean {
  if (!settings.hooks.enabled) {
    return false;
  }

  if (settings.hooks.requireTrust && !settings.security.trustedProject) {
    return false;
  }

  return true;
}
```

然后 `getMatchingHooks` 开头改成：

```ts
if (!canRunHooks(input.settings)) {
  return [];
}
```

为什么 trust 要放在 local settings？

因为信任是这台机器上的用户选择，不应该由项目仓库替用户决定。

真实工程有更完整的 trust dialog。Mini 先用 local settings 做最小版本。

## Once Hook

`once` 表示执行一次后移除。

真实工程支持 `once`，Mini 第一版可以先不实现移除逻辑。

但如果要做，建议只支持 local / session hooks，不要自动改 project settings。

原因：

```text
project settings 是团队共享文件。
hook 执行一次就自动改仓库配置，会制造难追踪的 diff。
```

本章保留字段，不实现移除。

## Async Hook

`async` 表示 hook 不阻塞主流程。

第一版也可以先不实现。

等后台任务系统和 Hook 记录表更完善后，再实现：

```text
async hook -> 创建后台 hook task -> 写入 .mini/hook-runs/
```

为什么不急着做？

因为 async hook 有两个难点：

- 主流程已经继续，hook 失败时怎么提醒模型。
- 用户怎么查看 hook stdout/stderr。

真实工程有 pending async hook registry 和 task notification。Mini 后面再补更稳。

## HTTP Hook 的安全边界

真实工程支持 HTTP hook，但它不是简单 `fetch(url)`。

它做了几件安全事：

- URL allowlist。
- header 里的环境变量必须显式声明 `allowedEnvVars`。
- 防 CRLF header 注入。
- SSRF guard，阻止访问内网和 metadata 地址。
- sandbox 开启时通过网络代理走 allowlist。

Mini 第一版不实现 HTTP hook。

如果后面要做，最低要求是：

```text
没有 allowedHttpHookUrls 时禁止 HTTP hook。
不能让项目配置任意 POST 到外部地址。
不能把环境变量全部注入 header。
不能允许访问云 metadata IP。
```

command hook 已经能覆盖本地团队流程，不需要急着开放网络。

## 测试 Matcher

```ts
// src/hooks/__tests__/hookMatcher.test.ts
import { describe, expect, test } from "bun:test";
import { matchesHookPattern } from "../hookMatcher";

describe("matchesHookPattern", () => {
  test("matches empty matcher", () => {
    expect(matchesHookPattern({ value: "bash" })).toBe(true);
  });

  test("matches wildcard", () => {
    expect(matchesHookPattern({ value: "bash", matcher: "*" })).toBe(true);
  });

  test("matches exact value", () => {
    expect(matchesHookPattern({ value: "bash", matcher: "bash" })).toBe(true);
    expect(matchesHookPattern({ value: "read", matcher: "bash" })).toBe(false);
  });

  test("matches pipe-separated values", () => {
    expect(matchesHookPattern({ value: "read", matcher: "read|write" })).toBe(true);
  });

  test("matches regex", () => {
    expect(matchesHookPattern({ value: "file_write", matcher: "^file_" })).toBe(true);
  });
});
```

运行：

```bash
bun test src/hooks/__tests__/hookMatcher.test.ts
```

## 测试 Output 解析

```ts
// src/hooks/__tests__/hookOutput.test.ts
import { describe, expect, test } from "bun:test";
import { parseHookOutput } from "../hookOutput";

describe("parseHookOutput", () => {
  test("parses plain text", () => {
    expect(parseHookOutput("hello").type).toBe("text");
  });

  test("parses JSON", () => {
    const output = parseHookOutput(
      JSON.stringify({
        decision: "block",
        reason: "no",
      }),
    );

    expect(output.type).toBe("json");
    if (output.type === "json") {
      expect(output.value.decision).toBe("block");
    }
  });
});
```

运行：

```bash
bun test src/hooks/__tests__/hookOutput.test.ts
```

## 测试 Command Hook

```ts
// src/hooks/__tests__/commandHookRunner.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runCommandHook } from "../commandHookRunner";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("runCommandHook", () => {
  test("passes hook input through stdin", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mini-hook-"));

    const result = await runCommandHook({
      cwd: tempDir,
      hook: {
        type: "command",
        command:
          "bun -e \"const input = await Bun.stdin.json(); console.log(input.hookEventName)\"",
      },
      hookInput: {
        hookEventName: "SessionStart",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("SessionStart");
  });

  test("captures blocking exit code", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mini-hook-"));

    const result = await runCommandHook({
      cwd: tempDir,
      hook: {
        type: "command",
        command: "bun -e \"console.error('blocked'); process.exit(2)\"",
      },
      hookInput: {
        hookEventName: "PreToolUse",
      },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("blocked");
  });
});
```

运行：

```bash
bun test src/hooks/__tests__/commandHookRunner.test.ts
```

## 测试 Executor

```ts
// src/hooks/__tests__/hookExecutor.test.ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../config/configDefaults";
import { executeHooks } from "../hookExecutor";

describe("executeHooks", () => {
  test("blocks when hook returns decision block", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      security: {
        trustedProject: true,
      },
      hooks: {
        enabled: true,
        requireTrust: true,
        events: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [
                {
                  type: "command" as const,
                  command:
                    "bun -e \"console.log(JSON.stringify({ decision: 'block', reason: 'no bash' }))\"",
                },
              ],
            },
          ],
        },
      },
    };

    const result = await executeHooks({
      settings,
      cwd: process.cwd(),
      hookInput: {
        hookEventName: "PreToolUse",
        sessionId: "s1",
        cwd: process.cwd(),
        toolName: "bash",
        toolInput: {
          command: "echo hi",
        },
        toolUseId: "t1",
      },
    });

    expect(result.blockingError).toBe("no bash");
  });
});
```

运行：

```bash
bun test src/hooks/__tests__/hookExecutor.test.ts
```

## 手工验证

创建 hook 脚本：

```bash
mkdir -p scripts/hooks
```

```ts
// scripts/hooks/log-pre-tool.ts
import { appendFile } from "node:fs/promises";

const input = await Bun.stdin.text();

await appendFile(".mini/hook.log", `${input}\n`, "utf8");
```

配置 `.mini/settings.local.json`：

```json
{
  "security": {
    "trustedProject": true
  },
  "hooks": {
    "enabled": true,
    "requireTrust": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "*",
          "hooks": [
            {
              "type": "command",
              "command": "bun scripts/hooks/log-pre-tool.ts"
            }
          ]
        }
      ]
    }
  }
}
```

然后让 Mini 执行任意工具。

预期生成：

```text
.mini/hook.log
```

里面能看到每次工具调用前的 JSON input。

再改成阻塞脚本：

```ts
// scripts/hooks/block-bash.ts
type HookInput = {
  toolName: string;
};

const input = (await Bun.stdin.json()) as HookInput;

if (input.toolName === "bash") {
  console.log(
    JSON.stringify({
      decision: "block",
      reason: "bash is disabled by local hook",
    }),
  );
}
```

配置 matcher 为 `bash` 后，再尝试执行 bash 工具，应该被拦截。

## 常见坑

### 1. 不做 trust gate

项目 hooks 可以执行任意命令。

没有 trust gate 就等于 clone 一个仓库后自动执行仓库里的脚本。

这很危险。

### 2. Hook allow 绕过 deny 规则

不要让 hook 的 `allow` 覆盖 settings 里的 `deny`。

正确顺序是：

```text
hook deny 立即拦截。
hook allow 只是减少询问。
settings deny 仍然最高优先级。
```

### 3. Post hook 失败导致主工具失败

Post hook 常用于日志、通知、补充上下文。

它失败默认不应该让主工具失败。

否则一个通知脚本坏了，会阻止代码修改。

### 4. 把 secret 写进 hook 配置

hook 配置里不要写 token。

如果脚本需要密钥，让脚本从环境变量读取。

配置文件只写脚本路径和非敏感参数。

### 5. 不限制 HTTP hook

HTTP hook 必须做 allowlist 和 SSRF 防护。

第一版不做 HTTP hook 是有意的。

不要为了“方便”直接开放任意 URL。

### 6. Stop hook 无限循环

Stop hook 如果阻止本轮结束，模型会继续工作。

要避免 hook 每次都返回同一个阻塞原因，导致无法收尾。

可以在 hook input 里加 `stopHookActive` 或在脚本里检查是否已经处理过。

Mini 第一版可以先要求 Stop hook 只用于明确、可修复的门禁。

### 7. Hook stdout 太大

hook 输出会进入 Mini 的上下文或日志。

不要把整份测试日志都输出到 stdout。

脚本应该输出摘要，完整日志写文件。

## 本章小结

本章给 Mini 加上了项目级 Hooks 与事件系统：

- hooks 配置 schema。
- command hook 类型。
- hook input / output 协议。
- matcher 匹配。
- command hook 执行器。
- hook 批处理聚合。
- PreToolUse / PostToolUse / PostToolUseFailure。
- UserPromptSubmit / SessionStart / SessionEnd / Stop。
- TaskCompleted / VerificationFailed / Notification。
- trust gate。
- hooks 测试和手工验证方式。

Mini 现在可以被项目配置主动扩展，不再只能靠内置逻辑适配团队流程。

下一章可以继续做 **插件系统与能力分发**：把 commands、hooks、agents、skills 统一打包成可安装插件，让 Mini 支持团队共享能力包。
