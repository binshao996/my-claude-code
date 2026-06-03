# 第 22 章：日志、调试与 Transcript

第二十一章实现了 API 请求容错。Mini 已经能重试、处理 streaming fallback、做模型 fallback，并把最终 API 错误转成用户可读消息。

但如果这些运行时事件只显示在屏幕上，问题排查仍然很困难：

- 用户说“刚才卡住了”，你不知道卡在哪个请求。
- API 重试发生过，但你不知道重试了几次。
- fallback 生效了，但 transcript 里没有证据。
- 工具执行失败了，但 debug 信息被普通聊天消息淹没。
- 会话恢复时缺少 parent 链，历史消息顺序不可靠。
- 错误日志里可能意外包含 token。

本章要做的是把运行时记录分层：

- **debug log**：给开发者看的本地调试日志。
- **event log**：给运行时统计和 UI 事件用的低敏结构化事件。
- **transcript**：给会话恢复、导出和复盘用的 JSONL 会话记录。

三者用途不同，不应该写进同一个文件，也不应该用同一种脱敏规则。

## 本章目标

完成本章后，你会得到：

1. `src/logging/redact.ts`：统一脱敏函数。
2. `src/logging/debugLog.ts`：本地 debug 日志。
3. `src/logging/events.ts`：运行时结构化事件。
4. `src/transcript/types.ts`：Transcript entry 类型。
5. `src/transcript/store.ts`：JSONL append-only 存储。
6. `src/transcript/reader.ts`：按行读取和恢复会话。
7. API retry/fallback 事件写入 transcript。
8. `/debug` 和 `/transcript` 两个基础命令。
9. 日志与 transcript 的测试。

这一章的工程目标是：Mini 出问题时，能通过本地文件回答“发生了什么、什么时候发生、属于哪个 session、是否可以恢复”。

## 本章完成效果

启动 Mini：

```bash
bun run dev
```

打开 debug：

```txt
> /debug on
Debug logging enabled: ~/.cc-mini/debug/latest.log
```

查看当前 transcript：

```txt
> /transcript
~/.cc-mini/projects/-Users-you-project/2b5d7d8a-9f41-4edb-9e32-111111111111.jsonl
```

当 API retry 发生时，用户看到：

```txt
API retry: rate_limit, attempt 1/4, retrying in 1200ms
```

transcript 里会出现一行结构化事件：

```json
{"type":"event","event":"api_retry","sessionId":"2b5d7d8a-9f41-4edb-9e32-111111111111","timestamp":"2026-05-26T06:00:00.000Z","data":{"errorKind":"rate_limit","attempt":1,"maxRetries":4,"retryInMs":1200}}
```

debug log 里会出现更适合开发排查的一行：

```txt
2026-05-26T06:00:00.000Z [WARN] api_retry role=main model=deepseek-v4-flash attempt=1 retryInMs=1200
```

注意：这两处都不能包含 `ANTHROPIC_AUTH_TOKEN` 的值。

## 真实工程如何分层

真实 Claude Code 的日志和会话记录不是一个系统。

### Debug log

`src/utils/debug.ts` 提供 `logForDebugging()`：

- 支持 `--debug`、`-d`、`DEBUG`、`DEBUG_SDK`。
- 支持 `--debug-file` 指定文件。
- 默认写到 `~/.claude/debug/<sessionId>.txt`。
- 维护 `~/.claude/debug/latest` symlink。
- 有日志级别：`verbose`、`debug`、`info`、`warn`、`error`。
- 多行内容会被处理，避免破坏日志格式。

Debug log 是给开发者看的，不是给模型看的，也不是会话恢复依据。

### Error log

`src/utils/log.ts` 里有 `logError()`：

- 维护最近 100 条 in-memory error。
- sink 未初始化时先排队。
- sink attach 后再 drain。
- 某些隐私模式或 provider 场景会跳过持久错误上报。

这说明错误日志必须独立于 transcript。Transcript 记录“会话发生了什么”，error log 记录“程序哪里坏了”。

### Event log

`src/services/analytics/index.ts` 提供 `logEvent()`：

- 模块本身无依赖，避免 import cycle。
- sink 未 attach 时先进入队列。
- sink attach 后异步 drain。
- metadata 限制为低敏字段，字符串需要明确标记后才能写入。

Mini 不需要做远端上报，但可以保留这个结构：先写一个本地 event bus，后面再决定是否接 UI、文件或远端。

### Transcript

`src/utils/sessionStorage.ts` 负责 JSONL transcript：

- 路径形如 `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`。
- 每条 entry 一行 JSON。
- append-only 写入，不反复重写整个文件。
- 写队列按文件分组，定时批量 flush。
- user/assistant/system message 会带 `parentUuid`，形成恢复链。
- progress 这类高频 UI 临时状态不进入 parent 链。
- 外部用户 transcript 会做内容清理。
- 读取 raw transcript 有大小上限，避免 OOM。

本章 Mini 实现一个轻量版：单文件 append、parent 链、脱敏、恢复。

## 本章项目结构变化

新增：

```txt
src/
  logging/
    redact.ts
    debugLog.ts
    events.ts
    __tests__/
      redact.test.ts
      debugLog.test.ts
      events.test.ts
  transcript/
    types.ts
    paths.ts
    store.ts
    reader.ts
    __tests__/
      transcript.test.ts
```

修改：

```txt
src/
  llm/
    resilientAnthropic.ts
  agent/
    agentLoop.ts
  commands/
    debug.ts
    transcript.ts
```

如果你的 Mini 命令目录名字不同，按已有 CommandRegistry 接入即可。

## 设计原则

记录系统遵循六条规则：

1. Debug log 可以详细，但必须本地、可关闭、可脱敏。
2. Event log 只能放低敏结构化字段。
3. Transcript 是恢复依据，必须 append-only。
4. Secret 永远不写入任何日志。
5. Runtime 事件不要伪装成 assistant 消息。
6. 写文件不能阻塞流式渲染的主路径。

三层边界：

```txt
debugLog.write()
  给开发者看，包含可读文本

events.emit()
  给 UI/统计/测试看，低敏结构化数据

transcript.append()
  给恢复和复盘看，JSONL append-only
```

## 第一步：实现脱敏

创建 `src/logging/redact.ts`：

```ts
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/g,
  /ANTHROPIC_AUTH_TOKEN=([^\s]+)/g,
  /ANTHROPIC_API_KEY=([^\s]+)/g,
  /api[_-]?key["']?\s*[:=]\s*["']?[^"',\s]+/gi,
  /authorization["']?\s*[:=]\s*["']?[^"',\s]+/gi,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    value,
  );
}

export function redactJson<T>(value: T): T {
  return JSON.parse(
    redactSecrets(JSON.stringify(value)),
  ) as T;
}
```

这不是完美的安全系统，但能挡住最常见的泄漏路径：

- 直接打印 token。
- 打印 Authorization header。
- 打印环境变量。
- 打印包含 apiKey 的对象。

后续所有日志入口都先经过它。

## 第二步：实现 debug log

创建 `src/logging/debugLog.ts`：

```ts
import { appendFile, mkdir, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSessionId } from "../session/sessionState";
import { redactSecrets } from "./redact";

export type DebugLevel = "verbose" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<DebugLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

let debugEnabled = process.env.CCMINI_DEBUG === "1";
let minLevel: DebugLevel = "debug";

export function enableDebugLog(): void {
  debugEnabled = true;
}

export function disableDebugLog(): void {
  debugEnabled = false;
}

export function isDebugLogEnabled(): boolean {
  return debugEnabled;
}

export function setDebugMinLevel(level: DebugLevel): void {
  minLevel = level;
}
```

继续写路径函数：

```ts
export function getConfigDir(): string {
  return process.env.CCMINI_HOME ?? join(process.env.HOME ?? ".", ".cc-mini");
}

export function getDebugLogPath(): string {
  return process.env.CCMINI_DEBUG_FILE
    ?? join(getConfigDir(), "debug", `${getSessionId()}.log`);
}

async function updateLatestSymlink(path: string): Promise<void> {
  const latest = join(dirname(path), "latest.log");
  await unlink(latest).catch(() => {});
  await symlink(path, latest).catch(() => {});
}
```

实现写入：

```ts
export async function writeDebugLog(
  level: DebugLevel,
  message: string,
): Promise<void> {
  if (!debugEnabled) {
    return;
  }

  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
    return;
  }

  const path = getDebugLogPath();
  await mkdir(dirname(path), { recursive: true });

  const safeMessage = redactSecrets(message).replace(/\n/g, "\\n");
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${safeMessage}\n`;

  await appendFile(path, line, { mode: 0o600 });
  await updateLatestSymlink(path);
}
```

真实工程里为了性能会用 buffered writer。Mini 先用直接 append，后面如果日志量大再加 buffer。

## 第三步：实现 event bus

创建 `src/logging/events.ts`：

```ts
import { redactJson } from "./redact";

export type RuntimeEvent =
  | {
      type: "api_retry";
      data: {
        errorKind: string;
        attempt: number;
        maxRetries: number;
        retryInMs: number;
      };
    }
  | {
      type: "streaming_fallback";
      data: {
        reason: string;
      };
    }
  | {
      type: "model_fallback";
      data: {
        from: string;
        to: string;
        reason: string;
      };
    }
  | {
      type: "api_error";
      data: {
        kind: string;
        status?: number;
        model: string;
      };
    };

type EventListener = (event: RuntimeEvent) => void | Promise<void>;

const listeners = new Set<EventListener>();
const queuedEvents: RuntimeEvent[] = [];
let attached = false;
```

继续写：

```ts
export function onRuntimeEvent(listener: EventListener): () => void {
  listeners.add(listener);
  attached = true;

  if (queuedEvents.length > 0) {
    const copy = queuedEvents.splice(0);
    queueMicrotask(() => {
      for (const event of copy) {
        emitRuntimeEvent(event);
      }
    });
  }

  return () => {
    listeners.delete(listener);
  };
}

export function emitRuntimeEvent(event: RuntimeEvent): void {
  const safeEvent = redactJson(event);

  if (!attached) {
    queuedEvents.push(safeEvent);
    return;
  }

  for (const listener of listeners) {
    void listener(safeEvent);
  }
}
```

这模仿真实工程的 `logEvent()`：早期事件先排队，sink attach 后再 drain。

Mini 当前不做远端统计，只让 UI、debug 和 transcript 订阅这个 event bus。

## 第四步：定义 Transcript 类型

创建 `src/transcript/types.ts`：

```ts
export type TranscriptRole = "user" | "assistant" | "system";

export type TranscriptMessageEntry = {
  type: "message";
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  cwd: string;
  role: TranscriptRole;
  content: string;
  model?: string;
};

export type TranscriptEventEntry = {
  type: "event";
  sessionId: string;
  uuid: string;
  timestamp: string;
  event: "api_retry" | "streaming_fallback" | "model_fallback" | "api_error";
  data: Record<string, unknown>;
};

export type TranscriptMetaEntry = {
  type: "meta";
  sessionId: string;
  uuid: string;
  timestamp: string;
  key: string;
  value: unknown;
};

export type TranscriptEntry =
  | TranscriptMessageEntry
  | TranscriptEventEntry
  | TranscriptMetaEntry;
```

Mini 把 runtime event 明确写成 `type: "event"`，而不是塞进 assistant 文本。恢复会话时可以选择只恢复 message entry，复盘时再显示 event entry。

## 第五步：实现 transcript 路径

创建 `src/transcript/paths.ts`：

```ts
import { join } from "node:path";
import { getSessionId } from "../session/sessionState";

export function getConfigDir(): string {
  return process.env.CCMINI_HOME ?? join(process.env.HOME ?? ".", ".cc-mini");
}

export function sanitizePathForFile(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function getProjectTranscriptDir(cwd = process.cwd()): string {
  return join(getConfigDir(), "projects", sanitizePathForFile(cwd));
}

export function getTranscriptPath(sessionId = getSessionId()): string {
  return join(getProjectTranscriptDir(), `${sessionId}.jsonl`);
}
```

真实工程使用 project dir 分组，这样不同项目的会话不会混在一起。Mini 也保留这个结构。

## 第六步：实现 append-only store

创建 `src/transcript/store.ts`：

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { getSessionId } from "../session/sessionState";
import { redactJson } from "../logging/redact";
import { getTranscriptPath } from "./paths";
import type { TranscriptEntry, TranscriptRole } from "./types";

let lastMessageUuid: string | null = null;

export async function appendTranscriptEntry(entry: TranscriptEntry): Promise<void> {
  const safeEntry = redactJson(entry);
  const path = getTranscriptPath(safeEntry.sessionId);

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(safeEntry) + "\n", { mode: 0o600 });
}
```

添加消息记录：

```ts
export async function recordTranscriptMessage(input: {
  role: TranscriptRole;
  content: string;
  model?: string;
}): Promise<string> {
  const uuid = randomUUID();
  const entry: TranscriptEntry = {
    type: "message",
    sessionId: getSessionId(),
    uuid,
    parentUuid: lastMessageUuid,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    role: input.role,
    content: input.content,
    model: input.model,
  };

  await appendTranscriptEntry(entry);
  lastMessageUuid = uuid;
  return uuid;
}
```

添加事件记录：

```ts
export async function recordTranscriptEvent(input: {
  event: TranscriptEntry extends infer T
    ? T extends { type: "event"; event: infer E }
      ? E
      : never
    : never;
  data: Record<string, unknown>;
}): Promise<string> {
  const uuid = randomUUID();
  const entry: TranscriptEntry = {
    type: "event",
    sessionId: getSessionId(),
    uuid,
    timestamp: new Date().toISOString(),
    event: input.event,
    data: input.data,
  };

  await appendTranscriptEntry(entry);
  return uuid;
}
```

事件不参与 `parentUuid` 链。它们是时间线信息，不是对话恢复链的一部分。

## 第七步：实现 transcript reader

创建 `src/transcript/reader.ts`：

```ts
import { readFile } from "node:fs/promises";
import type {
  TranscriptEntry,
  TranscriptMessageEntry,
} from "./types";

export async function readTranscriptFile(path: string): Promise<TranscriptEntry[]> {
  const text = await readFile(path, "utf8");
  const entries: TranscriptEntry[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      entries.push({
        type: "event",
        sessionId: "unknown",
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event: "api_error",
        data: {
          kind: "malformed_transcript_line",
        },
      });
    }
  }

  return entries;
}
```

恢复消息：

```ts
export function restoreMessages(
  entries: TranscriptEntry[],
): TranscriptMessageEntry[] {
  const messages = new Map<string, TranscriptMessageEntry>();

  for (const entry of entries) {
    if (entry.type === "message") {
      messages.set(entry.uuid, entry);
    }
  }

  const leaves = new Set(messages.keys());
  for (const message of messages.values()) {
    if (message.parentUuid) {
      leaves.delete(message.parentUuid);
    }
  }

  const leafUuid = [...leaves].at(-1);
  if (!leafUuid) {
    return [];
  }

  const restored: TranscriptMessageEntry[] = [];
  let current: TranscriptMessageEntry | undefined = messages.get(leafUuid);

  while (current) {
    restored.push(current);
    current = current.parentUuid ? messages.get(current.parentUuid) : undefined;
  }

  return restored.reverse();
}
```

真实工程要处理 fork、sidechain、compact boundary、tombstone 等复杂情况。Mini 当前只做单链恢复。

## 第八步：把 runtime event 写入 debug 和 transcript

在 app 初始化时注册 event listener：

```ts
import { onRuntimeEvent } from "./logging/events";
import { writeDebugLog } from "./logging/debugLog";
import { recordTranscriptEvent } from "./transcript/store";

export function installRuntimeEventSinks(): void {
  onRuntimeEvent(event => {
    void recordTranscriptEvent({
      event: event.type,
      data: event.data,
    });

    if (event.type === "api_retry") {
      void writeDebugLog(
        "warn",
        `api_retry errorKind=${event.data.errorKind} attempt=${event.data.attempt} retryInMs=${event.data.retryInMs}`,
      );
      return;
    }

    if (event.type === "model_fallback") {
      void writeDebugLog(
        "warn",
        `model_fallback from=${event.data.from} to=${event.data.to} reason=${event.data.reason}`,
      );
      return;
    }

    void writeDebugLog("info", `${event.type} ${JSON.stringify(event.data)}`);
  });
}
```

这里使用 fire-and-forget，避免日志写入阻塞主请求。测试里可以直接 await 底层函数。

## 第九步：接入 API retry/fallback

第二十一章的 `createResilientMessage()` 已经暴露了 `onRetry` 和 `onFallback`。现在把它们连到 event bus。

修改 AgentLoop：

```ts
import { emitRuntimeEvent } from "../logging/events";

const answer = await createResilientMessage({
  route: {
    role: "main",
    permissionMode: state.permissionMode,
    contextTokens: preparedContext.estimatedTokens,
  },
  system: preparedContext.system,
  messages: preparedContext.messages,
  tools: toolRegistry.toAnthropicTools(),
  stream: true,
  signal,
  onRetry(event) {
    emitRuntimeEvent({
      type: "api_retry",
      data: {
        errorKind: event.errorKind,
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        retryInMs: event.retryInMs,
      },
    });
  },
  onFallback(event) {
    if (event.kind === "model_fallback") {
      emitRuntimeEvent({
        type: "model_fallback",
        data: {
          from: event.from,
          to: event.to,
          reason: event.reason,
        },
      });
      return;
    }

    emitRuntimeEvent({
      type: "streaming_fallback",
      data: {
        reason: event.reason,
      },
    });
  },
});
```

重要：这些 event 不应该追加到模型上下文。它们是运行时记录，不是用户消息。

## 第十步：记录 user 和 assistant 消息

AgentLoop 接收用户输入时：

```ts
await recordTranscriptMessage({
  role: "user",
  content: userInput,
});
```

模型完整返回后：

```ts
await recordTranscriptMessage({
  role: "assistant",
  content: answer,
  model: route.model,
});
```

如果你有 streaming 渲染，不要每个 token 写一行 transcript。只在完整 assistant message 完成后写一次。

原因：

- 每 token 写入会造成巨量小文件 IO。
- resume 时没有必要恢复半个 token 流。
- fallback 时半条 assistant message 可能要丢弃。

真实工程虽然会处理 streaming block 的细节，但也非常小心地处理 tombstone、partial message 和 write queue。

## 第十一步：实现 `/debug`

创建 `src/commands/debug.ts`：

```ts
import {
  disableDebugLog,
  enableDebugLog,
  getDebugLogPath,
  isDebugLogEnabled,
} from "../logging/debugLog";

export function runDebugCommand(args: string[]): string {
  const action = args[0];

  if (action === "on") {
    enableDebugLog();
    return `Debug logging enabled: ${getDebugLogPath()}`;
  }

  if (action === "off") {
    disableDebugLog();
    return "Debug logging disabled";
  }

  return [
    `Debug logging: ${isDebugLogEnabled() ? "on" : "off"}`,
    `Path: ${getDebugLogPath()}`,
    "Usage: /debug on | /debug off",
  ].join("\n");
}
```

注册到 CommandRegistry 后：

```txt
> /debug
Debug logging: off
Path: ~/.cc-mini/debug/<session>.log
Usage: /debug on | /debug off
```

## 第十二步：实现 `/transcript`

创建 `src/commands/transcript.ts`：

```ts
import { getTranscriptPath } from "../transcript/paths";

export function runTranscriptCommand(): string {
  return getTranscriptPath();
}
```

先只输出路径。后续你可以扩展：

- `/transcript tail`：显示最近几行。
- `/transcript export`：导出纯文本。
- `/transcript inspect`：显示 event 和 message 数量。

本章不要一口气做完整 viewer。

## 第十三步：测试脱敏

创建 `src/logging/__tests__/redact.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { redactJson, redactSecrets } from "../redact";

describe("redactSecrets", () => {
  test("redacts token-like strings", () => {
    const text = redactSecrets("Authorization: Bearer secret-token");

    expect(text).toContain("[redacted]");
    expect(text).not.toContain("secret-token");
  });

  test("redacts env-style auth token", () => {
    const text = redactSecrets("ANTHROPIC_AUTH_TOKEN=abc123");

    expect(text).toBe("[redacted]");
  });

  test("redacts nested JSON values", () => {
    const redacted = redactJson({
      headers: {
        authorization: "Bearer abc123",
      },
    });

    expect(JSON.stringify(redacted)).not.toContain("abc123");
  });
});
```

## 第十四步：测试 event bus

创建 `src/logging/__tests__/events.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { emitRuntimeEvent, onRuntimeEvent } from "../events";

describe("runtime events", () => {
  test("delivers emitted events to listener", () => {
    const seen: unknown[] = [];
    const off = onRuntimeEvent(event => {
      seen.push(event);
    });

    emitRuntimeEvent({
      type: "api_retry",
      data: {
        errorKind: "rate_limit",
        attempt: 1,
        maxRetries: 4,
        retryInMs: 100,
      },
    });

    off();

    expect(seen).toHaveLength(1);
  });
});
```

如果你的 event bus 支持测试 reset，可以在测试前清空 listener。课程里为了简洁没有展开。

## 第十五步：测试 transcript append 和 restore

创建 `src/transcript/__tests__/transcript.test.ts`：

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendTranscriptEntry,
  recordTranscriptMessage,
} from "../store";
import { readTranscriptFile, restoreMessages } from "../reader";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cc-mini-"));
  process.env.CCMINI_HOME = home;
});

afterEach(async () => {
  delete process.env.CCMINI_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("transcript", () => {
  test("writes one JSON entry per line", async () => {
    await appendTranscriptEntry({
      type: "event",
      sessionId: "s1",
      uuid: "e1",
      timestamp: "2026-05-26T00:00:00.000Z",
      event: "api_retry",
      data: { attempt: 1 },
    });

    const file = join(home, "projects", process.cwd().replace(/[^a-zA-Z0-9._-]/g, "-"), "s1.jsonl");
    const text = await readFile(file, "utf8");

    expect(text.trim().split("\n")).toHaveLength(1);
  });

  test("restores message chain and ignores events", async () => {
    await recordTranscriptMessage({ role: "user", content: "hi" });
    await appendTranscriptEntry({
      type: "event",
      sessionId: "s1",
      uuid: "e1",
      timestamp: "2026-05-26T00:00:00.000Z",
      event: "api_retry",
      data: { attempt: 1 },
    });
    await recordTranscriptMessage({ role: "assistant", content: "hello" });

    const file = join(home, "projects", process.cwd().replace(/[^a-zA-Z0-9._-]/g, "-"), `${process.env.CCMINI_SESSION_ID}.jsonl`);
    const entries = await readTranscriptFile(file);
    const restored = restoreMessages(entries);

    expect(restored.map(message => message.role)).toEqual(["user", "assistant"]);
  });
});
```

如果你的 `getSessionId()` 不是环境变量实现，测试里按你的 session state 注入即可。核心断言是：event 写入 transcript，但恢复对话时不进入 message chain。

## 第十六步：性能和写入策略

Mini 现在直接 `appendFile()`。这对课程足够，但你要知道它的边界。

适合直接写：

- 用户消息。
- 完整 assistant 消息。
- API retry/fallback 事件。
- 少量 system 事件。

不适合直接写：

- 每个 streaming token。
- 高频 progress tick。
- 每行 shell 输出。
- 大块工具结果的完整内容。

后续优化方向：

- 用内存队列批量 flush。
- 为单条 entry 设置大小上限。
- 大工具结果写到 side file，transcript 只存引用。
- 保留最近 N 条 debug log，自动清理旧文件。

真实工程的 `sessionStorage.ts` 已经做了按文件队列、100ms flush、队列上限、读取大小上限和 tombstone 处理。Mini 先把接口边界搭好。

## 第十七步：运行验证

运行新增测试：

```bash
bun test src/logging/__tests__/redact.test.ts
bun test src/logging/__tests__/events.test.ts
bun test src/transcript/__tests__/transcript.test.ts
```

运行类型检查：

```bash
bun run typecheck
```

手动验证：

```bash
bun run dev
```

在 REPL 中执行：

```txt
> /debug on
> /transcript
```

然后触发一次模型请求，确认：

- transcript 文件出现 message entry。
- debug 文件出现请求相关日志。
- token 没有出现在任何输出里。

## 常见问题

### Debug log 和 transcript 为什么分开

因为它们的用途不同。

Debug log 是开发者调试程序用的，里面可以记录模块名、耗时、fallback 细节。Transcript 是会话恢复依据，应该稳定、结构化、可解析。

把 debug 文本塞进 transcript，会污染会话恢复；把 transcript 当 debug 文件，又会让排查缺少上下文级别和模块信息。

### Event 为什么不参与 parentUuid 链

`parentUuid` 表示对话消息之间的逻辑顺序。API retry、model fallback 这类 event 是运行时事实，不是用户或 assistant 的对话内容。

恢复会话时，模型只需要 message chain。复盘时，UI 可以把 event 按 timestamp 插入时间线展示。

### 为什么不每个 token 写 transcript

因为 token 流不是稳定会话状态。streaming 失败、fallback、用户中断时，半条 token 流可能需要撤销。

Transcript 应记录稳定结果：完整 user message、完整 assistant message、必要 system boundary、运行时 event。

### 日志里可以写文件路径吗

本地 debug log 可以写文件路径，但 event log 尽量不要写。真实工程的 analytics metadata 对字符串非常谨慎，就是为了避免把代码、路径或隐私内容发到低敏统计通道。

Mini 当前只做本地 event bus，但也应该提前养成边界：event data 放枚举、数字、布尔值和低敏短字符串。

### Secret 脱敏能保证万无一失吗

不能。正则脱敏只是最后一道防线。

更重要的做法是：

- 不把 token 放进普通对象。
- 不打印完整 request headers。
- 不记录完整环境变量。
- 不把 SDK error 原样 JSON stringify 后写日志。

## 本章检查清单

完成后确认：

1. debug log、event、transcript 是三套入口。
2. 所有入口都会脱敏。
3. transcript 是 JSONL，一行一个 entry。
4. message entry 有 `uuid`、`parentUuid`、`sessionId`、`timestamp`。
5. event entry 不参与 message parent 链。
6. API retry/fallback 会 emit runtime event。
7. `/debug on` 能开启 debug 文件写入。
8. `/transcript` 能输出当前 transcript 路径。
9. 恢复逻辑只恢复 message entry。

验证命令：

```bash
bun test src/logging/__tests__/redact.test.ts
bun test src/logging/__tests__/events.test.ts
bun test src/transcript/__tests__/transcript.test.ts
bun run typecheck
```

## 小结

本章为 Mini 加了运行时记录层：

- debug log 用于开发排查。
- event bus 用于低敏结构化事件。
- transcript 用于恢复、导出和复盘。
- runtime event 把第二十一章的 retry/fallback 记录下来。

到这里，Mini 已经不只是“能运行”，还开始具备可观测性。下一章可以继续做会话恢复增强：从 transcript 恢复上下文、实现 `/resume`、`/continue` 和会话列表。
