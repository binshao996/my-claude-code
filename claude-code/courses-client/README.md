# 企业级 AI Coding Agent Client

本教程输出目录统一为 `courses-client/`。

这套教程不是继续实现 Claude Code Runtime，也不是做一个 AI Chat App。它的目标是在已有 Runtime 能力之上，逐步构建一个企业级 AI Coding Agent Client：

```text
Claude Code Runtime
+
Desktop Client
+
Workspace
+
Editor
+
Terminal
+
Session UI
+
Diff UI
+
Project Management
+
Plugin System
```

## Client 工程基座

本教程必须从一个可运行 Client 工程开始，而不是从零散代码片段开始。

教学版采用和主流 Claude Code Client / Cursor / VS Code 体系一致的桌面客户端路线：

| 层级 | 选型 | 原因 |
| --- | --- | --- |
| Desktop Shell | Electron | 成熟桌面壳，适合承载 Monaco、PTY、IPC 和本地 Runtime |
| Renderer | React + TypeScript | 前端开发者可直接上手，组件化表达 Chat / Editor / Terminal |
| Build | Vite | 快速 dev server，适合逐章迭代 |
| Package Manager | pnpm | workspace 和依赖管理稳定 |
| Editor | Monaco Editor | VS Code 编辑器核心，和主流 AI Coding Client 编辑体验一致 |
| Terminal | xterm.js + node-pty | VS Code 终端路线，支持真实交互式 shell |
| Runtime Bridge | Electron main process IPC | 高权限能力留在 main process，renderer 只消费受控 API |
| State | Zustand-style store 或轻量 reducer | 每章先实现可理解状态，再按需要抽象 |

> 官方 Claude Code Desktop 的完整内部技术栈没有公开。教程选择的是与主流 AI Coding Client 一致、可教学、可运行、可扩展的桌面技术基座。

基座初始化在 [V0 - Runtime Integration](./v0-runtime-integration/README.md) 中完成。V0 之后所有章节都在同一个 Client 工程上继续加 feature，不能每章另起 demo。

## 教程路线

| 版本 | 主题 | 核心问题 | 可运行交付 |
| --- | --- | --- | --- |
| V0 | Client Foundation & Runtime Integration | 如何初始化 Client 工程并接入 Claude Code Runtime | 能启动 Electron Client shell，发送一次任务并看到 Runtime event stream |
| V1 | Chat Client | 如何把 Agent 输出变成可用的 Chat UI | 能在浏览器/桌面壳里完成一次流式对话 |
| V2 | Workspace | 如何管理项目、工作区和项目切换 | 能打开项目、保存最近项目，并让 Runtime 使用 workspace cwd |
| V3 | File Tree | 如何浏览、搜索、定位文件 | 能扫描项目、展示文件树、搜索文件并产生打开文件意图 |
| V4 | Editor | 如何接入 Monaco Editor 和多标签页 | 能打开文件、编辑、显示 dirty state 并保存 |
| V5 | Terminal | 如何接入 PTY、Shell 和实时输出 | 能在 workspace cwd 打开终端、输入命令、看到实时输出 |
| V6 | Agent Workspace | 如何可视化 Tool、Plan、Agent 状态 | 能展示 plan、tool timeline、runtime timeline 和权限队列 |
| V7 | Diff & Patch | 如何展示、接受、拒绝代码修改 | 能展示 Runtime diff，并完成 accept / reject 决策 |
| V8 | Multi Session | 如何管理会话、历史和项目会话 | 能按 workspace 列出、创建、恢复、继续 session |
| V9 | Plugin System | 如何扩展命令、工具和 UI 能力 | 能加载插件 manifest，启停 command / tool / panel |
| V10 | Enterprise Client | 如何形成企业级产品闭环 | 能用 policy / audit / diagnostics 串起企业治理闭环 |

## 可运行交付标准

本教程后续所有版本都必须可运行。每个版本不是只输出架构说明，而是交付一个可以启动、可以操作、可以验证的 Client 切片。

每个版本必须包含：

- `当前版本目标`：说明本版本解决什么用户问题。
- `项目结构变化`：列出新增或变更的工程目录和文件。
- `核心流程`：从用户操作到 Runtime / Client 状态变化的完整链路。
- `完整核心代码`：给出能落地到工程的关键代码，不只给类型片段。
- `逐步实现`：按文件和步骤推进，读者可以照着实现。
- `调试验证`：给出本版本的启动命令、手动验证点和最小测试点。
- `当前版本缺陷`：明确本版本没有做什么。
- `下一版本演化方向`：解释为什么需要下一版。

推荐统一命令：

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
```

如果某个版本引入 Electron、Tauri、Monaco、PTY 或原生模块，必须在该版本中明确额外安装命令、平台差异和失败排查方式。

## 重构 TodoList

下面是当前教程必须补齐的硬性缺漏。任何版本或章节如果没有满足这些项，都不能算完成。

### P0：Client 工程基座

- [x] V0 必须能从空目录初始化 `Electron + React + Vite + TypeScript` 工程。
- [x] V0 必须写清 `main / preload / renderer` 三层职责。
- [x] V0 必须给出 `src/main/index.ts`、`src/preload/index.ts`、`ClientShell.tsx`、`runtimeIpc.ts` 的完整最小代码。
- [x] V0 必须能运行 `pnpm dev` 打开 Electron 窗口。
- [x] V0 必须能输入 prompt，并在 UI 看到 Runtime event log。
- [x] Renderer 禁止直接 import Runtime 内部类，只能通过 preload typed API 访问 main process。

### P0：每章就是一个可运行 feature

- [x] 每个子章节必须有专属的 `本章效果`，不能写泛化描述。
- [x] 每个子章节必须列出本章实际要改的文件。
- [x] 每个子章节必须按 `类型 -> service/store -> UI/IPC -> 接入运行链路` 写实现步骤。
- [x] 每个子章节必须写 `pnpm dev` 后应该看到的具体 UI、事件日志或状态变化。
- [x] 每个子章节必须写本章特有的常见报错，不允许只写通用排查。

### P0：Feature PR 体验补齐

- [x] V0 必须提供稳定 Runtime Adapter 接入路径，不能只依赖 `claude-code-mini/src/*` 临时源码 import。
- [x] V0 必须提供 fake Runtime Adapter；没有模型 key 时也能跑出 event log。
- [x] V7-V10 每章必须有可复制的 service / store / UI 代码骨架。
- [x] V7-V10 每章必须提供 fixture 或 fake event，避免读者等真实 Runtime/企业后端才看到效果。
- [x] V7-V10 每章 Smoke Check 必须写清可见 UI 状态，而不是只写命令通过。

### P1：V1-V3 基础体验

- [x] V1 必须能跑出 streaming chat、Markdown code block、Tool Activity。
- [x] V2 必须能打开 workspace、持久化 recent projects、切换 Runtime cwd。
- [x] V3 必须能扫描文件树、应用 ignore rules、搜索文件、产生 OpenFileIntent。

### P1：V4-V6 IDE 与 Agent 可观察性

- [x] V4 必须能打开文件、Monaco 渲染、dirty/save、多 tab、EditorRuntimeBridge。
- [x] V5 必须能创建真实 PTY、xterm 输入输出、resize、dispose，并明确 Agent `run_command` 和用户 terminal 的边界。
- [x] V6 必须能展示 PlanView、ToolTimeline、RuntimeTimeline、PermissionQueue、AgentStatusSummary。

### P1：V7-V10 企业级闭环

- [x] V7 必须能解析 Runtime diff、展示 DiffViewer、基于 before snapshot accept/reject、刷新 editor。
- [x] V8 必须能按 workspace 管理 session、resume、continue、展示 timeline。
- [x] V9 必须能加载插件 manifest、enable/disable、注入 command/tool/panel，并受权限边界约束。
- [x] V10 必须能跑出 Settings/Policy、Permission governance、Audit/Diagnostics、Release compatibility 的最小闭环。

### P2：产品体验说明

- [x] 每个版本必须写清用户会看到什么，而不是只写代码如何组织。
- [x] Context、Command Palette、Permission、Diff、Session、Plugin、Audit 都必须解释产品价值和企业边界。
- [x] 每个版本必须保留当前缺陷和下一版本演化方向。

## 能力矩阵总览

| 用户能力 | Client 能力 | Runtime 能力 | 首次出现 |
| --- | --- | --- | --- |
| 发送任务 | Chat Panel | ChatSession / AgentLoop | V0 |
| 接收流式输出 | Streaming Renderer | LLM Stream Events | V0 |
| 查看工具执行 | Agent Activity | Tool Calling / ToolRunner | V0 |
| 打开项目 | Workspace Manager | cwd / runtime context | V2 |
| 浏览文件 | File Tree | read_file / context | V3 |
| 编辑代码 | Monaco Editor | write_file / edit_file | V4 |
| 执行命令 | Terminal Panel | run_command / Sandbox | V5 |
| 查看计划 | Plan View | Planner / update_plan | V6 |
| 查看代码变更 | Diff Viewer | Diff / Patch | V7 |
| 管理历史 | Session Manager | SessionStore / Transcript | V8 |
| 扩展能力 | Plugin Manager | Plugin Tool Injection | V9 |

## 当前章节

- [V0 - Runtime Integration](./v0-runtime-integration/README.md)
- [V1 - Chat Client](./v1-chat-client/README.md)
- [V2 - Workspace](./v2-workspace/README.md)
- [V3 - File Tree](./v3-file-tree/README.md)
- [V4 - Editor](./v4-editor/README.md)
- [V5 - Terminal](./v5-terminal/README.md)
- [V6 - Agent Workspace](./v6-agent-workspace/README.md)
- [V7 - Diff & Patch](./v7-diff-patch/README.md)
- [V8 - Multi Session](./v8-multi-session/README.md)
- [V9 - Plugin System](./v9-plugin-system/README.md)
- [V10 - Enterprise Client](./v10-enterprise-client/README.md)

## 最终补充

- [Claude Code Client 全景架构图](./claude-code-client-architecture-map.md)
- [Claude Code Client 源码阅读路线图](./claude-code-client-source-reading-roadmap.md)
