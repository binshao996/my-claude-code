export {
  DEFAULT_SYSTEM_PROMPT,
  buildMessages,
  buildRuntimeMessages,
  query,
  queryLoop,
  textDeltaFromEvent,
  type AgentEvent,
  type QueryOptions,
  type QueryProvider,
} from '../../packages/agent-runtime/src/query.js'
export { QueryEngine, type QueryEngineRunResult } from '../../packages/agent-runtime/src/queryEngine.js'

export const runtimeQueryMirror = {
  upstream: 'claude-code/src/query',
  local: 'packages/agent-runtime/src/query.ts',
  status: 'r1.6-provider-runtime-mirror',
  golden: 'docs/refactor/golden/runtime/r1.6-provider-runtime-golden.json',
} as const
