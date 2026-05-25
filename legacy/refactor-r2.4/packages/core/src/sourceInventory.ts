import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type SourceInventoryCategory = 'support' | 'service' | 'native' | 'fixture'

export type SourceInventoryDomain = {
  id: string
  category: SourceInventoryCategory
  upstreamPath: string
  localPath: string
  evidence: string[]
  packageName?: string
}

export type SourceInventoryDomainResult = SourceInventoryDomain & {
  upstreamExists: boolean
  manifestMapped: boolean
  manifestTarget?: string
  localExists: boolean
  missingEvidence: string[]
  status: 'pass' | 'fail'
}

export type SourceInventoryClosureReport = {
  total: number
  pass: number
  fail: number
  categories: Record<SourceInventoryCategory, {
    total: number
    pass: number
    fail: number
  }>
  results: SourceInventoryDomainResult[]
}

type StrictParityManifest = {
  packageMappings?: Record<string, string>
  sourceMappings?: Record<string, string>
}

export const SOURCE_INVENTORY_SUPPORT_DOMAINS: SourceInventoryDomain[] = [
  {
    id: 'constants',
    category: 'support',
    upstreamPath: 'claude-code/src/constants/',
    localPath: 'packages/core/src/sourceInventory.ts',
    evidence: ['SOURCE_INVENTORY_SUPPORT_DOMAINS'],
  },
  {
    id: 'types',
    category: 'support',
    upstreamPath: 'claude-code/src/types/',
    localPath: 'packages/core/src/protocol.ts',
    evidence: ['ToolUseBlock', 'ToolResult'],
  },
  {
    id: 'schemas',
    category: 'support',
    upstreamPath: 'claude-code/src/schemas/',
    localPath: 'packages/core/src/protocol.ts',
    evidence: ['ToolUseBlockSchema', 'MessageSchema'],
  },
  {
    id: 'bootstrap',
    category: 'support',
    upstreamPath: 'claude-code/src/bootstrap/',
    localPath: 'packages/cli/src/program.ts',
    evidence: ['createProgram', 'loadDevelopmentEnv'],
  },
  {
    id: 'setup',
    category: 'support',
    upstreamPath: 'claude-code/src/setup.ts',
    localPath: 'packages/cli/src/program.ts',
    evidence: ['loadDevelopmentEnv', 'createProgram'],
  },
  {
    id: 'project-onboarding-state',
    category: 'support',
    upstreamPath: 'claude-code/src/projectOnboardingState.ts',
    localPath: 'packages/settings/src/settings.ts',
    evidence: ['settingsSourceCandidates', 'projectSettingsPath'],
  },
  {
    id: 'dialog-launchers',
    category: 'support',
    upstreamPath: 'claude-code/src/dialogLaunchers.tsx',
    localPath: 'packages/tui/src/TuiApp.tsx',
    evidence: ['setActiveScreen', 'OverlayStack'],
  },
  {
    id: 'interactive-helpers',
    category: 'support',
    upstreamPath: 'claude-code/src/interactiveHelpers.tsx',
    localPath: 'packages/tui/src/TuiApp.tsx',
    evidence: ['submitPrompt', 'submitSlashCommand'],
  },
  {
    id: 'repl-launcher',
    category: 'support',
    upstreamPath: 'claude-code/src/replLauncher.tsx',
    localPath: 'packages/tui/src/TuiApp.tsx',
    evidence: ['TuiApp', 'submitPrompt'],
  },
  {
    id: 'migrations',
    category: 'support',
    upstreamPath: 'claude-code/src/migrations/',
    localPath: 'packages/settings/src/settings.ts',
    evidence: ['SettingsSchema', 'loadSettingsWithSources'],
  },
  {
    id: 'output-styles',
    category: 'support',
    upstreamPath: 'claude-code/src/outputStyles/',
    localPath: 'packages/settings/src/settings.ts',
    evidence: ['OUTPUT_STYLE_NAMES', 'OutputStyleNameSchema'],
  },
  {
    id: 'keybindings',
    category: 'support',
    upstreamPath: 'claude-code/src/keybindings/',
    localPath: 'packages/anthropic-ink/src/keybindings.ts',
    evidence: ['parseKeystroke', 'matchesKeystroke'],
  },
  {
    id: 'utils',
    category: 'support',
    upstreamPath: 'claude-code/src/utils/',
    localPath: 'packages/core/src/index.ts',
    evidence: ["export * from './protocol.js'"],
  },
]

export const SOURCE_INVENTORY_SERVICE_DOMAINS: SourceInventoryDomain[] = [
  {
    id: 'analytics',
    category: 'service',
    upstreamPath: 'claude-code/src/services/analytics/',
    localPath: 'packages/core/src/observability.ts',
    evidence: ['buildObservabilityEvents', 'redactAttributes'],
  },
  {
    id: 'diagnostic-tracking',
    category: 'service',
    upstreamPath: 'claude-code/src/services/diagnosticTracking.ts',
    localPath: 'packages/core/src/observability.ts',
    evidence: ['ObservabilityEvent', 'redactedKeys'],
  },
  {
    id: 'internal-logging',
    category: 'service',
    upstreamPath: 'claude-code/src/services/internalLogging.ts',
    localPath: 'packages/core/src/observability.ts',
    evidence: ['buildNativeClientMetadata', 'shouldSkipUpdateDetection'],
  },
  {
    id: 'langfuse',
    category: 'service',
    upstreamPath: 'claude-code/src/services/langfuse/',
    localPath: 'packages/core/src/observability.ts',
    evidence: ['buildObservabilityEvents', 'SECRET_KEY_PATTERN'],
  },
  {
    id: 'perfetto',
    category: 'service',
    upstreamPath: 'claude-code/src/utils/telemetry/perfettoTracing.ts',
    localPath: 'packages/core/src/observability.ts',
    evidence: ['PerfettoTraceEvent', 'buildPerfettoTraceEvent'],
  },
  {
    id: 'tool-execution-service',
    category: 'service',
    upstreamPath: 'claude-code/src/services/tools/',
    localPath: 'packages/tools/src/runner.ts',
    evidence: ['runToolUse', 'runPostToolUseHooks', 'recordFileSnapshotBeforeMutation'],
  },
]

export const SOURCE_INVENTORY_NATIVE_DOMAINS: SourceInventoryDomain[] = [
  {
    id: 'audio-capture-napi',
    category: 'native',
    upstreamPath: 'claude-code/packages/audio-capture-napi',
    localPath: 'packages/audio-capture-napi/src/index.ts',
    packageName: 'audio-capture-napi',
    evidence: ['isNativeAudioAvailable', 'startNativeRecording'],
  },
  {
    id: 'color-diff-napi',
    category: 'native',
    upstreamPath: 'claude-code/packages/color-diff-napi',
    localPath: 'packages/anthropic-ink/src/theme/theme.ts',
    packageName: 'color-diff-napi',
    evidence: ['themePreviewRows', 'resolveTheme'],
  },
  {
    id: 'image-processor-napi',
    category: 'native',
    upstreamPath: 'claude-code/packages/image-processor-napi',
    localPath: 'packages/tui/src/clipboard.ts',
    packageName: 'image-processor-napi',
    evidence: ['readImageFromSystemClipboard', 'imageClipboardCommandForPlatform'],
  },
  {
    id: 'modifiers-napi',
    category: 'native',
    upstreamPath: 'claude-code/packages/modifiers-napi',
    localPath: 'packages/tui/src/promptEditing.ts',
    packageName: 'modifiers-napi',
    evidence: ['deletePromptWordBackward', 'movePromptCursor'],
  },
  {
    id: 'url-handler-napi',
    category: 'native',
    upstreamPath: 'claude-code/packages/url-handler-napi',
    localPath: 'packages/cli/src/program.ts',
    packageName: 'url-handler-napi',
    evidence: ['normalizeTopLevelSlashCommand', 'appendSlashCommandFlags'],
  },
]

export const SOURCE_INVENTORY_FIXTURE_DOMAINS: SourceInventoryDomain[] = [
  {
    id: 'tool-test',
    category: 'fixture',
    upstreamPath: 'claude-code/src/__tests__/Tool.test.ts',
    localPath: 'packages/tools/src/runner.test.ts',
    evidence: ['runTools', 'permission'],
  },
  {
    id: 'commands-bridge-safety-test',
    category: 'fixture',
    upstreamPath: 'claude-code/src/__tests__/commandsBridgeSafety.test.ts',
    localPath: 'packages/commands/src/slashCommands.test.ts',
    evidence: ['runSlashCommand', '/parity --strict'],
  },
  {
    id: 'context-baseline-test',
    category: 'fixture',
    upstreamPath: 'claude-code/src/__tests__/context.baseline.test.ts',
    localPath: 'packages/agent-runtime/src/context.test.ts',
    evidence: ['buildRuntimeContext'],
  },
  {
    id: 'handle-prompt-submit-test',
    category: 'fixture',
    upstreamPath: 'claude-code/src/__tests__/handlePromptSubmit.test.ts',
    localPath: 'packages/agent-runtime/src/query.test.ts',
    evidence: ['query', 'UserPromptSubmit'],
  },
  {
    id: 'history-test',
    category: 'fixture',
    upstreamPath: 'claude-code/src/__tests__/history.test.ts',
    localPath: 'packages/tui/src/promptEditing.test.ts',
    evidence: ['history'],
  },
  {
    id: 'provider-boundary-test',
    category: 'fixture',
    upstreamPath: 'claude-code/src/__tests__/queryAutonomyProviderBoundary.test.ts',
    localPath: 'packages/agent-runtime/src/query.test.ts',
    evidence: ['provider', 'maxTurns'],
  },
  {
    id: 'tools-test',
    category: 'fixture',
    upstreamPath: 'claude-code/src/__tests__/tools.test.ts',
    localPath: 'packages/tools/src/runner.test.ts',
    evidence: ['runTools', 'postToolUseHooks'],
  },
]

export const SOURCE_INVENTORY_DOMAINS: SourceInventoryDomain[] = [
  ...SOURCE_INVENTORY_SUPPORT_DOMAINS,
  ...SOURCE_INVENTORY_SERVICE_DOMAINS,
  ...SOURCE_INVENTORY_NATIVE_DOMAINS,
  ...SOURCE_INVENTORY_FIXTURE_DOMAINS,
]

export function listSourceInventoryDomains(category?: SourceInventoryCategory): SourceInventoryDomain[] {
  return category
    ? SOURCE_INVENTORY_DOMAINS.filter(domain => domain.category === category)
    : [...SOURCE_INVENTORY_DOMAINS]
}

export function buildSourceInventoryClosureReport(args: {
  cwd: string
  manifestPath?: string
}): SourceInventoryClosureReport {
  const manifest = readManifest(args.cwd, args.manifestPath)
  const results = SOURCE_INVENTORY_DOMAINS.map(domain =>
    evaluateDomain(args.cwd, manifest, domain),
  )
  const categories = summarizeCategories(results)
  const pass = results.filter(result => result.status === 'pass').length

  return {
    total: results.length,
    pass,
    fail: results.length - pass,
    categories,
    results,
  }
}

export function validateSourceInventoryClosure(args: {
  cwd: string
  category?: SourceInventoryCategory
}): SourceInventoryDomainResult[] {
  const report = buildSourceInventoryClosureReport({ cwd: args.cwd })
  return report.results.filter(result =>
    result.status === 'fail' && (!args.category || result.category === args.category),
  )
}

function evaluateDomain(
  cwd: string,
  manifest: StrictParityManifest,
  domain: SourceInventoryDomain,
): SourceInventoryDomainResult {
  const upstreamExists = existsSync(join(cwd, domain.upstreamPath))
  const mapping = findManifestMapping(domain, manifest)
  const localExists = existsSync(join(cwd, domain.localPath))
  const localSource = localExists ? readFileSync(join(cwd, domain.localPath), 'utf8') : ''
  const missingEvidence = domain.evidence.filter(item => !localSource.includes(item))
  const packageMapped = !domain.packageName || Boolean(manifest.packageMappings?.[domain.packageName])
  const manifestMapped = domain.packageName ? packageMapped : mapping.manifestMapped
  const status = upstreamExists &&
    manifestMapped &&
    localExists &&
    missingEvidence.length === 0
    ? 'pass'
    : 'fail'

  return {
    ...domain,
    upstreamExists,
    manifestMapped,
    manifestTarget: mapping.manifestTarget,
    localExists,
    missingEvidence,
    status,
  }
}

function findManifestMapping(
  domain: SourceInventoryDomain,
  manifest: StrictParityManifest,
): { manifestMapped: boolean; manifestTarget?: string } {
  const mappings = manifest.sourceMappings ?? {}
  const exact = mappings[domain.upstreamPath]
  if (exact) {
    return { manifestMapped: exact === domain.localPath, manifestTarget: exact }
  }

  const parent = Object.entries(mappings)
    .filter(([upstream]) => upstream.endsWith('/') && domain.upstreamPath.startsWith(upstream))
    .sort(([left], [right]) => right.length - left.length)
    .at(0)

  return {
    manifestMapped: Boolean(parent),
    manifestTarget: parent?.[1],
  }
}

function summarizeCategories(
  results: SourceInventoryDomainResult[],
): SourceInventoryClosureReport['categories'] {
  return {
    support: summarizeCategory(results, 'support'),
    service: summarizeCategory(results, 'service'),
    native: summarizeCategory(results, 'native'),
    fixture: summarizeCategory(results, 'fixture'),
  }
}

function summarizeCategory(
  results: SourceInventoryDomainResult[],
  category: SourceInventoryCategory,
) {
  const categoryResults = results.filter(result => result.category === category)
  const pass = categoryResults.filter(result => result.status === 'pass').length
  return {
    total: categoryResults.length,
    pass,
    fail: categoryResults.length - pass,
  }
}

function readManifest(cwd: string, manifestPath?: string): StrictParityManifest {
  const path = manifestPath ?? join(cwd, 'docs', 'strict-parity-manifest.json')
  if (!existsSync(path)) {
    return {}
  }
  return JSON.parse(readFileSync(path, 'utf8')) as StrictParityManifest
}
