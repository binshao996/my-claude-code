# 02 - Editor 领域模型

## 当前章节目标

本章定义 Editor 的核心状态模型。

完成后，Client 会有清晰的：

- Buffer。
- Tab。
- Active file。
- Dirty state。
- Selection。

## Buffer 和 Tab 的区别

很多初学实现会把 tab 和文件内容放在一起：

```ts
type BadTab = {
  path: string;
  content: string;
};
```

这会导致后续很难处理：

- 同一个 buffer 被多个 editor group 打开。
- 预览 tab 和固定 tab。
- 保存状态。
- selection 和 scroll position。

正确分层：

| 概念 | 职责 |
| --- | --- |
| Buffer | 文件内容、版本、dirty state |
| Tab | UI 标签、是否 preview、是否 active |
| Selection | 光标、选区、滚动位置 |

## 核心类型

```ts
export type EditorBuffer = {
  id: string;
  workspaceId: string;
  relativePath: string;
  languageId: string;
  content: string;
  savedContent: string;
  version: number;
  savedVersion: number;
  dirty: boolean;
  mtimeMs: number | null;
};

export type EditorTab = {
  id: string;
  bufferId: string;
  title: string;
  preview: boolean;
  active: boolean;
};

export type EditorSelection = {
  bufferId: string;
  lineNumber: number;
  column: number;
};

export type EditorState = {
  workspaceId: string | null;
  buffers: Record<string, EditorBuffer>;
  tabs: EditorTab[];
  activeTabId: string | null;
  selections: Record<string, EditorSelection>;
  status: "idle" | "loading" | "saving" | "error";
  error: string | null;
};
```

## bufferId 设计

```ts
export function createBufferId(workspaceId: string, relativePath: string): string {
  return `${workspaceId}:${relativePath}`;
}
```

和 File Tree 一样，不能只用 `relativePath`，否则不同 Workspace 的同名文件会冲突。

## dirty state

```ts
export function updateBufferContent(
  buffer: EditorBuffer,
  content: string,
): EditorBuffer {
  const version = buffer.version + 1;

  return {
    ...buffer,
    content,
    version,
    dirty: content !== buffer.savedContent,
  };
}
```

这里用 `savedContent` 做教学版判断。生产实现可以用 text model version、hash 或 file snapshot。

## 语言识别

```ts
export function detectLanguageId(relativePath: string): string {
  if (relativePath.endsWith(".ts")) return "typescript";
  if (relativePath.endsWith(".tsx")) return "typescript";
  if (relativePath.endsWith(".js")) return "javascript";
  if (relativePath.endsWith(".jsx")) return "javascript";
  if (relativePath.endsWith(".json")) return "json";
  if (relativePath.endsWith(".md")) return "markdown";
  return "plaintext";
}
```

教学版先用扩展名。生产实现可以交给 Monaco/VS Code language registry。

## 本章实操：建立可测试的 Editor Store

本章的产物是 renderer 侧状态模型，不碰磁盘、不接 IPC。它要让后续章节能直接 dispatch action。

### 专属改动文件

```text
src/renderer/editor/types.ts
src/renderer/editor/language.ts
src/renderer/editor/editorStore.ts
src/renderer/editor/selectors.ts
src/renderer/editor/editorStore.test.ts
src/renderer/components/EditorStatusBar.tsx
```

### 实现步骤

1. 把本章 `EditorBuffer`、`EditorTab`、`EditorSelection`、`EditorState` 放入 `types.ts`。
2. 把 `createBufferId`、`updateBufferContent` 放入 `editorStore.ts` 或独立 `bufferModel.ts`，保证纯函数可单测。
3. 把 `detectLanguageId` 放入 `language.ts`，至少覆盖 `.ts`、`.tsx`、`.js`、`.json`、`.md`。
4. 写 `selectActiveTab`、`selectActiveBuffer`、`selectDirtyBuffers`，后续 UI 不直接遍历 state。
5. 在 `EditorStatusBar.tsx` 先显示 active buffer 的 `languageId`、`version`、`dirty`，没有 active buffer 时显示 `No file`。
6. 给 dirty 判断写单测：相同内容不 dirty，修改后 dirty，改回 savedContent 后 dirty 清除。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，Editor 面板底部出现状态栏。此时还不能打开文件，但空状态应显示 `No file`；单测可以证明 buffer dirty 逻辑已经可用。

### 常见报错

- `path.basename` 在 renderer 报错：renderer 里不要直接依赖 Node `path`，tab title 可以在 reducer 中用简单 `relativePath.split("/").at(-1)`，或由 main 返回。
- dirty 单测不稳定：不要用时间判断 dirty，本章只比较 `content` 和 `savedContent`。
- selector 返回旧对象：reducer 必须创建新 state，不要原地改 `buffers`。

## 可运行验收

本章验收：

- `editorStore.test.ts` 覆盖 `createBufferId`、`detectLanguageId`、`updateBufferContent`。
- Editor 状态栏能渲染空状态。
- `pnpm typecheck` 和相关测试通过。

## 当前章节缺陷

本章只定义状态，不加载文件，也不渲染 Monaco。

## 下一章预告

下一章会实现文件加载：消费 V3 的 `OpenFileIntent`，读取文件内容，并创建 `EditorBuffer` 和 `EditorTab`。
