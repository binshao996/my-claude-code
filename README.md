# my-claude-code

V1.0 hardening is in progress from `docs/08-version-roadmap.md`, adding release health and parity gates on top of the implemented agent/runtime surfaces:

- Bun/TypeScript monorepo skeleton.
- Claude-compatible core protocol schemas.
- DeepSeek/OpenAI-compatible streaming event parser.
- Commander-based CLI fast paths for `--help` and `--version`.
- Headless `-p/--print` streaming mode.
- Query loop terminal states and transcript JSONL append.
- Builtin tools: `Read`, `Glob`, `Grep`, `TodoWrite`, `Edit`, `Write`, `Bash`.
- Headless permission modes for tool execution.
- Settings MVP for model, permission mode, allowed tools, disallowed tools, theme, and Vim prompt mode.
- Session index and transcript replay for `--continue` / `--resume`.
- V0.4 slash commands: `/add-dir`, `/help`, `/clear`, `/compact`, `/config`, `/context`, `/cost`, `/diff`, `/doctor`, `/env`, `/keybindings`, `/memory`, `/model`, `/output-style`, `/resume`, `/status`, `/statusline`, `/theme`, `/usage`, `/permissions`, `/vim`, `/version`, `/exit`.
- React/Ink TTY app now imports through the local `@anthropic/ink` compatibility workspace, with renderer option normalization, screen buffer diff/cursor/resize helpers, typed core screen cells for style/noSelect/softWrap/wide-char spacer/blit/shift extraction, renderer DOM registry/frame commit paint order/overlay rect clearing/hit-test bubbling helpers, component-level `NoSelect`, ScrollBox `scrollToElement`, guarded message measurement with streaming cache invalidation, terminal resize reflow, terminal control-sequence input filtering, raw DEL/Ctrl+H backspace handling, cursor-aware prompt input, selectable slash/file/live-MCP-resource/agent/queued-command/prompt-suggestion/platform completion menu with descriptions, Ctrl+R history search with repeat cycling, readline-style editing shortcuts, Vim insert/normal prompt mode, Shift+Arrow and SGR mouse prompt selection, screen-level message/prompt selection copy with NoSelect decoration filtering and hit-test clamping, selected-text clipboard copy with failure feedback, status line, message ScrollBox compatibility boundary with Ink stdout viewport measurement, overscan/pendingDelta/sticky scroll/tick-drain semantics, measured Ink/Yoga row heights, CJK-aware width wrap fallback, prewrapped and clipped message rows to avoid terminal auto-wrap repaint residue, tool progress, queued prompt editing/drain, queued scoped permission confirmation, and optional persistent permission rules.
- Doctor screen model with cwd/runtime/install/package-manager/ripgrep/settings source validation/permission rule coverage/context files/MCP config/API-key/provider-env/git/session graph/file-snapshot store/tool-registry checks.
- Resume picker with local filter, selected-session preview, provider-message graph hydration after compact boundaries, structured compact metadata, prompt-state cache-break diagnostics, restore-plan lineage/snapshot coverage, fork, checkpoint rewind, and text/binary/directory/symlink/mode-aware file snapshot restore with Git worktree conflict reporting.
- Theme command persistence through `/theme default|dark|light|auto`, plus an interactive ThemePicker backed by a global ThemeProvider with structured palette preview, auto theme detection hints, and live palette preview across TUI status/messages/overlays.
- Line-oriented non-TTY fallback that reuses the same `query()` runtime.
- Shared command runtime so headless and interactive slash commands stay aligned.
- V0.5 context runtime builds sectioned system context with current date, git status snapshot, `CLAUDE.md` discovery, project memory files, relevant memory snippets, resume context, and additional directories.
- V0.5 compact applies conservative auto compact boundaries before provider requests, supports injectable compact summarizers, retries once after context overflow with reactive compact, and enforces tool result budgets by truncating large results and persisting full payloads under `.my-claude-code/tool-results`.
- `/context` now reports runtime context sections/memory/git budget details, and `/compact` writes a structured compact boundary transcript record while reporting compact candidates alongside session summary.
- V0.6 extension registry discovers `.mcp.json` stdio MCP servers, `.claude/skills` markdown skills, local plugin manifests, plugin skills, plugin MCP servers, and plugin commands.
- V0.6 runtime exposes MCP tools as normal local `Tool` adapters, adds `Skill`, `ListMcpResources`, `ReadMcpResource`, `SearchExtraTools`, and `ExecuteTool`, and routes deferred plugin commands through the same permission/tool-result path.
- V0.6 slash surfaces include `/mcp`, `/skills`, and `/plugin run <plugin> <command>` for local discovery and smoke testing.
- V0.7 workflow tools add `Agent`, `TaskCreate/Update/List/Get/Output/Stop`, `BackgroundStart/List/Output/Stop`, and `EnterWorktree/ExitWorktree/WorktreeStatus`, with persistent local task/background/agent/worktree state.
- V0.7 slash surfaces include `/agents`, `/tasks`, `/background`, and `/worktree` for local workflow discovery and smoke testing.
- V0.8 remote tools add `DaemonStart/Status/Stop`, `RemoteConnect/Run/Detach/Resume`, `RemoteTriggerTool`, `ListPeersTool`, and `TerminalCaptureTool`, with daemon lifecycle state, bridge JSONL events, loopback execution, SSH mock execution, remote transcript capture, dangerous-command guards, path isolation, and token redaction.
- V0.8 slash surfaces include `/daemon`, `/remote`, `/attach`, `/detach`, and `/peers` for local remote-control smoke testing.
- V0.9 feature flag closure adds a typed feature matrix, upstream `DEFAULT_BUILD_FEATURES` inventory, disabled/non-default feature inventory, vendored source `feature('...')` scan tests, secret-safe runtime defaults, env opt-in parsing, and `/features` for user-visible feature gate status.
- V1.0 hardening adds `/health` and `/parity` reports for coverage-ledger release blockers, feature matrix audit, bundle integrity, production smoke, doctor health, tool/slash registries, and secret-safe reporting.

## Commands

```sh
bun install
bun run typecheck
bun run test
bun run build
bun run cli -- --help
bun run cli -- -p "解释 README.md" --output-format json
bun run cli -- -p "解释 README.md" --output-format stream-json --include-partial-messages
bun run cli -- -p "解释 README.md" --system-prompt "custom system" --append-system-prompt "extra rules"
bun run cli -- -p "解释 README.md" --system-prompt-file ./system.txt --append-system-prompt-file ./append.txt
bun run cli -- --compatibility-spike-live
bun run cli -- -p "解释当前目录"
bun run cli -- -p "读取 README.md 并总结"
bun run cli -- -p "创建 hello.txt" --permission-mode acceptEdits
bun run cli -- -p "继续解释刚才的结果" --continue
bun run cli -- -p "读取共享目录" --add-dir "../shared"
bun run cli -- /help
bun run cli -- /agents
bun run cli -- /background
bun run cli -- /status
bun run cli -- /keybindings
bun run cli -- /config
bun run cli -- /env
bun run cli -- /features
bun run cli -- /health
bun run cli -- /parity
bun run cli -- /diff
bun run cli -- /memory
bun run cli -- /mcp
bun run cli -- /skills
bun run cli -- /plugin
bun run cli -- /plugin run <plugin> <command>
bun run cli -- /output-style
bun run cli -- /version
bun run cli -- /vim on
bun run cli -- /doctor
bun run cli -- /theme auto
bun run cli -- /context
bun run cli -- /tasks
bun run cli -- /tasks create "write V0.7 docs"
bun run cli -- /worktree
bun run cli -- /worktree enter ../feature-worktree feature/v07
bun run cli -- /daemon start
bun run cli -- /daemon status
bun run cli -- /remote connect local .
bun run cli -- /remote ssh fixture.example .
bun run cli -- /remote run <remoteSessionId> node -e 'console.log("remote-ready")'
bun run cli -- /remote detach <remoteSessionId>
bun run cli -- /attach <remoteSessionId>
bun run cli -- /peers
bun run cli -- /resume
bun run cli -- /resume <sessionId> --checkpoints
bun run cli -- /resume <sessionId> --fork
bun run cli -- /resume <sessionId> --rewind <recordId>
bun run cli -- /resume <sessionId> --rewind-files <recordId>
bun run cli -- /permissions --allowed-tools "Read,Write(README.md)" --disallowed-tools "Bash"
```

In headless mode, file edits are denied by default. Use
`--permission-mode acceptEdits` for edit/write tasks during development.

Running `bun run cli` without `-p` starts the React/Ink TUI when stdin/stdout
are TTYs. Piped input falls back to the line shell for scriptable smoke tests.
Full Claude Code TUI parity is still tracked in the source coverage ledger.

In the TUI permission panel, `y/n` applies only to the current tool call,
`s/d` applies to the current TUI session, and `p/x` persists the scoped rule to
`.my-claude-code/settings.json`. Scoped rules look like `Write(path)` or
`Bash(command)`. When multiple permission requests are queued, `A/D` applies a
session decision to all queued requests and `P/X` persists all queued rules.

The only target provider for the product is `deepseek-v4-flash`. The live
compatibility spike reads `DEEPSEEK_API_KEY` from the environment and never
prints the key.

For local development, put `DEEPSEEK_API_KEY` in `.env`. In production, set it
as a system environment variable instead; `.env` is ignored when
`NODE_ENV=production`.
