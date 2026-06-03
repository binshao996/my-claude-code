# 02 - 打开项目与最近项目

## 当前章节目标

本章实现 Workspace 的入口能力：

- 用户点击打开项目。
- Client 选择本地目录。
- 主进程验证目录。
- 创建 Workspace。
- 写入最近项目列表。

## 为什么打开项目要放在主进程

在 Electron/Tauri 桌面应用里，目录选择和文件系统验证都应该由高权限侧处理。

Renderer 只负责发起意图：

```text
我要打开一个项目
```

Main 负责执行：

```text
打开系统目录选择器
验证路径
创建 Workspace
持久化 recent projects
返回 Workspace
```

这样可以避免 UI 层直接持有不必要的文件系统能力。

## WorkspaceService

```ts
export class WorkspaceService {
  constructor(private readonly storage: WorkspaceStorage) {}

  async openProject(rootPath: string): Promise<Workspace> {
    const normalized = normalizePath(rootPath);
    await assertValidWorkspacePath(normalized);

    const workspace = createWorkspace(normalized);
    await this.storage.upsertRecentWorkspace(workspace);

    return workspace;
  }

  async listRecentProjects(): Promise<Workspace[]> {
    return this.storage.listRecentWorkspaces();
  }
}
```

## 路径校验

```ts
export async function assertValidWorkspacePath(rootPath: string): Promise<void> {
  const stat = await fs.promises.stat(rootPath);

  if (!stat.isDirectory()) {
    throw new Error("Workspace path must be a directory.");
  }
}
```

V2 只做最低限度校验。生产实现还需要：

- 路径是否存在。
- 是否可读。
- 是否位于允许访问范围。
- 是否是网络盘或慢速路径。
- 企业策略是否允许打开该目录。

## 最近项目存储

```ts
export type WorkspaceStorageData = {
  recentWorkspaces: Workspace[];
};

export class WorkspaceStorage {
  constructor(private readonly storagePath: string) {}

  async listRecentWorkspaces(): Promise<Workspace[]> {
    const data = await this.read();
    return data.recentWorkspaces.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  async upsertRecentWorkspace(workspace: Workspace): Promise<void> {
    const data = await this.read();
    const existing = data.recentWorkspaces.filter(item => item.id !== workspace.id);

    await this.write({
      recentWorkspaces: [
        { ...workspace, lastActiveAt: Date.now() },
        ...existing,
      ].slice(0, 20),
    });
  }
}
```

最近项目只保留 20 个，足够教学版使用。生产实现可以加 pin、remove、health check。

## IPC 设计

```ts
export type WorkspaceIpcApi = {
  openProject(): Promise<Workspace | null>;
  listRecentProjects(): Promise<Workspace[]>;
  switchProject(workspaceId: string): Promise<Workspace>;
};
```

这里 `openProject()` 不接受 renderer 传入路径，而是由 main 打开系统选择器。原因是用户选择目录这个动作本身应该发生在可信边界内。

## UI 组件

```tsx
export function OpenProjectButton({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" onClick={onOpen}>
      Open Project
    </button>
  );
}
```

```tsx
export function RecentProjectList({
  workspaces,
  onSelect,
}: {
  workspaces: Workspace[];
  onSelect(workspace: Workspace): void;
}) {
  return (
    <section>
      <h2>Recent Projects</h2>
      {workspaces.map(workspace => (
        <button key={workspace.id} type="button" onClick={() => onSelect(workspace)}>
          <strong>{workspace.displayName}</strong>
          <span>{workspace.rootPath}</span>
        </button>
      ))}
    </section>
  );
}
```

## 调试验证

手动验证：

- 打开一个真实项目目录。
- UI 显示项目名和路径。
- 关闭再打开应用，最近项目仍存在。
- 再次打开同一项目，不产生重复记录。
- 最近打开的项目排在最上面。

## 本章实操标准

### 本章效果

完成本章后，用户能从 UI 发起“打开项目”，main 侧完成目录选择、校验、创建 Workspace 和 recent storage：

```text
OpenProjectButton
  -> preload workspace API
  -> workspaceIpc
  -> WorkspaceService.openProject()
  -> WorkspaceStorage.upsertRecentWorkspace()
  -> RecentProjectList
```

renderer 不直接接触文件系统路径选择能力。

### 改动文件

本章改动文件：

```text
src/main/workspace/WorkspaceService.ts
src/main/workspace/workspaceStorage.ts
src/main/workspace/workspaceValidation.ts
src/main/ipc/workspaceIpc.ts
src/preload/workspaceApi.ts
src/renderer/components/OpenProjectButton.tsx
src/renderer/components/RecentProjectList.tsx
```

IPC 三侧必须同名：

```text
main:    ipcMain.handle("workspace:openProject", ...)
preload: window.workspace.openProject()
renderer: workspaceApi.openProject()
```

### 实现步骤

1. 在 `workspaceValidation.ts` 实现 `assertValidWorkspacePath()`，非目录、不可读路径要抛出明确错误。
2. 在 `workspaceStorage.ts` 实现 `listRecentWorkspaces()` 和 `upsertRecentWorkspace()`，按 `lastActiveAt` 倒序，最多保留 20 个。
3. 在 `WorkspaceService.ts` 组合校验、`createWorkspace()` 和 recent storage。
4. 在 `workspaceIpc.ts` 注册 `openProject`、`listRecentProjects`、`switchProject`；`openProject()` 由 main 打开目录选择器。
5. 在 preload 暴露 `window.workspace`，renderer 只能调用 API，不能 import main 模块。
6. 在 `OpenProjectButton` 和 `RecentProjectList` 中接入 API，先能打印/展示返回的 Workspace。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 `pnpm dev` 后手动验证：

- 点击 `Open Project` 会弹出系统目录选择器。
- 取消选择时返回 `null`，不会写入 recent，也不会报错刷屏。
- 选择真实项目后，UI 或调试面板能看到 `displayName`、`rootPath`、metadata。
- 关闭再启动应用，`RecentProjectList` 还能加载刚才的项目。
- 重复打开同一路径，recent list 只保留一条，并更新到最上方。
- 选择一个文件路径或不可读路径时，UI 显示错误，不写入 recent。

### 常见报错

- 点击按钮没有反应：确认 `workspaceIpc.ts` 已在 main 启动流程注册。
- `window.workspace` 是 undefined：确认 preload 文件已被 BrowserWindow 加载，并用 `contextBridge.exposeInMainWorld` 暴露。
- recent 重启后丢失：确认 `WorkspaceStorage` 写入的是 app data 或项目既有持久化目录，不是内存变量。
- recent 出现重复：upsert 前要按 `workspace.id` 过滤旧记录。
- renderer 传入任意 path：本章 `openProject()` 不接受 renderer path；路径来自 main 侧目录选择器。

## 可运行验收

本章完成后执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

验收重点是 IPC 和 recent storage 已跑通；当前 Workspace 的全局状态下一章再统一管理。

## 当前章节缺陷

本章只完成项目入口，不处理全局状态。打开项目后，谁是当前 Workspace、切换项目如何驱动 UI，还需要 Workspace Store。

## 下一章预告

下一章会实现 Workspace Store，把当前项目、最近项目、打开状态和错误状态统一管理起来。
