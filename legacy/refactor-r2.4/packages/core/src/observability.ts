import {
  type FeatureFlagRecord,
  summarizeFeatureFlags,
} from './featureFlags.js'

export type ObservabilityEventName =
  | 'ablation_baseline'
  | 'coworker_type'
  | 'enhanced_session'
  | 'feature_example'
  | 'memory_shape'
  | 'perfetto_trace'
  | 'slow_operation'

export type ObservabilityAttribute = string | number | boolean | null

export type ObservabilityEvent = {
  name: ObservabilityEventName
  enabled: boolean
  enabledBy: 'default' | 'env' | 'off'
  attributes: Record<string, ObservabilityAttribute>
  redactedKeys: string[]
}

export type PerfettoTraceEvent = {
  name: string
  ph: 'X'
  ts: number
  dur: number
  pid: number
  tid: number
  args: Record<string, ObservabilityAttribute>
}

const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|cookie|password|secret|session|token)/i
const SECRET_VALUE_PATTERN = /(sk-ant-|sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]+)/i

const EVENT_FEATURES: Array<{
  feature: string
  event: ObservabilityEventName
}> = [
  { feature: 'ABLATION_BASELINE', event: 'ablation_baseline' },
  { feature: 'COWORKER_TYPE_TELEMETRY', event: 'coworker_type' },
  { feature: 'ENHANCED_TELEMETRY_BETA', event: 'enhanced_session' },
  { feature: 'FLAG_NAME', event: 'feature_example' },
  { feature: 'MEMORY_SHAPE_TELEMETRY', event: 'memory_shape' },
  { feature: 'PERFETTO_TRACING', event: 'perfetto_trace' },
  { feature: 'SLOW_OPERATION_LOGGING', event: 'slow_operation' },
  { feature: 'X', event: 'feature_example' },
]

export function buildObservabilityEvents(args: {
  envValue?: string
  attributes?: Record<string, unknown>
} = {}): ObservabilityEvent[] {
  const records = summarizeFeatureFlags(args.envValue)
  const { attributes, redactedKeys } = redactAttributes(args.attributes ?? {})

  return EVENT_FEATURES.map(item => {
    const record = findFeature(records, item.feature)
    return {
      name: item.event,
      enabled: record.enabled,
      enabledBy: record.enabledBy,
      attributes,
      redactedKeys,
    }
  })
}

export function buildPerfettoTraceEvent(args: {
  name: string
  startedAtMicros: number
  durationMicros: number
  pid?: number
  tid?: number
  args?: Record<string, unknown>
}): PerfettoTraceEvent {
  const { attributes } = redactAttributes(args.args ?? {})
  return {
    name: args.name,
    ph: 'X',
    ts: Math.max(0, Math.trunc(args.startedAtMicros)),
    dur: Math.max(0, Math.trunc(args.durationMicros)),
    pid: args.pid ?? 0,
    tid: args.tid ?? 0,
    args: attributes,
  }
}

export function shouldSkipUpdateDetection(args: {
  autoUpdatesDisabled: boolean
  envValue?: string
}): boolean {
  const record = findFeature(
    summarizeFeatureFlags(args.envValue),
    'SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED',
  )
  return args.autoUpdatesDisabled && record.enabled
}

export function buildNativeClientMetadata(args: {
  version: string
  envValue?: string
}): string {
  const record = findFeature(
    summarizeFeatureFlags(args.envValue),
    'NATIVE_CLIENT_ATTESTATION',
  )
  const attestation = record.enabled ? ' cch=00000;' : ''
  return `my-claude-code/${args.version};${attestation}`
}

function redactAttributes(input: Record<string, unknown>): {
  attributes: Record<string, ObservabilityAttribute>
  redactedKeys: string[]
} {
  const attributes: Record<string, ObservabilityAttribute> = {}
  const redactedKeys: string[] = []

  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY_PATTERN.test(key) || isSecretValue(value)) {
      attributes[key] = '[redacted]'
      redactedKeys.push(key)
      continue
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      attributes[key] = value
      continue
    }
    attributes[key] = JSON.stringify(value)
  }

  return { attributes, redactedKeys: redactedKeys.sort() }
}

function isSecretValue(value: unknown): boolean {
  return typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)
}

function findFeature(
  records: Array<FeatureFlagRecord & { enabled: boolean; enabledBy: 'default' | 'env' | 'off' }>,
  name: string,
) {
  const record = records.find(candidate => candidate.name === name)
  if (!record) {
    throw new Error(`feature not registered: ${name}`)
  }
  return record
}
