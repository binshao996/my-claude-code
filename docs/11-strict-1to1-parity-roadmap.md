# 11. 严格 1:1 复刻路线图

本文是 `08-version-roadmap.md` 之后的新规划，用来纠正 V1.1 之后的推进方式：后续版本不再以“本地等价 shim”“默认关闭”“只登记状态”“mock 通过”为完成标准，而是按 `claude-code/` 源码行为做严格 1:1 复刻。

## 当前结论

当前仓库的 `/parity --full` 已经 pass，但它只能证明：

- feature 已登记；
- user-visible `Disabled-Parity` 已清零；
- ledger 不再含明显占位词；
- 本地等价路径都有测试。

这不等于 Claude Code 产品级 1:1。源码对比显示，当前仍存在三类硬缺口：

1. **命令面缺口**：`claude-code/src/commands` 有 114 个 command module，当前 `SLASH_COMMAND_NAMES` 只有 53 个。
2. **包/平台缺口**：`claude-code/packages` 中大量 native、browser、remote、ACP、MCP、audio 包没有真实实现。
3. **真实集成缺口**：当前不少能力曾经只停留在本地状态、占位实现、测试传输或离线行为，需要继续升级为 Claude Code 的真实 runtime 行为。

后续所有版本必须以本文件为准推进；旧文档中任何“本地等价”“shim”“mock”“disabled parity”只能作为开发中间态，不能作为版本完成态。

## 复核结论

基于 `claude-code/` 源码再次对照后，本路线图的方向是对的：先修 gate，再按 command、ecosystem、remote、TUI、platform、voice、memory、workflow 收口，比继续在旧版本里补零散 MVP 更安全。

但第一版 roadmap 仍然不够准确，原因是它只抓住了 command module 和 workspace package 两类显性差异，没有把以下源码面当成硬门禁：

- `claude-code/src/entrypoints/sdk/`、`agentSdkTypes.ts`、`sandboxTypes.ts` 等 SDK/schema 出口；
- `claude-code/src/cli/transports/`、`cli/bg/`、`cli/handlers/` 等非 slash command 入口；
- `claude-code/src/tools.ts` 和 `claude-code/packages/builtin-tools/src/tools/*` 的完整 tool inventory；
- `claude-code/src/hooks/`、`hooks/notifs/`、`hooks/toolPermission/` 的 TUI/runtime side effect；
- `claude-code/src/services/providerUsage/`、`sessionTranscript/`、`toolUseSummary/`、`tools/`、`MagicDocs/`、`PromptSuggestion/`、`tips/` 等服务；
- `claude-code/src/components/teams/`、`grove/`、`Passes/`、`ultraplan/`、`wizard/`、`sandbox/` 等 UI surface；
- `claude-code/src/migrations/`、`native-ts/`、`constants/`、`schemas/`、`types/`、`outputStyles/` 等支撑层。

因此本文件后续版本必须同时按“产品能力域”和“源码 inventory”推进。只要某个源码目录、feature、tool、command、CLI flag、SDK schema 没有明确版本和验收，最终就不能宣称 100% 1:1。

## 严格完成标准

一个能力只有同时满足以下条件，才算严格 1:1 完成：

1. **源码入口等价**：上游 `claude-code/` 中对应 command、tool、service、package、feature flag 有明确实现映射。
2. **用户行为等价**：CLI/TUI 输出、交互步骤、错误码、帮助文本、权限提示、transcript 记录和持久化副作用与 Claude Code 对齐。
3. **真实 transport 等价**：如果 Claude Code 走 HTTP、SSE、WebSocket、OAuth、SSH、native addon、browser protocol，就必须实现同类真实路径。只写本地 JSON record 不算完成。
4. **测试等价**：必须有 upstream fixture、fake server 或真实 smoke 配置入口；不能只测 happy path。
5. **gate 等价**：`/parity --strict` 必须能机器化证明 command diff、package diff、shim detector、source inventory、parity cases 均通过。
6. **文档等价**：教程必须解释从 0 到 1 如何实现该能力，不能只是实现总结。

## 当前差异基线

### 缺失 Command Modules

以下 upstream command module 当前没有同名或真实等价命令。后续版本必须逐项关闭。

```text
agents-platform
ant-trace
backfill-sessions
branch
break-cache
bridge
btw
bughunter
chrome
claim-main
color
copy
ctx_viz
debug-tool-call
desktop
effort
export
extra-usage
fast
feedback
files
fork
good-claude
heapdump
history
hooks
ide
install-github-app
install-slack-app
issue
job
lang
local-memory
local-vault
login
logout
memory-stores
mobile
mock-limits
oauth-refresh
onboarding
passes
perf-issue
pipe-status
pipes
plan
poor
pr_comments
privacy-settings
rate-limit-options
recap
release-notes
reload-plugins
remote-env
remote-setup
remoteControlServer
rename
reset-limits
review
rewind
sandbox-toggle
schedule
send
session
share
skill-learning
skill-search
skill-store
stats
stickers
summary
tag
teleport
terminalSetup
thinkback
thinkback-play
tui
upgrade
vault
workflows
```

### 缺失 Package Surfaces

`claude-code/packages` 的 package surface 当前没有被本仓库逐包真实复刻：

```text
@ant/claude-for-chrome-mcp
@ant/computer-use-input
@ant/computer-use-mcp
@ant/computer-use-swift
acp-link
agent-tools
audio-capture-napi
builtin-tools
color-diff-napi
image-processor-napi
mcp-client
modifiers-napi
remote-control-server
url-handler-napi
weixin
```

## 版本拆分原则

版本按依赖顺序推进，不按“看起来容易”乱补：

1. 先让 gate 真实，阻止 shim 继续伪装成完成。
2. 再补 command registry 和 help/alias/exit code，因为它是用户入口。
3. 再补扩展生态：auth、MCP、plugins、skills。
4. 再补 remote/bridge/ACP，因为它们依赖 auth、transport 和 daemon。
5. 再补 native/browser/IDE/voice，因为它们依赖 package/build/runtime gate。
6. 最后补高级 agent、memory、team、review、automation 场景。

## V1.2 Strict Parity Gate

目标：先修验收标准，避免之后继续“看起来 pass 但不是 1:1”。

必须实现：

- 新增 `/parity --strict`。
- command diff gate：扫描 `claude-code/src/commands/*`，要求每个 command 有同名命令或明确 alias 映射。
- package diff gate：扫描 `claude-code/packages/*`，要求每个 package 有本地 package、workspace mapping 或真实 runtime implementation。
- shim detector gate：扫描源码和 ledger，发现占位实现、测试传输、离线行为、仅状态记录、仅规划记录等只能标记为未完成。
- feature strict gate：所有 `Disabled-Parity` 在 strict mode 下都失败，即使不是 user-visible。
- parity fixture manifest：新增机器可读 `docs/strict-parity-manifest.json`，记录每个 upstream item 的实现文件、测试文件、命令、状态。
- source diff gate：扫描 `claude-code/src` 一级和二级目录，要求每个源码域都有目标版本、实现映射和验收。
- tool diff gate：扫描 `claude-code/packages/builtin-tools/src/tools/*` 和 `claude-code/src/tools.ts`，要求每个 tool 有同名实现、等价输入 schema、权限、UI、结果格式和测试。
- feature diff gate：扫描所有 `feature('...')` 调用，要求每个 feature 有默认状态、runtime 状态、目标版本和 strict 验收。
- entrypoint gate：覆盖 `entrypoints/cli.tsx`、`entrypoints/mcp.ts`、`entrypoints/sdk/*`、agent SDK types、sandbox types。
- CLI transport gate：覆盖 `cli/print.ts`、`structuredIO.ts`、`remoteIO.ts`、`transports/SSETransport.ts`、`WebSocketTransport.ts`、`HybridTransport.ts`、`bg/*`。
- schema/type gate：覆盖 `src/types/`、`src/schemas/`、SDK generated/runtime/control schemas，禁止只靠 TypeScript 编译通过。

拒收项：

- 只改 ledger 让 gate pass。
- 把 private service 写成“不可实现”。
- 只保留 mock，没有真实 transport。
- 只扫目录名，不扫 feature/tool/entrypoint/schema 细项。

验收：

```bash
bun run cli -- /parity --strict
bun run test packages/commands/src/hardening.test.ts packages/core/src/protocol.test.ts
bun run lint
bun run typecheck
```

## V1.3 Command Surface 1:1

目标：关闭 114 个 upstream command module 的入口差异。

必须实现：

- 所有 upstream command module 都能在本地 command registry 中找到同名命令或源码声明的 alias。
- 每个 command 都有：
  - help text；
  - argument parsing；
  - interactive path；
  - noninteractive path，如果 upstream 存在；
  - exit code；
  - error text；
  - permission/auth gating。
- 命令按 upstream 分组补齐：
  - session/history：`history`、`session`、`fork`、`rewind`、`rename`、`summary`、`recap`；
  - config/debug：`debug-tool-call`、`break-cache`、`mock-limits`、`reset-limits`、`extra-usage`、`stats`；
  - workflow/review：`branch`、`job`、`review`、`schedule`、`files`、`issue`、`pr_comments`；
  - shell/UI：`copy`、`color`、`lang`、`privacy-settings`、`terminalSetup`、`tui`；
  - platform：`chrome`、`desktop`、`mobile`、`ide`、`install-github-app`、`install-slack-app`。
- 同步覆盖 `claude-code/src/commands.ts` 的动态注入路径：
  - bundled skills commands；
  - local skill directory commands；
  - plugin commands；
  - workflow commands；
  - feature-gated commands；
  - noninteractive command variants。
- 同步覆盖非 slash CLI command：
  - `entrypoints/cli.tsx` 里的 `daemon`、`job`、`new`、`list`、`reply`、`environment-runner`、`self-hosted-runner`、`--acp`、`--computer-use-mcp`；
  - `cli/handlers/*` 里的 agents、auth、auto mode、MCP、plugins、template jobs、autonomy、ant handlers。

拒收项：

- 用 `/remote`、`/tasks` 等聚合命令代替 upstream command，除非 upstream 本身就是 alias。
- 输出 JSON 但 upstream 是人类可读文本，或反过来。
- 只补 `SLASH_COMMAND_NAMES`，但不补 `commands.ts` 的可用性判断、feature gate、dynamic command merge。

验收：

```bash
bun run cli -- /parity --strict --commands
bun test packages/commands/src
```

## V1.4 Auth, MCP, Plugins, Skills 1:1

目标：关闭扩展生态缺口。

必须实现：

- Auth：
  - `login`、`logout`、`oauth-refresh`；
  - workspace key / API key gating；
  - token storage、refresh、过期错误路径；
  - no-secret logging。
- Provider ecosystem：
  - `services/api/*`；
  - `services/providerRegistry/*`；
  - `services/providerUsage/*`；
  - model aliases、capabilities、rate limit、balance、usage aggregation；
  - Anthropic-compatible request/stream/error/cache semantics，除了已批准的 model provider 替换偏差。
- MCP：
  - stdio、HTTP、SSE、WebSocket transport；
  - OAuth flow；
  - approval/policy；
  - resource subscriptions；
  - MCP tool rich output；
  - MCP `skill://` resources。
- Plugins：
  - install；
  - update；
  - enable/disable；
  - reload；
  - local store；
  - marketplace-like index；
  - plugin-provided MCP server lifecycle。
- Skills：
  - `skill-store`；
  - `skill-search`；
  - `skill-learning`；
  - ranking/cache；
  - generation lifecycle；
  - conflict resolution。
- Settings/policy：
  - managed settings；
  - remote managed settings；
  - settings sync upload/download；
  - policy limits；
  - privacy settings；
  - plugin/user/project/local source priority。
- Search-extra-tools：
  - `services/searchExtraTools/*`；
  - deferred tool ranking；
  - `SearchExtraTools` 和 `ExecuteTool` 的 prompt、schema、permission、cache 语义。

拒收项：

- 只读取本地 `.mcp.json`。
- 只读取本地 markdown skill。
- 只把 plugin command 当 deferred text。
- 只实现 provider happy path，不实现 usage、rate limit、balance、cache break 和错误恢复。

验收：

```bash
bun run cli -- /parity --strict --ecosystem
bun test packages/tools/src/extensions.test.ts packages/tui/src/mcpDiscovery.test.ts
```

## V1.5 Remote, Bridge, ACP, Daemon 1:1

目标：把本地状态和测试 SSH 传输升级为真实 remote runtime。

必须实现：

- `remote-control-server` package；
- daemon worker lifecycle；
- direct connect server；
- URL handler；
- WebSocket bridge；
- SSE transport；
- Hybrid transport；
- serial batch event uploader；
- worker state uploader；
- UDS inbox；
- ACP link package；
- real SSH transport；
- tmux/detached background engines；
- CLI background mode；
- remote control server web assets；
- remote env；
- teleport；
- pipes / pipe-status / claim-main / bridge-kick / send；
- peers / attach / detach / history；
- CCR mirror；
- CCR auto connect；
- LAN pipes；
- reconnection；
- auth failure；
- heartbeat；
- transcript and file persistence across remote boundary。

拒收项：

- 把测试 SSH 传输当作 SSH 完成。
- 只写 bridge JSONL。
- 只登记 `tcp://host:port` 但不监听、不连接。
- 只实现 slash command，不实现 `cli/transports/*` 和 `cli/bg/*`。

验收：

```bash
bun run cli -- /parity --strict --remote
bun test ./packages/remote-control-server/src ./packages/tools/src/remote.test.ts ./packages/tools/src/ecosystem.test.ts ./packages/commands/src/slashCommands.test.ts
```

实现状态：

- `packages/remote-control-server/src/index.ts` 已提供独立 remote-control server runtime：`/health`、`/sessions`、`/events/stream`、`/worker/events/stream`、`/events`、`/worker/events`，SSE 客户端会收到 bridge frame，POST ingress 只保存 body hash，不持久化请求原文。
- `packages/tools/src/remote.ts` 已把 V0.8 的本地记录升级为 V1.5 runtime：真实 HTTP/SSE remote-control server 适配层、daemon heartbeat/reconnect/lock、bridge kick、remote env hash store、真实 ssh-compatible subprocess transport、loopback/SSH mock 兼容路径、真实 local TCP LAN pipe、真实 UDS inbox、pipe message persistence 和 transcript redaction。
- `packages/tools/src/ecosystem.ts` 已把 ACP 从“链接记录”升级为 JSONL runtime：`AcpLink` 创建 inbox/outbox 队列，`AcpSend` 写入 client/server 消息队列，`/acp send` 可从命令面验证。
- `packages/commands/src/slashCommands.ts` 已接入 `/daemon heartbeat`、`/remote ssh` 真实 SSH 参数、`/remote env`、`/remote bridge-kick`、`/remote uds-start`、`/remote uds-send`、`/remote-env`、`/bridge-kick`、`/teleport`、`/acp send` 的本地运行时行为。
- `packages/remote-control-server/src/index.test.ts`、`packages/tools/src/remote.test.ts`、`packages/tools/src/ecosystem.test.ts` 和 `packages/commands/src/slashCommands.test.ts` 覆盖真实 SSH 子进程边界、HTTP/SSE bridge、worker POST ingress、local TCP LAN pipe socket、UDS inbox socket、ACP JSONL queue、remote env redaction、daemon reconnect、slash command 面。

## V1.6 TUI, Ink, Native Terminal 1:1

目标：从“行为近似”升级到 renderer/runtime 真实等价。

必须实现：

- `@ant/ink` / local `@anthropic/ink` reconciler internals；
- Yoga layout parity；
- overlay stack；
- hit-test；
- selection；
- ScrollBox tick drain；
- mouse/keyboard parity；
- theme provider；
- permission modal；
- setup/trust/onboarding dialogs；
- structured diff；
- native clipboard/image paste；
- terminal shell integration；
- color-diff/image/modifier native packages。
- `components/*` 全 UI surface：
  - HelpV2；
  - Settings；
  - ManagedSettingsSecurityDialog；
  - FeedbackSurvey；
  - LspRecommendation；
  - ClaudeCodeHint；
  - DesktopUpsell；
  - Passes；
  - teams；
  - grove；
  - wizard；
  - sandbox；
  - messages；
  - skills；
  - tasks；
  - ultraplan；
  - shell。
- `hooks/*` runtime behavior：
  - paste/image/clipboard；
  - history search；
  - virtual scroll；
  - command queue；
  - IDE status；
  - settings/plugin/skills change；
  - diff in IDE；
  - deferred hook messages；
  - prompt suggestions；
  - task watcher；
  - bridge/pipe/remote/SSH hooks；
  - notification hooks。
- keybindings、vim、output styles、theme/color、privacy/settings UI 需要与 upstream snapshot 对齐。

拒收项：

- 只用 screen buffer fixture 代替真实 reconciler。
- 只测非 TTY fallback。
- 只覆盖 PromptInput/MessageList，不覆盖 settings、help、permissions、notification、dialog、wizard 等 TUI surface。

验收：

```bash
bun run cli -- /parity --strict --tui
bun test packages/anthropic-ink/src packages/tui/src
```

实现状态：

- `packages/cli/src/program.ts` 已支持 `--tui` 并转发到 `/parity --strict --tui`，V1.6 不再只依赖普通 strict gate。
- `packages/commands/src/hardening.ts` 已新增 TUI 专项 strict checks：`strict TUI Ink internals`、`strict TUI component surface`、`strict TUI upstream surface`、`strict TUI runtime tests`，覆盖 local `@anthropic/ink` renderer/screen/DOM/ScrollBox/theme/NoSelect、TUI app shell/status/message/prompt/permission/overlay/picker surface、HelpV2/settings/trust/onboarding/wizard/sandbox/native image paste routing，以及 TTY launch、prompt editing、permission、selection、ScrollBox、renderer DOM、theme 测试文件。
- `packages/tui/src/components/StatusLine.tsx` 已升级交互首屏状态栏，展示产品名、session、model、permission、status、token budget、cache；`bun run cli` TTY 首屏不再只有 readline 风格文本。
- `packages/tui/src/components/OverlayStack.tsx` 和 `packages/tui/src/TuiApp.tsx` 已把 permission、command screen、resume/checkpoint/theme picker、HelpV2、settings、trust/onboarding、wizard、sandbox、native image paste 纳入统一 overlay stack。
- `packages/core/src/protocol.ts`、`packages/tui/src/clipboard.ts` 已补 image content block schema、macOS/Linux/Windows native image clipboard adapter 和可注入测试路径；`/paste-image` 在 TUI 中读取 OS clipboard image 后放入 `@image:clipboard` prompt token，失败时展示结构化诊断 screen。
- `packages/tui/src/terminalApp.test.ts`、`packages/tui/src/clipboard.test.ts`、`packages/commands/src/screens.test.ts`、`packages/commands/src/slashCommands.test.ts`、`packages/cli/src/program.test.ts` 已覆盖 TTY 首屏、V1.6 overlay surfaces、native image clipboard adapter、`/parity --strict --tui` 和 CLI flag 透传。

## V1.7 Browser, Computer Use, IDE, Platform Apps 1:1

目标：关闭真实平台集成。

必须实现：

- Chrome MCP package；
- computer-use MCP；
- computer-use input；
- Swift computer-use package；
- browser session lifecycle；
- screenshots and input events；
- IDE/LSP integration；
- `services/lsp/*`；
- `LSPTool`；
- IDE selection、IDE diff、IDE status、IDE logging hooks；
- MagicDocs；
- PromptSuggestion；
- Claude-in-Chrome prompt import；
- desktop command；
- mobile command；
- install GitHub app；
- install Slack app；
- Weixin package parity，如果 upstream 暴露用户入口。

拒收项：

- `WebBrowser` 只 fetch HTML 文本。
- 只提供 command placeholder。
- 只实现 LSP command，不实现 tool、hook、recommendation UI 和 diagnostics。

验收：

```bash
bun run cli -- /parity --strict --platform
bun test packages/tools/src packages/commands/src packages/tui/src
```

实现状态：

- `packages/tools/src/tools/webBrowser.ts` 已从 fetch-only 升级为 stateful browser session runtime：会话、history、viewport、`state`、`back/forward`、`click/type/key/scroll` input events、SVG screenshot artifact、localhost/private host permission gate。
- `packages/tools/src/tools/computerUse.ts` 已新增 `ComputerUse` 和 `ComputerUseInput`，对齐 computer-use MCP/input/Swift package surface，并复用 browser session 事件流。
- `packages/tools/src/services/lsp/*` 已补 IDE diagnostics、selection/diff、logging hooks；`LSP` tool 继续提供 definition/reference/symbol/hover/call hierarchy。
- `/chrome`、`/desktop`、`/mobile`、`/install-github-app`、`/install-slack-app`、`/ide` 已改为 command-specific local runtime surface；`/ide` 显式暴露 selection、diff、status、logging hooks、MagicDocs、PromptSuggestion。
- Weixin package 用户入口已补：`/weixin serve` 与 `bun run cli -- weixin serve` 注册 builtin `plugin:weixin@builtin` channel，暴露 `plugin:weixin:weixin` MCP server metadata、`reply`/`send_typing` tools、login/access pair 状态，且不持久化 raw secrets。
- `packages/commands/src/hardening.ts` 已新增 V1.7 `--platform` strict gate：browser runtime、computer-use runtime、IDE/LSP runtime、platform command surface、runtime tests。

## V1.8 Voice, Audio, Notifications 1:1

目标：关闭 voice 和 native audio 缺口。

必须实现：

- `audio-capture-napi`；
- push-to-talk；
- voice prompt indicator；
- STT service integration；
- audio permission errors；
- device unavailable errors；
- push notification transport；
- user-visible notification lifecycle。
- `hooks/notifs/*` 全量覆盖：
  - startup；
  - settings errors；
  - MCP connectivity；
  - plugin install/autoupdate；
  - rate limit；
  - model migration；
  - npm deprecation；
  - update；
  - teammate shutdown；
  - IDE/LSP initialization；
  - fast mode；
  - subscription switch；
  - Chrome extension；
  - official marketplace recommendation。
- local notification config、permission fallback、Bridge/Kairos push notification path 都必须有真实行为。

拒收项：

- 本地占位实现。
- 只记录 voice enabled 状态。
- 只 queue push notification JSON。
- 只测 voice command，不测 REPL keybinding、footer indicator、audio lifecycle 和 OS notification edge cases。

验收：

```bash
bun run cli -- /parity --strict --voice
bun test packages/commands/src packages/tui/src
```

实现状态：

- `packages/audio-capture-napi` 已补本地 package surface：优先加载 `AUDIO_CAPTURE_NODE_PATH`，再查找 `vendor/audio-capture/<arch-platform>/audio-capture.node` 和 `claude-code/vendor/audio-capture/...`，缺失时返回明确 unavailable。
- `packages/tools/src/services/voice/audio.ts` 已实现 voice preflight、native/arecord/SoX backend 检测、麦克风权限状态、push-to-talk recording start/stop、active recording 列表，以及 Anthropic/Doubao STT endpoint/auth 状态检查；DeepSeek chat key 会被识别为文本模型凭据，但因官方 API 无 STT endpoint，会返回明确 unavailable 原因。
- `packages/tools/src/services/voice/stream.ts` 已实现真实 STT WebSocket adapter：带 endpoint/auth preflight、binary audio frame、`KeepAlive`、`CloseStream`、`TranscriptText`、`TranscriptEndpoint`、server error 和 finalize timeout；测试通过可注入 WebSocket factory 验证，不需要外部凭据。
- `packages/tools/src/ecosystem.ts` 已把 `VoiceModeSet/State` 从本地 stub 升级为带 microphone/STT availability 的 runtime，并新增 `VoiceCheck`、`VoiceRecordingStart`、`VoiceRecordingStop`、`VoiceRecordingList` tools。
- `packages/tools/src/services/notifications.ts` 和 `packages/tools/src/workflows.ts` 已把 `PushNotification` 从纯 JSON queue 升级为 OS notification dispatch：macOS `osascript`、Linux `notify-send`、Windows PowerShell；持久化记录包含 transport、status 和 body hash，并覆盖 `hooks/notifs/*` 生命周期、去重折叠和过期。
- `/voice check|on|off|start|stop` 和 `/parity --strict --voice` 已接入 CLI/slash command；TUI header/footer 会显示 voice 状态，`PromptInput` 提供 voice shortcut 入口；`MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS=1` 可用于测试禁用系统弹窗。
- `tech-docs/v1.8-voice-audio-notifications.md` 已按教程格式说明 native audio、preflight、push-to-talk、STT 和 notification lifecycle 的实现方法。

## V1.9 Memory, Context, Vault, Team 1:1

目标：关闭高级上下文和记忆系统。

必须实现：

- context collapse；
- history snip；
- local memory；
- local vault；
- memory stores；
- team memory；
- team memory sync；
- extract memories；
- agent memory snapshot；
- session memory；
- relevance ranking；
- cache invalidation；
- provider cache break parity。
- `memdir/*`；
- `services/AgentSummary/*`；
- `services/sessionTranscript/*`；
- `services/toolUseSummary/*`；
- `services/tips/*`；
- `history.ts` 的 prompt history、large paste、image refs；
- `cost-tracker.ts`、`costHook.ts`、`services/providerUsage/*` 的 usage/cost/balance 恢复；
- `context.ts` 的 system context、break-cache injection、connector text、lodestone、team context。

拒收项：

- 只读 CLAUDE.md。
- 只做简单关键词匹配。
- 把 team memory 永久 disabled。
- 只实现 compact，不实现 transcript/session/memory/cost/provider usage 的恢复链路。

验收：

```bash
bun run cli -- /parity --strict --memory
bun test packages/session/src packages/agent-runtime/src packages/commands/src
```

实现状态：

- `packages/tools/src/services/memory.ts` 已新增 V1.9 memory runtime：local memory store 扫描、relevance ranking、`memory-cache.json`、memory extraction、agent memory snapshot、session memory snapshot、team memory sync。
- `packages/agent-runtime/src/context.ts` 已把 ranked local memory、session memory、team context、provider cache breaks 和 context collapse marker 注入 sectioned system context；query runtime 会传入 `sessionId`。
- `packages/tools/src/tools/memoryParity.ts` 已新增 `MemoryRank`、`ExtractMemories`、`AgentMemorySnapshot`、`SessionMemorySnapshot`、`TeamMemorySync` tools；`CtxInspect` 暴露 context collapse、memory ranking 和 provider cache-break capability。
- `/memory rank|extract|sync-team`、`/vault`/`/local-vault` secret-safe key listing、`/parity --strict --memory` 已接入 command surface；CLI 支持 `--memory` parity flag。
- `VaultHttpFetch` 仍只从 `MY_CLAUDE_CODE_VAULT_*` 环境变量读 secret，并只输出 key name、hash/脱敏结果，不持久化 raw secret。
- `tech-docs/v1.9-memory-context-vault-team.md` 已补从 0 到 1 教程。

## V2.0 Agent Workflow And Review 1:1

目标：关闭高级 agent 工作流、review、automation 和诊断命令。

必须实现：

- verification agent；
- message actions；
- review artifact；
- agents platform；
- coordinator/swarm 真实调度；
- jobs classifier；
- schedule/cron；
- proactive/Kairos 真调度；
- autofix PR 真 mutation；
- issue/pr_comments；
- security review；
- thinkback/thinkback-play；
- bughunter/good-claude/perf-issue；
- release-notes/tag/share/stickers/feedback；
- heapdump/ant-trace/ctx_viz/debug-tool-call。
- Builtin tools workflow inventory：
  - `AgentTool`；
  - `TaskCreate/Get/Update/List/Output/Stop`；
  - `VerifyPlanExecutionTool`；
  - `ReviewArtifactTool`；
  - `WorkflowTool`；
  - `MonitorTool`；
  - `ScheduleCronTool`；
  - `SleepTool`；
  - `BriefTool`；
  - `SendMessageTool`；
  - `ListPeersTool`；
  - `TeamCreate/DeleteTool`；
  - `SuggestBackgroundPRTool`；
  - `SubscribePRTool`。
- Runtime services：
  - `tasks/*`；
  - `jobs/*`；
  - `proactive/*`；
  - `coordinator/*`；
  - `assistant/*`；
  - `buddy/*`；
  - `environment-runner/*`；
  - `self-hosted-runner/*`；
  - autonomy/advisor/provider command behavior。

拒收项：

- 只创建 plan record。
- 只创建 local buddy session。
- 只保存 review text。
- 只实现 task CRUD，不实现 agent/subagent runtime、permission forwarding、transcript、scheduler、background worker 和 review artifact mutation。

验收：

```bash
bun run cli -- /parity --strict --agent-workflows
bun test packages/tools/src packages/commands/src packages/agent-runtime/src
```

实现状态：

- `packages/tools/src/services/agentWorkflows.ts` 已补 V2.0 workflow runtime：message actions、verification agent 三阶段 worker transcript、review artifact mutation/backup、job classifier、cron-style schedule/run-due、workflow diagnostic/review event store。
- `packages/tools/src/tools/agentWorkflows.ts` 已注册 `MessageAction`、`VerificationAgent`、`ReviewArtifactMutation`、`JobClassify`、`ScheduleCron`、`ScheduleCronRunDue`、`ScheduleCronList`、`WorkflowEvent`、`AgentWorkflowState`；既有 `ReviewArtifact` 现在也会写 review artifact 索引。
- `packages/commands/src/slashCommands.ts` 已接入 `/message-action`、`/schedule`、`/job`，并把 `/review`、`/security-review`、`/issue`、`/pr-comments`、`/think-back`、`/thinkback-play`、`/bughunter`、`/good-claude`、`/perf-issue`、`/release-notes`、`/tag`、`/share`、`/stickers`、`/feedback`、`/ant-trace`、`/heapdump`、`/ctx_viz`、`/debug-tool-call` 从 V1.3 surface 升级为 V2.0 local runtime event。
- `packages/commands/src/hardening.ts` 已新增 `/parity --strict --agent-workflows` 专项 gate，覆盖 runtime、command surface、tool surface 和测试文件。
- `packages/tools/src/services/agentWorkflows.test.ts`、`packages/tools/src/runner.test.ts`、`packages/commands/src/slashCommands.test.ts` 覆盖 V2.0 service、tool runner 和 slash command strict focus。

## V2.1 Source Inventory Closure 1:1

目标：关闭所有没有自然落入 V1.2-V2.0 产品域的源码项。V2.1 是最终兜底版本，不允许继续把缺口推到“后续”。

必须实现：

- `constants/*`；
- `types/*`；
- `schemas/*`；
- `bootstrap/*`；
- `setup.ts`；
- `projectOnboardingState.ts`；
- `dialogLaunchers.tsx`；
- `interactiveHelpers.tsx`；
- `replLauncher.tsx`；
- `native-ts/*`；
- `migrations/*`；
- `outputStyles/*`；
- `keybindings/*`；
- `utils/*` 中所有被 upstream runtime 使用的 filesystem、git、shell、format、perf、安全、auth、model helper；
- `services/analytics/*`、`diagnosticTracking`、`internalLogging`、`langfuse/*`、Perfetto tracing；
- `services/tools/*` 的 tool service glue；
- `src/__tests__` 中能转化为本地 golden parity case 的全部 fixture。

必须补齐的机器 gate：

- source inventory diff 为 0；
- command inventory diff 为 0；
- tool inventory diff 为 0；
- package inventory diff 为 0；
- feature inventory diff 为 0；
- CLI flag/subcommand diff 为 0；
- SDK schema diff 为 0；
- TUI component/hook inventory diff 为 0；
- service inventory diff 为 0；
- native package build smoke diff 为 0；
- upstream reusable fixture 映射覆盖率 100%。

拒收项：

- 用“未暴露给用户”跳过源码域。1:1 复刻要求内部 runtime 行为也等价。
- 用“测试不需要”跳过 upstream fixture。
- 把无法联网、无法 OAuth、无法 native build 的路径标记为 Covered。

验收：

```bash
bun run cli -- /parity --strict --source-inventory
bun run test
bun run lint
bun run typecheck
bun run build
```

实现状态：

- `packages/core/src/sourceInventory.ts` 已新增 V2.1 source inventory closure service，把 support、service、native、fixture 四类域整理成机器可读 domain，并逐项校验 upstream 路径、strict manifest 映射、本地实现文件和关键 runtime 证据。
- `docs/strict-parity-manifest.json` 已补齐 `services/analytics`、`diagnosticTracking`、`internalLogging`、`langfuse`、Perfetto、`services/tools`、root test fixture 等 V2.1 显式映射。
- `packages/commands/src/hardening.ts` 已接入 `/parity --strict --source-inventory`，新增 V2.1 source closure、service inventory、native package smoke、fixture inventory 四个 gate。
- `packages/cli/src/program.ts` 和 `packages/commands/src/slashCommands.ts` 已支持 `--source-inventory` flag 透传与 focus 解析。
- `packages/core/src/sourceInventory.test.ts` 和 `packages/commands/src/slashCommands.test.ts` 覆盖 V2.1 inventory service、分类查询、失败检测和 slash command gate。

## 最终验收：Claude Code 1:1

V2.1 才允许声明 1:1 完美复刻。最终验收必须全部通过：

```bash
bun run test
bun run lint
bun run typecheck
bun run build
bun run cli -- /parity --strict
```

并额外满足：

- upstream command diff 为 0；
- upstream package diff 为 0；
- upstream source diff 为 0；
- upstream tool diff 为 0；
- upstream feature diff 为 0；
- upstream SDK/schema diff 为 0；
- upstream CLI transport/handler diff 为 0；
- upstream component/hook/service diff 为 0；
- `Disabled-Parity` 为 0；
- shim detector 为 0；
- 真实 transport smoke 全部通过；
- 50 个真实工程任务对照 Claude Code 输出、权限、工具、transcript、恢复行为一致；
- 教程文档覆盖每个新能力从 0 到 1 的实现方法。

## 执行顺序摘要

| 版本 | 优先级 | 主目标 | 不可接受完成方式 |
| --- | --- | --- | --- |
| V1.2 | P0 | strict gate、inventory、shim detector | 只改 ledger |
| V1.3 | P0 | 114 个 command module 入口等价 | 聚合命令替代 upstream command |
| V1.4 | P0 | Auth/MCP/Plugins/Skills 真实生态 | 只读本地文件 |
| V1.5 | P0 | Remote/Bridge/ACP/Daemon 真实 transport | 测试 SSH 传输、只登记 endpoint、无 socket |
| V1.6 | P1 | TUI/Ink/native terminal internals | screen fixture-only |
| V1.7 | P1 | Browser/computer-use/IDE/platform app | HTML fetch-only |
| V1.8 | P1 | Voice/audio/notifications | 本地占位实现 |
| V1.9 | P1 | Memory/context/vault/team | CLAUDE.md-only |
| V2.0 | P0 | Agent workflow/review/automation 全闭环 | plan record-only |
| V2.1 | P0 | source inventory 全量清零和 golden parity | “未暴露给用户”跳过内部源码 |
