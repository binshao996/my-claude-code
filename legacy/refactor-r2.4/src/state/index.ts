export type RuntimeAppStatus = 'idle' | 'running' | 'aborting'

export type RuntimeAppState = {
  sessionId?: string
  model?: string
  status: RuntimeAppStatus
  provider?: string
  lastTerminalStatus?: string
}

export function createRuntimeAppState(
  state: Partial<RuntimeAppState> = {},
): RuntimeAppState {
  return {
    status: 'idle',
    ...state,
  }
}

export const runtimeStateMirror = {
  upstream: 'claude-code/src/state',
  local: 'src/state',
  status: 'r1.6-provider-runtime-mirror',
  golden: 'docs/refactor/golden/runtime/r1.6-provider-runtime-golden.json',
} as const
