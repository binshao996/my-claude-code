# 03 - 文件加载与 Buffer

## 当前章节目标

本章实现从 `OpenFileIntent` 到 `EditorBuffer`。

完成后：

- 点击文件树文件可以触发打开。
- 主进程读取文件内容。
- Renderer 创建或激活对应 buffer。
- 预览 tab 和固定 tab 有基本行为。

## EditorService

文件读取应放在主进程或可信后端侧。

```ts
export type ReadEditorFileResult = {
  workspaceId: string;
  relativePath: string;
  content: string;
  mtimeMs: number;
  size: number;
};

export class EditorService {
  async readFile(workspace: Workspace, relativePath: string): Promise<ReadEditorFileResult> {
    const absolutePath = assertPathInsideWorkspace(workspace, relativePath);
    const stat = await fs.promises.stat(absolutePath);

    if (!stat.isFile()) {
      throw new Error("Editor can only open files.");
    }

    if (stat.size > 2 * 1024 * 1024) {
      throw new Error("File is too large for editor preview.");
    }

    const content = await fs.promises.readFile(absolutePath, "utf8");

    return {
      workspaceId: workspace.id,
      relativePath,
      content,
      mtimeMs: Math.floor(stat.mtimeMs),
      size: stat.size,
    };
  }
}
```

## 路径安全

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

不要用 `startsWith(workspace.rootPath)` 判断路径边界。

## 打开文件 Action

```ts
export type EditorAction =
  | { type: "open_started"; intent: OpenFileIntent }
  | { type: "file_loaded"; result: ReadEditorFileResult; preview: boolean }
  | { type: "open_failed"; message: string };
```

## Reducer

```ts
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "file_loaded": {
      const bufferId = createBufferId(action.result.workspaceId, action.result.relativePath);
      const tabId = bufferId;

      const buffer: EditorBuffer = {
        id: bufferId,
        workspaceId: action.result.workspaceId,
        relativePath: action.result.relativePath,
        languageId: detectLanguageId(action.result.relativePath),
        content: action.result.content,
        savedContent: action.result.content,
        version: 1,
        savedVersion: 1,
        dirty: false,
        mtimeMs: action.result.mtimeMs,
      };

      return {
        ...state,
        buffers: { ...state.buffers, [bufferId]: buffer },
        tabs: upsertEditorTab(state.tabs, {
          id: tabId,
          bufferId,
          title: path.basename(action.result.relativePath),
          preview: action.preview,
          active: true,
        }),
        activeTabId: tabId,
        status: "idle",
      };
    }

    case "open_failed":
      return { ...state, status: "error", error: action.message };

    default:
      return state;
  }
}
```

## 预览 tab

```ts
export function upsertEditorTab(tabs: EditorTab[], nextTab: EditorTab): EditorTab[] {
  const withoutActive = tabs.map(tab => ({ ...tab, active: false }));
  const existing = withoutActive.find(tab => tab.id === nextTab.id);

  if (existing) {
    return withoutActive.map(tab =>
      tab.id === nextTab.id ? { ...tab, active: true, preview: tab.preview && nextTab.preview } : tab,
    );
  }

  const withoutOldPreview = nextTab.preview
    ? withoutActive.filter(tab => !tab.preview)
    : withoutActive;

  return [...withoutOldPreview, nextTab];
}
```

单击文件树可以打开 preview tab；双击或编辑后固定 tab。

## 本章实操：接通 OpenFileIntent -> Buffer

本章开始接 Electron main/preload/renderer。完成后还没有 Monaco，但点击文件树应该能看到 tab 和文件内容预览。

### 专属改动文件

```text
src/main/editor/editorPath.ts
src/main/editor/EditorService.ts
src/main/ipc/editorIpc.ts
src/preload/editorApi.ts
src/renderer/editor/editorActions.ts
src/renderer/editor/editorStore.ts
src/renderer/components/EditorLayout.tsx
src/renderer/components/EditorTabs.tsx
```

### 实现步骤

1. 在 `editorPath.ts` 实现 `assertPathInsideWorkspace`，用 `path.resolve` + `path.relative` 校验 workspace 边界。
2. 在 `EditorService.readFile` 里读取 `content`、`mtimeMs`、`size`，拒绝目录、大文件和 workspace 外路径。
3. 在 `editorIpc.ts` 注册 `editor:readFile`，main 侧从 `workspaceId` 找 workspace，再调用 `EditorService`。
4. 在 `preload/editorApi.ts` 暴露 `window.clientEditor.readFile(workspaceId, relativePath)`。
5. 在 File Tree 的 `OpenFileIntent` handler 里调用 `openEditorFile(intent, { preview: true })`，成功后 dispatch `file_loaded`。
6. 在 `EditorTabs` 显示 tab；在 `EditorLayout` 临时用 `<pre>` 显示 active buffer 内容，作为 Monaco 前的可见效果。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，点击 File Tree 中的 `package.json`，右侧出现 `package.json` tab，内容以只读 `<pre>` 形式显示；再单击另一个文件，旧 preview tab 被替换；双击或后续编辑时会固定 tab。

### 常见报错

- `File path must stay inside workspace.`：检查传入的是 workspace 相对路径，不是绝对路径。
- 点击文件没有反应：确认 V3 File Tree 发出的 `OpenFileIntent` 已接到 V4 `openEditorFile`。
- IPC 有返回但 UI 不变：确认 `file_loaded` action 进入 reducer，并且 `activeTabId` 设置为新 tab。
- 打开中文或二进制文件乱码：V4 教学版只读 UTF-8 文本；二进制文件应先拒绝或提示不可编辑。

## 可运行验收

本章验收：

- `editor:readFile` 能读取 workspace 内文件。
- `../package.json`、绝对路径、目录、大文件都会被拒绝。
- 点击文件能创建或激活 buffer/tab。
- `pnpm typecheck` 通过，路径边界函数有单测。

## 当前章节缺陷

本章还没有渲染 Monaco，只是把文件内容加载进 EditorState。

## 下一章预告

下一章会接入 Monaco Editor，把 `EditorBuffer.content` 渲染为真正的代码编辑器。
