# 04 - Monaco 集成

## 当前章节目标

本章接入 Monaco Editor。

完成后，Client 可以用 VS Code 风格编辑器查看和编辑代码。

## 安装

```bash
pnpm add monaco-editor @monaco-editor/react
```

## MonacoCodeEditor

```tsx
import Editor from "@monaco-editor/react";

type MonacoCodeEditorProps = {
  buffer: EditorBuffer;
  onChange(content: string): void;
};

export function MonacoCodeEditor({ buffer, onChange }: MonacoCodeEditorProps) {
  return (
    <Editor
      path={buffer.relativePath}
      language={buffer.languageId}
      value={buffer.content}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
      }}
      onChange={value => {
        onChange(value ?? "");
      }}
    />
  );
}
```

`path` 很重要。Monaco 会用它区分 model，也会影响语言服务和 diagnostics。

## EditorLayout

```tsx
export function EditorLayout({ state, dispatch }: EditorLayoutProps) {
  const activeBuffer = selectActiveBuffer(state);

  if (!activeBuffer) {
    return <div className="editor-empty">Open a file to start editing.</div>;
  }

  return (
    <section className="editor-layout">
      <EditorTabs state={state} dispatch={dispatch} />
      <MonacoCodeEditor
        buffer={activeBuffer}
        onChange={content =>
          dispatch({
            type: "buffer_changed",
            bufferId: activeBuffer.id,
            content,
          })
        }
      />
      <EditorStatusBar buffer={activeBuffer} />
    </section>
  );
}
```

## Monaco Worker

在 Vite 中必须显式处理 Monaco worker，否则 Electron Client 常见表现是编辑器空白、语言服务报错或控制台出现 `Unexpected usage`。

推荐在 renderer 入口新增 `monacoWorkers.ts`：

```ts
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};
```

然后在 renderer app 入口最前面 import：

```ts
import "./editor/monacoWorkers";
```

`@monaco-editor/react` 负责 React 生命周期，`monacoWorkers.ts` 负责 worker 打包边界。

生产实现要关注：

- worker 打包路径。
- CSP。
- Electron/Tauri 本地资源加载。
- 大文件编辑性能。
- language worker 数量。

## 快捷键

V4 至少保留保存快捷键：

```tsx
useEffect(() => {
  function onKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      void saveActiveBuffer();
    }
  }

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [saveActiveBuffer]);
```

生产实现应接入统一 keybinding service，而不是到处监听 `window`。

## 本章实操：替换预览为 Monaco Model

### 专属改动文件

```text
src/renderer/editor/monacoWorkers.ts
src/renderer/components/MonacoCodeEditor.tsx
src/renderer/components/EditorLayout.tsx
src/renderer/editor/editorStore.ts
src/renderer/editor/selectors.ts
```

### 实现步骤

1. 执行本章安装命令，确认 `monaco-editor` 和 `@monaco-editor/react` 进入 `package.json`。
2. 新增 `monacoWorkers.ts`，在 renderer 入口第一批 import，保证 Monaco 初始化前已设置 `self.MonacoEnvironment`。
3. 用 `MonacoCodeEditor` 替换上一章的 `<pre>`，传入 `path={buffer.relativePath}`、`language={buffer.languageId}`、`value={buffer.content}`。
4. `onChange` dispatch `buffer_changed`，不要在组件内部直接改 store。
5. 当 active tab 切换时，Monaco 根据 `path` 复用/切换 model；不要手写 `monaco.editor.createModel`，除非项目不用 `@monaco-editor/react`。
6. 在 `EditorStatusBar` 显示当前文件 language、version、dirty，便于确认 model change 回到了 store。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm add monaco-editor @monaco-editor/react
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，打开 `.ts` 文件会出现 Monaco 编辑器，语法高亮生效；输入字符后状态栏 version 增加。打开 `.json` 文件时 JSON worker 不报错，两个文件切换后内容不串。

### 常见报错

- `Unexpected usage` 或 worker 404：确认 `monacoWorkers.ts` 使用 `?worker` import，并在 renderer 入口早于 Monaco 组件加载。
- 编辑器高度为 0：`EditorLayout` 和父容器必须有明确高度，例如 `height: 100%` 或 flex 填满。
- 切换文件内容串了：确认 `Editor` 的 `path` 使用 workspace 内唯一相对路径，不要只传文件名。
- TypeScript worker 报 CSP：Electron CSP 需要允许本地 worker 资源，或使用 Vite 打包后的 worker URL。

## 可运行验收

本章验收：

- Monaco 能显示 `.ts`、`.json`、`.md` 文件。
- 修改内容会 dispatch `buffer_changed`。
- 切换 tab 时 Monaco model 正确切换。
- DevTools 无 worker 404 和 CSP 报错。

## 当前章节缺陷

Monaco 已经能编辑代码，但 dirty state 和保存流程还没有完成。

## 下一章预告

下一章会实现 Tabs、Dirty State 和 Save：用户修改文件后，tab 上显示未保存标记，并可以保存回磁盘。
