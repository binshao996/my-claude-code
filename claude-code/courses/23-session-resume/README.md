# 第 23 章：会话列表、/resume 与 /continue

上一章已经把对话写成 JSONL transcript。本章继续补上另一个关键能力：让 Mini 版 CLI 能从 transcript 里把会话接回来。

在真实工程里，这条链路不是单纯“读文件再塞给模型”。它至少包含四件事：

1. 找到可恢复的会话。
2. 从 transcript 中还原当前分支的消息链。
3. 清理不适合继续发送的历史消息。
4. 把恢复后的消息作为初始上下文交给对话循环。

这一章我们先实现 Mini 版，不追求覆盖真实工程的全部边界，但要把结构搭对。后续章节再继续补工具调用、压缩上下文、文件快照、工作区恢复等能力。

## 真实工程怎么做

先看真实工程的恢复路径，方便确定 Mini 版的边界。

- `src/main.tsx` 负责解析 `--continue` 和 `--resume`。
- `--continue` 会加载当前项目最近一个可恢复会话。
- `--resume <value>` 可以按 session id、JSONL 文件路径、标题匹配或交互列表恢复。
- `src/utils/sessionStorage.ts` 负责读 transcript、找最新 leaf、按 `parentUuid` 还原消息链。
- `src/utils/conversationRecovery.ts` 负责把 JSONL 里的记录转换回消息，并过滤损坏或不完整的历史。
- `src/utils/sessionRestore.ts` 负责切换 session id、恢复成本统计、工作区、agent 配置等运行态信息。
- `src/QueryEngine.ts` 接收 `initialMessages`，并把它作为新一轮对话的起始消息数组。

Mini 版不用一次性实现这些高级状态。我们先实现：

- `sessions`：列出当前项目最近会话。
- `/continue`：恢复当前项目最近会话。
- `/resume <sessionId | path>`：恢复指定会话。
- `--continue` 和 `--resume`：启动时直接恢复。
- `initialMessages`：把恢复出的消息交给 AgentLoop。

## 本章目标

完成后，用户可以这样使用：

```bash
bun run dev -- --continue
bun run dev -- --resume 9e6f2a3c-7a1b-4b54-97f4-2b2d3b94d2d8
bun run dev -- --resume ~/.cc-mini/projects/my-project/9e6f2a3c-7a1b-4b54-97f4-2b2d3b94d2d8.jsonl
```

在交互界面里也可以这样用：

```text
/sessions
/continue
/resume 9e6f2a3c-7a1b-4b54-97f4-2b2d3b94d2d8
```

恢复后，新的用户输入应该带着历史消息一起进入模型请求。

## 推荐目录

这一章可以新增这些文件：

```text
src/session/sessionState.ts
src/transcript/sessionList.ts
src/transcript/resume.ts
src/commands/sessions.ts
src/commands/resume.ts
src/commands/continue.ts
```

如果你的 Mini 项目还没有命令分层，也可以先把 `/sessions`、`/resume`、`/continue` 接到现有 REPL 命令解析里。重点不是文件数量，而是职责边界：

- `sessionState.ts` 管当前运行中的 session id。
- `sessionList.ts` 只负责扫描 transcript 文件并提取摘要。
- `resume.ts` 只负责从 transcript 还原消息。
- command 文件只负责把用户输入转换成调用。

## 运行中的 session id

上一章写 transcript 时通常已经需要 session id。如果还没有集中管理，可以先补一个简单模块。

```ts
// src/session/sessionState.ts
import { randomUUID } from "node:crypto";

let currentSessionId = process.env.CCMINI_SESSION_ID ?? randomUUID();
let resumedFromSessionId: string | null = null;

export function getSessionId(): string {
  return currentSessionId;
}

export function switchSession(sessionId: string): void {
  currentSessionId = sessionId;
  process.env.CCMINI_SESSION_ID = sessionId;
}

export function forkSession(): string {
  resumedFromSessionId = currentSessionId;
  currentSessionId = randomUUID();
  process.env.CCMINI_SESSION_ID = currentSessionId;
  return currentSessionId;
}

export function getResumedFromSessionId(): string | null {
  return resumedFromSessionId;
}
```

这里有两个恢复模式：

- 普通恢复：继续使用原 session id，后续 transcript 继续写回同一个 JSONL。
- fork 恢复：生成新 session id，但初始消息来自旧会话。

Mini 版可以先只做普通恢复。fork 是安全能力，适合用户想基于旧会话开一个分支，但不想污染原 transcript。

## 会话列表

会话列表不要完整读取每个 JSONL。真实工程会先用文件 stat 做排序分页，然后只读每个文件的头尾片段提取摘要。Mini 版也可以用这个思路。

先定义列表项：

```ts
// src/transcript/sessionList.ts
export type SessionSummary = {
  sessionId: string;
  path: string;
  summary: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  createdAt: string | null;
  lastModified: Date;
  fileSize: number;
};
```

扫描当前项目的 transcript 目录：

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const SAMPLE_BYTES = 64 * 1024;

export async function listSessions(
  transcriptDir: string,
  limit = 20,
): Promise<SessionSummary[]> {
  const names = await readdir(transcriptDir).catch(() => []);
  const jsonlNames = names.filter((name) => name.endsWith(".jsonl"));

  const files = await Promise.all(
    jsonlNames.map(async (name) => {
      const path = join(transcriptDir, name);
      const info = await stat(path);
      return { path, info };
    }),
  );

  const newest = files
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    .slice(0, limit);

  return Promise.all(
    newest.map(async ({ path, info }) => {
      const sample = await readHeadTail(path);
      return parseSessionSummary(path, sample, info);
    }),
  );
}
```

`readHeadTail` 只拿文件开头和末尾：

```ts
async function readHeadTail(path: string): Promise<string> {
  const content = await readFile(path, "utf8");

  if (content.length <= SAMPLE_BYTES * 2) {
    return content;
  }

  return [
    content.slice(0, SAMPLE_BYTES),
    "\n",
    content.slice(-SAMPLE_BYTES),
  ].join("");
}
```

这段实现为了课程可读性直接用了 `readFile`。如果 transcript 很大，可以改成 `open` + `read`，只读取指定 byte range。先把行为做对，再做大文件优化。

摘要解析可以从 JSONL 里提取第一条用户输入和最后一条用户输入：

```ts
function parseSessionSummary(
  path: string,
  sample: string,
  info: { mtime: Date; size: number },
): SessionSummary {
  const sessionId = basename(path, ".jsonl");
  const entries = sample
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((entry): entry is TranscriptEntry => entry !== null);

  const userMessages = entries
    .filter((entry) => entry.type === "message")
    .filter((entry) => entry.message.role === "user");

  const firstPrompt = userMessages.at(0)?.message.content ?? null;
  const lastPrompt = userMessages.at(-1)?.message.content ?? null;

  return {
    sessionId,
    path,
    summary: lastPrompt ?? firstPrompt ?? sessionId,
    firstPrompt,
    lastPrompt,
    createdAt: entries.at(0)?.timestamp ?? null,
    lastModified: info.mtime,
    fileSize: info.size,
  };
}

function parseJsonLine(line: string): TranscriptEntry | null {
  try {
    return JSON.parse(line) as TranscriptEntry;
  } catch {
    return null;
  }
}
```

这里的 `TranscriptEntry` 应该复用上一章 transcript 模块里的类型，不要复制一份新类型。课程示例为了阅读方便省略了 import。

## 从 JSONL 还原消息链

上一章的 transcript 应该至少包含这些字段：

```ts
type TranscriptMessageEntry = {
  type: "message";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message: {
    role: "user" | "assistant" | "system";
    content: string;
  };
};

type TranscriptEventEntry = {
  type: "event";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  event: {
    name: string;
    data?: Record<string, unknown>;
  };
};

type TranscriptEntry = TranscriptMessageEntry | TranscriptEventEntry;
```

恢复时只把 `message` 记录还原成上下文。`event` 是审计和 UI 信息，不能直接发给模型。

```ts
// src/transcript/resume.ts
import { readFile } from "node:fs/promises";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type RestoredConversation = {
  sessionId: string;
  path: string;
  messages: ChatMessage[];
  lastMessageUuid: string | null;
};

export async function restoreConversationFromPath(
  path: string,
): Promise<RestoredConversation> {
  const entries = await readTranscriptEntries(path);
  const messageEntries = entries.filter(
    (entry): entry is TranscriptMessageEntry => entry.type === "message",
  );

  if (messageEntries.length === 0) {
    throw new Error(`No messages found in transcript: ${path}`);
  }

  const leaf = findLatestLeaf(messageEntries);
  const chain = buildMessageChain(messageEntries, leaf.uuid);
  const messages = deserializeForResume(chain);

  return {
    sessionId: leaf.sessionId,
    path,
    messages,
    lastMessageUuid: leaf.uuid,
  };
}
```

读取 JSONL 时要容忍坏行。单行损坏不应该让整个恢复失败，除非最后没有任何可用消息。

```ts
async function readTranscriptEntries(path: string): Promise<TranscriptEntry[]> {
  const content = await readFile(path, "utf8");
  const entries: TranscriptEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // Ignore broken lines. A future chapter can surface this as a warning.
    }
  }

  return entries;
}
```

## 找最新 leaf

真实 transcript 不是永远一条直线。恢复旧会话、fork、压缩上下文、工具中断都可能让消息形成一棵树。恢复时应该选择当前分支的 leaf。

Mini 版先用“没有子消息的消息”作为 leaf，再按时间选最新的 leaf。

```ts
function findLatestLeaf(
  messages: TranscriptMessageEntry[],
): TranscriptMessageEntry {
  const parentUuids = new Set(
    messages
      .map((message) => message.parentUuid)
      .filter((uuid): uuid is string => uuid !== null),
  );

  const leaves = messages.filter((message) => !parentUuids.has(message.uuid));

  const candidates = leaves.length > 0 ? leaves : messages;

  return candidates.sort((a, b) => {
    return Date.parse(b.timestamp) - Date.parse(a.timestamp);
  })[0];
}
```

这和真实工程的思路一致：先用 parent/child 关系找 leaf，再从 leaf 反向走回根节点。

## 反向还原链路

根据 leaf 的 `parentUuid` 一路向前追：

```ts
function buildMessageChain(
  messages: TranscriptMessageEntry[],
  leafUuid: string,
): TranscriptMessageEntry[] {
  const byUuid = new Map(messages.map((message) => [message.uuid, message]));
  const chain: TranscriptMessageEntry[] = [];
  const seen = new Set<string>();

  let current = byUuid.get(leafUuid);

  while (current) {
    if (seen.has(current.uuid)) {
      throw new Error(`Cycle detected in transcript at ${current.uuid}`);
    }

    seen.add(current.uuid);
    chain.push(current);

    if (current.parentUuid === null) {
      break;
    }

    current = byUuid.get(current.parentUuid);
  }

  return chain.reverse();
}
```

这里有两个刻意的防御：

- `seen` 防止 transcript 异常时出现死循环。
- 父节点缺失时停止恢复已有链路，而不是强行失败。

如果你希望更严格，可以在父节点缺失时抛错。课程版建议先“尽量恢复”，因为 transcript 是用户历史资产。

## 清理恢复后的消息

真实工程会做很多清理：

- 过滤未配对的 tool use。
- 过滤只有 thinking / redacted_thinking、没有可发送内容的 assistant 消息。
- 清理空白 assistant 消息。
- 如果最后一轮被中断，追加“继续刚才任务”的 meta user 消息。
- 如果最后一条可见消息是 user，插入一个不会触发真实回复的 assistant sentinel。

Mini 版先实现两条：

1. 去掉空白 assistant。
2. 如果最后一条是 user，补一个 assistant sentinel，避免恢复出的历史停在半轮请求上。

```ts
function deserializeForResume(
  chain: TranscriptMessageEntry[],
): ChatMessage[] {
  const messages = chain
    .map((entry) => entry.message)
    .filter((message) => {
      if (message.role !== "assistant") return true;
      return message.content.trim().length > 0;
    });

  const last = messages.at(-1);

  if (last?.role === "user") {
    messages.push({
      role: "assistant",
      content: "[No response recorded for the previous user message.]",
    });
  }

  return messages;
}
```

这不是给用户看的正常回复，而是恢复链路里的占位消息。更完整的做法是记录 turn interruption state，然后让下一次请求明确继续上次中断的任务。

## 按 session id 或路径加载

`/resume` 需要同时支持 session id 和 JSONL 路径。

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";

export async function loadConversationForResume(
  source: string | undefined,
  transcriptDir: string,
): Promise<RestoredConversation> {
  if (!source) {
    const sessions = await listSessions(transcriptDir, 1);
    const latest = sessions.at(0);

    if (!latest) {
      throw new Error("No conversation found to continue.");
    }

    return restoreConversationFromPath(latest.path);
  }

  if (source.endsWith(".jsonl")) {
    await assertReadable(source);
    return restoreConversationFromPath(source);
  }

  const path = join(transcriptDir, `${source}.jsonl`);
  await assertReadable(path);
  return restoreConversationFromPath(path);
}

async function assertReadable(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Transcript not found: ${path}`);
  }
}
```

这对应真实工程里的三个入口：

- `source === undefined`：`--continue`，加载最近会话。
- `source` 是 session id：找对应 transcript。
- `source` 是 JSONL 路径：直接读文件。

标题搜索、交互选择器、跨 worktree 搜索都可以后面再加。

## 接到 AgentLoop

AgentLoop 需要接受 `initialMessages`。

```ts
type AgentLoopOptions = {
  initialMessages?: ChatMessage[];
  mode?: "default" | "plan";
};

export class AgentLoop {
  private messages: ChatMessage[];

  constructor(options: AgentLoopOptions = {}) {
    this.messages = options.initialMessages ?? [];
  }

  async ask(input: string): Promise<string> {
    this.messages.push({ role: "user", content: input });

    const response = await this.callModel(this.messages);

    this.messages.push({ role: "assistant", content: response });
    return response;
  }
}
```

如果你是沿着前面 Mini 章节实现的，不要用这里的示例把第 13/15 章的 plan mode 覆盖掉。

`initialMessages` 只是新增恢复入口，应该和已有的 `mode?: "default" | "plan"`、plan mode 工具过滤共存。

恢复启动时：

```ts
const restored = await loadConversationForResume(args.resume, transcriptDir);

switchSession(restored.sessionId);

const agentLoop = new AgentLoop({
  initialMessages: restored.messages,
});
```

这就是恢复的核心闭环：transcript 变回 messages，messages 变成 AgentLoop 的初始状态。

## 实现 /continue

`/continue` 是没有参数的 resume。

```ts
export async function continueLatestConversation(
  transcriptDir: string,
): Promise<RestoredConversation> {
  const restored = await loadConversationForResume(undefined, transcriptDir);
  switchSession(restored.sessionId);
  return restored;
}
```

在 REPL 命令里：

```ts
if (input.trim() === "/continue") {
  const restored = await continueLatestConversation(transcriptDir);
  agentLoop.replaceMessages(restored.messages);
  console.log(`Continued session ${restored.sessionId}`);
  return;
}
```

这里需要给 AgentLoop 补一个 `replaceMessages`：

```ts
replaceMessages(messages: ChatMessage[]): void {
  this.messages = [...messages];
}
```

不要直接把外部数组引用塞进去。恢复后的 messages 进入 AgentLoop 后应该由 AgentLoop 自己维护。

## 实现 /resume

`/resume` 只是多一个参数。

```ts
export async function resumeConversation(
  source: string,
  transcriptDir: string,
): Promise<RestoredConversation> {
  const restored = await loadConversationForResume(source, transcriptDir);
  switchSession(restored.sessionId);
  return restored;
}
```

REPL 命令：

```ts
if (input.startsWith("/resume ")) {
  const source = input.slice("/resume ".length).trim();

  if (!source) {
    console.log("Usage: /resume <sessionId | transcript.jsonl>");
    return;
  }

  const restored = await resumeConversation(source, transcriptDir);
  agentLoop.replaceMessages(restored.messages);
  console.log(`Resumed session ${restored.sessionId}`);
  return;
}
```

真实工程还支持不带参数时弹出选择器。Mini 版可以先不做交互选择器，因为 `/sessions` 已经能列出候选。

## 实现 /sessions

`/sessions` 输出最近会话：

```ts
if (input.trim() === "/sessions") {
  const sessions = await listSessions(transcriptDir, 10);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  for (const session of sessions) {
    const time = session.lastModified.toLocaleString();
    console.log(`${session.sessionId}  ${time}  ${session.summary}`);
  }

  return;
}
```

后面如果有 Ink UI，可以把它做成可选列表。现在先保证命令行可用。

## 接到启动参数

如果你的 Mini CLI 已经有参数解析，新增两个参数：

```ts
type CliArgs = {
  resume?: string;
  continue?: boolean;
};
```

启动时先处理恢复，再创建 AgentLoop：

```ts
let initialMessages: ChatMessage[] = [];

if (args.continue) {
  const restored = await loadConversationForResume(undefined, transcriptDir);
  switchSession(restored.sessionId);
  initialMessages = restored.messages;
} else if (args.resume) {
  const restored = await loadConversationForResume(args.resume, transcriptDir);
  switchSession(restored.sessionId);
  initialMessages = restored.messages;
}

const agentLoop = new AgentLoop({ initialMessages });
```

如果同时传了 `--continue` 和 `--resume`，应该报错：

```ts
if (args.continue && args.resume) {
  throw new Error("Use either --continue or --resume, not both.");
}
```

真实工程里还有 `--fork-session`。Mini 版可以先保留接口设计：

```ts
if (args.forkSession) {
  const oldSessionId = restored.sessionId;
  const newSessionId = forkSession();

  await recordResumeEvent({
    newSessionId,
    resumedFromSessionId: oldSessionId,
  });
}
```

fork 的关键点是：消息历史来自旧会话，但后续 transcript 写入新 session id。

## transcript 目录怎么确定

上一章如果已经做了路径规范，就继续复用。一个常见做法是按项目目录生成 transcript 子目录：

```ts
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function getProjectTranscriptDir(cwd: string): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(homedir(), ".cc-mini", "projects", key);
}
```

不要把完整 cwd 直接作为目录名。路径里可能有空格、斜杠、中文、符号，直接拼文件路径容易出问题。真实工程会做更完整的项目目录编码，Mini 版用 hash 足够。

## 测试清单

建议补这些测试：

```ts
describe("listSessions", () => {
  test("returns sessions newest first", async () => {});
  test("uses last user prompt as summary", async () => {});
  test("ignores broken jsonl lines", async () => {});
});

describe("restoreConversationFromPath", () => {
  test("restores message chain from latest leaf", async () => {});
  test("ignores transcript event entries", async () => {});
  test("stops safely when parent is missing", async () => {});
  test("throws when transcript contains a parent cycle", async () => {});
  test("adds assistant sentinel when last message is user", async () => {});
});

describe("loadConversationForResume", () => {
  test("loads latest session when source is undefined", async () => {});
  test("loads by session id", async () => {});
  test("loads by jsonl path", async () => {});
});
```

对应命令：

```bash
bun test src/transcript/__tests__/sessionList.test.ts
bun test src/transcript/__tests__/resume.test.ts
bun run typecheck
```

## 常见问题

### 为什么恢复时忽略 event？

因为 event 是运行记录，不是模型上下文。比如 token 统计、命令执行状态、UI 状态都可能记录为 event。直接发给模型会污染上下文。

### 为什么不读取所有会话全文？

会话可能很多，每个 transcript 也可能很大。列表只需要摘要，所以应该读 stat、头部和尾部。只有真正 resume 时才读完整文件。

### /continue 和 /resume 有什么区别？

`/continue` 没有参数，恢复当前项目最近会话。

`/resume` 有参数，恢复指定 session id 或 JSONL 文件。

### 为什么需要 parentUuid？

没有 `parentUuid` 时，恢复只能按文件顺序取全部消息。一旦出现 fork、压缩、重写、撤销，就不知道当前分支是哪一条。`parentUuid` 让 transcript 可以表达消息树。

### transcript 损坏怎么办？

列表和读取都应该尽量容忍坏行。只要能还原出一条有效消息链，就允许继续。可以同时在 UI 中提示“部分历史无法读取”。

### 恢复后要不要立刻请求模型？

通常不要。恢复只是把历史装载回 AgentLoop。用户下一次输入时，再把历史和新输入一起发送给模型。

如果上一轮明显中断，可以提供单独的“继续上次任务”命令，或者像真实工程一样记录 interruption state，由恢复逻辑决定是否追加继续提示。

## 本章完成标准

完成后应满足：

- `bun run dev -- --continue` 能恢复当前项目最近会话。
- `bun run dev -- --resume <sessionId>` 能恢复指定会话。
- `/sessions` 能列出最近会话摘要。
- `/continue` 能在 REPL 内恢复最近会话。
- `/resume <sessionId | path>` 能在 REPL 内恢复指定会话。
- 恢复后的下一次用户输入会带上历史 messages。
- JSONL 中的 event 不会进入模型上下文。
- 损坏的 JSONL 单行不会导致整个恢复失败。
- `bun run typecheck` 通过。

第二十三章到这里，Mini 版已经具备“能记住，也能接回来”的基础能力。下一章可以继续做上下文压缩和长会话治理：当历史越来越长时，如何压缩、裁剪、保留关键事实，并让恢复后的会话仍然稳定可用。
