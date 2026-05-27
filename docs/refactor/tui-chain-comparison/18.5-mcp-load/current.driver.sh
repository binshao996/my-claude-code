#!/usr/bin/env bash
set +e
cd '/Users/bin.ke/my-compony/my-claude-code'
unset NO_COLOR
export TERM='xterm-256color'
export COLORTERM='truecolor'
export COLUMNS='100'
export LINES='32'
export CLAUDE_CODE_DISABLE_TERMINAL_TITLE='1'
export CLAUDE_CODE_DISABLE_SESSION_DATA_UPLOAD='1'
export CLAUDE_CODE_SKIP_PROMPT_HISTORY='1'
stty cols 100 rows 32 2>/dev/null || true
exec 'bun' 'run' 'scripts/dev.ts' '--mcp-config' '/Users/bin.ke/my-compony/my-claude-code/docs/refactor/tui-chain-comparison/fixture-mcp.json' '--strict-mcp-config'
