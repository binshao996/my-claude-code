# 01 - Workspace 概念模型

## 当前章节目标

本章定义 Workspace 的产品模型。

完成后，读者应该理解：

- Workspace 不是简单的 `cwd`。
- Workspace 是 Client 的项目上下文对象。
- Runtime、Chat、File Tree、Editor、Terminal 都应该挂在 Workspace 下面。

## 为什么需要 Workspace

V0/V1 中，Runtime 通过 `cwd` 知道当前目录：

```text
createRuntimeClient(cwd)
```

这对打通链路足够，但对企业级 Client 不够。

AI Coding Agent Client 的用户不是在“一个目录字符串”里工作，而是在“一个项目”里工作。项目有名字、路径、最近访问时间、会话历史、记忆文件、打开的 tab、终端、权限和策略。

所以 V2 的核心转变是：

```text
cwd
  -> Workspace
  -> Project-scoped Runtime
```

## Workspace 类型

```ts
export type WorkspaceId = string;

export type Workspace = {
  id: WorkspaceId;
  rootPath: string;
  displayName: string;
  openedAt: number;
  lastActiveAt: number;
  metadata: WorkspaceMetadata;
};

export type WorkspaceMetadata = {
  gitRootPath: string | null;
  packageManager: "bun" | "pnpm" | "npm" | "yarn" | null;
  hasClaudeMemory: boolean;
  hasGitRepository: boolean;
};
```

## id 如何设计

教学版可以用 root path hash：

```ts
export function createWorkspaceId(rootPath: string): string {
  return stableHash(normalizePath(rootPath));
}
```

不要直接把绝对路径当 id。

原因：

- 路径里可能包含用户名或敏感项目名。
- id 需要适合做 Map key、storage key。
- 后续同步或远程场景中，路径不一定稳定。

## displayName 如何设计

```ts
export function getWorkspaceDisplayName(rootPath: string): string {
  return path.basename(rootPath);
}
```

教学版先用目录名。生产实现可以补充：

- 从 `package.json.name` 获取项目名。
- 从 git remote 推导仓库名。
- 用户自定义 alias。
- monorepo package 子项目名。

## metadata 的边界

V2 的 metadata 只放轻量信息：

```text
git root
package manager
CLAUDE.md 是否存在
是否 git 仓库
```

不要在 V2 扫描整个项目，也不要构建文件索引。

原因是文件扫描属于 V3 File Tree。如果 V2 过早扫描项目，会把 Workspace 和 File Tree 的职责混在一起。

## 和 Runtime 的映射

当前 `claude-code-mini` 中几个模块已经以 `cwd` 为核心：

| Runtime 模块 | 当前依赖 | Workspace 映射 |
| --- | --- | --- |
| `ChatSession` | `cwd` | `workspace.rootPath` |
| `SessionStore` | constructor `cwd` | project-scoped transcript |
| `MemoryStore` | constructor `cwd` | project memory |
| ToolContext | `cwd` | tool execution root |
| Runtime context | `Working directory` | workspace root |

V2 不改 Runtime。V2 只在 Client 侧建立更清晰的产品对象。

## 完整核心代码

```ts
export function createWorkspace(rootPath: string): Workspace {
  const normalizedRoot = normalizePath(rootPath);
  const now = Date.now();

  return {
    id: createWorkspaceId(normalizedRoot),
    rootPath: normalizedRoot,
    displayName: getWorkspaceDisplayName(normalizedRoot),
    openedAt: now,
    lastActiveAt: now,
    metadata: inspectWorkspaceMetadata(normalizedRoot),
  };
}
```

```ts
export function inspectWorkspaceMetadata(rootPath: string): WorkspaceMetadata {
  return {
    gitRootPath: findGitRoot(rootPath),
    packageManager: detectPackageManager(rootPath),
    hasClaudeMemory: fileExists(path.join(rootPath, "CLAUDE.md")),
    hasGitRepository: Boolean(findGitRoot(rootPath)),
  };
}
```

这里的 `findGitRoot()`、`detectPackageManager()`、`fileExists()` 都应该是小函数，不要引入复杂项目扫描。

## 调试验证

用三个目录验证：

- 普通空目录。
- 有 `.git` 的目录。
- 有 `bun.lock` 或 `pnpm-lock.yaml` 的目录。

预期：

- `rootPath` 被标准化。
- `displayName` 是目录名。
- `id` 对同一路径稳定。
- metadata 不会因为缺少 git 或 lockfile 抛异常。

## 本章实操标准

### 本章效果

完成本章后，Client 里必须出现一个独立的 Workspace 产品对象：

```text
rootPath
  -> createWorkspace()
  -> Workspace { id, displayName, metadata }
  -> WorkspaceService / Store / Header 后续复用
```

本章不打开系统目录选择器，但要让后续所有章节都围绕 `Workspace`，而不是裸 `cwd` 字符串。

### 改动文件

本章改动文件：

```text
src/renderer/workspace/types.ts
src/main/workspace/createWorkspace.ts
src/main/workspace/workspaceValidation.ts
src/main/workspace/workspaceMetadata.ts
src/main/workspace/createWorkspace.test.ts
```

如果项目习惯把共享类型放在 `src/shared/`，也可以放到既有共享目录，但后续 `main` 和 `renderer` 必须 import 同一份 `Workspace` 类型。

### 实现步骤

1. 定义 `WorkspaceId`、`Workspace`、`WorkspaceMetadata`，其中 `rootPath` 是标准化后的绝对路径。
2. 实现 `createWorkspaceId(rootPath)`，用稳定 hash，不把绝对路径直接当 id。
3. 实现 `getWorkspaceDisplayName(rootPath)`，教学版先取目录名。
4. 实现 `inspectWorkspaceMetadata(rootPath)`，只检查 git root、package manager、`CLAUDE.md`、是否 git 仓库。
5. 实现 `createWorkspace(rootPath)`，把 id、displayName、openedAt、lastActiveAt、metadata 统一组装出来。
6. 写单测覆盖空目录、有 git、带 `pnpm-lock.yaml` 或 `bun.lock` 的目录。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

本章跑完测试后应该能确认：

- 同一路径多次调用 `createWorkspace()` 得到相同 `id`。
- `displayName` 是项目目录名，不是完整绝对路径。
- 缺少 `.git`、lockfile 或 `CLAUDE.md` 不会抛异常，只会让 metadata 对应字段为空或 false。
- `rootPath` 被标准化，后续 Runtime 使用的是同一份路径。
- Workspace 对象没有包含文件树节点、打开 tab 或聊天消息。

### 常见报错

- id 每次都变：确认 hash 输入只来自 normalized root path，不包含时间戳。
- metadata 检查抛异常：文件不存在应返回 false/null，不要把缺失 lockfile 当错误。
- renderer 无法 import 类型：确认类型文件在 main/renderer 都可访问的位置，或只用 `import type` 避免打包主进程依赖。
- V2 开始扫描整个项目：这是 V3 职责，本章 metadata 只能做轻量存在性检查。
- 绝对路径泄漏到 id/storage key：id 用 hash，UI 展示路径可以用 `rootPath`。

## 可运行验收

本章完成后先跑：

```bash
pnpm test src/main/workspace/createWorkspace.test.ts
pnpm typecheck
```

本章结束时不要求 UI 可见，但后续章节必须复用这里的 `Workspace` 类型，不再临时传裸 `cwd`。

## 当前章节缺陷

本章只定义模型，不处理用户如何选择目录，也不处理最近项目持久化。

## 下一章预告

下一章会实现“打开项目与最近项目”：用户如何通过 Client 选择一个目录，并把它加入最近项目列表。
