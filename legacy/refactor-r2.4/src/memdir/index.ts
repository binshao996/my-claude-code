export {
  extractMemories,
  listMemoryStoreEntries,
  memoryRoot,
  rankMemoryStoreEntries,
  readRankedMemorySnippets,
  readSessionMemory,
  syncTeamMemory,
  writeAgentMemorySnapshot,
  writeSessionMemorySnapshot,
  type AgentMemorySnapshot,
  type ExtractedMemoryRecord,
  type MemoryRankingResult,
  type MemoryStoreEntry,
  type SessionMemorySnapshot,
  type TeamMemorySyncRecord,
} from '../../packages/tools/src/services/memory.js'

export const memdirMirror = {
  upstream: 'claude-code/src/memdir',
  local: 'packages/tools/src/services/memory.ts',
  status: 'r1.7-session-context-memory-mirror',
  golden: 'docs/refactor/golden/runtime/r1.7-session-context-memory-golden.json',
} as const
