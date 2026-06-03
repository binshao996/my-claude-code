# 05 - 打开文件意图

## 当前章节目标

本章实现 `OpenFileIntent`。

完成后，File Tree 和 File Search 都不直接操作 Editor，而是发出统一的打开文件请求。

## 为什么需要 OpenFileIntent

V3 还没有 Editor。如果文件树直接假设存在 `editor.open()`，会让 V3 和 V4 强耦合。

更好的方式是定义意图：

```text
用户想打开这个文件
```

至于怎么打开，由 V4 Editor 决定。

## 类型定义

```ts
export type OpenFileIntent = {
  workspaceId: string;
  relativePath: string;
  source: "file-tree" | "file-search" | "agent-activity";
  preview: boolean;
};
```

## 从文件树发出意图

```tsx
function handleNodeClick(node: FileTreeNode) {
  dispatch({ type: "select_node", nodeId: node.id });

  if (node.type === "directory") {
    dispatch({ type: "toggle_expanded", nodeId: node.id });
    return;
  }

  emitOpenFileIntent({
    workspaceId,
    relativePath: node.relativePath,
    source: "file-tree",
    preview: true,
  });
}
```

## 从搜索结果发出意图

```tsx
function handleSearchOpen(item: FileSearchItem) {
  emitOpenFileIntent({
    workspaceId,
    relativePath: item.relativePath,
    source: "file-search",
    preview: false,
  });
}
```

搜索结果通常更像“明确打开”，所以可以用 `preview: false`。

## 和 Runtime 的关系

打开文件给用户看，不等于让 Agent 读取文件。

如果用户希望 Agent 分析当前文件，后续可以把打开文件作为上下文附加到 prompt。但那是新的产品动作。

V3 只建立路径桥：

```text
File Tree relativePath
  -> OpenFileIntent.relativePath
  -> V4 Editor
  -> later: attach to Agent context
```

## 安全边界

`OpenFileIntent.relativePath` 必须来自 File Tree 或经过路径校验，不能让任意 renderer 字符串直接变成文件读取。

主进程打开文件时仍要校验：

```ts
export function assertPathInsideWorkspace(
  workspace: Workspace,
  relativePath: string,
): string {
  const absolutePath = path.resolve(workspace.rootPath, relativePath);
  const relativeToRoot = path.relative(workspace.rootPath, absolutePath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("File path must stay inside workspace.");
  }

  return absolutePath;
}
```

这个校验和 Runtime 的 `resolveToolPath()`、sandbox 校验是同一类边界，但服务于用户打开文件。

## 调试验证

验证：

- 点击目录只展开，不发出 open intent。
- 点击文件发出 `source: "file-tree"`。
- 点击搜索结果发出 `source: "file-search"`。
- `relativePath` 不包含 Workspace 绝对路径。
- 切换 Workspace 后旧 intent 不应打开新 Workspace 的同名路径。

## 本章实操标准

### 本章效果

完成本章后，文件树点击和搜索结果点击都会发出统一的打开文件意图，并在 V3 里先写入日志/状态面板：

```text
FileTreeNode click
  -> select_node / toggle_expanded
  -> emitOpenFileIntent({ source: "file-tree" })

FileSearchBox result click
  -> select_node
  -> emitOpenFileIntent({ source: "file-search" })
```

V3 不读取文件内容，也不打开 Editor，只交付 V4 可以消费的 `OpenFileIntent`。

### 改动文件

本章改动文件：

```text
src/renderer/file-tree/openFileIntent.ts
src/renderer/file-tree/fileTreeStore.ts
src/renderer/components/FileTreePanel.tsx
src/renderer/components/FileTreeNode.tsx
src/renderer/components/FileSearchBox.tsx
src/renderer/components/OpenFileIntentLog.tsx
src/main/file-tree/assertPathInsideWorkspace.ts
```

如果还没有 V4 Editor，本章用 `OpenFileIntentLog` 展示最近一次 intent；不要新增假的 editor。

### 实现步骤

1. 在 `openFileIntent.ts` 实现 `emitOpenFileIntent(intent)`，教学版可以写入 store 或调用传入 callback。
2. 文件树点击时：目录只 `toggle_expanded`，文件先 `select_node`，再发 `source: "file-tree", preview: true`。
3. 搜索结果点击时：先 `select_node`，再发 `source: "file-search", preview: false`。
4. `OpenFileIntentLog` 显示最近 intent 的 `workspaceId`、`relativePath`、`source`、`preview`，用于 V3 验收。
5. 在 main 侧补 `assertPathInsideWorkspace(workspace, relativePath)`，为 V4 读取文件前的路径校验做准备。
6. 单测或手动验证 `../outside.ts`、绝对路径、空路径不会通过路径校验。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 `pnpm dev` 后验证：

- 点击目录只展开/折叠，不更新 `OpenFileIntentLog`。
- 点击文件树里的 `package.json`，日志显示 `source: file-tree`、`preview: true`、`relativePath: package.json`。
- 搜索 `main` 后点击结果，日志显示 `source: file-search`、`preview: false`。
- 日志不显示 workspace 绝对路径，只显示 workspaceId 和 relativePath。
- 切换 workspace 后，旧 workspace 的 intent 不会用于新 workspace 的同名文件。
- 手动构造 `../package.json` 时，main 侧校验返回错误。

### 常见报错

- 点击目录也发 intent：先判断 `node.type === "directory"` 并 return。
- intent 带绝对路径：从 node 取 `relativePath`，不要取 `absolutePath`。
- 搜索点击没有选中树：搜索结果的 item 要保留 `node.id`，点击时 dispatch `select_node`。
- workspace 切换后打开错项目文件：intent 必须带 `workspaceId`，消费方必须校验它等于当前 workspace。
- 路径越界校验漏掉绝对路径：同时检查 `path.relative()` 是否以 `..` 开头，以及结果是否仍为绝对路径。

## 可运行验收

本章完成后执行 V3 完整 smoke check：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

最终页面必须能打开 workspace、显示文件树、搜索文件，并在点击文件或搜索结果时看到 `OpenFileIntent` 日志。

## 当前章节缺陷

本章只发出意图，不读取文件内容，也不展示 Editor。

## 下一版本预告

V4 会实现 Editor。

V4 会消费本章的 `OpenFileIntent`：

```text
OpenFileIntent
  -> read file content
  -> create editor tab
  -> Monaco Editor
  -> dirty state
  -> save
```

到 V4，Client 会第一次具备真实代码阅读和编辑能力。
