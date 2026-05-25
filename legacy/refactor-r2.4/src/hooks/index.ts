export type RuntimeHookDecision =
  | { decision: 'allow'; reason?: string }
  | { decision: 'block'; reason?: string }

export type RuntimeHookEvent =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'

export type RuntimeHookRecord = {
  event: RuntimeHookEvent
  source: string
  decision: RuntimeHookDecision
}

export function createRuntimeHookRecord(
  event: RuntimeHookEvent,
  source: string,
  decision: RuntimeHookDecision = { decision: 'allow' },
): RuntimeHookRecord {
  return {
    event,
    source,
    decision,
  }
}

export const runtimeHooksMirror = {
  upstream: 'claude-code/src/hooks',
  local: 'packages/agent-runtime/src/query.ts',
  status: 'r1.6-provider-runtime-mirror',
  golden: 'docs/refactor/golden/runtime/r1.6-provider-runtime-golden.json',
} as const
