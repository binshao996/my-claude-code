# 第 46 章：Session Memory 与长期记忆压缩

第 45 章已经把上下文压缩升级成了一个完整的边界系统：

- 历史消息先被投影成可压缩输入。
- 压缩结果会写入 `CompactBoundary`。
- 最近一段消息会作为 preserved segment 保留下来。
- hook、工具发现结果、计划状态会在压缩后重新注入。

但第 45 章还留下一个重要缺口：每次自动压缩仍然需要调用摘要模型。

这在长会话里会带来三个问题：

1. 压缩本身消耗一次模型调用。
2. 压缩发生在上下文最紧张的时候，失败成本高。
3. 摘要只在 compact 时临时生成，平时没有持续维护的结构化会话状态。

官方 Claude Code 的高级方向不是只把 `/compact` 做得更聪明，而是让会话运行过程中持续维护一份 **Session Memory**。

它是一份和当前 session 绑定的 Markdown 记忆文件，后台异步更新。当上下文接近上限时，compact 可以直接使用这份已经提取好的记忆作为摘要，不必再临时调用摘要模型。

本章会为 Mini 实现这个能力。

## 本章目标

完成本章后，Mini 会拥有：

1. 一个会话级 `summary.md` 文件。
2. 一套固定的 Session Memory 模板。
3. 一个后台提取器，在安全时机异步更新记忆。
4. 一个手动 `/summary` 命令，强制刷新并展示当前会话摘要。
5. 一个 Session Memory Compact 路径，优先用记忆完成压缩。
6. 一组 fallback 规则，保证记忆不可用时退回传统摘要压缩。
7. 一组测试，覆盖提取阈值、权限限制、保留窗口和 compact 不变量。

这章的重点不是“把所有内容都记住”，而是建立一个可控、可解释、可恢复的长会话状态层。

## 与第 17 章 Memory 的区别

第 17 章实现的是项目和用户 Memory，通常来自 `CLAUDE.md` 这类文件。

Session Memory 不是同一种东西。

| 类型 | 生命周期 | 来源 | 写入者 | 注入位置 | 典型内容 |
| --- | --- | --- | --- | --- | --- |
| User Memory | 跨项目长期存在 | 用户配置目录 | 用户 | system context | 用户偏好 |
| Project Memory | 跟随仓库存在 | 仓库文件 | 用户或团队 | system context | 项目约定 |
| Local Memory | 当前机器存在 | 本地文件 | 用户 | system context | 本机调试偏好 |
| Session Memory | 当前会话存在 | 会话历史提取 | 后台提取器 | compact summary | 当前任务状态 |

Session Memory 只解决一个问题：长会话恢复连续性。

它不应该替代 `CLAUDE.md`。

它也不应该把所有工具输出完整复制一遍。

它保存的是：

- 用户当前要完成的任务。
- 已经做出的设计决策。
- 正在修改或已经验证过的文件。
- 运行过的关键命令和结论。
- 遇到过的错误以及修正方式。
- 用户明确纠正过的偏好。
- 当前还没完成的下一步。

它不保存：

- token、key、password、cookie 等敏感值。
- 大段日志。
- 大段源码。
- 可以通过读取文件重新获得的完整实现。
- 对项目事实的无依据猜测。

一个简单判断是：如果压缩后新一轮模型要继续工作，这条信息是否能显著减少重复探索？

如果答案是“能”，它才适合进入 Session Memory。

## 对齐真实实现

当前仓库里真实实现的核心文件是：

```txt
src/services/SessionMemory/sessionMemory.ts
src/services/SessionMemory/sessionMemoryUtils.ts
src/services/SessionMemory/prompts.ts
src/services/compact/sessionMemoryCompact.ts
src/commands/summary/index.ts
```

几个关键设计值得直接学习：

1. 提取发生在 `postSamplingHook`，不阻塞主回答。
2. 提取只在主 REPL thread 上运行，跳过 subagent 和其他 query source。
3. Poor mode 下跳过，避免额外 token 消耗。
4. 初始化和更新都有 token 阈值，避免频繁提取。
5. 最近一轮 assistant 如果还有 tool call，不直接把它标记为已总结，避免切断 tool_use/tool_result 对。
6. 真实提取通过 forked agent 执行，并且只允许编辑 session memory 文件。
7. `/summary` 可以绕过阈值手动触发提取。
8. `/compact` 和 auto-compact 会优先尝试 Session Memory Compact。
9. 如果 session memory 不存在、仍是空模板、边界不可确定或压缩后仍超阈值，就退回传统 compact。

Mini 不需要一开始就接入远程 feature gate，但应该保留同样的结构。

## 最终效果

用户和 Mini 对话很久之后，当前 session 目录下会出现：

```txt
~/.ccmini/projects/<sanitized-cwd>/<session-id>/session-memory/summary.md
```

内容类似：

```md
# Session Title
Implement official-like Session Memory compact

# Current State
- Writing chapter 46 in courses/46-session-memory-long-term-compaction/README.md.
- Need verify Bun-only commands, closed code fences, and typecheck.

# Task specification
- User wants the tutorial series to approach official Claude Code.
- Chapter 46 should continue after compact boundary and cover Session Memory.

# Files and Functions
- courses/45-context-compaction-compact-boundary/README.md: previous chapter.
- src/services/compact/sessionMemoryCompact.ts: reference behavior for real implementation.

# Workflow
- Use rg for search.
- Use bun run typecheck after writing.

# Errors & Corrections
- User explicitly prefers Bun commands.

# Worklog
- Read chapter 45 ending.
- Inspected real SessionMemory and compact implementation.
```

当自动压缩触发时，Mini 优先把这份内容变成 compact summary：

```txt
old history
  |
  |-- already represented by summary.md
  v
CompactBoundary(auto)
UserMessage(isCompactSummary=true, content=summary.md)
recent preserved messages
```

如果 Session Memory 不可用，Mini 再走第 45 章的传统摘要 compact。

## 项目结构变化

本章新增：

```txt
src/
  sessionMemory/
    types.ts
    paths.ts
    template.ts
    prompt.ts
    policy.ts
    store.ts
    thresholds.ts
    extract.ts
    hook.ts
    summaryCommand.ts
    compact.ts
    index.ts
tests/
  sessionMemory/
    thresholds.test.ts
    policy.test.ts
    compact.test.ts
    store.test.ts
```

修改：

```txt
src/chat/chatLoop.ts
src/chat/commands.ts
src/context/compact.ts
```

如果你的 Mini 项目文件名不同，按职责接入即可：

- “每轮模型完成后”的位置注册后台提取 hook。
- “slash command 分发”的位置注册 `/summary`。
- “自动 compact 或手动 compact”的位置优先调用 `trySessionMemoryCompaction()`。

这里如果已经把 slash command 抽到 `src/chat/commands.ts`，继续保留前面章节的 built-in command：

```txt
/plan
/plan show
/plan clear
/plan exit
```

不要把 `/plan` 退回成“查看计划”。`/plan` 仍然进入 plan mode，`/plan show` 才只读展示当前计划。

## 架构总览

Session Memory 的核心链路如下：

```txt
assistant turn completed
  |
  v
post sampling hook
  |
  |-- query source is main thread?
  |-- auto compact enabled?
  |-- enough tokens since init/update?
  |-- safe turn boundary?
  |
  v
background extraction job
  |
  |-- ensure summary.md exists
  |-- read current summary.md
  |-- ask forked agent to update it
  |-- allow only Edit(summary.md)
  |-- record last summarized message id
  |
  v
later compact trigger
  |
  |-- wait briefly if extraction in progress
  |-- load summary.md
  |-- reject if empty template
  |-- calculate recent preserved window
  |-- create compact boundary
  |-- build post compact messages
```

注意这里有两个完全不同的时机：

1. 提取时机：模型回答结束后，后台异步维护记忆。
2. 压缩时机：上下文接近上限时，读取已有记忆并裁剪历史。

这两个时机解耦以后，compact 变得便宜很多。

## 数据模型

Mini 先用 Markdown 作为真实存储格式，但内部仍需要一些状态对象。

### `src/sessionMemory/types.ts`

```ts
import type { ChatMessage } from "../chat/types";

export type SessionMemoryConfig = {
  minimumMessageTokensToInit: number;
  minimumTokensBetweenUpdate: number;
  toolCallsBetweenUpdates: number;
  extractionWaitTimeoutMs: number;
  extractionStaleMs: number;
};

export type SessionMemoryRuntimeState = {
  initialized: boolean;
  tokensAtLastExtraction: number;
  lastExtractedMessageId: string | undefined;
  extractionStartedAt: number | undefined;
  lastExtractionTriggerMessageId: string | undefined;
};

export type SessionMemoryPaths = {
  dir: string;
  summaryPath: string;
};

export type ExtractionContext = {
  messages: ChatMessage[];
  cwd: string;
  sessionId: string;
  querySource: string;
};

export type ExtractionResult = {
  success: boolean;
  summaryPath?: string;
  error?: string;
};

export type SessionMemoryCompactResult = {
  boundary: ChatMessage;
  summaryMessages: ChatMessage[];
  messagesToKeep: ChatMessage[];
  preCompactTokens: number;
  postCompactTokens: number;
};
```

本章仍然把 message 类型写成 `ChatMessage`，它对应前面章节里 Mini 的内部消息结构。如果你的项目已经有 `Message` 类型，直接替换即可。

## 路径设计

Session Memory 必须跟 session 绑定。

不能把它放在仓库根目录，也不能跟项目 Memory 混在一起。

推荐路径：

```txt
~/.ccmini/projects/<sanitized-cwd>/<session-id>/session-memory/summary.md
```

这样有几个好处：

- 不污染工作区。
- 不会被提交。
- 同一个项目的不同会话互不覆盖。
- session 恢复时可以直接找到对应 summary。
- 权限策略可以把这个目录标记为内部可读写路径。

### `src/sessionMemory/paths.ts`

```ts
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMemoryPaths } from "./types";

function getMiniHome(): string {
  return process.env.CCMINI_HOME ?? join(homedir(), ".ccmini");
}

function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function getProjectSessionDir(cwd: string, sessionId: string): string {
  return join(getMiniHome(), "projects", sanitizeCwd(cwd), sessionId);
}

export function getSessionMemoryPaths(
  cwd: string,
  sessionId: string,
): SessionMemoryPaths {
  const dir = join(getProjectSessionDir(cwd, sessionId), "session-memory");
  return {
    dir,
    summaryPath: join(dir, "summary.md"),
  };
}

export async function ensureSessionMemoryDir(paths: SessionMemoryPaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
}
```

这里的 `summary.md` 权限建议是 `0600`，目录权限建议是 `0700`。

即使 Mini 是个人工具，也不要把 session 记忆做成宽权限文件。

## 模板设计

Session Memory 模板要稳定。

因为后台提取器会反复编辑这个文件，如果模板结构频繁变化，会带来三个问题：

1. 老 summary 难以迁移。
2. 提取器可能误删标题。
3. compact 时无法按 section 截断。

本章使用固定 section：

### `src/sessionMemory/template.ts`

```ts
export const SESSION_MEMORY_TEMPLATE = `# Session Title
_A short 5-10 word title for this session._

# Current State
_What is actively being worked on right now? Immediate next steps._

# Task Specification
_What did the user ask to build, fix, explain, or verify?_

# Files and Functions
_Important files, functions, modules, and why they matter._

# Workflow
_Commands to run and how to interpret their output._

# Errors and Corrections
_Errors encountered, user corrections, and approaches to avoid._

# Decisions
_Design decisions made during the conversation._

# Key Results
_Exact user-visible answers, tables, or final outputs that must be preserved._

# Worklog
_Terse chronological summary of what was attempted or completed._
`;

export function isTemplateOnly(content: string): boolean {
  return content.trim() === SESSION_MEMORY_TEMPLATE.trim();
}
```

真实实现还支持用户自定义模板和 prompt：

```txt
~/.claude/session-memory/config/template.md
~/.claude/session-memory/config/prompt.md
```

Mini 可以先不做配置文件，但要把模板集中在一个模块里，方便后续扩展。

## 更新 Prompt

提取器的 prompt 要明确告诉模型：

- 这条消息不是用户对话。
- 不要把“记笔记”这件事写进记忆。
- 必须保留所有 section header。
- 必须保留每个 section 的说明行。
- 只能更新说明行下面的实际内容。
- 不要添加新 section。
- 不要保存敏感值。
- 不要复制大段日志或源码。
- `Current State` 必须反映最新进度。

### `src/sessionMemory/prompt.ts`

```ts
const MAX_SECTION_TOKENS = 2_000;
const MAX_TOTAL_TOKENS = 12_000;

export function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

type SectionSize = {
  title: string;
  tokens: number;
};

function analyzeSections(content: string): SectionSize[] {
  const result: SectionSize[] = [];
  const lines = content.split("\n");
  let title = "";
  let buffer: string[] = [];

  function flush(): void {
    if (!title) return;
    result.push({
      title,
      tokens: roughTokenCount(buffer.join("\n").trim()),
    });
  }

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      title = line;
      buffer = [];
    } else {
      buffer.push(line);
    }
  }

  flush();
  return result;
}

function buildBudgetReminder(currentMemory: string): string {
  const totalTokens = roughTokenCount(currentMemory);
  const oversized = analyzeSections(currentMemory).filter(
    section => section.tokens > MAX_SECTION_TOKENS,
  );

  const lines: string[] = [];

  if (totalTokens > MAX_TOTAL_TOKENS) {
    lines.push(
      `The full session memory is around ${totalTokens} tokens. Condense it below ${MAX_TOTAL_TOKENS} tokens.`,
    );
  }

  for (const section of oversized) {
    lines.push(
      `${section.title} is around ${section.tokens} tokens. Condense that section while preserving critical facts.`,
    );
  }

  return lines.length === 0 ? "" : `\n\nBudget reminders:\n${lines.join("\n")}`;
}

export function buildSessionMemoryUpdatePrompt(input: {
  currentMemory: string;
  summaryPath: string;
}): string {
  const budgetReminder = buildBudgetReminder(input.currentMemory);

  return `IMPORTANT: This instruction is not part of the user conversation.

Based only on the actual conversation above, update the session memory file.

The file has already been read for you:
${input.summaryPath}

Current file contents:
<current_session_memory>
${input.currentMemory}
</current_session_memory>

Your only task:
- Use the Edit tool to update ${input.summaryPath}.
- Do not call any other tool.
- Preserve every section header exactly.
- Preserve every italic section instruction line exactly.
- Only edit the real content below each instruction line.
- Do not add new sections.
- Do not mention note-taking, extraction, prompts, or this instruction.
- Do not store secrets, tokens, passwords, cookies, or private credentials.
- Do not paste long logs or large source blocks.
- Keep content dense, concrete, and actionable.
- Always update Current State to the latest state.

Stop after editing the file.${budgetReminder}`;
}
```

真实实现里还有一个重要细节：变量替换要做单次替换。

原因是用户内容里可能恰好包含 `{{currentNotes}}` 这样的文本。如果做多轮替换，就可能把用户内容再次当成模板变量展开。

Mini 当前没有自定义 prompt 文件，可以先跳过。但未来支持配置时要注意这个点。

## 存储层

存储层只负责：

- 确保文件存在。
- 读取当前 memory。
- 判断是否为空模板。
- 原子写入测试辅助内容。
- 按 section 截断 compact 输入。

### `src/sessionMemory/store.ts`

```ts
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureSessionMemoryDir, getSessionMemoryPaths } from "./paths";
import { SESSION_MEMORY_TEMPLATE, isTemplateOnly } from "./template";
import type { SessionMemoryPaths } from "./types";

export async function setupSessionMemoryFile(
  cwd: string,
  sessionId: string,
): Promise<SessionMemoryPaths> {
  const paths = getSessionMemoryPaths(cwd, sessionId);
  await ensureSessionMemoryDir(paths);

  try {
    await writeFile(paths.summaryPath, SESSION_MEMORY_TEMPLATE, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  return paths;
}

export async function readSessionMemory(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function hasUsefulSessionMemory(content: string | null): content is string {
  if (!content) return false;
  if (content.trim().length === 0) return false;
  return !isTemplateOnly(content);
}

export async function writeSessionMemoryForTest(
  path: string,
  content: string,
): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, path);
}

export function getSessionMemoryDirFromSummaryPath(path: string): string {
  return dirname(path);
}
```

`setupSessionMemoryFile()` 使用 `flag: "wx"`。

这表示只在文件不存在时创建，避免覆盖已有 summary。

## 敏感信息策略

Session Memory 是自动写入的，所以必须比 `/remember` 更保守。

本章用一个轻量策略：

- 提取 prompt 明确禁止保存敏感值。
- 在写入前检查明显敏感模式。
- 如果疑似包含敏感信息，拒绝保存并记录错误。

Mini 如果没有专门的写入拦截器，可以先把检查放在测试辅助函数和提取完成后的读取校验里。

### `src/sessionMemory/policy.ts`

```ts
const SECRET_PATTERNS: RegExp[] = [
  /\bapi[_-]?key\b/i,
  /\baccess[_-]?token\b/i,
  /\bauth[_-]?token\b/i,
  /\bpassword\b/i,
  /\bcookie\b/i,
  /\bsecret\b/i,
  /\bsk-[a-zA-Z0-9_-]{12,}\b/,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
];

export function containsLikelySecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

export function assertSessionMemorySafe(text: string): void {
  if (containsLikelySecret(text)) {
    throw new Error("Session memory appears to contain a secret-like value.");
  }
}
```

不要试图让正则覆盖所有秘密格式。

它只是最后一道防线。

真正的防线是：提取器只记录“用户配置了 DeepSeek key”，而不是记录 key 的实际值。

## 提取阈值

后台提取不能每轮都跑。

它至少要满足两个目标：

1. 不影响主对话延迟。
2. 不因为频繁提取消耗太多 token。

默认配置：

```ts
export const DEFAULT_SESSION_MEMORY_CONFIG = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
  extractionWaitTimeoutMs: 15_000,
  extractionStaleMs: 60_000,
} as const;
```

真实实现也使用类似的思路：

- 首次达到约 10k tokens 后才初始化。
- 每次提取后记录当时上下文 token 数。
- 下次至少增长约 5k tokens 才考虑更新。
- 工具调用达到一定数量后更倾向更新。
- 如果最后一轮没有 tool call，也可以在自然语言停顿处更新。

### `src/sessionMemory/thresholds.ts`

```ts
import type { ChatMessage } from "../chat/types";
import type { SessionMemoryConfig, SessionMemoryRuntimeState } from "./types";

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
  extractionWaitTimeoutMs: 15_000,
  extractionStaleMs: 60_000,
};

export function createSessionMemoryState(): SessionMemoryRuntimeState {
  return {
    initialized: false,
    tokensAtLastExtraction: 0,
    lastExtractedMessageId: undefined,
    extractionStartedAt: undefined,
    lastExtractionTriggerMessageId: undefined,
  };
}

function countToolCallsSince(
  messages: ChatMessage[],
  sinceId: string | undefined,
): number {
  let found = sinceId === undefined;
  let count = 0;

  for (const message of messages) {
    if (!found) {
      if (message.id === sinceId) found = true;
      continue;
    }

    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "tool_use") count++;
    }
  }

  return count;
}

export function hasToolCallsInLastAssistantTurn(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    return message.content.some(part => part.type === "tool_use");
  }
  return false;
}

export function shouldExtractSessionMemory(input: {
  messages: ChatMessage[];
  currentTokens: number;
  state: SessionMemoryRuntimeState;
  config?: SessionMemoryConfig;
}): boolean {
  const config = input.config ?? DEFAULT_SESSION_MEMORY_CONFIG;
  const { state, currentTokens, messages } = input;

  if (!state.initialized) {
    if (currentTokens < config.minimumMessageTokensToInit) {
      return false;
    }
    state.initialized = true;
  }

  const tokenGrowth = currentTokens - state.tokensAtLastExtraction;
  if (tokenGrowth < config.minimumTokensBetweenUpdate) {
    return false;
  }

  const toolCalls = countToolCallsSince(
    messages,
    state.lastExtractionTriggerMessageId,
  );
  const enoughTools = toolCalls >= config.toolCallsBetweenUpdates;
  const naturalPause = !hasToolCallsInLastAssistantTurn(messages);

  if (!enoughTools && !naturalPause) {
    return false;
  }

  state.lastExtractionTriggerMessageId = messages.at(-1)?.id;
  return true;
}
```

这里有一个细节：`shouldExtractSessionMemory()` 会修改 state。

如果你更喜欢纯函数，也可以返回 `{ shouldExtract, nextState }`。

Mini 教程里这样写是为了更接近真实 runtime 的模块级状态。

## 提取执行器

真实实现使用 forked agent。

Mini 可以先实现一个 `runExtractionAgent()` 抽象，底层仍然调用你现有的模型客户端。

关键不是 agent 名字，而是这几个隔离条件：

- prompt 使用当前对话作为上下文。
- 提取器不能修改主会话消息数组。
- 提取器不能污染主工具缓存。
- 提取器只能编辑 `summary.md`。
- 提取器失败不能中断用户当前对话。

### `src/sessionMemory/extract.ts`

```ts
import { buildSessionMemoryUpdatePrompt } from "./prompt";
import { assertSessionMemorySafe } from "./policy";
import { readSessionMemory, setupSessionMemoryFile } from "./store";
import type {
  ExtractionContext,
  ExtractionResult,
  SessionMemoryRuntimeState,
} from "./types";
import { hasToolCallsInLastAssistantTurn } from "./thresholds";

type ExtractionAgent = {
  updateSessionMemory(input: {
    messages: ExtractionContext["messages"];
    prompt: string;
    summaryPath: string;
  }): Promise<void>;
};

export async function extractSessionMemory(input: {
  context: ExtractionContext;
  state: SessionMemoryRuntimeState;
  agent: ExtractionAgent;
}): Promise<ExtractionResult> {
  const { context, state, agent } = input;

  state.extractionStartedAt = Date.now();

  try {
    const paths = await setupSessionMemoryFile(context.cwd, context.sessionId);
    const currentMemory = (await readSessionMemory(paths.summaryPath)) ?? "";

    const prompt = buildSessionMemoryUpdatePrompt({
      currentMemory,
      summaryPath: paths.summaryPath,
    });

    await agent.updateSessionMemory({
      messages: context.messages,
      prompt,
      summaryPath: paths.summaryPath,
    });

    const updated = await readSessionMemory(paths.summaryPath);
    if (updated) {
      assertSessionMemorySafe(updated);
    }

    state.tokensAtLastExtraction = estimateConversationTokens(context.messages);

    if (!hasToolCallsInLastAssistantTurn(context.messages)) {
      state.lastExtractedMessageId = context.messages.at(-1)?.id;
    }

    return { success: true, summaryPath: paths.summaryPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    state.extractionStartedAt = undefined;
  }
}

function estimateConversationTokens(messages: ExtractionContext["messages"]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message.content).length;
  }
  return Math.ceil(chars / 4);
}
```

这个版本假设 `agent.updateSessionMemory()` 会真正编辑文件。

如果你的 Mini 还没有 forked agent，可以先用普通模型调用返回新的 Markdown，再由 Mini 自己写入文件。

但要注意：这和官方行为不完全一样。

官方式设计让提取器通过 `Edit` 工具改文件，是为了复用工具权限、diff 和文件状态逻辑。

## 只允许编辑 summary.md

这是本章最重要的安全边界。

Session Memory 提取器是自动运行的，它不应该拥有普通 agent 的全部工具能力。

允许它读写任意文件会很危险：

- 它可能误改用户源码。
- 它可能读取无关私有文件。
- 它可能把提取任务变成二次 agent loop。

Mini 可以用一个简单的 tool policy：

```ts
type ToolDecision =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message: string };

type Tool = {
  name: string;
};

export function createSessionMemoryToolPolicy(summaryPath: string) {
  return async function canUseTool(
    tool: Tool,
    input: unknown,
  ): Promise<ToolDecision> {
    if (
      tool.name === "Edit" &&
      typeof input === "object" &&
      input !== null &&
      "file_path" in input &&
      input.file_path === summaryPath
    ) {
      return { behavior: "allow", updatedInput: input };
    }

    return {
      behavior: "deny",
      message: `session memory extraction may only edit ${summaryPath}`,
    };
  };
}
```

如果你的工具名是 `FileEditTool`，就改成对应名称。

重点是：只允许一个 exact path。

不要用 `startsWith(sessionMemoryDir)` 放宽权限。

因为提取器只需要更新一份 summary。

## 后台 Hook

提取器应该在模型完成一次采样之后运行。

它不应该在用户输入前运行，也不应该在工具结果还没回来的中间状态运行。

### `src/sessionMemory/hook.ts`

```ts
import { extractSessionMemory } from "./extract";
import {
  DEFAULT_SESSION_MEMORY_CONFIG,
  createSessionMemoryState,
  shouldExtractSessionMemory,
} from "./thresholds";
import type { ExtractionContext } from "./types";

type HookContext = ExtractionContext & {
  currentTokens: number;
};

type ExtractionAgent = Parameters<typeof extractSessionMemory>[0]["agent"];

const state = createSessionMemoryState();

export function getSessionMemoryRuntimeState() {
  return state;
}

export async function onPostSampling(input: {
  context: HookContext;
  agent: ExtractionAgent;
  autoCompactEnabled: boolean;
  poorModeEnabled: boolean;
}): Promise<void> {
  if (!input.autoCompactEnabled) return;
  if (input.poorModeEnabled) return;
  if (input.context.querySource !== "repl_main_thread") return;

  const shouldExtract = shouldExtractSessionMemory({
    messages: input.context.messages,
    currentTokens: input.context.currentTokens,
    state,
    config: DEFAULT_SESSION_MEMORY_CONFIG,
  });

  if (!shouldExtract) return;

  void extractSessionMemory({
    context: input.context,
    state,
    agent: input.agent,
  });
}
```

这里用了 `void extractSessionMemory(...)`。

这表示后台执行，不阻塞主 UI。

生产实现里还应该包一层 `sequential()`，确保不会同时跑多个提取任务。

### 顺序化执行

```ts
export function sequential<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  let current = Promise.resolve();

  return (...args: TArgs) => {
    current = current
      .catch(() => undefined)
      .then(() => fn(...args));
    return current;
  };
}
```

真实实现用这个思想避免重入：

```txt
assistant turn A done -> extraction starts
assistant turn B done -> waits behind A
assistant turn C done -> waits behind B
```

如果不顺序化，两个提取器可能同时编辑同一个 summary 文件，后完成的任务覆盖先完成的任务。

## 手动 `/summary`

自动提取有阈值，但用户有时想立刻查看当前会话摘要。

`/summary` 的语义是：

1. 过滤出 API 安全的 user/assistant/system 消息。
2. 绕过阈值强制提取。
3. 读取 `summary.md`。
4. 把内容显示给用户。

### `src/sessionMemory/summaryCommand.ts`

```ts
import { extractSessionMemory } from "./extract";
import { createSessionMemoryState } from "./thresholds";
import { readSessionMemory } from "./store";
import type { ChatMessage } from "../chat/types";

type SummaryCommandContext = {
  messages: ChatMessage[];
  cwd: string;
  sessionId: string;
  agent: Parameters<typeof extractSessionMemory>[0]["agent"];
};

const manualState = createSessionMemoryState();

export async function runSummaryCommand(
  context: SummaryCommandContext,
): Promise<string> {
  const safeMessages = context.messages.filter(message =>
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "system",
  );

  if (safeMessages.length === 0) {
    return "No messages to summarize.";
  }

  const result = await extractSessionMemory({
    context: {
      messages: safeMessages,
      cwd: context.cwd,
      sessionId: context.sessionId,
      querySource: "repl_main_thread",
    },
    state: manualState,
    agent: context.agent,
  });

  if (!result.success || !result.summaryPath) {
    return `Failed to generate session summary: ${result.error ?? "unknown error"}`;
  }

  const content = await readSessionMemory(result.summaryPath);
  if (!content || content.trim().length === 0) {
    return "Session summary was updated, but the content is empty.";
  }

  return `Session summary updated.\n\n${content}`;
}
```

真实实现会复用当前 tool context 和 system prompt cache-safe 参数。

Mini 如果先做简单版，也要保留“过滤 API 安全消息”这一步。

原因是 REPL 内部消息里可能包含 progress、attachment、debug 或 boundary 这类非 API 消息。直接发给模型会导致请求构造失败。

## Compact 集成

现在进入本章核心：用 Session Memory 完成压缩。

传统 compact：

```txt
messages -> compact model -> summary -> boundary + summary + recent messages
```

Session Memory Compact：

```txt
summary.md + recent messages -> boundary + summary + recent messages
```

它不调用摘要模型。

它只是把已有 `summary.md` 包装成 compact summary message。

### `src/sessionMemory/compact.ts`

```ts
import { getSessionMemoryPaths } from "./paths";
import { hasUsefulSessionMemory, readSessionMemory } from "./store";
import type {
  SessionMemoryCompactResult,
  SessionMemoryRuntimeState,
} from "./types";
import type { ChatMessage } from "../chat/types";

type CompactConfig = {
  minTokens: number;
  minTextMessages: number;
  maxTokens: number;
  autoCompactThreshold?: number;
};

export const DEFAULT_SESSION_MEMORY_COMPACT_CONFIG: CompactConfig = {
  minTokens: 10_000,
  minTextMessages: 5,
  maxTokens: 40_000,
};

export async function trySessionMemoryCompaction(input: {
  messages: ChatMessage[];
  cwd: string;
  sessionId: string;
  state: SessionMemoryRuntimeState;
  config?: CompactConfig;
}): Promise<SessionMemoryCompactResult | null> {
  const config = input.config ?? DEFAULT_SESSION_MEMORY_COMPACT_CONFIG;
  await waitForExtractionIfNeeded(input.state);

  const paths = getSessionMemoryPaths(input.cwd, input.sessionId);
  const memory = await readSessionMemory(paths.summaryPath);
  if (!hasUsefulSessionMemory(memory)) {
    return null;
  }

  const lastExtractedId = input.state.lastExtractedMessageId;
  let lastExtractedIndex = -1;

  if (lastExtractedId) {
    lastExtractedIndex = input.messages.findIndex(
      message => message.id === lastExtractedId,
    );
    if (lastExtractedIndex === -1) {
      return null;
    }
  } else {
    lastExtractedIndex = input.messages.length - 1;
  }

  const startIndex = calculateMessagesToKeepIndex({
    messages: input.messages,
    lastExtractedIndex,
    config,
  });

  const messagesToKeep = input.messages
    .slice(startIndex)
    .filter(message => message.type !== "compact_boundary");

  const summary = createCompactSummaryMessage(memory, paths.summaryPath);
  const boundary = createCompactBoundary(input.messages, messagesToKeep, summary);

  const postCompactMessages = [boundary, summary, ...messagesToKeep];
  const postCompactTokens = estimateMessages(postCompactMessages);

  if (
    config.autoCompactThreshold !== undefined &&
    postCompactTokens >= config.autoCompactThreshold
  ) {
    return null;
  }

  return {
    boundary,
    summaryMessages: [summary],
    messagesToKeep,
    preCompactTokens: estimateMessages(input.messages),
    postCompactTokens,
  };
}

async function waitForExtractionIfNeeded(
  state: SessionMemoryRuntimeState,
): Promise<void> {
  const startedAt = state.extractionStartedAt;
  if (!startedAt) return;

  const timeoutAt = Date.now() + 15_000;
  const staleAt = startedAt + 60_000;

  while (state.extractionStartedAt) {
    if (Date.now() > staleAt) return;
    if (Date.now() > timeoutAt) return;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
```

这里故意把 helper 留到下面解释。

先看整体规则：

- compact 前最多等待 15 秒，让正在跑的提取器有机会完成。
- 如果提取器卡住超过 60 秒，视为 stale，不再等待。
- 没有 summary 文件就返回 `null`。
- 文件仍是模板也返回 `null`。
- 找不到 last extracted message 也返回 `null`。
- compact 后仍超过阈值也返回 `null`。

返回 `null` 不代表失败。

它只是告诉调用方：这次不适合用 Session Memory，请走传统 compact。

## 保留最近窗口

Session Memory 只能代表“已经被提取过”的旧历史。

它不能替代最近一段未提取历史。

因此 compact 后必须保留最近窗口。

真实实现的默认思路：

- 从 `lastSummarizedMessageId` 后一条开始保留。
- 如果保留内容太少，就向前扩展。
- 至少保留一定 tokens。
- 至少保留一定数量的 text message。
- 不能超过硬上限太多。
- 不能跨过旧 compact boundary。
- 不能切断 tool_use/tool_result。

### 判断文本消息

```ts
function hasTextContent(message: ChatMessage): boolean {
  return message.content.some(part => {
    if (part.type !== "text") return false;
    return part.text.trim().length > 0;
  });
}
```

### token 估算

```ts
function estimateMessages(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message.content).length;
  }
  return Math.ceil(chars / 4);
}
```

### 计算起点

```ts
function calculateMessagesToKeepIndex(input: {
  messages: ChatMessage[];
  lastExtractedIndex: number;
  config: CompactConfig;
}): number {
  const { messages, lastExtractedIndex, config } = input;

  if (messages.length === 0) return 0;

  let startIndex =
    lastExtractedIndex >= 0 ? lastExtractedIndex + 1 : messages.length;

  let tokens = estimateMessages(messages.slice(startIndex));
  let textMessages = messages.slice(startIndex).filter(hasTextContent).length;

  if (tokens >= config.maxTokens) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex);
  }

  if (tokens >= config.minTokens && textMessages >= config.minTextMessages) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex);
  }

  const lastBoundaryIndex = findLastCompactBoundaryIndex(messages);
  const floor = lastBoundaryIndex === -1 ? 0 : lastBoundaryIndex + 1;

  for (let i = startIndex - 1; i >= floor; i--) {
    const message = messages[i];
    if (!message) continue;

    tokens += estimateMessages([message]);
    if (hasTextContent(message)) textMessages++;
    startIndex = i;

    if (tokens >= config.maxTokens) break;
    if (tokens >= config.minTokens && textMessages >= config.minTextMessages) {
      break;
    }
  }

  return adjustIndexToPreserveAPIInvariants(messages, startIndex);
}

function findLastCompactBoundaryIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === "compact_boundary") return i;
  }
  return -1;
}
```

为什么不能跨过旧 compact boundary？

因为 boundary 前后的消息不是连续原始历史。

旧 boundary 可能已经代表了一段摘要和 preserved segment 链。如果新的 Session Memory Compact 随意向前跨过它，会破坏 loader 通过 boundary 串联恢复 preserved messages 的假设。

简单规则：保留窗口向前扩展时，最多扩展到最后一个 boundary 之后。

## API 不变量

压缩最容易出错的地方不是 summary 内容，而是消息切片。

Anthropic-compatible 请求通常要求：

- `tool_result` 必须能找到对应 `tool_use`。
- 同一个 assistant message id 下的 thinking / redacted_thinking / tool_use / text 片段不能被随意切开。

如果 startIndex 刚好切在中间，会产生无效请求。

### 工具对示例

压缩前：

```txt
10 assistant tool_use id=read_1
11 user      tool_result tool_use_id=read_1
12 assistant text
```

如果保留从 11 开始：

```txt
11 user tool_result tool_use_id=read_1
12 assistant text
```

这会变成孤儿 tool result。

正确做法是把 startIndex 往前调到 10。

### streaming message 示例

有些实现会把同一个 assistant response 的不同 block 拆成多条内部消息：

```txt
20 assistant id=msg_abc thinking / redacted_thinking
21 assistant id=msg_abc tool_use id=edit_1
22 user      tool_result tool_use_id=edit_1
```

如果保留从 21 开始，API normalize 时可能丢失 thinking / redacted_thinking block，或者合并出不完整 message。

正确做法是把 startIndex 往前调到同一个 assistant id 的第一条。

### `adjustIndexToPreserveAPIInvariants`

```ts
function adjustIndexToPreserveAPIInvariants(
  messages: ChatMessage[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex;
  }

  let adjusted = startIndex;

  const toolResultIds = new Set<string>();
  for (let i = adjusted; i < messages.length; i++) {
    for (const part of messages[i]?.content ?? []) {
      if (part.type === "tool_result") {
        toolResultIds.add(part.toolUseId);
      }
    }
  }

  const keptToolUseIds = new Set<string>();
  for (let i = adjusted; i < messages.length; i++) {
    for (const part of messages[i]?.content ?? []) {
      if (part.type === "tool_use") {
        keptToolUseIds.add(part.id);
      }
    }
  }

  for (const id of keptToolUseIds) {
    toolResultIds.delete(id);
  }

  for (let i = adjusted - 1; i >= 0 && toolResultIds.size > 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;

    for (const part of message.content) {
      if (part.type === "tool_use" && toolResultIds.has(part.id)) {
        toolResultIds.delete(part.id);
        adjusted = i;
      }
    }
  }

  const assistantIds = new Set<string>();
  for (let i = adjusted; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === "assistant" && message.providerMessageId) {
      assistantIds.add(message.providerMessageId);
    }
  }

  for (let i = adjusted - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message?.role === "assistant" &&
      message.providerMessageId &&
      assistantIds.has(message.providerMessageId)
    ) {
      adjusted = i;
    }
  }

  return adjusted;
}
```

如果你的 Mini 还没有 `providerMessageId`，可以先只做 tool pair 保护。

但只要你保存了 provider 返回的 message id，就应该加上第二段保护。

## 创建 Summary Message

Session Memory Compact 生成的 summary message 要和传统 compact 兼容。

也就是说，下游不需要知道 summary 是模型刚生成的，还是来自 `summary.md`。

```ts
function truncateSessionMemoryForCompact(content: string): {
  content: string;
  truncated: boolean;
} {
  const maxCharsPerSection = 2_000 * 4;
  const lines = content.split("\n");
  const output: string[] = [];
  let header = "";
  let sectionLines: string[] = [];
  let truncated = false;

  function flush(): void {
    if (!header) {
      output.push(...sectionLines);
      return;
    }

    const section = sectionLines.join("\n");
    output.push(header);

    if (section.length <= maxCharsPerSection) {
      output.push(...sectionLines);
      return;
    }

    let chars = 0;
    for (const line of sectionLines) {
      if (chars + line.length + 1 > maxCharsPerSection) break;
      output.push(line);
      chars += line.length + 1;
    }
    output.push("[... section truncated for length ...]");
    truncated = true;
  }

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      header = line;
      sectionLines = [];
    } else {
      sectionLines.push(line);
    }
  }
  flush();

  return { content: output.join("\n"), truncated };
}

function createCompactSummaryMessage(memory: string, summaryPath: string): ChatMessage {
  const truncated = truncateSessionMemoryForCompact(memory);
  let text = `This conversation was compacted using session memory.

The following session memory summarizes the earlier conversation:

${truncated.content}`;

  if (truncated.truncated) {
    text += `\n\nSome session memory sections were truncated for length. Full file: ${summaryPath}`;
  }

  return {
    id: crypto.randomUUID(),
    role: "user",
    type: "message",
    isCompactSummary: true,
    visibleInTranscriptOnly: true,
    content: [{ type: "text", text }],
  };
}
```

这里把 summary 伪装成 user message，是为了复用前面章节的 compact 表示。

但它有两个特殊标记：

- `isCompactSummary: true`
- `visibleInTranscriptOnly: true`

UI 可以选择不把它当成普通用户输入展示。

## 创建 Boundary

Boundary 仍沿用第 45 章的结构。

```ts
function createCompactBoundary(
  messages: ChatMessage[],
  messagesToKeep: ChatMessage[],
  summary: ChatMessage,
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "system",
    type: "compact_boundary",
    content: [],
    compact: {
      kind: "auto",
      preCompactTokens: estimateMessages(messages),
      lastMessageId: messages.at(-1)?.id,
      summaryMessageId: summary.id,
      preservedMessageIds: messagesToKeep.map(message => message.id),
      createdAt: new Date().toISOString(),
    },
  };
}
```

真实实现还会把压缩前已经发现的额外工具名写入 boundary metadata。

Mini 可以先不做，但结构上要留扩展空间。

## Hook 重新注入

第 45 章讲过：compact 之后不是只保留 summary。

还需要重新注入 session start hooks。

原因是 summary 代表旧对话，不能替代运行时上下文。

压缩后下一轮请求仍需要：

- 当前 `CLAUDE.md`。
- 当前工作目录。
- 当前日期。
- 当前 model override。
- 当前 MCP 或工具说明。
- 当前 plan attachment。

Session Memory Compact 也必须执行同样流程。

调用顺序建议：

```txt
trySessionMemoryCompaction()
  |
  |-- load summary.md
  |-- calculate messagesToKeep
  |-- processSessionStartHooks("compact")
  |-- create boundary
  |-- create compact summary
  |-- attach current plan if needed
```

不要认为 summary.md 已经包含了所有上下文。

Session Memory 是历史摘要，不是运行时配置。

## 接入 `/compact`

手动 `/compact` 的逻辑：

1. 如果用户传了自定义 compact 指令，跳过 Session Memory Compact。
2. 否则先尝试 Session Memory Compact。
3. 成功则返回 compact result。
4. 失败则走传统 compact。

```ts
export async function runCompactCommand(context: CompactCommandContext) {
  const customInstructions = context.args.trim();

  if (!customInstructions) {
    const sessionMemoryResult = await trySessionMemoryCompaction({
      messages: context.messages,
      cwd: context.cwd,
      sessionId: context.sessionId,
      state: context.sessionMemoryState,
    });

    if (sessionMemoryResult) {
      context.sessionMemoryState.lastExtractedMessageId = undefined;
      context.suppressCompactWarning();
      return {
        type: "compact",
        compactionResult: sessionMemoryResult,
      };
    }
  }

  return context.runLegacyCompact(customInstructions);
}
```

为什么有自定义指令时跳过？

因为 Session Memory Compact 不调用摘要模型，无法执行“请重点保留某某内容”这种临时指令。

这种情况必须回到传统 compact。

## 接入自动压缩

自动压缩的逻辑类似，但多一个阈值保护：

```ts
export async function maybeAutoCompact(context: AutoCompactContext) {
  if (!context.shouldCompact()) {
    return { wasCompacted: false };
  }

  const sessionMemoryResult = await trySessionMemoryCompaction({
    messages: context.messages,
    cwd: context.cwd,
    sessionId: context.sessionId,
    state: context.sessionMemoryState,
    config: {
      ...DEFAULT_SESSION_MEMORY_COMPACT_CONFIG,
      autoCompactThreshold: context.autoCompactThreshold,
    },
  });

  if (sessionMemoryResult) {
    context.sessionMemoryState.lastExtractedMessageId = undefined;
    context.runPostCompactCleanup();
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    };
  }

  const legacyResult = await context.runLegacyAutoCompact();
  context.sessionMemoryState.lastExtractedMessageId = undefined;
  context.runPostCompactCleanup();
  return {
    wasCompacted: true,
    compactionResult: legacyResult,
  };
}
```

成功 compact 后要清空 `lastExtractedMessageId`。

原因是消息数组已经被替换，旧 id 不再存在。

如果不清空，下一次 Session Memory Compact 会找不到边界，然后不断 fallback。

## Fallback 矩阵

Session Memory Compact 是优化路径，不是唯一正确路径。

它应该很容易退出。

| 场景 | 处理 |
| --- | --- |
| 功能未启用 | 返回 `null` |
| auto-compact 未启用 | 不注册提取 hook |
| Poor mode | 跳过后台提取 |
| query source 不是主 REPL | 跳过后台提取 |
| token 未达到初始化阈值 | 跳过后台提取 |
| token 增长不足 | 跳过后台提取 |
| 最后一轮仍有 tool call | 不标记 last extracted id |
| 提取正在运行 | compact 最多等待一小段时间 |
| 提取运行过久 | 视为 stale，不等待 |
| summary 文件不存在 | fallback 传统 compact |
| summary 仍是空模板 | fallback 传统 compact |
| last extracted id 找不到 | fallback 传统 compact |
| compact 后仍超过阈值 | fallback 传统 compact |
| 用户传入 custom compact 指令 | fallback 传统 compact |

这张表很重要。

官方感强的实现不是“永远走新路径”，而是“新路径很强，但失败边界清晰”。

## 和恢复会话的关系

恢复会话时可能出现这种状态：

- `summary.md` 已经存在。
- runtime state 里的 `lastExtractedMessageId` 丢失。

真实实现会把这种情况当作 resumed session：

```txt
session memory has content
lastSummarizedMessageId missing
=> use session memory as summary
=> initially keep no messages
=> then expand backwards to min tokens/text messages
```

Mini 也可以这么做。

但要谨慎：

- 如果 summary 文件来自同一个 session，可以使用。
- 如果 session id 变了，不要跨 session 使用。
- 如果无法确认 summary 归属，fallback。

当前路径已经包含 session id，所以只要路径来自当前 session，就可以接受。

## 和 prompt cache 的关系

Session Memory Compact 没有调用 compact API。

这意味着一些“传统 compact 内部顺手做的清理”不会自动发生。

例如：

- compact warning 状态。
- prompt cache break baseline。
- post compact cleanup。
- user context cache。

Mini 如果还没有 prompt cache break 检测，可以先只做：

```ts
context.suppressCompactWarning();
context.runPostCompactCleanup();
```

如果已经实现了 prompt cache 监控，则要在 Session Memory Compact 成功后主动通知：

```ts
context.notifyCompaction("compact");
```

否则系统可能误以为压缩后 cache 突然断裂是异常。

## 测试：阈值

### `tests/sessionMemory/thresholds.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SESSION_MEMORY_CONFIG,
  createSessionMemoryState,
  shouldExtractSessionMemory,
} from "../../src/sessionMemory/thresholds";
import type { ChatMessage } from "../../src/chat/types";

function user(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    type: "message",
    content: [{ type: "text", text }],
  };
}

function assistant(id: string, text: string): ChatMessage {
  return {
    id,
    role: "assistant",
    type: "message",
    content: [{ type: "text", text }],
  };
}

describe("shouldExtractSessionMemory", () => {
  test("does not initialize before token threshold", () => {
    const state = createSessionMemoryState();
    const messages = [user("u1", "hello"), assistant("a1", "hi")];

    expect(
      shouldExtractSessionMemory({
        messages,
        currentTokens: DEFAULT_SESSION_MEMORY_CONFIG.minimumMessageTokensToInit - 1,
        state,
      }),
    ).toBe(false);
  });

  test("extracts at a natural pause after enough token growth", () => {
    const state = createSessionMemoryState();
    const messages = [user("u1", "task"), assistant("a1", "done")];

    expect(
      shouldExtractSessionMemory({
        messages,
        currentTokens: 20_000,
        state,
      }),
    ).toBe(true);
  });
});
```

## 测试：权限策略

### `tests/sessionMemory/policy.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { containsLikelySecret } from "../../src/sessionMemory/policy";

describe("containsLikelySecret", () => {
  test("flags secret-like field names", () => {
    expect(containsLikelySecret("api_key = abc")).toBe(true);
    expect(containsLikelySecret("auth token configured")).toBe(true);
  });

  test("allows normal task notes", () => {
    expect(
      containsLikelySecret("Use DeepSeek through the Anthropic-compatible endpoint."),
    ).toBe(false);
  });
});
```

### tool policy test

```ts
import { describe, expect, test } from "bun:test";
import { createSessionMemoryToolPolicy } from "../../src/sessionMemory/toolPolicy";

describe("createSessionMemoryToolPolicy", () => {
  test("allows editing the exact summary file", async () => {
    const canUseTool = createSessionMemoryToolPolicy("/tmp/session/summary.md");

    const decision = await canUseTool(
      { name: "Edit" },
      { file_path: "/tmp/session/summary.md" },
    );

    expect(decision.behavior).toBe("allow");
  });

  test("denies editing a sibling file", async () => {
    const canUseTool = createSessionMemoryToolPolicy("/tmp/session/summary.md");

    const decision = await canUseTool(
      { name: "Edit" },
      { file_path: "/tmp/session/other.md" },
    );

    expect(decision.behavior).toBe("deny");
  });
});
```

## 测试：compact fallback

### `tests/sessionMemory/compact.test.ts`

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { trySessionMemoryCompaction } from "../../src/sessionMemory/compact";
import { createSessionMemoryState } from "../../src/sessionMemory/thresholds";
import { writeSessionMemoryForTest } from "../../src/sessionMemory/store";
import type { ChatMessage } from "../../src/chat/types";

function message(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return {
    id,
    role,
    type: "message",
    content: [{ type: "text", text }],
  };
}

describe("trySessionMemoryCompaction", () => {
  test("returns null when summary is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccmini-sm-"));
    try {
      const state = createSessionMemoryState();
      const result = await trySessionMemoryCompaction({
        messages: [message("u1", "user", "hello")],
        cwd: dir,
        sessionId: "s1",
        state,
      });

      expect(result).toBe(null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses summary and keeps recent messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccmini-sm-"));
    try {
      const state = createSessionMemoryState();
      state.lastExtractedMessageId = "a1";

      const paths = {
        summaryPath: join(
          dir,
          ".ccmini",
          "projects",
          dir.replace(/[^a-zA-Z0-9._-]+/g, "-"),
          "s1",
          "session-memory",
          "summary.md",
        ),
      };

      await writeSessionMemoryForTest(
        paths.summaryPath,
        "# Session Title\nReal work\n\n# Current State\nContinue compact.",
      );

      const messages = [
        message("u1", "user", "start"),
        message("a1", "assistant", "done"),
        message("u2", "user", "continue"),
        message("a2", "assistant", "ok"),
      ];

      const result = await trySessionMemoryCompaction({
        messages,
        cwd: dir,
        sessionId: "s1",
        state,
      });

      expect(result).not.toBe(null);
      expect(result?.messagesToKeep.map(item => item.id)).toContain("u2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

上面第二个测试如果路径 helper 和测试构造不一致，可以改成先调用 `setupSessionMemoryFile()`，再写入 summary。

重点是断言两个行为：

- 有 useful summary 时能返回 compact result。
- 最近消息不会丢。

## 测试：不切断工具对

```ts
import { describe, expect, test } from "bun:test";
import { adjustIndexToPreserveAPIInvariants } from "../../src/sessionMemory/compact";
import type { ChatMessage } from "../../src/chat/types";

describe("adjustIndexToPreserveAPIInvariants", () => {
  test("moves start index back to include matching tool use", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        type: "message",
        content: [{ type: "tool_use", id: "tool_1", name: "Read", input: {} }],
      },
      {
        id: "u1",
        role: "user",
        type: "message",
        content: [{ type: "tool_result", toolUseId: "tool_1", content: "ok" }],
      },
    ];

    expect(adjustIndexToPreserveAPIInvariants(messages, 1)).toBe(0);
  });
});
```

这类测试非常值。

它能防止以后重构 compact 窗口时引入隐蔽 API 请求错误。

## 运行验证

本章改完后，先跑最小相关测试：

```bash
bun test tests/sessionMemory
```

再跑类型检查：

```bash
bun run typecheck
```

如果你已经把 Session Memory 接入真实 chat loop，再手动跑：

```bash
bun run dev
```

手动验证流程：

```txt
1. 开启一个长会话。
2. 让 Mini 读写几个文件。
3. 等 token 数超过提取阈值。
4. 触发一次普通 assistant 回复。
5. 检查 session-memory/summary.md 是否出现。
6. 执行 /summary，确认能强制刷新摘要。
7. 执行 /compact，确认优先使用 Session Memory Compact。
8. 删除 summary.md，再执行 /compact，确认能 fallback 到传统 compact。
```

## 常见错误

### 把 Session Memory 注入每轮 system prompt

不要这么做。

第 17 章的项目 Memory 可以进入 system context，因为它是长期约定。

Session Memory 是当前会话历史的压缩表示。

如果每轮都注入，它会：

- 增加常规请求 token。
- 和原始历史重复。
- 在 compact 前污染上下文。
- 让模型把“摘要”误当成当前用户指令。

正确做法：Session Memory 主要用于 compact summary，必要时给 `/summary` 展示。

### 每轮都提取

这会让后台提取消耗不可控。

一定要有 token 阈值和自然停顿判断。

### 允许提取器使用全部工具

这是安全边界错误。

提取器只需要更新 `summary.md`。

### compact 后不清空 last extracted id

compact 会替换消息数组。

旧 message id 已经不可靠。

### 空模板也拿去 compact

空模板不是摘要。

用它 compact 会丢失历史。

### 切断 tool result

只要保留窗口里有 `tool_result`，就必须保证对应 `tool_use` 也在窗口里。

否则下一次 API 请求可能直接失败。

## 和官方能力的差距

本章实现后，Mini 在长会话压缩上已经接近官方路径，但还有一些差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| 后台提取 | 有 | forked agent + cache-safe params |
| 权限隔离 | exact summary file | 复用完整 tool permission pipeline |
| 模板 | 固定模板 | 用户可配置模板 |
| 更新 prompt | 固定 prompt | 用户可配置 prompt |
| feature gate | 本地开关 | 远程动态配置 |
| telemetry | 可选日志 | 提取频率、长度、fallback 原因 |
| compact fallback | 有 | 更多边界事件和 debug log |
| prompt cache | 基础清理 | cache break baseline 重置 |
| session resume | 路径支持 | 更完整的 transcript 恢复联动 |

如果你的目标是“接近官方 Claude Code”，下一步最值得补的是：

1. forked agent 的 cache-safe 参数。
2. 提取器使用真实 Edit 工具，而不是直接写文件。
3. 用户自定义 session memory template 和 prompt。
4. compact 后的 prompt cache break 检测。
5. Session Memory 文件访问审计。

## 本章小结

这一章把 compact 从“压缩时临时总结”升级成了“平时持续维护会话状态，压缩时直接复用”。

现在 Mini 的长会话系统有三层：

```txt
CLAUDE.md / project memory
  -> 长期项目约定

Session Memory summary.md
  -> 当前会话稳定事实

Compact Boundary + preserved segment
  -> 压缩后的消息连续性
```

这三层职责不同：

- `CLAUDE.md` 让模型知道项目和用户偏好。
- `summary.md` 让模型记得这次会话做到了哪里。
- `CompactBoundary` 让消息历史在被裁剪后仍可恢复。

到这里，Mini 已经具备官方 Claude Code 长会话体验里非常关键的一块：自动提取、可手动查看、可用于压缩、失败可回退。

下一章可以继续补 **Transcript 恢复与 Rewind/Edit 历史分支**：让用户不仅能恢复会话，还能从历史某一轮回退、编辑输入并重新生成，进一步接近官方交互体验。
