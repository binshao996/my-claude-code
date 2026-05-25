export {
  readSessionMemory,
  writeSessionMemorySnapshot,
  type SessionMemorySnapshot,
} from '../../../packages/tools/src/services/memory.js'

export const sessionMemoryMirror = {
  upstream: 'claude-code/src/services/SessionMemory',
  local: 'packages/tools/src/services/memory.ts',
  status: 'r1.7-session-context-memory-mirror',
  golden: 'docs/refactor/golden/runtime/r1.7-session-context-memory-golden.json',
} as const
