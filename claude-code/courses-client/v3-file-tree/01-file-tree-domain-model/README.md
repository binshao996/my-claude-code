# 01 - 文件树领域模型

## 当前章节目标

本章定义 File Tree 的核心数据结构。

完成后，读者应该理解：

- 文件树节点如何表示。
- 绝对路径和相对路径如何分工。
- 展开、选中、加载状态为什么不应该塞进节点本体。

## 为什么先做领域模型

文件树看起来只是 UI，但它会连接 Workspace、Editor、Runtime 工具和搜索。

如果模型不稳定，后续会出现：

- 点击文件无法打开正确路径。
- 切换 Workspace 后路径串项目。
- 搜索结果和树节点无法对应。
- Agent 工具结果里的路径无法定位到文件树。

## 核心类型

```ts
export type FileNodeType = "file" | "directory";

export type FileTreeNode = {
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  type: FileNodeType;
  depth: number;
  size: number | null;
  children?: FileTreeNode[];
};
```

## relativePath 和 absolutePath

两者都需要，但用途不同：

| 字段 | 用途 |
| --- | --- |
| `absolutePath` | 主进程扫描、文件系统读写 |
| `relativePath` | UI 展示、Runtime 工具输入、跨平台存储 |

Runtime 的 `read_file` 接受相对 cwd 的路径：

```ts
{ path: "src/main.ts" }
```

所以 File Tree 对外发出的打开意图应该优先使用 `relativePath`。

## 节点 id

教学版可以使用：

```ts
export function createFileNodeId(workspaceId: string, relativePath: string): string {
  return `${workspaceId}:${relativePath || "."}`;
}
```

不要只用 `relativePath`。因为不同 Workspace 可能都有 `src/main.ts`。

## 状态不要塞进节点

不要这样设计：

```ts
type BadFileTreeNode = {
  path: string;
  expanded: boolean;
  selected: boolean;
};
```

原因：

- 节点来自文件系统扫描结果。
- 展开和选中是 UI 状态。
- 搜索和打开文件也会改变 UI 状态。

正确方式：

```ts
export type FileTreeState = {
  root: FileTreeNode | null;
  expandedNodeIds: Set<string>;
  selectedNodeId: string | null;
};
```

这样扫描结果和 UI 状态可以独立更新。

## OpenFileIntent

V3 不实现 Editor，但要定义打开文件意图：

```ts
export type OpenFileIntent = {
  workspaceId: string;
  relativePath: string;
  source: "file-tree" | "file-search" | "agent-activity";
  preview: boolean;
};
```

`preview` 用于后续 Editor：单击可以预览，双击或编辑后固定 tab。

## 调试验证

用这些路径构造节点：

```text
package.json
src/main.ts
src/components/App.tsx
```

预期：

- 每个节点 id 包含 workspaceId。
- `relativePath` 使用 POSIX 风格 `/`。
- directory 节点有 children。
- file 节点不需要 children。

## 本章实操标准

### 本章效果

完成本章后，V3 有稳定的文件树数据模型和打开文件意图模型：

```text
Workspace
  -> FileTreeNode { id, relativePath, absolutePath, type }
  -> FileTreeState UI 状态
  -> OpenFileIntent
```

本章不扫描真实目录，但要让后续 `scanDirectory`、`fileTreeStore`、`searchFiles`、V4 Editor 都使用同一套类型。

### 改动文件

本章改动文件：

```text
src/renderer/file-tree/types.ts
src/renderer/file-tree/createFileNodeId.ts
src/renderer/file-tree/openFileIntent.ts
src/renderer/file-tree/types.test.ts
```

如果 main 侧扫描也要复用类型，可以把纯类型移动到项目既有 shared 目录；不要让 main import React 组件目录。

### 实现步骤

1. 定义 `FileTreeNode`，明确 `relativePath` 用 POSIX `/`，`absolutePath` 只给 main/file-system 使用。
2. 实现 `createFileNodeId(workspaceId, relativePath)`，root 节点使用 `"."` 或空路径的稳定表示。
3. 定义 `FileTreeState`，只放 `root`、`expandedNodeIds`、`selectedNodeId` 等 UI 状态，不把 expanded/selected 塞进节点。
4. 定义 `OpenFileIntent`，包含 `workspaceId`、`relativePath`、`source`、`preview`。
5. 补类型测试：不同 workspace 的同名文件 id 不相同，`src/main.ts` 这类相对路径不会变成绝对路径。

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

- `createFileNodeId("w1", "src/main.ts")` 和 `createFileNodeId("w2", "src/main.ts")` 不相同。
- root node、directory node、file node 都能用同一套 `FileTreeNode` 表示。
- `OpenFileIntent.relativePath` 是 `src/main.ts`，不是 `/Users/.../src/main.ts`。
- `FileTreeState` 可以在不改节点数据的情况下切换展开和选中。

### 常见报错

- 不同项目文件选中串了：确认 node id 包含 `workspaceId`。
- UI 展示绝对路径：展示和 intent 使用 `relativePath`，`absolutePath` 只留给 main 侧扫描/校验。
- 节点里有 `expanded` 或 `selected`：把这些状态移到 `FileTreeState`。
- intent 直接依赖 Editor：V3 只定义意图，V4 再消费，不要在本章调用 `editor.open()`。

## 可运行验收

本章完成后先跑：

```bash
pnpm test src/renderer/file-tree/types.test.ts
pnpm typecheck
```

本章结束时不要求 UI 显示文件树，但后续章节必须复用这里的 `FileTreeNode` 和 `OpenFileIntent`。

## 当前章节缺陷

本章只定义数据结构，不做扫描，也不做 UI 展示。

## 下一章预告

下一章会实现目录扫描与忽略规则：从 `Workspace.rootPath` 读取真实文件系统，并把它转换成本章定义的 `FileTreeNode`。
