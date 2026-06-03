# 01 - 主流选型与架构边界

## 当前章节目标

本章明确 Editor 选型。

结论：

```text
教学实现：Monaco Editor
生产演进：Code OSS / VS Code Workbench / Theia
```

## 为什么必须贴近 VS Code / Monaco

用户特别要求 Editor 选型要和主流 Claude Code Client、Cursor、Trae、Windsurf 这类产品方向一致。

这里要先澄清：

- Claude Code 官方核心不是一个自带完整编辑器的桌面 IDE，它主要通过 CLI、Desktop 和 VS Code / JetBrains 等 IDE 集成提供体验。
- Cursor、Trae 这类 AI IDE 的主流路径是 VS Code fork 或 VS Code-like workbench。
- 如果我们自研 Client，不能用 textarea 或普通 code block 假装编辑器。

所以 V4 不能选：

```text
textarea
contenteditable
简单 pre/code 编辑
```

它们都不能承载企业级代码编辑能力。

## 为什么教学版不直接 fork VS Code

直接从 Code OSS / VS Code Workbench 开始，会带来巨大复杂度：

- Workbench layout。
- Extension host。
- Text model service。
- Keybinding service。
- Theme service。
- Language feature registry。
- File service。
- Settings service。

这不适合“普通前端开发也能一步步实现”的教程目标。

Monaco 是合理折中：

- 它来自 VS Code 编辑器核心。
- 支持代码编辑、语言模式、快捷键、selection、decorations。
- 能在 Electron/Tauri/Web 中嵌入。
- 可以先建立 Buffer、Tab、Save、Dirty State。

## 选型矩阵

| 方案 | 优点 | 缺点 | V4 结论 |
| --- | --- | --- | --- |
| textarea | 简单 | 不是代码编辑器 | 不选 |
| CodeMirror | 轻量、现代 | 和 VS Code 主流体验不一致 | 不选 |
| Monaco Editor | VS Code 编辑器核心，适合教学实现 | 不含完整 workbench | 选择 |
| Code OSS Workbench | 最接近 Cursor/Trae | 工程量巨大 | 生产演进 |
| Theia | VS Code-like 平台 | 架构复杂 | 生产演进 |

## 教学实现和生产实现

教学实现：

```text
OpenFileIntent
  -> EditorService.readFile()
  -> EditorBuffer
  -> Monaco Editor
  -> dirty state
  -> save
```

生产实现：

```text
Workspace
  -> FileService
  -> TextModelService
  -> Editor Groups
  -> Language Server
  -> Extension Host
  -> Agent Integration
```

V4 先实现第一条路径，但数据模型要给第二条路径留空间。

## 本章实操：把 Editor PR 边界落到工程

本章不写 Monaco 代码，但要先把 V4 的工程边界定下来，避免后续章节变成散落 demo。

### 专属改动文件

```text
src/main/editor/EditorService.ts          # 先放 class 和 read/save 方法签名
src/main/editor/editorPath.ts             # 先放 workspace 路径边界函数签名
src/main/ipc/editorIpc.ts                 # 先声明 editor:readFile / editor:saveFile channel
src/preload/editorApi.ts                  # 先声明 window.clientEditor API 形状
src/renderer/editor/types.ts              # EditorBuffer / EditorTab / EditorState
src/renderer/components/EditorLayout.tsx  # 接入空状态和后续 Monaco 容器位置
```

如果项目已有 `src/preload/index.ts` 或 `src/main/index.ts`，本章只在现有入口注册这些模块，不新增平行入口。

### 实现步骤

1. 在 `types.ts` 定义 Editor 领域类型的导出位置，先不填复杂 reducer。
2. 在 `EditorLayout.tsx` 渲染一个 Editor 面板空状态：`Open a file from Explorer`。
3. 在 Electron 主进程入口预留 `registerEditorIpc({ workspaceService, editorService })` 的调用点。
4. 在 preload 入口预留 `window.clientEditor`，API 名称固定为 `readFile`、`saveFile`，后续章节沿用。
5. 在 App 主布局中把 `EditorLayout` 放到 File Tree 右侧，确认 V4 PR 的 UI 落点存在。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，File Tree 右侧出现 Editor 空面板；打开 DevTools 能看到 `window.clientEditor` 已存在，但调用 `readFile` 仍可以先返回未实现错误。这个效果证明 V4 feature PR 的 main/preload/renderer 落点已经接好。

### 常见报错

- `window.clientEditor` 是 `undefined`：确认 preload 入口 import 了 `editorApi.ts`，并且 Electron `contextIsolation` 下使用 `contextBridge.exposeInMainWorld`。
- Editor 面板没出现：确认 App layout 没被 Chat 面板占满，Editor 区需要有固定 flex 容器。
- IPC channel 后续对不上：本章就固定 channel 命名，后续不要改成 `openFile`、`editor:open` 等别名。

## 可运行验收

本章验收只看边界：

- Electron Client 有 Editor 空面板。
- `window.clientEditor.readFile` / `saveFile` API 名称固定。
- 主进程入口存在 `registerEditorIpc` 注册点。
- `pnpm typecheck` 通过。

## 当前章节缺陷

本章只完成选型，不写代码。

## 下一章预告

下一章会定义 Editor 领域模型：`EditorBuffer`、`EditorTab`、`EditorSelection`、`EditorState`。
