# 08. 版本路线图：1:1 复刻 Claude Code

## 项目目标

通过 1:1 复刻 `claude-code/`，掌握开发终端 agent runtime 的完整能力。复刻目标不是做一个“类似 Claude Code 的聊天 CLI”，而是按源码架构拆解、按行为等价验收，逐步覆盖 Claude Code 的 agent loop、工具系统、权限系统、TUI、会话、上下文、扩展、后台任务、remote/bridge、构建和发布链路。

底层模型 provider 固定以 `deepseek-v4-flash` 为默认主模型。DeepSeek 只替换外部模型供应商，不改变内部协议目标：runtime 内部仍使用 Claude-compatible message/content block/tool_use/tool_result/stop_reason/usage/error 语义。

## 1:1 判定口径

1:1 复刻按“行为等价 + 架构边界等价”推进，不要求源码逐行一致。

- CLI 命令、参数、fast path、headless/interactive 行为尽量一致。
- TUI 信息架构、输入体验、权限弹窗、消息流、工具进度、快捷键和中断恢复尽量一致。
- Agent loop 的状态机、continuation、工具调用、多轮修复、错误恢复、abort 语义要对齐。
- 工具系统、权限系统、hooks、MCP、skills、plugins 使用相同抽象边界。
- Context、compact、memory、tool result budget、transcript replay 能支撑长任务。
- Background、subagent、task、worktree、remote/bridge/daemon 必须进入 V1.0 前的版本范围；不把它们视为可选插件。
- 构建、安装、doctor、生产测试和 release artifact 是复刻范围的一部分。
- `docs/10-source-coverage-ledger.md` 是唯一覆盖台账。V1.0 不能存在未映射源码目录、未关闭 feature flag、未登记 command/tool 或未关闭偏差。

## 三条并行主线

每个版本都按三条主线并行推进，避免只做表层 UI 或只做底层 runtime。

| 主线 | 目标 | 典型模块 | 验收方式 |
| --- | --- | --- | --- |
| Agent Core | 复刻 agent runtime 的核心决策能力 | provider、query loop、tools、permissions、hooks、context、compact、memory | transcript replay、provider contract、tool/permission fixture、长任务回归 |
| Product Surface | 复刻用户可感知的 Claude Code 体验 | CLI、TUI、slash commands、session、subagent、task、background、remote/bridge | parity case、TUI smoke、真实工程任务 demo |
| Engineering Parity | 复刻源码工程体系和可发布能力 | monorepo、Bun build、Node/Bun wrapper、vendor binaries、test matrix、doctor、release | typecheck/test/lint/build、production smoke、bundle integrity |

## 技术栈基线

复刻实现必须在 Sprint 0/V0.1 锁定技术栈，后续 Story 不再随意漂移。

| 类别 | 目标基线 |
| --- | --- |
| Runtime | Bun 优先，保留 Node wrapper/compat 入口 |
| Language | TypeScript strict，ESNext，`moduleResolution: bundler` |
| CLI | `@commander-js/extra-typings` 或等价强类型 Commander 封装 |
| TUI | React 19 + Claude Code 源码同类 Ink fork 策略，优先复刻 `@anthropic/ink` 能力边界 |
| Schema | Zod，tool input/output/provider event 均有 schema 或 contract test |
| Build | Bun build、feature flags、source map、Node/Bun 双 wrapper、vendor binary copy |
| Quality | Biome、typecheck、unit test、fixture test、production smoke、health/doctor |
| Provider | DeepSeek v4 flash，内部适配成 Claude-compatible content blocks |

## 版本节奏

建议 2 周一个 Sprint。V0.1 之后每个版本可由 1-2 个 Sprint 组成，但每个 Sprint 都必须交付可运行、可演示、可回归的切片。

| 版本 | Agent Core | Product Surface | Engineering Parity | 版本门槛 |
| --- | --- | --- | --- | --- |
| Sprint 0 | 源码映射、协议风险拆解 | parity case 初版 | 技术栈锁定、repo/backlog/ADR | 可以进入 V0.1 |
| V0.1 | 核心协议、DeepSeek compatibility spike | CLI fast path `--help/--version` | monorepo/build/test 骨架 | 协议和工程不再频繁推倒 |
| V0.2 | streaming query loop、forced tool-call contract | headless `-p`、transcript append | provider fixtures、bundle smoke | 第一个可用 headless agent |
| V0.3 | builtin tools、permissions、settings、hooks MVP | 基础命令面、权限确认文本流 | tool/permission fixtures、dangerous command tests | 可安全执行工程任务 |
| V0.4 | continuation、error recovery、session runtime | React/Ink TUI、slash commands、resume/continue | TUI smoke、session replay、perf budget | 接近本地 Claude Code 体验 |
| V0.5 | context、compact、memory、tool result budget | `/compact`、`/context`、长任务 UX | long-run replay、大结果持久化测试 | 可支撑长上下文任务 |
| V0.6 | MCP、skills、plugins、deferred tools | plugin/skill command surface | MCP fixture server、plugin manifest tests | 可扩展 runtime |
| V0.7 | subagent、task、background、worktree | task/background 命令和日志 | background integration、subagent isolation tests | 支撑高级 agent workflow |
| V0.8 | remote/bridge/daemon/SSH 最小闭环 | remote/attach/bridge 命令面 | remote smoke、daemon lifecycle tests | 非本地能力不再缺口 |
| V0.9 | feature flag closure | default/conditional/disabled feature gates | feature flag matrix closure | 条件分支不再有隐藏缺口 |
| V0.10 | platform integrations 和 native packages | voice/chrome/browser/computer-use/LSP/IDE/workflows/marketplace | native/package/platform smoke | 平台能力进入可验收状态 |
| V0.11 | inventory closure 和 CLI audit | tool/command/Commander subcommands/CLI flags | inventory closure、subcommand audit | V1.0 前全量清单关闭 |
| V1.0 | parity hardening、provider 修正 | CLI/TUI/commands 全量 audit | install/doctor/release/production-test | 1:1 可替代版本 |
| V1.1 | full ecosystem parity、关闭 MVP/disabled 边界 | MCP OAuth/SSE/HTTP/WebSocket、plugin lifecycle、bundled skills、browser/computer-use、voice、IDE/LSP、真实 remote | full ecosystem parity gate、真实对照 fixture、source inventory diff | 1:1 完美复刻版本 |

## Sprint 0：源码映射和计划校准

### 目标

在写实现前完成源码架构映射、风险登记和技术栈锁定，避免在 50w 行源码复刻中边做边猜。

### Agent Core

- 建立 Claude-compatible 内部协议清单：
  - `Message`
  - `ContentBlock`
  - `ToolUseBlock`
  - `ToolResultBlock`
  - `QueryEvent`
  - `Terminal`
  - `Continue`
  - `Usage`
  - `StopReason`
- 梳理 DeepSeek v4 flash 与 Claude tool_use/tool_result 的差异。
- 明确 provider event 到内部 event 的映射规则。

### Product Surface

- 建立 CLI/TUI/commands/source map。
- 建立 30 个初始 parity case，覆盖 headless、interactive、tools、permissions、resume、compact、MCP、subagent、remote。

### Engineering Parity

- 锁定 Bun/TypeScript/React/Ink/Zod/Biome/build 版本策略。
- 建立 ADR 目录和源码映射 ledger。
- 确认 repo 是否采用 monorepo，以及 package 边界。

### 验收标准

- 每个 V0.1 Story 都有源码参考路径。
- DeepSeek compatibility spike 有明确实验任务。
- 技术栈 ADR 已冻结。

## V0.1 工程骨架、核心协议和兼容性 Spike

### 目标

建立不会频繁推倒的工程底座，并提前验证 DeepSeek 是否能承载 Claude Code 的内部工具协议。

### Agent Core

- 定义核心类型和事件协议。
- 建立 provider abstraction。
- 实现 DeepSeek compatibility spike：
  - text streaming delta。
  - forced tool-call 输出实验。
  - tool-call JSON delta 解析实验。
  - usage/stop/error 映射实验。
- 定义 transcript JSONL schema。

### Product Surface

- CLI entrypoint。
- `--version`、`--help` fast path。
- 错误输出格式和 exit code 基线。

### Engineering Parity

- 初始化 TypeScript/Bun 工程。
- 建立 monorepo/package 边界。
- 建立 `typecheck`、`test`、`lint`、`build` 命令。
- 建立 Bun build 雏形、feature flags 雏形。
- 建立 provider contract fixture 目录。

### 验收标准

- `bun run typecheck` 通过。
- `bun run test` 覆盖核心类型和 provider event parser。
- CLI 可启动并输出版本/help。
- DeepSeek spike 产出结论：可直接 tool-call、需 prompt 包装、或需 parser fallback。

### 本版本不做

- 不做完整 TUI。
- 不做 MCP。
- 不做可编辑工具。

## V0.2 DeepSeek Streaming Agent Loop

### 目标

实现第一个可运行 headless agent：用户输入 -> DeepSeek streaming -> assistant response -> transcript。

### Agent Core

- `query()` async generator。
- `queryLoop()` 状态机雏形。
- DeepSeek provider：
  - streaming text delta。
  - abort signal。
  - basic retry。
  - usage 解析。
  - stop reason 映射。
- 支持 terminal：
  - `completed`
  - `model_error`
  - `aborted_streaming`
  - `max_turns`
- 支持最小 `systemPrompt + userContext + messages`。
- 支持 forced tool-call contract test，但不执行真实工具。

### Product Surface

- headless `-p/--print`。
- `--model`、`--max-turns`、`--permission-mode` 参数占位或最小解析。
- transcript append。
- 基础 stderr/stdout 分离。

### Engineering Parity

- provider VCR/fixture 测试。
- transcript replay 测试雏形。
- bundle smoke：构建后 CLI 可运行 `--version` 和 `-p`。
- DeepSeek API key 只从环境变量读取，不写入代码或日志。

### 验收标准

- 可执行：`agent -p "解释当前目录"`。
- streaming 输出不是一次性整段返回。
- abort 可停止请求。
- 每次请求写入 transcript。
- tool-call contract fixture 能稳定解析为内部 `ToolUseBlock`。

### 本版本不做

- 不执行真实工具。
- 不做自动 compact。
- 不做 TUI 权限弹窗。

## V0.3 核心工具、权限、配置和 Hooks MVP

### 目标

让 agent 能安全完成真实工程任务：读文件、搜索、执行命令、编辑文件。

### Agent Core

- 核心工具：
  - `Read`
  - `Write`
  - `Edit`
  - `Bash`
  - `Glob`
  - `Grep`
  - `TodoWrite`
- 工具 runtime：
  - `runTools()`
  - `runToolUse()`
  - Zod input validation。
  - `tool_result` message。
  - unknown tool 和 validation error recovery。
  - 并发安全工具批量并发。
  - 写入/命令工具串行。
- 权限系统：
  - `default`
  - `acceptEdits`
  - `bypassPermissions`
  - `plan`
  - `dontAsk`
  - `Tool`
  - `Tool(pattern)`
- Bash destructive command 检测。
- 文件路径安全检查。
- settings/config/auth/policy MVP：
  - DeepSeek API key env。
  - settings schema。
  - permission settings source。
  - model/provider config。
- hooks MVP：
  - `UserPromptSubmit`
  - `PreToolUse`
  - `PostToolUse`
  - `Stop`

### Product Surface

- headless 工具执行输出。
- 权限确认的最小交互文本流。
- `/permissions` 简版。
- `/status` 简版。

### Engineering Parity

- tool fixture tests。
- permission fixture tests。
- dangerous Bash tests。
- settings/env tests。
- hook dispatch tests。

### 验收标准

- agent 可读取仓库、搜索代码、运行只读命令。
- 编辑文件前会进入权限确认。
- 破坏性 Bash 命令不会被默认放行。
- 工具失败会以 `tool_result` error 进入下一轮，而不是直接崩溃。
- hooks 能影响至少一个工具执行前后的行为。

### 本版本不做

- 不做 MCP 工具。
- 不做完整 TUI。
- 不做 deferred tools。

## V0.4 CLI/TUI、Session 和本地体验

### 目标

把可用 agent 做成接近 Claude Code 的本地终端交互产品。

### Agent Core

- continuation 和 multi-turn recovery。
- read file state。
- permission state。
  - 一次/会话/settings 持久权限规则。
  - permission queue 和批量授权/拒绝。
  - MCP permission rule 格式桥接，不实现 MCP client。
- session state restore。
- prompt cache/上下文预算的最小统计。

### Product Surface

- CLI：
  - `--version`
  - `--help`
  - `-p/--print`
  - `--continue`
  - `--resume`
  - `--model`
  - `--permission-mode`
  - `--add-dir`
- React/Ink TUI：
  - App shell。
  - Prompt input。
  - 可选择 slash completion menu。
  - slash argument、project file mention、MCP resource、agent、queued command、prompt suggestion completion 底座。
  - Message list。
  - Status line。
  - Loading/streaming 状态。
  - Tool use/progress 展示。
  - Permission queue 和确认弹窗。
  - scoped permission rule 展示和持久化入口。
  - Doctor/Theme/Resume screen skeleton。
  - Theme 项目级持久切换。
  - ThemePicker 上下选择、preview、auto mode 和 Enter 持久保存。
  - `@anthropic/ink` theme core：palette、structured preview、COLORFGBG/terminal hint auto resolve。
  - Resume selected-session preview。
  - Resume restorePlan preview：lineage、missing parent、transcript hydration、file snapshot coverage。
  - Resume 本地搜索/filter。
  - Resume fork/rewind transcript 底座和 session graph。
  - Resume CheckpointPicker。
  - 文件 snapshot rewind MVP，覆盖文本、二进制、目录普通文件、空目录、symlink、mode。
  - PromptInput Shift+方向键选择和选中文本 Ctrl+C 系统剪贴板复制。
  - PromptInput SGR mouse prompt selection MVP。
- screen-level selection 数据模型，支持 status/messages/overlay/prompt 跨 pane copy text 抽取。
- renderer typed core Screen regression，覆盖 style/noSelect/softWrap/wide-char spacer/blit/shift/selection extraction。
- PromptInput 剪贴板失败提示。
  - PromptInput Ctrl+R history search/cycling。
  - PromptInput Vim insert/normal prompt mode MVP。
  - MessageList 按终端 columns 估算折行高度。
  - MessageList Ink stdout terminal viewport measurement。
  - MessageList `measureElement()` computed height cache。
  - Ctrl+C abort，Ctrl+D exit。
- Commands：
  - `/help`
  - `/clear`
  - `/compact` 简版
  - `/config` 简版
  - `/cost` 简版
  - `/diff` 简版
  - `/env` 简版
  - `/model`
  - `/memory` 简版
  - `/output-style` 简版
  - `/permissions`
  - `/status`
  - `/context`
  - `/resume`
  - `/doctor`
  - `/keybindings`
  - `/theme`
  - `/statusline`
  - `/usage`
  - `/version`
  - `/vim`
  - `/exit`

### Engineering Parity

- TUI smoke test。
- terminal app fallback smoke。
- Ink TUI force path smoke。
- transcript replay。
- resume/continue regression。
- perf budget：
  - 首屏启动时间。
  - streaming 首 token 时间。
  - 长消息列表内存上限。
- 最小 virtual list 或 message windowing，不能等到后期才解决长会话卡顿。
- scroll anchor restore helper，避免追加消息时丢失滚动位置。
- row-based MessageList 接入，先按终端行数估算。
- terminal columns 折行高度估算。
- CJK display width 折行估算。
- theme settings 持久化 regression。
- theme auto/preview regression。
- resume filter regression。
- resume fork/rewind regression。
- file snapshot rewind regression，覆盖文本/二进制/目录/symlink/mode 快照。
- prompt selection/clipboard helper regression。
- prompt mouse selection helper regression。
- prompt history search/cycling regression。
- prompt vim helper regression。
- prompt completion sources regression。
- renderer option normalization regression。
- message measurement guard regression。
- print mode json output regression。
- print mode stream-json/json-schema regression。
- screen-level cross-pane selection helper regression。

### 验收标准

- 交互式 TUI 可以完成一个包含 read/search/edit/bash 的任务。
- 中断后可恢复会话。
- 权限弹窗和 prompt 输入不会互相阻塞。
- 多个 permission request 不会互相覆盖。
- `Tool(pattern)` 范围授权不会误伤其它 provider tool schema。
- MCP tool permission 不生成源码不接受的括号 pattern。
- headless 和 interactive 复用同一套 query/tool runtime。
- 非 TTY 环境自动进入 line shell fallback。

### 本版本不做

- 不做 MCP。
- 不做 remote/daemon。
- 不做完整主题系统。

## V0.5 上下文、Compact、Memory 和长任务

### 目标

支撑长任务和复杂项目，不因上下文增长快速失效。

### 当前进度

V0.5 已实现当前版本规划内的本地可验证功能：

- `packages/agent-runtime/src/context.ts`：按 section 构造 runtime context，覆盖 base instructions、append instructions、current date、git status snapshot、`CLAUDE.md`/`.my-claude-code/memory.md`、resume context、additional directories。
- `packages/agent-runtime/src/context.ts`：提供 prompt 关键词匹配的 relevant memory attachment 简版。
- `packages/agent-runtime/src/compact.ts`：提供保守 auto compact threshold、compact boundary message、可注入 `CompactSummarizer`、tool result budget、大 tool result 持久化引用和简版 microcompact 截断。
- `queryLoop()` 在 provider request 前应用 auto compact 和 tool result budget；遇到 provider context overflow / prompt too long 会 reactive compact 并重试一次。
- `/context` 输出 runtime context 预算、section、memory files、relevant memory 和 git status 字符数；`/compact` 会写入结构化 compact boundary transcript record，并输出 compact candidate 和 session summary。

当前 V0.5 仍不做高级 context collapse、完整 memdir/local vault 和复杂 relevance ranking；这些明确在后续版本或“本版本不做”范围内。

### Agent Core

- Context：
  - `CLAUDE.md` 发现和注入。
  - git status snapshot。
  - current date。
  - additional directories。
  - system prompt 分 section 构造。
- Compact：
  - manual compact。
  - auto compact 阈值。
  - compact summary 模型调用。
  - compact boundary message。
  - tool result budget。
  - 大 tool result 截断和持久化引用。
  - microcompact 简版。
- Memory：
  - 项目 memory 文件读取。
  - relevant memory attachment 简版。

### Product Surface

- `/compact` 完整交互。
- `/context` 展示上下文预算。
- 长会话状态提示。
- 大工具结果引用展示。

### Engineering Parity

- 长会话 replay。
- compact before/after transcript fixture。
- 大文件读取和大 Bash 输出测试。
- prompt/context snapshot 测试。

### 验收标准

- 长会话超过阈值会自动 compact。
- compact 后 agent 能继续任务，不丢失当前目标。
- 大文件读取不会无限塞进上下文。
- `CLAUDE.md` 内容能影响 agent 行为。

### 本版本不做

- 不做完整 memdir/local vault。
- 不做高级 context collapse。

## V0.6 MCP、Skills、Plugins 和 Deferred Tools

### 目标

实现扩展能力，使 runtime 不只依赖内置工具。

### 当前进度

V0.6 已实现当前版本规划内的本地可验证 MVP：

- `packages/tools/src/extensions.ts`：新增 extension registry，统一发现 MCP servers、skills、plugins、deferred tools。
- MCP：支持 user/project/local 配置入口的 stdio server 发现，覆盖 `tools/list`、`tools/call`、`resources/list`、`resources/read`，并把 MCP tool 适配为本地 `Tool`。
- Skills：支持 `.claude/skills`、`.my-claude-code/skills` 的 markdown/frontmatter loader，并通过 `Skill` tool 返回 skill instructions。
- Plugins：支持 `.claude/plugins`、`.my-claude-code/plugins` 和 `--plugin-dir` 的 `plugin.json` manifest，plugin 可注入 commands、skills、MCP servers。
- Deferred tools：支持 `SearchExtraTools` 和 `ExecuteTool`，当前用于发现并执行 deferred plugin command tools。
- `queryLoop()` 默认加载 V0.6 extension registry；MCP/skill/deferred tools 和内置工具共用 provider tool schema、权限解析、tool execution event、`tool_result` 映射。
- Slash surface：新增 `/mcp`、`/skills`、`/plugin`、`/plugin run <plugin> <command>`，用于本地发现和 smoke test。

当前 V0.6 仍不做 marketplace、MCP OAuth、MCPB、SSE/HTTP/WebSocket transport、plugin install/update/enable/disable lifecycle、bundled skills、MCP `skill://` resources 和完整 skill search/ranking/cache；这些不是永久偏差，后续版本明确收口：

- V0.10：实现或关闭态验证 MCP OAuth、MCPB、SSE/HTTP/WebSocket transport、marketplace、plugin lifecycle、bundled skills、MCP `skill://` resources、skill search/ranking/cache、skill learning。
- V0.11：补齐 MCP/plugin/skill 相关 CLI flags、subcommands、slash commands、tool inventory 和 command inventory audit。
- V1.0：对 MCP/skills/plugins 做真实场景 hardening，覆盖发现、授权、调用、恢复和失败等价路径。

### Agent Core

- MCP：
  - stdio transport。
  - MCP config scopes：user/project/local。
  - `tools/list`。
  - `callTool`。
  - `resources/list`。
  - `resources/read`。
  - MCP tool -> local `Tool` adapter。
  - MCP tool permission rule。
- Skills：
  - `.claude/skills` loader。
  - markdown/frontmatter。
  - `SkillTool`。
  - skill command 注入。
- Plugins：
  - plugin manifest。
  - 本地 plugin dir。
  - plugin commands。
  - plugin skills。
  - plugin MCP server。
- Deferred tools：
  - `SearchExtraTools` 简版。
  - `ExecuteTool` 简版。

### Product Surface

- `/mcp` 或等价 MCP 状态命令。
- skill/plugin 发现结果展示。
- plugin command 可执行。

### Engineering Parity

- MCP fixture server。
- MCP permission fixture。
- skill loader fixture。
- plugin manifest validation。
- deferred tool discovery tests。

### 验收标准

- 可接入一个 stdio MCP server 并调用工具。
- MCP tool 走同一套权限和 `tool_result`。
- 本地 skill 能被发现和调用。
- plugin 可以注入至少一种 command 或 skill。

### 本版本不做

- 本版本不完成 marketplace、MCP OAuth、MCPB、SSE/HTTP/WebSocket transport、plugin install/update/enable/disable lifecycle、bundled skills、MCP `skill://` resources、完整 skill search/ranking/cache 的全量闭环；这些条目必须在 V0.10/V0.11/V1.0 按覆盖台账关闭，不能作为永久偏差。

## V0.7 Subagent、Task、Background 和 Worktree

### 目标

实现 Claude Code 的高级 agent 工作流能力。

### 当前进度

V0.7 已实现当前版本规划内的本地可验证 MVP：

- `packages/tools/src/workflows.ts`：新增 workflow tools，覆盖 `Agent`、`TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet`、`TaskOutput`、`TaskStop`、`BackgroundStart`、`BackgroundList`、`BackgroundOutput`、`BackgroundStop`、`EnterWorktree`、`ExitWorktree`、`WorktreeStatus`。
- Subagent：`Agent` tool 会创建隔离的 subagent record/transcript 文件，返回 result summary，并校验 subagent `allowedTools` 不能超过父 session restrictive `allowedTools`。
- Task：任务状态持久化到 `.my-claude-code/tasks/tasks.json`，支持跨 turn create/update/list/get/output/stop。
- Background：支持 detached local background process、log file、job state、output read、stop。
- Worktree：支持 active worktree session metadata、enter/exit/status 简版。
- Slash surface：新增 `/agents`、`/tasks`、`/background`、`/worktree`，用于本地发现和 smoke test。

当前 V0.7 仍不做完整 swarm/coordinator、proactive/Kairos、monitor/schedule、job templates、verification agent、brief flows 和 remote SSH；这些不是永久偏差，后续版本明确收口：

- V0.8：remote/bridge/daemon/SSH 最小闭环，关闭 remote SSH 真实连接缺口。
- V0.9：feature flag closure，登记并关闭 `PROACTIVE`、`KAIROS`、`MONITOR_TOOL`、`COORDINATOR_MODE`、`BG_SESSIONS`、`TEMPLATES` 等默认态/关闭态行为。
- V0.11：补齐 agents/tasks/job/monitor/schedule/coordinator 等 CLI/slash/tool inventory audit。
- V1.0：对 subagent/background/remote 场景做真实工程任务 hardening，覆盖完成路径和等价错误路径。

### Agent Core

- Subagent：
  - `Agent` tool。
  - agent context 隔离。
  - agent tool filtering。
  - agent transcript。
  - agent result summary。
- Task：
  - `TaskCreate`
  - `TaskUpdate`
  - `TaskList`
  - `TaskGet`
  - `TaskOutput`
  - `TaskStop`
- Background：
  - detached background session。
  - logs。
  - attach/kill。
  - 简版 daemon state。
- Worktree：
  - worktree session metadata。
  - enter/exit worktree 工具简版。

### Product Surface

- task/background 命令面。
- background 日志查看。
- subagent 进度和摘要展示。
- worktree 状态提示。

### Engineering Parity

- subagent isolation tests。
- background lifecycle tests。
- task persistence tests。
- worktree metadata tests。

### 验收标准

- 主 agent 可以委派子任务并拿回摘要。
- task list 可以跨 turn 维护。
- background session 可启动、查看日志、终止。
- 子 agent 的权限不能越过主 session 策略。

### 本版本不做

- 不做完整 swarm/coordinator。
- 不做 proactive/Kairos、monitor/schedule、job templates、verification agent、brief flows 的全量闭环。
- 不做 remote SSH 真实连接；该项在 V0.8 收口。

## V0.8 Remote、Bridge、Daemon 和 SSH 最小闭环

### 目标

补齐 Claude Code 非本地运行能力，避免 V1.0 仍只是 local clone。

### Agent Core

- daemon lifecycle。
- remote-control bridge protocol MVP。
- remote session state。
- SSH remote 最小连接/命令面，允许先做受限能力。
- remote 安全策略：
  - 禁止未经确认的危险命令。
  - remote path 和 local path 隔离。
  - session token 不落 transcript。

### Product Surface

- remote/attach/detach 命令面。
- daemon 状态查看。
- remote 错误提示。
- remote session resume。

### Engineering Parity

- daemon lifecycle smoke。
- bridge protocol fixture。
- SSH/remote 可用 mock 或本地 loopback fixture。
- remote permission regression。

### 当前实现进度

- `packages/tools/src/remote.ts` 已实现 V0.8 本地 MVP：
  - daemon lifecycle 状态：`startDaemon()`、`readDaemonState()`、`stopDaemon()`。
  - bridge protocol fixture：`.my-claude-code/remote/bridge.jsonl` 记录 daemon、remote、trigger、terminal capture 事件。
  - remote session state：`.my-claude-code/remote/sessions.json` 和每个 session 的 transcript JSONL。
  - SSH remote 最小面：`loopback` 真执行和 `ssh-mock` 无外部依赖 fixture。
  - remote 安全策略：危险命令默认需要确认、remote path 不能逃出 session root、session token 不写入 transcript/bridge。
- `packages/commands/src/slashCommands.ts` 已接入 `/daemon`、`/remote`、`/attach`、`/detach`、`/peers`。
- `packages/tools/src/remote.test.ts` 和 `packages/commands/src/slashCommands.test.ts` 覆盖 lifecycle、bridge、loopback、SSH mock、resume、permission regression。

### 后续规划核对

- V0.8 已关闭最小闭环；未做的真实 remote-control server、真实 SSH 部署/auth proxy、ACP/WebSocket、URL handler/open/server、商业化 remote UI 不作为本版本验收。
- 这些缺口已在后续版本登记：V0.10 覆盖 Vite/remote-control-server package smoke、平台/native/集成默认态；V0.11 关闭 command/subcommand/flag inventory；V1.0 做 remote/background/subagent 操作路径 hardening 和真实场景对照。

### 验收标准

- 可以启动 daemon、连接、执行最小任务、断开、恢复。
- remote session 和 local session 的 transcript/权限边界清晰。
- remote 命令失败不会破坏本地 session。

### 本版本不做

- 不做大规模 remote fleet。
- 不做商业化 remote control UI。

## V0.9 Feature Flag Closure

### 目标

关闭源码中默认 feature、非默认 feature、默认关闭 feature 形成的隐藏条件分支，确保后续版本不再发现未登记能力。

### Agent Core

- feature flag matrix closure：
  - 默认开启 feature 必须映射到实现版本，或达到 `Disabled-Parity`。
  - 默认关闭 feature 必须覆盖关闭态行为。
- 所有 `feature('...')` 调用必须进入 `docs/10-source-coverage-ledger.md`。
- provider registry、model aliases、thinking/effort、prompt cache break detection 的 feature-gated 行为全量 audit。
- telemetry/debug/tracing 类 feature 必须有 secret-safe 默认态。

### Product Surface

- feature-gated command/tool 的显示、隐藏、help、错误提示行为。
- 用户可见 feature gate 不允许静默缺失。

### Engineering Parity

- feature flag matrix 更新到无 `RED`。
- `DEFAULT_BUILD_FEATURES`、disabled features、conditional feature calls 全部进入状态登记表。
- 每个 feature 至少有目标版本、parity case；当前版本关闭的 feature 需要 disabled-parity 测试。

### 当前实现进度

- `packages/core/src/featureFlags.ts` 已实现 V0.9 typed feature matrix：
  - `UPSTREAM_DEFAULT_BUILD_FEATURES` 登记 `claude-code/scripts/defines.ts` 的默认 feature。
  - `UPSTREAM_DISABLED_FEATURES` 登记源码默认关闭 feature。
  - `FEATURE_FLAG_MATRIX` 为每个 feature 记录目标版本、`Covered`/`Disabled-Parity`/`Planned`、runtime 默认态、用户可见性、secret-safe 默认态和说明。
  - `validateFeatureFlagMatrix()` 检查未登记 feature、未登记 default build feature、未覆盖却默认开启的 feature、非 secret-safe 默认开启 feature。
  - `scanFeatureCallsFromText()` 用于扫描 `feature('...')` 源码调用。
- `packages/core/src/protocol.test.ts` 已真实扫描当前 `claude-code` 源码树，确保所有 `feature('...')` 调用都进入 matrix。
- `packages/commands/src/slashCommands.ts` 已新增 `/features`，以 JSON 输出每个 feature 的 runtime enablement、parity state 和目标版本，避免用户可见 feature gate 静默缺失。
- telemetry/debug/tracing 类 feature 目前全部默认关闭或 planned，且 runtime 默认开启 feature 必须是 `Covered` 且 `secretSafeDefault: true`。

### 后续规划核对

- V0.9 关闭的是 feature gate 的登记、默认态、安全态和可见性，不代表把所有 gated 产品能力都实现并启用。
- 已登记但未启用的能力继续按后续版本收口：V0.10 负责 platform/native/browser/voice/workflow/marketplace，V0.11 负责 tool/command/subcommand inventory closure，V1.0 做最终 hardening。

### 验收标准

- `docs/10-source-coverage-ledger.md` 中所有 feature 条目全部为 `Covered`、`Disabled-Parity` 或明确后续版本状态。
- 源码扫描 `feature('...')` 不产生未登记 feature。
- 任何新增 feature 必须先登记再实现。

## V0.10 Platform Integrations 和 Native Packages

### 目标

关闭平台集成、native package、browser/computer-use、voice、IDE/LSP、workflow、marketplace 等非核心但影响 1:1 的能力面。

### Agent Core

- LSP/IDE integration。
- workflow scripts。
- skill search/ranking/cache、skill learning 默认态和开启态。
- bundled skills 与 MCP `skill://` resources 默认态和开启态。
- voice/STT service。
- browser/computer-use tool protocol。
- MCP OAuth/MCPB。
- MCP SSE/HTTP/WebSocket transport。

### Product Surface

- voice mode。
- Chrome integration。
- browser/computer-use package surface。
- marketplace/plugin lifecycle。
  - plugin install/update/enable/disable。
- install integrations：
  - GitHub app。
  - Slack app。
  - desktop/mobile/chrome commands。
- local vault/local memory/vault command surfaces。

### Engineering Parity

- native package build smoke：
  - audio capture。
  - image processor。
  - color diff。
  - modifiers。
  - URL handler。
- Vite/remote-control-server package smoke。
- platform default-state regression。

### 验收标准

- `docs/10-source-coverage-ledger.md` 中 platform/native/package 条目无 `RED`。
- 平台能力若默认关闭，必须有 `Disabled-Parity` 证据。
- native package 在目标平台上通过 build smoke 或明确 default-state parity。

## V0.11 Inventory Closure 和 CLI Audit

### 目标

关闭全量 tool、command、Commander subcommand、CLI flag inventory，让 V1.0 不再补漏，只做稳定性和行为等价 hardening。

### Agent Core

- tool inventory closure。
- tool result mapping audit。
- permission UI/headless path audit。
- CLI flag 对 provider、tool、permission、session 的影响 audit。

### Product Surface

- command inventory closure。
- Commander subcommand inventory closure。
- help/alias/options/exit code audit。
- interactive/headless fast path audit。

### Engineering Parity

- 状态登记表所有 V0.11 及以前条目无 `RED`。
- tool/command/flag/subcommand 自动扫描与台账比对。
- 每个 inventory group 至少有 fixture、smoke 或 parity case。

### 验收标准

- 所有内置 tools 都有 schema、permission、UI/headless、result mapping 验收记录。
- 所有 command modules 都有目标版本、验收方式和当前状态。
- 所有 Commander 子命令和 CLI flags 都有 parity case 或 disabled-parity 测试。
- 源码扫描 command/tool/flag 不产生未登记条目。

## V1.0 1:1 Parity Hardening

### 目标

把前面版本打磨成稳定可替代版本，而不是只可演示的 prototype。

### Agent Core

- provider/tool-call 兼容性修正。
- agent loop terminal/continue/error audit。
- 权限和 hooks audit。
- compact/memory 长任务 audit。
- MCP/skills/plugins/subagent/background/remote audit。

### Product Surface

- CLI 参数和常用命令 parity audit。
- TUI 行为 parity audit。
- slash command audit。
- session/resume/continue audit。
- remote/background/subagent 操作路径 audit。

### Engineering Parity

- build/release/install audit。
- doctor/health。
- production-test。
- bundle integrity。
- 文档和升级说明。
- telemetry/network/secret safety audit。

### 当前实现进度

- `packages/commands/src/hardening.ts` 已实现 V1.0 release hardening report：
  - coverage ledger release gate：扫描 `docs/10-source-coverage-ledger.md` 中的 `Planned`、`In Progress`、`RED`，作为 V1.0 发布阻塞。
  - feature matrix audit：扫描当前 `claude-code` 源码树 `feature('...')`，复用 V0.9 matrix 检查未登记 feature、非法默认开启和非 secret-safe 默认态。
  - bundle integrity：检查 `dist/cli.js` 是否存在且体积合理。
  - production smoke：用当前 Node 执行 `dist/cli.js --version`，确认构建 artifact 可独立运行。
  - doctor health：复用 `/doctor` 检查，汇总 error/warning。
  - registry smoke：检查 builtin tool registry 和 slash command registry。
  - secret safety：只报告 secret env var 的配置数量/名称类别，不输出 secret 值。
- `packages/commands/src/slashCommands.ts` 已新增 `/health` 和 `/parity`，输出同一份 V1.0 hardening JSON report。
- `packages/commands/src/hardening.test.ts` 覆盖 release health、production smoke、ledger blocker、secret redaction。

### 当前 V1.0 状态

- V1.0 hardening gate 已实现并通过：`/health` 和 `/parity` 当前输出 `status: pass`。
- coverage ledger blocker 已清零；V0.10/V0.11 未作为当前本地 MVP 实现的外部平台/上游内部能力，均以明确 evidence 或 disabled-parity 边界收口，不再作为 V1.0 release blocker。
- doctor warning 代表可选环境项缺失，例如 managed policy、MCP config、context files，不阻塞发布；doctor error 才阻塞 V1.0。

### 验收标准

- 选取 50 个真实工程任务，与 Claude Code 对照执行，核心路径行为一致。
- 选取 20 个权限/危险命令场景，全部按预期拦截或确认。
- 选取 10 个长任务，能自动 compact 并完成。
- 选取 5 个 MCP/skill/plugin 场景，能发现、授权、调用、恢复。
- 选取 5 个 subagent/background/remote 场景，能完成或给出等价错误路径。
- `resume/continue` 能恢复中断任务。
- 安装后的 CLI artifact 可独立运行。
- `docs/10-source-coverage-ledger.md` 全部条目为 `Covered`、`Disabled-Parity` 或 D-001。
- 除 D-001 外无永久偏差。
- 无高优先级崩溃类问题。

## V1.1 Full Ecosystem Parity

### 目标

把 V1.0 中以 MVP、`Disabled-Parity`、默认关闭态或 full-parity follow-up 收口的能力继续推进到真实 1:1。V1.1 的目标不是再做一个“能用的本地 clone”，而是必须以 Claude Code 全量扩展生态、平台集成、命令清单、远端能力和真实验收任务的行为等价作为完成口径。

V1.1 起，`Disabled-Parity` 只能作为临时开发状态，不能作为版本完成状态。若某项能力依赖 Anthropic 私有服务、商业后台或不可获得凭据，必须实现本地等价替代、协议兼容 shim、明确错误路径和对照测试；不能只用“默认关闭”宣称完成。

### Agent Core

- MCP full transport parity：
  - stdio 之外补齐 SSE、HTTP、WebSocket transport。
  - MCP OAuth 授权、refresh、失败恢复和 token redaction。
  - MCPB package discovery/install/load。
  - MCP rich output、MCP `skill://` resources、MCP-provided skills。
- Skills full parity：
  - bundled skills。
  - skill search/ranking/cache。
  - skill learning / skill improvement 的默认关闭态、开启态和持久化边界。
  - skill generator / run-skill-generator 行为。
- Plugin full lifecycle：
  - marketplace registry。
  - plugin install/update/enable/disable/remove。
  - plugin command、skill、MCP server 的启用态、禁用态、冲突和权限隔离。
- Platform tools：
  - browser/computer-use tool protocol。
  - voice/STT service protocol 和默认关闭态。
  - IDE/LSP integration。
  - workflow scripts。
  - settings sync upload/download。
  - local vault/local memory/vault command surfaces。
- Remote full parity：
  - real remote-control server。
  - real SSH deploy/auth proxy。
  - ACP/WebSocket、pipe IPC、URL handler/open/server。
  - self-hosted runner、BYOC environment runner。
  - remote setup、remote env、remote bridge recovery。
- Observability and safety：
  - telemetry/tracing/debug features 需要 secret-safe disabled behavior 或本地等价实现。
  - slow-operation logging、Perfetto tracing、memory shape telemetry、coworker telemetry 的关闭态和开启态都要有测试。

### Product Surface

- 补齐 Claude Code 用户可见 command、slash command、subcommand、flag、alias、help text、exit code。
- 补齐 marketplace、plugin、skill、MCP OAuth、browser、voice、IDE/LSP、remote setup 的 CLI/TUI 入口。
- 补齐 user-visible disabled features 的提示，不允许静默缺失。
- 补齐真实 TUI 交互：OAuth prompt、plugin install confirmation、browser/computer-use progress、voice state、remote reconnect、MCP rich output rendering。
- 补齐安装后使用路径：全局 binary、shell integration、desktop/chrome/mobile/GitHub/Slack 相关命令的等价入口或明确兼容 shim。

### Engineering Parity

- source inventory diff：
  - 扫描 `claude-code/` 的 tools、commands、Commander subcommands、CLI flags、feature calls、package directories、native packages。
  - 每个 source item 必须映射到实现、disabled shim、或不可实现但有等价错误路径的 parity case。
- full ecosystem gate：
  - 在 `/parity` 基础上新增或扩展 full mode，要求 `Planned=0`。
  - user-visible feature 不允许停留在 `Disabled-Parity`。
  - V0.10/V0.11/V1.0 的 MVP-only 条目必须关闭或转成真实实现。
- 真实对照 fixture：
  - 与上游 Claude Code 行为对照记录输入、输出、exit code、transcript、permission prompt、tool result。
  - 每个外部集成都要有 fake server/mock server 和至少一个真实 smoke 配置入口。
- release artifact：
  - native packages、browser/voice/IDE/remote packages 都要进入 build smoke。
  - production artifact 不允许依赖 dev-only 路径。
- docs：
  - V1.1 文档必须是教程，不是实现总结。
  - 每个复杂能力都要说明协议、状态机、权限边界、失败恢复、测试 fixture 和本地验证命令。

### 必须关闭的 V1.0 遗留清单

- V0.6 遗留：
  - MCP OAuth。
  - MCPB。
  - MCP SSE/HTTP/WebSocket transport。
  - marketplace。
  - plugin install/update/enable/disable lifecycle。
  - bundled skills。
  - MCP `skill://` resources。
  - full skill search/ranking/cache。
- V0.7 遗留：
  - swarm/coordinator。
  - proactive/Kairos。
  - monitor/schedule。
  - job templates。
  - verification agent。
  - brief flows。
- V0.8 遗留：
  - real remote-control server。
  - real SSH deploy/auth proxy。
  - ACP/WebSocket。
  - URL handler/open/server。
  - commercial remote UI 的本地等价入口或明确兼容 shim。
- V0.10 遗留：
  - browser/computer-use。
  - voice/STT。
  - Chrome integration。
  - IDE/LSP。
  - workflow scripts。
  - GitHub/Slack/desktop/mobile/chrome install integrations。
  - settings sync upload/download。
  - native package smoke。
  - local vault/local memory/vault surfaces。
- V0.11 遗留：
  - 全量 command inventory closure。
  - 全量 tool inventory closure。
  - 全量 Commander subcommand inventory closure。
  - 全量 CLI flag parity case。
  - command/tool/flag 自动扫描和 ledger 比对。

### 验收标准

- `/health` 仍为 `status: pass`。
- `/parity` full ecosystem mode 为 `status: pass`。
- `/features` 输出中 `planned` 为 0。
- 用户可见 feature 不再停留在 `Disabled-Parity`；必须实现、提供等价 shim，或有明确可测试的 upstream-private error path。
- `docs/10-source-coverage-ledger.md` 中不允许出现 MVP-only、deferred、later、pending 作为完成证据。
- `claude-code/` source inventory diff 无未登记 source path、tool、command、subcommand、flag、feature。
- 至少完成并保存这些对照 fixture：
  - 50 个真实工程任务。
  - 20 个权限/危险命令场景。
  - 10 个长任务和 compact 场景。
  - 10 个 MCP/skill/plugin 场景，其中至少覆盖 OAuth、HTTP/SSE、plugin lifecycle、MCP skill。
  - 10 个 remote/background/subagent 场景，其中至少覆盖真实 SSH/remote server、reconnect、失败恢复。
  - 5 个 browser/computer-use 场景。
  - 5 个 IDE/LSP 场景。
  - 3 个 voice/default-state 场景。
- 所有新增能力都有本地可运行测试命令、fixture 和教程文档。

### 当前实现进度

- `packages/commands/src/hardening.ts` 已扩展 `mode: "release" | "full-ecosystem"`：
  - `/health` 和普通 `/parity` 继续运行 V1.0 release gate，保持当前发布状态 pass。
  - `/parity --full` 运行 V1.1 full ecosystem gate。
- V1.1 full ecosystem gate 当前新增三类阻塞检查：
  - `full ecosystem feature parity`：要求 `FEATURE_FLAG_MATRIX` 中 `Planned=0`，且用户可见 feature 不再停留在 `Disabled-Parity`。
  - `full ecosystem ledger`：扫描 `docs/10-source-coverage-ledger.md` 中 `Covered for MVP`、`MVP-only`、`disabled/full-parity`、`full-parity follow-up`、`deferred`、`later`、`pending`、`Planned:` 等不能作为 V1.1 完成证据的占位。
  - `source inventory diff`：扫描 `claude-code/src/*` 和 `claude-code/packages/*`，要求每个 upstream inventory item 在 coverage ledger 中有映射。
- `packages/cli/src/program.ts` 已支持 `bun run cli -- /parity --full`，并把 `--full`/`--full-ecosystem` 转发给 slash command。
- `packages/cli/src/program.ts` 已实现 `--dump-system-prompt` fast path；`DUMP_SYSTEM_PROMPT` 从 `Planned` 收到 `Covered`，该路径输出有效本地 system prompt 后立即退出，不调用 provider、不写 transcript。
- `packages/settings/src/settingsSync.ts` 已实现本地 settings sync snapshot；`/config sync-upload` 会导出 schema-safe 设置快照，`/config sync-download` 会把快照合并写回项目设置，`UPLOAD_USER_SETTINGS` 和 `DOWNLOAD_USER_SETTINGS` 从 `Planned` 收到 `Covered`。
- `packages/core/src/observability.ts` 已实现 secret-safe 本地 observability shim：telemetry、memory shape、slow operation、Perfetto trace、update detection skip、native attestation metadata 都只产生本地脱敏事件或 metadata，不发网络请求。
- `packages/tools/src/extensions.ts` 已实现本地 skill improvement feedback：`SkillFeedback` tool 和 `/skills feedback` 只写入本地 `.my-claude-code/skill-improvement.jsonl`，不做外部 survey 或隐藏同步。
- `packages/tools/src/remote.ts` 已实现 remote setup 与 pipe IPC 本地等价：`RemoteSetup`、`PipeRegister`、`PipeSend`、`PipeList` tools，以及 `/remote setup`、`/remote pipe-register`、`/remote send`、`/remote pipes` 命令面。
- `packages/tools/src/workflows.ts` 已实现 headless runner 本地等价：`EnvironmentRunner`、`SelfHostedRunner` tools，以及 `/tasks runner environment|self-hosted|list` 命令面；profile 只持久化 env key，不保存 secret 值。
- `packages/tools/src/workflows.ts` 已实现 templates/workflow/monitor 本地等价：`TaskTemplateCreate/List/Run`、`WorkflowScriptRun/List`、`MonitorStart/List/Output/Stop` tools，以及 `/tasks template`、`/tasks workflow`、`/monitor` 命令面；workflow env 只保存 key，不保存 secret 值。
- `packages/tools/src/workflows.ts` 已实现 built-in agents/coordinator/ultraplan 本地等价：bundled `explore`/`plan` agent persona、`CoordinatorRun/List` worker 记录、`UltraplanCreate/List` 本地计划记录，以及 `/agents builtin|run`、`/coordinator`、`/ultraplan` 命令面。
- `packages/tools/src/workflows.ts` 已实现 Kairos/proactive 本地等价：`AssistantMode/AssistantState`、`BriefCreate/List`、`KairosChannelRegister/List`、`PushNotification/List`、`GithubWebhookSubscribe/List`、`ProactiveSchedule/List` tools，以及 `/assistant`、`/brief`、`/channels`、`/push`、`/subscribe-pr`、`/proactive` 命令面；通知、channel 和 webhook 均只落本地状态，不发外部网络请求。
- `packages/tools/src/tools/webBrowser.ts` 已升级为 V1.7 stateful browser runtime：支持 `navigate`、`screenshot`、`click`、`type`、`key`、`scroll`、`back`、`forward`、`state`，持久化 `.my-claude-code/browser-sessions/*` 会话，生成 SVG screenshot artifact；默认阻断 localhost/private hosts，显式 `allowLocalhost` 才允许本地调试。
- `packages/tools/src/tools/computerUse.ts` 已实现 `ComputerUse` / `ComputerUseInput`：对齐 computer-use MCP、input 和 Swift package surface，可对 active browser session 发送输入事件并读取运行状态。
- `packages/tools/src/services/lsp/*` 已补 IDE/LSP supporting services：diagnostics、selection/diff、logging hooks；`/ide` 命令输出 LSP、MagicDocs、PromptSuggestion、selection/diff/status/logging surface。
- `/chrome`、`/desktop`、`/mobile`、`/install-github-app`、`/install-slack-app` 已从 V1.7 待办占位改为 command-specific local runtime surface；`/parity --strict --platform` 作为 V1.7 专项验收 gate。
- `packages/commands/src/slashCommands.ts` 与 `packages/cli/src/program.ts` 已补 Weixin package 用户入口：`/weixin serve` 和 `bun run cli -- weixin serve` 注册 builtin `plugin:weixin@builtin` channel，暴露 `plugin:weixin:weixin` MCP server metadata、`reply`/`send_typing` tools、login clear/access pair 状态；不持久化 QR、cookie、token 等 raw secret。
- `packages/tui/src/messageMarkdown.ts` 已升级为 block-level terminal markdown renderer：表格转 aligned terminal rows，table separator 不再原样显示，无序列表使用单个 bullet 并缩进 continuation，inline bold/link/code marker 会清理；`TuiApp` 对 assistant streaming delta 做 40ms buffer，减少 token 级重绘闪动。
- `packages/tools/src/extensions.ts` 已实现 bundled `claude-api` skill：`BUILDING_CLAUDE_APPS` 对齐 Claude Code 的 bundled Claude API app-builder skill 注册路径，可通过 `/skills` 发现并通过 `Skill` tool 读取教程。
- `packages/tools/src/extensions.ts` 已实现本地 skill generator / learning：`SkillGenerate` 会显式写入 `.my-claude-code/skills/*.md`，`SkillLearning/SkillLearningList` 会显式写入/读取 `.my-claude-code/skill-learning.jsonl`，`/skills generate|learn` 提供可测命令面；不做隐藏学习或外部同步。
- `packages/tools/src/remote.ts` 已实现 LAN pipe V1.5 runtime：`LanPipeRegister` tool 和 `/remote lan-register` 可对 localhost 绑定真实 TCP listener，`PipeSend` 会通过 TCP 发送消息；非本机 host 仍作为显式 endpoint，不做自动局域网扫描。
- `packages/tools/src/tools/overflowTest.ts` 已实现 `OverflowTest`：生成有界 synthetic overflow preview，用于上下文上限/截断测试，不产生无界大 payload。
- `packages/tools/src/ecosystem.ts` 已实现 V1.1 外部生态的本地等价：`AcpLink/List`、`AutofixPrPlan/List`、`BuddyStart/List`、`ChicagoMcpRegister/List`、`TorchProbe/List`、`VoiceModeSet/State` tools，以及 `/acp`、`/autofix-pr`、`/buddy`、`/chicago-mcp`、`/torch`、`/voice` 命令面；全部只写本地状态，不做 OAuth、真实 GitHub mutation、音频采集或内部 MCP 网络。
- 当前 `/parity --full` 已达到 `status: pass`，V1.1 full ecosystem gate 已收口：
  - `planned=0`。
  - `user-visible-disabled=0`。
  - full ecosystem ledger 已无占位证据。
  - source inventory diff 已通过：69 个 upstream inventory item 已映射。

## Epic Backlog

| Epic | 覆盖版本 | 主线 | 优先级 |
| --- | --- | --- | --- |
| Runtime core protocols | Sprint 0, V0.1 | Agent Core | P0 |
| DeepSeek provider compatibility | Sprint 0, V0.1, V0.2 | Agent Core | P0 |
| Agent loop state machine | V0.2-V1.0 | Agent Core | P0 |
| Builtin tools | V0.3 | Agent Core | P0 |
| Permission runtime | V0.3-V1.0 | Agent Core | P0 |
| Settings/auth/config/policy | V0.3 | Agent Core | P0 |
| Hooks | V0.3-V0.6 | Agent Core | P0 |
| Interactive TUI | V0.4 | Product Surface | P0 |
| Session persistence | V0.4 | Product Surface | P0 |
| Context and prompt system | V0.5 | Agent Core | P0 |
| Compact and tool result budget | V0.5 | Agent Core | P0 |
| MCP stdio | V0.6 | Agent Core | P1 |
| Skills | V0.6 | Agent Core | P1 |
| Plugins | V0.6 | Product Surface | P1 |
| Deferred tools | V0.6 | Agent Core | P1 |
| Subagents and tasks | V0.7 | Agent Core | P1 |
| Background sessions | V0.7 | Product Surface | P1 |
| Worktree session | V0.7 | Product Surface | P1 |
| Remote/bridge/daemon/SSH | V0.8 | Product Surface | P1 |
| Feature flag matrix closure | V0.9 | Engineering Parity | P0 |
| Platform integrations and native packages | V0.10 | Product Surface | P1 |
| Command, tool and CLI inventory closure | V0.11 | Engineering Parity | P0 |
| Build/release/install/doctor | V0.1-V1.0 | Engineering Parity | P0 |
| Test matrix and parity fixtures | Sprint 0-V1.0 | Engineering Parity | P0 |
| Browser/computer use/voice | V0.10 | Product Surface | P1 |
| Full ecosystem parity | V1.1 | Product Surface | P0 |
| MCP OAuth and full transports | V1.1 | Agent Core | P0 |
| Plugin marketplace and lifecycle | V1.1 | Product Surface | P0 |
| Full source inventory diff gate | V1.1 | Engineering Parity | P0 |
| Real remote/browser/IDE/voice parity fixtures | V1.1 | Engineering Parity | P0 |

## 核心风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| DeepSeek tool calling 语义与 Claude 不一致 | agent loop 返工 | Sprint 0/V0.1 做 compatibility spike，内部统一成 Claude-compatible content blocks |
| 技术栈没有按源码锁定 | 后续 TUI/build/release 返工 | V0.1 前冻结 Bun/TS/React/Ink/build/quality ADR |
| 一开始只做 UI 表面 | 学不到 agent runtime | 每个版本必须同时有 Agent Core 和 Engineering Parity 验收 |
| 一开始做太多高级能力 | 进度失控 | 高级能力拆到 V0.6-V0.8，但不移出 V1.0 范围 |
| TUI 和 runtime 强耦合 | headless/SDK/remote 返工 | TUI 只消费 query events |
| 权限系统做晚 | 工具无法安全开放 | V0.3 必须完成权限 runtime 和 settings source |
| hooks 做晚 | 工具、安全、compact 行为返工 | V0.3 做 hooks MVP，V0.6 扩展 |
| compact 做晚 | 长任务不可用 | V0.5 前完成基础 compact，V0.4 已有预算统计 |
| remote/bridge 没有在 V0.8 关闭 | V1.0 不是 1:1 | V0.8 必须关闭 remote/daemon/bridge 最小闭环 |
| V1.0 MVP/Disabled-Parity 被误当最终完成 | 永远达不到 1:1 完美复刻 | V1.1 把所有 MVP-only、deferred、user-visible Disabled-Parity 拉回实现队列，并以 full ecosystem parity gate 阻塞版本完成 |
| build/release 最后才做 | dev-only prototype | 从 V0.1 开始每版做 bundle smoke |
| 测试矩阵太薄 | parity 缺口不可控 | Sprint 0 建 parity case，V0.2 起维护 fixture/replay |
| 源码清单没有单一事实源 | 重复文档导致遗漏或幻觉 | 以 `docs/10-source-coverage-ledger.md` 为唯一覆盖台账 |
