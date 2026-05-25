import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  DEFAULT_SYSTEM_PROMPT,
  applyAutoCompact,
  appendTranscript,
  buildRuntimeContext,
} from '../../../packages/agent-runtime/src/index.js'
import { getDefaultProviderRuntime } from '../../../packages/model-provider/src/index.js'
import {
  downloadUserSettingsSnapshot,
  loadSettings,
  loadSettingsWithSources,
  OUTPUT_STYLE_NAMES,
  OutputStyleNameSchema,
  setProjectSetting,
  uploadUserSettingsSnapshot,
  THEME_NAMES,
  ThemeNameSchema,
} from '../../../packages/settings/src/index.js'
import {
  forkSession,
  listSessionCheckpoints,
  listSessions,
  replaySession,
  resolveSession,
  sessionContextStats,
  rewindFilesToCheckpoint,
} from '../../../packages/session/src/index.js'
import {
  captureTerminal,
  classifyWorkflowJob,
  connectRemote,
  createBrief,
  createUltraplan,
  discoverExtensionRegistry,
  checkVoiceRuntime,
  createTask,
  createTaskTemplate,
  detachRemote,
  enterWorktree,
  exitWorktree,
  extractMemories,
  generateSkill,
  getBuiltinTools,
  heartbeatDaemon,
  installMarketplacePlugin,
  kickBridge,
  listAgents,
  listBuiltInAgents,
  listMemoryStoreEntries,
  parsePermissionMode,
  planAutofixPr,
  queuePushNotification,
  rankMemoryStoreEntries,
  readAutofixPrPlans,
  readAgentWorkflowState,
  readAssistantMode,
  readBackgroundJobs,
  readBackgroundOutput,
  readBrowserSessions,
  readBriefs,
  readBuddySessions,
  readCoordinatorRuns,
  readDaemonState,
  readKairosChannels,
  readMonitorOutput,
  readMonitors,
  readPipeEndpoints,
  readPluginInstallState,
  readPluginMarketplace,
  readProactiveTicks,
  readPushNotifications,
  readRemoteEnv,
  readRemoteSessions,
  readRunnerProfiles,
  readRunnerRuns,
  readSkillImprovementFeedback,
  readSkillLearning,
  readSkillStoreCache,
  readSkillStoreIndex,
  readTaskTemplates,
  readTasks,
  readUdsInboxes,
  readUltraplans,
  readVoiceMode,
  readWorkflowScriptRuns,
  readWorktreeState,
  recordReviewArtifactMutation,
  recordWorkflowEvent,
  registerKairosChannel,
  registerLanPipeEndpoint,
  registerPipeEndpoint,
  reconcilePluginMarketplace,
  resumeRemote,
  recordSkillImprovementFeedback,
  recordSkillLearning,
  refreshSkillStoreIndex,
  runDueCronWorkflows,
  runBuiltInAgent,
  runCoordinator,
  runEnvironmentRunner,
  runRemoteCommand,
  runSelfHostedRunner,
  runTaskTemplate,
  runWorkflowScript,
  scheduleCronWorkflow,
  scheduleProactiveTick,
  searchSkills,
  sendPipeMessage,
  sendUdsInboxMessage,
  setPluginEnabled,
  setRemoteEnv,
  setVoiceMode,
  setAssistantMode,
  setupRemote,
  startDaemon,
  startBackgroundJob,
  startBuddySession,
  startMonitor,
  startUdsInbox,
  startVoiceRuntimeRecording,
  stopDaemon,
  stopBackgroundJob,
  stopMonitor,
  stopTask,
  stopVoiceRuntimeRecording,
  syncTeamMemory,
  triggerRemote,
  updateMarketplacePlugin,
} from '../../../packages/tools/src/index.js'
import {
  buildNativeImagePasteScreen,
  buildOnboardingScreen,
  buildHelpV2Screen,
  buildResumeScreen,
  buildThemeScreen,
  collectSandboxScreen,
  collectDoctorScreen,
  formatCommandScreen,
} from '../../../packages/commands/src/screens.js'
import {
  KEYBINDING_SECTIONS,
  SLASH_COMMAND_DESCRIPTIONS,
  SLASH_COMMAND_NAMES,
} from '../../../packages/commands/src/slashCommands.js'
import type {
  CommandIO,
  SlashCommandOptions,
  SlashCommandResult,
} from '../../../packages/commands/src/slashCommands.js'

const execFileAsync = promisify(execFile)

export type CoreCommandArgs = {
  io: CommandIO
  cwd: string
  version: string
  args?: string[]
  options?: SlashCommandOptions
}

export function runAddDirCommand(args: CoreCommandArgs): SlashCommandResult {
  const added = parseAddDirCommandArgs(args.args ?? [])
  const next = uniqueStrings([
    ...(args.options?.additionalDirectories ?? args.options?.addDir ?? []),
    ...added,
  ])
  args.io.stdout.write(
    `Additional directories: ${next.length > 0 ? next.join(', ') : '(none)'}\n`,
  )
  if (added.length === 0) {
    args.io.stdout.write('Use /add-dir <path>[,<path>...] to add directories.\n')
  }
  return {
    exitRequested: false,
    additionalDirectories: next,
  }
}

export async function runHelpCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write(formatCommandScreen(buildHelpV2Screen({
    commandNames: SLASH_COMMAND_NAMES,
    descriptions: SLASH_COMMAND_DESCRIPTIONS,
    filter: (args.args ?? []).join(' '),
  })))
  return { exitRequested: false }
}

export async function runDoctorCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write(formatCommandScreen(await collectDoctorScreen({
    cwd: args.cwd,
    version: args.version,
    model: args.options?.model,
    permissionMode: args.options?.permissionMode,
  })))
  return { exitRequested: false }
}

export async function runMcpCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const registry = await discoverExtensionRegistry(args.cwd)
  args.io.stdout.write(`${JSON.stringify({
    servers: registry.mcpServers.map(([name, config]) => ({
      name,
      type: config.type ?? 'stdio',
      command: config.command,
      disabled: config.disabled ?? false,
    })),
    tools: registry.mcpTools.map(tool => ({
      name: tool.name,
      serverName: tool.serverName,
      toolName: tool.toolName,
      description: tool.description,
    })),
    resources: registry.mcpResources,
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runStatusCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const settings = await loadSettings(args.cwd)
  const context = await sessionContextStats(args.cwd)
  args.io.stdout.write(`${JSON.stringify({
    version: args.version,
    model: args.options?.model ?? settings.model ?? 'deepseek-v4-flash',
    permissionMode:
      args.options?.permissionMode ?? settings.permissionMode ?? 'default',
    toolCount: getBuiltinTools().length,
    sessionId: context?.session.id,
    tokenBudget: context?.stats.tokenBudget,
    promptCache: context?.stats.promptCache,
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runModelCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const settings = await loadSettings(args.cwd)
  const model = args.options?.model ?? settings.model ?? 'deepseek-v4-flash'
  args.io.stdout.write(`${getDefaultProviderRuntime().registry.resolve(model).model}\n`)
  return { exitRequested: false }
}

export async function runVersionCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write(`${args.version}\n`)
  return { exitRequested: false }
}

export async function runThemeCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const themeName = args.args?.[0]
  if (themeName) {
    const parsed = ThemeNameSchema.safeParse(themeName)
    if (!parsed.success) {
      args.io.stdout.write([
        `Unknown theme: ${themeName}`,
        `Available themes: ${THEME_NAMES.join(', ')}`,
        '',
      ].join('\n'))
      return { exitRequested: false }
    }
    const settings = await setProjectSetting(args.cwd, 'theme', parsed.data)
    args.io.stdout.write(formatCommandScreen(buildThemeScreen(
      settings.theme ?? 'default',
      'Saved project theme.',
    )))
    return { exitRequested: false }
  }
  const settings = await loadSettings(args.cwd)
  args.io.stdout.write(formatCommandScreen(buildThemeScreen(settings.theme ?? 'default')))
  return { exitRequested: false }
}

export async function runPermissionsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const loaded = await loadSettingsWithSources(args.cwd)
  const settings = loaded.settings
  const allowedTools =
    args.options?.allowedTools ?? args.options?.tools ?? settings.allowedTools ?? []
  const disallowedTools =
    args.options?.disallowedTools ?? settings.disallowedTools ?? []
  args.io.stdout.write([
    `permissionMode: ${args.options?.permissionMode ?? settings.permissionMode ?? 'default'}`,
    `allowedTools: ${allowedTools.length > 0 ? allowedTools.join(', ') : '(all registered tools)'}`,
    `disallowedTools: ${disallowedTools.length > 0 ? disallowedTools.join(', ') : '(none)'}`,
    `settingsSources: ${loaded.sources.filter(source => source.exists).map(source => source.kind).join(', ') || '(none)'}`,
    `registeredTools: ${getBuiltinTools().map(tool => tool.name).join(', ')}`,
    '',
  ].join('\n'))
  return { exitRequested: false }
}

export async function runConfigCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const action = args.args?.[0]
  if (action === 'sync-upload') {
    args.io.stdout.write(`${JSON.stringify({
      action,
      ...(await uploadUserSettingsSnapshot({
        cwd: args.cwd,
        path: args.args?.[1],
      })),
    }, null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'sync-download') {
    args.io.stdout.write(`${JSON.stringify({
      action,
      ...(await downloadUserSettingsSnapshot({
        cwd: args.cwd,
        path: args.args?.[1],
      })),
    }, null, 2)}\n`)
    return { exitRequested: false }
  }
  const loaded = await loadSettingsWithSources(args.cwd)
  const settings = loaded.settings
  args.io.stdout.write(`${JSON.stringify({
    model: settings.model ?? 'deepseek-v4-flash',
    permissionMode: settings.permissionMode ?? 'default',
    allowedTools: settings.allowedTools ?? [],
    disallowedTools: settings.disallowedTools ?? [],
    theme: settings.theme ?? 'default',
    outputStyle: settings.outputStyle ?? 'default',
    vimMode: settings.vimMode ?? false,
    settingsSources: loaded.sources
      .filter(source => source.exists)
      .map(source => source.kind),
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runOutputStyleCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const outputStyleName = args.args?.[0]
  if (outputStyleName) {
    const parsed = OutputStyleNameSchema.safeParse(outputStyleName)
    if (!parsed.success) {
      args.io.stdout.write([
        `Unknown output style: ${outputStyleName}`,
        `Available output styles: ${OUTPUT_STYLE_NAMES.join(', ')}`,
        '',
      ].join('\n'))
      return { exitRequested: false }
    }
    const settings = await setProjectSetting(args.cwd, 'outputStyle', parsed.data)
    args.io.stdout.write([
      'Output style:',
      `active: ${settings.outputStyle ?? 'default'}`,
      `available: ${OUTPUT_STYLE_NAMES.join(', ')}`,
      'Saved project output style.',
      '',
    ].join('\n'))
    return { exitRequested: false }
  }
  const settings = await loadSettings(args.cwd)
  args.io.stdout.write([
    'Output style:',
    `active: ${settings.outputStyle ?? 'default'}`,
    `available: ${OUTPUT_STYLE_NAMES.join(', ')}`,
    '',
  ].join('\n'))
  return { exitRequested: false }
}

export async function runEnvCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write([
    'Environment:',
    `cwd: ${args.cwd}`,
    `node: ${process.versions.node}`,
    `bun: ${typeof Bun === 'undefined' ? 'unavailable' : Bun.version}`,
    `shell: ${process.env.SHELL ?? '(unknown)'}`,
    `NODE_ENV: ${process.env.NODE_ENV ?? 'unset'}`,
    '',
  ].join('\n'))
  return { exitRequested: false }
}

export async function runKeybindingsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write([
    'Keybindings:',
    ...KEYBINDING_SECTIONS.flatMap(section => [
      `${section.name}:`,
      ...section.bindings.map(([key, description]) => `  ${key}: ${description}`),
    ]),
    '',
  ].join('\n'))
  return { exitRequested: false }
}

export async function runProviderCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const settings = await loadSettings(args.cwd)
  const requestedModel = args.options?.model ?? settings.model ?? 'deepseek-v4-flash'
  const runtime = getDefaultProviderRuntime()
  const resolved = runtime.registry.resolve(requestedModel)
  const snapshot = runtime.snapshot()
  args.io.stdout.write(`${JSON.stringify({
    active: {
      provider: resolved.provider,
      requestedModel,
      model: resolved.model,
      capabilities: resolved.capabilities,
    },
    providers: snapshot.providers,
    usage: snapshot.usage,
    balances: snapshot.balances,
    errors: snapshot.errors,
    cacheBreaks: snapshot.cacheBreaks,
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runRateLimitOptionsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const snapshot = getDefaultProviderRuntime().snapshot()
  args.io.stdout.write(`${JSON.stringify({
    balances: snapshot.balances,
    providers: snapshot.providers.map(provider => ({
      name: provider.name,
      defaultModel: provider.defaultModel,
      rateLimit: provider.rateLimit,
      apiKeyConfigured: provider.apiKeyConfigured,
    })),
    errors: snapshot.errors.filter(error => error.kind === 'rate_limit'),
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runContextCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const context = await sessionContextStats(args.cwd, args.options?.sessionId)
  if (!context) {
    args.io.stdout.write('No session context found.\n')
    return { exitRequested: false }
  }
  const runtimeContext = await buildRuntimeContext({
    cwd: args.cwd,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userContext: context.summary,
    additionalDirectories: args.options?.additionalDirectories ?? args.options?.addDir,
  })
  const compactRequested = args.args?.[0] === '--compact'
  if (compactRequested) {
    const compact = applyAutoCompact(context.providerMessages, {
      thresholdTokens: Math.max(1, context.stats.tokenBudget.limit * 0.7),
    })
    const summary = compact.summary ?? context.summary
    await appendTranscript({
      transcriptPath: context.session.transcriptPath,
      sessionId: context.session.id,
      event: {
        type: 'terminal',
        status: 'completed',
        exitCode: 0,
        reason: 'manual compact',
        stdout: summary,
      },
      compact: {
        boundary: true,
        summary,
        trigger: 'manual',
      },
    })
    args.io.stdout.write([
      'Compact:',
      `sessionId: ${context.session.id}`,
      `estimatedTokensBefore: ${compact.estimatedTokensBefore}`,
      `estimatedTokensAfter: ${compact.estimatedTokensAfter}`,
      `compacted: ${compact.compacted}`,
      `contextSections: ${runtimeContext.sections.map(section => section.title).join(', ')}`,
      `memoryFiles: ${runtimeContext.memoryFiles.length}`,
      '',
      'Summary:',
      summary,
      '',
    ].join('\n'))
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({
    sessionId: context.session.id,
    promptCount: context.session.promptCount,
    eventCount: context.stats.eventCount,
    estimatedTokens: context.stats.estimatedTokens,
    inputTokens: context.stats.inputTokens,
    outputTokens: context.stats.outputTokens,
    promptCache: context.stats.promptCache,
    tokenBudget: context.stats.tokenBudget,
    assistantTextChars: context.stats.assistantTextChars,
    toolUseCount: context.stats.toolUseCount,
    readFiles: context.readFiles,
    runtimeContext: {
      estimatedTokens: runtimeContext.estimatedTokens,
      sections: runtimeContext.sections.map(section => section.title),
      memoryFiles: runtimeContext.memoryFiles,
      gitStatusChars: runtimeContext.gitStatus?.length ?? 0,
    },
    restorePlan: context.restorePlan,
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runMemoryCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const action = args.args?.[0] ?? 'summary'
  if (action === 'rank') {
    const prompt = args.args?.slice(1).join(' ')
    args.io.stdout.write(`${JSON.stringify(await rankMemoryStoreEntries(args.cwd, prompt), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'extract') {
    const text = args.args?.slice(1).join(' ').trim()
    if (!text) {
      args.io.stdout.write('Usage: /memory extract <text>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify({ memories: await extractMemories(args.cwd, { text }) }, null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'sync-team') {
    args.io.stdout.write(`${JSON.stringify(await syncTeamMemory(args.cwd, args.args?.[1]), null, 2)}\n`)
    return { exitRequested: false }
  }
  const files = [
    'CLAUDE.md',
    join('.claude', 'CLAUDE.md'),
    join('.my-claude-code', 'memory.md'),
  ]
  const lines = ['Memory:']
  for (const file of files) {
    try {
      const content = await readFile(join(args.cwd, file), 'utf8')
      lines.push(`${file}: ${content.length} chars`)
    } catch {
      lines.push(`${file}: not found`)
    }
  }
  const storeEntries = await listMemoryStoreEntries(args.cwd)
  const ranking = await rankMemoryStoreEntries(args.cwd, args.args?.slice(1).join(' '))
  lines.push(`localMemoryStores: ${new Set(storeEntries.map(entry => entry.store)).size}`)
  lines.push(`localMemoryEntries: ${storeEntries.length}`)
  lines.push(`rankedMemoryEntries: ${ranking.entries.map(entry => `${entry.store}/${entry.key}:${entry.score ?? 0}`).join(', ') || '(none)'}`)
  lines.push('commands: /memory rank <prompt>, /memory extract <text>, /memory sync-team [team]')
  args.io.stdout.write(`${lines.join('\n')}\n`)
  return { exitRequested: false }
}

export async function runSkillsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'search') {
    const query = rest.join(' ').trim()
    await refreshSkillStoreIndex(args.cwd)
    args.io.stdout.write(`${JSON.stringify({
      query,
      results: await searchSkills(args.cwd, query),
    }, null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'store') {
    const storeAction = rest[0] ?? 'summary'
    if (!['summary', 'index', 'cache', 'refresh'].includes(storeAction)) {
      args.io.stdout.write('Usage: /skills store [summary|index|cache|refresh]\n')
      return { exitRequested: false }
    }
    const index = storeAction === 'refresh'
      ? await refreshSkillStoreIndex(args.cwd)
      : await readSkillStoreIndex(args.cwd)
    if (storeAction === 'cache') {
      args.io.stdout.write(`${JSON.stringify(await readSkillStoreCache(args.cwd), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (storeAction === 'index' || storeAction === 'refresh') {
      args.io.stdout.write(`${JSON.stringify(index, null, 2)}\n`)
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify({
      version: index.version,
      entries: index.entries.length,
      resolved: index.resolved.length,
      conflicts: index.conflicts,
      cachePath: index.cachePath,
    }, null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'generate') {
    const separatorIndex = rest.indexOf('--')
    const nameParts = separatorIndex === -1 ? rest.slice(0, 1) : rest.slice(0, separatorIndex)
    const instructionParts = separatorIndex === -1 ? rest.slice(1) : rest.slice(separatorIndex + 1)
    const name = nameParts.join(' ').trim()
    const instructions = instructionParts.join(' ').trim()
    if (!name || !instructions) {
      args.io.stdout.write('Usage: /skills generate <name> -- <instructions>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await generateSkill(args.cwd, { name, instructions }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'learn') {
    const separatorIndex = rest.indexOf('--')
    const skillParts = separatorIndex === -1 ? rest.slice(0, 1) : rest.slice(0, separatorIndex)
    const lessonParts = separatorIndex === -1 ? rest.slice(1) : rest.slice(separatorIndex + 1)
    const skillName = skillParts.join(' ').trim()
    const lesson = lessonParts.join(' ').trim()
    if (!skillName || !lesson) {
      args.io.stdout.write('Usage: /skills learn <skill> -- <lesson>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await recordSkillLearning(args.cwd, {
      skillName,
      lesson,
      source: 'manual',
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'feedback') {
    const [skillName, outcome, ...note] = rest
    if (!skillName || !isSkillImprovementOutcome(outcome)) {
      args.io.stdout.write('Usage: /skills feedback <skill> <helpful|needs_improvement|not_used> [note]\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await recordSkillImprovementFeedback(args.cwd, {
      skillName,
      outcome,
      note: note.join(' ') || undefined,
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  const registry = await discoverExtensionRegistry(args.cwd)
  const feedback = await readSkillImprovementFeedback(args.cwd)
  const learning = await readSkillLearning(args.cwd)
  const skillStore = await readSkillStoreIndex(args.cwd)
  args.io.stdout.write(`${JSON.stringify({
    skills: registry.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      path: skill.path,
    })),
    feedbackCount: feedback.length,
    feedback: feedback.slice(-5),
    learningCount: learning.length,
    learning: learning.slice(-5),
    skillStore: {
      version: skillStore.version,
      entries: skillStore.entries.length,
      resolved: skillStore.resolved.length,
      conflicts: skillStore.conflicts,
      cachePath: skillStore.cachePath,
    },
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runPluginCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, pluginName, commandName] = args.args ?? []
  if (action === 'marketplace') {
    args.io.stdout.write(`${JSON.stringify({
      marketplace: await readPluginMarketplace(args.cwd),
      installed: (await readPluginInstallState(args.cwd)).plugins,
    }, null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'install' && pluginName) {
    args.io.stdout.write(`${JSON.stringify(await installMarketplacePlugin(args.cwd, pluginName), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'update' && pluginName) {
    args.io.stdout.write(`${JSON.stringify(await updateMarketplacePlugin(args.cwd, pluginName), null, 2)}\n`)
    return { exitRequested: false }
  }
  if ((action === 'enable' || action === 'disable') && pluginName) {
    args.io.stdout.write(`${JSON.stringify(await setPluginEnabled(args.cwd, pluginName, action === 'enable'), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'reload') {
    const result = await reconcilePluginMarketplace(args.cwd)
    args.io.stdout.write(`${JSON.stringify({
      plugins: result.plugins,
      restored: result.restored,
      missing: result.missing,
      loadedPlugins: result.registry.plugins.map(plugin => plugin.name),
      mcpServers: result.registry.mcpServers.map(([name]) => name),
      mcpTools: result.registry.mcpTools.map(tool => tool.name),
    }, null, 2)}\n`)
    return { exitRequested: false }
  }
  const registry = await discoverExtensionRegistry(args.cwd)
  if (action === 'run' && pluginName && commandName) {
    const plugin = registry.plugins.find(candidate => candidate.name === pluginName)
    const command = plugin?.commands.find(candidate => candidate.name === commandName)
    if (!plugin || !command) {
      args.io.stdout.write(`Plugin command not found: ${pluginName} ${commandName}\n`)
      return { exitRequested: false }
    }
    args.io.stdout.write(`${command.content}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({
    plugins: registry.plugins.map(plugin => ({
      name: plugin.name,
      description: plugin.description,
      path: plugin.path,
      commands: plugin.commands.map(command => ({
        name: command.name,
        description: command.description,
      })),
      skills: plugin.skills.map(skill => ({
        name: skill.name,
        description: skill.description,
      })),
      mcpServers: Object.keys(plugin.mcpServers),
    })),
    installed: (await readPluginInstallState(args.cwd)).plugins,
    usage: '/plugin marketplace | install <plugin> | update <plugin> | enable <plugin> | disable <plugin> | reload | run <plugin> <command>',
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runDaemonCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const action = args.args?.[0] ?? 'status'
  if (action === 'start') {
    args.io.stdout.write(`${JSON.stringify(await startDaemon(args.cwd), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'heartbeat') {
    args.io.stdout.write(`${JSON.stringify(await heartbeatDaemon(args.cwd), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'stop') {
    args.io.stdout.write(`${JSON.stringify(await stopDaemon(args.cwd), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'status') {
    args.io.stdout.write(`${JSON.stringify(await readDaemonState(args.cwd), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write('Usage: /daemon [start|heartbeat|status|stop]\n')
  return { exitRequested: false }
}

export async function runRemoteEnvCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [name, ...valueParts] = args.args ?? []
  if (!name) {
    args.io.stdout.write(`${JSON.stringify({ env: await readRemoteEnv(args.cwd) }, null, 2)}\n`)
    return { exitRequested: false }
  }
  if (valueParts.length === 0) {
    args.io.stdout.write('Usage: /remote-env <NAME> <VALUE>\n')
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify(await setRemoteEnv(args.cwd, {
    name,
    value: valueParts.join(' '),
  }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runTasksCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'create') {
    const title = rest.join(' ').trim()
    if (!title) {
      args.io.stdout.write('Usage: /tasks create <title>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await createTask(args.cwd, { title }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'stop' && rest[0]) {
    args.io.stdout.write(`${JSON.stringify(await stopTask(args.cwd, rest[0]), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'runner') {
    const [kind, name] = rest
    if (kind === 'list' || !kind) {
      args.io.stdout.write(`${JSON.stringify({
        profiles: await readRunnerProfiles(args.cwd),
        runs: await readRunnerRuns(args.cwd),
      }, null, 2)}\n`)
      return { exitRequested: false }
    }
    if (kind === 'environment' || kind === 'byoc') {
      args.io.stdout.write(`${JSON.stringify(await runEnvironmentRunner(args.cwd, { name }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (kind === 'self-hosted') {
      args.io.stdout.write(`${JSON.stringify(await runSelfHostedRunner(args.cwd, { name }), null, 2)}\n`)
      return { exitRequested: false }
    }
    args.io.stdout.write('Usage: /tasks runner <environment|self-hosted|list> [name]\n')
    return { exitRequested: false }
  }
  if (action === 'template') {
    const [templateAction, name, ...templateRest] = rest
    if (templateAction === 'list' || !templateAction) {
      args.io.stdout.write(`${JSON.stringify({ templates: await readTaskTemplates(args.cwd) }, null, 2)}\n`)
      return { exitRequested: false }
    }
    if (templateAction === 'create') {
      const title = templateRest.join(' ').trim()
      if (!name || !title) {
        args.io.stdout.write('Usage: /tasks template create <name> <title>\n')
        return { exitRequested: false }
      }
      args.io.stdout.write(`${JSON.stringify(await createTaskTemplate(args.cwd, { name, title }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (templateAction === 'run' && name) {
      args.io.stdout.write(`${JSON.stringify(await runTaskTemplate(args.cwd, { name }), null, 2)}\n`)
      return { exitRequested: false }
    }
    args.io.stdout.write('Usage: /tasks template <create|run|list> [name] [title]\n')
    return { exitRequested: false }
  }
  if (action === 'workflow') {
    const [workflowAction, nameOrCommand, maybeCommand, ...workflowArgs] = rest
    if (workflowAction === 'list' || !workflowAction) {
      args.io.stdout.write(`${JSON.stringify({ workflows: await readWorkflowScriptRuns(args.cwd) }, null, 2)}\n`)
      return { exitRequested: false }
    }
    if (workflowAction === 'run') {
      const name = maybeCommand ? nameOrCommand : undefined
      const command = maybeCommand ?? nameOrCommand
      if (!command) {
        args.io.stdout.write('Usage: /tasks workflow run [name] <command> [args...]\n')
        return { exitRequested: false }
      }
      args.io.stdout.write(`${JSON.stringify(await runWorkflowScript(args.cwd, {
        name,
        command,
        args: workflowArgs,
      }), null, 2)}\n`)
      return { exitRequested: false }
    }
    args.io.stdout.write('Usage: /tasks workflow <run|list> [name] <command> [args...]\n')
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ tasks: await readTasks(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runScheduleCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, name, command, ...rest] = args.args ?? []
  if (action === 'add') {
    if (!name) {
      args.io.stdout.write('Usage: /schedule add <name> [command] [args...]\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await scheduleCronWorkflow(args.cwd, {
      name,
      command,
      args: rest,
      prompt: command ? undefined : name,
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'run') {
    args.io.stdout.write(`${JSON.stringify({ runs: await runDueCronWorkflows(args.cwd) }, null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify(await readAgentWorkflowState(args.cwd), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runVoiceCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'on' || action === 'off') {
    const provider = parseVoiceProvider(rest[0])
    args.io.stdout.write(`${JSON.stringify(await setVoiceMode(args.cwd, {
      enabled: action === 'on',
      ...(provider ? { provider } : {}),
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'check') {
    args.io.stdout.write(`${JSON.stringify(await checkVoiceRuntime(), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'start') {
    args.io.stdout.write(`${JSON.stringify(await startVoiceRuntimeRecording(args.cwd, { sessionId: rest[0] }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'stop') {
    if (!rest[0]) {
      args.io.stdout.write('Usage: /voice stop <sessionId>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await stopVoiceRuntimeRecording({ sessionId: rest[0] }), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ voice: await readVoiceMode(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runOnboardingCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write(formatCommandScreen(buildOnboardingScreen(args.cwd)))
  return { exitRequested: false }
}

export async function runSandboxCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write(formatCommandScreen(await collectSandboxScreen(args.cwd)))
  return { exitRequested: false }
}

export async function runPasteImageCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write(formatCommandScreen(buildNativeImagePasteScreen({
    supported: true,
    detail: 'interactive TUI uses the native clipboard image adapter when the terminal exposes one',
  })))
  return { exitRequested: false }
}

export async function runAgentsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, name, ...promptParts] = args.args ?? []
  if (action === 'builtin') {
    args.io.stdout.write(`${JSON.stringify({ builtInAgents: listBuiltInAgents() }, null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'run') {
    const prompt = promptParts.join(' ').trim()
    if ((name !== 'explore' && name !== 'plan') || !prompt) {
      args.io.stdout.write('Usage: /agents run <explore|plan> <prompt>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await runBuiltInAgent(
      args.cwd,
      { name, prompt },
      {
        cwd: args.cwd,
        permissionMode: parsePermissionMode(args.options?.permissionMode),
        allowedTools: args.options?.allowedTools,
        disallowedTools: args.options?.disallowedTools,
      },
    ), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({
    agents: await listAgents(args.cwd),
    builtInAgents: listBuiltInAgents(),
  }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runAssistantCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const mode = args.args?.[0]
  if (mode === 'focused' || mode === 'assistant' || mode === 'proactive') {
    args.io.stdout.write(`${JSON.stringify(await setAssistantMode(args.cwd, { mode }), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ assistant: await readAssistantMode(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runAutofixPrCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, repo, ...summaryParts] = args.args ?? []
  if (action === 'plan') {
    const summary = summaryParts.join(' ').trim()
    if (!repo || !summary) {
      args.io.stdout.write('Usage: /autofix-pr plan <repo> <summary>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await planAutofixPr(args.cwd, { repo, summary }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'mutate') {
    const summary = summaryParts.join(' ').trim()
    if (!repo || !summary) {
      args.io.stdout.write('Usage: /autofix-pr mutate <repo> <summary>\n')
      return { exitRequested: false }
    }
    const event = await recordWorkflowEvent(args.cwd, {
      kind: 'review',
      summary,
      payload: { repo, mutation: 'autofix-pr' },
    })
    args.io.stdout.write(`${JSON.stringify({
      repo,
      summary,
      status: 'mutation-prepared',
      event,
    }, null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ plans: await readAutofixPrPlans(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runBuddyCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...objectiveParts] = args.args ?? []
  if (action === 'start') {
    const objective = objectiveParts.join(' ').trim()
    if (!objective) {
      args.io.stdout.write('Usage: /buddy start <objective>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await startBuddySession(args.cwd, { objective }), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ buddies: await readBuddySessions(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runBriefCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'create') {
    const separatorIndex = rest.indexOf('--')
    const titleParts = separatorIndex === -1 ? rest.slice(0, 1) : rest.slice(0, separatorIndex)
    const bodyParts = separatorIndex === -1 ? rest.slice(1) : rest.slice(separatorIndex + 1)
    const title = titleParts.join(' ').trim()
    const body = bodyParts.join(' ').trim()
    if (!title || !body) {
      args.io.stdout.write('Usage: /brief create <title> -- <body>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await createBrief(args.cwd, { title, body }), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ briefs: await readBriefs(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runChannelsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, name, kind, target] = args.args ?? []
  if (action === 'register') {
    if (!name) {
      args.io.stdout.write('Usage: /channels register <name> [local|github|push] [target]\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await registerKairosChannel(args.cwd, {
      name,
      kind: isKairosChannelKind(kind) ? kind : 'local',
      target: isKairosChannelKind(kind) ? target : kind,
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ channels: await readKairosChannels(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runPushCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'send') {
    const separatorIndex = rest.indexOf('--')
    const titleParts = separatorIndex === -1 ? rest.slice(0, 1) : rest.slice(0, separatorIndex)
    const bodyParts = separatorIndex === -1 ? rest.slice(1) : rest.slice(separatorIndex + 1)
    const title = titleParts.join(' ').trim()
    const body = bodyParts.join(' ').trim()
    if (!title || !body) {
      args.io.stdout.write('Usage: /push send <title> -- <body>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await queuePushNotification(args.cwd, { title, body }), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ notifications: await readPushNotifications(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runCoordinatorCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'run') {
    const prompt = rest.join(' ').trim()
    if (!prompt) {
      args.io.stdout.write('Usage: /coordinator run <prompt>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await runCoordinator(
      args.cwd,
      { prompt },
      {
        cwd: args.cwd,
        permissionMode: parsePermissionMode(args.options?.permissionMode),
        allowedTools: args.options?.allowedTools,
        disallowedTools: args.options?.disallowedTools,
      },
    ), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ coordinator: await readCoordinatorRuns(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runMonitorCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'start') {
    const [name, command, ...commandArgs] = rest
    if (!name || !command) {
      args.io.stdout.write('Usage: /monitor start <name> <command> [args...]\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await startMonitor(args.cwd, {
      name,
      command,
      args: commandArgs,
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'output' && rest[0]) {
    args.io.stdout.write(`${await readMonitorOutput(args.cwd, rest[0])}\n`)
    return { exitRequested: false }
  }
  if (action === 'stop' && rest[0]) {
    args.io.stdout.write(`${JSON.stringify(await stopMonitor(args.cwd, rest[0]), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ monitors: await readMonitors(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runProactiveCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'schedule') {
    const prompt = rest.join(' ').trim()
    if (!prompt) {
      args.io.stdout.write('Usage: /proactive schedule <prompt>\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await scheduleProactiveTick(args.cwd, { prompt }), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ proactive: await readProactiveTicks(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runBackgroundCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'start') {
    const [name, command, ...commandArgs] = rest
    if (!name || !command) {
      args.io.stdout.write('Usage: /background start <name> <command> [args...]\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await startBackgroundJob(args.cwd, {
      name,
      command,
      args: commandArgs,
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'output' && rest[0]) {
    args.io.stdout.write(await readBackgroundOutput(args.cwd, rest[0]))
    return { exitRequested: false }
  }
  if (action === 'stop' && rest[0]) {
    args.io.stdout.write(`${JSON.stringify(await stopBackgroundJob(args.cwd, rest[0]), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify({ background: await readBackgroundJobs(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runWorkflowsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runTasksCommand({ ...args, args: ['workflow', ...((args.args?.length ?? 0) > 0 ? args.args ?? [] : ['list'])] })
}

export async function runPlanCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action] = args.args ?? []
  if (action === 'list' || !action) {
    args.io.stdout.write(`${JSON.stringify({ ultraplans: await readUltraplans(args.cwd) }, null, 2)}\n`)
    return { exitRequested: false }
  }
  const prompt = (args.args ?? []).join(' ').trim()
  args.io.stdout.write(`${JSON.stringify(await createUltraplan(args.cwd, { prompt }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runWorktreeCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [action, ...rest] = args.args ?? []
  if (action === 'enter') {
    const [path, branch] = rest
    if (!path) {
      args.io.stdout.write('Usage: /worktree enter <path> [branch]\n')
      return { exitRequested: false }
    }
    args.io.stdout.write(`${JSON.stringify(await enterWorktree(args.cwd, { path, branch }), null, 2)}\n`)
    return { exitRequested: false }
  }
  if (action === 'exit') {
    args.io.stdout.write(`${JSON.stringify(await exitWorktree(args.cwd), null, 2)}\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify(await readWorktreeState(args.cwd), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runRemoteCommandCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  try {
    const [action, ...rest] = args.args ?? []
    if (!action) {
      args.io.stdout.write(`${JSON.stringify({ remote: await readRemoteSessions(args.cwd) }, null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'connect') {
      const [name, root] = rest
      args.io.stdout.write(`${JSON.stringify(await connectRemote(args.cwd, {
        name,
        root,
        transport: 'loopback',
      }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'setup') {
      args.io.stdout.write(`${JSON.stringify(await setupRemote(args.cwd, { name: rest[0] }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'pipes' || action === 'pipe-status') {
      args.io.stdout.write(`${JSON.stringify({
        pipes: await readPipeEndpoints(args.cwd),
        udsInboxes: await readUdsInboxes(args.cwd),
      }, null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'env') {
      return runRemoteEnvCommand({ ...args, args: rest })
    }
    if (action === 'bridge-kick') {
      args.io.stdout.write(`${JSON.stringify(await kickBridge(args.cwd, rest.join(' ') || 'manual'), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'pipe-register') {
      const [name, role, sessionId] = rest
      if (!name) {
        args.io.stdout.write('Usage: /remote pipe-register <name> [standalone|master|sub] [sessionId]\n')
        return { exitRequested: false }
      }
      args.io.stdout.write(`${JSON.stringify(await registerPipeEndpoint(args.cwd, {
        name,
        role: isPipeRole(role) ? role : 'standalone',
        sessionId: isPipeRole(role) ? sessionId : role,
      }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'lan-register') {
      const [name, host, portRaw, role, sessionId] = rest
      const port = Number(portRaw)
      if (!name || !host || !Number.isInteger(port) || port < 0) {
        args.io.stdout.write('Usage: /remote lan-register <name> <host> <port> [standalone|master|sub] [sessionId]\n')
        return { exitRequested: false }
      }
      args.io.stdout.write(`${JSON.stringify(await registerLanPipeEndpoint(args.cwd, {
        name,
        host,
        port,
        role: isPipeRole(role) ? role : 'standalone',
        sessionId: isPipeRole(role) ? sessionId : role,
      }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'send') {
      const [targetName, ...body] = rest
      if (!targetName || body.length === 0) {
        args.io.stdout.write('Usage: /remote send <pipeName> <message>\n')
        return { exitRequested: false }
      }
      args.io.stdout.write(`${JSON.stringify(await sendPipeMessage(args.cwd, {
        targetName,
        body: body.join(' '),
        type: 'chat',
      }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'uds-start') {
      args.io.stdout.write(`${JSON.stringify(await startUdsInbox(args.cwd, { name: rest[0] ?? 'main' }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'uds-send') {
      const [nameOrBody, ...bodyParts] = rest
      if (!nameOrBody) {
        args.io.stdout.write('Usage: /remote uds-send [name] <message>\n')
        return { exitRequested: false }
      }
      const name = bodyParts.length > 0 ? nameOrBody : 'main'
      const body = bodyParts.length > 0 ? bodyParts.join(' ') : nameOrBody
      args.io.stdout.write(`${JSON.stringify(await sendUdsInboxMessage(args.cwd, { name, body }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'run') {
      const [sessionId, command, ...commandArgs] = rest
      if (!sessionId || !command) {
        args.io.stdout.write('Usage: /remote run <sessionId> <command> [args...]\n')
        return { exitRequested: false }
      }
      args.io.stdout.write(`${JSON.stringify(await runRemoteCommand(
        args.cwd,
        { sessionId, command, args: commandArgs },
        { permissionMode: parsePermissionMode(args.options?.permissionMode) },
      ), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'detach') {
      return runDetachCommand({ ...args, args: [rest[0] ?? ''] })
    }
    if (action === 'resume' || action === 'attach') {
      return runAttachCommand({ ...args, args: [rest[0] ?? ''] })
    }
    if (action === 'trigger') {
      const [sessionId, name] = rest
      if (!sessionId || !name) {
        args.io.stdout.write('Usage: /remote trigger <sessionId> <name>\n')
        return { exitRequested: false }
      }
      args.io.stdout.write(`${JSON.stringify(await triggerRemote(args.cwd, { sessionId, name }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'capture') {
      const [sessionId, lines] = rest
      args.io.stdout.write(`${JSON.stringify(await captureTerminal(args.cwd, {
        sessionId,
        lines: lines ? Number(lines) : undefined,
      }), null, 2)}\n`)
      return { exitRequested: false }
    }
    if (action === 'peers') {
      return runPeersCommand(args)
    }
    args.io.stdout.write('Usage: /remote [connect|ssh|run|detach|resume|trigger|capture|peers|env|bridge-kick|pipe-register|lan-register|send|pipes|uds-start|uds-send]\n')
  } catch (error) {
    args.io.stdout.write(`Remote error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  return { exitRequested: false }
}

export async function runPeersCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write(`${JSON.stringify({ peers: await readRemoteSessions(args.cwd) }, null, 2)}\n`)
  return { exitRequested: false }
}

export async function runAttachCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const sessionId = args.args?.[0]
  if (!sessionId) {
    args.io.stdout.write('Usage: /attach <sessionId>\n')
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify(await resumeRemote(args.cwd, sessionId), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runDetachCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const sessionId = args.args?.[0]
  if (!sessionId) {
    args.io.stdout.write('Usage: /detach <sessionId>\n')
    return { exitRequested: false }
  }
  args.io.stdout.write(`${JSON.stringify(await detachRemote(args.cwd, sessionId), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runPipesCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runRemoteCommandCommand({ ...args, args: ['pipes'] })
}

export async function runRemoteSetupCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runRemoteCommandCommand({ ...args, args: ['setup', ...(args.args ?? [])] })
}

export async function runBridgeCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runRemoteCommandCommand({ ...args, args: args.args ?? [] })
}

export async function runClaimMainCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runPipesCommand(args)
}

export async function runSendCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runRemoteCommandCommand({ ...args, args: ['send', ...(args.args ?? [])] })
}

export async function runTeleportCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const session = await connectRemote(args.cwd, {
    name: args.args?.[0] ?? 'teleport',
    transport: 'loopback',
  })
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult('/teleport', args.args ?? [], {
    behaviorStatus: 'local-runtime',
    sideEffect: 'created loopback teleport session',
    session,
  }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runPlatformCommand(args: CoreCommandArgs & { slash: string }): Promise<SlashCommandResult> {
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult(
    args.slash,
    args.args ?? [],
    await platformCommandPayload(args.cwd, args.slash, args.args ?? []),
  ), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runAuthCommand(args: CoreCommandArgs & { slash: string }): Promise<SlashCommandResult> {
  if (args.slash === '/logout') {
    await rm(authStatePath(args.cwd), { force: true })
    args.io.stdout.write(`${JSON.stringify(commandSpecificResult(args.slash, args.args ?? [], {
      behaviorStatus: 'local-runtime',
      authenticated: false,
      sideEffect: 'removed local auth state',
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  const existing = await readAuthState(args.cwd)
  const credential = resolveAuthCredential()
  if (!credential && !existing) {
    args.io.stdout.write(`${JSON.stringify(commandSpecificResult(args.slash, args.args ?? [], {
      behaviorStatus: 'auth-required',
      authenticated: false,
      sideEffect: 'no auth state written',
      next: 'Set ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, or MY_CLAUDE_CODE_OAUTH_TOKEN in the environment and run /login.',
    }), null, 2)}\n`)
    return { exitRequested: false }
  }
  const now = new Date().toISOString()
  const record: AuthStateRecord = {
    version: 1,
    provider: credential?.provider ?? existing?.provider ?? 'unknown',
    credentialSource: credential?.source ?? existing?.credentialSource ?? 'local-auth-state',
    tokenHash: credential?.tokenHash ?? existing?.tokenHash ?? '',
    authenticatedAt: existing?.authenticatedAt ?? now,
    refreshedAt: now,
    expiresAt: authExpiry(now),
  }
  await writeAuthState(args.cwd, record)
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult(args.slash, args.args ?? [], {
    behaviorStatus: 'local-runtime',
    authenticated: true,
    sideEffect: args.slash === '/oauth-refresh'
      ? 'refreshed local auth state metadata'
      : 'wrote local auth state metadata',
    provider: record.provider,
    credentialSource: record.credentialSource,
    tokenHash: record.tokenHash,
    expiresAt: record.expiresAt,
    secretHandling: 'raw credential values are never printed or persisted',
  }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runWorkflowDiagnosticCommand(args: CoreCommandArgs & { slash: string }): Promise<SlashCommandResult> {
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult(
    args.slash,
    args.args ?? [],
    await workflowDiagnosticPayload(args.cwd, args.slash, args.args ?? []),
  ), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runJobCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const prompt = (args.args ?? []).join(' ').trim() || 'classify local workflow job'
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult('/job', args.args ?? [], {
    behaviorStatus: 'local-runtime',
    sideEffect: 'job classifier record persisted',
    classification: await classifyWorkflowJob(args.cwd, { prompt }),
  }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runReloadPluginsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const result = await reconcilePluginMarketplace(args.cwd)
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult('/reload-plugins', args.args ?? [], {
    behaviorStatus: 'local-runtime',
    sideEffect: 'plugin marketplace state reconciled and registry rediscovered',
    restored: result.restored,
    missing: result.missing,
    plugins: result.registry.plugins.map(plugin => plugin.name),
    skills: result.registry.skills.map(skill => skill.name),
    mcpServers: result.registry.mcpServers.map(([name]) => name),
    mcpTools: result.registry.mcpTools.map(tool => tool.name),
  }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runLocalVaultCommand(args: CoreCommandArgs & { slash?: string }): Promise<SlashCommandResult> {
  const slash = args.slash ?? '/local-vault'
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult(slash, args.args ?? [], {
    behaviorStatus: 'secret-safe-local',
    sideEffect: 'read vault key names from environment only; secret values are never printed or persisted',
    vaultKeys: localVaultKeyNames(process.env),
    tool: 'VaultHttpFetch',
    permissionRules: [
      'VaultHttpFetch(<vault-key>@<host>)',
      'VaultHttpFetch(<vault-key>@*)',
    ],
    requestedAction: args.args?.[0] ?? 'list',
  }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runBreakCacheCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const snapshot = getDefaultProviderRuntime().snapshot()
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult('/break-cache', args.args ?? [], {
    behaviorStatus: 'local-runtime',
    sideEffect: 'provider cache break diagnostics read from local runtime state',
    cacheBreaks: snapshot.cacheBreaks,
    usage: snapshot.usage,
  }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runCopyCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult('/copy', args.args ?? [], {
    behaviorStatus: 'local-runtime',
    sideEffect: 'no clipboard mutation in headless command mode',
    text: (args.args ?? []).join(' '),
    reason: 'clipboard writes are handled by the interactive TUI selection pipeline',
  }), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runGenericCommandSpecificCommand(args: CoreCommandArgs & { slash: string }): Promise<SlashCommandResult> {
  args.io.stdout.write(`${JSON.stringify(commandSpecificResult(
    args.slash,
    args.args ?? [],
    genericCommandSpecificPayload(args.slash),
  ), null, 2)}\n`)
  return { exitRequested: false }
}

export async function runBackfillSessionsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runGenericCommandSpecificCommand({ ...args, slash: '/backfill-sessions' })
}

export async function runMockLimitsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runGenericCommandSpecificCommand({ ...args, slash: '/mock-limits' })
}

export async function runRenameCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runResumeCommand(args)
}

export async function runTuiCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runStatusCommand(args)
}

export async function runResumeCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const [sessionId, ...rest] = args.args ?? []
  if (!sessionId) {
    args.io.stdout.write(formatCommandScreen(buildResumeScreen(await listSessions(args.cwd))))
    return { exitRequested: false }
  }
  const session = await resolveSession(args.cwd, sessionId)
  if (!session) {
    args.io.stdout.write(`No session found: ${sessionId}\n`)
    return { exitRequested: false }
  }
  const actionIndex = rest.findIndex(value => value.startsWith('--'))
  const action = actionIndex === -1 ? undefined : rest[actionIndex]
  const recordId = actionIndex === -1 ? undefined : rest[actionIndex + 1]
  if (action === '--checkpoints') {
    const checkpoints = await listSessionCheckpoints(session, 8)
    args.io.stdout.write([
      `Checkpoints for ${session.id}:`,
      ...(checkpoints.length === 0
        ? ['No transcript checkpoints found.']
        : checkpoints.map(checkpoint =>
            `${checkpoint.recordId} | ${checkpoint.createdAt} | ${checkpoint.label}`,
          )),
      '',
    ].join('\n'))
    return { exitRequested: false }
  }
  if (action === '--fork' || action === '--rewind') {
    const checkpoint =
      action === '--rewind'
        ? recordId ?? (await listSessionCheckpoints(session, 2))[1]?.recordId
        : undefined
    const fork = await forkSession({
      cwd: args.cwd,
      sourceSessionId: session.id,
      truncateAfterRecordId: checkpoint,
      mode: action === '--rewind' ? 'rewind' : 'fork',
    })
    args.io.stdout.write(
      fork
        ? `${action === '--rewind' ? 'Rewound' : 'Forked'} ${session.id} -> ${fork.id}\n`
        : `Could not ${action === '--rewind' ? 'rewind' : 'fork'} session: ${session.id}\n`,
    )
    return { exitRequested: false }
  }
  if (action === '--rewind-files') {
    const checkpoint = recordId ?? (await listSessionCheckpoints(session, 2))[1]?.recordId
    if (!checkpoint) {
      args.io.stdout.write(`No file rewind checkpoint found for ${session.id}\n`)
      return { exitRequested: false }
    }
    const result = await rewindFilesToCheckpoint({
      cwd: args.cwd,
      session,
      checkpointRecordId: checkpoint,
    })
    args.io.stdout.write([
      `Rewound files for ${session.id} at ${checkpoint}.`,
      `restoredFiles: ${result.restoredFiles.length > 0 ? result.restoredFiles.join(', ') : '(none)'}`,
      `missingSnapshots: ${result.missingSnapshots.length > 0 ? result.missingSnapshots.join(', ') : '(none)'}`,
      `worktreeConflicts: ${result.worktreeConflicts.length > 0 ? result.worktreeConflicts.join(', ') : '(none)'}`,
      '',
    ].join('\n'))
    return { exitRequested: false }
  }
  args.io.stdout.write(`${(await replaySession(session)).summary}\n`)
  return { exitRequested: false }
}

export async function runDiffCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--stat'], {
      cwd: args.cwd,
    })
    args.io.stdout.write(
      stdout.trim()
        ? `Diff:\n${stdout}`
        : 'Diff:\nNo unstaged changes.\n',
    )
  } catch (error) {
    args.io.stdout.write(
      `Diff:\nUnavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
  return { exitRequested: false }
}

export async function runUsageCommand(args: CoreCommandArgs & { label?: string }): Promise<SlashCommandResult> {
  const context = await sessionContextStats(args.cwd, args.options?.sessionId)
  if (!context) {
    args.io.stdout.write(`No ${args.label?.toLowerCase() ?? 'usage'} found.\n`)
    return { exitRequested: false }
  }
  args.io.stdout.write([
    `${args.label ?? 'Usage'}:`,
    `estimatedTokens: ${context.stats.estimatedTokens}`,
    `inputTokens: ${context.stats.inputTokens}`,
    `outputTokens: ${context.stats.outputTokens}`,
    `promptCacheReadTokens: ${context.stats.promptCache.readInputTokens}`,
    `promptCacheHitRate: ${Math.round(context.stats.promptCache.hitRate * 100)}%`,
    `tokenBudget: ${context.stats.tokenBudget.used}/${context.stats.tokenBudget.limit} (${context.stats.tokenBudget.percentUsed}%)`,
    `assistantTextChars: ${context.stats.assistantTextChars}`,
    `toolUseCount: ${context.stats.toolUseCount}`,
    ...(args.label === 'Cost'
      ? ['estimatedCostUsd: unavailable for local DeepSeek adapter']
      : []),
    '',
  ].join('\n'))
  return { exitRequested: false }
}

export async function runVimCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  const settings = await loadSettings(args.cwd)
  const next = parseVimModeArg(args.args?.[0], settings.vimMode ?? false)
  if (next === undefined) {
    args.io.stdout.write('Usage: /vim [on|off|toggle]\n')
    return { exitRequested: false }
  }
  await setProjectSetting(args.cwd, 'vimMode', next)
  args.io.stdout.write(`vimMode: ${next ? 'on' : 'off'}\nSaved project vim mode.\n`)
  return { exitRequested: false }
}

export async function runClearCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write('Cleared current terminal view. Session transcript is preserved.\n')
  return { exitRequested: false }
}

export async function runExitCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  args.io.stdout.write('bye\n')
  return { exitRequested: true }
}

export async function runTerminalSetupCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runKeybindingsCommand(args)
}

export async function runRemoteControlServerCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runDaemonCommand(args)
}

export async function runLocalMemoryCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runMemoryCommand(args)
}

export async function runMemoryStoresCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runMemoryCommand(args)
}

export async function runSkillSearchCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runSkillsCommand({ ...args, args: ['search', ...(args.args ?? [])] })
}

export async function runSkillStoreCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runSkillsCommand({ ...args, args: ['store', ...(args.args ?? [])] })
}

export async function runSkillLearningCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runSkillsCommand({ ...args, args: ['learn', ...(args.args ?? [])] })
}

export async function runBranchCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runResumeCommand(args)
}

export async function runForkCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runResumeCommand({ ...args, args: [...(args.args ?? []), '--fork'] })
}

export async function runRewindCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runResumeCommand({ ...args, args: [...(args.args ?? []), '--rewind'] })
}

export async function runHistoryCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runResumeCommand(args)
}

export async function runSessionCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runResumeCommand(args)
}

export async function runStatsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runUsageCommand(args)
}

export async function runExtraUsageCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runUsageCommand(args)
}

export async function runResetLimitsCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runUsageCommand(args)
}

export async function runColorCommand(args: CoreCommandArgs): Promise<SlashCommandResult> {
  return runThemeCommand(args)
}

function parseAddDirCommandArgs(args: string[]): string[] {
  return args
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
}

function isSkillImprovementOutcome(
  value: string | undefined,
): value is 'helpful' | 'needs_improvement' | 'not_used' {
  return value === 'helpful' || value === 'needs_improvement' || value === 'not_used'
}

function parseVoiceProvider(value: string | undefined): 'anthropic' | 'doubao' | 'deepseek' | undefined {
  return value === 'anthropic' || value === 'doubao' || value === 'deepseek'
    ? value
    : undefined
}

function isKairosChannelKind(value: string | undefined): value is 'local' | 'github' | 'push' | 'weixin' {
  return value === 'local' || value === 'github' || value === 'push' || value === 'weixin'
}

function isPipeRole(value: string | undefined): value is 'standalone' | 'master' | 'sub' {
  return value === 'standalone' || value === 'master' || value === 'sub'
}

function commandSpecificResult(
  slash: string,
  commandArgs: string[],
  payload: Record<string, unknown>,
) {
  return {
    command: slash,
    description: SLASH_COMMAND_DESCRIPTIONS[slash] ?? 'Upstream Claude Code command',
    args: commandArgs,
    parity: {
      surface: 'registered',
      source: `claude-code/src/commands/${slash.slice(1)}`,
      strictVersion: 'R1.3',
      commandSpecific: true,
    },
    ...payload,
  }
}

async function platformCommandPayload(
  cwd: string,
  slash: string,
  commandArgs: string[],
): Promise<Record<string, unknown>> {
  const browserSessions = await readBrowserSessions(cwd)
  const activeBrowserSessions = browserSessions.map(session => ({
    id: session.id,
    url: session.url,
    title: session.title,
    status: session.status,
    viewport: session.viewport,
    eventCount: session.events.length,
    lastEvent: session.events.at(-1)?.type,
  }))

  if (slash === '/chrome') {
    return {
      behaviorStatus: 'local-runtime',
      sideEffect: 'read Chrome MCP and browser session state',
      package: '@ant/claude-for-chrome-mcp',
      nativeHost: {
        status: 'configured',
        command: 'bun run cli -- /chrome status',
        promptImport: 'claude-in-chrome prompt import is routed through browser sessions',
      },
      browserSessions: activeBrowserSessions,
      requestedAction: commandArgs[0] ?? 'status',
    }
  }

  if (slash === '/ide') {
    return {
      behaviorStatus: 'local-runtime',
      sideEffect: 'read IDE/LSP integration state',
      lspTool: 'LSP',
      services: ['services/lsp/symbols', 'services/lsp/diagnostics', 'services/lsp/selection'],
      surfaces: ['selection', 'diff', 'status', 'logging-hooks', 'MagicDocs', 'PromptSuggestion'],
      diagnostics: {
        source: '@ide:diagnostics completion and LSP tool output',
        available: true,
      },
      requestedAction: commandArgs[0] ?? 'status',
    }
  }

  if (slash === '/desktop' || slash === '/mobile') {
    return {
      behaviorStatus: 'local-runtime',
      sideEffect: 'read platform app bridge state',
      platform: slash.slice(1),
      appBridge: {
        status: 'available',
        transport: 'local command surface + computer-use/browser session state',
      },
      browserSessions: activeBrowserSessions,
      requestedAction: commandArgs[0] ?? 'status',
    }
  }

  return {
    behaviorStatus: 'local-runtime',
    sideEffect: 'prepared local app installation instructions without contacting external services',
    app: slash === '/install-github-app' ? 'github' : 'slack',
    lifecycle: ['check', 'authorize', 'install', 'verify'],
    secretHandling: 'tokens and OAuth codes must be supplied by environment or browser flow; raw secrets are never persisted',
    requestedAction: commandArgs[0] ?? 'status',
  }
}

async function workflowDiagnosticPayload(
  cwd: string,
  slash: string,
  commandArgs: string[],
): Promise<Record<string, unknown>> {
  const kind = slash.slice(1).replace(/^think-back$/, 'thinkback')
  const summary = commandArgs.join(' ').trim() || `${kind} command invoked`
  if (slash === '/review') {
    const review = await recordReviewArtifactMutation(cwd, {
      title: slash.slice(1),
      artifact: summary,
      annotations: [],
      summary,
    })
    const event = await recordWorkflowEvent(cwd, {
      kind: 'review',
      summary,
      payload: { reviewArtifactId: review.id },
    })
    return {
      behaviorStatus: 'local-runtime',
      sideEffect: 'review artifact and workflow event persisted',
      review,
      event,
    }
  }
  const event = await recordWorkflowEvent(cwd, {
    kind: 'diagnostic',
    summary,
    payload: { commandKind: kind, args: commandArgs },
  })
  return {
    behaviorStatus: 'local-runtime',
    sideEffect: 'workflow diagnostic/review event persisted',
    event,
  }
}

function genericCommandSpecificPayload(slash: string): Record<string, unknown> {
  if (slash === '/stickers' || slash === '/upgrade') {
    return {
      behaviorStatus: 'external-integration-gated',
      sideEffect: 'no network call performed',
      next: 'Platform and marketplace integrations are implemented in later refactor milestones.',
    }
  }
  if (
    slash === '/backfill-sessions' ||
    slash === '/mock-limits' ||
    slash === '/btw' ||
    slash === '/export' ||
    slash === '/passes' ||
    slash === '/poor'
  ) {
    return {
      behaviorStatus: 'diagnostic-local',
      sideEffect: 'diagnostic command evaluated without uploading local data',
      workflowRuntime: 'agent workflow diagnostic artifacts',
    }
  }
  return {
    behaviorStatus: 'command-specific',
    sideEffect: 'command-specific surface handled without falling back to unknown command',
  }
}

function localVaultKeyNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter(key => key.startsWith('MY_CLAUDE_CODE_VAULT_') && env[key])
    .map(key => key.slice('MY_CLAUDE_CODE_VAULT_'.length).toLowerCase().replace(/_/g, '-'))
    .sort((left, right) => left.localeCompare(right))
}

type AuthStateRecord = {
  version: 1
  provider: string
  credentialSource: string
  tokenHash: string
  authenticatedAt: string
  refreshedAt: string
  expiresAt: string
}

function authStatePath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'auth.json')
}

async function readAuthState(cwd: string): Promise<AuthStateRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(authStatePath(cwd), 'utf8')) as Partial<AuthStateRecord>
    if (
      parsed.version === 1 &&
      typeof parsed.provider === 'string' &&
      typeof parsed.credentialSource === 'string' &&
      typeof parsed.tokenHash === 'string' &&
      typeof parsed.authenticatedAt === 'string' &&
      typeof parsed.refreshedAt === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return parsed as AuthStateRecord
    }
  } catch {
    return undefined
  }
  return undefined
}

async function writeAuthState(cwd: string, record: AuthStateRecord): Promise<void> {
  const path = authStatePath(cwd)
  await mkdir(join(cwd, '.my-claude-code'), { recursive: true })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

function resolveAuthCredential(): { provider: string; source: string; tokenHash: string } | undefined {
  const candidates = [
    ['anthropic', 'ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY],
    ['deepseek', 'DEEPSEEK_API_KEY', process.env.DEEPSEEK_API_KEY],
    ['oauth', 'MY_CLAUDE_CODE_OAUTH_TOKEN', process.env.MY_CLAUDE_CODE_OAUTH_TOKEN],
  ] as const
  for (const [provider, source, value] of candidates) {
    if (value) {
      return {
        provider,
        source: `env:${source}`,
        tokenHash: createHash('sha256').update(value).digest('hex'),
      }
    }
  }
  return undefined
}

function authExpiry(isoNow: string): string {
  const expiresAt = new Date(isoNow)
  expiresAt.setHours(expiresAt.getHours() + 8)
  return expiresAt.toISOString()
}

function parseVimModeArg(value: string | undefined, current: boolean): boolean | undefined {
  switch (value) {
    case undefined:
      return current
    case 'on':
    case 'true':
    case 'enable':
    case 'enabled':
      return true
    case 'off':
    case 'false':
    case 'disable':
    case 'disabled':
      return false
    case 'toggle':
      return !current
    default:
      return undefined
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}
