# 02 - 目录扫描与忽略规则

## 当前章节目标

本章实现从 `Workspace.rootPath` 扫描项目目录，并应用基础忽略规则。

完成后，Client 可以得到一棵可展示的 `FileTreeNode`。

## 为什么扫描要谨慎

项目目录可能很大：

- `node_modules`
- `.git`
- `dist`
- `coverage`
- monorepo packages
- 生成文件

如果打开项目时一次性扫描所有文件，Client 会卡顿，甚至把大量无意义文件塞进 UI。

## 默认忽略规则

教学版先内置一组基础规则：

```ts
export const DEFAULT_IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);
```

生产实现要合并：

- `.gitignore`
- `.ignore`
- 用户设置
- 企业策略
- Runtime sandbox policy

V3 先不完整实现 `.gitignore` parser，避免章节变成 ignore 规则教程。

## IgnoreMatcher

```ts
export type IgnoreMatcher = {
  shouldIgnore(relativePath: string, name: string): boolean;
};

export function createDefaultIgnoreMatcher(): IgnoreMatcher {
  return {
    shouldIgnore(_relativePath, name) {
      return DEFAULT_IGNORED_NAMES.has(name);
    },
  };
}
```

## 扫描限制

```ts
export type ScanOptions = {
  maxDepth: number;
  maxNodes: number;
};

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  maxDepth: 8,
  maxNodes: 5000,
};
```

限制不是偷懒，而是产品安全阀。企业项目里，任何文件系统扫描都需要上限。

## scanDirectory

```ts
export async function scanDirectory(input: {
  workspaceId: string;
  rootPath: string;
  currentPath: string;
  relativePath: string;
  depth: number;
  options: ScanOptions;
  ignore: IgnoreMatcher;
  counter: { value: number };
}): Promise<FileTreeNode> {
  if (input.counter.value > input.options.maxNodes) {
    throw new Error("File tree scan exceeded max node limit.");
  }

  const stat = await fs.promises.stat(input.currentPath);
  const name = input.relativePath ? path.basename(input.currentPath) : path.basename(input.rootPath);

  const node: FileTreeNode = {
    id: createFileNodeId(input.workspaceId, input.relativePath),
    name,
    relativePath: toPosixPath(input.relativePath),
    absolutePath: input.currentPath,
    type: stat.isDirectory() ? "directory" : "file",
    depth: input.depth,
    size: stat.isFile() ? stat.size : null,
  };

  input.counter.value++;

  if (!stat.isDirectory() || input.depth >= input.options.maxDepth) {
    return node;
  }

  const entries = await fs.promises.readdir(input.currentPath, { withFileTypes: true });
  const children: FileTreeNode[] = [];

  for (const entry of sortDirEntries(entries)) {
    const childRelativePath = joinPosix(input.relativePath, entry.name);
    if (input.ignore.shouldIgnore(childRelativePath, entry.name)) {
      continue;
    }

    children.push(
      await scanDirectory({
        ...input,
        currentPath: path.join(input.currentPath, entry.name),
        relativePath: childRelativePath,
        depth: input.depth + 1,
      }),
    );
  }

  return { ...node, children };
}
```

## 排序规则

```ts
export function sortDirEntries(entries: fs.Dirent[]): fs.Dirent[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
}
```

目录优先、名称排序，是最符合 IDE 用户习惯的默认行为。

## FileTreeService

```ts
export class FileTreeService {
  async loadTree(workspace: Workspace): Promise<FileTreeNode> {
    return scanDirectory({
      workspaceId: workspace.id,
      rootPath: workspace.rootPath,
      currentPath: workspace.rootPath,
      relativePath: "",
      depth: 0,
      options: DEFAULT_SCAN_OPTIONS,
      ignore: createDefaultIgnoreMatcher(),
      counter: { value: 0 },
    });
  }
}
```

## 调试验证

验证一个包含这些目录的项目：

```text
.git/
node_modules/
src/
package.json
dist/
```

预期：

- `.git` 不出现。
- `node_modules` 不出现。
- `dist` 不出现。
- `src` 和 `package.json` 出现。
- 目录排在文件前面。

## 本章实操标准

### 本章效果

完成本章后，main 侧能从当前 Workspace root 扫描出一棵安全、有上限、已过滤的文件树：

```text
Workspace.rootPath
  -> FileTreeService.loadTree()
  -> scanDirectory()
  -> ignoreMatcher.shouldIgnore()
  -> FileTreeNode root
  -> fileTreeIpc.loadFileTree()
```

本章的可运行效果可以先体现在 IPC 返回值或调试日志；下一章再渲染 UI。

### 改动文件

本章改动文件：

```text
src/main/file-tree/ignoreMatcher.ts
src/main/file-tree/scanDirectory.ts
src/main/file-tree/FileTreeService.ts
src/main/ipc/fileTreeIpc.ts
src/preload/fileTreeApi.ts
src/main/file-tree/scanDirectory.test.ts
```

IPC 三侧建议：

```text
main:    ipcMain.handle("fileTree:load", ...)
preload: window.fileTree.loadFileTree(workspaceId)
renderer: fileTreeApi.loadFileTree(workspaceId)
```

renderer 只传 `workspaceId`，root path 由 main 侧 WorkspaceService 查。

### 实现步骤

1. 在 `ignoreMatcher.ts` 定义 `DEFAULT_IGNORED_NAMES` 和 `createDefaultIgnoreMatcher()`。
2. 在 `scanDirectory.ts` 实现 `DEFAULT_SCAN_OPTIONS`、`sortDirEntries()`、`scanDirectory()`，包含 `maxDepth` 和 `maxNodes` 上限。
3. 递归扫描时先计算 child relative path，再用 `ignore.shouldIgnore(childRelativePath, entry.name)` 过滤。
4. 生成节点时使用上一章的 `createFileNodeId()` 和 POSIX relative path。
5. 在 `FileTreeService.loadTree(workspace)` 中注入默认 ignore matcher 和 scan options。
6. 在 `fileTreeIpc.ts` 通过 `workspaceId` 查 Workspace，再调用 `FileTreeService`；找不到 workspace 要返回明确错误。
7. 用临时目录单测覆盖 `.git`、`node_modules`、`dist` 被忽略，目录排在文件前。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

用包含这些内容的项目验证：

```text
.git/
node_modules/
dist/
src/main.ts
package.json
```

预期：

- `scanDirectory()` 返回的 children 里有 `src` 和 `package.json`。
- `.git`、`node_modules`、`dist` 不出现在 root children。
- `src` 这类目录排在 `package.json` 前面。
- 超过 `maxNodes` 时抛出 `File tree scan exceeded max node limit.`。
- IPC 调用 `loadFileTree(workspace.id)` 返回的是 root node，不暴露 renderer 传入的任意 root path。

### 常见报错

- 扫描到 `node_modules`：确认 ignore 判断发生在递归进入子目录之前。
- UI/IPC 卡死：确认有 `maxDepth`、`maxNodes`，并且 counter 每创建一个节点就递增。
- Windows 路径搜索失败：UI 和 intent 用 POSIX relative path，文件系统访问再用 `path.join`。
- renderer 能传 rootPath：修正 IPC，只接受 `workspaceId`，root path 必须从 main store 查。
- symlink 循环：教学版可以先跳过 symlink 或按文件处理，不要递归跟随。

## 可运行验收

本章完成后执行：

```bash
pnpm test src/main/file-tree/scanDirectory.test.ts
pnpm typecheck
```

如果已经接入 IPC，也运行 `pnpm dev`，打开 workspace 后在调试日志确认 `fileTree:load` 返回 root node。

## 当前章节缺陷

本章是一次性扫描，还没有按需展开和文件监听。

## 下一章预告

下一章会实现 FileTree Store：把扫描结果、展开节点、选中文件、加载状态和错误状态统一管理起来。
