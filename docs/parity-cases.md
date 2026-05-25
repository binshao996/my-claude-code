# Parity Cases

## Initial 30 Cases

| ID | Version | Area | Source Reference | Expected |
| --- | --- | --- | --- | --- |
| PC-001 | V0.1 | CLI | `claude-code/src/main.tsx` | `--version` exits 0 and prints version |
| PC-002 | V0.1 | CLI | `claude-code/src/main.tsx` | `--help` exits 0 and prints usage |
| PC-003 | V0.1 | CLI | `claude-code/src/main.tsx` | unknown option exits non-zero with `error:` prefix |
| PC-004 | V0.1 | Provider | `claude-code/packages/@ant/model-provider` | text streaming delta maps to `text_delta` |
| PC-005 | V0.1 | Provider | `claude-code/packages/@ant/model-provider` | tool-call JSON delta maps to `input_json_delta` |
| PC-006 | V0.1 | Provider | `claude-code/packages/@ant/model-provider` | usage maps to input/output tokens |
| PC-007 | V0.1 | Protocol | `claude-code/src/Tool.ts` | `tool_use` block validates id/name/input |
| PC-008 | V0.1 | Protocol | `claude-code/src/types/message.js` | transcript event is JSONL-ready |
| PC-009 | V0.2 | Headless | `claude-code/src/query.ts` | `-p` returns assistant text |
| PC-010 | V0.2 | Headless | `claude-code/src/main.tsx` | `--output-format json` returns structured result |
| PC-011 | V0.2 | Headless | `claude-code/src/main.tsx` | `--output-format stream-json` streams events |
| PC-012 | V0.2 | Transcript | `claude-code/src/cli/` | transcript appends user and assistant messages |
| PC-013 | V0.3 | Tools | `claude-code/packages/builtin-tools` | Bash permission gate runs before execution |
| PC-014 | V0.3 | Tools | `claude-code/packages/builtin-tools` | Read/Edit/Write validate file paths |
| PC-015 | V0.3 | Permissions | `claude-code/src/hooks/toolPermission` | deny result becomes tool_result error |
| PC-016 | V0.3 | Hooks | `claude-code/src/hooks` | PreToolUse can block a tool |
| PC-017 | V0.4 | TUI | `claude-code/src/components` | prompt renders and accepts input |
| PC-018 | V0.4 | Session | `claude-code/src/state` | `/resume` shows prior sessions |
| PC-019 | V0.4 | Session | `claude-code/src/main.tsx` | `--continue` resumes latest session |
| PC-020 | V0.5 | Compact | `claude-code/src/services/compact` | `/compact` preserves key context |
| PC-021 | V0.5 | Memory | `claude-code/src/memdir` | memory files enter system context |
| PC-022 | V0.5 | Budget | `claude-code/src/query` | token budget warning triggers |
| PC-023 | V0.6 | MCP | `claude-code/src/services/mcp` | stdio MCP tool appears in registry |
| PC-024 | V0.6 | Skills | `claude-code/src/skills` | local skill is discovered |
| PC-025 | V0.6 | Plugins | `claude-code/src/plugins` | plugin command is injected |
| PC-026 | V0.7 | Subagent | `claude-code/packages/builtin-tools/tools/AgentTool` | subagent has isolated context |
| PC-027 | V0.7 | Background | `claude-code/src/tasks` | background task persists state |
| PC-028 | V0.8 | Remote | `claude-code/src/remote` | remote resume roundtrip works |
| PC-029 | V0.8 | Daemon | `claude-code/src/daemon` | daemon lifecycle starts and stops |
| PC-030 | V0.9 | Feature Flags | `claude-code/scripts/defines.ts` | all feature calls are registered |
