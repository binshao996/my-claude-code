# 03 - Workspace Store

## 当前章节目标

本章实现 Client 侧 Workspace 状态管理。

完成后，UI 可以稳定读取：

- 当前 Workspace。
- 最近项目列表。
- 是否正在打开项目。
- 打开失败错误。

## 为什么需要 Workspace Store

如果每个组件都自己调用 IPC，会出现状态分裂：

- Header 不知道当前项目。
- Recent List 不知道项目是否刚被打开。
- Chat Client 不知道 Runtime 是否需要重建。
- 后续 File Tree 和 Editor 无法共享当前 Workspace。

所以需要统一 Store：

```text
Workspace IPC
  -> Workspace Actions
  -> Workspace Store
  -> Selectors
  -> UI / Runtime binding
```

## WorkspaceState

```ts
export type WorkspaceState = {
  current: Workspace | null;
  recent: Workspace[];
  status: "idle" | "opening" | "switching";
  error: string | null;
};

export const initialWorkspaceState: WorkspaceState = {
  current: null,
  recent: [],
  status: "idle",
  error: null,
};
```

## Actions

```ts
export type WorkspaceAction =
  | { type: "recent_loaded"; workspaces: Workspace[] }
  | { type: "open_started" }
  | { type: "workspace_opened"; workspace: Workspace; recent: Workspace[] }
  | { type: "workspace_switched"; workspace: Workspace }
  | { type: "workspace_failed"; message: string };
```

## Reducer

```ts
export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "recent_loaded":
      return { ...state, recent: action.workspaces };

    case "open_started":
      return { ...state, status: "opening", error: null };

    case "workspace_opened":
      return {
        current: action.workspace,
        recent: action.recent,
        status: "idle",
        error: null,
      };

    case "workspace_switched":
      return {
        ...state,
        current: action.workspace,
        status: "idle",
        error: null,
      };

    case "workspace_failed":
      return { ...state, status: "idle", error: action.message };

    default:
      return state;
  }
}
```

## Actions 封装

```ts
export function createWorkspaceActions(
  api: WorkspaceIpcApi,
  dispatch: (action: WorkspaceAction) => void,
) {
  return {
    async loadRecent() {
      const workspaces = await api.listRecentProjects();
      dispatch({ type: "recent_loaded", workspaces });
    },

    async openProject() {
      dispatch({ type: "open_started" });

      try {
        const workspace = await api.openProject();
        if (!workspace) {
          dispatch({ type: "workspace_failed", message: "No project selected." });
          return;
        }

        const recent = await api.listRecentProjects();
        dispatch({ type: "workspace_opened", workspace, recent });
      } catch (error) {
        dispatch({
          type: "workspace_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async switchProject(workspace: Workspace) {
      dispatch({ type: "workspace_switched", workspace });
    },
  };
}
```

## Selectors

```ts
export function selectCurrentWorkspace(state: WorkspaceState): Workspace | null {
  return state.current;
}

export function selectCanStartRuntime(state: WorkspaceState): boolean {
  return Boolean(state.current) && state.status === "idle";
}

export function selectWorkspaceTitle(state: WorkspaceState): string {
  return state.current?.displayName ?? "No project";
}
```

Selectors 看起来简单，但非常重要。后续 File Tree、Editor、Terminal 不应该自己读 `state.current?.rootPath`，而应该通过 selector 获取当前项目上下文。

## WorkspaceShell

```tsx
export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const workspace = useWorkspaceSelector(selectCurrentWorkspace);

  if (!workspace) {
    return <WelcomeWorkspaceScreen />;
  }

  return (
    <div className="workspace-shell">
      <WorkspaceHeader workspace={workspace} />
      {children}
    </div>
  );
}
```

V2 的 `WorkspaceShell` 还很简单。V4/V5 后，它会承载 Editor、Terminal、Chat、File Tree 的布局。

## 调试验证

验证点：

- 初次启动没有 current workspace，显示 welcome。
- recent 加载后，最近项目列表显示。
- 打开项目成功后，current 被设置。
- 打开项目失败后，error 可见。
- 切换项目后，Header 更新。

## 本章实操标准

### 本章效果

完成本章后，打开项目不再只是一次 IPC 返回值，而是进入全局 Workspace 状态：

```text
workspaceApi
  -> workspaceActions
  -> workspaceReducer / workspaceStore
  -> selectors
  -> WorkspaceShell / WorkspaceHeader / RecentProjectList
```

Header、recent list、Runtime binding 后续都从同一个 store 读取 current workspace。

### 改动文件

本章改动文件：

```text
src/renderer/workspace/types.ts
src/renderer/workspace/workspaceStore.ts
src/renderer/workspace/workspaceActions.ts
src/renderer/workspace/selectors.ts
src/renderer/components/WorkspaceShell.tsx
src/renderer/components/WorkspaceHeader.tsx
src/renderer/components/RecentProjectList.tsx
```

本章不新增 main IPC；它复用上一章的 `window.workspace.openProject()` 和 `window.workspace.listRecentProjects()`。

### 实现步骤

1. 在 `workspaceStore.ts` 定义 `WorkspaceState`、`WorkspaceAction`、`initialWorkspaceState` 和 reducer。
2. `recent_loaded` 只更新 recent；`workspace_opened` 同时更新 current 和 recent；`workspace_failed` 清理 loading 状态并保留错误。
3. 在 `workspaceActions.ts` 封装 `loadRecent()`、`openProject()`、`switchProject()`，组件不直接写 IPC try/catch。
4. 在 `selectors.ts` 暴露 `selectCurrentWorkspace()`、`selectRecentWorkspaces()`、`selectWorkspaceTitle()`、`selectCanStartRuntime()`。
5. `WorkspaceShell` 在没有 current 时显示 welcome/open project/recent list；有 current 时渲染 header 和 children。
6. `WorkspaceHeader` 显示 `displayName`、`rootPath`、metadata，并在 `status === "opening"` 时给出打开中状态。

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

- 初次启动时没有 current workspace，页面显示 open project 入口和 recent list。
- 应用启动后自动调用 `loadRecent()`，最近项目不需要点击按钮才出现。
- 打开项目时按钮进入 opening 状态，成功后 `WorkspaceHeader` 替换 welcome 页面。
- Header 显示项目名和 root path，recent list 中同一项目排到第一。
- 打开失败时 current 不被旧值覆盖，错误提示显示在 workspace 区域。
- 切换 recent 项目后 Header 立即更新为被选择的 workspace。

### 常见报错

- Header 不更新：确认 Header 读的是 `selectCurrentWorkspace()`，不是组件本地 state。
- recent list 打开后没刷新：`openProject()` 成功后要再调用 `listRecentProjects()` 或使用 main 返回的新 recent。
- 取消目录选择显示错误：取消应返回 `null`，可以保持 idle，不应该显示“打开失败”。
- 切换项目时状态残留 opening：`workspace_switched` 必须把 `status` 设回 `idle`。
- 组件直接调用 IPC：把 IPC 调用收敛到 `workspaceActions.ts`，否则状态会分裂。

## 可运行验收

本章完成后执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

验收重点是：打开项目后 `WorkspaceHeader` 可见，recent list 持久化，所有 UI 都从同一个 `WorkspaceState` 读取。

## 当前章节缺陷

Workspace Store 只管理 Workspace 本身，还没有驱动 Runtime 重建。

## 下一章预告

下一章会把 Workspace 绑定到 Runtime：当前项目变化时，RuntimeClient、SessionStore、MemoryStore 都要跟着切换到新的项目上下文。
