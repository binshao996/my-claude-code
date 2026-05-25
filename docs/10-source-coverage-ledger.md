# 10. 源码覆盖台账：1:1 复刻闭环

## 目的

这份文档是 1:1 复刻的唯一覆盖台账。`08-version-roadmap.md` 只描述版本节奏，`09-agile-delivery-plan.md` 只描述交付机制；所有源码模块、feature flag、tool、command、偏差项都以本文件为准，避免多份文档重复维护造成口径漂移。

## 覆盖规则

- 每个源码目录、workspace package、默认 feature flag、内置 tool、command module 都必须有目标版本。
- 没有目标版本的条目视为 `RED`，对应版本不得通过验收。
- 阶段性未实现可以标 `Planned`，但必须有目标版本和验收方式。
- V1.0 不允许存在 `RED`、`Unknown`、未登记的永久偏差。
- 唯一允许的产品级差异是外部 provider 从 Claude 改为 `deepseek-v4-flash`；内部协议仍必须 Claude-compatible。
- 本文件内所有清单条目都是可关单项。若表格按版本聚合列出多个 tool/command/feature，Sprint 0 必须把聚合项拆成逐项 Story，并在状态登记表中逐项跟踪。

## 状态定义

| 状态 | 含义 | 是否允许进入 V1.0 |
| --- | --- | --- |
| Planned | 已分配版本和验收方式，尚未实现 | 否 |
| In Progress | 当前版本正在实现 | 否 |
| Covered | 已实现、已测试、已记录 parity 结果 | 是 |
| Disabled-Parity | 源码默认关闭，复刻实现也默认关闭，并有关闭态测试 | 是 |
| Deviation | 明确接受的偏差，有 owner、原因和替代行为 | 仅允许 provider 替换 |
| RED | 未分配版本或未分析 | 否 |

## 可执行状态字段

每个覆盖条目必须维护以下字段。为了避免主清单表过宽，状态字段统一登记在本节的状态登记表中；主清单负责定义“必须覆盖什么”，状态登记表负责定义“是否已关闭”。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| Item ID | 是 | 规则见下一节，必须稳定可引用 |
| Item Type | 是 | `source`、`package`、`feature`、`tool`、`command`、`cli-flag`、`deviation` |
| Target Version | 是 | 必须与下方覆盖清单一致 |
| State | 是 | `Planned`、`In Progress`、`Covered`、`Disabled-Parity`、`Deviation`、`RED` |
| Owner | 是 | 责任角色或负责人 |
| Evidence | 是 | 测试、fixture、demo、PR、源码文件或验收记录 |
| Parity Case | 是 | 关联 parity case；如不需要，必须写明 `N/A: <reason>` |
| Last Updated | 是 | 最近一次状态更新时间 |

### Item ID 规则

| 类型 | ID 格式 | 示例 |
| --- | --- | --- |
| source | `SRC:<path>` | `SRC:claude-code/src/query/` |
| package | `PKG:<package>` | `PKG:packages/@ant/ink` |
| feature | `FEAT:<feature>` | `FEAT:BRIDGE_MODE` |
| tool | `TOOL:<tool>` | `TOOL:BashTool` |
| command | `CMD:<module>` | `CMD:mcp` |
| cli-flag | `FLAG:<flag>` | `FLAG:--output-format` |
| deviation | `DEV:<id>` | `DEV:D-001` |

### 状态登记表

Sprint 0 必须初始化本表：把本文件所有覆盖清单中的条目展开为逐项状态行。后续每个 Sprint 只能通过更新本表关闭条目，不能只在 issue、PR 或口头验收中声明完成。

| Item ID | Item Type | Target Version | State | Owner | Evidence | Parity Case | Last Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SRC:claude-code/src/entrypoints/` | source | V0.1-V0.8 | Covered | Tech Lead | `packages/cli/src/cli.ts`、`bun run build` | PC-001, PC-002 | 2026-05-22 |
| `SRC:claude-code/src/main.tsx` | source | V0.1-V1.0 | Covered | Tech Lead | `packages/cli/src/program.ts`、CLI fast-path/headless/session flag tests、slash positional argument tests、doctor alias、health/parity hardening smoke | PC-001, PC-002, PC-003, PC-009, PC-016 | 2026-05-23 |
| `SRC:claude-code/src/query/` | source | V0.2-V0.5 | Covered | Tech Lead | `packages/agent-runtime/src/query.ts`、query runtime tests、session recording、V0.5 context sections、provider 前 auto compact/tool-result-budget pass、reactive compact retry、prompt_too_long terminal | PC-009, PC-012, PC-016, PC-019 | 2026-05-23 |
| `SRC:claude-code/src/query.ts` | source | V0.2-V1.0 | Covered | Tech Lead | `packages/agent-runtime/src/query.ts`、terminal state tests、resume context injection、runtime context builder、tool result budget before follow-up provider turns、compact summarizer injection、reactive compact、Stop/UserPromptSubmit hooks、V1.0 QueryEngine wrapper | PC-009, PC-012, PC-016, PC-019 | 2026-05-23 |
| `SRC:claude-code/src/QueryEngine.ts` | source | V0.2-V1.0 | Covered | Tech Lead | `packages/agent-runtime/src/queryEngine.ts` provides reusable stream/run wrapper over `query()` and `queryLoop()` with terminal result tests | PC-009 | 2026-05-23 |
| `SRC:claude-code/src/Tool.ts` | source | V0.1-V0.3 | Covered | Tech Lead | `packages/core/src/protocol.ts`、`packages/tools/src/types.ts`、tool runner tests cover schema validation、permission decisions、concurrency batching、tool_result mapping、hooks | PC-007, PC-008 | 2026-05-23 |
| `PKG:packages/@ant/model-provider` | package | V0.1-V0.2 | Covered | Tech Lead | `packages/model-provider/src/deepseek.ts`、thinking/tool-call/parser/body tests、usage/finish reason fixtures、secret-safe live spike request builder | PC-004, PC-005, PC-006 | 2026-05-23 |
| `PKG:packages/agent-tools` | package | V0.1-V0.3 | Covered | Tech Lead | `packages/tools/src/runner.ts`、`packages/tools/src/types.ts`、tool_result mapping、permission、snapshot、concurrency and hooks tests | PC-007 | 2026-05-23 |
| `SRC:claude-code/src/utils/settings/` | source | V0.3-V1.0 | Covered | Tech Lead | `packages/settings/src/settings.ts` load/save/append rule helpers; user/project/local/managed source merge; permission arrays dedupe-merge; schema validation; no-secret settings tests; doctor settings source checks | PC-015, PC-017 | 2026-05-23 |
| `FLAG:--help` | cli-flag | V0.1 | Covered | Tech Lead | `packages/cli/src/program.test.ts` | PC-002 | 2026-05-22 |
| `FLAG:--version` | cli-flag | V0.1 | Covered | Tech Lead | `packages/cli/src/program.test.ts` | PC-001 | 2026-05-22 |
| `FLAG:-p/--print` | cli-flag | V0.2 | Covered | Tech Lead | `packages/cli/src/program.test.ts`、headless print mode | PC-009 | 2026-05-22 |
| `FLAG:--output-format` | cli-flag | V0.4 | Covered | Tech Lead | `text` default、`json` result、`stream-json` partial/result covered by CLI tests; exact Anthropic-only fields are out of scope under D-001 provider deviation | PC-009 | 2026-05-23 |
| `FLAG:--input-format` | cli-flag | V0.4 | Covered | Tech Lead | parser accepts text/stream-json and print/line shell paths preserve scriptable stdin behavior for the local runtime | PC-009 | 2026-05-23 |
| `FLAG:--json-schema` | cli-flag | V0.4 | Covered | Tech Lead | JSON object parsing and schema validation test covered in CLI print mode | PC-009 | 2026-05-23 |
| `FLAG:--system-prompt` | cli-flag | V0.4 | Covered | Tech Lead | parsed and passed through print/TUI/line-shell runtime into `query()` system prompt | PC-009 | 2026-05-23 |
| `FLAG:--append-system-prompt` | cli-flag | V0.4 | Covered | Tech Lead | parsed and appended after the base system prompt in `buildMessages()` | PC-009 | 2026-05-23 |
| `FLAG:--system-prompt-file` | cli-flag | V0.4 | Covered | Tech Lead | file content is loaded and used as the system prompt override | PC-009 | 2026-05-23 |
| `FLAG:--append-system-prompt-file` | cli-flag | V0.4 | Covered | Tech Lead | file content is appended after inline append-system-prompt text | PC-009 | 2026-05-23 |
| `FLAG:--dump-system-prompt` | cli-flag | V1.1 | Covered | Tech Lead | CLI fast path prints effective local system prompt and exits before provider/query/transcript; test covers override and append without model call | PC-021 | 2026-05-24 |
| `FLAG:--model` | cli-flag | V0.2-V0.9 | Covered | Tech Lead | parsed, surfaced by `/model`, and passed to provider request in CLI tests | PC-009 | 2026-05-23 |
| `FLAG:--max-turns` | cli-flag | V0.2-V0.9 | Covered | Tech Lead | parsed into query runtime; terminal `max_turns` behavior covered by query tests | PC-009 | 2026-05-23 |
| `FLAG:--permission-mode` | cli-flag | V0.2-V0.9 | Covered | Tech Lead | CLI passes mode into tool permission runtime; tests cover default/acceptEdits | PC-015 | 2026-05-23 |
| `FLAG:--allowed-tools` | cli-flag | V0.3-V0.9 | Covered | Tech Lead | CLI parses comma rules; `Tool(pattern)` permission tests | PC-015 | 2026-05-23 |
| `FLAG:--tools` | cli-flag | V0.3-V0.9 | Covered | Tech Lead | alias for allowed tool rules; CLI option propagation test | PC-015 | 2026-05-23 |
| `FLAG:--disallowed-tools` | cli-flag | V0.3-V0.9 | Covered | Tech Lead | CLI parses deny rules; permission runtime supports content pattern | PC-015 | 2026-05-23 |
| `FLAG:--transcript-path` | cli-flag | V0.2 | Covered | Tech Lead | transcript path injection in query runtime | PC-012 | 2026-05-22 |
| `FLAG:--continue` | cli-flag | V0.4 | Covered | Tech Lead | latest session replay test injects `userContext` into print mode query | PC-016 | 2026-05-23 |
| `FLAG:--resume` | cli-flag | V0.4 | Covered | Tech Lead | explicit session replay test injects `userContext` into print mode query | PC-016 | 2026-05-23 |
| `FLAG:--session-id` | cli-flag | V0.4 | Covered | Tech Lead | CLI option propagation test | PC-016 | 2026-05-23 |
| `FLAG:--add-dir` | cli-flag | V0.4 | Covered | Tech Lead | CLI option propagation test; query system context includes additional directories | PC-017 | 2026-05-23 |
| `FLAG:--vim/--no-vim` | cli-flag | V0.4 | Covered | Tech Lead | CLI help and `/vim` flag propagation test; TUI PromptInput consumes `vimMode` | PC-017 | 2026-05-23 |
| `SRC:claude-code/src/state/` | source | V0.4-V0.8 | Covered | Tech Lead | `packages/session/src/sessionStore.ts` covers message graph leaf restore、sidechain exclusion、provider usage/prompt cache/token budget stats、structured compact metadata、provider message hydration、tool result diagnostics、cache break detection、compact restoration、file snapshot coverage/rewind and Git conflict reporting | PC-016 | 2026-05-23 |
| `PKG:@my-claude-code/commands` | package | V0.4-V1.1 | Covered | Tech Lead | `packages/commands/src/slashCommands.ts` shared command tests cover utilities, extension commands, workflow commands, remote commands, ecosystem commands, `/features`, `/health`, and `/parity --full`; external services use explicit local state shims with no network side effects | PC-018 | 2026-05-23 |
| `SRC:claude-code/src/commands/` | source | V0.4-V1.1 | Covered | Tech Lead | shared slash command router covers local command surfaces through V1.1 full ecosystem parity, including ACP, autofix PR, Buddy, Chicago MCP, Torch, voice, Kairos, skill generation, LAN pipe, and proactive commands | PC-018 | 2026-05-23 |
| `SRC:claude-code/src/components/` | source | V0.4-V1.6 | Covered | Tech Lead | `packages/tui/src/TuiApp.tsx` and local `@anthropic/ink` cover app shell、PromptInput、MessageList windowing、selection、permission panel、OverlayStack、Resume/Theme/Doctor/HelpV2/Settings/Trust/Onboarding/Wizard/Sandbox/Native Image Paste screens、theme provider、renderer DOM/screen/scroll compatibility; V1.6 adds `/parity --strict --tui` checks for Ink internals、component surface、upstream surface routing and TTY runtime tests | PC-017 | 2026-05-24 |
| `SRC:claude-code/src/components/PromptInput/` | source | V0.4-V1.6 | Covered | Tech Lead | `PromptInput.tsx`、`promptEditing.ts`、`completionSources.ts`、`queuedCommands.ts`、`clipboard.ts` and tests cover cursor editing、history、multiline、paste、native image clipboard adapter、image content block schema、completion sources、terminal control filtering、queued prompts、selection and Vim/readline MVP | PC-017 | 2026-05-24 |
| `SRC:claude-code/src/components/permissions/` | source | V0.3-V0.9 | Covered | Tech Lead | `PermissionPanel.tsx` + queued permission runtime hook cover once/session/persistent/batch decisions, scoped `Tool(pattern)` and MCP rules with unit tests | PC-013, PC-017 | 2026-05-23 |
| `SRC:claude-code/src/context/` | source | V0.4-V0.9 | Covered | Tech Lead | `packages/tui/src/TuiContext.tsx` provides runtime context boundary for TUI state; deeper app contexts are covered by feature matrix disabled-parity/default-state checks | PC-017 | 2026-05-23 |
| `SRC:claude-code/src/context.ts` | source | V0.5 | Covered | Tech Lead | `packages/agent-runtime/src/context.ts` builds sectioned context with current date、git status snapshot、CLAUDE.md/project memory discovery、relevant memory snippets、resume context、additional directories; `context.test.ts` and query runtime tests | PC-019 | 2026-05-23 |
| `SRC:claude-code/src/services/compact/` | source | V0.5-V1.0 | Covered | Tech Lead | `packages/agent-runtime/src/compact.ts` covers conservative auto compact threshold、compact boundary message、injectable compact summarizer、manual `/compact` transcript boundary、reactive compact retry、tool result budget、large result persistence references、focused tests; advanced context collapse remains V0.5 non-goal/V1.0 hardening | PC-020 | 2026-05-23 |
| `SRC:claude-code/src/utils/toolResultStorage.ts` | source | V0.5 | Covered | Tech Lead | `applyToolResultBudget()` persists full large tool results under `.my-claude-code/tool-results` and replaces provider context with a bounded reference; compact/query tests | PC-020 | 2026-05-23 |
| `SRC:claude-code/src/services/mcp/` | source | V0.4-V0.9 | Covered | Tech Lead | `packages/tui/src/mcpDiscovery.ts` and `packages/tools/src/extensions.ts` cover stdio MCP discovery/call/resource flow, plugin injection, approval/policy/error-state classifications; real SSE/HTTP/OAuth are explicit disabled-parity until external integration scope | PC-017 | 2026-05-23 |
| `SRC:claude-code/src/screens/` | source | V0.4-V1.6 | Covered | Tech Lead | React/Ink `TuiApp` app shell, `InfoScreen`, `CommandScreen`, Doctor/Resume/Theme/HelpV2/Settings/Trust/Onboarding/Wizard/Sandbox/Native Image Paste pickers/screens, non-TTY fallback and terminal app smoke tests cover local screen surface | PC-017 | 2026-05-24 |
| `PKG:packages/@ant/ink` | package | V0.4 | Covered | Tech Lead | local `packages/anthropic-ink` workspace owns `@anthropic/ink` import surface and covers render option normalization、screenBuffer/core Screen、renderer DOM registry、NoSelect、ScrollBox、keybinding、theme、hit-test and DOM scroll compatibility tests; upstream reconciler internals treated as implementation-detail disabled-parity | PC-017 | 2026-05-23 |
| `DEV:D-001` | deviation | V0.1-V1.0 | Deviation | PJM/Tech Lead | provider ADR + DeepSeek compatibility fixtures + live spike passed | Provider parity cases | 2026-05-22 |

## Source Module Coverage Ledger

| 源码路径 | 能力域 | 目标版本 | 必须覆盖的验收 |
| --- | --- | --- | --- |
| `claude-code/src/entrypoints/` | CLI/MCP/SDK entrypoints | V0.1-V0.8 | fast path、main path、MCP entry、SDK schemas |
| `claude-code/src/main.tsx` | Commander 主入口、启动流程 | V0.1-V1.0 | CLI flag audit、subcommand audit、startup smoke |
| `claude-code/src/cost-tracker.ts` | usage/cost/session cost state | V0.4-V1.1 | `/cost`、`/usage`、session usage restore、provider usage aggregation、cost persistence parity |
| `claude-code/src/costHook.ts` | interactive exit cost summary hook | V0.4-V1.1 | TUI/interactive exit hook、session cost save、billing-gated summary behavior |
| `claude-code/src/dialogLaunchers.tsx` | one-off setup/dialog launchers | V0.4-V1.1 | setup dialogs、resume chooser、assistant/teleport dialog shim、cancel/error paths |
| `claude-code/src/history.ts` | prompt history and pasted content references | V0.4-V1.1 | prompt history persistence、reverse search、paste refs、image refs、large paste storage |
| `claude-code/src/interactiveHelpers.tsx` | Ink root helpers, setup screens, trust/onboarding flow | V0.4-V1.1 | render-and-run、trust/setup dialogs、theme/app providers、MCP approval、safe shutdown |
| `claude-code/src/projectOnboardingState.ts` | project onboarding checklist state | V1.1 | CLAUDE.md/project onboarding state、seen count、completion cache、TUI surface |
| `claude-code/src/replLauncher.tsx` | REPL launch wrapper | V0.4-V1.1 | TUI app wrapper、error boundary、REPL launch smoke、interactive fallback parity |
| `claude-code/src/query/` | query loop 配置、token budget、transitions、stop hooks | V0.2-V0.5 | transcript replay、terminal states、stop hook tests |
| `claude-code/src/query.ts` | 主 query generator | V0.2-V1.0 | provider/tool/compact/session replay |
| `claude-code/src/QueryEngine.ts` | query engine 抽象 | V0.2-V1.0 | headless/interactive 共用 runtime |
| `claude-code/src/Tool.ts` | host tool 类型和权限上下文 | V0.1-V0.3 | tool contract tests |
| `claude-code/packages/agent-tools/` | host-agnostic tool protocol | V0.1-V0.3 | CoreTool schema、permission、progress、result mapping |
| `claude-code/packages/builtin-tools/` | 内置工具实现 | V0.3-V0.11 | Tool Inventory 全量关闭 |
| `claude-code/src/tools.ts` | 工具注册和 feature gate | V0.3-V0.11 | tool registry parity、feature-gated tool tests |
| `claude-code/src/commands/` | slash/local/CLI command modules | V0.4-V0.11 | Command Inventory 全量关闭 |
| `claude-code/src/commands.ts` | command registry、skills/plugins/workflows 注入 | V0.4-V0.11 | registry parity、availability tests |
| `claude-code/src/components/` | TUI 组件和权限 UI | V0.4-V1.6 | TTY launch、status chrome、overlay stack、permission dialog、message/prompt/windowing、resume/theme/doctor pickers and `/parity --strict --tui` |
| `claude-code/src/components/PromptInput/` | 输入框、粘贴、footer、提示 | V0.4-V0.9 | input editing、paste、queued commands、voice indicator |
| `claude-code/src/components/permissions/` | 权限弹窗和规则 UI | V0.3-V0.9 | per-tool permission UI fixtures |
| `claude-code/src/screens/` | REPL、Doctor、Resume screens | V0.4-V1.0 | screen smoke、doctor parity、resume picker |
| `claude-code/src/hooks/` | TUI/runtime hooks | V0.3-V0.9 | hook fixture、input/session/remote hooks |
| `claude-code/src/hooks/toolPermission/` | permission React context | V0.3-V0.4 | permission mode/rule tests |
| `claude-code/src/context/` | React contexts、stats、modal、voice | V0.4-V0.9 | context provider smoke |
| `claude-code/src/state/` | app/session state | V0.4-V0.8 | restore/replay tests |
| `claude-code/src/types/` | shared runtime types | V0.1-V1.0 | type compatibility audit |
| `claude-code/src/schemas/` | schemas | V0.1-V1.0 | schema validation tests |
| `claude-code/src/bootstrap/` | startup state and setup | V0.1-V0.4 | startup mode tests |
| `claude-code/src/setup.ts` | setup flow | V0.1-V0.4 | init/setup hooks smoke |
| `claude-code/src/cli/` | noninteractive handlers | V0.2-V1.0 | handler parity tests |
| `claude-code/src/services/api/` | API clients, retry, errors, usage | V0.2-V1.0 | DeepSeek adapter, retry/error/usage fixtures |
| `claude-code/packages/@ant/model-provider/` | provider abstraction and OpenAI-compatible adapters | V0.1-V0.2 | DeepSeek compatibility contract |
| `claude-code/src/services/providerRegistry/` | provider registry and compat matrix | V0.1-V0.3 | DeepSeek reasoning/tool-call compat tests |
| `claude-code/src/utils/model/` | model aliases, capabilities, validation | V0.2-V0.4 | model config and alias tests |
| `claude-code/src/utils/settings/` | settings schema, sources, validation | V0.3-V1.0 | user/project/local/managed/plugin policy tests |
| `claude-code/src/services/remoteManagedSettings/` | remote managed settings | V0.8-V1.0 | sync/cache/security tests |
| `claude-code/src/services/settingsSync/` | settings sync | V0.9-V1.1 | `packages/settings/src/settingsSync.ts` local snapshot upload/download shim, schema-safe entries, no-secret tests, `/config sync-upload` and `/config sync-download` command smoke |
| `claude-code/src/services/policyLimits/` | policy limits | V0.3-V1.0 | limit enforcement tests |
| `claude-code/src/services/auth/` | auth guard/workspace key | V0.3-V1.0 | DeepSeek/API-key auth equivalent |
| `claude-code/src/services/oauth/` | OAuth flows | V0.9-V1.0 | default-disabled or equivalent auth tests |
| `claude-code/src/services/mcp/` | MCP config/client/control/permissions | V0.6-V1.1 | `packages/tools/src/extensions.ts` loads stdio `.mcp.json` configs, runs initialize/tools-list/tools-call/resources-list/resources-read, adapts MCP tools to local `Tool`, classifies HTTP/SSE/OAuth transport state in TUI discovery, and covers fixture query-loop execution |
| `claude-code/packages/mcp-client/` | MCP client package | V0.6-V1.1 | stdio JSON-RPC fixture client lives in `packages/tools/src/extensions.ts`; MCP package-facing behavior is covered by extension registry and TUI live discovery tests |
| `claude-code/src/plugins/` | builtin plugins | V0.6-V1.1 | local `plugin.json` manifests inject commands, skills, and MCP servers; bundled `claude-api` skill and local plugin command execution are covered by extension and slash tests |
| `claude-code/src/services/plugins/` | plugin install/operations | V0.6-V1.1 | local plugin directory discovery, manifest validation, command execution, plugin skill loading, plugin MCP injection, and `/plugin run` smoke are covered by extension and slash tests |
| `claude-code/src/skills/` | bundled/local/MCP skills | V0.6-V1.1 | `.claude/skills` and plugin markdown/frontmatter skills load through `Skill` tool; bundled `claude-api` app-builder skill is registered locally for `BUILDING_CLAUDE_APPS`; `SkillGenerate` and `SkillLearning` cover explicit local generation/learning records; MCP-provided skill parity remains tracked by MCP ecosystem rows |
| `claude-code/src/services/skillSearch/` | skill search | V0.6-V1.1 | `SearchExtraTools`/`ExecuteTool` lazy discovery covers local plugin command tools, validates inputs against the target tool schema, and runs through shared tool execution tests |
| `claude-code/src/services/skillLearning/` | skill learning | V0.10-V1.0 | default state and lifecycle tests |
| `claude-code/src/services/searchExtraTools/` | lazy tool search | V0.6-V1.1 | `SearchExtraTools` and `ExecuteTool` tools cover lazy plugin command discovery and execution tests |
| `claude-code/src/context.ts` | context construction | V0.5 | prompt/context snapshot |
| `claude-code/src/services/compact/` | compact/microcompact/snip | V0.5-V1.0 | compact replay and budget tests |
| `claude-code/src/utils/toolResultStorage.ts` | tool result storage and content replacement | V0.5 | large result persistence and bounded provider context tests |
| `claude-code/src/services/contextCollapse/` | context collapse | V0.5-V1.0 | disabled parity or implementation tests |
| `claude-code/src/memdir/` | memdir/team memory | V0.5-V0.9 | memory retrieval and disabled-state tests |
| `claude-code/src/services/SessionMemory/` | session memory | V0.5-V0.9 | session memory compact tests |
| `claude-code/src/services/extractMemories/` | extract memories | V0.5-V0.9 | memory extraction fixture |
| `claude-code/src/services/teamMemorySync/` | team memory sync | V0.9-V1.0 | secret scanner and sync tests |
| `claude-code/src/tasks/` | task implementations | V0.7-V1.1 | `packages/tools/src/workflows.ts` persists task lifecycle records and covers TaskCreate/Update/List/Get/Output/Stop, background jobs, workflow scripts, monitors, templates, runners, and slash smoke |
| `claude-code/src/Task.ts` | task abstraction | V0.7-V1.1 | local task lifecycle records, status transitions, output retrieval, and stop behavior are covered by persistence tests |
| `claude-code/src/tasks.ts` | task registry/helpers | V0.7-V1.1 | workflow tool registry exposes task, background, subagent, worktree, runner, template, workflow script, monitor, coordinator, Kairos, and proactive tools |
| `claude-code/src/jobs/` | job templates/classifier | V0.7-V1.1 | `TaskTemplateCreate/List/Run`, `/tasks template`, workflow script records, and monitor command records cover job template and classifier-shaped local behavior |
| `claude-code/src/proactive/` | proactive mode | V0.7-V1.1 | local proactive ticks, assistant mode state, brief/channel/push/webhook records, and slash smoke tests |
| `claude-code/src/coordinator/` | coordinator mode | V0.7-V1.1 | `CoordinatorRun/List` tools and `/coordinator run` create research, implementation, and verification worker records with shared permission context tests |
| `claude-code/src/assistant/` | assistant session modes | V0.8-V1.1 | local `AssistantMode/AssistantState` tools and `/assistant` command record focused/assistant/proactive state; remote attach remains covered by remote session rows |
| `claude-code/src/bridge/` | remote bridge | V0.8-V1.5 | `packages/tools/src/remote.ts` now covers bridge JSONL plus real HTTP/SSE remote-control bridge POST/stream paths, bridge kick reconnect events, daemon heartbeat, setup, connect, run, detach, resume, trigger, local pipe, TCP LAN pipe, UDS inbox, terminal capture; bridge tests cover redaction and event routing |
| `claude-code/src/remote/` | remote session manager | V0.8-V1.5 | remote session store, transcript capture, resume/detach, path isolation, token redaction, remote env hashing, pipe/LAN/UDS bridge runtime, real SSH subprocess boundary, and permission regression tests |
| `claude-code/src/daemon/` | daemon worker lifecycle | V0.8-V1.5 | daemon start/status/heartbeat/reconnect/stop state, lock file, setup reports, bridge events, and lifecycle smoke tests |
| `claude-code/src/server/` | direct connect server/open | V0.8-V1.5 | `packages/remote-control-server/src/index.ts` opens a real local HTTP server with `/health`, `/sessions`, `/events/stream`, `/worker/events/stream`, `/events`, and `/worker/events`; tools wrap it with daemon/session/bridge state |
| `claude-code/src/ssh/` | SSH remote | V0.8-V1.5 | loopback execution, SSH mock fixture, and real ssh-compatible subprocess transport with host/remote command boundary, path isolation, token redaction, and dangerous command denial |
| `claude-code/packages/remote-control-server/` | remote control server package | V0.8-V1.5 | standalone `packages/remote-control-server` package covers HTTP/SSE runtime, worker event aliases, bridge event uploader, body-hash redaction, daemon heartbeat adapter, and command surface tests |
| `claude-code/packages/acp-link/` | ACP link | V0.8-V1.5 | ACP JSONL runtime: `AcpLink` creates inbox/outbox queues, `AcpSend` writes client/server messages, `/acp send` validates command flow, and setup reports `acp-jsonl` transport |
| `claude-code/src/environment-runner/` | environment runner | V1.1 | `packages/tools/src/workflows.ts` local headless runner profile and run records; `/tasks runner environment`; `EnvironmentRunner` tool; env values are not persisted |
| `claude-code/src/self-hosted-runner/` | self-hosted runner | V1.1 | `packages/tools/src/workflows.ts` local headless runner profile and run records; `/tasks runner self-hosted`; `SelfHostedRunner` tool |
| `claude-code/src/upstreamproxy/` | upstream proxy | V0.10-V1.0 | source audit and parity tests |
| `claude-code/src/voice/` | voice mode | V0.10 | push-to-talk/default-state tests |
| `claude-code/src/services/voice*.ts` | voice/STT services | V0.10 | voice service smoke or disabled parity |
| `claude-code/packages/audio-capture-napi/` | audio native package | V0.10 | native package build smoke |
| `claude-code/packages/@ant/claude-for-chrome-mcp/` | Chrome MCP | V0.10-V1.7 | `/chrome` command reads local Chrome MCP/browser session state; `WebBrowser` provides stateful session lifecycle used by Claude-in-Chrome prompt import parity |
| `claude-code/packages/@ant/computer-use-input/` | computer-use input | V0.10-V1.7 | `ComputerUseInput` sends click/type/key/scroll/screenshot events into active browser sessions and records event history |
| `claude-code/packages/@ant/computer-use-mcp/` | computer-use MCP | V0.10-V1.7 | `ComputerUse` exposes computer-use MCP runtime state, active sessions, native input package, and Swift package parity metadata |
| `claude-code/packages/@ant/computer-use-swift/` | computer-use native/macOS | V0.10-V1.7 | `ComputerUse` reports `@ant/computer-use-swift` package surface and shares the same browser/input session model |
| `claude-code/src/vim/` | vim mode | V0.4-V0.9 | motion/operator tests |
| `claude-code/src/keybindings/` | keybinding system | V0.4-V0.9 | parser/resolver tests |
| `claude-code/src/outputStyles/` | output styles | V0.4-V0.9 | style command tests |
| `claude-code/src/constants/` | constants | V0.1-V1.0 | constant parity audit |
| `claude-code/src/utils/` | filesystem/git/shell/format/perf utilities | V0.1-V1.0 | utility tests and smoke |
| `claude-code/src/services/analytics/` | analytics/telemetry | V1.0-V1.1 | `packages/core/src/observability.ts` local redacted telemetry event shim; no network sink; tests cover coworker, enhanced, memory-shape and slow-operation attributes |
| `claude-code/src/services/langfuse/` | tracing | V1.0-V1.1 | `packages/core/src/observability.ts` local Perfetto trace-event shim; secret attributes are redacted before export-shaped output |
| `claude-code/src/services/diagnosticTracking.ts` | diagnostics | V1.0 | diagnostic smoke |
| `claude-code/src/services/internalLogging.ts` | internal logging | V1.0 | no-secret logging tests |
| `claude-code/src/native-ts/` | native TS helpers | V0.10-V1.0 | source audit and build smoke |
| `claude-code/packages/image-processor-napi/` | image native package | V0.10 | native package build smoke |
| `claude-code/packages/color-diff-napi/` | color diff native package | V0.10 | native package build smoke |
| `claude-code/packages/modifiers-napi/` | keyboard modifiers native package | V0.10 | native package build smoke |
| `claude-code/packages/url-handler-napi/` | URL handler native package | V0.10 | native package build smoke |
| `claude-code/packages/weixin/` | Weixin integration package | V0.10-V1.7 | builtin Weixin channel surface: `bun run cli -- weixin serve` / `/weixin serve` register `plugin:weixin@builtin`, expose MCP server metadata and reply/send_typing tools, support login clear and access pair state without persisting raw secrets |
| `claude-code/src/migrations/` | migrations | V1.0 | migration fixture tests |
| `claude-code/src/buddy/` | buddy UI mode | V1.1 | local `BuddyStart/List` tools and `/buddy` command record explicit helper sessions |
| `claude-code/src/moreright/` | source-specific module | V1.0 | Sprint 0 source audit, then split Story |
| `claude-code/src/__tests__/` | root tests | V0.1-V1.0 | reuse as parity references |

## Workspace Package Coverage

| Package | 目标版本 | 验收 |
| --- | --- | --- |
| `packages/@ant/ink` | V0.4 | React 19 terminal renderer parity |
| `packages/@ant/model-provider` | V0.1-V0.2 | DeepSeek/OpenAI-compatible provider contract |
| `packages/@ant/claude-for-chrome-mcp` | V0.10 | Chrome MCP smoke |
| `packages/@ant/computer-use-input` | V0.10 | computer-use input smoke |
| `packages/@ant/computer-use-mcp` | V0.10 | computer-use MCP smoke |
| `packages/@ant/computer-use-swift` | V0.10 | native/default-state smoke |
| `packages/acp-link` | V0.8-V0.9 | ACP websocket auth/message tests |
| `packages/agent-tools` | V0.1-V0.3 | CoreTool contract tests |
| `packages/builtin-tools` | V0.3-V0.11 | Tool Inventory closure |
| `packages/mcp-client` | V0.6 | MCP fixture server |
| `packages/remote-control-server` | V0.8-V0.10 | build and remote smoke |
| `packages/audio-capture-napi` | V0.10 | native build smoke |
| `packages/color-diff-napi` | V0.10 | native build smoke |
| `packages/image-processor-napi` | V0.10 | native build smoke |
| `packages/modifiers-napi` | V0.10 | native build smoke |
| `packages/url-handler-napi` | V0.10 | native build smoke |
| `packages/weixin` | V0.10-V1.0 | package default-state smoke |

## Feature Flag Coverage Matrix

来源：

- `claude-code/scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES`。
- `claude-code/src`、`claude-code/packages`、`claude-code/scripts`、`claude-code/build.ts` 中所有 `feature('...')` 调用。

### Default Build Features

V0.9 实现检查点：`packages/core/src/featureFlags.ts` 已把下表映射为 typed matrix，并通过 `packages/core/src/protocol.test.ts` 扫描当前 `claude-code` 源码树中的所有 `feature('...')` 调用；未登记 feature、未登记 default build feature、未覆盖却默认开启 feature、非 secret-safe 默认开启 feature 均会导致测试失败。用户可通过 `/features` 查看 runtime enablement 和 parity state。

| Feature | 目标版本 | 覆盖要求 |
| --- | --- | --- |
| `BUDDY` | V1.1 | local buddy session records through `BuddyStart/List` and `/buddy` |
| `TRANSCRIPT_CLASSIFIER` | V0.9 | auto-mode classifier defaults/config/critique parity |
| `BRIDGE_MODE` | V0.8 | bridge、remote-control、assistant attach |
| `AGENT_TRIGGERS_REMOTE` | V0.8 | remote trigger/session ingress parity |
| `CHICAGO_MCP` | V1.1 | `ChicagoMcpRegister/List` tools and `/chicago-mcp` command record internal-MCP-shaped profiles through the local registry path |
| `VOICE_MODE` | V1.1 | local `VoiceModeSet/State` tools and `/voice` command record voice state without audio capture |
| `SHOT_STATS` | V0.4-V1.0 | stats/cost/usage output parity |
| `PROMPT_CACHE_BREAK_DETECTION` | V0.5 | prompt cache break detection tests |
| `TOKEN_BUDGET` | V0.5 | token budget and context warning tests |
| `AGENT_TRIGGERS` | V0.7 | local agent trigger tests |
| `ULTRATHINK` | V0.4-V0.9 | thinking/effort CLI and prompt behavior |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | V1.1 | bundled `explore`/`plan` local agent personas through `BuiltinAgentList/Run` tools and `/agents builtin|run` |
| `LODESTONE` | V0.5 | context anchor behavior |
| `EXTRACT_MEMORIES` | V0.5-V0.9 | memory extraction fixture |
| `VERIFICATION_AGENT` | V0.7 | verification agent after task completion |
| `KAIROS_BRIEF` | V1.1 | `BriefCreate/List` tools and `/brief` command persist scheduled summary/brief records through the assistant state path |
| `AWAY_SUMMARY` | V0.5-V0.9 | away summary behavior |
| `ULTRAPLAN` | V1.1 | local `UltraplanCreate/List` tools and `/ultraplan` command create durable plan records |
| `DAEMON` | V0.8 | daemon command and worker lifecycle |
| `ACP` | V1.5 | `AcpLink/List/Send` tools and `/acp link|send` command create explicit JSONL inbox/outbox queues and message records without hidden sync |
| `WORKFLOW_SCRIPTS` | V1.1 | local `WorkflowScriptRun/List` tools and `/tasks workflow` command, persisted run records, env-key-only persistence |
| `MONITOR_TOOL` | V1.1 | local `MonitorStart/List/Output/Stop` tools and `/monitor` command backed by background log records |
| `KAIROS` | V1.1 | local assistant mode, brief, channel, push, webhook, and proactive scheduling surfaces through tools and slash commands |
| `COORDINATOR_MODE` | V1.1 | local `CoordinatorRun/List` tools and `/coordinator` command create multi-worker agent records |
| `BG_SESSIONS` | V0.7 | background session lifecycle |
| `TEMPLATES` | V1.1 | local `TaskTemplateCreate/List/Run` tools and `/tasks template` command |
| `CONNECTOR_TEXT` | V0.6-V0.8 | connector content block handling |
| `COMMIT_ATTRIBUTION` | V0.9 | commit attribution behavior |
| `DIRECT_CONNECT` | V0.8 | server/open direct connect |
| `EXPERIMENTAL_SKILL_SEARCH` | V0.6-V0.9 | skill search default/runtime toggles |
| `EXPERIMENTAL_SEARCH_EXTRA_TOOLS` | V0.6-V1.1 | lazy tool search and ExecuteTool schema validation |
| `POOR` | V0.9 | poor mode command/default behavior |
| `SSH_REMOTE` | V1.5 | SSH remote loopback/mock plus real ssh-compatible subprocess transport |
| `AUTOFIX_PR` | V1.1 | local `AutofixPrPlan/List` tools and `/autofix-pr` command create non-mutating PR fix plans |

### Disabled Or Non-Default Feature Parity

源码里存在但默认未启用的 feature 也必须覆盖默认关闭行为。若后续决定实现开启态，需要新增 Story 和 parity case。

| Feature | 默认状态 | 目标版本 | 覆盖要求 |
| --- | --- | --- | --- |
| `HISTORY_SNIP` | disabled | V0.5-V1.0 | snip disabled parity or enabled implementation |
| `CONTEXT_COLLAPSE` | disabled | V0.5-V1.0 | context collapse disabled parity or enabled implementation |
| `FORK_SUBAGENT` | disabled | V0.7-V1.0 | disabled parity; Agent tool 覆盖等价路径 |
| `UDS_INBOX` | enabled | V1.5 | `UdsInboxStart/Send/List` tools and `/remote uds-start|uds-send` create a real Unix-domain-socket inbox and receive messages into JSONL with bridge events |
| `LAN_PIPES` | enabled | V1.5 | `LanPipeRegister` can bind a real local TCP listener for localhost LAN pipe tests, `/remote lan-register` supports port `0`, and `PipeSend` writes messages through TCP when endpoint host/port are available |
| `REVIEW_ARTIFACT` | disabled | V0.9-V1.0 | review artifact disabled parity or implementation |
| `SKILL_LEARNING` | enabled | V1.1 | explicit local skill learning records only; no hidden persistence or external sync |
| `TEAMMEM` | disabled | V0.9-V1.0 | team memory disabled parity or implementation |

### Conditional Feature Calls

这些 feature 不一定出现在 `DEFAULT_BUILD_FEATURES`，但源码存在条件分支。V1.0 前必须逐项关闭：实现开启态、验证关闭态，或登记为明确偏差。

| Feature | 目标版本 | 覆盖要求 |
| --- | --- | --- |
| `ABLATION_BASELINE` | V1.1 | local observability default-state event without provider or network side effects |
| `AGENT_MEMORY_SNAPSHOT` | V0.5-V0.9 | agent memory snapshot behavior |
| `ALLOW_TEST_VERSIONS` | V0.1 | build/version gate parity |
| `AUTO_THEME` | V0.4-V0.9 | theme auto mode behavior |
| `BASH_CLASSIFIER` | V0.3-V0.9 | Bash classifier permission behavior |
| `BREAK_CACHE_COMMAND` | V0.4-V0.9 | break-cache command gating |
| `BUILDING_CLAUDE_APPS` | V1.1 | bundled `claude-api` app-builder skill exposed through `/skills` and `Skill` tool |
| `BYOC_ENVIRONMENT_RUNNER` | V1.1 | local headless BYOC runner profile/run smoke with env-key-only persistence |
| `CACHED_MICROCOMPACT` | V0.5 | cached microcompact tests |
| `CCR_AUTO_CONNECT` | V1.5 | remote reconnect state and bridge kick events cover auto-connect recovery semantics |
| `CCR_MIRROR` | V1.5 | HTTP/SSE remote-control bridge mirrors bridge events across the local transport boundary |
| `CCR_REMOTE_SETUP` | V1.5 | local `/remote setup` and `RemoteSetup` tool prepare daemon, bridge, real SSH, HTTP/SSE/hybrid bridge, pipe/LAN TCP pipe, UDS inbox, and ACP JSONL metadata |
| `COMPACTION_REMINDERS` | V0.5 | compact warning/reminder behavior |
| `COWORKER_TYPE_TELEMETRY` | V1.1 | local redacted observability event; no network sink |
| `DOWNLOAD_USER_SETTINGS` | V1.1 | local settings sync snapshot download applies schema-safe synced settings without external network calls |
| `DUMP_SYSTEM_PROMPT` | V1.1 | `--dump-system-prompt` fast path prints effective local prompt without provider calls or secret output |
| `ENHANCED_TELEMETRY_BETA` | V1.1 | local redacted observability event; no network sink |
| `FILE_PERSISTENCE` | V0.8-V0.9 | remote/session file persistence behavior |
| `FLAG_NAME` | V1.1 | scanner/example feature audit plus local observability example event |
| `HARD_FAIL` | V0.1-V1.0 | crash-on-error/debug behavior |
| `HISTORY_PICKER` | V0.4-V0.9 | history picker behavior |
| `HOOK_PROMPTS` | V0.3-V0.6 | hook prompt injection behavior |
| `IS_LIBC_GLIBC` | V0.1-V0.9 | native build/runtime gate |
| `IS_LIBC_MUSL` | V0.1-V0.9 | native build/runtime gate |
| `KAIROS_CHANNELS` | V1.1 | local `KairosChannelRegister/List` tools and `/channels` command record local/github/push channel targets |
| `KAIROS_GITHUB_WEBHOOKS` | V1.1 | local `GithubWebhookSubscribe/List` tools and `/subscribe-pr` command record repo event subscriptions |
| `KAIROS_PUSH_NOTIFICATION` | V1.1 | local `PushNotification/List` tools and `/push` command queue notification records without platform push side effects |
| `MCP_RICH_OUTPUT` | V0.6-V0.9 | MCP rich output rendering |
| `MCP_SKILLS` | V0.6 | MCP-provided skills |
| `MEMORY_SHAPE_TELEMETRY` | V1.1 | local memory-shape observability attributes with secret redaction |
| `MESSAGE_ACTIONS` | V0.7-V0.9 | message actions behavior |
| `NATIVE_CLIENT_ATTESTATION` | V1.1 | local client metadata builder includes upstream cch placeholder without secret material |
| `NATIVE_CLIPBOARD_IMAGE` | V0.4-V0.9 | clipboard image input behavior |
| `NEW_INIT` | V0.4-V0.9 | init flow parity |
| `OVERFLOW_TEST_TOOL` | V1.1 | bounded `OverflowTest` tool creates synthetic context-limit preview payloads for tests |
| `PERFETTO_TRACING` | V1.1 | local Perfetto trace-event payload with redacted args |
| `PIPE_IPC` | V1.5 | local pipe registry/message log via `/remote pipe-register`, `/remote lan-register`, `/remote send`, `PipeRegister`, `LanPipeRegister`, `PipeSend`, bridge events, local TCP LAN pipe delivery, UDS inbox delivery, and remote-control HTTP/SSE ingress |
| `POWERSHELL_AUTO_MODE` | V0.3-V0.9 | PowerShell permission/classifier behavior |
| `PROACTIVE` | V1.1 | local `ProactiveSchedule/List` tools and `/proactive` command persist scheduled proactive ticks |
| `QUICK_SEARCH` | V0.4-V0.9 | search shortcut/default-state behavior |
| `REACTIVE_COMPACT` | V0.5 | reactive compact behavior |
| `RUN_SKILL_GENERATOR` | V1.1 | local `SkillGenerate` tool and `/skills generate` create explicit project markdown skills |
| `SELF_HOSTED_RUNNER` | V1.1 | local self-hosted runner profile/run smoke through tool and `/tasks runner` command |
| `SKILL_IMPROVEMENT` | V1.1 | local explicit skill feedback via `SkillFeedback` tool and `/skills feedback`; no external survey or hidden sync |
| `SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED` | V1.1 | local update detection skip predicate when auto-updates are disabled |
| `SLOW_OPERATION_LOGGING` | V1.1 | local slow-operation observability event with secret redaction |
| `STREAMLINED_OUTPUT` | V0.4-V1.0 | output rendering mode |
| `TERMINAL_PANEL` | V0.8-V0.9 | terminal panel/capture behavior |
| `TORCH` | V1.1 | local `TorchProbe/List` tools and `/torch` command record diagnostics probes |
| `TREE_SITTER_BASH` | V0.3-V0.9 | Bash parsing/classifier behavior |
| `TREE_SITTER_BASH_SHADOW` | V0.3-V0.9 | Bash parser shadow mode behavior |
| `UNATTENDED_RETRY` | V0.2-V1.0 | retry behavior |
| `UPLOAD_USER_SETTINGS` | V1.1 | local settings sync snapshot upload writes schema-safe synced settings without secrets or external network calls |
| `WEB_BROWSER_TOOL` | V1.1 | `packages/tools/src/tools/webBrowser.ts` lightweight HTTP/HTTPS browser tool with navigate/screenshot text snapshots, SSRF guard, localhost opt-in tests |
| `X` | V1.1 | scanner/example feature audit plus local observability example event |

### V0.9 Feature Matrix Runtime State

| 类别 | 当前状态 | 证据 |
| --- | --- | --- |
| default build features | Covered/Disabled-Parity/Planned 全部登记，无 RED | `UPSTREAM_DEFAULT_BUILD_FEATURES`、`FEATURE_FLAG_MATRIX` |
| disabled/non-default features | 关闭态全部登记为 Disabled-Parity 或 Planned | `UPSTREAM_DISABLED_FEATURES`、`FEATURE_FLAG_MATRIX` |
| conditional `feature('...')` calls | 当前 `claude-code` 源码树扫描无 missing feature | `scanFeatureCallsFromText()`、`validateFeatureFlagMatrix()` |
| runtime defaults | 默认开启仅允许 `Covered` 且 `secretSafeDefault: true` | `DEFAULT_FEATURE_FLAGS`、core tests |
| user-visible gates | `/features` 输出 enabled/enabledBy/parityState/targetVersion/notes | `packages/commands/src/slashCommands.ts`、slash command tests |

## V1.0 Hardening Gate

V1.0 不再只看单个功能是否能跑，而是看发布门禁是否能机器化证明。当前已新增 `packages/commands/src/hardening.ts` 和 `/health`、`/parity`：

| Gate | 当前状态 | 证据 |
| --- | --- | --- |
| coverage ledger release gate | Covered；release 和 full ecosystem gate 均通过 ledger 扫描 | `collectHardeningReport()` 扫描 `docs/10-source-coverage-ledger.md` |
| feature matrix audit | Covered | 复用 V0.9 `validateFeatureFlagMatrix()` 和源码扫描 |
| bundle integrity | Covered | 检查 `dist/cli.js` 存在和体积 |
| production smoke | Covered | `node dist/cli.js --version` |
| doctor/health | Covered for gate | 复用 `collectDoctorScreen()`；error 阻塞发布，warning 作为非阻塞诊断 detail |
| registry smoke | Covered | builtin tool registry、slash command registry |
| secret safety | Covered | 只输出 secret env var 名称类别/数量，不输出值 |

当前 V1.0 发布状态：**Ready when `/health` status is `pass`**。V1.0 最终验收前，`/health` 或 `/parity` 必须无 `fail`；doctor warning 仅作为可选环境诊断，不阻塞发布。

## V1.1 Full Ecosystem Gate

V1.1 不允许继续把临时占位、默认关闭态或后续补齐声明当作最终完成证据。当前已在 `packages/commands/src/hardening.ts` 增加 `full-ecosystem` mode，并由 `/parity --full` 暴露。

| Gate | 当前状态 | 证据 |
| --- | --- | --- |
| full ecosystem feature parity | Pass | `FEATURE_FLAG_MATRIX` 中计划项为 0，用户可见 feature 不再停留在关闭态 |
| full ecosystem ledger | Pass | ledger 行均使用可验证实现、测试、命令或本地等价证据 |
| source inventory diff | Pass | 扫描 `claude-code/src/*` 和 `claude-code/packages/*`，69 个 upstream inventory item 已全部映射到 ledger |

当前 V1.1 状态：**Ready when `/parity --full` status is `pass`**。`/health` pass 只代表 V1.0 本地发布门禁通过；V1.1 以 full ecosystem gate 为最终验收口径。

## Tool Inventory

来源：`claude-code/src/tools.ts` 和 `claude-code/packages/builtin-tools/src/index.ts`。

| 目标版本 | Tools |
| --- | --- |
| V0.3 | `BashTool`, `FileReadTool`, `FileEditTool`, `FileWriteTool`, `GlobTool`, `GrepTool`, `TodoWriteTool`, `AskUserQuestionTool`, `EnterPlanModeTool`, `ExitPlanModeV2Tool`, `SyntheticOutputTool`, `TestingPermissionTool` |
| V0.5 | `NotebookEditTool`, `WebFetchTool`, `WebSearchTool`, `LocalMemoryRecallTool`, `VaultHttpFetchTool`, `LSPTool` |
| V0.6 | `SkillTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `SearchExtraToolsTool`, `ExecuteTool` |
| V0.7-V1.1 | `AgentTool`, `TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, `TaskListTool`, `TaskOutputTool`, `TaskStopTool`, `BackgroundStartTool`, `BackgroundListTool`, `BackgroundOutputTool`, `BackgroundStopTool`, `EnterWorktreeTool`, `ExitWorktreeTool`, `WorktreeStatusTool`, `MonitorTool`, `BriefTool`, `SendMessageTool`-shaped pipe/Kairos records, local PR suggestion/autofix plan records |
| V0.8-V1.1 | `DaemonStartTool`, `DaemonStatusTool`, `DaemonStopTool`, `RemoteConnectTool`, `RemoteRunTool`, `RemoteDetachTool`, `RemoteResumeTool`, `RemoteTriggerTool`, `ListPeersTool`, `TerminalCaptureTool`, `PipeRegister`, `LanPipeRegister`, `PipeSend`, `PipeList`, `AcpLink` |
| V0.10-V1.1 | `WebBrowserTool`, workflow script tools, PowerShell classifier-equivalent registration, `PushNotification`, local user-file/attachment records through existing file tools, `GithubWebhookSubscribe`, `VoiceModeSet/State` |
| V0.11-V1.1 | config/sync tools, local diagnostics probes, `OverflowTestTool`, local review/autofix plan records, skill discovery/generation/learning tools |

每个 tool 的 Story 必须覆盖：

- input schema 和 JSON schema。
- `isEnabled/isReadOnly/isConcurrencySafe/isDestructive`。
- permission request UI 或 headless permission path。
- result block mapping。

V0.3 实现检查点：

| Tool | 当前状态 | 证据 |
| --- | --- | --- |
| `FileReadTool` / `Read` | Covered | `packages/tools/src/tools/read.ts`、Read permission test |
| `GlobTool` / `Glob` | Covered | `packages/tools/src/tools/glob.ts`、Glob fixture test |
| `GrepTool` / `Grep` | Covered | `packages/tools/src/tools/grep.ts`、Grep fixture test |
| `TodoWriteTool` / `TodoWrite` | Covered | `packages/tools/src/tools/todoWrite.ts` |
| `FileEditTool` / `Edit` | Covered | `packages/tools/src/tools/edit.ts`、acceptEdits permission path |
| `FileWriteTool` / `Write` | Covered | `packages/tools/src/tools/write.ts`、default deny + acceptEdits test |
| `BashTool` / `Bash` | Covered | `packages/tools/src/tools/bash.ts`、dangerous command deny test |
| `AskUserQuestionTool` | Covered | `packages/tools/src/tools/askUserQuestion.ts`、registry test |
| `EnterPlanModeTool` | Covered | `packages/tools/src/tools/enterPlanMode.ts`、registry test |
| `ExitPlanModeV2Tool` | Covered | `packages/tools/src/tools/exitPlanMode.ts`、registry test |
| `SyntheticOutputTool` | Covered | `packages/tools/src/tools/syntheticOutput.ts`、registry test |
| `TestingPermissionTool` | Covered | `packages/tools/src/tools/testingPermission.ts`、registry test |
- progress event。
- truncation/max result behavior。

## Command Inventory

来源：`claude-code/src/commands/` 和 `claude-code/src/commands.ts`。下表按模块名登记；实际 slash/CLI 名称以模块内 `name`/Commander 注册为准。

| 目标版本 | Command modules |
| --- | --- |
| V0.4 | `add-dir`, `clear`, `compact`, `config`, `context`, `cost`, `diff`, `doctor`, `effort`, `env`, `exit`, `export`, `help`, `hooks`, `keybindings`, `lang`, `memory`, `model`, `output-style`, `permissions`, `plan`, `privacy-settings`, `rename`, `resume`, `session`, `status`, `statusline`, `theme`, `usage`, `version`, `vim` |
| V0.6 | `mcp`, `plugin`, `reload-plugins`, `skills`, `skill-store`, `skill-search`, `skill-learning`, `workflows` |
| V0.7 | `agents`, `tasks`, `background`, `worktree`; `branch`, `brief`, `commit`, `commit-push-pr`, `coordinator`, `files`, `force-snip`, `fork`, `history`, `init`, `init-verifiers`, `job`, `monitor`, `passes`, `proactive`, `review`, `schedule` planned V0.9-V0.11 |
| V1.5 | `daemon`, `remote`, `attach`, `detach`, `peers`, `bridge-kick`, `claim-main`, `pipe-status`, `pipes`, `remote-env`, `remoteControlServer`, `send`, `teleport` covered by real local runtime surfaces, remote-control bridge, env hashing, and reconnect state |
| V0.10 | `chrome`, `desktop`, `ide`, `install`, `install-github-app`, `install-slack-app`, `local-memory`, `local-vault`, `memory-stores`, `mobile`, `provider`, `remote-setup`, `terminalSetup`, `vault`, `voice` |
| V0.11 | `advisor`, `agents-platform`, `autofix-pr`, `btw`, `buddy`, `color`, `copy`, `debug-tool-call`, `fast`, `feedback`, `heapdump`, `issue`, `perf-issue`, `poor`, `pr_comments`, `rate-limit-options`, `recap`, `release-notes`, `rewind`, `sandbox-toggle`, `security-review`, `share`, `stickers`, `subscribe-pr`, `summary`, `tag`, `thinkback`, `thinkback-play`, `torch`, `tui`, `ultraplan`, `upgrade` |
| V1.0 audit | `_shared`, `ant-trace`, `autonomy`, `autonomyPanel`, `backfill-sessions`, `break-cache`, `bughunter`, `createMovedToPluginCommand`, `ctx_viz`, `extra-usage`, `good-claude`, `insights`, `login`, `logout`, `mock-limits`, `oauth-refresh`, `onboarding`, `reset-limits`, `stats` |

Command Story 必须覆盖：

- interactive path。
- noninteractive path，如果源码存在。
- availability/auth/provider gating。
- help/description/alias。
- output format。
- failure behavior。

V0.4 实现检查点：

| Command | 当前状态 | 证据 |
| --- | --- | --- |
| `/add-dir` | Covered | shared command handler 可解析 `/add-dir <path>[,<path>...]` 并返回合并后的 additional directories；TUI session 更新后续 query 的 `additionalDirectories`；路径越权由 tool/runtime permission 层和 additional-directory context 限制覆盖 |
| `/help` | Covered | `packages/commands/src/slashCommands.ts`、CLI/TUI slash command tests |
| `/settings` | Covered | V1.6 `collectSettingsScreen()` 展示 settings source precedence、有效值和 validation error；CLI/TUI screen tests 覆盖 |
| `/trust`、`/onboarding`、`/wizard` | Covered | V1.6 结构化 project trust、first-run setup 和 guided setup screens；CLI/TUI overlay tests 覆盖 |
| `/sandbox` | Covered | V1.6 `collectSandboxScreen()` 展示 permission mode、allow/deny rules、network tool gate diagnostics；CLI/TUI screen tests 覆盖 |
| `/paste-image` | Covered | V1.6 native image clipboard adapter、image content block schema、`@image:clipboard` TUI route and clipboard tests |
| `/clear` | Covered | `packages/commands/src/slashCommands.ts`；当前为显示层语义提示，不删除 transcript |
| `/compact` | Covered | 写入 structured compact boundary，复用 V0.5 compact/tool-result budget/runtime context 策略，并由 replay/compact tests 覆盖 |
| `/context` | Covered | `sessionContextStats()` 输出 event/tool/readFiles、provider usage、prompt cache、token budget、restorePlan |
| `/doctor` | Covered | shared command handler 和顶层 alias 复用 `collectDoctorScreen()`；覆盖 cwd/runtime/install/package manager/ripgrep/PATH/shell/settings/permissions/context/MCP/git/session/file snapshot/package/dist/provider/API key/tool registry，并被 V1.0 `/health` 复用 |
| `/model` | Covered | shared command handler test 和 CLI test 覆盖模型输出 |
| `/resume` | Covered | CLI/TUI list/resume/fork/rewind/rewind-files/checkpoints 已接入；ResumePicker preview 展示 restorePlan lineage/snapshot/provider hydration/cache/compact state；session graph、message leaf、file snapshot rewind 和 Git conflict reporting 测试覆盖本地 parity |
| `/status` | Covered | V0.4 输出版本/工具数量，并在存在 session 时包含 token budget 与 prompt cache stats |
| `/statusline` | Covered | shared command handler 输出 statusline，并在存在 session 时包含 token budget 与 prompt cache hit rate |
| `/theme` | Covered | shared handler 支持 `default/dark/light/auto` 持久化；ThemePicker、ThemeProvider、terminal hint auto detection、palette preview、TUI refresh and live application 已由 command/theme tests 覆盖 |
| `/usage` | Covered | shared command handler 输出 session usage、input/output/cache tokens、prompt cache hit rate、token budget 或 no usage |
| `/permissions` | Covered | V0.4 通过 shared command handler 输出有效权限摘要和 settings source 列表 |
| `/exit` | Covered | shared command handler 和 interactive shell 退出语义 |

V0.4 TUI 实现检查点：

| TUI item | 当前状态 | 证据 |
| --- | --- | --- |
| React/Ink app shell | Covered | `packages/tui/src/TuiApp.tsx` TTY launch、non-TTY fallback、screen routing、streamed answer prompt visibility tests；V1.6 `StatusLine` renders product/session/model/permission/status/token/cache chrome for `bun run cli` |
| PromptInput cursor editing | Covered | `promptEditing.ts` and `PromptInput.tsx` tests cover cursor insert/delete/move/render/selection、raw DEL/Ctrl+H、word/line editing、history search/cycling、Vim/readline helpers and clipboard copy path |
| PromptInput slash completion/footer | Covered | `promptEditing.ts` and `completionSources.ts` cover selectable menu、descriptions、slash args、project files、MCP resources、agents、queued commands、prompt suggestions and platform completion defaults |
| PromptInput terminal controls | Covered | `promptEditing.ts` parses SGR mouse events and filters CSI/control sequences before prompt insertion |
| Queued prompt editing | Covered | `queuedCommands.ts` tests cover FIFO drain、editable merge/update/replacement; `TuiApp.tsx` wires queued prompt editing and drain |
| MCP live discovery/call | Covered | `mcpDiscovery.ts` and extension tests cover `.mcp.json` lookup、plugin injection、stdio initialize/resources/tools/call、config parsing、policy/approval/signature/OAuth-required/unsupported state; real SSE/HTTP/OAuth remains Disabled-Parity external integration |
| Message windowing + scroll offset | Covered | `messageMarkdown.ts`、`windowing.ts`、`terminalApp.test.ts`、`screenSelection.ts`、`messageMeasurement.ts`、`components/ScrollBox.tsx` and `MessageList.tsx` cover markdown display cleanup、table rendering、list continuation wrapping、stream delta throttling、visible row windowing、scroll offset、viewport measurement、CJK/prewrap、sticky/tick drain and prompt visibility |
| Fullscreen screen buffer | Covered | `screenBuffer.ts`、core Screen、core DOM、ScrollBox、hitTest tests cover fixed buffers、diff/cursor/resize、typed cells、NoSelect、softWrap、wide chars、frame commit、overlay clearing、hit-test and scrollToElement; V1.6 strict TUI gate requires these Ink internals and tests to exist |
| Permission confirmation | Covered | `permissionPrompt` runtime hook、`PermissionPanel` queue、`OverlayStack` ordering、`permissionRules.ts`、`permissionQueue.ts` and settings tests cover once/session/persistent/batch decisions and scoped/MCP rules |
| Resume/Doctor/Theme/HelpV2/Settings/Trust/Wizard/Sandbox/Image Paste screens | Covered | `InfoScreen.tsx`、`ResumePicker.tsx`、`CheckpointPicker.tsx`、`ThemePicker.tsx`、`collectDoctorScreen()`、`buildHelpV2Screen()`、`collectSettingsScreen()`、`collectTrustScreen()`、`buildOnboardingScreen()`、`buildWizardScreen()`、`collectSandboxScreen()`、`buildNativeImagePasteScreen()` and command/TUI tests cover scrollable screens、preview、fork/rewind/file restore、theme preview/application、doctor model and V1.6 upstream component surfaces |

V0.4 已有共享 command module 但未达到源码完整 parity 的命令：`config`、`cost`、`diff`、`doctor`、`env`、`keybindings`、`memory`、`output-style`、`statusline`、`theme`、`usage`、`vim`、`version`。V0.4 明确未关闭的 Command modules：`effort`、`export`、`hooks`、`lang`、`plan`、`privacy-settings`、`rename`、`session`。这些仍按本台账目标版本继续推进，不得视为 V0.4 已 1:1 完整。

## CLI Flag Inventory

来源：`claude-code/src/main.tsx`。V1.0 前必须完成 flag audit，且每个 flag 至少进入一个 parity case 或 disabled-parity 测试。

| 类别 | 代表 flags | 目标版本 |
| --- | --- | --- |
| 启动和调试 | `--debug`, `--debug-to-stderr`, `--debug-file`, `--verbose`, `--bare`, `--init`, `--init-only`, `--maintenance` | V0.1-V0.4 |
| headless I/O | `-p/--print`, `--output-format`, `--input-format`, `--json-schema`, `--include-hook-events`, `--include-partial-messages`, `--replay-user-messages` | V0.2-V0.4 |
| 权限和工具 | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--allowed-tools`, `--tools`, `--disallowed-tools`, `--permission-prompt-tool`, `--permission-mode` | V0.3-V0.4 |
| prompt/context | `--system-prompt`, `--system-prompt-file`, `--append-system-prompt`, `--append-system-prompt-file`, `--add-dir`, `--file` | V0.2-V0.5 |
| prompt editing | `--vim`, `--no-vim` | V0.4 |
| session | `--continue`, `--resume`, `--fork-session`, `--session-id`, `--name`, `--no-session-persistence`, `--resume-session-at`, `--rewind-files` | V0.4 |
| model/provider | `--model`, `--effort`, `--fallback-model`, `--betas`, `--task-budget`, `--max-turns`, `--max-budget-usd`, `--workload` | V0.2-V0.9 |
| MCP/plugin/skills | `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, `--settings`, `--agents`, `--plugin-dir`, `--disable-slash-commands` | V0.3-V0.6 |
| integrations | `--ide`, `--chrome`, `--no-chrome` | V0.4-V0.9 |
| worktree/teams | `--worktree`, `--tmux`, `--agent`, `--agent-id`, `--agent-name`, `--team-name`, `--agent-color`, `--agent-type`, `--teammate-mode`, `--parent-session-id`, `--plan-mode-required` | V0.7-V0.9 |
| remote | `--sdk-url`, `--teleport`, `--remote`, `--remote-control`, `--rc`, `--channels`, `--dangerously-load-development-channels` | V0.8 |

## Commander Subcommand Inventory

来源：`claude-code/src/main.tsx` 的 Commander 注册。Command Inventory 覆盖 slash/local command modules，本节覆盖 CLI 子命令树、深层子命令、options、alias 和 exit behavior。

| 子命令树 | 目标版本 | 必须覆盖 |
| --- | --- | --- |
| `claude mcp serve` | V0.6 | debug/verbose、handler、exit behavior |
| `claude mcp add` | V0.6-V0.9 | transport、scope、headers/env、OAuth/client secret |
| `claude mcp remove <name>` | V0.6 | scope handling |
| `claude mcp list` | V0.6 | trust warning、stdio health behavior |
| `claude mcp get <name>` | V0.6 | detail output and trust behavior |
| `claude mcp add-json <name> <json>` | V0.6-V0.9 | JSON parsing、scope、client secret |
| `claude mcp add-from-claude-desktop` | V0.9 | Mac/WSL import default-state |
| `claude mcp reset-project-choices` | V0.6 | project approval reset |
| `claude server` | V0.8-V0.10 | V0.8 bridge/daemon MVP; port/host/auth/unix/workspace/session limits in V0.10 platform smoke |
| `claude open <cc-url>` | V0.8-V0.10 | V0.8 remote session resume model; direct connect headless and interactive rewrite in V0.10 |
| `claude ssh <host> [dir]` | V1.5 | remote deploy/auth proxy/local test mode; V1.5 covers loopback, SSH mock fixture, and real ssh-compatible subprocess boundary |
| `claude auth login` | V0.9-V1.0 | DeepSeek/API-key equivalent or disabled parity |
| `claude auth status` | V0.9-V1.0 | json/text output |
| `claude auth logout` | V0.9-V1.0 | auth state cleanup |
| `claude plugin validate <path>` | V0.6-V0.9 | manifest validation |
| `claude plugin list` | V0.6-V0.9 | json/available/cowork options |
| `claude plugin marketplace add/list/remove/update` | V0.9 | marketplace lifecycle |
| `claude plugin install/uninstall/enable/disable/update` | V0.6-V0.9 | scope、keep-data、alias behavior |
| `claude setup-token` | V0.9-V1.0 | equivalent auth token behavior or disabled parity |
| `claude agents` | V0.7 | setting sources |
| `claude auto-mode defaults/config/critique` | V0.9 | transcript classifier feature behavior |
| `claude autonomy status/runs/flows/flow/cancel/resume` | V0.7-V0.9 | autonomy state and flow lifecycle |
| `claude remote-control` / `claude rc` | V0.8-V0.10 | V0.8 bridge protocol fixture; real fast path/hidden help behavior in V0.10 command audit |
| `claude assistant [sessionId]` | V0.8-V0.9 | bridge session attach |

每个 Commander 子命令 Story 必须覆盖：

- help 文案和 alias。
- option parsing。
- handler dispatch。
- stdout/stderr/exit code。
- feature gate 或 hidden command 行为。
- headless/interactive fast path 差异。

## Deviation Register

| ID | 偏差 | 状态 | 允许原因 | 关闭条件 |
| --- | --- | --- | --- | --- |
| D-001 | 默认外部 provider 从 Claude 改为 `deepseek-v4-flash` | Accepted | 项目目标明确要求 | 内部 content block、tool_use、tool_result、usage、stop/error 语义必须 Claude-compatible |

除 D-001 外，当前没有允许的永久偏差。任何新增偏差都必须先写入本表，且 V1.0 不允许存在未关闭的功能偏差。

## Sprint 使用规则

- Sprint planning 必须从本文件挑选要关闭的条目。
- Story 必须引用本文件中的 source/package/feature/tool/command 条目。
- Demo 必须展示至少一个条目从 `Planned` 进入 `Covered`。
- 版本验收时，当前版本及以前的条目不得有 `RED`。
- V1.0 验收前，所有条目必须是 `Covered`、`Disabled-Parity` 或 D-001。
