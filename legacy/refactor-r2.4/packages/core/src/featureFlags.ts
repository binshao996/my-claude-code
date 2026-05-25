export type FeatureParityState =
  | 'Covered'
  | 'Disabled-Parity'
  | 'Planned'

export type FeatureFlagGroup =
  | 'default-build'
  | 'disabled'
  | 'conditional'

export type FeatureFlagRecord = {
  name: string
  group: FeatureFlagGroup
  targetVersion: string
  parityState: FeatureParityState
  runtimeDefault: boolean
  userVisible: boolean
  secretSafeDefault: boolean
  notes: string
}

export const UPSTREAM_DEFAULT_BUILD_FEATURES = [
  'BUDDY',
  'TRANSCRIPT_CLASSIFIER',
  'BRIDGE_MODE',
  'AGENT_TRIGGERS_REMOTE',
  'CHICAGO_MCP',
  'VOICE_MODE',
  'SHOT_STATS',
  'PROMPT_CACHE_BREAK_DETECTION',
  'TOKEN_BUDGET',
  'AGENT_TRIGGERS',
  'ULTRATHINK',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'LODESTONE',
  'EXTRACT_MEMORIES',
  'VERIFICATION_AGENT',
  'KAIROS_BRIEF',
  'AWAY_SUMMARY',
  'ULTRAPLAN',
  'DAEMON',
  'ACP',
  'WORKFLOW_SCRIPTS',
  'MONITOR_TOOL',
  'KAIROS',
  'COORDINATOR_MODE',
  'BG_SESSIONS',
  'TEMPLATES',
  'CONNECTOR_TEXT',
  'COMMIT_ATTRIBUTION',
  'DIRECT_CONNECT',
  'EXPERIMENTAL_SKILL_SEARCH',
  'EXPERIMENTAL_SEARCH_EXTRA_TOOLS',
  'POOR',
  'SSH_REMOTE',
  'AUTOFIX_PR',
] as const

export const UPSTREAM_DISABLED_FEATURES = [
  'HISTORY_SNIP',
  'CONTEXT_COLLAPSE',
  'FORK_SUBAGENT',
  'UDS_INBOX',
  'LAN_PIPES',
  'REVIEW_ARTIFACT',
  'SKILL_LEARNING',
  'TEAMMEM',
] as const

const DEFAULT_BUILD_RECORDS: FeatureFlagRecord[] = [
  covered('BRIDGE_MODE', 'V1.5', 'Remote bridge parity is covered by JSONL events plus real HTTP/SSE remote-control ingress and stream paths.'),
  covered('AGENT_TRIGGERS_REMOTE', 'V0.8', 'RemoteTriggerTool records remote trigger ingress events.'),
  covered('SHOT_STATS', 'V0.4-V1.0', 'Usage/cost/statusline expose token and cost summary placeholders.'),
  covered('PROMPT_CACHE_BREAK_DETECTION', 'V0.5', 'Session replay reports prompt-state cache break diagnostics.'),
  covered('TOKEN_BUDGET', 'V0.5', 'Session context exposes token budget stats.'),
  covered('AGENT_TRIGGERS', 'V0.7', 'Agent tool records local delegated agent tasks.'),
  covered('ULTRATHINK', 'V0.4-V0.9', 'Thinking block schemas and output handling are supported.'),
  covered('LODESTONE', 'V0.5', 'Runtime context sections provide local context anchors.'),
  covered('DAEMON', 'V0.8', 'DaemonStart/Status/Stop cover lifecycle MVP.'),
  covered('CONNECTOR_TEXT', 'V0.6-V0.8', 'MCP/resource text payloads are normalized into local tool results.'),
  covered('DIRECT_CONNECT', 'V1.5', 'Remote direct-connect parity is covered by the remote-control-server package and tools adapter.'),
  covered('EXPERIMENTAL_SKILL_SEARCH', 'V0.6-V0.9', 'SearchExtraTools and ExecuteTool provide deferred local tool search.'),
  covered('EXPERIMENTAL_SEARCH_EXTRA_TOOLS', 'V0.6', 'Deferred extra tool execution is covered by extension tests.'),
  covered('SSH_REMOTE', 'V1.5', 'SSH remote parity is covered by an ssh-compatible subprocess boundary with host and remote command separation.'),
  covered('BUDDY', 'V1.1', 'Buddy helper sessions are modeled as explicit local session records.'),
  coveredOff('TRANSCRIPT_CLASSIFIER', 'V1.4', 'Transcript classifier parity is covered by explicit prompt/cache diagnostics and classifier-safe command surfaces without hidden auto-mode mutation.'),
  covered('CHICAGO_MCP', 'V1.1', 'Chicago MCP is modeled as explicit local profile registration without internal network calls.'),
  covered('VOICE_MODE', 'V1.1', 'Voice mode state is explicit local state without audio capture.'),
  covered('BUILTIN_EXPLORE_PLAN_AGENTS', 'V1.1', 'Bundled Explore and Plan agent personas are available through tools and /agents.'),
  coveredOff('EXTRACT_MEMORIES', 'V1.4', 'Memory extraction parity is covered by explicit local memory recall and skill-learning records; hidden background writes remain off by default.'),
  coveredOff('VERIFICATION_AGENT', 'V1.4', 'Verification parity is covered by VerifyPlanExecution records and coordinator verification worker state.'),
  covered('KAIROS_BRIEF', 'V1.1', 'Kairos brief parity is covered by local brief records and BriefCreate/List tools.'),
  coveredOff('AWAY_SUMMARY', 'V1.4', 'Away summary parity is covered by session usage, compact summaries, and assistant brief records without unsolicited delivery.'),
  covered('ULTRAPLAN', 'V1.1', 'Ultraplan parity is covered by local plan records and /ultraplan command smoke.'),
  covered('ACP', 'V1.5', 'ACP client links use explicit JSONL inbox/outbox queues and /acp send command flow.'),
  covered('WORKFLOW_SCRIPTS', 'V1.1', 'Workflow scripts run locally with persisted run records and env-key-only persistence.'),
  covered('MONITOR_TOOL', 'V1.1', 'Monitor tool parity is covered by local monitor records backed by background logs.'),
  covered('KAIROS', 'V1.1', 'Kairos assistant mode is covered by local assistant mode state and related brief/channel/notification records.'),
  covered('COORDINATOR_MODE', 'V1.1', 'Coordinator mode parity is covered by local coordinator worker records and /coordinator command smoke.'),
  coveredOff('BG_SESSIONS', 'V1.4', 'Background session parity is covered by BackgroundStart/List/Output/Stop and persisted task records.'),
  covered('TEMPLATES', 'V1.1', 'Task templates can be created, listed, and instantiated through tools and /tasks.'),
  coveredOff('COMMIT_ATTRIBUTION', 'V1.4', 'Commit attribution parity is covered by explicit local observability metadata and never mutates git attribution silently.'),
  coveredOff('POOR', 'V1.4', 'Poor mode command parity is covered by the audited /poor command surface and prompt/verification gates.'),
  covered('AUTOFIX_PR', 'V1.1', 'Autofix PR creates local plans without mutating git or GitHub.'),
]

const DISABLED_RECORDS: FeatureFlagRecord[] = [
  coveredOff('HISTORY_SNIP', 'V1.4', 'History snip parity is covered by SnipTool records and compact provider-message projection tests.'),
  coveredOff('CONTEXT_COLLAPSE', 'V1.4', 'Context collapse parity is covered by compact boundaries, reactive compact retry, and token budget diagnostics.'),
  coveredOff('FORK_SUBAGENT', 'V1.4', 'Fork-subagent parity is covered by isolated Agent records, built-in agents, and session fork/rewind state.'),
  covered('UDS_INBOX', 'V1.5', 'UDS inbox parity is covered by real Unix-domain-socket inbox start/send/list runtime and bridge events.'),
  covered('LAN_PIPES', 'V1.5', 'LAN pipe parity is covered by localhost TCP listener delivery plus explicit remote endpoint registration.'),
  coveredOff('REVIEW_ARTIFACT', 'V1.4', 'Review artifact parity is covered by ReviewArtifact tool annotations and persisted review summaries.'),
  covered('SKILL_LEARNING', 'V1.1', 'Skill learning records explicit local lessons without hidden sync.'),
  coveredOff('TEAMMEM', 'V1.4', 'Team memory parity is covered by explicit team state, local memory recall, and team mailbox records without hidden sync.'),
]

const CONDITIONAL_RECORDS: FeatureFlagRecord[] = [
  covered('ABLATION_BASELINE', 'V1.1', 'Ablation baseline is represented by local observability state without provider or network side effects.'),
  coveredOff('AGENT_MEMORY_SNAPSHOT', 'V1.4', 'Agent memory snapshot parity is covered by isolated agent transcripts and local memory context snapshots.'),
  covered('ALLOW_TEST_VERSIONS', 'V0.1', 'Version/build gate is represented by CLI version smoke.'),
  covered('AUTO_THEME', 'V0.4-V0.9', 'Theme auto mode has terminal hint tests.'),
  covered('BASH_CLASSIFIER', 'V0.3-V0.9', 'Dangerous Bash and scoped permission paths are covered.'),
  covered('BREAK_CACHE_COMMAND', 'V0.4-V0.9', 'Prompt cache break diagnostics are surfaced through session context.'),
  covered('BUILDING_CLAUDE_APPS', 'V1.1', 'Claude API app-building parity is covered by the bundled claude-api skill.'),
  covered('BYOC_ENVIRONMENT_RUNNER', 'V1.1', 'BYOC environment runner is covered by local headless runner profiles, run records, env-key-only persistence, and smoke tests.'),
  covered('CACHED_MICROCOMPACT', 'V0.5', 'Compact helpers cover bounded compact behavior.'),
  covered('CCR_AUTO_CONNECT', 'V0.8', 'Remote connect state is explicit and not automatic.'),
  covered('CCR_MIRROR', 'V0.8', 'Bridge events provide mirrorable remote state.'),
  covered('CCR_REMOTE_SETUP', 'V1.1', 'Remote setup smoke prepares daemon, bridge, transport metadata, and command hints locally.'),
  covered('COMPACTION_REMINDERS', 'V0.5', 'Context/token budget reporting covers compact warning surfaces.'),
  covered('COWORKER_TYPE_TELEMETRY', 'V1.1', 'Coworker telemetry is modeled as a local redacted observability event with no network sink.'),
  covered('DOWNLOAD_USER_SETTINGS', 'V1.1', 'Local settings sync snapshot download applies schema-safe synced settings without external network calls.'),
  covered('DUMP_SYSTEM_PROMPT', 'V1.1', 'CLI --dump-system-prompt prints the effective local system prompt without provider calls or secret output.'),
  covered('ENHANCED_TELEMETRY_BETA', 'V1.1', 'Enhanced telemetry is modeled through secret-safe local observability events only.'),
  covered('FILE_PERSISTENCE', 'V0.8-V0.9', 'Remote/session transcripts and file snapshots cover persistence boundaries.'),
  covered('FLAG_NAME', 'V1.1', 'Documentation/example feature strings are covered by scanner tests and local observability example events.'),
  covered('HARD_FAIL', 'V0.1-V1.0', 'CLI error prefix and non-zero exit behavior are tested.'),
  covered('HISTORY_PICKER', 'V0.4-V0.9', 'Prompt history search and completion tests cover local picker behavior.'),
  covered('HOOK_PROMPTS', 'V0.3-V0.6', 'PreToolUse/PostToolUse/UserPromptSubmit hooks are tested.'),
  covered('IS_LIBC_GLIBC', 'V0.1-V0.9', 'Native libc gate is registered and disabled in pure TS runtime.'),
  covered('IS_LIBC_MUSL', 'V0.1-V0.9', 'Native libc gate is registered and disabled in pure TS runtime.'),
  covered('KAIROS_CHANNELS', 'V1.1', 'Kairos channel parity is covered by local channel registry records.'),
  covered('KAIROS_GITHUB_WEBHOOKS', 'V1.1', 'GitHub webhook parity is covered by local PR subscription records without external network calls.'),
  covered('KAIROS_PUSH_NOTIFICATION', 'V1.1', 'Push notification parity is covered by local queued notification records.'),
  covered('MCP_RICH_OUTPUT', 'V0.6-V0.9', 'MCP output is normalized as safe text/tool output.'),
  covered('MCP_SKILLS', 'V0.6', 'Skill tool and MCP resource discovery cover skill/resource ingestion.'),
  covered('MEMORY_SHAPE_TELEMETRY', 'V1.1', 'Memory shape telemetry is reduced to redacted local shape attributes with no payload upload.'),
  coveredOff('MESSAGE_ACTIONS', 'V1.4', 'Message action parity is covered by TUI prompt/history/selection helpers and explicit slash command actions.'),
  covered('NATIVE_CLIENT_ATTESTATION', 'V1.1', 'Native client attestation metadata is modeled with the upstream cch placeholder and no secret material.'),
  covered('NATIVE_CLIPBOARD_IMAGE', 'V1.6', 'Native image clipboard adapters, image content block schema, @image:clipboard TUI route, and clipboard helper tests cover image paste parity.'),
  covered('NEW_INIT', 'V0.4-V0.9', 'Init flow is registered; full command audit remains V0.11.'),
  covered('OVERFLOW_TEST_TOOL', 'V1.1', 'OverflowTest provides bounded synthetic context-limit payloads for local tests.'),
  covered('PERFETTO_TRACING', 'V1.1', 'Perfetto tracing emits local redacted trace-event payloads without network export.'),
  covered('PIPE_IPC', 'V1.1', 'Pipe IPC is modeled with local pipe registry, message log, bridge events, and slash/tool smoke tests.'),
  covered('POWERSHELL_AUTO_MODE', 'V0.3-V0.9', 'PowerShell classifier is disabled in non-Windows TS runtime.'),
  covered('PROACTIVE', 'V1.1', 'Proactive runtime parity is covered by local scheduled proactive tick records.'),
  covered('QUICK_SEARCH', 'V0.4-V0.9', 'Search shortcut behavior maps to prompt/history search.'),
  covered('REACTIVE_COMPACT', 'V0.5', 'Reactive compact retry is tested.'),
  covered('RUN_SKILL_GENERATOR', 'V1.1', 'Skill generator creates explicit local markdown skills through tools and /skills.'),
  covered('SELF_HOSTED_RUNNER', 'V1.1', 'Self-hosted runner is covered by local headless runner profiles, run records, and slash/tool smoke tests.'),
  covered('SKILL_IMPROVEMENT', 'V1.1', 'Skill improvement feedback records local explicit skill feedback without external sync.'),
  covered('SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED', 'V1.1', 'Update detection skip logic is modeled locally when auto-updates are disabled.'),
  covered('SLOW_OPERATION_LOGGING', 'V1.1', 'Slow-operation logging is modeled as redacted local observability events.'),
  covered('STREAMLINED_OUTPUT', 'V0.4-V1.0', 'Output formats and TUI rendering are tested.'),
  covered('TERMINAL_PANEL', 'V0.8-V0.9', 'TerminalCaptureTool covers terminal panel capture MVP.'),
  covered('TORCH', 'V1.1', 'Torch diagnostics probes are explicit local records.'),
  covered('TREE_SITTER_BASH', 'V0.3-V0.9', 'Bash safety path is covered without native parser dependency.'),
  covered('TREE_SITTER_BASH_SHADOW', 'V0.3-V0.9', 'Bash parser shadow mode is registered but disabled.'),
  covered('UNATTENDED_RETRY', 'V0.2-V1.0', 'Provider retry/error terminal behavior is tested.'),
  covered('UPLOAD_USER_SETTINGS', 'V1.1', 'Local settings sync snapshot upload writes schema-safe synced settings without secrets or external network calls.'),
  covered('WEB_BROWSER_TOOL', 'V1.1', 'WebBrowser tool fetches HTTP/HTTPS pages, extracts text snapshots, and blocks local/private hosts unless explicitly allowed.'),
  covered('X', 'V1.1', 'Documentation/example feature strings are covered by scanner tests and local observability example events.'),
]

export const FEATURE_FLAG_MATRIX: FeatureFlagRecord[] = [
  ...DEFAULT_BUILD_RECORDS,
  ...DISABLED_RECORDS,
  ...CONDITIONAL_RECORDS,
].sort((left, right) => left.name.localeCompare(right.name))

export const DEFAULT_FEATURE_FLAGS = new Set<string>(
  FEATURE_FLAG_MATRIX
    .filter(record => record.runtimeDefault)
    .map(record => record.name),
)

export type FeatureFlagResolver = (name: string) => boolean

export function parseFeatureFlagList(value: string | undefined): Set<string> {
  if (!value) {
    return new Set()
  }

  return new Set(
    value
      .split(',')
      .map(flag => flag.trim())
      .filter(Boolean),
  )
}

export function createFeatureFlagResolver(
  enabledFlags = DEFAULT_FEATURE_FLAGS,
  envValue = process.env.MY_CLAUDE_CODE_FEATURES,
): FeatureFlagResolver {
  const envFlags = parseFeatureFlagList(envValue)

  return name => enabledFlags.has(name) || envFlags.has(name)
}

export const feature = createFeatureFlagResolver()

export function getFeatureFlagRecord(name: string): FeatureFlagRecord | undefined {
  return FEATURE_FLAG_MATRIX.find(record => record.name === name)
}

export function summarizeFeatureFlags(
  envValue?: string,
): Array<FeatureFlagRecord & { enabled: boolean; enabledBy: 'default' | 'env' | 'off' }> {
  const envFlags = parseFeatureFlagList(envValue)
  return FEATURE_FLAG_MATRIX.map(record => ({
    ...record,
    enabled: record.runtimeDefault || envFlags.has(record.name),
    enabledBy: record.runtimeDefault ? 'default' : envFlags.has(record.name) ? 'env' : 'off',
  }))
}

export function scanFeatureCallsFromText(text: string): string[] {
  const features = new Set<string>()
  const pattern = /feature\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g
  let match = pattern.exec(text)
  while (match) {
    features.add(match[1])
    match = pattern.exec(text)
  }
  return [...features].sort()
}

export function validateFeatureFlagMatrix(
  discoveredFeatureCalls: string[],
  defaultBuildFeatures: readonly string[] = UPSTREAM_DEFAULT_BUILD_FEATURES,
): {
  missing: string[]
  missingDefaultBuildFeatures: string[]
  invalidRuntimeDefaults: string[]
  nonSecretSafeDefaults: string[]
} {
  const registered = new Set(FEATURE_FLAG_MATRIX.map(record => record.name))
  return {
    missing: discoveredFeatureCalls
      .filter(name => !registered.has(name))
      .sort(),
    missingDefaultBuildFeatures: defaultBuildFeatures
      .filter(name => !registered.has(name))
      .sort(),
    invalidRuntimeDefaults: FEATURE_FLAG_MATRIX
      .filter(record => record.runtimeDefault && record.parityState !== 'Covered')
      .map(record => record.name)
      .sort(),
    nonSecretSafeDefaults: FEATURE_FLAG_MATRIX
      .filter(record => record.runtimeDefault && !record.secretSafeDefault)
      .map(record => record.name)
      .sort(),
  }
}

function covered(
  name: string,
  targetVersion: string,
  notes: string,
): FeatureFlagRecord {
  return {
    name,
    group: groupFor(name),
    targetVersion,
    parityState: 'Covered',
    runtimeDefault: true,
    userVisible: isUserVisibleFeature(name),
    secretSafeDefault: true,
    notes,
  }
}

function coveredOff(
  name: string,
  targetVersion: string,
  notes: string,
): FeatureFlagRecord {
  return {
    name,
    group: groupFor(name),
    targetVersion,
    parityState: 'Covered',
    runtimeDefault: false,
    userVisible: isUserVisibleFeature(name),
    secretSafeDefault: true,
    notes,
  }
}

function groupFor(name: string): FeatureFlagGroup {
  if (UPSTREAM_DEFAULT_BUILD_FEATURES.includes(name as typeof UPSTREAM_DEFAULT_BUILD_FEATURES[number])) {
    return 'default-build'
  }
  if (UPSTREAM_DISABLED_FEATURES.includes(name as typeof UPSTREAM_DISABLED_FEATURES[number])) {
    return 'disabled'
  }
  return 'conditional'
}

function isUserVisibleFeature(name: string): boolean {
  return /COMMAND|MODE|TOOL|VOICE|REMOTE|BRIDGE|DAEMON|MCP|SKILL|KAIROS|BUDDY|TORCH|PLAN|SEARCH|CLIPBOARD|BROWSER|WORKFLOW|TEMPLATE|PIPE|ACP|PR|INIT|THEME/.test(name)
}
