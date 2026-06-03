# 06 - Editor 与 Runtime Bridge

## 当前章节目标

本章建立 Editor 和 Runtime 的边界。

完成后：

- Chat 可以知道当前打开文件。
- Agent 可以在 prompt context 中看到用户关注的文件路径。
- Runtime 工具仍然通过 `read_file`、`edit_file`、sandbox 执行，不直接操作 Editor buffer。

## 为什么需要 Bridge

AI IDE 的关键体验是：

```text
用户正在看某个文件
  -> Agent 理解当前上下文
  -> Agent 可以读取或修改相关文件
  -> 用户在 Editor / Diff 中审查
```

但这不意味着 Runtime 可以直接改 Editor buffer。

正确边界是：

| 方向 | 允许 |
| --- | --- |
| Editor -> Runtime | 提供当前文件路径、selection、可选上下文 |
| Runtime -> Editor | 通过工具结果、diff、open intent 通知 UI |
| Runtime 直接改 buffer | 不允许 |

## EditorContext

```ts
export type EditorRuntimeContext = {
  activeFile: {
    workspaceId: string;
    relativePath: string;
    languageId: string;
    dirty: boolean;
  } | null;
  openFiles: Array<{
    relativePath: string;
    languageId: string;
    dirty: boolean;
  }>;
};
```

## 构建上下文

```ts
export function buildEditorRuntimeContext(state: EditorState): EditorRuntimeContext {
  const activeBuffer = selectActiveBuffer(state);

  return {
    activeFile: activeBuffer
      ? {
          workspaceId: activeBuffer.workspaceId,
          relativePath: activeBuffer.relativePath,
          languageId: activeBuffer.languageId,
          dirty: activeBuffer.dirty,
        }
      : null,
    openFiles: state.tabs
      .map(tab => state.buffers[tab.bufferId])
      .filter(Boolean)
      .map(buffer => ({
        relativePath: buffer.relativePath,
        languageId: buffer.languageId,
        dirty: buffer.dirty,
      })),
  };
}
```

## Prompt Context 策略

V4 只把路径和状态放入 Runtime context，不自动塞入完整文件内容。

原因：

- 文件可能很大。
- dirty buffer 还没有保存，Runtime 工具读到的是磁盘内容。
- 自动注入内容会消耗 token。
- 用户未必希望当前文件内容进入模型上下文。

推荐上下文：

```text
Current editor:
- active file: src/main.ts
- open files: src/main.ts, package.json
- active file dirty: false
```

如果用户明确说“分析当前文件”，后续可以触发 `read_file` 或 attachment 流程。

## 保存后再让 Agent 修改

当 active buffer 是 dirty 时，如果用户要求 Agent 修改当前文件，Client 应提醒：

```text
当前文件有未保存修改。请先保存，或明确允许 Agent 基于磁盘版本继续。
```

否则 Runtime 的 `read_file` 和 `edit_file` 只会看到磁盘版本，容易覆盖用户未保存内容。

## 与 Diff 的关系

V4 不直接应用 Agent diff。

后续 V7 会实现：

```text
ToolResult.diff
  -> Diff Viewer
  -> Accept / Reject
  -> Editor refresh
```

Editor 只负责打开和编辑文件，不负责审查 Agent patch。

## 本章实操：EditorRuntimeBridge

本章的重点是“暴露上下文”，不是让 Runtime 直接读写 editor buffer。

### 专属改动文件

```text
src/renderer/editor/editorRuntimeBridge.ts
src/renderer/editor/selectors.ts
src/renderer/components/EditorContextDebug.tsx
src/renderer/components/EditorLayout.tsx
src/renderer/runtime/runtimeContext.ts
```

如果项目的 Runtime context 模块名称不同，接入现有 prompt context builder，不新增第二套 Runtime。

### 实现步骤

1. 在 `editorRuntimeBridge.ts` 实现 `buildEditorRuntimeContext(state)`，只返回 active file、open files、language、dirty。
2. 在 Runtime prompt context builder 中增加 `getEditorContext()` 回调，运行每轮请求前读取最新 editor state。
3. dirty active buffer 时，prompt context 只标记 `dirty: true`，不注入未保存内容。
4. 在 `EditorContextDebug.tsx` 渲染当前 bridge 输出，便于读者看见 Agent 将拿到什么上下文。
5. 如果用户请求“修改当前文件”且 active buffer dirty，在 Chat 发送前弹出提示或写入 warning 状态：先保存，或明确允许基于磁盘版本继续。
6. Runtime 工具结果如果带 `openFileIntent`，只 dispatch 到 Editor 打开文件；不要直接把 tool result 写进 Monaco model。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，打开两个文件，Editor context/debug 区显示 active file 和 open files；修改当前文件但不保存，debug 区的 `dirty` 变为 `true`。发送 Chat 前的 Runtime context 只包含路径和 dirty 状态，不包含完整文件内容。

### 常见报错

- Agent 看到旧文件内容：Runtime 的 `read_file` 读的是磁盘；dirty buffer 必须提示保存或明确继续。
- context 过大：Bridge 不应注入 `buffer.content`，只传路径、语言和 dirty。
- Runtime 直接改了 Monaco：检查 tool result handler，只能发 open/refresh intent，不能写 `buffer.content`。

## 可运行验收

本章验收：

- `buildEditorRuntimeContext` 有单测，覆盖无文件、active file、多个 open files、dirty file。
- Agent context/debug 面板可见 active file。
- dirty buffer 不会把未保存内容自动交给 Runtime。
- Runtime 工具仍走 `read_file` / `edit_file` / sandbox。

## 当前章节缺陷

V4 的 Bridge 只提供当前文件上下文，不做 inline AI edit、不做 selection-aware edit。

## 下一版本预告

V5 会实现 Terminal。

Editor 解决“看和改代码”，Terminal 解决“运行代码”：

```text
save file
  -> run command
  -> stream output
  -> Agent observes result
```

到 V5，Client 会具备开发工作流中最基础的执行能力。
