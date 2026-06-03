# 第 44 章：会话持久化、恢复与 rewind

第四十三章完成了 API 错误恢复：retry、rate limit、streaming fallback、model fallback、max output recovery 和 prompt-too-long recovery。

这些能力让一次请求更可靠，但还没有让一个长会话可靠。真正接近官方 Claude Code 的 CLI，必须能处理更现实的情况：

- 进程崩溃后，用户可以继续原来的会话。
- streaming fallback 已经显示过的 partial assistant message 不会污染后续请求。
- 工具调用中断后，`tool_use` 和 `tool_result` 仍然成对。
- 用户可以回到某条历史消息继续，也可以把文件恢复到那一刻。
- transcript 很大时，恢复不会把整个进程拖垮。
- session metadata、agent 设置、工作区状态、成本统计等不会因为 resume 丢失。

本章要把前面第 22、23 章的基础 transcript/resume，升级成一个可靠的会话系统。

## 本章目标

完成本章后，Mini 会新增：

1. `src/session/types.ts`：统一定义 transcript entry、checkpoint、恢复状态。
2. `src/session/paths.ts`：稳定生成项目级 session 路径。
3. `src/session/transcript.ts`：带写队列和 flush 的 JSONL append-only writer。
4. `src/session/projector.ts`：从 JSONL 投影出当前有效消息链。
5. `src/session/pairing.ts`：修复 `tool_use` / `tool_result` 配对。
6. `src/session/recovery.ts`：恢复中断 turn、partial stream、orphan thinking。
7. `src/session/resume.ts`：实现 `--resume`、`--continue` 和 `/resume` 的核心逻辑。
8. `src/session/rewind.ts`：实现 rewind 到历史 user message。
9. `src/session/fileSnapshots.ts`：在文件修改前创建快照，支持 code rewind。
10. `src/session/doctor.ts`：检查 transcript 是否可恢复。
11. 对 Agent Loop、工具执行和命令层的接入。
12. 关键测试：写入顺序、tombstone、恢复、rewind、崩溃恢复、tool pairing。

本章不是再写一个“聊天记录保存”。它的目标是让会话记录成为运行时事实来源。

## 本章完成效果

启动一个新会话：

```bash
bun run dev
```

查看当前 session：

```txt
> /session
Session: 5a7f6c10-8f2f-4b0c-92c8-0e6a11111111
Transcript: ~/.cc-mini/projects/-Users-you-demo/5a7f6c10-8f2f-4b0c-92c8-0e6a11111111.jsonl
Messages: 18
Checkpoints: 4
Restorable files: 3
```

从最近会话继续：

```bash
bun run dev -- --continue
```

按 session id 恢复：

```bash
bun run dev -- --resume 5a7f6c10-8f2f-4b0c-92c8-0e6a11111111
```

恢复到某条用户消息继续：

```txt
> /rewind 97e0d6a2-9f2f-4e2f-9d3c-111111111111
Rewound conversation to selected message.
```

把文件也恢复到那一刻：

```txt
> /rewind 97e0d6a2-9f2f-4e2f-9d3c-111111111111 --files
Rewound conversation and restored 2 files.
```

检查 transcript：

```bash
bun run src/session/doctor.ts ~/.cc-mini/projects/-Users-you-demo/5a7f6c10-8f2f-4b0c-92c8-0e6a11111111.jsonl
```

## 先明确边界

第 22 章已经实现：

- debug log。
- event log。
- JSONL transcript。
- 基础 reader。

第 23 章已经实现：

- 会话列表。
- `/resume`。
- `/continue`。
- 把 transcript 还原成 `initialMessages`。

本章补的是官方级可靠性：

- 不完整 streaming message 的删除或隔离。
- crash 后的 turn interruption 检测。
- tool pair repair。
- parent chain 和 checkpoint。
- rewind。
- 文件快照。
- 大文件读取上限。
- 写队列和 flush。
- resume 后运行态恢复。

也就是说，第 22、23 章像“能读写历史”。第 44 章像“历史可以作为恢复协议”。

## 真实工程给我们的关键启发

真实工程的核心不是一个 `saveMessages()`。

它至少包含这些机制：

- transcript 路径按项目隔离，形如 `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`。
- message entry 是 append-only JSONL，每条消息带 `uuid`、`parentUuid`、`sessionId`、`cwd`、`timestamp`、`version`。
- `Project` writer 内部有按文件分组的写队列，批量 flush，避免并发 append 乱序。
- transcript raw 读取有上限，真实工程用 50MB guard 和 head/tail/lite metadata 策略。
- resume 时不是全量数组直接塞回模型，而是先找 leaf，再沿 `parentUuid` 构造当前链。
- streaming fallback 时，已经显示的 assistant partial 会被 tombstone，从 UI 和 transcript 里移除。
- resume 时会过滤 unresolved tool use、orphan thinking-only message、whitespace-only assistant。
- 如果中断时最后停在 `tool_use`，恢复前要生成 synthetic `tool_result`，否则 API 会拒绝。
- 文件 rewind 依赖每个用户消息前后的 file history snapshot，不依赖 git commit。
- session metadata 会在退出时重新 append 到文件尾部，让 resume 列表可以只读 tail 就拿到标题、tag、agent、mode。

Mini 不需要一次复制所有内部细节，但结构要按这些事实设计。

## 会话可靠性的三层模型

我们把系统拆成三层：

```txt
Runtime state
  当前内存里的 messages、session id、tool state、file history

Append log
  JSONL transcript，每行是不可变 entry

Projection
  从 append log 还原出“当前有效会话”的算法
```

可靠性来自第三层。

如果只保存 `messages.json`，崩溃时很难判断：

- 哪些 message 是 streaming fallback 的旧尝试。
- 哪些 tool result 是孤儿。
- 哪些 message 已被 rewind 排除。
- 文件快照对应哪条用户消息。

JSONL append log 允许我们记录事实：

```txt
message A
message B
tombstone B
checkpoint C
file_snapshot C
rewind_to C
message D
```

Projection 决定最终可见历史：

```txt
A, C, D
```

## 推荐目录

新增：

```txt
src/
  session/
    types.ts
    paths.ts
    transcript.ts
    projector.ts
    pairing.ts
    recovery.ts
    resume.ts
    rewind.ts
    fileSnapshots.ts
    doctor.ts
    __tests__/
      transcript.test.ts
      projector.test.ts
      pairing.test.ts
      recovery.test.ts
      rewind.test.ts
      fileSnapshots.test.ts
```

修改：

```txt
src/
  agent/
    agentLoop.ts
  llm/
    resilientAnthropic.ts
  tools/
    fileEdit.ts
    fileWrite.ts
  commands/
    session.ts
    resume.ts
    rewind.ts
  cli.ts
```

如果你的 Mini 当前文件名不同，按现有结构接入即可。重点是模块职责，不是路径完全一致。

## 第一步：统一 session 类型

创建 `src/session/types.ts`：

```ts
export type SessionId = string;
export type MessageId = string;
export type ToolUseId = string;

export type Role = "user" | "assistant" | "system";

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: ToolUseId;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: ToolUseId;
  content: string;
  is_error?: boolean;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

export type RedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

export type ChatMessage = {
  uuid: MessageId;
  role: Role;
  content: string | ContentBlock[];
  createdAt: string;
  isMeta?: boolean;
  isApiError?: boolean;
};

export type TranscriptMessageEntry = {
  type: "message";
  sessionId: SessionId;
  uuid: MessageId;
  parentUuid: MessageId | null;
  cwd: string;
  timestamp: string;
  version: string;
  message: ChatMessage;
};

export type TombstoneEntry = {
  type: "tombstone";
  sessionId: SessionId;
  targetUuid: MessageId;
  reason:
    | "streaming_fallback"
    | "model_fallback"
    | "rewind"
    | "manual_delete";
  timestamp: string;
};

export type CheckpointEntry = {
  type: "checkpoint";
  sessionId: SessionId;
  messageId: MessageId;
  parentUuid: MessageId | null;
  label?: string;
  timestamp: string;
};

export type RewindEntry = {
  type: "rewind";
  sessionId: SessionId;
  targetMessageId: MessageId;
  restoreFiles: boolean;
  timestamp: string;
};

export type SessionMetaEntry = {
  type: "session_meta";
  sessionId: SessionId;
  timestamp: string;
  title?: string;
  lastPrompt?: string;
  cwd?: string;
  model?: string;
  mode?: string;
  agent?: string;
};

export type CostEntry = {
  type: "cost";
  sessionId: SessionId;
  timestamp: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export type FileBackup = {
  backupFileName: string | null;
  version: number;
  backupTime: string;
};

export type FileSnapshot = {
  messageId: MessageId;
  trackedFileBackups: Record<string, FileBackup>;
  timestamp: string;
};

export type FileSnapshotEntry = {
  type: "file_snapshot";
  sessionId: SessionId;
  messageId: MessageId;
  snapshot: FileSnapshot;
  isUpdate: boolean;
  timestamp: string;
};

export type TranscriptEntry =
  | TranscriptMessageEntry
  | TombstoneEntry
  | CheckpointEntry
  | RewindEntry
  | SessionMetaEntry
  | CostEntry
  | FileSnapshotEntry;

export type SessionProjection = {
  sessionId: SessionId;
  messages: ChatMessage[];
  entries: TranscriptEntry[];
  checkpoints: CheckpointEntry[];
  fileSnapshots: FileSnapshot[];
  meta: SessionMetaEntry | null;
  interrupted: boolean;
  repairs: SessionRepair[];
};

export type SessionRepair = {
  kind:
    | "missing_tool_result"
    | "orphan_tool_result"
    | "orphan_thinking"
    | "empty_assistant"
    | "interrupted_turn";
  message: string;
  messageId?: MessageId;
  toolUseId?: ToolUseId;
};
```

这里刻意没有把 UI progress 放进 transcript message。

原因是 progress 是临时渲染状态，不应该参与 `parentUuid` 链。真实工程也避免让 progress 进入恢复链，否则旧 transcript 里 progress 可能成为 parent，导致真正的会话消息断链。

## 第二步：稳定路径

创建 `src/session/paths.ts`：

```ts
import { join } from "node:path";
import { homedir } from "node:os";

export function getConfigHome(): string {
  return process.env.CCMINI_HOME ?? join(homedir(), ".cc-mini");
}

export function sanitizeProjectPath(cwd: string): string {
  return cwd
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/\//g, "-")
    .replace(/-+/g, "-");
}

export function getProjectsDir(): string {
  return join(getConfigHome(), "projects");
}

export function getProjectSessionDir(cwd: string): string {
  return join(getProjectsDir(), sanitizeProjectPath(cwd));
}

export function getTranscriptPath(cwd: string, sessionId: string): string {
  return join(getProjectSessionDir(cwd), `${sessionId}.jsonl`);
}

export function getFileHistoryDir(sessionId: string): string {
  return join(getConfigHome(), "file-history", sessionId);
}
```

路径策略要满足：

- 同一个项目的 session 在同一目录。
- session id 对应一个 JSONL 文件。
- 文件快照按 session id 存储。
- 不把原始路径当文件名。

真实工程使用 `sanitizePath()` 而不是 hash，方便人工定位。Mini 可以沿用这种可读策略。

## 第三步：实现 append-only writer

创建 `src/session/transcript.ts`：

```ts
import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MessageId, TranscriptEntry } from "./types";

const FLUSH_INTERVAL_MS = 100;
const MAX_QUEUE_LENGTH = 1000;
const MAX_CHUNK_BYTES = 100 * 1024 * 1024;
const TAIL_READ_BYTES = 64 * 1024;
const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024;

type QueuedWrite = {
  entry: TranscriptEntry;
  resolve: () => void;
};

export class TranscriptWriter {
  private queues = new Map<string, QueuedWrite[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDrain: Promise<void> | null = null;

  append(path: string, entry: TranscriptEntry): Promise<void> {
    return new Promise((resolve) => {
      const queue = this.queues.get(path) ?? [];

      if (queue.length >= MAX_QUEUE_LENGTH) {
        const dropped = queue.splice(0, queue.length - MAX_QUEUE_LENGTH + 1);
        for (const item of dropped) {
          item.resolve();
        }
      }

      queue.push({ entry, resolve });
      this.queues.set(path, queue);
      this.scheduleDrain();
    });
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.activeDrain) {
      await this.activeDrain;
    }

    await this.drain();
  }

  async removeMessage(path: string, targetUuid: MessageId): Promise<void> {
    await this.flush();

    try {
      const info = await stat(path);
      if (info.size === 0) {
        return;
      }

      const handle = await open(path, "r+");
      try {
        const chunkLength = Math.min(info.size, TAIL_READ_BYTES);
        const tailStart = info.size - chunkLength;
        const buffer = Buffer.allocUnsafe(chunkLength);
        const read = await handle.read(buffer, 0, chunkLength, tailStart);
        const tail = buffer.subarray(0, read.bytesRead);

        const needle = `"uuid":"${targetUuid}"`;
        const matchIndex = tail.lastIndexOf(needle);

        if (matchIndex >= 0) {
          const previousNewline = tail.lastIndexOf(0x0a, matchIndex);
          const canFindLineStart = previousNewline >= 0 || tailStart === 0;

          if (canFindLineStart) {
            const lineStart = previousNewline + 1;
            const nextNewline = tail.indexOf(0x0a, matchIndex + needle.length);
            const lineEnd = nextNewline >= 0 ? nextNewline + 1 : read.bytesRead;
            const absoluteStart = tailStart + lineStart;
            const afterLength = read.bytesRead - lineEnd;

            await handle.truncate(absoluteStart);
            if (afterLength > 0) {
              await handle.write(tail, lineEnd, afterLength, absoluteStart);
            }
            return;
          }
        }
      } finally {
        await handle.close();
      }

      if (info.size > MAX_TOMBSTONE_REWRITE_BYTES) {
        return;
      }

      const content = await readFile(path, "utf8");
      const kept = content.split("\n").filter((line) => {
        if (!line.trim()) {
          return true;
        }
        try {
          const parsed = JSON.parse(line) as { uuid?: string };
          return parsed.uuid !== targetUuid;
        } catch {
          return true;
        }
      });

      await writeFile(path, kept.join("\n"), "utf8");
    } catch {
      // Best effort. Tombstone is recovery hygiene, not a reason to kill the CLI.
    }
  }

  private scheduleDrain(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.activeDrain = this.drain().finally(() => {
        this.activeDrain = null;
        if (this.queues.size > 0) {
          this.scheduleDrain();
        }
      });
    }, FLUSH_INTERVAL_MS);
  }

  private async drain(): Promise<void> {
    for (const [path, queue] of this.queues) {
      if (queue.length === 0) {
        continue;
      }

      const batch = queue.splice(0);
      let chunk = "";
      const resolvers: Array<() => void> = [];

      for (const item of batch) {
        const line = `${JSON.stringify(item.entry)}\n`;

        if (chunk.length + line.length >= MAX_CHUNK_BYTES) {
          await appendJsonl(path, chunk);
          for (const resolve of resolvers) {
            resolve();
          }
          chunk = "";
          resolvers.length = 0;
        }

        chunk += line;
        resolvers.push(item.resolve);
      }

      if (chunk.length > 0) {
        await appendJsonl(path, chunk);
        for (const resolve of resolvers) {
          resolve();
        }
      }

      if (queue.length === 0) {
        this.queues.delete(path);
      }
    }
  }
}

async function appendJsonl(path: string, data: string): Promise<void> {
  try {
    await appendFile(path, data, { mode: 0o600 });
  } catch {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, data, { mode: 0o600 });
  }
}

export const transcriptWriter = new TranscriptWriter();
```

关键点：

- UI 不等待每条写入落盘。
- `flush()` 在退出、resume 切换、测试里使用。
- tombstone 优先读 tail，避免大文件全量 rewrite。
- 文件权限用 `0o600`，目录用 `0o700`。

## 第四步：记录消息和 metadata

继续在 `src/session/transcript.ts` 里加高层 API：

```ts
import { randomUUID } from "node:crypto";
import { cwd } from "node:process";
import { getTranscriptPath } from "./paths";
import type {
  ChatMessage,
  CheckpointEntry,
  FileSnapshot,
  MessageId,
  SessionId,
  SessionMetaEntry,
  TombstoneEntry,
  TranscriptMessageEntry,
} from "./types";

const VERSION = "mini-dev";

let currentSessionId: SessionId = process.env.CCMINI_SESSION_ID ?? randomUUID();
let currentTranscriptPath = getTranscriptPath(cwd(), currentSessionId);
let lastParentUuid: MessageId | null = null;

export function getSessionId(): SessionId {
  return currentSessionId;
}

export function getCurrentTranscriptPath(): string {
  return currentTranscriptPath;
}

export function switchSession(sessionId: SessionId, projectCwd = cwd()): void {
  currentSessionId = sessionId;
  currentTranscriptPath = getTranscriptPath(projectCwd, sessionId);
  process.env.CCMINI_SESSION_ID = sessionId;
  lastParentUuid = null;
}

export async function recordMessage(message: ChatMessage): Promise<void> {
  const entry: TranscriptMessageEntry = {
    type: "message",
    sessionId: currentSessionId,
    uuid: message.uuid,
    parentUuid: lastParentUuid,
    cwd: cwd(),
    timestamp: new Date().toISOString(),
    version: VERSION,
    message,
  };

  await transcriptWriter.append(currentTranscriptPath, entry);
  lastParentUuid = message.uuid;

  if (message.role === "user" && !message.isMeta) {
    await recordCheckpoint(message.uuid, entry.parentUuid);
    await recordSessionMeta({
      lastPrompt: stringifyMessageContent(message.content).slice(0, 300),
    });
  }
}

export async function recordCheckpoint(
  messageId: MessageId,
  parentUuid: MessageId | null,
): Promise<void> {
  const entry: CheckpointEntry = {
    type: "checkpoint",
    sessionId: currentSessionId,
    messageId,
    parentUuid,
    timestamp: new Date().toISOString(),
  };

  await transcriptWriter.append(currentTranscriptPath, entry);
}

export async function recordTombstone(
  targetUuid: MessageId,
  reason: TombstoneEntry["reason"],
): Promise<void> {
  const entry: TombstoneEntry = {
    type: "tombstone",
    sessionId: currentSessionId,
    targetUuid,
    reason,
    timestamp: new Date().toISOString(),
  };

  await transcriptWriter.append(currentTranscriptPath, entry);
  await transcriptWriter.removeMessage(currentTranscriptPath, targetUuid);
}

export async function recordSessionMeta(
  meta: Omit<SessionMetaEntry, "type" | "sessionId" | "timestamp">,
): Promise<void> {
  const entry: SessionMetaEntry = {
    type: "session_meta",
    sessionId: currentSessionId,
    timestamp: new Date().toISOString(),
    cwd: cwd(),
    ...meta,
  };

  await transcriptWriter.append(currentTranscriptPath, entry);
}

export async function recordFileSnapshot(snapshot: FileSnapshot, isUpdate: boolean): Promise<void> {
  await transcriptWriter.append(currentTranscriptPath, {
    type: "file_snapshot",
    sessionId: currentSessionId,
    messageId: snapshot.messageId,
    snapshot,
    isUpdate,
    timestamp: new Date().toISOString(),
  });
}

export async function flushSession(): Promise<void> {
  await transcriptWriter.flush();
}

function stringifyMessageContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
```

这里有一个重要取舍：`recordTombstone()` 既写入 tombstone entry，又尝试从文件里删掉 target message。

为什么还要写 tombstone？

- 删除是 best effort，可能因为文件太大或 IO 失败跳过。
- tombstone entry 是语义事实，projection 时仍然可以排除 target。
- UI 也可以立即删除对应 message。

真实工程里 tombstone control message 会让 REPL 从 UI messages 里移除该对象，并调用 `removeTranscriptMessage(uuid)` 做落盘清理。Mini 这个设计保留了同样的双保险。

## 第五步：读取 JSONL

创建 `src/session/projector.ts`：

```ts
import { open, readFile, stat } from "node:fs/promises";
import type { TranscriptEntry } from "./types";

export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024;
const LITE_READ_BYTES = 64 * 1024;

export async function readTranscriptEntries(path: string): Promise<TranscriptEntry[]> {
  const info = await stat(path);
  if (info.size > MAX_TRANSCRIPT_READ_BYTES) {
    throw new Error(
      `Transcript is too large to load directly (${info.size} bytes). Use session doctor or compact first.`,
    );
  }

  const raw = await readFile(path, "utf8");
  return parseJsonl(raw);
}

export async function readTranscriptHeadTail(path: string): Promise<{
  head: string;
  tail: string;
}> {
  const info = await stat(path);
  const handle = await open(path, "r");

  try {
    const headSize = Math.min(info.size, LITE_READ_BYTES);
    const headBuffer = Buffer.allocUnsafe(headSize);
    const headRead = await handle.read(headBuffer, 0, headSize, 0);

    const tailSize = Math.min(info.size, LITE_READ_BYTES);
    const tailOffset = Math.max(0, info.size - tailSize);
    const tailBuffer = Buffer.allocUnsafe(tailSize);
    const tailRead = await handle.read(tailBuffer, 0, tailSize, tailOffset);

    return {
      head: headBuffer.subarray(0, headRead.bytesRead).toString("utf8"),
      tail: tailBuffer.subarray(0, tailRead.bytesRead).toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

export function parseJsonl(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // Keep loading. One corrupt line should not destroy the whole session.
    }
  }

  return entries;
}
```

真实工程对大 transcript 做得更深入：

- head/tail 读取用于会话列表。
- compact boundary 前的旧内容可以跳过。
- 某些巨大 snapshot 类型会在 fd 层过滤。
- 大文件 projection 会先找链再 parse，减少内存。

Mini 先设置 50MB 上限，避免最危险的 OOM。后面可以继续优化。

## 第六步：从 entry 投影出有效消息

继续写 `src/session/projector.ts`：

```ts
import type {
  ChatMessage,
  CheckpointEntry,
  FileSnapshot,
  MessageId,
  SessionMetaEntry,
  SessionProjection,
  TranscriptEntry,
  TranscriptMessageEntry,
} from "./types";
import { repairConversationForResume } from "./recovery";

export function projectSession(
  sessionId: string,
  entries: TranscriptEntry[],
): SessionProjection {
  const messagesById = new Map<MessageId, TranscriptMessageEntry>();
  const tombstoned = new Set<MessageId>();
  const checkpoints: CheckpointEntry[] = [];
  const fileSnapshots = new Map<MessageId, FileSnapshot>();
  let meta: SessionMetaEntry | null = null;
  let rewindTarget: MessageId | null = null;

  for (const entry of entries) {
    if ("sessionId" in entry && entry.sessionId !== sessionId) {
      continue;
    }

    if (entry.type === "message") {
      messagesById.set(entry.uuid, entry);
      continue;
    }

    if (entry.type === "tombstone") {
      tombstoned.add(entry.targetUuid);
      continue;
    }

    if (entry.type === "checkpoint") {
      checkpoints.push(entry);
      continue;
    }

    if (entry.type === "file_snapshot") {
      fileSnapshots.set(entry.messageId, entry.snapshot);
      continue;
    }

    if (entry.type === "session_meta") {
      meta = { ...(meta ?? entry), ...entry };
      continue;
    }

    if (entry.type === "rewind") {
      rewindTarget = entry.targetMessageId;
    }
  }

  const activeMessages = [...messagesById.values()]
    .filter((entry) => !tombstoned.has(entry.uuid))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const chain = rewindTarget
    ? buildChainToTarget(activeMessages, rewindTarget)
    : buildLatestChain(activeMessages);

  const repaired = repairConversationForResume(chain.map((entry) => entry.message));

  return {
    sessionId,
    messages: repaired.messages,
    entries,
    checkpoints,
    fileSnapshots: [...fileSnapshots.values()],
    meta,
    interrupted: repaired.interrupted,
    repairs: repaired.repairs,
  };
}

function buildLatestChain(entries: TranscriptMessageEntry[]): TranscriptMessageEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const byId = new Map(entries.map((entry) => [entry.uuid, entry]));
  const parentIds = new Set(
    entries
      .map((entry) => entry.parentUuid)
      .filter((id): id is MessageId => id !== null),
  );

  const leaves = entries.filter((entry) => !parentIds.has(entry.uuid));
  const leaf = leaves.at(-1) ?? entries.at(-1);
  if (!leaf) {
    return [];
  }

  return walkParents(byId, leaf.uuid);
}

function buildChainToTarget(
  entries: TranscriptMessageEntry[],
  target: MessageId,
): TranscriptMessageEntry[] {
  const byId = new Map(entries.map((entry) => [entry.uuid, entry]));
  if (!byId.has(target)) {
    return buildLatestChain(entries);
  }
  return walkParents(byId, target);
}

function walkParents(
  byId: Map<MessageId, TranscriptMessageEntry>,
  leafId: MessageId,
): TranscriptMessageEntry[] {
  const result: TranscriptMessageEntry[] = [];
  const seen = new Set<MessageId>();
  let cursor: MessageId | null = leafId;

  while (cursor) {
    if (seen.has(cursor)) {
      break;
    }
    seen.add(cursor);

    const entry = byId.get(cursor);
    if (!entry) {
      break;
    }

    result.push(entry);
    cursor = entry.parentUuid;
  }

  return result.reverse();
}
```

这一步是恢复系统的核心。

注意：

- projection 不修改 transcript 文件。
- tombstone 是过滤规则。
- rewind 是选择历史 leaf 的规则。
- file snapshot 单独返回，给 code rewind 用。
- `repairConversationForResume()` 在下一步处理 API 合规性。

## 第七步：过滤不适合恢复的 assistant 消息

创建 `src/session/recovery.ts`：

```ts
import type {
  ChatMessage,
  ContentBlock,
  SessionRepair,
  ToolResultBlock,
  ToolUseBlock,
} from "./types";
import { ensureToolResultPairing } from "./pairing";

export type RecoveryResult = {
  messages: ChatMessage[];
  interrupted: boolean;
  repairs: SessionRepair[];
};

export function repairConversationForResume(messages: ChatMessage[]): RecoveryResult {
  const repairs: SessionRepair[] = [];

  const withoutOrphanThinking = filterOrphanThinking(messages, repairs);
  const withoutWhitespace = filterWhitespaceOnlyAssistant(withoutOrphanThinking, repairs);
  const paired = ensureToolResultPairing(withoutWhitespace, repairs);
  const interrupted = detectAndRepairInterruptedTurn(paired, repairs);

  return {
    messages: interrupted.messages,
    interrupted: interrupted.interrupted,
    repairs,
  };
}

function filterOrphanThinking(
  messages: ChatMessage[],
  repairs: SessionRepair[],
): ChatMessage[] {
  const assistantIdsWithNonThinking = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }

    const hasNonThinking = message.content.some(
      (block) => !isThinkingLikeBlock(block),
    );

    if (hasNonThinking) {
      assistantIdsWithNonThinking.add(message.uuid);
    }
  }

  return messages.filter((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return true;
    }

    const allThinking = message.content.every(isThinkingLikeBlock);
    if (!allThinking) {
      return true;
    }

    if (assistantIdsWithNonThinking.has(message.uuid)) {
      return true;
    }

    repairs.push({
      kind: "orphan_thinking",
      message: "Removed orphan thinking-only assistant message during resume.",
      messageId: message.uuid,
    });
    return false;
  });
}

function isThinkingLikeBlock(block: ContentBlock): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function filterWhitespaceOnlyAssistant(
  messages: ChatMessage[],
  repairs: SessionRepair[],
): ChatMessage[] {
  return messages.filter((message) => {
    if (message.role !== "assistant") {
      return true;
    }
    if (!Array.isArray(message.content)) {
      return String(message.content).trim().length > 0;
    }

    const onlyWhitespaceText =
      message.content.length > 0 &&
      message.content.every(
        (block) => block.type === "text" && block.text.trim().length === 0,
      );

    if (!onlyWhitespaceText) {
      return true;
    }

    repairs.push({
      kind: "empty_assistant",
      message: "Removed whitespace-only assistant message during resume.",
      messageId: message.uuid,
    });
    return false;
  });
}

function detectAndRepairInterruptedTurn(
  messages: ChatMessage[],
  repairs: SessionRepair[],
): { messages: ChatMessage[]; interrupted: boolean } {
  const last = [...messages]
    .reverse()
    .find((message) => message.role !== "system" && !message.isApiError);

  if (!last) {
    return { messages, interrupted: false };
  }

  if (last.role === "assistant") {
    return { messages, interrupted: false };
  }

  if (last.role === "user" && isToolResultMessage(last)) {
    repairs.push({
      kind: "interrupted_turn",
      message: "Conversation ended after tool_result; added continuation prompt.",
      messageId: last.uuid,
    });

    return {
      messages: [
        ...messages,
        {
          uuid: crypto.randomUUID(),
          role: "user",
          content: "Continue from where you left off.",
          createdAt: new Date().toISOString(),
          isMeta: true,
        },
      ],
      interrupted: true,
    };
  }

  if (last.role === "user" && !last.isMeta) {
    return { messages, interrupted: true };
  }

  return { messages, interrupted: false };
}

function isToolResultMessage(message: ChatMessage): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block): block is ToolResultBlock => {
    return block.type === "tool_result";
  });
}

export function getToolUses(message: ChatMessage): ToolUseBlock[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((block): block is ToolUseBlock => {
    return block.type === "tool_use";
  });
}

export function getToolResults(message: ChatMessage): ToolResultBlock[] {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((block): block is ToolResultBlock => {
    return block.type === "tool_result";
  });
}

export function contentBlocks(message: ChatMessage): ContentBlock[] {
  return Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: message.content }];
}
```

真实工程的恢复会处理更多情况：

- invalid permission mode。
- legacy attachment migration。
- terminal tool result。
- compact boundary。
- sidechain。
- skill listing suppression。

Mini 先覆盖会导致 API 400 或会话卡死的核心问题。

注意这里把 `thinking` 和 `redacted_thinking` 都当作 thinking-like block。

第 7 章已经说明：thinking mode 的 block 必须原样保存和回传。恢复层只过滤“只有 thinking / redacted_thinking、没有 text/tool_use 等可发送内容”的孤立 assistant；如果同一条 assistant 消息里还有 `tool_use`，不能删掉它前面的 thinking。

## 第八步：修复 tool use pairing

创建 `src/session/pairing.ts`：

```ts
import type {
  ChatMessage,
  ContentBlock,
  SessionRepair,
  ToolResultBlock,
  ToolUseBlock,
} from "./types";

const SYNTHETIC_TOOL_RESULT =
  "[Tool result unavailable because the previous turn was interrupted during resume.]";

export function ensureToolResultPairing(
  messages: ChatMessage[],
  repairs: SessionRepair[],
): ChatMessage[] {
  const result: ChatMessage[] = [];
  const seenToolUseIds = new Set<string>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    if (message.role !== "assistant") {
      const previous = result.at(-1);
      if (message.role === "user" && previous?.role !== "assistant") {
        const stripped = stripOrphanToolResults(message, seenToolUseIds, repairs);
        if (stripped) {
          result.push(stripped);
        }
        continue;
      }

      result.push(message);
      continue;
    }

    const assistant = dedupeToolUses(message, seenToolUseIds, repairs);
    result.push(assistant);

    const toolUses = getToolUses(assistant);
    if (toolUses.length === 0) {
      continue;
    }

    const next = messages[index + 1];
    const nextResults = next?.role === "user" ? getToolResults(next) : [];
    const nextResultIds = new Set(nextResults.map((block) => block.tool_use_id));
    const toolUseIds = new Set(toolUses.map((block) => block.id));

    const missing = toolUses.filter((block) => !nextResultIds.has(block.id));
    const orphaned = nextResults.filter((block) => !toolUseIds.has(block.tool_use_id));

    if (missing.length === 0 && orphaned.length === 0) {
      continue;
    }

    const syntheticBlocks: ToolResultBlock[] = missing.map((block) => {
      repairs.push({
        kind: "missing_tool_result",
        message: "Inserted synthetic tool_result for unmatched tool_use.",
        messageId: assistant.uuid,
        toolUseId: block.id,
      });

      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: SYNTHETIC_TOOL_RESULT,
        is_error: true,
      };
    });

    if (next?.role === "user") {
      const patchedContent = [
        ...syntheticBlocks,
        ...contentArray(next).filter((block) => {
          if (block.type !== "tool_result") {
            return true;
          }
          if (orphaned.some((orphan) => orphan.tool_use_id === block.tool_use_id)) {
            repairs.push({
              kind: "orphan_tool_result",
              message: "Removed orphan tool_result during resume.",
              messageId: next.uuid,
              toolUseId: block.tool_use_id,
            });
            return false;
          }
          return true;
        }),
      ];

      result.push({
        ...next,
        content: patchedContent,
      });
      index++;
      continue;
    }

    if (syntheticBlocks.length > 0) {
      result.push({
        uuid: crypto.randomUUID(),
        role: "user",
        content: syntheticBlocks,
        createdAt: new Date().toISOString(),
        isMeta: true,
      });
    }
  }

  return result;
}

function dedupeToolUses(
  message: ChatMessage,
  seenToolUseIds: Set<string>,
  repairs: SessionRepair[],
): ChatMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }

  let changed = false;
  const content = message.content.filter((block) => {
    if (block.type !== "tool_use") {
      return true;
    }

    if (seenToolUseIds.has(block.id)) {
      changed = true;
      repairs.push({
        kind: "orphan_tool_result",
        message: "Removed duplicate tool_use id during resume.",
        messageId: message.uuid,
        toolUseId: block.id,
      });
      return false;
    }

    seenToolUseIds.add(block.id);
    return true;
  });

  if (!changed) {
    return message;
  }

  return {
    ...message,
    content:
      content.length > 0
        ? content
        : [{ type: "text", text: "[Tool use interrupted]" }],
  };
}

function stripOrphanToolResults(
  message: ChatMessage,
  seenToolUseIds: Set<string>,
  repairs: SessionRepair[],
): ChatMessage | null {
  if (!Array.isArray(message.content)) {
    return message;
  }

  const content = message.content.filter((block) => {
    if (block.type !== "tool_result") {
      return true;
    }

    if (seenToolUseIds.has(block.tool_use_id)) {
      return true;
    }

    repairs.push({
      kind: "orphan_tool_result",
      message: "Removed tool_result without matching tool_use.",
      messageId: message.uuid,
      toolUseId: block.tool_use_id,
    });
    return false;
  });

  if (content.length === 0) {
    return null;
  }

  return { ...message, content };
}

function getToolUses(message: ChatMessage): ToolUseBlock[] {
  return contentArray(message).filter((block): block is ToolUseBlock => {
    return block.type === "tool_use";
  });
}

function getToolResults(message: ChatMessage): ToolResultBlock[] {
  return contentArray(message).filter((block): block is ToolResultBlock => {
    return block.type === "tool_result";
  });
}

function contentArray(message: ChatMessage): ContentBlock[] {
  return Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: message.content }];
}
```

为什么这一步必须做？

Anthropic message API 对工具消息顺序很严格：

```txt
assistant: tool_use(id=abc)
user: tool_result(tool_use_id=abc)
assistant: ...
```

如果 resume 后出现下面任一情况，都可能 400：

```txt
assistant: tool_use(id=abc)
assistant: text
```

```txt
user: tool_result(tool_use_id=abc)
```

```txt
assistant: tool_use(id=abc)
user: tool_result(tool_use_id=abc), tool_result(tool_use_id=abc)
```

真实工程的 `ensureToolResultPairing()` 做了双向防御：

- forward：缺失 tool result 时插入 synthetic error result。
- reverse：孤儿 tool result 会被删除。
- duplicate：重复 tool use 或 tool result 会被去重。

Mini 也要有这条防线。

## 第九步：streaming fallback 的 tombstone

第四十三章已经有 streaming fallback。现在把 tombstone 接到 transcript。

在 `src/llm/resilientAnthropic.ts` 或你的 streaming loop 中，遇到 fallback 时：

```ts
import { recordTombstone } from "../session/transcript";
import type { ChatMessage } from "../session/types";

export async function tombstoneAssistantMessages(
  messages: ChatMessage[],
  reason: "streaming_fallback" | "model_fallback",
): Promise<void> {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    await recordTombstone(message.uuid, reason);
  }
}
```

在 streaming loop 中：

```ts
const assistantMessages: ChatMessage[] = [];
let streamingFallbackOccurred = false;

for await (const message of streamModelResponse(request)) {
  if (message.type === "streaming_fallback") {
    streamingFallbackOccurred = true;
  }

  if (streamingFallbackOccurred) {
    await tombstoneAssistantMessages(assistantMessages, "streaming_fallback");
    assistantMessages.length = 0;
    pendingToolUses.length = 0;
    pendingToolResults.length = 0;
    continue;
  }

  if (message.role === "assistant") {
    assistantMessages.push(message);
    yield message;
  }
}
```

注意顺序：

1. UI 先收到 partial assistant。
2. fallback 发生。
3. tombstone control signal 让 UI 删除 partial。
4. transcript 也删除或投影排除 partial。
5. 新请求重新开始。

不这么做会出现两个问题：

- 用户界面里看到一段已经废弃的回答。
- transcript 恢复时把废弃 thinking signature 发回 API。

第二个问题尤其危险。thinking signature 往往绑定模型和请求上下文，跨 fallback 或跨 provider 回放很容易触发 API 错误。

## 第十步：partial stream 的持久化策略

Mini 有两种策略。

策略 A：只在完整 assistant message 完成后写 transcript。

```txt
message_start
content_block_delta
content_block_delta
content_block_stop
message_delta
message_stop
  -> recordMessage(assistant)
```

优点：

- transcript 干净。
- 不需要 tombstone 大量 partial。

缺点：

- 崩溃时会丢失已经显示但未完成的 assistant 内容。
- SDK 或 UI 的 replay 颗粒度较粗。

策略 B：content block 完成时就写 assistant slice。

```txt
content_block_stop(thinking)
  -> recordMessage(assistant slice)
content_block_stop(text)
  -> recordMessage(assistant slice)
```

优点：

- 更接近真实 streaming 轨迹。
- 崩溃后能看到更多上下文。

缺点：

- resume 必须合并同一 assistant response 的 slices。
- orphan thinking-only slice 必须过滤。
- fallback 时必须 tombstone。

本章建议 Mini 先用策略 A，除非你已经实现了 SDK streaming transcript。

如果你选择策略 B，必须保证：

```txt
filterOrphanThinking()
ensureToolResultPairing()
tombstoneAssistantMessages()
```

这三个能力都存在。

## 第十一步：实现 resume

创建 `src/session/resume.ts`：

```ts
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { cwd } from "node:process";
import { getProjectSessionDir } from "./paths";
import { projectSession, readTranscriptEntries, readTranscriptHeadTail } from "./projector";
import { switchSession } from "./transcript";
import type { SessionProjection } from "./types";

export type ResumeSource =
  | { type: "latest" }
  | { type: "session_id"; sessionId: string }
  | { type: "path"; path: string };

export type SessionListItem = {
  sessionId: string;
  path: string;
  modifiedAt: Date;
  size: number;
  firstPrompt: string | null;
  lastPrompt: string | null;
};

export async function loadConversationForResume(
  source: ResumeSource,
  projectCwd = cwd(),
): Promise<SessionProjection | null> {
  const item = await resolveResumeSource(source, projectCwd);
  if (!item) {
    return null;
  }

  const entries = await readTranscriptEntries(item.path);
  switchSession(item.sessionId, projectCwd);

  return projectSession(item.sessionId, entries);
}

export async function listSessions(projectCwd = cwd()): Promise<SessionListItem[]> {
  const dir = getProjectSessionDir(projectCwd);
  const names = await readdir(dir).catch(() => []);
  const files = names.filter((name) => name.endsWith(".jsonl"));

  const items = await Promise.all(
    files.map(async (name) => {
      const path = join(dir, name);
      const info = await stat(path);
      const sample = await readTranscriptHeadTail(path);
      return {
        sessionId: basename(name, ".jsonl"),
        path,
        modifiedAt: info.mtime,
        size: info.size,
        ...extractPromptSummary(sample.head, sample.tail),
      };
    }),
  );

  return items.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

async function resolveResumeSource(
  source: ResumeSource,
  projectCwd: string,
): Promise<SessionListItem | null> {
  if (source.type === "latest") {
    return (await listSessions(projectCwd)).at(0) ?? null;
  }

  if (source.type === "path") {
    const path = resolve(source.path);
    const info = await stat(path).catch(() => null);
    if (!info) {
      return null;
    }
    const sessionId = basename(path, ".jsonl");
    const sample = await readTranscriptHeadTail(path);
    return {
      sessionId,
      path,
      modifiedAt: info.mtime,
      size: info.size,
      ...extractPromptSummary(sample.head, sample.tail),
    };
  }

  const match = (await listSessions(projectCwd)).find(
    (item) => item.sessionId === source.sessionId,
  );
  return match ?? null;
}

function extractPromptSummary(
  head: string,
  tail: string,
): Pick<SessionListItem, "firstPrompt" | "lastPrompt"> {
  return {
    firstPrompt: firstUserPrompt(head),
    lastPrompt: lastUserPrompt(tail),
  };
}

function firstUserPrompt(raw: string): string | null {
  for (const line of raw.split("\n")) {
    const prompt = promptFromLine(line);
    if (prompt) {
      return prompt;
    }
  }
  return null;
}

function lastUserPrompt(raw: string): string | null {
  const lines = raw.split("\n").reverse();
  for (const line of lines) {
    const prompt = promptFromLine(line);
    if (prompt) {
      return prompt;
    }
  }
  return null;
}

function promptFromLine(line: string): string | null {
  if (!line.includes('"type":"message"') || !line.includes('"role":"user"')) {
    return null;
  }

  try {
    const entry = JSON.parse(line) as {
      message?: { content?: unknown; isMeta?: boolean };
    };
    if (entry.message?.isMeta) {
      return null;
    }
    const content = entry.message?.content;
    const text = typeof content === "string" ? content : null;
    return text ? text.slice(0, 200) : null;
  } catch {
    return null;
  }
}
```

这里 `loadConversationForResume()` 返回 `SessionProjection`，而不是裸 messages。

原因是调用方还需要：

- `fileSnapshots` 初始化 file history。
- `meta` 恢复模型、mode、agent。
- `repairs` 展示诊断。
- `interrupted` 决定是否自动继续。

## 第十二步：接入启动参数

在 `src/cli.ts` 或主入口里：

```ts
import { loadConversationForResume } from "./session/resume";

type CliOptions = {
  continue?: boolean;
  resume?: string;
};

export async function loadInitialMessages(options: CliOptions) {
  if (options.continue) {
    const projection = await loadConversationForResume({ type: "latest" });
    return projection?.messages ?? [];
  }

  if (options.resume) {
    const source = options.resume.endsWith(".jsonl")
      ? { type: "path" as const, path: options.resume }
      : { type: "session_id" as const, sessionId: options.resume };

    const projection = await loadConversationForResume(source);
    return projection?.messages ?? [];
  }

  return [];
}
```

如果你已经有 `AgentLoop`：

```ts
const initialMessages = await loadInitialMessages(options);

const loop = new AgentLoop({
  initialMessages,
  tools,
  model,
});

await loop.start();
```

交互式 `/resume` 和启动时 `--resume` 可以复用同一个 `loadConversationForResume()`。

不同点：

- 启动时 resume：直接初始化 loop。
- 交互式 resume：需要替换当前 loop 的 messages，并 flush 当前 session writer。

## 第十三步：实现 `/session`

创建 `src/commands/session.ts`：

```ts
import { getCurrentTranscriptPath, getSessionId } from "../session/transcript";

export async function sessionCommand(): Promise<string> {
  return [
    `Session: ${getSessionId()}`,
    `Transcript: ${getCurrentTranscriptPath()}`,
  ].join("\n");
}
```

实际项目里可以补充：

- message count。
- checkpoint count。
- transcript size。
- current model。
- cwd。
- file history 状态。

但第一版不要让命令层去读取和解析所有内容。命令层只做展示，数据来自 session 模块。

## 第十四步：实现 checkpoint

Checkpoint 是 rewind 的锚点。

原则：每条真实用户消息都应该有 checkpoint。

```txt
user message U1
checkpoint U1
assistant A1
tool result T1
assistant A2
user message U2
checkpoint U2
```

为什么 checkpoint 绑 user message？

- 用户天然理解“回到我发这句话的时候”。
- 文件快照也应该在用户请求触发工具修改前创建。
- assistant 和 tool result 之间 rewind 容易产生不完整 tool pair。

我们已经在 `recordMessage()` 中对非 meta user message 调了 `recordCheckpoint()`。

如果你的消息写入路径不是统一的，要确保入口唯一：

```ts
export async function submitUserPrompt(prompt: string): Promise<void> {
  const userMessage = createUserMessage(prompt);
  await recordMessage(userMessage);
  await agentLoop.pushUserMessage(userMessage);
}
```

不要让 UI 层、CLI 层、AgentLoop 层各自写 checkpoint。重复写入可以投影处理，但会增加复杂度。

## 第十五步：实现 conversation rewind

创建 `src/session/rewind.ts`：

```ts
import { randomUUID } from "node:crypto";
import { readTranscriptEntries, projectSession } from "./projector";
import { getCurrentTranscriptPath, getSessionId, transcriptWriter } from "./transcript";
import type { ChatMessage, MessageId, RewindEntry } from "./types";
import { restoreFilesToMessage } from "./fileSnapshots";

export type RewindResult = {
  messages: ChatMessage[];
  restoredFiles: string[];
};

export async function rewindToMessage(
  targetMessageId: MessageId,
  options: { restoreFiles: boolean },
): Promise<RewindResult> {
  const sessionId = getSessionId();
  const path = getCurrentTranscriptPath();
  const entries = await readTranscriptEntries(path);
  const before = projectSession(sessionId, entries);

  const target = before.messages.find((message) => message.uuid === targetMessageId);
  if (!target || target.role !== "user") {
    throw new Error("Rewind target must be a user message in the current session.");
  }

  const rewindEntry: RewindEntry = {
    type: "rewind",
    sessionId,
    targetMessageId,
    restoreFiles: options.restoreFiles,
    timestamp: new Date().toISOString(),
  };

  await transcriptWriter.append(path, rewindEntry);
  await transcriptWriter.flush();

  const afterEntries = await readTranscriptEntries(path);
  const after = projectSession(sessionId, afterEntries);

  const restoredFiles = options.restoreFiles
    ? await restoreFilesToMessage(after.fileSnapshots, targetMessageId)
    : [];

  return {
    messages: after.messages,
    restoredFiles,
  };
}

export function createRewindNotice(targetMessageId: MessageId): ChatMessage {
  return {
    uuid: randomUUID(),
    role: "system",
    content: `Conversation rewound to ${targetMessageId}.`,
    createdAt: new Date().toISOString(),
    isMeta: true,
  };
}
```

这个 rewind 是 append-only 的。

它没有删除旧消息，而是追加：

```json
{"type":"rewind","targetMessageId":"..."}
```

projection 看到 rewind 后，把当前 leaf 改为 target。

这样做有几个好处：

- 原始历史还在，可以审计。
- rewind 本身可恢复。
- 如果用户误操作，后面可以做 `/rewind --undo`。
- 不需要重写巨大 transcript。

真实工程的 UI 消息选择器会展示每条 user message 是否有可恢复文件快照，并支持恢复 code。Mini 可以先做命令式 `/rewind <id>`。

## 第十六步：文件快照设计

文件快照不能等修改后再做。

正确时机：

```txt
用户消息 checkpoint 创建
  ↓
assistant 决定调用 FileEdit
  ↓
FileEdit 执行前 backup 当前文件
  ↓
FileEdit 写入新内容
```

创建 `src/session/fileSnapshots.ts`：

```ts
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { cwd } from "node:process";
import { getFileHistoryDir } from "./paths";
import { getSessionId, recordFileSnapshot } from "./transcript";
import type { FileBackup, FileSnapshot, MessageId } from "./types";

export type FileHistoryState = {
  snapshots: FileSnapshot[];
  trackedFiles: Set<string>;
};

const state: FileHistoryState = {
  snapshots: [],
  trackedFiles: new Set(),
};

export async function makeFileSnapshot(messageId: MessageId): Promise<void> {
  const trackedFileBackups: Record<string, FileBackup> = {};
  const previous = state.snapshots.at(-1);

  for (const trackingPath of state.trackedFiles) {
    const latest = previous?.trackedFileBackups[trackingPath];
    const nextVersion = latest ? latest.version + 1 : 1;
    trackedFileBackups[trackingPath] = await createBackup(
      expandPath(trackingPath),
      nextVersion,
    );
  }

  const snapshot: FileSnapshot = {
    messageId,
    trackedFileBackups,
    timestamp: new Date().toISOString(),
  };

  state.snapshots.push(snapshot);
  await recordFileSnapshot(snapshot, false);
}

export async function trackFileBeforeEdit(
  filePath: string,
  messageId: MessageId,
): Promise<void> {
  const trackingPath = shortenPath(filePath);
  const current = state.snapshots.at(-1);
  if (!current) {
    return;
  }

  if (current.trackedFileBackups[trackingPath]) {
    return;
  }

  const backup = await createBackup(filePath, 1);
  state.trackedFiles.add(trackingPath);
  current.trackedFileBackups[trackingPath] = backup;

  await recordFileSnapshot(current, true);
}

export async function restoreFilesToMessage(
  snapshots: FileSnapshot[],
  messageId: MessageId,
): Promise<string[]> {
  const target = [...snapshots].reverse().find(
    (snapshot) => snapshot.messageId === messageId,
  );
  if (!target) {
    throw new Error("No file snapshot found for selected message.");
  }

  const trackedFiles = collectTrackedFiles(snapshots);
  const changed: string[] = [];

  for (const trackingPath of trackedFiles) {
    const targetBackup =
      target.trackedFileBackups[trackingPath] ??
      findFirstBackup(snapshots, trackingPath);

    if (!targetBackup) {
      continue;
    }

    const filePath = expandPath(trackingPath);

    if (targetBackup.backupFileName === null) {
      await unlink(filePath).catch(() => undefined);
      changed.push(filePath);
      continue;
    }

    const backupPath = join(
      getFileHistoryDir(getSessionId()),
      targetBackup.backupFileName,
    );

    await mkdir(dirname(filePath), { recursive: true });
    await copyFile(backupPath, filePath);
    changed.push(filePath);
  }

  return changed;
}

function collectTrackedFiles(snapshots: FileSnapshot[]): Set<string> {
  const tracked = new Set<string>();
  for (const snapshot of snapshots) {
    for (const path of Object.keys(snapshot.trackedFileBackups)) {
      tracked.add(path);
    }
  }
  return tracked;
}

function findFirstBackup(
  snapshots: FileSnapshot[],
  trackingPath: string,
): FileBackup | null {
  for (const snapshot of snapshots) {
    const backup = snapshot.trackedFileBackups[trackingPath];
    if (backup) {
      return backup;
    }
  }
  return null;
}

async function createBackup(filePath: string, version: number): Promise<FileBackup> {
  const backupFileName = backupName(filePath, version);
  const backupPath = join(getFileHistoryDir(getSessionId()), backupFileName);

  const info = await stat(filePath).catch(() => null);
  if (!info) {
    return {
      backupFileName: null,
      version,
      backupTime: new Date().toISOString(),
    };
  }

  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(filePath, backupPath);
  await chmod(backupPath, info.mode);

  return {
    backupFileName,
    version,
    backupTime: new Date().toISOString(),
  };
}

function backupName(filePath: string, version: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${hash}@v${version}`;
}

function shortenPath(filePath: string): string {
  if (!isAbsolute(filePath)) {
    return filePath;
  }
  const current = cwd();
  return filePath.startsWith(current) ? relative(current, filePath) : filePath;
}

function expandPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(cwd(), filePath);
}
```

接入 FileEdit：

```ts
import { trackFileBeforeEdit } from "../session/fileSnapshots";

export async function runFileEdit(input: {
  path: string;
  oldText: string;
  newText: string;
}, context: {
  parentUserMessageId: string;
}) {
  await trackFileBeforeEdit(input.path, context.parentUserMessageId);

  // existing edit logic
}
```

接入每轮用户消息：

```ts
import { makeFileSnapshot } from "../session/fileSnapshots";

async function onUserMessage(message: ChatMessage): Promise<void> {
  await recordMessage(message);
  await makeFileSnapshot(message.uuid);
}
```

真实工程为了避免内存膨胀，会限制 snapshot 数量，并使用 `copyFile` 避免把大文件读入 JS heap。Mini 也使用 `copyFile`。

## 第十七步：resume 后恢复 file history state

`projectSession()` 已经返回 `fileSnapshots`。

交互式启动时：

```ts
const projection = await loadConversationForResume(source);

if (projection) {
  appState.messages = projection.messages;
  appState.fileHistory = restoreFileHistoryState(projection.fileSnapshots);
}
```

在 `src/session/fileSnapshots.ts` 里补：

```ts
export function restoreFileHistoryState(snapshots: FileSnapshot[]): FileHistoryState {
  const trackedFiles = new Set<string>();

  for (const snapshot of snapshots) {
    for (const filePath of Object.keys(snapshot.trackedFileBackups)) {
      trackedFiles.add(shortenPath(filePath));
    }
  }

  state.snapshots = snapshots;
  state.trackedFiles = trackedFiles;

  return {
    snapshots: [...state.snapshots],
    trackedFiles: new Set(state.trackedFiles),
  };
}
```

如果 resume 是 fork 模式，还要复制旧 session 的 backup 文件到新 session 目录。真实工程优先 hard link，失败再 copy。Mini 第一版可以只支持同 session resume。

## 第十八步：实现 `/rewind`

创建 `src/commands/rewind.ts`：

```ts
import { rewindToMessage } from "../session/rewind";

export async function rewindCommand(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const target = parts[0];
  const restoreFiles = parts.includes("--files");

  if (!target) {
    return "Usage: /rewind <user-message-id> [--files]";
  }

  try {
    const result = await rewindToMessage(target, { restoreFiles });
    if (restoreFiles) {
      return `Rewound conversation and restored ${result.restoredFiles.length} files.`;
    }
    return "Rewound conversation to selected message.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to rewind: ${message}`;
  }
}
```

如果你的 REPL 有 message selector，可以让用户不用复制 UUID：

```txt
> /rewind
? Select message to rewind to
```

但底层仍然应该只依赖 `messageId`。

## 第十九步：crash recovery

崩溃恢复不是“读最后一行继续”。

常见崩溃点：

```txt
user message 已写入，assistant 还没开始
assistant tool_use 已写入，tool_result 没写入
tool_result 已写入，assistant 总结还没写入
streaming thinking 已写入，text 没写入
fallback 发生，旧 partial 没删干净
```

我们已经在 `repairConversationForResume()` 里处理了大部分。

再补一个明确的 turn marker 会更稳：

```ts
export type TurnMarkerEntry = {
  type: "turn_marker";
  sessionId: string;
  turnId: string;
  phase: "start" | "api_done" | "tools_done" | "done";
  userMessageId: string;
  timestamp: string;
};
```

每轮写入：

```txt
turn_marker start
assistant messages...
turn_marker api_done
tool results...
turn_marker tools_done
assistant final...
turn_marker done
```

Mini 第一版可以不加 turn marker，因为 tool pairing + interrupted detection 已经能恢复核心合法性。

但如果你要接近官方行为，推荐加。它可以让 `/session doctor` 解释得更清楚：

```txt
Last turn interrupted after api_done, before tools_done.
Inserted synthetic tool_result for toolu_abc.
```

## 第二十步：session doctor

创建 `src/session/doctor.ts`：

```ts
import { basename } from "node:path";
import { projectSession, readTranscriptEntries } from "./projector";

export async function inspectTranscript(path: string): Promise<string> {
  const sessionId = basename(path, ".jsonl");
  const entries = await readTranscriptEntries(path);
  const projection = projectSession(sessionId, entries);

  const lines = [
    `Session: ${sessionId}`,
    `Entries: ${entries.length}`,
    `Messages: ${projection.messages.length}`,
    `Checkpoints: ${projection.checkpoints.length}`,
    `File snapshots: ${projection.fileSnapshots.length}`,
    `Interrupted: ${projection.interrupted ? "yes" : "no"}`,
    `Repairs: ${projection.repairs.length}`,
  ];

  for (const repair of projection.repairs) {
    lines.push(`- ${repair.kind}: ${repair.message}`);
  }

  return lines.join("\n");
}

if (import.meta.main) {
  const path = Bun.argv[2];
  if (!path) {
    console.error("Usage: bun run src/session/doctor.ts <transcript.jsonl>");
    process.exit(1);
  }
  console.log(await inspectTranscript(path));
}
```

这类工具很有用。会话系统一旦出问题，用户很难描述“哪里坏了”。doctor 可以把 projection 的判断暴露出来。

## 第二十一步：把 Agent Loop 改成 session-aware

在 `src/agent/agentLoop.ts` 中，原来可能是：

```ts
this.messages.push(userMessage);
```

改成：

```ts
await recordMessage(userMessage);
await makeFileSnapshot(userMessage.uuid);
this.messages.push(userMessage);
```

assistant 消息：

```ts
for await (const event of this.callModel()) {
  if (event.type === "assistant_message") {
    this.messages.push(event.message);
    await recordMessage(event.message);
    yield event.message;
  }

  if (event.type === "tombstone") {
    this.messages = this.messages.filter(
      (message) => message.uuid !== event.targetUuid,
    );
    await recordTombstone(event.targetUuid, "streaming_fallback");
  }
}
```

工具结果：

```ts
const toolResultMessage = createToolResultMessage(toolUse.id, result);
this.messages.push(toolResultMessage);
await recordMessage(toolResultMessage);
```

关键规则：

- 内存 append 和 transcript append 的顺序要一致。
- tombstone 必须同时作用于 UI 和 transcript。
- user checkpoint 必须早于可能修改文件的工具。
- `flushSession()` 要在进程退出、切换 session、测试结束时调用。

## 第二十二步：API 请求前再做一次防御

即使 resume 做了 repair，发送 API 前也应该再做一遍轻量校验。

在请求构造处：

```ts
import { repairConversationForResume } from "../session/recovery";

function buildApiMessages(messages: ChatMessage[]) {
  const repaired = repairConversationForResume(messages);
  return repaired.messages.map(toAnthropicMessage);
}
```

这不是鼓励隐藏 bug。

原因是会话消息有多个入口：

- resume。
- rewind。
- compaction。
- streaming fallback。
- user interrupt。
- hook 注入。
- tool error。

API 前最后一层 guard 可以避免用户被卡死在 400 循环里。

如果你做训练数据或严格测试，可以加环境变量让 repair 变成 throw：

```ts
if (process.env.CCMINI_STRICT_TOOL_PAIRING === "1" && repaired.repairs.length > 0) {
  throw new Error("Conversation needed repair before API request.");
}
```

真实工程也有类似思路：普通用户路径尽量 repair，严格采集路径宁愿失败。

## 第二十三步：session metadata

session 不只是 messages。

至少要存：

- cwd。
- model。
- last prompt。
- custom title。
- mode。
- agent。
- total cost。
- token usage。

示例：

```ts
await recordSessionMeta({
  title: "Fix auth provider retries",
  model: "deepseek-v4-flash",
  mode: "normal",
});
```

退出前重新 append metadata：

```ts
process.on("beforeExit", () => {
  void recordSessionMeta(currentMeta);
  void flushSession();
});
```

为什么退出时还要 append？

resume 列表通常只读文件 tail，不会 parse 全文件。如果 title 写在 3 小时前，后面追加了几百 MB tool result，tail 里就找不到 title。

真实工程的 cleanup handler 会先 flush，再把 custom title、tag、agent、mode、worktree state 等 metadata 重新 append 到文件尾。

Mini 可以在退出时写：

```ts
await recordSessionMeta({
  title: currentTitle,
  lastPrompt: currentLastPrompt,
  model: currentModel,
});
await flushSession();
```

## 第二十四步：处理 session 切换

交互式 `/resume` 会在一个进程内切换 session。

切换前必须：

```ts
await flushSession();
```

切换后必须：

```ts
switchSession(newSessionId, projectCwd);
restoreFileHistoryState(projection.fileSnapshots);
agentLoop.replaceMessages(projection.messages);
```

不要只替换 `messages`。

还要考虑：

- file history。
- model override。
- mode。
- agent。
- cwd。
- cost。
- prompt cache 相关状态。

Mini 第一版至少做：

```ts
type RuntimeRestore = {
  messages: ChatMessage[];
  fileSnapshots: FileSnapshot[];
  model?: string;
  cwd?: string;
};
```

随着后续章节扩展，再把更多运行态加进 `SessionMetaEntry`。

## 第二十五步：测试 transcript writer

创建 `src/session/__tests__/transcript.test.ts`：

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptWriter } from "../transcript";
import type { TranscriptEntry } from "../types";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("append writes entries in order", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccmini-session-"));
  const path = join(tempDir, "session.jsonl");
  const writer = new TranscriptWriter();

  const entries: TranscriptEntry[] = [
    meta("s1", "one"),
    meta("s1", "two"),
    meta("s1", "three"),
  ];

  await Promise.all(entries.map((entry) => writer.append(path, entry)));
  await writer.flush();

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  expect(lines.map((line) => JSON.parse(line).lastPrompt)).toEqual([
    "one",
    "two",
    "three",
  ]);
});

test("removeMessage removes target line", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccmini-session-"));
  const path = join(tempDir, "session.jsonl");
  const writer = new TranscriptWriter();

  await writer.append(path, message("s1", "m1"));
  await writer.append(path, message("s1", "m2"));
  await writer.flush();

  await writer.removeMessage(path, "m2");

  const raw = await readFile(path, "utf8");
  expect(raw).toContain('"uuid":"m1"');
  expect(raw).not.toContain('"uuid":"m2"');
});

function meta(sessionId: string, lastPrompt: string): TranscriptEntry {
  return {
    type: "session_meta",
    sessionId,
    timestamp: new Date().toISOString(),
    lastPrompt,
  };
}

function message(sessionId: string, uuid: string): TranscriptEntry {
  return {
    type: "message",
    sessionId,
    uuid,
    parentUuid: null,
    cwd: "/tmp",
    timestamp: new Date().toISOString(),
    version: "test",
    message: {
      uuid,
      role: "user",
      content: "hello",
      createdAt: new Date().toISOString(),
    },
  };
}
```

## 第二十六步：测试 projection 和 tombstone

创建 `src/session/__tests__/projector.test.ts`：

```ts
import { expect, test } from "bun:test";
import { projectSession } from "../projector";
import type { TranscriptEntry } from "../types";

test("projectSession excludes tombstoned messages", () => {
  const entries: TranscriptEntry[] = [
    message("u1", null, "user", "hello"),
    message("a1", "u1", "assistant", "partial"),
    {
      type: "tombstone",
      sessionId: "s1",
      targetUuid: "a1",
      reason: "streaming_fallback",
      timestamp: now(),
    },
    message("a2", "u1", "assistant", "final"),
  ];

  const projected = projectSession("s1", entries);
  expect(projected.messages.map((message) => message.uuid)).toEqual(["u1", "a2"]);
});

test("projectSession rewinds to target message", () => {
  const entries: TranscriptEntry[] = [
    message("u1", null, "user", "one"),
    message("a1", "u1", "assistant", "answer one"),
    message("u2", "a1", "user", "two"),
    message("a2", "u2", "assistant", "answer two"),
    {
      type: "rewind",
      sessionId: "s1",
      targetMessageId: "u1",
      restoreFiles: false,
      timestamp: now(),
    },
  ];

  const projected = projectSession("s1", entries);
  expect(projected.messages.map((message) => message.uuid)).toEqual(["u1"]);
});

function message(
  uuid: string,
  parentUuid: string | null,
  role: "user" | "assistant",
  content: string,
): TranscriptEntry {
  return {
    type: "message",
    sessionId: "s1",
    uuid,
    parentUuid,
    cwd: "/tmp",
    timestamp: now(),
    version: "test",
    message: {
      uuid,
      role,
      content,
      createdAt: now(),
    },
  };
}

function now(): string {
  return new Date().toISOString();
}
```

## 第二十七步：测试 tool pairing

创建 `src/session/__tests__/pairing.test.ts`：

```ts
import { expect, test } from "bun:test";
import { ensureToolResultPairing } from "../pairing";
import type { ChatMessage, SessionRepair } from "../types";

test("inserts synthetic tool_result when assistant tool_use has no result", () => {
  const repairs: SessionRepair[] = [];
  const messages = ensureToolResultPairing(
    [
      {
        uuid: "a1",
        role: "assistant",
        createdAt: now(),
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { path: "README.md" },
          },
        ],
      },
    ],
    repairs,
  );

  expect(messages).toHaveLength(2);
  expect(messages[1]?.role).toBe("user");
  expect(repairs[0]?.kind).toBe("missing_tool_result");
});

test("removes orphan tool_result", () => {
  const repairs: SessionRepair[] = [];
  const messages: ChatMessage[] = [
    {
      uuid: "u1",
      role: "user",
      createdAt: now(),
      content: [
        {
          type: "tool_result",
          tool_use_id: "missing",
          content: "orphan",
        },
      ],
    },
  ];

  const repaired = ensureToolResultPairing(messages, repairs);
  expect(repaired).toHaveLength(0);
  expect(repairs[0]?.kind).toBe("orphan_tool_result");
});

function now(): string {
  return new Date().toISOString();
}
```

## 第二十八步：测试 crash recovery

创建 `src/session/__tests__/recovery.test.ts`：

```ts
import { expect, test } from "bun:test";
import { repairConversationForResume } from "../recovery";
import type { ChatMessage } from "../types";

test("marks plain trailing user message as interrupted prompt", () => {
  const result = repairConversationForResume([
    user("u1", "please edit this"),
  ]);

  expect(result.interrupted).toBe(true);
  expect(result.messages).toHaveLength(1);
});

test("adds continuation after trailing tool_result", () => {
  const messages: ChatMessage[] = [
    assistantToolUse("a1", "toolu_1"),
    {
      uuid: "u2",
      role: "user",
      createdAt: now(),
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "done",
        },
      ],
    },
  ];

  const result = repairConversationForResume(messages);
  expect(result.interrupted).toBe(true);
  expect(result.messages.at(-1)?.content).toBe("Continue from where you left off.");
});

test("filters orphan thinking-only assistant", () => {
  const result = repairConversationForResume([
    {
      uuid: "a1",
      role: "assistant",
      createdAt: now(),
      content: [{ type: "thinking", thinking: "hidden" }],
    },
  ]);

  expect(result.messages).toHaveLength(0);
  expect(result.repairs[0]?.kind).toBe("orphan_thinking");
});

function user(uuid: string, content: string): ChatMessage {
  return {
    uuid,
    role: "user",
    content,
    createdAt: now(),
  };
}

function assistantToolUse(uuid: string, toolUseId: string): ChatMessage {
  return {
    uuid,
    role: "assistant",
    createdAt: now(),
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: "Read",
        input: { path: "README.md" },
      },
    ],
  };
}

function now(): string {
  return new Date().toISOString();
}
```

## 第二十九步：测试 rewind 文件恢复

文件测试要使用临时目录，不能动真实项目文件。

创建 `src/session/__tests__/fileSnapshots.test.ts`：

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file rewind restores previous content", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccmini-file-history-"));
  const file = join(tempDir, "demo.txt");

  await writeFile(file, "before\n");

  // 这里按你的实现调用 makeFileSnapshot / trackFileBeforeEdit / restoreFilesToMessage。
  // 课程只强调测试形状：先备份，再修改，再恢复。

  await writeFile(file, "after\n");

  // await restoreFilesToMessage(...)

  const content = await readFile(file, "utf8");
  expect(content).toBe("before\n");
});
```

这段测试需要按你的实际 file snapshot API 补齐。重点是测试顺序：

```txt
write before
snapshot
track before edit
write after
restore
expect before
```

## 第三十步：手工验证流程

先跑类型检查：

```bash
bun run typecheck
```

跑 session 相关测试：

```bash
bun test src/session/__tests__/transcript.test.ts
bun test src/session/__tests__/projector.test.ts
bun test src/session/__tests__/pairing.test.ts
bun test src/session/__tests__/recovery.test.ts
bun test src/session/__tests__/rewind.test.ts
```

启动交互：

```bash
bun run dev
```

输入：

```txt
请创建 demo-session.txt，内容是 before
```

再输入：

```txt
把 demo-session.txt 改成 after
```

查看 session：

```txt
/session
```

复制第一条 user message id，执行：

```txt
/rewind <message-id> --files
```

确认：

```bash
cat demo-session.txt
```

应该看到：

```txt
before
```

恢复最近会话：

```bash
bun run dev -- --continue
```

检查 transcript：

```bash
bun run src/session/doctor.ts ~/.cc-mini/projects/<project>/<session>.jsonl
```

## 常见坑

### 坑 1：把 progress 写进 parent chain

不要让 progress 成为 parent。

错误：

```txt
user -> progress -> assistant
```

正确：

```txt
user -> assistant
progress 不参与链
```

### 坑 2：resume 时直接取所有 message

JSONL 里可能有：

- side branch。
- rewind 前的旧消息。
- tombstoned partial。
- compact boundary 前的旧链。

必须 projection。

### 坑 3：tool result 孤儿导致 400

只要有工具，就必须在 API 前检查 pairing。

### 坑 4：文件快照在编辑后创建

那只能恢复到“已经坏了”的状态。

文件快照必须在 edit/write 前创建。

### 坑 5：大 transcript 全量读

会话跑久后 JSONL 很容易巨大。

至少设置：

```ts
const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024;
```

会话列表只读 head/tail。

### 坑 6：resume 后没有 flush 旧 session

交互式 `/resume` 前必须 flush 当前 writer，否则旧 session 可能丢最后几条消息。

### 坑 7：rewind 直接删除 transcript

不要这么做。

append `rewind` entry 更安全。

### 坑 8：把 token 写进 transcript

任何 auth token、API key、authorization header 都不能进入 transcript。

session metadata 只存 provider 名、model 名、状态，不存密钥。

## 与官方 Claude Code 的差距

做到本章后，Mini 已经具备接近官方的会话可靠性骨架。

但还有一些官方级细节没完全覆盖：

- 超大 transcript 的 compact boundary 快速扫描。
- sidechain/subagent transcript。
- worktree state 恢复。
- session title/tag 的 tail re-append 策略。
- content replacement，用于把巨大 tool result 替换成稳定引用。
- context collapse commit 和 snapshot。
- remote control session 的远端持久化。
- interrupted prompt 的自动续跑策略。
- 更完整的 attachment migration。

这些不是第一版 session 子系统的阻塞项，但它们决定了长会话和多 agent 场景的稳定性。

## 本章验收标准

代码层面：

- transcript 写入是 JSONL append-only。
- 每条真实 user message 有 checkpoint。
- resume 走 projection，不直接使用全量 entries。
- streaming fallback 会 tombstone partial assistant。
- resume 会修复 tool pairing。
- rewind 不删除 transcript，只 append rewind entry。
- 文件 rewind 使用修改前快照。
- 大 transcript 有读取上限。

测试层面：

- writer 并发 append 顺序稳定。
- tombstone 后 projection 不包含 target。
- rewind 后 projection 截断到 target。
- 缺失 tool result 会插入 synthetic error result。
- orphan tool result 会删除。
- orphan thinking-only assistant 会过滤。
- trailing user/tool result 能被识别为 interrupted。
- 文件恢复能把内容改回目标快照。

命令层面：

- `bun run dev -- --continue` 可恢复最近会话。
- `bun run dev -- --resume <session-id>` 可恢复指定会话。
- `/session` 能显示当前 session 信息。
- `/rewind <message-id>` 能回到历史 user message。
- `/rewind <message-id> --files` 能恢复文件。

## 小结

会话系统是 Claude Code 这类 CLI 的地基。

前面的章节让 Mini 能发请求、调用工具、处理错误；本章让这些行为变成可恢复的历史。

真正可靠的会话持久化不只是保存数组，而是：

```txt
append-only facts
  + parent chain
  + tombstone
  + checkpoint
  + projection
  + repair
  + file snapshot
```

做到这里，Mini 已经能支撑长时间工作流。下一章可以继续补 **上下文压缩与 compact boundary**：让很长的 session 在不丢关键历史的前提下继续运行，并让 transcript projection 能跳过压缩前的旧链。
