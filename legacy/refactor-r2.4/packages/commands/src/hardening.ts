import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  FEATURE_FLAG_MATRIX,
  buildSourceInventoryClosureReport,
  scanFeatureCallsFromText,
  validateFeatureFlagMatrix,
  type SourceInventoryCategory,
} from '@my-claude-code/core'
import { getBuiltinTools, getExtensionToolSurfaceNames } from '@my-claude-code/tools'
import { collectDoctorScreen } from './screens.js'

const execFileAsync = promisify(execFile)

export type HardeningCheckStatus = 'pass' | 'warning' | 'fail'

export type HardeningCheck = {
  label: string
  status: HardeningCheckStatus
  detail: string
}

export type HardeningReport = {
  mode: HardeningMode
  status: HardeningCheckStatus
  version: string
  cwd: string
  generatedAt: string
  summary: {
    pass: number
    warning: number
    fail: number
  }
  checks: HardeningCheck[]
}

export type HardeningMode = 'release' | 'full-ecosystem' | 'strict'

type StrictParityManifest = {
  schemaVersion?: number
  generatedFrom?: string
  commandAliases?: Record<string, string>
  packageMappings?: Record<string, string>
  sourceMappings?: Record<string, string>
  toolAliases?: Record<string, string>
  entrypointMappings?: Record<string, string>
  cliTransportMappings?: Record<string, string>
  schemaMappings?: Record<string, string>
}

export async function collectHardeningReport(args: {
  cwd: string
  version: string
  env?: Record<string, string | undefined>
  mode?: HardeningMode
  focus?: readonly string[]
  slashCommandCount?: number
  slashCommandNames?: readonly string[]
  genericSlashCommandNames?: readonly string[]
}): Promise<HardeningReport> {
  const env = args.env ?? process.env
  const mode = args.mode ?? 'release'
  const checks: HardeningCheck[] = [
    await ledgerReadinessCheck(args.cwd),
    await featureMatrixCheck(args.cwd),
    await bundleIntegrityCheck(args.cwd),
    await bundleSmokeCheck(args.cwd, args.version),
    await doctorHealthCheck(args.cwd, args.version, env),
    toolRegistryCheck(),
    slashCommandRegistryCheck(args.slashCommandCount),
    secretSafetyCheck(env),
  ]
  if (mode === 'full-ecosystem' || mode === 'strict') {
    checks.push(
      fullFeatureParityCheck(),
      await fullEcosystemLedgerCheck(args.cwd),
      await sourceInventoryDiffCheck(args.cwd),
    )
  }
  if (mode === 'strict') {
    const manifest = await readStrictParityManifest(args.cwd)
    checks.push(
      strictManifestCheck(manifest),
      await strictCommandInventoryCheck(args.cwd, args.slashCommandNames, manifest.data),
      strictCommandBehaviorCheck(args.genericSlashCommandNames),
      await strictPackageInventoryCheck(args.cwd, manifest.data),
      await strictSourceInventoryCheck(args.cwd, manifest.data),
      await strictToolInventoryCheck(args.cwd, manifest.data),
      strictFeatureParityCheck(),
      strictShimDetectorCheck(await readStrictScanText(args.cwd)),
      strictEntrypointCheck(args.cwd, manifest.data),
      strictCliTransportCheck(args.cwd, manifest.data),
      strictSchemaCheck(args.cwd, manifest.data),
    )
    if (args.focus?.includes('tui')) {
      checks.push(
        strictTuiInkCheck(args.cwd),
        strictTuiComponentCheck(args.cwd),
        await strictTuiSurfaceCheck(args.cwd),
        strictTuiTestCheck(args.cwd),
      )
    }
    if (args.focus?.includes('platform')) {
      checks.push(
        await strictPlatformBrowserCheck(args.cwd),
        strictPlatformComputerUseCheck(args.cwd),
        strictPlatformIdeCheck(args.cwd),
        await strictPlatformCommandCheck(args.cwd),
        strictPlatformTestCheck(args.cwd),
      )
    }
    if (args.focus?.includes('voice')) {
      checks.push(
        strictVoiceAudioPackageCheck(args.cwd),
        strictVoiceRuntimeCheck(args.cwd),
        await strictVoiceCommandCheck(args.cwd),
        strictVoiceNotificationCheck(args.cwd),
        strictVoiceTestCheck(args.cwd),
      )
    }
    if (args.focus?.includes('memory')) {
      checks.push(
        strictMemoryRuntimeCheck(args.cwd),
        await strictMemoryCommandCheck(args.cwd),
        strictMemoryToolCheck(),
        strictMemoryTestCheck(args.cwd),
      )
    }
    if (args.focus?.includes('agent-workflows')) {
      checks.push(
        strictAgentWorkflowRuntimeCheck(args.cwd),
        await strictAgentWorkflowCommandCheck(args.cwd),
        strictAgentWorkflowToolCheck(),
        strictAgentWorkflowTestCheck(args.cwd),
      )
    }
    if (args.focus?.includes('source-inventory')) {
      checks.push(
        strictSourceInventoryClosureCheck(args.cwd),
        strictServiceInventoryClosureCheck(args.cwd),
        strictNativeInventoryClosureCheck(args.cwd),
        strictFixtureInventoryClosureCheck(args.cwd),
      )
    }
  }
  const summary = {
    pass: checks.filter(check => check.status === 'pass').length,
    warning: checks.filter(check => check.status === 'warning').length,
    fail: checks.filter(check => check.status === 'fail').length,
  }

  return {
    mode,
    status: summary.fail > 0 ? 'fail' : summary.warning > 0 ? 'warning' : 'pass',
    version: args.version,
    cwd: args.cwd,
    generatedAt: new Date().toISOString(),
    summary,
    checks,
  }
}

function strictSourceInventoryClosureCheck(cwd: string): HardeningCheck {
  const report = buildSourceInventoryClosureReport({ cwd })
  const missing = report.results.filter(result => result.status === 'fail')
  return missing.length > 0
    ? {
        label: 'strict V2.1 source inventory closure',
        status: 'fail',
        detail: formatSourceInventoryFailures(missing),
      }
    : {
        label: 'strict V2.1 source inventory closure',
        status: 'pass',
        detail: `${report.total} support/service/native/fixture domain(s) have upstream paths, manifest mappings, local files, and runtime evidence`,
      }
}

function strictServiceInventoryClosureCheck(cwd: string): HardeningCheck {
  return strictSourceInventoryCategoryCheck(cwd, 'service', 'strict V2.1 service inventory')
}

function strictNativeInventoryClosureCheck(cwd: string): HardeningCheck {
  return strictSourceInventoryCategoryCheck(cwd, 'native', 'strict V2.1 native package smoke')
}

function strictFixtureInventoryClosureCheck(cwd: string): HardeningCheck {
  return strictSourceInventoryCategoryCheck(cwd, 'fixture', 'strict V2.1 fixture inventory')
}

function strictSourceInventoryCategoryCheck(
  cwd: string,
  category: SourceInventoryCategory,
  label: string,
): HardeningCheck {
  const report = buildSourceInventoryClosureReport({ cwd })
  const categorySummary = report.categories[category]
  const missing = report.results.filter(result =>
    result.category === category && result.status === 'fail',
  )

  return missing.length > 0
    ? {
        label,
        status: 'fail',
        detail: formatSourceInventoryFailures(missing),
      }
    : {
        label,
        status: 'pass',
        detail: `${categorySummary.pass}/${categorySummary.total} ${category} domain(s) closed`,
      }
}

function formatSourceInventoryFailures(
  missing: Array<{
    id: string
    upstreamExists: boolean
    manifestMapped: boolean
    localExists: boolean
    missingEvidence: string[]
  }>,
): string {
  return `${missing.length} inventory domain(s) incomplete: ${missing.slice(0, 8).map(result => {
    const reasons = [
      result.upstreamExists ? undefined : 'upstream',
      result.manifestMapped ? undefined : 'manifest',
      result.localExists ? undefined : 'local',
      result.missingEvidence.length > 0 ? `evidence:${result.missingEvidence.join('+')}` : undefined,
    ].filter(Boolean)
    return `${result.id}(${reasons.join('/')})`
  }).join(', ')}`
}

function strictAgentWorkflowRuntimeCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/services/agentWorkflows.ts',
    'packages/tools/src/tools/agentWorkflows.ts',
    'packages/tools/src/tools/reviewArtifact.ts',
    'packages/tools/src/workflows.ts',
    'packages/tools/src/ecosystem.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  if (missing.length > 0) {
    return {
      label: 'strict agent workflow runtime',
      status: 'fail',
      detail: `${missing.length} missing agent workflow runtime file(s): ${missing.join(', ')}`,
    }
  }
  const source = required.map(path => safeReadSync(join(cwd, path))).join('\n')
  const symbols = [
    'recordMessageAction',
    'runVerificationAgent',
    'recordReviewArtifactMutation',
    'classifyWorkflowJob',
    'scheduleCronWorkflow',
    'runDueCronWorkflows',
    'recordWorkflowEvent',
    'runCoordinator',
    'subscribeGithubWebhook',
    'suggestBackgroundPR',
    'planAutofixPr',
  ]
  const missingSymbols = symbols.filter(symbol => !source.includes(symbol))
  return missingSymbols.length > 0
    ? {
        label: 'strict agent workflow runtime',
        status: 'fail',
        detail: `${missingSymbols.length} missing agent workflow runtime symbol(s): ${missingSymbols.join(', ')}`,
      }
    : {
        label: 'strict agent workflow runtime',
        status: 'pass',
        detail: 'verification agent, message actions, review artifact mutation, job classification, cron scheduling, coordinator, PR subscription, and diagnostic workflow events are present',
      }
}

async function strictAgentWorkflowCommandCheck(cwd: string): Promise<HardeningCheck> {
  const slashCommands = await safeRead(join(cwd, 'packages/commands/src/slashCommands.ts'))
  const program = await safeRead(join(cwd, 'packages/cli/src/program.ts'))
  const required = [
    "'--agent-workflows'",
    "'/message-action'",
    "'/schedule'",
    "'/job'",
    "'/review'",
    "'/security-review'",
    "'/issue'",
    "'/pr-comments'",
    "'/thinkback-play'",
    'printMessageAction',
    'printSchedule',
    'agentWorkflowCommandPayload',
    'recordWorkflowEvent',
    'classifyWorkflowJob',
  ]
  const source = `${slashCommands}\n${program}`
  const missing = required.filter(item => !source.includes(item))
  return missing.length > 0
    ? {
        label: 'strict agent workflow command surface',
        status: 'fail',
        detail: `${missing.length} missing agent workflow command item(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict agent workflow command surface',
        status: 'pass',
        detail: '/message-action, /schedule, /job, review/security/issue diagnostics, and /parity --strict --agent-workflows are command-routed',
      }
}

function strictAgentWorkflowToolCheck(): HardeningCheck {
  const names = new Set(getBuiltinTools().map(tool => tool.name))
  const required = [
    'Agent',
    'TaskCreate',
    'TaskGet',
    'TaskUpdate',
    'TaskList',
    'TaskOutput',
    'TaskStop',
    'VerificationAgent',
    'VerifyPlanExecution',
    'MessageAction',
    'ReviewArtifact',
    'ReviewArtifactMutation',
    'WorkflowScriptRun',
    'MonitorStart',
    'ScheduleCron',
    'ScheduleCronRunDue',
    'Sleep',
    'BriefCreate',
    'SendMessage',
    'ListPeersTool',
    'TeamCreate',
    'TeamDelete',
    'SuggestBackgroundPR',
    'SubscribePR',
    'JobClassify',
    'WorkflowEvent',
  ]
  const missing = required.filter(name => !names.has(name))
  return missing.length > 0
    ? {
        label: 'strict agent workflow tool surface',
        status: 'fail',
        detail: `${missing.length} missing agent workflow tool(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict agent workflow tool surface',
        status: 'pass',
        detail: 'agent, task, verification, review, workflow, monitor, cron, team, PR, and diagnostic tools are registered',
      }
}

function strictAgentWorkflowTestCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/services/agentWorkflows.test.ts',
    'packages/tools/src/runner.test.ts',
    'packages/tools/src/workflows.test.ts',
    'packages/commands/src/slashCommands.test.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict agent workflow runtime tests',
        status: 'fail',
        detail: `${missing.length} missing agent workflow test file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict agent workflow runtime tests',
        status: 'pass',
        detail: 'agent workflow services, tool registry, legacy workflow tools, and command surfaces are covered by tests',
      }
}

function strictMemoryRuntimeCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/services/memory.ts',
    'packages/tools/src/tools/memoryParity.ts',
    'packages/agent-runtime/src/context.ts',
    'packages/session/src/sessionStore.ts',
    'packages/tools/src/tools/vaultHttpFetch.ts',
    'packages/tools/src/tools/team.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  if (missing.length > 0) {
    return {
      label: 'strict memory runtime',
      status: 'fail',
      detail: `${missing.length} missing memory runtime file(s): ${missing.join(', ')}`,
    }
  }
  const source = required.map(path => safeReadSync(join(cwd, path))).join('\n')
  const symbols = [
    'rankMemoryStoreEntries',
    'readRankedMemorySnippets',
    'extractMemories',
    'writeAgentMemorySnapshot',
    'writeSessionMemorySnapshot',
    'syncTeamMemory',
    'Provider cache breaks',
    'Context collapse',
    'VaultHttpFetch',
    'TeamMemorySync',
  ]
  const missingSymbols = symbols.filter(symbol => !source.includes(symbol))
  return missingSymbols.length > 0
    ? {
        label: 'strict memory runtime',
        status: 'fail',
        detail: `${missingSymbols.length} missing memory runtime symbol(s): ${missingSymbols.join(', ')}`,
      }
    : {
        label: 'strict memory runtime',
        status: 'pass',
        detail: 'context collapse, history/session memory, ranked local memory cache, team memory sync, vault fetch, and provider cache-break injection are present',
      }
}

async function strictMemoryCommandCheck(cwd: string): Promise<HardeningCheck> {
  const slashCommands = await safeRead(join(cwd, 'packages/commands/src/slashCommands.ts'))
  const required = [
    "'--memory'",
    "'/memory'",
    "'/local-memory'",
    "'/memory-stores'",
    "'/vault'",
    "'/local-vault'",
    'rankMemoryStoreEntries',
    'extractMemories',
    'syncTeamMemory',
    'localVaultKeyNames',
  ]
  const missing = required.filter(item => !slashCommands.includes(item))
  return missing.length > 0
    ? {
        label: 'strict memory command surface',
        status: 'fail',
        detail: `${missing.length} missing memory command item(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict memory command surface',
        status: 'pass',
        detail: '/memory rank/extract/sync-team, /vault key listing, and /parity --strict --memory are command-routed',
      }
}

function strictMemoryToolCheck(): HardeningCheck {
  const names = new Set(getBuiltinTools().map(tool => tool.name))
  const required = [
    'LocalMemoryRecall',
    'MemoryRank',
    'ExtractMemories',
    'AgentMemorySnapshot',
    'SessionMemorySnapshot',
    'TeamMemorySync',
    'VaultHttpFetch',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'CtxInspect',
  ]
  const missing = required.filter(name => !names.has(name))
  return missing.length > 0
    ? {
        label: 'strict memory tool surface',
        status: 'fail',
        detail: `${missing.length} missing memory tool(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict memory tool surface',
        status: 'pass',
        detail: 'memory, vault, team, context inspect, and provider-cache diagnostic tools are registered',
      }
}

function strictMemoryTestCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/services/memory.test.ts',
    'packages/agent-runtime/src/context.test.ts',
    'packages/tools/src/runner.test.ts',
    'packages/commands/src/slashCommands.test.ts',
    'packages/session/src/sessionStore.test.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict memory runtime tests',
        status: 'fail',
        detail: `${missing.length} missing memory test file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict memory runtime tests',
        status: 'pass',
        detail: 'memory ranking/cache, context injection, session restore, slash command, and tool runtime tests are present',
      }
}

function strictVoiceAudioPackageCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/audio-capture-napi/package.json',
    'packages/audio-capture-napi/src/index.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict voice audio package',
        status: 'fail',
        detail: `${missing.length} missing audio package item(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict voice audio package',
        status: 'pass',
        detail: 'audio-capture-napi package surface resolves native vendor binaries when present',
      }
}

function strictVoiceRuntimeCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/services/voice/audio.ts',
    'packages/tools/src/services/voice/stream.ts',
    'packages/tools/src/ecosystem.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  if (missing.length > 0) {
    return {
      label: 'strict voice runtime',
      status: 'fail',
      detail: `${missing.length} missing voice runtime file(s): ${missing.join(', ')}`,
    }
  }
  const ecosystem = safeReadSync(join(cwd, 'packages/tools/src/ecosystem.ts'))
  const symbols = [
    'VoiceCheck',
    'VoiceRecordingStart',
    'VoiceRecordingStop',
    'checkVoiceAvailability',
    'getVoiceStreamStatus',
    'connectVoiceStream',
    'TranscriptText',
    'TranscriptEndpoint',
    'CloseStream',
    'deepseek',
  ]
  const source = `${ecosystem}\n${safeReadSync(join(cwd, 'packages/tools/src/services/voice/stream.ts'))}`
  const missingSymbols = symbols.filter(symbol => !source.includes(symbol))
  return missingSymbols.length > 0
    ? {
        label: 'strict voice runtime',
        status: 'fail',
        detail: `${missingSymbols.length} missing voice runtime symbol(s): ${missingSymbols.join(', ')}`,
      }
    : {
        label: 'strict voice runtime',
        status: 'pass',
        detail: 'voice mode checks microphone backend, STT auth, WebSocket STT stream protocol, push-to-talk recording lifecycle, and active sessions',
      }
}

async function strictVoiceCommandCheck(cwd: string): Promise<HardeningCheck> {
  const slashCommands = await safeRead(join(cwd, 'packages/commands/src/slashCommands.ts'))
  const program = await safeRead(join(cwd, 'packages/cli/src/program.ts'))
  const tui = await safeRead(join(cwd, 'packages/tui/src/TuiApp.tsx'))
  const required = [
    "'/voice'",
    "'--voice'",
    'checkVoiceRuntime',
    'startVoiceRuntimeRecording',
    'stopVoiceRuntimeRecording',
    'voiceIndicator',
    'onVoiceShortcut',
  ]
  const source = `${slashCommands}\n${program}\n${tui}`
  const missing = required.filter(symbol => !source.includes(symbol))
  return missing.length > 0
    ? {
        label: 'strict voice command surface',
        status: 'fail',
        detail: `${missing.length} missing voice command item(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict voice command surface',
        status: 'pass',
        detail: '/voice check/on/off/start/stop, TUI indicator/shortcut, and /parity --strict --voice are command-routed',
      }
}

function strictVoiceNotificationCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/services/notifications.ts',
    'packages/tools/src/workflows.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  if (missing.length > 0) {
    return {
      label: 'strict voice notification runtime',
      status: 'fail',
      detail: `${missing.length} missing notification runtime file(s): ${missing.join(', ')}`,
    }
  }
  const source = [
    safeReadSync(join(cwd, 'packages/tools/src/workflows.ts')),
    safeReadSync(join(cwd, 'packages/tools/src/services/notifications.ts')),
  ].join('\n')
  const hookSymbols = [
    'UPSTREAM_NOTIFICATION_HOOKS',
    'startup',
    'settings-errors',
    'mcp-connectivity',
    'plugin-install',
    'plugin-autoupdate',
    'rate-limit',
    'model-migration',
    'npm-deprecation',
    'update',
    'teammate-shutdown',
    'ide-lsp-initialization',
    'fast-mode',
    'subscription-switch',
    'chrome-extension',
    'official-marketplace-recommendation',
    'emitNotificationHook',
    'expireNotifications',
    'dispatchLocalNotification',
    'bodyHash',
    'transport',
  ]
  const missingSymbols = hookSymbols.filter(symbol => !source.includes(symbol))
  return missingSymbols.length > 0
    ? {
        label: 'strict voice notification runtime',
        status: 'fail',
        detail: `${missingSymbols.length} missing notification item(s): ${missingSymbols.join(', ')}`,
      }
    : {
        label: 'strict voice notification runtime',
        status: 'pass',
        detail: 'push notifications attempt OS dispatch and model upstream notification hook lifecycle with secret-safe delivery metadata',
      }
}

function strictVoiceTestCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/ecosystem.test.ts',
    'packages/tools/src/workflows.test.ts',
    'packages/commands/src/slashCommands.test.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict voice runtime tests',
        status: 'fail',
        detail: `${missing.length} missing voice test file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict voice runtime tests',
        status: 'pass',
        detail: 'voice runtime, notification dispatch, slash command, and strict voice gate tests are present',
      }
}

async function strictPlatformBrowserCheck(cwd: string): Promise<HardeningCheck> {
  const browser = await safeRead(join(cwd, 'packages/tools/src/tools/webBrowser.ts'))
  const required = [
    'BrowserSessionRecord',
    "'screenshot'",
    "'click'",
    "'type'",
    "'scroll'",
    'writeScreenshotArtifact',
    'recordBrowserInputEvent',
  ]
  const missing = required.filter(symbol => !browser.includes(symbol))
  if (browser.includes('Text snapshot - visual screenshots require a browser engine')) {
    missing.push('real screenshot artifact replaces text snapshot')
  }
  return missing.length > 0
    ? {
        label: 'strict platform browser runtime',
        status: 'fail',
        detail: `${missing.length} missing browser runtime item(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict platform browser runtime',
        status: 'pass',
        detail: 'WebBrowser has session lifecycle, visual screenshot artifacts, and input events',
      }
}

function strictPlatformComputerUseCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/tools/computerUse.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict platform computer-use runtime',
        status: 'fail',
        detail: `${missing.length} missing computer-use file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict platform computer-use runtime',
        status: 'pass',
        detail: 'ComputerUse and ComputerUseInput tools expose MCP/input/Swift package parity state',
      }
}

function strictPlatformIdeCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/tools/lsp.ts',
    'packages/tools/src/services/lsp/index.ts',
    'packages/tools/src/services/lsp/diagnostics.ts',
    'packages/tools/src/services/lsp/selection.ts',
    'packages/tools/src/services/lsp/logging.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict platform IDE/LSP runtime',
        status: 'fail',
        detail: `${missing.length} missing IDE/LSP file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict platform IDE/LSP runtime',
        status: 'pass',
        detail: 'LSP tool plus IDE diagnostics, selection, diff, and logging services are present',
      }
}

async function strictPlatformCommandCheck(cwd: string): Promise<HardeningCheck> {
  const slashCommands = await safeRead(join(cwd, 'packages/commands/src/slashCommands.ts'))
  const required = [
    'platformCommandPayload',
    "'/chrome'",
    "'/desktop'",
    "'/mobile'",
    "'/install-github-app'",
    "'/install-slack-app'",
    "'/ide'",
    "'/weixin'",
    'MagicDocs',
    'PromptSuggestion',
  ]
  const missing = required.filter(symbol => !slashCommands.includes(symbol))
  return missing.length > 0
    ? {
        label: 'strict platform command surface',
        status: 'fail',
        detail: `${missing.length} missing platform command item(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict platform command surface',
        status: 'pass',
        detail: 'Chrome, desktop, mobile, app install, IDE, Weixin, MagicDocs, and PromptSuggestion surfaces are command-routed',
      }
}

function strictPlatformTestCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tools/src/webBrowser.test.ts',
    'packages/commands/src/slashCommands.test.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict platform runtime tests',
        status: 'fail',
        detail: `${missing.length} missing platform test file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict platform runtime tests',
        status: 'pass',
        detail: 'browser/computer-use and platform command tests are present',
      }
}

function strictTuiInkCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/anthropic-ink/src/renderer.ts',
    'packages/anthropic-ink/src/core/screen.ts',
    'packages/anthropic-ink/src/core/dom.ts',
    'packages/anthropic-ink/src/scrollBox.tsx',
    'packages/anthropic-ink/src/theme/ThemeProvider.tsx',
    'packages/anthropic-ink/src/noSelect.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict TUI Ink internals',
        status: 'fail',
        detail: `${missing.length} missing Ink runtime file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict TUI Ink internals',
        status: 'pass',
        detail: 'renderer, screen, DOM, ScrollBox, ThemeProvider, and NoSelect internals are present',
      }
}

function strictTuiComponentCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tui/src/TuiApp.tsx',
    'packages/tui/src/runInkTui.tsx',
    'packages/tui/src/components/StatusLine.tsx',
    'packages/tui/src/components/MessageList.tsx',
    'packages/tui/src/components/PromptInput.tsx',
    'packages/tui/src/components/PermissionPanel.tsx',
    'packages/tui/src/components/OverlayStack.tsx',
    'packages/tui/src/components/InfoScreen.tsx',
    'packages/tui/src/components/ThemePicker.tsx',
    'packages/tui/src/components/ResumePicker.tsx',
    'packages/tui/src/components/CheckpointPicker.tsx',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict TUI component surface',
        status: 'fail',
        detail: `${missing.length} missing TUI component file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict TUI component surface',
        status: 'pass',
        detail: 'app shell, status line, message list, prompt, permission modal, overlay stack, pickers, and command screens are present',
      }
}

async function strictTuiSurfaceCheck(cwd: string): Promise<HardeningCheck> {
  const requiredSymbols = [
    'buildHelpV2Screen',
    'collectSettingsScreen',
    'collectTrustScreen',
    'buildOnboardingScreen',
    'buildWizardScreen',
    'collectSandboxScreen',
    'buildNativeImagePasteScreen',
  ]
  const requiredRoutes = [
    "'/help'",
    "'/settings'",
    "'/trust'",
    "'/onboarding'",
    "'/wizard'",
    "'/sandbox'",
    "'/paste-image'",
  ]
  const screens = await safeRead(join(cwd, 'packages/commands/src/screens.ts'))
  const tui = await safeRead(join(cwd, 'packages/tui/src/TuiApp.tsx'))
  const missingSymbols = requiredSymbols.filter(symbol => !screens.includes(symbol))
  const missingRoutes = requiredRoutes.filter(route => !tui.includes(route))
  const missing = [...missingSymbols, ...missingRoutes]

  return missing.length > 0
    ? {
        label: 'strict TUI upstream surface',
        status: 'fail',
        detail: `${missing.length} missing upstream surface item(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict TUI upstream surface',
        status: 'pass',
        detail: 'HelpV2, settings, trust/onboarding, wizard, sandbox, and native image paste surfaces are routed through TUI overlays',
      }
}

function strictTuiTestCheck(cwd: string): HardeningCheck {
  const required = [
    'packages/tui/src/terminalApp.test.ts',
    'packages/tui/src/promptEditing.test.ts',
    'packages/tui/src/permissionQueue.test.ts',
    'packages/tui/src/screenSelection.test.ts',
    'packages/tui/src/scrollBox.test.ts',
    'packages/anthropic-ink/src/core/dom.test.ts',
    'packages/anthropic-ink/src/core/screen.test.ts',
    'packages/anthropic-ink/src/theme/ThemeProvider.test.ts',
  ]
  const missing = required.filter(path => !existsSync(join(cwd, path)))
  return missing.length > 0
    ? {
        label: 'strict TUI runtime tests',
        status: 'fail',
        detail: `${missing.length} missing TUI test file(s): ${missing.join(', ')}`,
      }
    : {
        label: 'strict TUI runtime tests',
        status: 'pass',
        detail: 'TTY launch, prompt editing, permissions, selection, ScrollBox, renderer DOM, screen, and theme tests are present',
      }
}

function strictCommandBehaviorCheck(genericSlashCommandNames: readonly string[] | undefined): HardeningCheck {
  const genericCommands = genericSlashCommandNames ?? []
  return genericCommands.length > 0
    ? {
        label: 'strict command behavior',
        status: 'fail',
        detail: `${genericCommands.length} registered upstream command surface(s) still use generic pending-real-runtime behavior: ${genericCommands.slice(0, 20).join(', ')}`,
      }
    : {
        label: 'strict command behavior',
        status: 'pass',
        detail: 'all registered upstream commands have command-specific runtime handlers',
      }
}

async function readStrictParityManifest(cwd: string): Promise<{
  path: string
  data?: StrictParityManifest
  error?: string
}> {
  const manifestPath = join(cwd, 'docs', 'strict-parity-manifest.json')
  if (!existsSync(manifestPath)) {
    return {
      path: manifestPath,
      error: 'docs/strict-parity-manifest.json not found',
    }
  }

  try {
    const data = JSON.parse(await readFile(manifestPath, 'utf8')) as StrictParityManifest
    return { path: manifestPath, data }
  } catch (error) {
    return {
      path: manifestPath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function strictManifestCheck(manifest: {
  data?: StrictParityManifest
  error?: string
}): HardeningCheck {
  if (manifest.error) {
    return {
      label: 'strict parity manifest',
      status: 'fail',
      detail: manifest.error,
    }
  }
  if (manifest.data?.schemaVersion !== 1) {
    return {
      label: 'strict parity manifest',
      status: 'fail',
      detail: 'manifest schemaVersion must be 1',
    }
  }
  return {
    label: 'strict parity manifest',
    status: 'pass',
    detail: 'docs/strict-parity-manifest.json loaded',
  }
}

async function strictCommandInventoryCheck(
  cwd: string,
  slashCommandNames: readonly string[] | undefined,
  manifest: StrictParityManifest | undefined,
): Promise<HardeningCheck> {
  const upstreamRoot = join(cwd, 'claude-code', 'src', 'commands')
  if (!existsSync(upstreamRoot)) {
    return {
      label: 'strict command inventory',
      status: 'fail',
      detail: 'claude-code/src/commands not found',
    }
  }
  if (!slashCommandNames) {
    return {
      label: 'strict command inventory',
      status: 'fail',
      detail: 'local slash command names were not provided',
    }
  }

  const upstream = await listCommandModules(upstreamRoot)
  const local = new Set(slashCommandNames.map(command => command.replace(/^\//, '')))
  const aliases = manifest?.commandAliases ?? {}
  const missing = upstream.filter(command => !local.has(command) && !local.has(aliases[command] ?? ''))

  return missing.length > 0
    ? {
        label: 'strict command inventory',
        status: 'fail',
        detail: `${missing.length} upstream command module(s) missing: ${missing.slice(0, 20).join(', ')}`,
      }
    : {
        label: 'strict command inventory',
        status: 'pass',
        detail: `${upstream.length} upstream command module(s) mapped`,
      }
}

async function strictPackageInventoryCheck(
  cwd: string,
  manifest: StrictParityManifest | undefined,
): Promise<HardeningCheck> {
  const upstreamRoot = join(cwd, 'claude-code', 'packages')
  const localRoot = join(cwd, 'packages')
  if (!existsSync(upstreamRoot)) {
    return {
      label: 'strict package inventory',
      status: 'fail',
      detail: 'claude-code/packages not found',
    }
  }
  const upstream = await listWorkspacePackages(upstreamRoot)
  const local = existsSync(localRoot)
    ? new Set(await listWorkspacePackages(localRoot))
    : new Set<string>()
  const mappings = manifest?.packageMappings ?? {}
  const missing = upstream.filter(pkg => {
    const mapped = mappings[pkg]
    return !local.has(pkg) && !(mapped && local.has(mapped))
  })

  return missing.length > 0
    ? {
        label: 'strict package inventory',
        status: 'fail',
        detail: `${missing.length} upstream package(s) missing: ${missing.slice(0, 20).join(', ')}`,
      }
    : {
        label: 'strict package inventory',
        status: 'pass',
        detail: `${upstream.length} upstream package(s) mapped`,
      }
}

async function strictSourceInventoryCheck(
  cwd: string,
  manifest: StrictParityManifest | undefined,
): Promise<HardeningCheck> {
  const upstreamRoot = join(cwd, 'claude-code', 'src')
  if (!existsSync(upstreamRoot)) {
    return {
      label: 'strict source inventory',
      status: 'fail',
      detail: 'claude-code/src not found',
    }
  }

  const upstream = await listSourceInventoryItems(upstreamRoot)
  const mappings = manifest?.sourceMappings ?? {}
  const missing = upstream.filter(item => !hasStrictSourceMapping(cwd, item, mappings))

  return missing.length > 0
    ? {
        label: 'strict source inventory',
        status: 'fail',
        detail: `${missing.length} upstream source item(s) missing manifest mapping: ${missing.slice(0, 20).join(', ')}`,
      }
    : {
        label: 'strict source inventory',
        status: 'pass',
        detail: `${upstream.length} upstream source item(s) mapped`,
      }
}

function hasStrictSourceMapping(
  cwd: string,
  item: string,
  mappings: Record<string, string>,
): boolean {
  const target = mappings[item] ?? Object.entries(mappings)
    .filter(([upstream]) => upstream.endsWith('/') && item.startsWith(upstream))
    .sort(([left], [right]) => right.length - left.length)
    .at(0)?.[1]

  return Boolean(target && existsSync(join(cwd, target)))
}

async function strictToolInventoryCheck(
  cwd: string,
  manifest: StrictParityManifest | undefined,
): Promise<HardeningCheck> {
  const upstreamRoot = join(cwd, 'claude-code', 'packages', 'builtin-tools', 'src', 'tools')
  if (!existsSync(upstreamRoot)) {
    return {
      label: 'strict tool inventory',
      status: 'fail',
      detail: 'claude-code/packages/builtin-tools/src/tools not found',
    }
  }

  const local = new Set([
    ...getBuiltinTools().map(tool => tool.name),
    ...getExtensionToolSurfaceNames(),
  ])
  const aliases = manifest?.toolAliases ?? {}
  const upstream = await listBuiltinToolModules(upstreamRoot)
  const missing = upstream.filter(tool => !local.has(tool) && !local.has(aliases[tool] ?? ''))

  if (Object.keys(aliases).length === 0) {
    return {
      label: 'strict tool inventory',
      status: 'fail',
      detail: 'manifest has no toolAliases; builtin tool inventory is not mapped',
    }
  }

  return missing.length > 0
    ? {
        label: 'strict tool inventory',
        status: 'fail',
        detail: `${missing.length} upstream tool(s) missing: ${missing.slice(0, 20).join(', ')}`,
      }
    : {
        label: 'strict tool inventory',
        status: 'pass',
        detail: `${upstream.length} upstream tool module(s) mapped to ${local.size} local builtin tools`,
      }
}

function strictFeatureParityCheck(): HardeningCheck {
  const notCovered = FEATURE_FLAG_MATRIX.filter(record => record.parityState !== 'Covered')
  return notCovered.length > 0
    ? {
        label: 'strict feature parity',
        status: 'fail',
        detail: `${notCovered.length} non-covered feature(s): ${notCovered.slice(0, 20).map(record => `${record.name}:${record.parityState}`).join(', ')}`,
      }
    : {
        label: 'strict feature parity',
        status: 'pass',
        detail: `${FEATURE_FLAG_MATRIX.length} feature(s) fully covered`,
      }
}

async function readStrictScanText(cwd: string): Promise<string> {
  const paths = [
    join(cwd, 'docs', '10-source-coverage-ledger.md'),
    join(cwd, 'docs', '11-strict-1to1-parity-roadmap.md'),
  ]
  const parts: string[] = []
  for (const path of paths) {
    if (existsSync(path)) {
      parts.push(await readFile(path, 'utf8'))
    }
  }
  return parts.join('\n')
}

function strictShimDetectorCheck(text: string): HardeningCheck {
  const patterns = [
    /local-stub/gi,
    /ssh-mock/gi,
    /without network/gi,
    /no socket/gi,
    /record only/gi,
    /plan only/gi,
    /local record/gi,
    /mock transport/gi,
  ]
  const counts = Object.fromEntries(
    patterns
      .map(pattern => [pattern.source.replace(/\\/g, ''), (text.match(pattern) ?? []).length] as const)
      .filter(([, count]) => count > 0),
  )

  return Object.keys(counts).length > 0
    ? {
        label: 'strict shim detector',
        status: 'fail',
        detail: `shim evidence remains: ${formatCounts(counts)}`,
      }
    : {
        label: 'strict shim detector',
        status: 'pass',
        detail: 'no strict shim markers found in parity docs',
      }
}

function strictEntrypointCheck(
  cwd: string,
  manifest: StrictParityManifest | undefined,
): HardeningCheck {
  return strictMappingCheck({
    label: 'strict entrypoint inventory',
    cwd,
    upstreamItems: [
      'claude-code/src/entrypoints/cli.tsx',
      'claude-code/src/entrypoints/mcp.ts',
      'claude-code/src/entrypoints/agentSdkTypes.ts',
      'claude-code/src/entrypoints/sandboxTypes.ts',
      'claude-code/src/entrypoints/sdk/',
    ],
    mappings: manifest?.entrypointMappings,
  })
}

function strictCliTransportCheck(
  cwd: string,
  manifest: StrictParityManifest | undefined,
): HardeningCheck {
  return strictMappingCheck({
    label: 'strict CLI transport inventory',
    cwd,
    upstreamItems: [
      'claude-code/src/cli/print.ts',
      'claude-code/src/cli/structuredIO.ts',
      'claude-code/src/cli/remoteIO.ts',
      'claude-code/src/cli/transports/SSETransport.ts',
      'claude-code/src/cli/transports/WebSocketTransport.ts',
      'claude-code/src/cli/transports/HybridTransport.ts',
      'claude-code/src/cli/transports/SerialBatchEventUploader.ts',
      'claude-code/src/cli/transports/WorkerStateUploader.ts',
      'claude-code/src/cli/bg/',
      'claude-code/src/cli/handlers/',
    ],
    mappings: manifest?.cliTransportMappings,
  })
}

function strictSchemaCheck(
  cwd: string,
  manifest: StrictParityManifest | undefined,
): HardeningCheck {
  return strictMappingCheck({
    label: 'strict schema inventory',
    cwd,
    upstreamItems: [
      'claude-code/src/types/',
      'claude-code/src/schemas/',
      'claude-code/src/entrypoints/sdk/coreSchemas.ts',
      'claude-code/src/entrypoints/sdk/controlSchemas.ts',
      'claude-code/src/entrypoints/sdk/coreTypes.ts',
      'claude-code/src/entrypoints/sdk/runtimeTypes.ts',
      'claude-code/src/entrypoints/sdk/toolTypes.ts',
    ],
    mappings: manifest?.schemaMappings,
  })
}

function strictMappingCheck(args: {
  label: string
  cwd: string
  upstreamItems: string[]
  mappings: Record<string, string> | undefined
}): HardeningCheck {
  const existing = args.upstreamItems.filter(item => existsSync(join(args.cwd, item)))
  const mappings = args.mappings ?? {}
  const missing = existing.filter(item => !mappings[item])

  return missing.length > 0
    ? {
        label: args.label,
        status: 'fail',
        detail: `${missing.length} upstream item(s) missing manifest mapping: ${missing.join(', ')}`,
      }
    : {
        label: args.label,
        status: 'pass',
        detail: `${existing.length} upstream item(s) mapped`,
      }
}

function fullFeatureParityCheck(): HardeningCheck {
  const planned = FEATURE_FLAG_MATRIX.filter(record => record.parityState === 'Planned')
  const userVisibleDisabled = FEATURE_FLAG_MATRIX.filter(
    record => record.userVisible && record.parityState === 'Disabled-Parity',
  )
  const blockers = [
    planned.length > 0 ? `planned=${planned.length} (${planned.slice(0, 8).map(record => record.name).join(', ')})` : '',
    userVisibleDisabled.length > 0
      ? `user-visible-disabled=${userVisibleDisabled.length} (${userVisibleDisabled.slice(0, 8).map(record => record.name).join(', ')})`
      : '',
  ].filter(Boolean)

  return blockers.length > 0
    ? {
        label: 'full ecosystem feature parity',
        status: 'fail',
        detail: blockers.join('; '),
      }
    : {
        label: 'full ecosystem feature parity',
        status: 'pass',
        detail: 'no planned or user-visible Disabled-Parity features remain',
      }
}

async function fullEcosystemLedgerCheck(cwd: string): Promise<HardeningCheck> {
  const ledgerPath = join(cwd, 'docs', '10-source-coverage-ledger.md')
  if (!existsSync(ledgerPath)) {
    return {
      label: 'full ecosystem ledger',
      status: 'fail',
      detail: 'docs/10-source-coverage-ledger.md not found',
    }
  }

  const rawContent = await readFile(ledgerPath, 'utf8')
  const content = rawContent.split('\n## V1.1 Full Ecosystem Gate\n', 1)[0] ?? rawContent
  const unfinishedPatterns = [
    /Covered for MVP/gi,
    /MVP-only/gi,
    /disabled\/full-parity/gi,
    /full-parity follow-up/gi,
    /deferred/gi,
    /later/gi,
    /pending/gi,
    /Planned:/g,
  ]
  const counts = Object.fromEntries(
    unfinishedPatterns
      .map(pattern => [pattern.source.replace(/\\/g, ''), (content.match(pattern) ?? []).length] as const)
      .filter(([, count]) => count > 0),
  )

  return Object.keys(counts).length > 0
    ? {
        label: 'full ecosystem ledger',
        status: 'fail',
        detail: `unfinished evidence remains: ${formatCounts(counts)}`,
      }
    : {
        label: 'full ecosystem ledger',
        status: 'pass',
        detail: 'ledger evidence has no MVP/deferred/full-parity placeholders',
      }
}

async function sourceInventoryDiffCheck(cwd: string): Promise<HardeningCheck> {
  const upstreamRoot = join(cwd, 'claude-code')
  const ledgerPath = join(cwd, 'docs', '10-source-coverage-ledger.md')
  if (!existsSync(upstreamRoot)) {
    return {
      label: 'source inventory diff',
      status: 'fail',
      detail: 'claude-code source tree not found',
    }
  }
  if (!existsSync(ledgerPath)) {
    return {
      label: 'source inventory diff',
      status: 'fail',
      detail: 'docs/10-source-coverage-ledger.md not found',
    }
  }

  const [items, ledger] = await Promise.all([
    listUpstreamInventoryItems(upstreamRoot),
    readFile(ledgerPath, 'utf8'),
  ])
  const missing = items.filter(item => !ledger.includes(item))

  return missing.length > 0
    ? {
        label: 'source inventory diff',
        status: 'fail',
        detail: `${missing.length} upstream inventory item(s) missing from ledger: ${missing.slice(0, 12).join(', ')}`,
      }
    : {
        label: 'source inventory diff',
        status: 'pass',
        detail: `${items.length} upstream inventory item(s) mapped in ledger`,
      }
}

async function ledgerReadinessCheck(cwd: string): Promise<HardeningCheck> {
  const ledgerPath = join(cwd, 'docs', '10-source-coverage-ledger.md')
  if (!existsSync(ledgerPath)) {
    return {
      label: 'coverage ledger',
      status: 'fail',
      detail: 'docs/10-source-coverage-ledger.md not found',
    }
  }

  const content = await readFile(ledgerPath, 'utf8')
  const blockers = [...content.matchAll(/\|\s*`?[^|\n]+`?\s*\|\s*[^|\n]+\|\s*[^|\n]+\|\s*(Planned|In Progress|RED)\s*\|/g)]
    .map(match => match[1])
  if (blockers.length > 0) {
    const counts = countValues(blockers)
    return {
      label: 'coverage ledger',
      status: 'fail',
      detail: `V1.0 blockers remain: ${formatCounts(counts)}`,
    }
  }

  return {
    label: 'coverage ledger',
    status: 'pass',
    detail: 'all ledger status rows are release-acceptable',
  }
}

async function featureMatrixCheck(cwd: string): Promise<HardeningCheck> {
  const sourceRoot = join(cwd, 'claude-code')
  const discovered = existsSync(sourceRoot)
    ? await scanFeatureCallsFromFiles(sourceRoot)
    : []
  const audit = validateFeatureFlagMatrix(discovered)
  const failures = [
    ...audit.missing.map(feature => `missing:${feature}`),
    ...audit.missingDefaultBuildFeatures.map(feature => `missing-default:${feature}`),
    ...audit.invalidRuntimeDefaults.map(feature => `invalid-default:${feature}`),
    ...audit.nonSecretSafeDefaults.map(feature => `non-secret-safe:${feature}`),
  ]

  if (failures.length > 0) {
    return {
      label: 'feature matrix',
      status: 'fail',
      detail: failures.slice(0, 10).join(', '),
    }
  }

  return {
    label: 'feature matrix',
    status: 'pass',
    detail: `${FEATURE_FLAG_MATRIX.length} registered features, ${discovered.length} source calls audited`,
  }
}

async function bundleIntegrityCheck(cwd: string): Promise<HardeningCheck> {
  const artifactPath = join(cwd, 'dist', 'cli.js')
  try {
    const artifact = await stat(artifactPath)
    await access(artifactPath)
    if (artifact.size < 100_000) {
      return {
        label: 'bundle integrity',
        status: 'fail',
        detail: `dist/cli.js is unexpectedly small (${artifact.size} bytes)`,
      }
    }
    return {
      label: 'bundle integrity',
      status: 'pass',
      detail: `dist/cli.js exists (${artifact.size} bytes)`,
    }
  } catch {
    return {
      label: 'bundle integrity',
      status: 'warning',
      detail: 'dist/cli.js not built yet; run bun run build',
    }
  }
}

async function bundleSmokeCheck(cwd: string, version: string): Promise<HardeningCheck> {
  const artifactPath = join(cwd, 'dist', 'cli.js')
  if (!existsSync(artifactPath)) {
    return {
      label: 'production smoke',
      status: 'warning',
      detail: 'skipped because dist/cli.js is missing',
    }
  }

  try {
    const { stdout } = await execFileAsync(process.execPath, [artifactPath, '--version'], {
      cwd,
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    })
    const output = stdout.trim()
    return output === version || output.startsWith(`${version} `)
      ? {
          label: 'production smoke',
          status: 'pass',
          detail: `node dist/cli.js --version => ${output}`,
        }
      : {
          label: 'production smoke',
          status: 'fail',
          detail: `expected ${version}, got ${output || '(empty)'}`,
        }
  } catch (error) {
    return {
      label: 'production smoke',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function doctorHealthCheck(
  cwd: string,
  version: string,
  env: Record<string, string | undefined>,
): Promise<HardeningCheck> {
  const doctor = await collectDoctorScreen({ cwd, version, env })
  const checks = doctor.checks ?? []
  const errors = checks.filter(check => check.status === 'error')
  const warnings = checks.filter(check => check.status === 'warning')
  if (errors.length > 0) {
    return {
      label: 'doctor health',
      status: 'fail',
      detail: `${errors.length} error(s): ${errors.map(error => error.label).join(', ')}`,
    }
  }
  if (warnings.length > 0) {
    return {
      label: 'doctor health',
      status: 'pass',
      detail: `${warnings.length} non-blocking warning(s): ${warnings.map(warning => warning.label).join(', ')}`,
    }
  }
  return {
    label: 'doctor health',
    status: 'pass',
    detail: `${checks.length} doctor checks passed`,
  }
}

function toolRegistryCheck(): HardeningCheck {
  const tools = getBuiltinTools()
  return tools.length > 0
    ? {
        label: 'tool registry',
        status: 'pass',
        detail: `${tools.length} builtin tools registered`,
      }
    : {
        label: 'tool registry',
        status: 'fail',
        detail: 'no builtin tools registered',
      }
}

function slashCommandRegistryCheck(count: number | undefined): HardeningCheck {
  if (count === undefined) {
    return {
      label: 'slash command registry',
      status: 'warning',
      detail: 'slash command count was not provided',
    }
  }
  return count > 0
    ? {
        label: 'slash command registry',
        status: 'pass',
        detail: `${count} slash commands registered`,
      }
    : {
        label: 'slash command registry',
        status: 'fail',
        detail: 'no slash commands registered',
      }
}

function secretSafetyCheck(env: Record<string, string | undefined>): HardeningCheck {
  const configured = [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ].filter(name => Boolean(env[name]))

  return {
    label: 'secret safety',
    status: 'pass',
    detail: configured.length > 0
      ? `${configured.length} secret env var(s) detected by name only`
      : 'no known secret env vars configured',
  }
}

async function scanFeatureCallsFromFiles(root: string): Promise<string[]> {
  const features = new Set<string>()
  for (const file of await listSourceFiles(root)) {
    for (const feature of scanFeatureCallsFromText(await readFile(file, 'utf8'))) {
      features.add(feature)
    }
  }
  return [...features].sort()
}

async function listSourceFiles(root: string): Promise<string[]> {
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
  const files: string[] = []
  for (const entry of await readdir(root)) {
    if (ignored.has(entry)) {
      continue
    }
    const path = join(root, entry)
    const fileStat = await stat(path)
    if (fileStat.isDirectory()) {
      files.push(...await listSourceFiles(path))
      continue
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

async function listUpstreamInventoryItems(root: string): Promise<string[]> {
  const items: string[] = []
  const srcRoot = join(root, 'src')
  const packageRoot = join(root, 'packages')

  if (existsSync(srcRoot)) {
    for (const entry of await readdir(srcRoot)) {
      if (entry.startsWith('.')) {
        continue
      }
      const path = join(srcRoot, entry)
      const entryStat = await stat(path)
      items.push(entryStat.isDirectory()
        ? `claude-code/src/${entry}/`
        : `claude-code/src/${entry}`)
    }
  }

  if (existsSync(packageRoot)) {
    for (const entry of await readdir(packageRoot)) {
      if (entry.startsWith('.')) {
        continue
      }
      const path = join(packageRoot, entry)
      const entryStat = await stat(path)
      if (entryStat.isDirectory()) {
        items.push(`claude-code/packages/${entry}/`)
      }
    }
  }

  return items.sort()
}

async function listCommandModules(root: string): Promise<string[]> {
  const modules: string[] = []
  for (const entry of await readdir(root)) {
    if (entry.startsWith('.') || entry === '__tests__' || entry === '_shared') {
      continue
    }
    const path = join(root, entry)
    const entryStat = await stat(path)
    if (entryStat.isDirectory()) {
      const commandName = await readCommandNameFromDirectory(path)
      if (commandName) {
        modules.push(commandName)
      }
      continue
    }
    if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      const commandName = await readCommandNameFromFile(path)
      if (commandName) {
        modules.push(commandName)
      }
    }
  }
  return [...new Set(modules)].sort()
}

async function readCommandNameFromDirectory(path: string): Promise<string | undefined> {
  for (const candidate of ['index.ts', 'index.tsx', 'index.js', 'index.jsx', `${basename(path)}.ts`, `${basename(path)}.tsx`]) {
    const candidatePath = join(path, candidate)
    if (!existsSync(candidatePath)) {
      continue
    }
    const name = await readCommandNameFromFile(candidatePath)
    if (name) {
      return name
    }
  }
  return basename(path)
}

async function readCommandNameFromFile(path: string): Promise<string | undefined> {
  const content = await readFile(path, 'utf8')
  if (/isHidden:\s*true/.test(content) && /name:\s*['"]stub['"]/.test(content)) {
    return undefined
  }
  if (!/export\s+default|const\s+\w+|function\s+\w+/.test(content)) {
    return undefined
  }
  const nameMatches = [...content.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)]
  const name = nameMatches.at(-1)?.[1]
  if (name && name !== 'stub') {
    return name
  }
  if (/export\s+default/.test(content)) {
    return basename(path, extname(path))
  }
  return undefined
}

async function listWorkspacePackages(root: string): Promise<string[]> {
  const packages: string[] = []
  for (const entry of await readdir(root)) {
    if (entry.startsWith('.') || entry === 'node_modules') {
      continue
    }
    const path = join(root, entry)
    const entryStat = await stat(path)
    if (!entryStat.isDirectory()) {
      continue
    }
    if (entry.startsWith('@')) {
      for (const scopedEntry of await readdir(path)) {
        if (scopedEntry.startsWith('.')) {
          continue
        }
        const scopedPath = join(path, scopedEntry)
        if ((await stat(scopedPath)).isDirectory()) {
          packages.push(`${entry}/${scopedEntry}`)
        }
      }
      continue
    }
    packages.push(entry)
  }
  return packages.sort()
}

async function listBuiltinToolModules(root: string): Promise<string[]> {
  const modules: string[] = []
  for (const entry of await readdir(root)) {
    if (entry.startsWith('.') || entry === 'shared' || entry === 'src' || entry === 'testing') {
      continue
    }
    const path = join(root, entry)
    const entryStat = await stat(path)
    if (entryStat.isDirectory()) {
      modules.push(entry)
    }
  }
  return modules.sort()
}

async function listSourceInventoryItems(root: string): Promise<string[]> {
  const items: string[] = []
  for (const entry of await readdir(root)) {
    if (entry.startsWith('.') || entry === 'node_modules') {
      continue
    }
    const path = join(root, entry)
    const entryStat = await stat(path)
    const topLevel = entryStat.isDirectory()
      ? `claude-code/src/${entry}/`
      : `claude-code/src/${entry}`
    items.push(topLevel)

    if (!entryStat.isDirectory()) {
      continue
    }
    for (const child of await readdir(path)) {
      if (child.startsWith('.') || child === 'node_modules' || child === '__tests__') {
        continue
      }
      const childPath = join(path, child)
      const childStat = await stat(childPath)
      items.push(childStat.isDirectory()
        ? `claude-code/src/${entry}/${child}/`
        : `claude-code/src/${entry}/${child}`)
    }
  }
  return [...new Set(items)].sort()
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function safeReadSync(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(', ')
}
