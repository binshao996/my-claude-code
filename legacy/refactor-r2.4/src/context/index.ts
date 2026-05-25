export {
  buildRuntimeContext,
  estimateTokens,
  type ContextSection,
  type RuntimeContextOptions,
  type RuntimeContextSnapshot,
} from '../../packages/agent-runtime/src/context.js'

export const runtimeContextMirror = {
  upstream: 'claude-code/src/context',
  local: 'packages/agent-runtime/src/context.ts',
  status: 'r1.6-provider-runtime-mirror',
  golden: 'docs/refactor/golden/runtime/r1.6-provider-runtime-golden.json',
} as const
