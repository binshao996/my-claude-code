# 第 17 章：实现 Memory

从这一章开始，Mini Claude Code 进入“更像真实工具”的阶段。

前面十六章已经实现了 CLI、模型连接、流式输出、工具调用、Agent Loop、编辑、上下文压缩、权限、完整闭环和质量门禁。现在的问题是：每次启动后，CLI 都像一个没有项目背景的新同事。它不知道这个仓库的命令规范，不知道用户偏好，也不知道哪些本地约定不能提交。

真实 Claude Code 用 `CLAUDE.md` 解决这类问题。本章会为 Mini 实现一个轻量 Memory 系统：

- 启动时自动发现并读取记忆文件。
- 将记忆注入模型请求的上下文。
- 支持 `/memory` 查看当前加载的记忆。
- 支持 `/remember <内容>` 写入本地记忆。
- 避免把 token、key、password 这类敏感信息写入记忆。

本章不会实现自动长期记忆、向量检索或复杂的团队记忆同步。那些能力可以建立在本章的接口之上，但不应该一开始就塞进主循环。

## 本章目标

完成本章后，你会拥有：

1. 一个 `src/memory/` 模块，负责发现、读取、渲染和更新记忆文件。
2. 一套固定的 Memory 加载优先级。
3. 一段可注入模型请求的 Memory Prompt。
4. `/memory` 和 `/remember` 两个 REPL 命令。
5. Memory 的单元测试。

这一章的重点不是“记得越多越好”，而是把记忆变成一个可控、可解释、可测试的上下文来源。

## 本章完成效果

假设项目中有一个 `CLAUDE.md`：

```md
# Project Memory

- Use Bun for scripts and tests.
- Keep CLI output concise.
- Do not commit `CLAUDE.local.md`.
```

启动 Mini 后，用户输入：

```txt
> /memory
```

输出：

```txt
Loaded memory files:
- project  /repo/CLAUDE.md
```

用户继续输入：

```txt
> /remember 本地调试默认使用 deepseek-v4-flash
```

CLI 会写入当前目录的 `CLAUDE.local.md`：

```md
# Local Memory

- 2026-05-26 本地调试默认使用 deepseek-v4-flash
```

下一次模型请求时，Mini 会把这些内容放入 system context，而不是把它们伪装成用户消息。

## 本章项目结构变化

新增：

```txt
src/
  memory/
    types.ts
    paths.ts
    load.ts
    write.ts
    store.ts
tests/
  memory.test.ts
```

修改：

```txt
src/chat/session.ts
src/chat/chatLoop.ts
```

如果你的 Mini 项目里文件名和前面章节略有不同，按同样职责接入即可：

- “发请求前组织上下文”的地方接入 `MemoryStore.getPrompt()`。
- “处理 REPL slash command”的地方接入 `/memory` 和 `/remember`。

注意不要把第 13、15 章的 `/plan` 分发覆盖掉。

本章新增命令后，slash command 至少要继续保留：

```txt
/plan
/plan show
/plan clear
/plan exit
/memory
/remember <content>
```

其中 `/plan` 仍然是进入 Mini plan mode，`/plan show` 才是查看当前计划。

## 为什么需要这个模块

没有 Memory 时，用户只能反复在 prompt 里补充背景：

```txt
这个项目用 Bun，不要给我 Node 脚本。
这个仓库要求先跑 typecheck。
本地 DeepSeek 走 Anthropic-compatible endpoint。
```

这些信息有三个特点：

1. 长期有效。
2. 和项目或用户偏好相关。
3. 每次都手动输入很浪费上下文。

Memory 模块就是把这类信息沉淀成文件，然后在每次请求时稳定注入。

但 Memory 也有边界。它不应该保存：

- API key、token、password。
- 已经过期的临时任务状态。
- 可以从源码直接读出的函数路径和实现细节。
- 未经验证的“某文件一定做某事”。

真实项目里，Memory 最大的风险不是“不够聪明”，而是“悄悄变脏”。所以本章的实现会保持简单，并让用户可以看到当前加载了哪些文件。

## 整体架构

Memory 不应该直接嵌进 Agent Loop。它是上下文来源之一，和 Git 状态、当前时间、工作目录信息类似。

```txt
CLAUDE.md files
      |
      v
MemoryStore
      |
      v
renderMemoryPrompt()
      |
      v
ContextManager / AgentLoop
      |
      v
Model request system context
```

推荐的职责划分：

| 模块 | 职责 |
| --- | --- |
| `paths.ts` | 计算候选记忆文件路径 |
| `load.ts` | 读取、清洗、渲染记忆 |
| `write.ts` | 写入本地记忆 |
| `store.ts` | 缓存和刷新 Memory |
| `chatLoop.ts` | 处理 `/memory`、`/remember` |
| `session.ts` | 在模型请求前注入 Memory Prompt |

这样做有一个关键收益：Memory 的加载、写入、注入和交互是分开的。后面你想加团队记忆、自动记忆或禁用开关时，不需要重写主循环。

## 加载优先级

Mini 采用下面的顺序加载：

1. 用户记忆：`~/.ccmini/CLAUDE.md`
2. 项目记忆：从仓库根到当前目录逐层查找 `CLAUDE.md`
3. 项目配置记忆：从仓库根到当前目录逐层查找 `.claude/CLAUDE.md`
4. 本地记忆：当前目录 `CLAUDE.local.md`

后加载的内容优先级更高，但 Mini 不做内容合并冲突解析。模型会看到所有文件，以及每个文件来自哪里。

为什么本地记忆最后加载？

因为 `CLAUDE.local.md` 通常代表个人机器上的偏好，比如本地端口、临时调试模型、私有路径。它不应该提交到仓库，也不应该覆盖团队共享文件时不被用户察觉。

建议把它加入项目 `.gitignore`：

```gitignore
CLAUDE.local.md
```

## 核心流程

一次完整的请求流程如下：

```txt
用户输入
  |
  |-- slash command?
  |      |
  |      |-- /memory   -> 打印已加载文件
  |      |-- /remember -> 追加到 CLAUDE.local.md 并刷新缓存
  |
  v
普通对话
  |
  v
MemoryStore.load()
  |
  v
ContextManager.prepare(messages)
  |
  v
system context = base system + memory prompt + runtime context
  |
  v
Anthropic-compatible request
```

注意：Memory Prompt 不建议作为一条普通 user message 插入对话历史。

原因很简单：Memory 是运行时上下文，不是用户本轮输入。它应该参与请求，但不应该污染 session transcript，也不应该被 `/compact` 当作聊天内容反复压缩。

## 完整核心代码

下面的代码按模块拆开，方便直接放进 Mini 项目。

### `src/memory/types.ts`

```ts
export type MemoryScope = "user" | "project" | "local";

export type MemoryFile = {
  path: string;
  scope: MemoryScope;
  content: string;
};

export type MemoryLoadResult = {
  files: MemoryFile[];
  prompt: string | null;
};

export const MEMORY_PROMPT_HEADER =
  "Codebase and user instructions are shown below. Follow them when they are relevant to the current task.";
```

### `src/memory/paths.ts`

```ts
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export function getMiniHome(): string {
  return process.env.CCMINI_HOME ?? join(homedir(), ".ccmini");
}

export function getUserMemoryPath(): string {
  return join(getMiniHome(), "CLAUDE.md");
}

function ancestorsFromRoot(cwd: string): string[] {
  const start = resolve(cwd);
  const root = parse(start).root;
  const dirs: string[] = [];

  let current = start;
  while (true) {
    dirs.push(current);
    if (current === root) break;
    current = dirname(current);
  }

  return dirs.reverse();
}

export function getProjectMemoryCandidates(cwd: string): string[] {
  return ancestorsFromRoot(cwd).flatMap((dir) => [
    join(dir, "CLAUDE.md"),
    join(dir, ".claude", "CLAUDE.md"),
  ]);
}

export function getLocalMemoryPath(cwd: string): string {
  return join(resolve(cwd), "CLAUDE.local.md");
}
```

这个实现会从文件系统根一路查到当前目录。真实工具通常会结合项目根、工作树和配置目录做更精细的过滤。Mini 先保持透明：候选路径怎么来，一眼能看懂。

### `src/memory/load.ts`

```ts
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { MEMORY_PROMPT_HEADER, type MemoryFile, type MemoryLoadResult } from "./types";
import { getLocalMemoryPath, getProjectMemoryCandidates, getUserMemoryPath } from "./paths";

const MAX_MEMORY_CHARS = 40_000;
const TEXT_EXTENSIONS = new Set(["", ".md", ".txt"]);

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + "\n---\n".length);
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function isAllowedTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path));
}

function resolveIncludePath(baseFile: string, value: string): string {
  if (isAbsolute(value)) return value;
  return resolve(dirname(baseFile), value);
}

async function readInclude(baseFile: string, includeValue: string): Promise<string | null> {
  const includePath = resolveIncludePath(baseFile, includeValue);
  if (!isAllowedTextFile(includePath)) return null;
  if (!(await fileExists(includePath))) return null;
  return readFile(includePath, "utf8");
}

async function expandIncludes(path: string, content: string): Promise<string> {
  const lines = content.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    const match = line.match(/^@(.+)$/);
    if (!match) {
      output.push(line);
      continue;
    }

    const included = await readInclude(path, match[1].trim());
    if (included === null) {
      output.push(line);
      continue;
    }

    output.push(included.trim());
  }

  return output.join("\n");
}

async function readMemoryFile(path: string, scope: MemoryFile["scope"]): Promise<MemoryFile | null> {
  if (!(await fileExists(path))) return null;

  const raw = await readFile(path, "utf8");
  const withIncludes = await expandIncludes(path, raw);
  const content = stripHtmlComments(stripFrontmatter(withIncludes)).slice(0, MAX_MEMORY_CHARS);

  if (content.trim().length === 0) return null;
  return { path, scope, content: content.trim() };
}

export function renderMemoryPrompt(files: MemoryFile[]): string | null {
  if (files.length === 0) return null;

  const sections = files.map((file) => {
    return `Contents of ${file.path} (${file.scope} memory):\n\n${file.content}`;
  });

  return `${MEMORY_PROMPT_HEADER}\n\n${sections.join("\n\n")}`;
}

export async function loadMemory(cwd: string): Promise<MemoryLoadResult> {
  const files: MemoryFile[] = [];

  const user = await readMemoryFile(getUserMemoryPath(), "user");
  if (user) files.push(user);

  for (const path of getProjectMemoryCandidates(cwd)) {
    const project = await readMemoryFile(path, "project");
    if (project) files.push(project);
  }

  const local = await readMemoryFile(getLocalMemoryPath(cwd), "local");
  if (local) files.push(local);

  return {
    files,
    prompt: renderMemoryPrompt(files),
  };
}
```

这里实现了一个极简 include 语法：如果某一行是 `@./extra.md`，就把它替换成对应文件内容。这个能力要保守处理：

- 只读取文本文件。
- 文件不存在时保留原行。
- 不执行任何文件内容。
- 不把 include 做成递归系统。

真实项目里 include 会更复杂，也会处理 glob、父子关系、缓存失效和过滤规则。Mini 只需要让用户能拆分少量 Markdown 片段即可。

### `src/memory/write.ts`

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getLocalMemoryPath } from "./paths";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function looksLikeSecret(text: string): boolean {
  return /(api[_-]?key|auth[_-]?token|token|secret|password|private[_-]?key)\s*[:=]/i.test(text);
}

export async function appendLocalMemory(cwd: string, text: string): Promise<string> {
  const value = text.trim();
  if (!value) {
    throw new Error("Memory content cannot be empty.");
  }

  if (looksLikeSecret(value)) {
    throw new Error("Refusing to store content that looks like a secret.");
  }

  const path = getLocalMemoryPath(cwd);
  await mkdir(dirname(path), { recursive: true });

  let previous = "";
  try {
    previous = await readFile(path, "utf8");
  } catch {
    previous = "# Local Memory\n\n";
  }

  const separator = previous.endsWith("\n") ? "" : "\n";
  const next = `${previous}${separator}- ${today()} ${value}\n`;
  await writeFile(path, next, "utf8");
  return path;
}
```

这里没有提供“删除记忆”的命令。删除和整理更适合交给编辑器，因为 Memory 文件本质上就是 Markdown。CLI 只提供最小写入入口。

### `src/memory/store.ts`

```ts
import { loadMemory } from "./load";
import type { MemoryFile, MemoryLoadResult } from "./types";

export class MemoryStore {
  private cached: MemoryLoadResult | null = null;

  constructor(private readonly cwd: string) {}

  async load(): Promise<MemoryLoadResult> {
    if (this.cached) return this.cached;
    this.cached = await loadMemory(this.cwd);
    return this.cached;
  }

  async reload(): Promise<MemoryLoadResult> {
    this.cached = await loadMemory(this.cwd);
    return this.cached;
  }

  async getPrompt(): Promise<string | null> {
    return (await this.load()).prompt;
  }

  async listFiles(): Promise<MemoryFile[]> {
    return (await this.load()).files;
  }
}
```

缓存的目的不是性能优化，而是让同一轮请求里 Memory 保持一致。`/remember` 写入后调用 `reload()`，下一轮请求才看到新内容。

## 接入模型请求

假设第 11 章以后你的 `ChatSession` 已经有 `ContextManager`，现在需要把 Memory Prompt 加入 system context。

示例：

```ts
import { MemoryStore } from "../memory/store";

export class ChatSession {
  private readonly memory: MemoryStore;

  constructor(private readonly cwd: string) {
    this.memory = new MemoryStore(cwd);
  }

  async send(input: string): Promise<void> {
    const memoryPrompt = await this.memory.getPrompt();
    const prepared = this.contextManager.prepare(this.messages);

    await this.agentLoop.run({
      messages: prepared.messages,
      system: [
        this.baseSystemPrompt,
        memoryPrompt,
        prepared.systemContext,
      ].filter(Boolean).join("\n\n"),
    });
  }
}
```

如果你的模型客户端已经接受 `system` 字段，就把 Memory 拼进去。如果你的实现是 `systemMessages: string[]`，则把 `memoryPrompt` 作为其中一个元素。

重点是：不要把 Memory 直接 push 到 `this.messages`。

错误做法：

```ts
this.messages.unshift({
  role: "user",
  content: memoryPrompt,
});
```

这会污染历史消息，并且让压缩、重放和导出都变得混乱。

正确做法是让 Memory 留在请求构造阶段：

```ts
const request = {
  system: renderSystemContext([basePrompt, memoryPrompt, runtimeContext]),
  messages: prepared.messages,
};
```

## 接入 Slash Command

在 REPL 或 `chatLoop.ts` 里增加两个命令。

```ts
import { appendLocalMemory } from "../memory/write";
import { MemoryStore } from "../memory/store";

export class ChatLoop {
  private readonly memory: MemoryStore;

  constructor(private readonly cwd: string) {
    this.memory = new MemoryStore(cwd);
  }

  async handleInput(input: string): Promise<boolean> {
    if (input === "/memory") {
      await this.printMemory();
      return true;
    }

    if (input.startsWith("/remember ")) {
      await this.remember(input.slice("/remember ".length));
      return true;
    }

    return false;
  }

  private async printMemory(): Promise<void> {
    const files = await this.memory.listFiles();
    if (files.length === 0) {
      console.log("No memory files loaded.");
      return;
    }

    console.log("Loaded memory files:");
    for (const file of files) {
      console.log(`- ${file.scope.padEnd(7)} ${file.path}`);
    }
  }

  private async remember(text: string): Promise<void> {
    const path = await appendLocalMemory(this.cwd, text);
    await this.memory.reload();
    console.log(`Saved local memory: ${path}`);
  }
}
```

如果你已经有命令注册表，可以把这两个命令做成独立 handler。原则不变：

- `/memory` 只展示当前状态。
- `/remember` 只写本地记忆。
- 写完必须刷新 Memory 缓存。

## 单元测试

Memory 是纯文件系统逻辑，非常适合写测试。

新增 `tests/memory.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendLocalMemory } from "../src/memory/write";
import { loadMemory } from "../src/memory/load";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccmini-memory-"));
  process.env.CCMINI_HOME = join(dir, "home");
});

afterEach(async () => {
  delete process.env.CCMINI_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("memory", () => {
  test("loads user, project, and local memory", async () => {
    await mkdir(process.env.CCMINI_HOME!, { recursive: true });
    await Bun.write(join(process.env.CCMINI_HOME!, "CLAUDE.md"), "- User preference");
    await Bun.write(join(dir, "CLAUDE.md"), "- Project rule");
    await Bun.write(join(dir, "CLAUDE.local.md"), "- Local override");

    const result = await loadMemory(dir);

    expect(result.files.map((file) => file.scope)).toEqual(["user", "project", "local"]);
    expect(result.prompt).toContain("User preference");
    expect(result.prompt).toContain("Project rule");
    expect(result.prompt).toContain("Local override");
  });

  test("appends local memory and refuses obvious secrets", async () => {
    const path = await appendLocalMemory(dir, "Prefer short answers");
    const content = await Bun.file(path).text();

    expect(content).toContain("Prefer short answers");
    await expect(appendLocalMemory(dir, "api_key = abc")).rejects.toThrow("secret");
  });
});
```

运行：

```bash
bun test tests/memory.test.ts
bun run typecheck
```

## 关键源码分析

真实工程里的 Memory 主要分为四层。

### 1. `src/utils/claudemd.ts`

这是 `CLAUDE.md` 加载的核心。真实实现比 Mini 复杂得多，主要做了这些事：

- 从 managed、user、project、local 多个来源加载记忆。
- 支持 `.claude/CLAUDE.md` 和 `.claude/rules/*.md`。
- 支持 include。
- 清理 frontmatter 和 HTML 注释。
- 限制最大记忆字符数。
- 对文件读取结果做缓存。
- 暴露 `clearMemoryFileCaches()` 让编辑后刷新。

里面有一个非常重要的设计：每个 Memory 都带着来源和路径。模型看到的不只是内容，也能知道内容来自哪个文件。

### 2. `src/context.ts`

真实请求不是在聊天历史里硬塞 `CLAUDE.md`。它会在构造用户上下文时调用 Memory 加载逻辑，然后把格式化后的内容放入 request context。

这和本章设计一致：Memory 是请求上下文，不是普通对话消息。

### 3. `src/commands/memory/memory.tsx`

真实 `/memory` 命令不是简单打印文件，而是让用户选择并编辑 Memory 文件。编辑后会清理缓存并重新加载。

Mini 先做两个更小的命令：

- `/memory` 查看加载状态。
- `/remember` 追加本地记忆。

等 CLI UI 更成熟后，可以再加“打开编辑器选择文件”的体验。

### 4. `src/memdir/memoryTypes.ts`

真实工程还有自动记忆系统，它把长期记忆分成 user、feedback、project、reference 等类型，并且明确规定哪些内容不应该保存。

本章没有实现自动记忆，但要提前吸收它的经验：

- 不要把可从源码推导的信息写入长期记忆。
- 不要保存临时任务状态。
- 对文件路径、函数职责、flag 状态这类信息保持怀疑，使用前要重新验证。

## 调试与验证

建议按下面顺序验证：

```bash
bun test tests/memory.test.ts
bun run typecheck
```

然后手动验证：

```bash
printf '%s\n' '# Project Memory' '' '- Use Bun for all commands.' > CLAUDE.md
bun run dev
```

在 Mini 里输入：

```txt
/memory
/remember 本地默认使用 deepseek-v4-flash
/memory
```

预期：

- 第一次 `/memory` 能看到 `CLAUDE.md`。
- `/remember` 后生成 `CLAUDE.local.md`。
- 第二次 `/memory` 能同时看到 project 和 local memory。
- 发起普通对话时，模型请求的 system context 中包含 Memory Prompt。

如果想检查注入内容，可以在模型请求前临时打印：

```ts
console.error(system);
```

确认后立刻删掉，不要把完整上下文长期打印到日志里。

## 常见问题

### 为什么文件仍然叫 `CLAUDE.md`

这是为了兼容真实 Claude Code 和现有生态。即使你的 Mini 项目不是 Claude Code，沿用这个文件名也能减少迁移成本。

如果你想支持自己的文件名，可以在 `paths.ts` 里额外加入 `MINI.md`。但不要一开始就支持太多名字，否则用户会不知道到底哪个文件生效。

### 为什么 `/remember` 写入 `CLAUDE.local.md`

因为 slash command 写入的内容通常是用户本机偏好，不一定适合团队共享。

团队共享规则应该由人明确写入仓库里的 `CLAUDE.md`，经过代码评审或至少被团队看见。

### 为什么要拒绝疑似 secret 的内容

Memory 会进入模型请求上下文。只要内容被写入 Memory，它就可能被发送给模型 provider。

这个正则不是完整安全方案，但它能挡住最常见的误操作。真正敏感的配置应该通过环境变量传入，而不是写进 Markdown。

### 为什么不实现自动记忆

自动记忆需要回答三个问题：

1. 什么信息值得长期保存？
2. 谁来决定它是正确的？
3. 过期后如何删除或降权？

这三个问题都不属于基础闭环。Mini 应先实现显式记忆，再考虑自动记忆。

### Memory 会不会撑爆上下文

会。所以本章设置了 `MAX_MEMORY_CHARS = 40_000`。

后续可以继续优化：

- 文件级预算。
- 按当前任务关键词筛选片段。
- 对大型 Memory 做摘要。
- 在 `/memory` 里提示过大的文件。

但第一版不要急着做检索系统。先把“可见、可控、可测试”的文件记忆做好。

## 本章小结

本章完成了 Mini 的 Memory 能力：

- 用 `CLAUDE.md` 表达用户和项目长期约定。
- 用 `CLAUDE.local.md` 保存本地偏好。
- 用 `MemoryStore` 隔离缓存和刷新。
- 在请求构造阶段注入 Memory Prompt。
- 用 `/memory` 和 `/remember` 提供最小交互入口。
- 用测试覆盖加载顺序、Prompt 渲染和本地写入。

到这里，Mini 已经不仅能“执行用户这一轮的命令”，还能带着项目约定工作。

下一章可以继续做 Token 预算和上下文裁剪的高级版：把普通历史、工具结果、Memory、Git 状态分成不同预算池，让上下文管理从“能压缩”升级成“能分配”。
