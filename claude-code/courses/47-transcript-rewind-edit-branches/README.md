# 第 47 章：Transcript 浏览、搜索与历史分支编辑

第 44 章已经把 transcript 做成了可靠的恢复协议：

- JSONL append-only 写入。
- parent chain 投影。
- tombstone。
- resume。
- rewind。
- 文件快照。
- crash recovery。

第 46 章又补上了 Session Memory，让长会话压缩可以优先复用持续维护的 `summary.md`。

但如果目标是接近官方 Claude Code，还缺一个很关键的体验层：用户必须能在历史里 **找得到、看得懂、选得准、改得回去**。

官方感不是只有 `--resume <id>`。

它还包括：

- 打开 session 列表，快速找到要恢复的会话。
- 在 session 列表里按标题、分支、标签、项目路径和 transcript 内容搜索。
- 预览某个 session 的完整 transcript。
- 给 session 重命名。
- 把同一个 session 的 fork 分组展示。
- 在当前 transcript 中移动光标，复制消息、复制工具参数、编辑历史用户输入。
- 从某条用户消息前恢复 conversation。
- 选择只恢复 conversation、只恢复 code，或者同时恢复。
- 不想直接 rewind 时，可以把某一段历史 partial compact 成摘要。

本章会把第 44 章的底层能力包装成一个完整的历史操作体验。

## 本章目标

完成本章后，Mini 会新增：

1. `src/transcriptUx/types.ts`：session 列表、搜索、预览和历史操作的类型。
2. `src/transcriptUx/sessionIndex.ts`：把 transcript 文件转成轻量 session list。
3. `src/transcriptUx/searchText.ts`：把消息渲染成真实可搜索文本。
4. `src/transcriptUx/sessionPicker.tsx`：可搜索、可预览、可重命名的 session picker。
5. `src/transcriptUx/messageActions.ts`：当前 transcript 的消息光标和动作条。
6. `src/transcriptUx/rewindSelector.tsx`：选择历史用户消息并确认恢复方式。
7. `src/transcriptUx/conversationFork.ts`：从历史用户消息前 fork conversation。
8. `src/transcriptUx/partialSummarize.ts`：支持 “summarize from here” 和 “summarize up to here”。
9. 对 `/resume`、`/rewind`、PromptInput 快捷键和 transcript view 的接入。
10. 覆盖搜索、分组、重命名、直接编辑、确认恢复、partial compact 的测试。

这一章不再重复第 44 章的 transcript 写入和恢复算法。

它解决的是用户如何安全地操作这些历史。

## 本章完成效果

启动 Mini 后，用户输入：

```txt
> /resume
```

出现 session picker：

```txt
Resume Session

Search: implement session memory

› Implement official-like Session Memory compact
  2h ago · main · 214 messages · /Users/me/project

  Chapter 46 course writing
  1d ago · docs/course · 98 messages · /Users/me/project

Enter resume · Ctrl+V preview · Ctrl+R rename · Ctrl+B branch · / search · Esc cancel
```

按 `Ctrl+V` 可以预览 transcript：

```txt
User
继续第46章

Assistant
我会继续第 46 章...

...

2h ago · 214 messages · main
Enter resume · Esc cancel
```

在聊天界面里按历史消息动作快捷键，选择一条用户消息：

```txt
Rewind

Restore the code and/or conversation to the point before…

› 继续第46章
  README.md +2146 -0

  第二章节的 baseUrl和 key的配置...
  No code changes

Enter to continue · Esc to exit
```

确认后可以选择：

```txt
Restore code and conversation
Restore conversation
Restore code
Summarize from here
Never mind
```

如果只是编辑最近一条用户输入，Mini 会直接把原 prompt 放回输入框，用户改完重新发送。

这就是官方 Claude Code 里非常高频的“改历史输入并从那里继续”的体验。

## 和第 44 章的边界

第 44 章是协议层：

```txt
JSONL transcript
  -> projection
  -> resume
  -> rewind
  -> file snapshots
```

本章是体验层：

```txt
session picker
  -> search
  -> preview
  -> rename
  -> group forks

message actions
  -> copy
  -> edit prompt
  -> restore conversation
  -> restore code
  -> partial compact
```

第 44 章回答的是：历史如何被可靠记录和恢复？

第 47 章回答的是：用户如何高效找到历史，并用历史继续工作？

## 真实工程给我们的关键启发

当前仓库里可以参考这些实现：

```txt
src/components/LogSelector.tsx
src/components/SessionPreview.tsx
src/components/MessageSelector.tsx
src/components/messageActions.tsx
src/utils/sessionStorage.ts
src/utils/transcriptSearch.ts
src/screens/REPL.tsx
src/commands/rewind/rewind.ts
```

关键点如下：

1. Session 列表不是直接全量加载所有 JSONL。它可以先用 lite log，只在 preview 或 resume 时加载完整 transcript。
2. 搜索分两层：标题、分支、标签等 metadata 即时搜索；transcript 内容做延迟深搜。
3. 大 transcript 搜索要裁剪 head/tail，不能每次键入都扫完整 GB 文件。
4. 搜索文本必须接近用户实际看到的文本，不能索引 system reminder 或模型私有序列化。
5. 同一个 session 的多个 fork 要分组展示。
6. Session 可以重命名，重命名通过 append `custom-title` entry，而不是改旧 JSONL。
7. 当前 transcript 里的消息动作只对“可操作消息”开放。
8. 编辑历史 user message 本质是 rewind 到该消息之前，然后把原 prompt 放回输入框。
9. 如果有文件快照，恢复前要展示 diff 统计，并让用户选择恢复 conversation、code 或 both。
10. “Summarize from here” 不是 rewind，而是 partial compact。

这章的 Mini 版本会复刻这些设计原则。

## 推荐目录

新增：

```txt
src/
  transcriptUx/
    types.ts
    sessionIndex.ts
    searchText.ts
    sessionPicker.tsx
    sessionPreview.tsx
    messageActions.ts
    rewindSelector.tsx
    conversationFork.ts
    partialSummarize.ts
    commands.ts
tests/
  transcriptUx/
    sessionIndex.test.ts
    searchText.test.ts
    sessionPicker.test.tsx
    messageActions.test.ts
    conversationFork.test.ts
    partialSummarize.test.ts
```

修改：

```txt
src/chat/chatLoop.ts
src/chat/commands.ts
src/ui/PromptInput.tsx
src/ui/Messages.tsx
src/session/transcript.ts
```

如果你的 Mini 没有 React/Ink UI，也可以先做 TTY 文本版。

但类型和核心算法建议保持一致。

改 `src/chat/chatLoop.ts` 或 `src/chat/commands.ts` 时，继续保留 plan mode 命令语义：

```txt
/plan       进入 plan mode
/plan show  查看当前 plan
/plan clear 清空当前 plan
/plan exit  退出 Mini plan mode
```

Transcript rewind / fork 只能改变消息历史视图，不应该把 `PlannerStore` 的最新 plan entry 解析逻辑删掉。

## 核心类型

先定义这章要操作的数据。

### `src/transcriptUx/types.ts`

```ts
import type { ChatMessage } from "../chat/types";

export type SessionLogOption = {
  sessionId: string;
  fullPath: string;
  projectPath: string;
  messages: ChatMessage[];
  messageCount: number;
  createdAt: string;
  modifiedAt: string;
  firstPrompt?: string;
  summary?: string;
  customTitle?: string;
  aiTitle?: string;
  gitBranch?: string;
  tag?: string;
  prNumber?: number;
  prRepository?: string;
  isSidechain?: boolean;
  isLite: boolean;
};

export type SessionPickerState =
  | { mode: "list" }
  | { mode: "search"; query: string }
  | { mode: "preview"; log: SessionLogOption }
  | { mode: "rename"; log: SessionLogOption; value: string };

export type SessionSearchResult = {
  log: SessionLogOption;
  score?: number;
  snippet?: {
    before: string;
    match: string;
    after: string;
  };
};

export type RestoreOption =
  | "both"
  | "conversation"
  | "code"
  | "summarize_from"
  | "summarize_up_to"
  | "cancel";

export type RewindCandidate = {
  message: ChatMessage;
  index: number;
  label: string;
  canRestoreCode: boolean;
  changedFiles: string[];
  insertions: number;
  deletions: number;
};

export type ConversationForkResult = {
  messages: ChatMessage[];
  inputText: string;
  inputMode: "prompt" | "bash";
  conversationId: string;
};
```

这里的 `SessionLogOption` 既可以表示完整 log，也可以表示 lite log。

lite log 的 `messages` 为空，只保留 metadata。

预览或真正恢复时再加载完整消息。

## Session Index

第 44 章已经能读 transcript。

但 session picker 不应该每次打开都读取全部消息。

推荐分两级：

```txt
listSessions()
  -> 读取每个 JSONL 的 head/tail 和 metadata
  -> 返回 lite logs

loadFullSession(log)
  -> 用户 preview/resume 时读取完整 JSONL
  -> 返回 full log
```

### `src/transcriptUx/sessionIndex.ts`

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "../chat/types";
import { loadTranscriptFile } from "../session/transcript";
import type { SessionLogOption } from "./types";

export async function listSessionLogs(projectsDir: string): Promise<SessionLogOption[]> {
  const logs: SessionLogOption[] = [];
  const projectDirs = await safeReadDir(projectsDir);

  for (const projectDir of projectDirs) {
    const absoluteProjectDir = join(projectsDir, projectDir);
    const files = await safeReadDir(absoluteProjectDir);

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const fullPath = join(absoluteProjectDir, file);
      const sessionId = file.replace(/\.jsonl$/, "");
      const fileStat = await stat(fullPath);
      const lite = await readLiteSession(fullPath, sessionId, absoluteProjectDir);

      logs.push({
        ...lite,
        fullPath,
        projectPath: absoluteProjectDir,
        sessionId,
        messages: [],
        messageCount: lite.messageCount,
        createdAt: fileStat.birthtime.toISOString(),
        modifiedAt: fileStat.mtime.toISOString(),
        isLite: true,
      });
    }
  }

  logs.sort(
    (a, b) =>
      new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
  );
  return logs;
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readLiteSession(
  fullPath: string,
  sessionId: string,
  projectPath: string,
): Promise<Pick<
  SessionLogOption,
  | "firstPrompt"
  | "summary"
  | "customTitle"
  | "aiTitle"
  | "gitBranch"
  | "tag"
  | "messageCount"
>> {
  const transcript = await loadTranscriptFile(fullPath, {
    mode: "metadata",
    maxBytes: 1024 * 1024,
  });

  return {
    firstPrompt: getFirstMeaningfulPrompt(transcript.messages),
    summary: transcript.summary,
    customTitle: transcript.customTitle,
    aiTitle: transcript.aiTitle,
    gitBranch: transcript.gitBranch,
    tag: transcript.tag,
    messageCount: transcript.messageCount,
  };
}

export async function loadFullSession(
  log: SessionLogOption,
): Promise<SessionLogOption> {
  if (!log.isLite && log.messages.length > 0) {
    return log;
  }

  const transcript = await loadTranscriptFile(log.fullPath, {
    mode: "full",
    maxBytes: 50 * 1024 * 1024,
  });

  return {
    ...log,
    messages: transcript.messages,
    messageCount: transcript.messages.length,
    summary: transcript.summary ?? log.summary,
    customTitle: transcript.customTitle ?? log.customTitle,
    aiTitle: transcript.aiTitle ?? log.aiTitle,
    gitBranch: transcript.gitBranch ?? log.gitBranch,
    tag: transcript.tag ?? log.tag,
    isLite: false,
  };
}

function getFirstMeaningfulPrompt(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (message.isMeta || message.isCompactSummary) continue;
    const text = textFromMessage(message).trim();
    if (!text) continue;
    if (text.startsWith("<")) continue;
    if (text.startsWith("/model")) continue;
    if (text.startsWith("/resume")) continue;
    return text;
  }
  return undefined;
}

function textFromMessage(message: ChatMessage): string {
  return message.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n");
}
```

真实实现里 `readLiteSession()` 会更复杂：

- 从 JSONL tail 读取最新 metadata。
- 避免一次性读大文件。
- 合并 custom title、AI title、tag、PR、worktree state。
- 跳过没有意义的内置 slash command。

Mini 先实现接口，后续再优化读取方式。

## 标题选择规则

Session picker 每一行必须有稳定标题。

标题优先级建议：

1. 用户自定义标题。
2. AI 生成标题。
3. summary。
4. first meaningful prompt。
5. session id 短前缀。

```ts
export function getSessionDisplayTitle(log: SessionLogOption): string {
  return (
    log.customTitle?.trim() ||
    log.aiTitle?.trim() ||
    log.summary?.trim() ||
    log.firstPrompt?.trim() ||
    `Session ${log.sessionId.slice(0, 8)}`
  );
}
```

用户重命名时，不要改旧 JSONL 行。

继续使用 append-only：

```ts
export async function saveCustomSessionTitle(
  log: SessionLogOption,
  title: string,
  appendEntry: (path: string, entry: unknown) => Promise<void>,
): Promise<void> {
  await appendEntry(log.fullPath, {
    type: "custom-title",
    sessionId: log.sessionId,
    customTitle: title,
    timestamp: new Date().toISOString(),
  });
}
```

这样做符合第 44 章的原则：历史记录不可变，后续事件修正投影结果。

## 搜索文本：不要制造幻觉命中

Session 搜索最容易做错。

很多内部 message 内容不是用户实际看到的文本。

如果直接 `JSON.stringify(message)` 做搜索，会出现大量“幻觉命中”：

- system reminder。
- tool result 的模型序列化包装。
- hidden prompt。
- thinking / redacted_thinking block。
- compact metadata。
- interrupt sentinel。

用户搜到结果却在预览里看不到对应文本，会非常糟糕。

所以搜索文本必须接近 UI 可见文本。

### `src/transcriptUx/searchText.ts`

```ts
import type { ChatMessage, MessagePart } from "../chat/types";

const SYNTHETIC_TEXT = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export function messageSearchText(message: ChatMessage): string {
  switch (message.type) {
    case "message":
      return visibleMessageText(message);
    case "attachment":
      return visibleAttachmentText(message);
    case "compact_boundary":
      return "";
    default:
      return "";
  }
}

function visibleMessageText(message: ChatMessage): string {
  if (message.role === "user") {
    if (message.isMeta || message.isCompactSummary) return "";
    return stripSystemReminders(
      message.content.map(searchTextFromPart).filter(Boolean).join("\n"),
    );
  }

  if (message.role === "assistant") {
    return message.content
      .map(part => {
        if (part.type === "text") return part.text;
        if (part.type === "tool_use") return toolUseSearchText(part.input);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function searchTextFromPart(part: MessagePart): string {
  if (part.type === "text") {
    return SYNTHETIC_TEXT.has(part.text) ? "" : part.text;
  }
  if (part.type === "tool_result") {
    return toolResultSearchText(part.result);
  }
  return "";
}

function visibleAttachmentText(message: ChatMessage): string {
  if (message.attachmentType === "queued_command" && !message.isMeta) {
    return message.promptText ?? "";
  }
  if (message.attachmentType === "relevant_memories") {
    return message.memories?.map(item => item.content).join("\n") ?? "";
  }
  return "";
}

export function toolUseSearchText(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const fields = [
    "command",
    "pattern",
    "file_path",
    "path",
    "prompt",
    "description",
    "query",
    "url",
  ];

  return fields
    .map(field => record[field])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function toolResultSearchText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";

  const record = result as Record<string, unknown>;
  if (typeof record.stdout === "string") {
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    return stderr ? `${record.stdout}\n${stderr}` : record.stdout;
  }

  if (
    record.file &&
    typeof record.file === "object" &&
    typeof (record.file as Record<string, unknown>).content === "string"
  ) {
    return (record.file as { content: string }).content;
  }

  return ["content", "output", "result", "text", "message"]
    .map(field => record[field])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function stripSystemReminders(text: string): string {
  let output = text;
  while (true) {
    const start = output.indexOf(SYSTEM_REMINDER_OPEN);
    if (start < 0) return output;

    const end = output.indexOf(SYSTEM_REMINDER_CLOSE, start);
    if (end < 0) return output.slice(0, start);

    output =
      output.slice(0, start) +
      output.slice(end + SYSTEM_REMINDER_CLOSE.length);
  }
}
```

如果你的 Mini 没有 attachment 或 compact boundary 类型，可以删除对应分支。

关键原则不变：搜索 UI 看得见的内容，宁可漏掉一点，也不要命中用户看不到的内部文本。

## 构建 Session 搜索

Session 搜索分成两层：

1. metadata 即时搜索。
2. transcript 深搜。

metadata 包括：

- 自定义标题。
- AI 标题。
- summary。
- first prompt。
- git branch。
- tag。
- PR 信息。
- project path。

深搜才扫描消息。

### `src/transcriptUx/sessionSearch.ts`

```ts
import type { SessionLogOption, SessionSearchResult } from "./types";
import { getSessionDisplayTitle } from "./sessionIndex";
import { messageSearchText } from "./searchText";

const DEEP_SEARCH_MAX_MESSAGES = 2_000;
const DEEP_SEARCH_CROP_SIZE = 1_000;
const DEEP_SEARCH_MAX_TEXT_LENGTH = 50_000;
const SNIPPET_CONTEXT_CHARS = 50;

export function searchSessions(
  logs: SessionLogOption[],
  query: string,
): SessionSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return logs.map(log => ({ log }));
  }

  const results: SessionSearchResult[] = [];

  for (const log of logs) {
    const metadata = buildMetadataText(log).toLowerCase();
    if (metadata.includes(normalizedQuery)) {
      results.push({ log, score: 0 });
      continue;
    }

    const transcriptText = buildSearchableTranscriptText(log);
    const index = transcriptText.toLowerCase().indexOf(normalizedQuery);
    if (index >= 0) {
      results.push({
        log,
        score: 1,
        snippet: extractSnippet(transcriptText, index, query.length),
      });
    }
  }

  return results.sort((a, b) => {
    const scoreDiff = (a.score ?? 0) - (b.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (
      new Date(b.log.modifiedAt).getTime() -
      new Date(a.log.modifiedAt).getTime()
    );
  });
}

function buildMetadataText(log: SessionLogOption): string {
  return [
    getSessionDisplayTitle(log),
    log.firstPrompt,
    log.summary,
    log.gitBranch,
    log.tag,
    log.prNumber ? `PR #${log.prNumber}` : undefined,
    log.prRepository,
    log.projectPath,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildSearchableTranscriptText(log: SessionLogOption): string {
  const messages =
    log.messages.length <= DEEP_SEARCH_MAX_MESSAGES
      ? log.messages
      : [
          ...log.messages.slice(0, DEEP_SEARCH_CROP_SIZE),
          ...log.messages.slice(-DEEP_SEARCH_CROP_SIZE),
        ];

  const text = messages.map(messageSearchText).filter(Boolean).join(" ");
  return text.length > DEEP_SEARCH_MAX_TEXT_LENGTH
    ? text.slice(0, DEEP_SEARCH_MAX_TEXT_LENGTH)
    : text;
}

function extractSnippet(
  text: string,
  matchIndex: number,
  matchLength: number,
): SessionSearchResult["snippet"] {
  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(
    text.length,
    matchIndex + matchLength + SNIPPET_CONTEXT_CHARS,
  );

  return {
    before: `${start > 0 ? "..." : ""}${text.slice(start, matchIndex).trimStart()}`,
    match: text.slice(matchIndex, matchIndex + matchLength),
    after: `${text.slice(matchIndex + matchLength, end).trimEnd()}${end < text.length ? "..." : ""}`,
  };
}
```

真实实现会用 Fuse 做 fuzzy search。

Mini 可以先做 substring search。

接口保持 `score` 和 `snippet`，以后换成 Fuse 不影响 UI。

## Session 分组

当用户从历史消息处 fork conversation 后，同一个 session 可能出现多条相关 log。

在列表里平铺会很混乱。

更好的展示方式是按 `sessionId` 分组：

```txt
▼ Implement auth flow (+2 other sessions)
  main · 2h ago
  ▸ Implement auth flow
    main · 1h ago
  ▸ Implement auth flow
    debug-auth · 30m ago
```

### `src/transcriptUx/groupLogs.ts`

```ts
import type { SessionLogOption } from "./types";

export function groupLogsBySessionId(
  logs: SessionLogOption[],
): Map<string, SessionLogOption[]> {
  const groups = new Map<string, SessionLogOption[]>();

  for (const log of logs) {
    const group = groups.get(log.sessionId);
    if (group) {
      group.push(log);
    } else {
      groups.set(log.sessionId, [log]);
    }
  }

  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        new Date(b.modifiedAt).getTime() -
        new Date(a.modifiedAt).getTime(),
    );
  }

  return groups;
}
```

如果你的 Mini 还没有 fork metadata，也可以先只按 session id 分组。

后续可以加入：

- parent session id。
- forked from message id。
- worktree path。
- branch name。

## Session Picker 状态机

Session picker 不要写成一堆布尔值。

它至少有四种模式：

```txt
list
search
preview
rename
```

状态机：

```txt
list
  | "/" or printable key
  v
search
  | Enter on result
  v
select

list
  | Ctrl+V
  v
preview
  | Enter
  v
select

list
  | Ctrl+R
  v
rename
  | Enter
  v
list
```

### `src/transcriptUx/sessionPicker.tsx`

下面是简化版，重点展示状态和回调：

```tsx
import * as React from "react";
import { Box, Text } from "ink";
import type { SessionLogOption, SessionPickerState } from "./types";
import { searchSessions } from "./sessionSearch";
import { getSessionDisplayTitle, loadFullSession } from "./sessionIndex";

type Props = {
  logs: SessionLogOption[];
  onSelect: (log: SessionLogOption) => void;
  onCancel: () => void;
  onRename: (log: SessionLogOption, title: string) => Promise<void>;
};

export function SessionPicker({
  logs,
  onSelect,
  onCancel,
  onRename,
}: Props): React.ReactNode {
  const [state, setState] = React.useState<SessionPickerState>({
    mode: "list",
  });
  const [query, setQuery] = React.useState("");
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const [previewLog, setPreviewLog] = React.useState<SessionLogOption | null>(
    null,
  );

  const displayed = React.useMemo(() => {
    return searchSessions(logs, query).map(result => result.log);
  }, [logs, query]);

  async function openPreview(log: SessionLogOption): Promise<void> {
    const full = await loadFullSession(log);
    setPreviewLog(full);
    setState({ mode: "preview", log: full });
  }

  async function submitRename(title: string): Promise<void> {
    if (state.mode !== "rename") return;
    await onRename(state.log, title.trim());
    setState({ mode: "list" });
  }

  if (state.mode === "preview" && previewLog) {
    return (
      <SessionPreview
        log={previewLog}
        onCancel={() => setState({ mode: "list" })}
        onSelect={() => onSelect(previewLog)}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Resume Session</Text>
      <Text dimColor>Search: {query}</Text>

      {displayed.map((log, index) => (
        <Box key={`${log.sessionId}:${log.fullPath}`} flexDirection="column">
          <Text color={index === focusedIndex ? "cyan" : undefined}>
            {index === focusedIndex ? "› " : "  "}
            {getSessionDisplayTitle(log)}
          </Text>
          <Text dimColor>
            {formatLogMetadata(log)}
          </Text>
        </Box>
      ))}

      <Text dimColor>
        Enter resume · Ctrl+V preview · Ctrl+R rename · / search · Esc cancel
      </Text>
    </Box>
  );
}

function formatLogMetadata(log: SessionLogOption): string {
  const parts = [
    relativeTime(log.modifiedAt),
    log.gitBranch,
    `${log.messageCount} messages`,
    log.projectPath,
  ].filter(Boolean);
  return parts.join(" · ");
}

function relativeTime(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
```

真实 UI 还需要键盘处理、滚动窗口、tag tabs、branch filter、worktree filter 和 deep search loading state。

这些可以逐步加。

## Session Preview

Preview 是只读 transcript。

它不应该复用正在运行的工具状态，也不应该触发权限请求。

它只需要：

- 加载完整 log。
- 用普通 message renderer 展示。
- 底部显示 metadata。
- Enter 恢复。
- Esc 返回列表。

### `src/transcriptUx/sessionPreview.tsx`

```tsx
import * as React from "react";
import { Box, Text } from "ink";
import type { SessionLogOption } from "./types";

type Props = {
  log: SessionLogOption;
  onSelect: () => void;
  onCancel: () => void;
};

export function SessionPreview({ log, onSelect, onCancel }: Props): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {log.messages.map(message => (
          <PreviewMessage key={message.id} message={message} />
        ))}
      </Box>

      <Box borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false}>
        <Text dimColor>
          {log.messageCount} messages
          {log.gitBranch ? ` · ${log.gitBranch}` : ""}
          {" · Enter resume · Esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}
```

注意：preview 不是 resume。

用户只是查看历史时，不要改变当前 session id，不要恢复 file history，不要写任何 transcript entry。

## 当前 Transcript 的消息动作

Session picker 解决“找会话”。

消息动作解决“在当前会话里找某条消息并操作”。

官方体验里，用户可以进入 transcript 光标模式，对消息做动作：

- copy message。
- copy tool primary input。
- expand/collapse。
- edit user prompt。

先定义哪些消息可操作。

### `src/transcriptUx/messageActions.ts`

```ts
import type { ChatMessage } from "../chat/types";

export type NavigableMessageType =
  | "user"
  | "assistant"
  | "system"
  | "attachment"
  | "tool_group";

export type MessageActionState = {
  messageId: string;
  type: NavigableMessageType;
  expanded: boolean;
  toolName?: string;
};

export type MessageAction =
  | { key: "enter"; label: "expand" | "collapse" }
  | { key: "c"; label: "copy" }
  | { key: "p"; label: string }
  | { key: "e"; label: "edit" };

export function isNavigableMessage(message: ChatMessage): boolean {
  if (message.role === "user") {
    if (message.isMeta || message.isCompactSummary) return false;
    const text = firstText(message);
    if (!text) return false;
    if (text.startsWith("<")) return false;
    if (text.startsWith("[Request interrupted")) return false;
    return true;
  }

  if (message.role === "assistant") {
    return message.content.some(part => {
      if (part.type === "text") return part.text.trim().length > 0;
      if (part.type === "tool_use") return getPrimaryToolInput(part.name, part.input) !== undefined;
      return false;
    });
  }

  return message.type === "attachment" || message.type === "system";
}

export function getAvailableActions(message: ChatMessage): MessageAction[] {
  const actions: MessageAction[] = [{ key: "c", label: "copy" }];

  if (message.role === "user") {
    actions.unshift({ key: "e", label: "edit" });
  }

  const tool = firstToolUse(message);
  if (tool) {
    const primary = getPrimaryToolInput(tool.name, tool.input);
    if (primary) {
      actions.push({ key: "p", label: `copy ${primary.label}` });
    }
  }

  if (message.type === "attachment" || message.type === "system") {
    actions.unshift({ key: "enter", label: "expand" });
  }

  return actions;
}

function firstText(message: ChatMessage): string | undefined {
  return message.content.find(part => part.type === "text")?.text;
}

function firstToolUse(message: ChatMessage):
  | { name: string; input: unknown }
  | undefined {
  const part = message.content.find(item => item.type === "tool_use");
  return part?.type === "tool_use" ? { name: part.name, input: part.input } : undefined;
}

const PRIMARY_TOOL_INPUTS: Record<string, { label: string; field: string }> = {
  Read: { label: "path", field: "file_path" },
  Edit: { label: "path", field: "file_path" },
  Write: { label: "path", field: "file_path" },
  Bash: { label: "command", field: "command" },
  Grep: { label: "pattern", field: "pattern" },
  Glob: { label: "pattern", field: "pattern" },
  WebFetch: { label: "url", field: "url" },
  WebSearch: { label: "query", field: "query" },
  Agent: { label: "prompt", field: "prompt" },
};

function getPrimaryToolInput(
  toolName: string,
  input: unknown,
): { label: string; value: string } | undefined {
  const config = PRIMARY_TOOL_INPUTS[toolName];
  if (!config || !input || typeof input !== "object") return undefined;

  const value = (input as Record<string, unknown>)[config.field];
  return typeof value === "string"
    ? { label: config.label, value }
    : undefined;
}
```

这里有两个关键过滤：

- meta user message 不能编辑。
- compact summary 不能编辑。

否则用户可能把系统注入内容当成自己的输入拿出来改。

## 编辑历史用户消息

“编辑历史消息”不是在原地修改 transcript。

正确语义是：

```txt
选择历史 user message M
  |
  v
把 active messages 截断到 M 之前
  |
  v
把 M 的文本放回输入框
  |
  v
用户修改后重新发送
  |
  v
形成新的 conversation branch
```

这有几个好处：

- JSONL 仍然 append-only。
- 旧回答没有被伪造或覆盖。
- 新分支和旧分支都可恢复。
- 如果文件恢复可用，可以选择是否回滚 code。

### `src/transcriptUx/conversationFork.ts`

```ts
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../chat/types";
import type { ConversationForkResult } from "./types";

export function forkConversationBeforeMessage(input: {
  messages: ChatMessage[];
  message: ChatMessage;
}): ConversationForkResult | null {
  if (input.message.role !== "user") return null;

  const index = input.messages.findIndex(
    message => message.id === input.message.id,
  );
  if (index < 0) return null;

  const inputText = textForResubmit(input.message);
  if (!inputText) return null;

  return {
    messages: input.messages.slice(0, index),
    inputText,
    inputMode: inferInputMode(inputText),
    conversationId: randomUUID(),
  };
}

export function textForResubmit(message: ChatMessage): string | null {
  if (message.role !== "user") return null;
  if (message.isMeta || message.isCompactSummary) return null;

  const text = message.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n")
    .trim();

  if (!text) return null;
  if (text.startsWith("<")) return null;
  return text;
}

function inferInputMode(text: string): "prompt" | "bash" {
  return text.trimStart().startsWith("!") ? "bash" : "prompt";
}
```

如果 user message 带图片粘贴，还需要恢复 pasted image state。

Mini 可以把图片恢复作为后续增强：

```ts
export type ConversationForkResult = {
  messages: ChatMessage[];
  inputText: string;
  inputMode: "prompt" | "bash";
  conversationId: string;
  pastedImages?: Record<number, { mediaType: string; data: string }>;
};
```

## 什么时候可以直接编辑

真实交互里，编辑最近输入时不一定要弹确认。

如果满足两个条件，可以直接 rewind 并填回输入框：

1. 从选中消息之后没有 AI 修改过文件。
2. 后面的消息只是 synthetic 或 interrupt 之类，不是真正有效对话。

否则必须弹确认。

原因是直接编辑会丢弃后续 conversation。

如果后续已经有文件变更，用户必须明确选择是否恢复 code。

### `src/transcriptUx/directEdit.ts`

```ts
import type { ChatMessage } from "../chat/types";

export function canDirectEdit(input: {
  messages: ChatMessage[];
  selectedIndex: number;
  hasFileChangesAfter: boolean;
}): boolean {
  if (input.hasFileChangesAfter) return false;

  const after = input.messages.slice(input.selectedIndex + 1);
  return after.every(isSyntheticMessage);
}

function isSyntheticMessage(message: ChatMessage): boolean {
  if (message.type === "system") return true;
  if (message.role === "assistant") {
    const text = message.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
      .trim();
    return text.length === 0 || text.startsWith("[Request interrupted");
  }
  return false;
}
```

这能让常见场景很顺：

```txt
用户发错 prompt
立刻中断
编辑刚才那条 prompt
重新发送
```

这个流程不需要多余确认。

## Rewind Selector

如果不能直接编辑，就打开 Rewind Selector。

它需要展示：

- 可选择的历史用户消息。
- 每条消息后到下一条用户消息之间的文件变更统计。
- 当前 prompt 作为虚拟选项。
- 选择后展示确认界面。
- 提供 restore options。

### `src/transcriptUx/rewindSelector.tsx`

```tsx
import * as React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "../chat/types";
import type { RestoreOption, RewindCandidate } from "./types";

type Props = {
  messages: ChatMessage[];
  candidates: RewindCandidate[];
  onRestoreConversation: (message: ChatMessage) => Promise<void>;
  onRestoreCode: (message: ChatMessage) => Promise<void>;
  onSummarize: (
    message: ChatMessage,
    direction: "from" | "up_to",
    feedback?: string,
  ) => Promise<void>;
  onCancel: () => void;
};

export function RewindSelector({
  candidates,
  onRestoreConversation,
  onRestoreCode,
  onSummarize,
  onCancel,
}: Props): React.ReactNode {
  const [selectedIndex, setSelectedIndex] = React.useState(
    Math.max(0, candidates.length - 1),
  );
  const [confirming, setConfirming] = React.useState<RewindCandidate | null>(
    null,
  );
  const selected = candidates[selectedIndex];

  async function apply(option: RestoreOption): Promise<void> {
    if (!confirming) return;
    if (option === "cancel") {
      setConfirming(null);
      return;
    }

    if (option === "summarize_from") {
      await onSummarize(confirming.message, "from");
      return;
    }

    if (option === "summarize_up_to") {
      await onSummarize(confirming.message, "up_to");
      return;
    }

    if (option === "code" || option === "both") {
      await onRestoreCode(confirming.message);
    }

    if (option === "conversation" || option === "both") {
      await onRestoreConversation(confirming.message);
    }
  }

  if (confirming) {
    return (
      <Box flexDirection="column">
        <Text bold>Rewind</Text>
        <Text>Confirm you want to restore to the point before:</Text>
        <Text color="cyan">{confirming.label}</Text>
        <RestoreOptions candidate={confirming} onSelect={apply} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Rewind</Text>
      <Text dimColor>Restore the code and/or conversation to the point before...</Text>

      {candidates.map((candidate, index) => (
        <Box key={candidate.message.id} flexDirection="column">
          <Text color={index === selectedIndex ? "cyan" : undefined}>
            {index === selectedIndex ? "› " : "  "}
            {candidate.label}
          </Text>
          <Text dimColor>
            {formatCandidateDiff(candidate)}
          </Text>
        </Box>
      ))}

      <Text dimColor>Enter to continue · Esc to exit</Text>
    </Box>
  );
}

function formatCandidateDiff(candidate: RewindCandidate): string {
  if (!candidate.canRestoreCode) return "No code restore";
  if (candidate.changedFiles.length === 0) return "No code changes";
  const first = candidate.changedFiles[0] ?? "file";
  const fileLabel =
    candidate.changedFiles.length === 1
      ? first
      : `${first} and ${candidate.changedFiles.length - 1} other files`;
  return `${fileLabel} +${candidate.insertions} -${candidate.deletions}`;
}
```

真实 UI 会：

- 一次只展示最多 7 条，保持选择项在中间。
- Esc 在确认态先返回列表，再退出。
- 恢复中显示 spinner。
- 对 summarize option 提供 inline feedback 输入。

Mini 可以逐步补。

## 恢复 Code

第 44 章已经实现了文件快照。

本章只负责把它接到选项上。

```ts
export async function restoreCodeForMessage(input: {
  messageId: string;
  fileHistory: FileHistoryState;
  updateFileHistory: (fn: (prev: FileHistoryState) => FileHistoryState) => void;
  rewindFiles: (messageId: string) => Promise<void>;
}): Promise<void> {
  await input.rewindFiles(input.messageId);
  input.updateFileHistory(prev => ({
    ...prev,
    lastRestoredMessageId: input.messageId,
  }));
}
```

需要明确提示用户：

```txt
Rewinding does not affect files edited manually or via bash.
```

因为文件快照通常只覆盖 Mini 通过 Edit/Write 工具改过的文件。

手动编辑、脚本生成、外部格式化、shell 命令改文件，不一定能还原。

## 恢复 Conversation

Conversation restore 的核心就是第 44 章的 rewind。

但体验层还要做一些额外清理：

- 取消当前正在跑的请求。
- 截断 active messages。
- 生成新的 conversation id。
- 清掉 microcompact 状态。
- 清掉 prompt suggestion。
- 从被选中的用户消息恢复 permission mode。
- 把原用户输入放回输入框。
- 如果有粘贴图片，恢复 pasted content。

### `src/transcriptUx/restoreConversation.ts`

```ts
import { forkConversationBeforeMessage } from "./conversationFork";
import type { ChatMessage } from "../chat/types";

export type RestoreConversationRuntime = {
  cancelCurrentTurn: () => void;
  setMessages: (messages: ChatMessage[]) => void;
  setConversationId: (id: string) => void;
  setInput: (text: string, mode: "prompt" | "bash") => void;
  resetMicrocompactState: () => void;
  clearPromptSuggestion: () => void;
  restorePermissionMode?: (mode: string | undefined) => void;
};

export async function restoreConversationBeforeMessage(input: {
  messages: ChatMessage[];
  message: ChatMessage;
  runtime: RestoreConversationRuntime;
}): Promise<void> {
  const result = forkConversationBeforeMessage({
    messages: input.messages,
    message: input.message,
  });

  if (!result) {
    throw new Error("Selected message cannot be restored.");
  }

  input.runtime.cancelCurrentTurn();
  input.runtime.setMessages(result.messages);
  input.runtime.setConversationId(result.conversationId);
  input.runtime.resetMicrocompactState();
  input.runtime.clearPromptSuggestion();
  input.runtime.restorePermissionMode?.(input.message.permissionMode);
  input.runtime.setInput(result.inputText, result.inputMode);
}
```

这里的 `conversationId` 不是 session id。

session id 仍然表示这份 transcript 所属会话。

conversation id 表示当前活跃分支。

如果你的 Mini 没有这个区分，可以先生成一个 `branchId` 写入后续 transcript entry。

## Partial Compact：Summarize From Here

Rewind 是丢弃后面的 active history。

Partial compact 是保留当前进度，但把某一段历史摘要掉。

两个方向：

```txt
summarize from here
  选中消息之前保留
  选中消息之后摘要
  把选中消息文本放回输入框

summarize up to here
  选中消息之前摘要
  选中消息及之后保留
  仍留在当前对话末尾
```

这个能力很适合：

- 会话太长，但用户不想完整 rewind。
- 用户想保留最近上下文，只把旧探索压成摘要。
- 用户想从某个历史输入重新提问，但不想完全丢掉后续信息。

### `src/transcriptUx/partialSummarize.ts`

```ts
import type { ChatMessage } from "../chat/types";
import { compactMessagesRange } from "../context/compact";

export type PartialCompactDirection = "from" | "up_to";

export async function partialSummarizeConversation(input: {
  messages: ChatMessage[];
  pivotMessage: ChatMessage;
  direction: PartialCompactDirection;
  feedback?: string;
}): Promise<ChatMessage[]> {
  const pivotIndex = input.messages.findIndex(
    message => message.id === input.pivotMessage.id,
  );
  if (pivotIndex < 0) {
    throw new Error("Selected message is no longer in active context.");
  }

  if (input.direction === "from") {
    const kept = input.messages.slice(0, pivotIndex);
    const summarized = await compactMessagesRange({
      messages: input.messages.slice(pivotIndex),
      feedback: input.feedback,
    });
    return [...kept, ...summarized];
  }

  const summarized = await compactMessagesRange({
    messages: input.messages.slice(0, pivotIndex),
    feedback: input.feedback,
  });
  const kept = input.messages.slice(pivotIndex);
  return [...summarized, ...kept];
}
```

真实实现还会：

- 先投影掉已经 snipped 的 compact boundary 前历史。
- 构建完整 system prompt、user context、system context。
- 生成 compact boundary。
- 重新注入 attachments 和 hook results。
- 清理 context-blocked 状态。

Mini 可以复用第 45 章的 compact pipeline。

## 接入 `/rewind`

`/rewind` 本身应该很薄。

它只负责打开 selector。

```ts
export async function rewindCommand(context: {
  openRewindSelector?: () => void;
}): Promise<{ type: "skip" }> {
  context.openRewindSelector?.();
  return { type: "skip" };
}
```

为什么返回 `skip`？

因为打开 UI 不应该向 transcript 追加一条用户消息。

`/rewind` 是本地控制命令，不是模型上下文。

## 接入 `/resume`

`/resume` 打开 session picker。

```ts
export async function resumeCommand(context: {
  openSessionPicker: () => void;
}): Promise<{ type: "skip" }> {
  context.openSessionPicker();
  return { type: "skip" };
}
```

如果用户在 CLI 参数里传了 `--resume <id>`，可以直接走第 44 章的恢复流程，不打开 UI。

如果用户只输入 `/resume`，打开 picker。

## 筛选器：分支、工作区、标签

Session 多了以后，纯搜索还不够。

建议至少支持三个筛选：

| 筛选 | 用途 |
| --- | --- |
| branch | 只看当前 Git branch 的 sessions |
| worktree | 只看当前 worktree 的 sessions |
| tag | 只看某类 session |

```ts
export function filterSessions(input: {
  logs: SessionLogOption[];
  currentBranch?: string;
  currentProjectPath: string;
  branchOnly: boolean;
  currentWorktreeOnly: boolean;
  tag?: string;
}): SessionLogOption[] {
  return input.logs.filter(log => {
    if (input.branchOnly && input.currentBranch) {
      if (log.gitBranch !== input.currentBranch) return false;
    }

    if (input.currentWorktreeOnly) {
      if (log.projectPath !== input.currentProjectPath) return false;
    }

    if (input.tag && log.tag !== input.tag) {
      return false;
    }

    return true;
  });
}
```

真实实现里 worktree filter 很重要。

同一个仓库多个 worktree 时，用户通常只想恢复当前 worktree 的会话。

但也要提供“show all worktrees”，否则旧会话可能找不到。

## 大 transcript 的性能边界

这章的所有 UI 都必须尊重大文件边界。

建议规则：

1. Session list 默认只读 lite metadata。
2. Preview 才加载完整 messages。
3. Raw transcript 超过 50MB 时，不做全量读取。
4. 搜索最多索引前 1000 条和后 1000 条消息。
5. 搜索文本最多 50k chars。
6. 每次键入不要同步扫描大数组。
7. 对 message search text 做 WeakMap 缓存。

示例：

```ts
const searchTextCache = new WeakMap<ChatMessage, string>();

export function cachedMessageSearchText(message: ChatMessage): string {
  const cached = searchTextCache.get(message);
  if (cached !== undefined) return cached;

  const text = messageSearchText(message).toLowerCase();
  searchTextCache.set(message, text);
  return text;
}
```

WeakMap 的好处是不会阻止旧 message 被 GC。

前提是 message 对象是 append-only 或近似不可变。

## 测试：标题和分组

### `tests/transcriptUx/sessionIndex.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { getSessionDisplayTitle } from "../../src/transcriptUx/sessionIndex";
import { groupLogsBySessionId } from "../../src/transcriptUx/groupLogs";
import type { SessionLogOption } from "../../src/transcriptUx/types";

function log(input: Partial<SessionLogOption>): SessionLogOption {
  return {
    sessionId: input.sessionId ?? "s1",
    fullPath: input.fullPath ?? "/tmp/s1.jsonl",
    projectPath: input.projectPath ?? "/tmp/project",
    messages: [],
    messageCount: 0,
    createdAt: input.createdAt ?? "2026-05-26T00:00:00.000Z",
    modifiedAt: input.modifiedAt ?? "2026-05-26T00:00:00.000Z",
    isLite: true,
    ...input,
  };
}

describe("getSessionDisplayTitle", () => {
  test("prefers custom title", () => {
    expect(
      getSessionDisplayTitle(
        log({
          customTitle: "My title",
          firstPrompt: "Original prompt",
        }),
      ),
    ).toBe("My title");
  });
});

describe("groupLogsBySessionId", () => {
  test("groups and sorts forks by modified time", () => {
    const grouped = groupLogsBySessionId([
      log({ sessionId: "s1", modifiedAt: "2026-05-26T01:00:00.000Z" }),
      log({ sessionId: "s1", modifiedAt: "2026-05-26T02:00:00.000Z" }),
    ]);

    expect(grouped.get("s1")?.[0]?.modifiedAt).toBe(
      "2026-05-26T02:00:00.000Z",
    );
  });
});
```

## 测试：搜索文本

### `tests/transcriptUx/searchText.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { messageSearchText } from "../../src/transcriptUx/searchText";
import type { ChatMessage } from "../../src/chat/types";

function user(text: string): ChatMessage {
  return {
    id: "u1",
    role: "user",
    type: "message",
    content: [{ type: "text", text }],
  };
}

describe("messageSearchText", () => {
  test("strips system reminders", () => {
    const text = messageSearchText(
      user("<system-reminder>hidden</system-reminder>visible"),
    );

    expect(text).toBe("visible");
  });

  test("does not index compact summaries", () => {
    expect(
      messageSearchText({
        ...user("summary text"),
        isCompactSummary: true,
      }),
    ).toBe("");
  });
});
```

## 测试：conversation fork

### `tests/transcriptUx/conversationFork.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { forkConversationBeforeMessage } from "../../src/transcriptUx/conversationFork";
import type { ChatMessage } from "../../src/chat/types";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
): ChatMessage {
  return {
    id,
    role,
    type: "message",
    content: [{ type: "text", text }],
  };
}

describe("forkConversationBeforeMessage", () => {
  test("truncates before selected user message and restores input", () => {
    const selected = message("u2", "user", "try again");
    const messages = [
      message("u1", "user", "start"),
      message("a1", "assistant", "ok"),
      selected,
      message("a2", "assistant", "done"),
    ];

    const result = forkConversationBeforeMessage({ messages, message: selected });

    expect(result?.messages.map(item => item.id)).toEqual(["u1", "a1"]);
    expect(result?.inputText).toBe("try again");
    expect(result?.conversationId).toBeTruthy();
  });
});
```

## 测试：direct edit guard

```ts
import { describe, expect, test } from "bun:test";
import { canDirectEdit } from "../../src/transcriptUx/directEdit";
import type { ChatMessage } from "../../src/chat/types";

function user(id: string): ChatMessage {
  return {
    id,
    role: "user",
    type: "message",
    content: [{ type: "text", text: "hello" }],
  };
}

function interrupted(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    type: "message",
    content: [{ type: "text", text: "[Request interrupted by user]" }],
  };
}

describe("canDirectEdit", () => {
  test("allows direct edit when only synthetic messages follow", () => {
    expect(
      canDirectEdit({
        messages: [user("u1"), interrupted("a1")],
        selectedIndex: 0,
        hasFileChangesAfter: false,
      }),
    ).toBe(true);
  });

  test("requires confirmation when file changes exist", () => {
    expect(
      canDirectEdit({
        messages: [user("u1"), interrupted("a1")],
        selectedIndex: 0,
        hasFileChangesAfter: true,
      }),
    ).toBe(false);
  });
});
```

## 测试：partial summarize

```ts
import { describe, expect, test } from "bun:test";
import { partialSummarizeConversation } from "../../src/transcriptUx/partialSummarize";
import type { ChatMessage } from "../../src/chat/types";

function text(id: string, role: "user" | "assistant", value: string): ChatMessage {
  return {
    id,
    role,
    type: "message",
    content: [{ type: "text", text: value }],
  };
}

describe("partialSummarizeConversation", () => {
  test("summarizes from pivot and keeps previous messages", async () => {
    const pivot = text("u2", "user", "new direction");
    const result = await partialSummarizeConversation({
      messages: [text("u1", "user", "old"), text("a1", "assistant", "ok"), pivot],
      pivotMessage: pivot,
      direction: "from",
      compactRange: async () => [text("summary", "user", "summary")],
    });

    expect(result.map(item => item.id)).toEqual(["u1", "a1", "summary"]);
  });
});
```

如果你的实现把 `compactRange` 固定 import，而不是依赖注入，就在测试里 mock 掉 compact 模块。

## 手动验证流程

先跑相关测试：

```bash
bun test tests/transcriptUx
```

再跑类型检查：

```bash
bun run typecheck
```

手动验证：

```bash
bun run dev
```

然后检查：

```txt
1. 创建两个普通会话。
2. 执行 /resume，确认 session picker 出现。
3. 输入关键词，确认标题搜索生效。
4. 打开一个包含较多历史的会话，确认 preview 能加载。
5. 对 session 执行 rename，退出再进，确认标题仍存在。
6. 在当前会话里进入 message actions。
7. 选择一条用户消息 edit，确认输入框被填回原 prompt。
8. 对有文件变更的历史消息执行 rewind，确认出现 code/conversation/both 选择。
9. 选择 summarize from here，确认消息被部分压缩。
10. 再次发送新 prompt，确认 transcript 仍然 append-only。
```

## 常见错误

### 直接修改旧 transcript 行

不要这样做。

重命名、fork、rewind 都应该追加新 entry 或改变 runtime projection。

旧 JSONL 行代表历史事实。

### 搜索 `JSON.stringify(message)`

这会命中用户看不到的内部文本。

搜索文本要从 UI 渲染语义提取。

### 打开 session picker 时全量读所有 transcript

大仓库会非常慢，甚至 OOM。

先用 lite log，preview 时再 load full。

### 编辑历史消息时覆盖原消息

编辑历史输入不是修改那条 user message。

正确做法是 fork 到它之前，把文本放回输入框。

### 忘记恢复 permission mode

如果历史消息是在某个 permission mode 下发出的，rewind 后继续应该尽量恢复当时的模式。

否则用户可能发现工具权限行为突然变了。

### 只恢复 conversation，不提醒 code 未恢复

这会让用户以为回到了历史状态，但文件其实还是当前状态。

UI 必须明确显示 code 是否会恢复。

### partial compact 选中已被 snip 的消息

如果用户选中的消息不在 active context 里，要提示“这条消息已经不在活跃上下文中”，不要静默 no-op。

## 和官方能力的差距

本章完成后，Mini 的历史操作体验会更接近官方，但仍有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| session picker | 有 | tag tabs、worktree filter、branch filter、agentic search |
| preview | 有 | 复用完整 transcript renderer |
| rename | append custom title | AI title 与用户 title 优先级完整处理 |
| deep search | substring | Fuse fuzzy search + snippet 高亮 |
| message actions | copy/edit 基础动作 | 光标模式、expand/collapse、copy primary tool input |
| edit prompt | rewind + fill input | pasted images、mode、permission、stream interrupt 全恢复 |
| restore code | file snapshot | 文件 diff UI 和不可恢复文件提示 |
| partial compact | 基础 from/up-to | compact boundary、hook results、prompt cache cleanup |
| fork grouping | session id 分组 | parent/fork metadata 与跨 worktree 展示 |

下一步如果继续贴近官方，最值得补的是：

1. Agentic session search：让模型根据自然语言问题从历史会话里找结果。
2. Transcript overlay：在聊天过程中按快捷键展开完整历史，不离开当前输入状态。
3. Cross-project resume：跨项目列出和恢复 session。
4. Teleport resume：从远端或分享链接恢复 session。
5. Transcript sharing：用户授权后导出脱敏 transcript。

## 本章小结

第 44 章让历史“可靠”。

第 47 章让历史“可用”。

现在 Mini 已经有一条接近官方 Claude Code 的历史闭环：

```txt
append-only transcript
  -> lite session index
  -> searchable session picker
  -> read-only preview
  -> resume
  -> message actions
  -> edit historical prompt
  -> restore conversation/code
  -> partial compact
  -> append new branch
```

这条链路的核心原则是：

- 历史事实不改写。
- UI 操作改变 projection 或追加事件。
- 搜索只索引用户能看到的文本。
- 恢复 conversation 和恢复 code 是两个独立选择。
- 编辑历史输入等价于从历史点 fork，而不是篡改旧消息。

到这里，Mini 的长会话能力已经不只是“能继续”，而是可以像一个成熟 CLI 一样管理、搜索、预览、修正和分叉自己的工作历史。

下一章可以继续补 **跨项目恢复、Session 分享与 Teleport Resume**：让 session 不只在当前本机当前仓库内可恢复，还能跨工作区、跨机器或通过链接继续。
