# 05 - Tabs、Dirty State 与 Save

## 当前章节目标

本章实现多标签、未保存状态和保存。

完成后：

- 打开多个文件会产生多个 tab。
- 修改内容后 tab 显示 dirty 标记。
- `Cmd/Ctrl+S` 可以保存当前文件。
- 保存后 dirty 状态清除。

## buffer_changed

```ts
export type EditorAction =
  | { type: "buffer_changed"; bufferId: string; content: string }
  | { type: "buffer_saved"; bufferId: string; content: string; mtimeMs: number };
```

```ts
case "buffer_changed": {
  const buffer = state.buffers[action.bufferId];
  if (!buffer) return state;

  return {
    ...state,
    buffers: {
      ...state.buffers,
      [action.bufferId]: updateBufferContent(buffer, action.content),
    },
    tabs: state.tabs.map(tab =>
      tab.bufferId === action.bufferId ? { ...tab, preview: false } : tab,
    ),
  };
}
```

编辑后 preview tab 自动固定。这是 VS Code 风格行为。

## EditorTabs

```tsx
export function EditorTabs({ state, dispatch }: EditorTabsProps) {
  return (
    <div className="editor-tabs">
      {state.tabs.map(tab => {
        const buffer = state.buffers[tab.bufferId];
        const dirty = buffer?.dirty;

        return (
          <button
            key={tab.id}
            type="button"
            className={tab.active ? "active" : ""}
            onClick={() => dispatch({ type: "tab_activated", tabId: tab.id })}
          >
            <span>{tab.title}</span>
            {dirty ? <span className="dirty-dot" /> : null}
          </button>
        );
      })}
    </div>
  );
}
```

## 保存文件

```ts
export type SaveEditorFileInput = {
  workspaceId: string;
  relativePath: string;
  content: string;
  expectedMtimeMs: number | null;
};

export class EditorService {
  async saveFile(workspace: Workspace, input: SaveEditorFileInput) {
    const absolutePath = assertPathInsideWorkspace(workspace, input.relativePath);
    const currentStat = await fs.promises.stat(absolutePath);

    if (
      input.expectedMtimeMs !== null &&
      Math.floor(currentStat.mtimeMs) > input.expectedMtimeMs
    ) {
      throw new Error("File changed on disk. Reload before saving.");
    }

    await fs.promises.writeFile(absolutePath, input.content, "utf8");
    const nextStat = await fs.promises.stat(absolutePath);

    return { mtimeMs: Math.floor(nextStat.mtimeMs) };
  }
}
```

这里和 Runtime 的 `edit_file` 思路一致：写入前检查文件是否已经被外部修改。

## 保存成功

```ts
case "buffer_saved": {
  const buffer = state.buffers[action.bufferId];
  if (!buffer) return state;

  return {
    ...state,
    buffers: {
      ...state.buffers,
      [action.bufferId]: {
        ...buffer,
        content: action.content,
        savedContent: action.content,
        savedVersion: buffer.version,
        dirty: false,
        mtimeMs: action.mtimeMs,
      },
    },
  };
}
```

## 关闭 tab

V4 教学版遇到 dirty tab 时先阻止关闭：

```ts
if (buffer.dirty) {
  throw new Error("Save or discard changes before closing this tab.");
}
```

生产实现应提供 Confirm Dialog：

- Save
- Discard
- Cancel

## 本章实操：Dirty Tab 与保存回磁盘

### 专属改动文件

```text
src/main/editor/EditorService.ts
src/main/ipc/editorIpc.ts
src/preload/editorApi.ts
src/renderer/editor/editorActions.ts
src/renderer/editor/editorStore.ts
src/renderer/components/EditorTabs.tsx
src/renderer/components/EditorStatusBar.tsx
src/renderer/components/EditorLayout.tsx
```

### 实现步骤

1. 在 `EditorService.saveFile` 实现 workspace 边界、mtime 冲突检查和 `writeFile`。
2. 在 `editorIpc.ts` 增加 `editor:saveFile`，preload 暴露 `window.clientEditor.saveFile(input)`。
3. 在 renderer 新增 `saveActiveBuffer(state, dispatch)`：只保存 active dirty buffer，成功后 dispatch `buffer_saved`。
4. 在 reducer 中实现 `buffer_changed`、`buffer_saved`、`tab_activated`、`tab_close_requested`。
5. `EditorTabs` 显示 dirty dot；dirty tab 关闭时先阻止并给出错误提示。
6. 在 `EditorLayout` 注册 `Cmd/Ctrl+S`，只触发 active buffer 保存，不全局保存所有文件。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，修改当前文件，tab 出现 dirty dot，状态栏显示 `Unsaved`；按 `Cmd/Ctrl+S` 后 dirty dot 消失，重新从磁盘打开该文件能看到刚才的修改。

### 常见报错

- 保存后 dirty 仍存在：确认 `buffer_saved` 同时更新 `savedContent`、`savedVersion`、`dirty` 和 `mtimeMs`。
- 保存报文件已变化：说明磁盘 mtime 比 buffer 打开时更新，教学版先提示用户 Reload，不要直接覆盖。
- `Cmd/Ctrl+S` 触发浏览器保存页面：确认 keydown 中 `event.preventDefault()` 生效。
- dirty tab 被关闭导致内容丢失：本章应阻止关闭，Confirm Dialog 留到生产增强。

## 可运行验收

本章验收：

- dirty marker 随编辑和保存正确变化。
- `editor:saveFile` 写回 workspace 内文件。
- 外部修改导致 mtime 冲突时拒绝保存。
- 关闭 dirty tab 会被阻止。
- `pnpm typecheck` 通过。

## 当前章节缺陷

保存是用户主动触发，没有 autosave，没有外部文件变更监听。

## 下一章预告

下一章会建立 Editor 与 Runtime Bridge：让 Chat/Agent 知道当前打开文件，但不绕过编辑器和 Runtime 的安全边界。
