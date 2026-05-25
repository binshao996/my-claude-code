import { execFile } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  SessionMetadata,
  SessionRestorePlan,
} from '@my-claude-code/session'
import {
  buildSessionGraph,
  fileSnapshotRoot,
  sessionRoot,
} from '@my-claude-code/session'
import {
  loadSettingsWithSources,
  localProjectSettingsPath,
  managedSettingsPath,
  projectSettingsPath,
  settingsSourceCandidates,
  SettingsSchema,
  THEME_NAMES,
  type ThemeName,
} from '@my-claude-code/settings'
import { getBuiltinTools } from '@my-claude-code/tools'

const execFileAsync = promisify(execFile)

export type CommandScreen = {
  title: string
  rows?: Array<{
    label: string
    value: string
  }>
  items?: string[]
  checks?: Array<{
    label: string
    status: 'ok' | 'warning' | 'error'
    detail?: string
  }>
  footer?: string
}

export function buildDoctorScreen(args: {
  cwd: string
  version: string
  model: string
  permissionMode: string
  tui?: string
  provider?: string
  toolCount?: number
  settingsSources?: string[]
  checks?: CommandScreen['checks']
}): CommandScreen {
  const status = summarizeCheckStatus(args.checks)
  return {
    title: 'Doctor',
    rows: [
      { label: 'status', value: status },
      { label: 'version', value: args.version },
      { label: 'cwd', value: args.cwd },
      { label: 'model', value: args.model },
      { label: 'permissionMode', value: args.permissionMode },
      { label: 'tui', value: args.tui ?? 'react-ink' },
      { label: 'provider', value: args.provider ?? 'deepseek-v4-flash' },
      ...(args.toolCount === undefined
        ? []
        : [{ label: 'toolCount', value: String(args.toolCount) }]),
      ...(args.settingsSources
        ? [{ label: 'settingsSources', value: args.settingsSources.join(', ') || '(none)' }]
        : []),
    ],
    checks: args.checks,
    footer: 'Esc closes this screen in TUI.',
  }
}

export async function collectDoctorScreen(args: {
  cwd: string
  version: string
  model?: string
  permissionMode?: string
  env?: Record<string, string | undefined>
}): Promise<CommandScreen> {
  const env = args.env ?? process.env
  const settingsResult = await safeLoadSettings(args.cwd)
  const toolCount = getBuiltinTools().length

  return buildDoctorScreen({
    cwd: args.cwd,
    version: args.version,
    model:
      args.model ??
      settingsResult.settings?.settings.model ??
      'deepseek-v4-flash',
    permissionMode:
      args.permissionMode ??
      settingsResult.settings?.settings.permissionMode ??
      'default',
    settingsSources: settingsResult.ok
      ? settingsResult.settings.sources
        .filter(source => source.exists)
        .map(source => source.kind)
      : [],
    toolCount,
    checks: [
      await accessCheck(args.cwd, constants.R_OK, 'cwd readable'),
      await accessCheck(args.cwd, constants.W_OK, 'cwd writable'),
      optionalRuntimeCheck('node runtime', process.versions.node),
      optionalRuntimeCheck('bun runtime', process.versions.bun),
      installationTypeCheck(args.cwd, env),
      invokedBinaryCheck(),
      execPathCheck(),
      autoUpdateCheck(env),
      await packageManagerCheck(args.cwd),
      await commandVersionCheck('rg', ['--version'], 'ripgrep'),
      pathLookupCheck('my-claude-code', env),
      pathLookupCheck('claude', env),
      shellCheck(env),
      await optionalPathCheck(
        sessionRoot(args.cwd),
        'session root',
        'not created yet',
      ),
      await sessionGraphCheck(args.cwd),
      await optionalPathCheck(
        fileSnapshotRoot(args.cwd),
        'file snapshot store',
        'not created yet',
      ),
      await optionalPathCheck(
        projectSettingsPath(args.cwd),
        'project settings',
        'not created yet',
      ),
      await optionalPathCheck(
        localProjectSettingsPath(args.cwd),
        'local project settings',
        'not created yet',
      ),
      await managedPolicyCheck(env),
      ...(await settingsSourceChecks(args.cwd, env)),
      permissionRuleCoverageCheck(
        settingsResult.ok ? settingsResult.settings.settings : undefined,
      ),
      await contextFileCheck(args.cwd),
      await mcpConfigCheck(args.cwd),
      await optionalPathCheck(
        join(args.cwd, '.claude', 'settings.json'),
        'claude settings',
        'not found',
      ),
      await optionalPathCheck(join(args.cwd, '.git'), 'git worktree', 'not detected'),
      await gitHeadCheck(args.cwd),
      await packageManifestCheck(args.cwd),
      await optionalPathCheck(join(args.cwd, 'dist', 'cli.js'), 'dist cli', 'not built'),
      {
        label: 'provider endpoint',
        status: 'ok',
        detail: 'https://api.deepseek.com/chat/completions',
      },
      settingsResult.ok
        ? {
            label: 'settings',
            status: 'ok',
            detail: `${settingsResult.settings.sources.filter(source => source.exists).length} source(s) loaded`,
          }
        : {
            label: 'settings',
            status: 'error',
            detail: settingsResult.error,
          },
      env.DEEPSEEK_API_KEY
        ? {
            label: 'DEEPSEEK_API_KEY',
            status: 'ok',
            detail: 'configured',
          }
        : {
            label: 'DEEPSEEK_API_KEY',
            status: 'warning',
            detail: 'not set',
          },
      providerEnvironmentCheck(env),
      {
        label: 'NODE_ENV',
        status: 'ok',
        detail: env.NODE_ENV || 'unset',
      },
      toolCount > 0
        ? {
            label: 'tool registry',
            status: 'ok',
            detail: `${toolCount} tools`,
          }
        : {
            label: 'tool registry',
            status: 'error',
            detail: 'empty',
          },
    ],
  })
}

export function buildThemeScreen(
  activeTheme: ThemeName = 'default',
  footer = 'Use /theme <name> to switch and persist the project theme.',
): CommandScreen {
  return {
    title: 'Theme',
    rows: [
      { label: 'active', value: activeTheme },
      { label: 'available', value: THEME_NAMES.join(', ') },
      {
        label: 'preview',
        value: themePreview(activeTheme),
      },
    ],
    items: THEME_NAMES.map(theme =>
      `${theme === activeTheme ? '*' : ' '} ${theme}`,
    ).concat(
      '',
      ...themePreviewRows(activeTheme).map(row =>
        `preview ${row.label}: ${row.value}`,
      ),
    ),
    footer,
  }
}

export function buildHelpV2Screen(args: {
  commandNames: readonly string[]
  descriptions: Record<string, string>
  filter?: string
}): CommandScreen {
  const filter = args.filter?.trim().toLowerCase() ?? ''
  const visibleCommands = args.commandNames
    .filter(command =>
      !filter ||
      command.toLowerCase().includes(filter) ||
      (args.descriptions[command] ?? '').toLowerCase().includes(filter),
    )
    .sort((left, right) => left.localeCompare(right))

  return {
    title: 'Help',
    rows: [
      { label: 'version', value: 'HelpV2' },
      { label: 'commands', value: `${visibleCommands.length}/${args.commandNames.length}` },
      ...(filter ? [{ label: 'filter', value: filter }] : []),
    ],
    items: visibleCommands.map(command =>
      `${command.padEnd(24)} ${args.descriptions[command] ?? 'Upstream Claude Code command'}`,
    ),
    footer: 'Type a slash command to run it. Esc closes this screen in TUI.',
  }
}

export async function collectSettingsScreen(args: {
  cwd: string
  env?: Record<string, string | undefined>
}): Promise<CommandScreen> {
  try {
    const loaded = await loadSettingsWithSources(args.cwd, args.env)
    const effective = SettingsSchema.parse(loaded.settings)
    return {
      title: 'Settings',
      rows: [
        { label: 'cwd', value: args.cwd },
        { label: 'model', value: effective.model ?? '(default)' },
        { label: 'permissionMode', value: effective.permissionMode ?? 'default' },
        { label: 'theme', value: effective.theme ?? 'default' },
        { label: 'outputStyle', value: effective.outputStyle ?? 'default' },
        { label: 'vimMode', value: String(effective.vimMode ?? false) },
        { label: 'allowedTools', value: `${effective.allowedTools?.length ?? 0}` },
        { label: 'disallowedTools', value: `${effective.disallowedTools?.length ?? 0}` },
      ],
      checks: loaded.sources.map(source => ({
        label: `${source.kind} settings`,
        status: source.exists ? 'ok' : 'warning',
        detail: source.exists
          ? `${source.path} (${Object.keys(source.settings ?? {}).length} key(s))`
          : `${source.path} not found`,
      })),
      footer: 'Use /config for raw effective config and /permissions for tool rules.',
    }
  } catch (error) {
    return {
      title: 'Settings',
      rows: [{ label: 'cwd', value: args.cwd }],
      checks: [{
        label: 'settings validation',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      }],
      footer: 'Fix the invalid settings source and reopen this screen.',
    }
  }
}

export async function collectTrustScreen(cwd: string): Promise<CommandScreen> {
  const settings = await safeLoadSettings(cwd)
  const git = await optionalPathState(join(cwd, '.git'))
  const claudeSettings = await optionalPathState(join(cwd, '.claude', 'settings.json'))
  const localSettings = await optionalPathState(localProjectSettingsPath(cwd))
  const managedPolicy = await optionalPathState(managedSettingsPath() ?? '')
  return {
    title: 'Trust',
    rows: [
      { label: 'cwd', value: cwd },
      {
        label: 'permissionMode',
        value: settings.ok ? settings.settings.settings.permissionMode ?? 'default' : 'unknown',
      },
      { label: 'worktree', value: git.exists ? 'git' : 'plain directory' },
      { label: 'projectOnboarding', value: claudeSettings.exists || localSettings.exists ? 'has local state' : 'not completed' },
    ],
    checks: [
      {
        label: 'workspace trust',
        status: git.exists ? 'ok' : 'warning',
        detail: git.exists ? '.git detected' : 'no git metadata detected',
      },
      {
        label: 'local trust state',
        status: claudeSettings.exists || localSettings.exists ? 'ok' : 'warning',
        detail: [claudeSettings.path, localSettings.path].filter(Boolean).join(', '),
      },
      {
        label: 'managed policy',
        status: managedPolicy.exists ? 'ok' : 'warning',
        detail: managedPolicy.exists ? managedPolicy.path : 'not configured',
      },
      settings.ok
        ? {
            label: 'settings load',
            status: 'ok',
            detail: `${settings.settings.sources.filter(source => source.exists).length} source(s) loaded`,
          }
        : {
            label: 'settings load',
            status: 'error',
            detail: settings.error,
          },
    ],
    footer: 'Use /permissions to inspect allow/deny rules before trusting new project actions.',
  }
}

export function buildOnboardingScreen(cwd: string): CommandScreen {
  return {
    title: 'Onboarding',
    rows: [
      { label: 'cwd', value: cwd },
      { label: 'flow', value: 'project trust -> settings -> permissions -> model -> TUI basics' },
    ],
    items: [
      '1. Review workspace trust with /trust.',
      '2. Review effective settings with /settings.',
      '3. Review tool access with /permissions.',
      '4. Pick a model with /model and theme with /theme.',
      '5. Use @file, @mcp, @image, and queued prompts from the TUI completion bar.',
    ],
    footer: 'This mirrors the upstream first-run/onboarding surface without mutating project files.',
  }
}

export function buildWizardScreen(): CommandScreen {
  return {
    title: 'Wizard',
    rows: [
      { label: 'mode', value: 'guided setup' },
      { label: 'steps', value: 'settings, permissions, MCP, plugins, skills, remote, TUI' },
    ],
    items: [
      '/settings    inspect effective configuration and source precedence',
      '/permissions inspect tool allow/deny rules',
      '/mcp         inspect MCP servers, resources, and tools',
      '/plugin      inspect plugin marketplace lifecycle state',
      '/skills      inspect local skills and store cache',
      '/remote      inspect remote transports and peers',
      '/theme       preview and change TUI theme',
    ],
    footer: 'Wizard is deterministic and local: each step maps to a concrete command surface.',
  }
}

export async function collectSandboxScreen(cwd: string): Promise<CommandScreen> {
  const settings = await safeLoadSettings(cwd)
  const permissionMode = settings.ok
    ? settings.settings.settings.permissionMode ?? 'default'
    : 'unknown'
  const allowed = settings.ok ? settings.settings.settings.allowedTools ?? [] : []
  const disallowed = settings.ok ? settings.settings.settings.disallowedTools ?? [] : []
  return {
    title: 'Sandbox',
    rows: [
      { label: 'permissionMode', value: permissionMode },
      { label: 'allowedTools', value: allowed.length > 0 ? allowed.join(', ') : '(none)' },
      { label: 'disallowedTools', value: disallowed.length > 0 ? disallowed.join(', ') : '(none)' },
    ],
    checks: [
      {
        label: 'tool permission gate',
        status: permissionMode === 'bypassPermissions' || permissionMode === 'dontAsk'
          ? 'warning'
          : 'ok',
        detail: `mode=${permissionMode}`,
      },
      {
        label: 'network sandbox policy',
        status: allowed.some(rule => /WebFetch|WebSearch|VaultHttpFetch/i.test(rule))
          ? 'warning'
          : 'ok',
        detail: 'network tools still require command/tool permission checks',
      },
      settings.ok
        ? {
            label: 'settings source',
            status: 'ok',
            detail: `${settings.settings.sources.filter(source => source.exists).length} source(s) loaded`,
          }
        : {
            label: 'settings source',
            status: 'error',
            detail: settings.error,
          },
    ],
    footer: 'Sandbox requests are resolved through the same permission queue used by tool execution.',
  }
}

export function buildNativeImagePasteScreen(args: {
  supported: boolean
  detail?: string
}): CommandScreen {
  return {
    title: 'Native Image Paste',
    rows: [
      { label: 'status', value: args.supported ? 'available' : 'unavailable' },
      { label: 'promptToken', value: '@image:clipboard' },
      { label: 'contentTypes', value: 'image/png, image/jpeg, image/gif, image/webp' },
    ],
    checks: [{
      label: 'clipboard image adapter',
      status: args.supported ? 'ok' : 'warning',
      detail: args.detail ?? (args.supported
        ? 'native clipboard image command is available'
        : 'native clipboard image command is not available on this terminal'),
    }],
    items: [
      'Paste or reference clipboard images with @image:clipboard in the TUI.',
      'Use @image:file for file-backed image attachments when the terminal cannot expose image clipboard data.',
    ],
    footer: 'Image payloads are read from the OS clipboard only when requested and are not persisted as secrets.',
  }
}

export function filterResumeSessions(
  sessions: SessionMetadata[],
  query: string,
): SessionMetadata[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return sessions
  }

  return sessions.filter(session =>
    resumeSearchText(session).includes(normalized),
  )
}

export function buildResumePreviewRows(
  session: SessionMetadata | undefined,
  restorePlan?: SessionRestorePlan,
): CommandScreen['rows'] {
  if (!session) {
    return [
      { label: 'selected', value: '(none)' },
    ]
  }

  return [
    { label: 'selected', value: session.id },
    { label: 'updatedAt', value: session.updatedAt },
    { label: 'promptCount', value: String(session.promptCount) },
    { label: 'model', value: session.model ?? '(default)' },
    { label: 'permissionMode', value: session.permissionMode ?? '(default)' },
    { label: 'forkedFrom', value: session.parentSessionId ?? '(none)' },
    { label: 'forkReason', value: session.forkReason ?? '(none)' },
    { label: 'rewindRecord', value: session.rewindRecordId ?? '(none)' },
    ...(restorePlan
      ? [
          { label: 'branchDepth', value: String(restorePlan.branchDepth) },
          {
            label: 'lineage',
            value: restorePlan.lineageSessionIds.join(' <- ') || '(root)',
          },
          {
            label: 'missingParents',
            value: restorePlan.missingParentSessionIds.join(', ') || '(none)',
          },
          {
            label: 'transcriptHydration',
            value: `${restorePlan.transcriptHydration.status} (${restorePlan.transcriptHydration.messageCount} messages, ${restorePlan.transcriptHydration.toolUseCount} tool uses, ${restorePlan.transcriptHydration.toolResultCount} tool results)`,
          },
          {
            label: 'providerMessages',
            value: `${restorePlan.providerMessageHydration.status} (${restorePlan.providerMessageHydration.messageCount} messages, ${restorePlan.providerMessageHydration.toolUseBlockCount} tool uses, ${restorePlan.providerMessageHydration.toolResultBlockCount} tool results, ${restorePlan.providerMessageHydration.replayedRecordCount} replay records)`,
          },
          {
            label: 'cacheBreaks',
            value: String(restorePlan.providerCacheBreaks.length),
          },
          {
            label: 'compactState',
            value: `${restorePlan.compactState.status} (${restorePlan.compactState.compactedRecordCount} compacted, ${restorePlan.compactState.replayableRecordCount} replayable)`,
          },
          {
            label: 'fileSnapshots',
            value: `${restorePlan.fileSnapshotCoverage.available}/${restorePlan.fileSnapshotCoverage.changed} available, ${restorePlan.fileSnapshotCoverage.missing} missing`,
          },
        ]
      : []),
    { label: 'transcript', value: session.transcriptPath },
    { label: 'lastPrompt', value: session.lastPrompt ?? '(none)' },
  ]
}

export function buildResumeScreen(
  sessions: SessionMetadata[],
  query = '',
): CommandScreen {
  const visibleSessions = filterResumeSessions(sessions, query)
  return {
    title: 'Resume',
    rows: [
      ...(query ? [{ label: 'filter', value: query }] : []),
      ...(buildResumePreviewRows(visibleSessions[0]) ?? []),
    ],
    items:
      sessions.length === 0
        ? ['No sessions found.']
        : visibleSessions.length === 0
          ? [`No sessions match: ${query}`]
          : visibleSessions.map(session =>
            [
              session.id,
              session.updatedAt,
              `${session.promptCount} prompt${session.promptCount === 1 ? '' : 's'}`,
              session.lastPrompt ?? '',
            ].join(' | '),
          ),
    footer: 'Use /resume <sessionId>, /resume <sessionId> --fork, /resume <sessionId> --rewind [recordId], or /resume <sessionId> --checkpoints.',
  }
}

export function formatCommandScreen(screen: CommandScreen): string {
  const lines = [`${screen.title}:`]

  for (const row of screen.rows ?? []) {
    lines.push(`${row.label}: ${row.value}`)
  }

  for (const check of screen.checks ?? []) {
    lines.push(
      `check ${check.label}: ${check.status}${check.detail ? ` - ${check.detail}` : ''}`,
    )
  }

  if (screen.items?.length) {
    lines.push(...screen.items)
  }

  if (screen.footer) {
    lines.push(screen.footer)
  }

  lines.push('')
  return lines.join('\n')
}

async function safeLoadSettings(cwd: string): Promise<
  | { ok: true; settings: Awaited<ReturnType<typeof loadSettingsWithSources>> }
  | { ok: false; error: string; settings?: undefined }
> {
  try {
    return {
      ok: true,
      settings: await loadSettingsWithSources(cwd),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function summarizeCheckStatus(checks: CommandScreen['checks']): string {
  if (checks?.some(check => check.status === 'error')) {
    return 'error'
  }

  if (checks?.some(check => check.status === 'warning')) {
    return 'warning'
  }

  return 'ok'
}

async function optionalPathState(path: string): Promise<{
  path: string
  exists: boolean
}> {
  if (!path) {
    return { path, exists: false }
  }

  try {
    await stat(path)
    return { path, exists: true }
  } catch {
    return { path, exists: false }
  }
}

async function settingsSourceChecks(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<NonNullable<CommandScreen['checks']>> {
  return Promise.all(settingsSourceCandidates(cwd, env).map(async source => {
    try {
      const raw = JSON.parse(await readFile(source.path, 'utf8')) as unknown
      const parsed = SettingsSchema.safeParse(raw)
      return {
        label: `settings source ${source.kind}`,
        status: parsed.success ? 'ok' : 'error',
        detail: parsed.success ? source.path : 'invalid settings schema',
      }
    } catch (error) {
      if (isNotFound(error)) {
        return {
          label: `settings source ${source.kind}`,
          status: 'warning',
          detail: 'not found',
        }
      }

      return {
        label: `settings source ${source.kind}`,
        status: 'error',
        detail: error instanceof SyntaxError
          ? 'invalid JSON'
          : error instanceof Error
            ? error.message
            : String(error),
      }
    }
  }))
}

function permissionRuleCoverageCheck(
  settings: Awaited<ReturnType<typeof loadSettingsWithSources>>['settings'] | undefined,
): NonNullable<CommandScreen['checks']>[number] {
  const allowed = settings?.allowedTools ?? []
  const disallowed = settings?.disallowedTools ?? []
  const allRules = [
    ...allowed.map(rule => ({ field: 'allowed', rule })),
    ...disallowed.map(rule => ({ field: 'disallowed', rule })),
  ]
  const duplicateCount = allRules.length - new Set(allRules.map(item => `${item.field}:${item.rule}`)).size
  const shadowed = allRules
    .filter(item => !item.rule.includes('('))
    .flatMap(item =>
      allRules
        .filter(candidate =>
          candidate.field === item.field &&
          candidate.rule.startsWith(`${item.rule}(`),
        )
        .map(candidate => `${item.rule} shadows ${candidate.rule}`),
    )

  const warnings = [
    duplicateCount > 0 ? `${duplicateCount} duplicate rule(s)` : undefined,
    ...shadowed,
  ].filter(Boolean)

  return {
    label: 'permission rule coverage',
    status: warnings.length > 0 ? 'warning' : 'ok',
    detail: warnings.length > 0
      ? warnings.join('; ')
      : `${allowed.length} allowed, ${disallowed.length} disallowed`,
  }
}

async function contextFileCheck(
  cwd: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  const candidates = [
    join(cwd, 'CLAUDE.md'),
    join(cwd, 'AGENTS.md'),
    join(cwd, '.claude', 'CLAUDE.md'),
  ]
  const existing = []

  for (const path of candidates) {
    try {
      existing.push({ path, size: (await stat(path)).size })
    } catch (error) {
      if (!isNotFound(error)) {
        return {
          label: 'context files',
          status: 'error',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }

  if (existing.length === 0) {
    return {
      label: 'context files',
      status: 'warning',
      detail: 'CLAUDE.md/AGENTS.md not found',
    }
  }

  const totalBytes = existing.reduce((sum, file) => sum + file.size, 0)
  return {
    label: 'context files',
    status: totalBytes > 100_000 ? 'warning' : 'ok',
    detail: `${existing.length} file(s), ${totalBytes} bytes`,
  }
}

async function mcpConfigCheck(
  cwd: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  const candidates = [
    join(cwd, '.mcp.json'),
    join(cwd, '.claude', 'mcp.json'),
  ]
  const existing: string[] = []

  for (const path of candidates) {
    try {
      JSON.parse(await readFile(path, 'utf8'))
      existing.push(path)
    } catch (error) {
      if (isNotFound(error)) {
        continue
      }

      return {
        label: 'mcp config',
        status: 'error',
        detail: error instanceof SyntaxError
          ? `invalid JSON in ${path}`
          : error instanceof Error
            ? error.message
            : String(error),
      }
    }
  }

  return {
    label: 'mcp config',
    status: existing.length > 0 ? 'ok' : 'warning',
    detail: existing.length > 0 ? existing.join(', ') : 'not found',
  }
}

function providerEnvironmentCheck(
  env: Record<string, string | undefined>,
): NonNullable<CommandScreen['checks']>[number] {
  const hasDeepSeek = Boolean(env.DEEPSEEK_API_KEY)
  const conflictingProviderKeys = [
    env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : undefined,
    env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : undefined,
  ].filter(Boolean)

  return {
    label: 'provider environment',
    status: hasDeepSeek && conflictingProviderKeys.length === 0 ? 'ok' : 'warning',
    detail: conflictingProviderKeys.length > 0
      ? `DeepSeek configured with extra provider env: ${conflictingProviderKeys.join(', ')}`
      : hasDeepSeek
        ? 'DeepSeek only'
        : 'DeepSeek key missing',
  }
}

async function managedPolicyCheck(
  env: Record<string, string | undefined>,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  const path = managedSettingsPath(env)
  if (!path) {
    return {
      label: 'managed policy',
      status: 'warning',
      detail: 'MY_CLAUDE_CODE_MANAGED_SETTINGS_PATH not set',
    }
  }

  return optionalPathCheck(path, 'managed policy', 'configured path not found')
}

async function accessCheck(
  path: string,
  mode: number,
  label: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  try {
    await access(path, mode)
    return {
      label,
      status: 'ok',
    }
  } catch (error) {
    return {
      label,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function optionalPathCheck(
  path: string,
  label: string,
  missingDetail: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  try {
    await access(path, constants.F_OK)
    return {
      label,
      status: 'ok',
      detail: path,
    }
  } catch (error) {
    if (isNotFound(error)) {
      return {
        label,
        status: 'warning',
        detail: missingDetail,
      }
    }

    return {
      label,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function installationTypeCheck(
  cwd: string,
  env: Record<string, string | undefined>,
): NonNullable<CommandScreen['checks']>[number] {
  const invoked = process.argv[1] ?? ''
  const installationType =
    env.NODE_ENV === 'development' || invoked.includes('/packages/cli/src/')
      ? 'development'
      : invoked.includes('/dist/')
        ? 'local-build'
        : invoked.includes('/node_modules/')
          ? 'npm-local'
          : 'unknown'

  return {
    label: 'installation type',
    status: installationType === 'unknown' ? 'warning' : 'ok',
    detail: `${installationType} (${cwd})`,
  }
}

function invokedBinaryCheck(): NonNullable<CommandScreen['checks']>[number] {
  return {
    label: 'invoked binary',
    status: process.argv[1] ? 'ok' : 'warning',
    detail: process.argv[1] || '(unknown)',
  }
}

function execPathCheck(): NonNullable<CommandScreen['checks']>[number] {
  return {
    label: 'exec path',
    status: process.execPath ? 'ok' : 'warning',
    detail: process.execPath || '(unknown)',
  }
}

function autoUpdateCheck(
  env: Record<string, string | undefined>,
): NonNullable<CommandScreen['checks']>[number] {
  return {
    label: 'auto updates',
    status: 'ok',
    detail:
      env.NODE_ENV === 'production'
        ? 'not implemented in local clone'
        : 'disabled in development',
  }
}

async function packageManagerCheck(
  cwd: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  const candidates = [
    ['bun', 'bun.lock'],
    ['pnpm', 'pnpm-lock.yaml'],
    ['npm', 'package-lock.json'],
    ['yarn', 'yarn.lock'],
  ] as const

  for (const [name, filename] of candidates) {
    try {
      await access(join(cwd, filename), constants.F_OK)
      return {
        label: 'package manager',
        status: 'ok',
        detail: name,
      }
    } catch (error) {
      if (!isNotFound(error)) {
        return {
          label: 'package manager',
          status: 'error',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }

  return {
    label: 'package manager',
    status: 'warning',
    detail: 'lockfile not found',
  }
}

async function commandVersionCheck(
  command: string,
  args: string[],
  label: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  try {
    const result = await execFileAsync(command, args, { timeout: 2000 })
    return {
      label,
      status: 'ok',
      detail: firstLine(result.stdout || result.stderr || command),
    }
  } catch (error) {
    return {
      label,
      status: 'warning',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function pathLookupCheck(
  command: string,
  env: Record<string, string | undefined>,
): NonNullable<CommandScreen['checks']>[number] {
  const found = findOnPath(command, env.PATH)
  return {
    label: `PATH ${command}`,
    status: found ? 'ok' : 'warning',
    detail: found ?? 'not found',
  }
}

function shellCheck(
  env: Record<string, string | undefined>,
): NonNullable<CommandScreen['checks']>[number] {
  return {
    label: 'shell',
    status: env.SHELL ? 'ok' : 'warning',
    detail: env.SHELL ?? 'not set',
  }
}

async function packageManifestCheck(
  cwd: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  try {
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    return {
      label: 'package manifest',
      status: 'ok',
      detail: `${String(manifest.name ?? '(unnamed)')} ${String(manifest.version ?? '')}`.trim(),
    }
  } catch (error) {
    if (isNotFound(error)) {
      return {
        label: 'package manifest',
        status: 'warning',
        detail: 'not found',
      }
    }

    return {
      label: 'package manifest',
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function sessionGraphCheck(
  cwd: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  try {
    const graph = await buildSessionGraph(cwd)
    return {
      label: 'session graph',
      status: 'ok',
      detail: `${graph.nodes.length} sessions, ${graph.roots.length} roots`,
    }
  } catch (error) {
    return {
      label: 'session graph',
      status: 'warning',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function gitHeadCheck(
  cwd: string,
): Promise<NonNullable<CommandScreen['checks']>[number]> {
  try {
    const head = (await readFile(join(cwd, '.git', 'HEAD'), 'utf8')).trim()
    return {
      label: 'git head',
      status: 'ok',
      detail: head.startsWith('ref: ') ? head.slice('ref: '.length) : head.slice(0, 12),
    }
  } catch (error) {
    if (isNotFound(error)) {
      return {
        label: 'git head',
        status: 'warning',
        detail: 'not detected',
      }
    }

    return {
      label: 'git head',
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function optionalRuntimeCheck(
  label: string,
  version: string | undefined,
): NonNullable<CommandScreen['checks']>[number] {
  return version
    ? {
        label,
        status: 'ok',
        detail: version,
      }
    : {
        label,
        status: 'warning',
        detail: 'not detected',
      }
}

function themePreview(theme: ThemeName): string {
  switch (theme) {
    case 'default':
      return 'terminal default colors'
    case 'dark':
      return 'high contrast on dark terminals'
    case 'light':
      return 'muted contrast on light terminals'
    case 'auto':
      return 'follow terminal color capability'
  }
}

function themePreviewRows(theme: ThemeName): Array<{ label: string; value: string }> {
  switch (theme) {
    case 'default':
      return [
        { label: 'user', value: 'terminal default foreground' },
        { label: 'assistant', value: 'terminal default accent' },
        { label: 'diff', value: '+ added / - removed' },
      ]
    case 'dark':
      return [
        { label: 'user', value: 'cyan on dark background' },
        { label: 'assistant', value: 'green on dark background' },
        { label: 'diff', value: 'bright green add, red remove' },
      ]
    case 'light':
      return [
        { label: 'user', value: 'blue on light background' },
        { label: 'assistant', value: 'dark green on light background' },
        { label: 'diff', value: 'muted green add, crimson remove' },
      ]
    case 'auto':
      return [
        { label: 'detector', value: '$COLORFGBG / terminal color capability' },
        { label: 'dark', value: 'uses dark preview when background is dark' },
        { label: 'light', value: 'uses light preview when background is light' },
      ]
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find(Boolean)?.trim() ?? ''
}

function findOnPath(
  command: string,
  pathValue: string | undefined,
): string | undefined {
  if (!pathValue) {
    return undefined
  }

  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory, command)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function resumeSearchText(session: SessionMetadata): string {
  return [
    session.id,
    session.cwd,
    session.transcriptPath,
    session.createdAt,
    session.updatedAt,
    session.model,
    session.permissionMode,
    session.lastPrompt,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}
