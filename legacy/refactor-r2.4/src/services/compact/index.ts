export {
  DEFAULT_AUTO_COMPACT_THRESHOLD_TOKENS,
  applyAutoCompact,
  applyAutoCompactWithSummary,
  applyToolResultBudget,
  reactiveCompactMessages,
  type CompactOptions,
  type CompactResult,
  type CompactSummarizer,
  type CompactWithSummaryOptions,
  type ToolResultBudgetOptions,
  type ToolResultBudgetStats,
} from '../../../packages/agent-runtime/src/compact.js'

export const compactMirror = {
  upstream: 'claude-code/src/services/compact',
  local: 'packages/agent-runtime/src/compact.ts',
  status: 'r1.6-provider-runtime-mirror',
  golden: 'docs/refactor/golden/runtime/r1.6-provider-runtime-golden.json',
} as const
