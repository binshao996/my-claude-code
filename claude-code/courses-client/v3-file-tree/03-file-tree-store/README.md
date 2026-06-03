# 03 - FileTree Store

## 当前章节目标

本章实现 FileTree Store。

完成后，UI 可以管理：

- 文件树根节点。
- 展开的目录。
- 当前选中文件。
- 加载状态。
- 扫描错误。

## FileTreeState

```ts
export type FileTreeState = {
  workspaceId: string | null;
  root: FileTreeNode | null;
  expandedNodeIds: Set<string>;
  selectedNodeId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};
```

`workspaceId` 必须放进状态。切换 Workspace 时，如果旧的扫描结果晚回来，可以用它判断是否应该丢弃。

## Actions

```ts
export type FileTreeAction =
  | { type: "load_started"; workspaceId: string }
  | { type: "load_succeeded"; workspaceId: string; root: FileTreeNode }
  | { type: "load_failed"; workspaceId: string; message: string }
  | { type: "toggle_expanded"; nodeId: string }
  | { type: "select_node"; nodeId: string };
```

## Reducer

```ts
export function fileTreeReducer(
  state: FileTreeState,
  action: FileTreeAction,
): FileTreeState {
  switch (action.type) {
    case "load_started":
      return {
        workspaceId: action.workspaceId,
        root: null,
        expandedNodeIds: new Set(),
        selectedNodeId: null,
        status: "loading",
        error: null,
      };

    case "load_succeeded":
      if (state.workspaceId !== action.workspaceId) return state;

      return {
        ...state,
        root: action.root,
        status: "ready",
        expandedNodeIds: new Set([action.root.id]),
      };

    case "load_failed":
      if (state.workspaceId !== action.workspaceId) return state;
      return { ...state, status: "error", error: action.message };

    case "toggle_expanded": {
      const expanded = new Set(state.expandedNodeIds);
      if (expanded.has(action.nodeId)) {
        expanded.delete(action.nodeId);
      } else {
        expanded.add(action.nodeId);
      }
      return { ...state, expandedNodeIds: expanded };
    }

    case "select_node":
      return { ...state, selectedNodeId: action.nodeId };

    default:
      return state;
  }
}
```

## 加载动作

```ts
export function createFileTreeActions(
  api: FileTreeIpcApi,
  dispatch: (action: FileTreeAction) => void,
) {
  return {
    async loadForWorkspace(workspace: Workspace) {
      dispatch({ type: "load_started", workspaceId: workspace.id });

      try {
        const root = await api.loadFileTree(workspace.id);
        dispatch({ type: "load_succeeded", workspaceId: workspace.id, root });
      } catch (error) {
        dispatch({
          type: "load_failed",
          workspaceId: workspace.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
```

真实 IPC 可以只传 `workspaceId`，由主进程 WorkspaceService 查出 rootPath，避免 renderer 传路径。

## Selectors

```ts
export function selectVisibleFileNodes(state: FileTreeState): FileTreeNode[] {
  if (!state.root) return [];

  const result: FileTreeNode[] = [];

  function visit(node: FileTreeNode) {
    result.push(node);

    if (node.type === "directory" && state.expandedNodeIds.has(node.id)) {
      for (const child of node.children ?? []) {
        visit(child);
      }
    }
  }

  visit(state.root);
  return result;
}
```

把 visible nodes 做成 selector，而不是每个组件递归判断，有两个好处：

- 后续可以接虚拟列表。
- 搜索、高亮、展开逻辑更容易统一。

## FileTreePanel

```tsx
export function FileTreePanel({ state, dispatch }: FileTreePanelProps) {
  const nodes = selectVisibleFileNodes(state);

  if (state.status === "loading") return <div>Loading files...</div>;
  if (state.status === "error") return <div>{state.error}</div>;

  return (
    <nav className="file-tree-panel">
      {nodes.map(node => (
        <FileTreeNodeRow
          key={node.id}
          node={node}
          expanded={state.expandedNodeIds.has(node.id)}
          selected={state.selectedNodeId === node.id}
          onToggle={() => dispatch({ type: "toggle_expanded", nodeId: node.id })}
          onSelect={() => dispatch({ type: "select_node", nodeId: node.id })}
        />
      ))}
    </nav>
  );
}
```

## 调试验证

验证：

- 加载开始时清空旧树。
- 加载成功后根目录默认展开。
- 点击目录可以展开/折叠。
- 点击文件可以选中。
- 切换 Workspace 时旧请求结果不会覆盖新 Workspace。

## 本章实操标准

### 本章效果

完成本章后，上一章扫描到的 root node 会进入 renderer 状态，并显示为可展开的文件树：

```text
WorkspaceStore.current
  -> fileTreeActions.loadForWorkspace()
  -> window.fileTree.loadFileTree(workspaceId)
  -> fileTreeReducer
  -> selectVisibleFileNodes()
  -> FileTreePanel
```

用户打开 workspace 后能看到树，点击目录能展开/折叠，点击文件能选中。

### 改动文件

本章改动文件：

```text
src/renderer/file-tree/fileTreeStore.ts
src/renderer/file-tree/fileTreeActions.ts
src/renderer/file-tree/selectors.ts
src/renderer/components/FileTreePanel.tsx
src/renderer/components/FileTreeNode.tsx
src/renderer/components/WorkspaceShell.tsx
```

本章复用 V2 的 `WorkspaceStore.current` 和上一章的 `window.fileTree.loadFileTree(workspaceId)`。

### 实现步骤

1. 在 `fileTreeStore.ts` 定义 `FileTreeState` 和 reducer，`workspaceId` 必须进入 state。
2. `load_started` 清空旧 root、expanded、selected，避免切项目时旧树闪现。
3. `load_succeeded` 先判断 `state.workspaceId === action.workspaceId`，旧请求晚回来要丢弃。
4. `selectVisibleFileNodes()` 根据 `expandedNodeIds` 拉平可见节点，供 UI 渲染。
5. `FileTreePanel` 处理 loading/error/ready 三种状态；ready 时渲染 `FileTreeNodeRow`。
6. `FileTreeNodeRow` 点击目录 dispatch `toggle_expanded`，点击文件 dispatch `select_node`。
7. 在 `WorkspaceShell` 或左侧栏中，当 current workspace 改变时调用 `loadForWorkspace(current)`。

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

- 打开 workspace 后左侧出现文件树，根目录默认展开。
- loading 期间显示 `Loading files...`，扫描失败时显示错误，不影响 Chat 区域。
- 点击目录时只展开/折叠该目录，文件选中状态不丢失。
- 点击文件时该行高亮，`selectedNodeId` 变成文件 node id。
- 快速切换项目时，项目 A 的慢请求不会覆盖项目 B 的树。
- `.git`、`node_modules` 等仍不出现，因为 store 只展示 scan 结果，不重新过滤。

### 常见报错

- 展开后整棵树消失：确认 `toggle_expanded` 只改 `expandedNodeIds`，不改 `root`。
- 切项目后旧树还在：`load_started` 必须重置 root 和 selected。
- 旧请求覆盖新项目：`load_succeeded` / `load_failed` 要检查 workspaceId。
- 每次渲染 expanded 都丢失：不要在组件 render 中 new 初始 Set；Set 更新放 reducer。
- 文件点击也展开：目录和文件点击逻辑要分支处理。

## 可运行验收

本章完成后执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

验收重点是：打开 workspace 后能看到文件树、展开目录、选中文件，并且切换 workspace 不串树。

## 当前章节缺陷

本章只显示树，不提供搜索，也不产生打开文件意图。

## 下一章预告

下一章会实现文件搜索：基于已加载文件树，快速通过文件名定位项目文件。
