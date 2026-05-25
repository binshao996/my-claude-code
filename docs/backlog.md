# Backlog

## V0.1 Committed

| ID | Track | Story | Source Reference | Acceptance |
| --- | --- | --- | --- | --- |
| V01-001 | Engineering Parity | 建立 Bun/TypeScript monorepo | `claude-code/package.json` | `bun run typecheck` 通过 |
| V01-002 | Agent Core | 定义 Claude-compatible 核心协议 | `claude-code/src/Tool.ts`、`claude-code/packages/agent-tools/src/types.ts` | 协议 schema tests 通过 |
| V01-003 | Agent Core | 建立 provider abstraction 和 DeepSeek parser | `claude-code/packages/@ant/model-provider` | streaming parser tests 通过 |
| V01-004 | Product Surface | CLI fast path | `claude-code/src/main.tsx` | `--help`、`--version` tests 通过 |
| V01-005 | Engineering Parity | 建立 build/typecheck/test/lint 命令 | `claude-code/package.json` | 四个命令可执行 |

## V0.2 Candidates

| ID | Track | Story | Source Reference |
| --- | --- | --- | --- |
| V02-001 | Agent Core | Headless `-p` query loop | `claude-code/src/query.ts` |
| V02-002 | Agent Core | Transcript JSONL append | `claude-code/src/cli/` |
| V02-003 | Product Surface | `--output-format text/json/stream-json` | `claude-code/src/main.tsx` |
