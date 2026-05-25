export {
  extractMemories,
  type ExtractedMemoryRecord,
} from '../../../packages/tools/src/services/memory.js'

export const extractMemoriesMirror = {
  upstream: 'claude-code/src/services/extractMemories',
  local: 'packages/tools/src/services/memory.ts',
  status: 'r1.7-session-context-memory-mirror',
  golden: 'docs/refactor/golden/runtime/r1.7-session-context-memory-golden.json',
} as const
