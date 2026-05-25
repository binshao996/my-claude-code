import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { summarizeFeatureFlags } from '@my-claude-code/core'
import {
  applyAutoCompact,
  appendTranscript,
  buildRuntimeContext,
  DEFAULT_SYSTEM_PROMPT,
} from '@my-claude-code/agent-runtime'
import { getDefaultProviderRuntime } from '@my-claude-code/model-provider'
import {
  loadSettings,
  loadSettingsWithSources,
  OUTPUT_STYLE_NAMES,
  OutputStyleNameSchema,
  downloadUserSettingsSnapshot,
  setProjectSetting,
  THEME_NAMES,
  ThemeNameSchema,
  uploadUserSettingsSnapshot,
} from '@my-claude-code/settings'
import {
  forkSession,
  listSessionCheckpoints,
  listSessions,
  replaySession,
  rewindFilesToCheckpoint,
  resolveLatestSession,
  resolveSession,
  sessionContextStats,
} from '@my-claude-code/session'
import {
  createTask,
  createTaskTemplate,
  createBrief,
  createUltraplan,
  captureTerminal,
  connectRemote,
  discoverExtensionRegistry,
  detachRemote,
  enterWorktree,
  exitWorktree,
  heartbeatDaemon,
  kickBridge,
  linkAcpSession,
  getBuiltinTools,
  generateSkill,
  installMarketplacePlugin,
  listAgents,
  listBuiltInAgents,
  parsePermissionMode,
  queuePushNotification,
  planAutofixPr,
  readCoordinatorRuns,
  readAssistantMode,
  readAcpSessions,
  readAutofixPrPlans,
  readBrowserSessions,
  readBriefs,
  readBuddySessions,
  readChicagoMcpProfiles,
  readGithubWebhookSubscriptions,
  readKairosChannels,
  readProactiveTicks,
  readPushNotifications,
  readSkillImprovementFeedback,
  readSkillLearning,
  readSkillStoreCache,
  readSkillStoreIndex,
  readDaemonState,
  readBackgroundJobs,
  readBackgroundOutput,
  readMonitorOutput,
  readMonitors,
  readRemoteSessions,
  readRemoteEnv,
  readPipeEndpoints,
  readUdsInboxes,
  readPluginInstallState,
  readPluginMarketplace,
  readTorchProbes,
  readVoiceMode,
  listMemoryStoreEntries,
  rankMemoryStoreEntries,
  syncTeamMemory,
  extractMemories,
  checkVoiceRuntime,
  readRunnerProfiles,
  readRunnerRuns,
  readTasks,
  readTaskTemplates,
  readUltraplans,
  readWorkflowScriptRuns,
  readWorktreeState,
  classifyWorkflowJob,
  readAgentWorkflowState,
  recordMessageAction,
  recordReviewArtifactMutation,
  recordWorkflowEvent,
  runDueCronWorkflows,
  scheduleCronWorkflow,
  registerLanPipeEndpoint,
  registerChicagoMcpProfile,
  registerPipeEndpoint,
  recordSkillImprovementFeedback,
  recordSkillLearning,
  refreshSkillStoreIndex,
  recordTorchProbe,
  registerKairosChannel,
  reconcilePluginMarketplace,
  resumeRemote,
  runEnvironmentRunner,
  runBuiltInAgent,
  runCoordinator,
  runRemoteCommand,
  runSelfHostedRunner,
  runTaskTemplate,
  runWorkflowScript,
  scheduleProactiveTick,
  searchSkills,
  sendAcpMessage,
  sendPipeMessage,
  sendUdsInboxMessage,
  setRemoteEnv,
  setPluginEnabled,
  setVoiceMode,
  startVoiceRuntimeRecording,
  stopVoiceRuntimeRecording,
  setAssistantMode,
  setupRemote,
  startDaemon,
  startUdsInbox,
  startBackgroundJob,
  startBuddySession,
  startMonitor,
  stopDaemon,
  stopBackgroundJob,
  stopMonitor,
  stopTask,
  subscribeGithubWebhook,
  triggerRemote,
  updateMarketplacePlugin,
} from '@my-claude-code/tools'
import {
  buildHelpV2Screen,
  buildNativeImagePasteScreen,
  buildOnboardingScreen,
  buildResumeScreen,
  buildThemeScreen,
  buildWizardScreen,
  collectDoctorScreen,
  collectSandboxScreen,
  collectSettingsScreen,
  collectTrustScreen,
  formatCommandScreen,
} from './screens.js'
import { collectHardeningReport, type HardeningMode } from './hardening.js'

const execFileAsync = promisify(execFile)

export const LOCAL_SLASH_COMMAND_NAMES = [
  '/add-dir',
  '/acp',
  '/agents',
  '/assistant',
  '/attach',
  '/autofix-pr',
  '/background',
  '/brief',
  '/buddy',
  '/channels',
  '/chicago-mcp',
  '/help',
  '/clear',
  '/compact',
  '/config',
  '/context',
  '/coordinator',
  '/cost',
  '/daemon',
  '/detach',
  '/diff',
  '/doctor',
  '/env',
  '/features',
  '/health',
  '/keybindings',
  '/memory',
  '/message-action',
  '/mcp',
  '/model',
  '/monitor',
  '/output-style',
  '/parity',
  '/plugin',
  '/peers',
  '/permissions',
  '/provider',
  '/proactive',
  '/push',
  '/rate-limit-options',
  '/remote',
  '/remote-env',
  '/settings',
  '/skills',
  '/sandbox',
  '/schedule',
  '/onboarding',
  '/paste-image',
  '/resume',
  '/status',
  '/statusline',
  '/trust',
  '/subscribe-pr',
  '/tasks',
  '/theme',
  '/torch',
  '/ultraplan',
  '/usage',
  '/vim',
  '/voice',
  '/weixin',
  '/version',
  '/wizard',
  '/worktree',
  '/exit',
] as const

export const UPSTREAM_PARITY_COMMAND_NAMES = [
  '/advisor',
  '/agents-platform',
  '/ant-trace',
  '/autonomy',
  '/backfill-sessions',
  '/branch',
  '/break-cache',
  '/bridge-kick',
  '/btw',
  '/bughunter',
  '/chrome',
  '/claim-main',
  '/color',
  '/commit',
  '/commit-push-pr',
  '/copy',
  '/ctx_viz',
  '/debug-tool-call',
  '/desktop',
  '/effort',
  '/export',
  '/extra-usage',
  '/fast',
  '/feedback',
  '/files',
  '/force-snip',
  '/fork',
  '/good-claude',
  '/heapdump',
  '/history',
  '/hooks',
  '/ide',
  '/init',
  '/init-verifiers',
  '/insights',
  '/install',
  '/install-github-app',
  '/install-slack-app',
  '/issue',
  '/job',
  '/lang',
  '/local-memory',
  '/local-vault',
  '/login',
  '/logout',
  '/memory-stores',
  '/mobile',
  '/mock-limits',
  '/oauth-refresh',
  '/onboarding',
  '/passes',
  '/perf-issue',
  '/pipe-status',
  '/pipes',
  '/plan',
  '/poor',
  '/pr-comments',
  '/privacy-settings',
  '/provider',
  '/rate-limit-options',
  '/recap',
  '/release-notes',
  '/reload-plugins',
  '/remote-control',
  '/remote-control-server',
  '/remote-env',
  '/rename',
  '/reset-limits',
  '/review',
  '/rewind',
  '/sandbox',
  '/security-review',
  '/send',
  '/session',
  '/share',
  '/skill-learning',
  '/skill-search',
  '/skill-store',
  '/stats',
  '/stickers',
  '/summary',
  '/tag',
  '/teleport',
  '/terminal-setup',
  '/think-back',
  '/thinkback-play',
  '/triggers',
  '/tui',
  '/ultrareview',
  '/upgrade',
  '/vault',
  '/web-setup',
  '/workflows',
] as const

const COMMAND_ALIAS_ROUTES: Record<string, (args: string[]) => string> = {
  '/branch': args => `/resume ${args.join(' ')}`.trim(),
  '/claim-main': () => '/remote pipes',
  '/color': args => `/theme ${args.join(' ')}`.trim(),
  '/commit': () => '/diff',
  '/commit-push-pr': () => '/diff',
  '/effort': args => `/model ${args.join(' ')}`.trim(),
  '/extra-usage': () => '/usage',
  '/fast': () => '/model',
  '/files': () => '/diff',
  '/fork': args => `/resume ${args.join(' ')} --fork`.trim(),
  '/history': () => '/resume',
  '/hooks': () => '/permissions',
  '/lang': () => '/config',
  '/local-memory': () => '/memory',
  '/memory-stores': () => '/memory',
  '/pipe-status': () => '/remote pipes',
  '/pipes': () => '/remote pipes',
  '/plan': args => `/ultraplan ${args.join(' ')}`.trim(),
  '/privacy-settings': () => '/config',
  '/recap': () => '/context',
  '/remote-control': args => `/remote ${args.join(' ')}`.trim(),
  '/remote-control-server': args => `/daemon ${args.join(' ')}`.trim(),
  '/rename': () => '/resume',
  '/reset-limits': () => '/usage',
  '/rewind': args => `/resume ${args.join(' ')} --rewind`.trim(),
  '/send': args => `/remote send ${args.join(' ')}`.trim(),
  '/session': () => '/resume',
  '/skill-learning': args => `/skills learn ${args.join(' ')}`.trim(),
  '/skill-search': args => `/skills search ${args.join(' ')}`.trim(),
  '/skill-store': args => `/skills store ${args.join(' ')}`.trim(),
  '/stats': () => '/usage',
  '/summary': () => '/context',
  '/terminal-setup': () => '/keybindings',
  '/triggers': args => `/proactive ${args.join(' ')}`.trim(),
  '/tui': () => '/status',
  '/ultrareview': () => '/autofix-pr list',
  '/web-setup': () => '/remote setup',
  '/workflows': args => `/tasks workflow ${args.length > 0 ? args.join(' ') : 'list'}`.trim(),
}

const COMMAND_SPECIFIC_SURFACE_NAMES = [
  '/advisor',
  '/agents-platform',
  '/ant-trace',
  '/autonomy',
  '/backfill-sessions',
  '/break-cache',
  '/bridge-kick',
  '/btw',
  '/bughunter',
  '/chrome',
  '/copy',
  '/ctx_viz',
  '/debug-tool-call',
  '/desktop',
  '/export',
  '/feedback',
  '/force-snip',
  '/good-claude',
  '/heapdump',
  '/ide',
  '/init',
  '/init-verifiers',
  '/insights',
  '/install',
  '/install-github-app',
  '/install-slack-app',
  '/issue',
  '/job',
  '/local-vault',
  '/login',
  '/logout',
  '/mobile',
  '/mock-limits',
  '/oauth-refresh',
  '/onboarding',
  '/passes',
  '/perf-issue',
  '/poor',
  '/pr-comments',
  '/release-notes',
  '/reload-plugins',
  '/remote-env',
  '/review',
  '/security-review',
  '/share',
  '/stickers',
  '/tag',
  '/teleport',
  '/think-back',
  '/thinkback-play',
  '/upgrade',
  '/vault',
] as const

export const GENERIC_UPSTREAM_COMMAND_NAMES = UPSTREAM_PARITY_COMMAND_NAMES.filter(
  command =>
    !(command in COMMAND_ALIAS_ROUTES) &&
    !LOCAL_SLASH_COMMAND_NAMES.includes(command as typeof LOCAL_SLASH_COMMAND_NAMES[number]) &&
    !COMMAND_SPECIFIC_SURFACE_NAMES.includes(command as typeof COMMAND_SPECIFIC_SURFACE_NAMES[number]),
)

export const SLASH_COMMAND_NAMES = uniqueStrings([
  ...LOCAL_SLASH_COMMAND_NAMES,
  ...UPSTREAM_PARITY_COMMAND_NAMES,
])

export const SLASH_COMMAND_DESCRIPTIONS: Record<string, string> = {
  '/add-dir': 'Add extra directories to the current session context',
  '/acp': 'Link or list local ACP client records',
  '/agents': 'List local subagent delegation records',
  '/assistant': 'Show or set local assistant/Kairos mode',
  '/attach': 'Attach or resume a remote session',
  '/autofix-pr': 'Create or list local autofix PR plans',
  '/background': 'List, start, stop, or read local background jobs',
  '/brief': 'Create or list local Kairos brief records',
  '/buddy': 'Start or list local buddy helper sessions',
  '/channels': 'Register or list local Kairos channels',
  '/chicago-mcp': 'Register or list local Chicago MCP profiles',
  '/help': 'Show available slash commands',
  '/clear': 'Clear the visible terminal view',
  '/compact': 'Summarize the current session context',
  '/config': 'Show effective non-secret project configuration',
  '/context': 'Show current session context statistics',
  '/coordinator': 'Run or list local coordinator worker records',
  '/cost': 'Show current session usage and estimated cost placeholders',
  '/daemon': 'Start, stop, or inspect the remote-control daemon',
  '/detach': 'Detach a remote session',
  '/diff': 'Show git diff summary',
  '/doctor': 'Run local installation and environment diagnostics',
  '/env': 'Show non-secret runtime environment summary',
  '/features': 'Show feature gate matrix and runtime enablement',
  '/health': 'Run V1.0 release health checks',
  '/keybindings': 'Show active prompt and TUI keybindings',
  '/memory': 'Show project memory file summary',
  '/message-action': 'Record a local message action such as retry, edit, delete, pin, copy, or rate',
  '/mcp': 'Show configured MCP servers, resources, and tools',
  '/model': 'Show the active model',
  '/monitor': 'List, start, stop, or read long-running monitor commands',
  '/output-style': 'Show active output style',
  '/parity': 'Run V1.0 parity hardening audit',
  '/plugin': 'List or execute local plugin commands',
  '/peers': 'List known remote peers',
  '/permissions': 'Show current tool permission rules',
  '/proactive': 'Schedule or list local proactive ticks',
  '/push': 'Queue or list local push notifications',
  '/remote': 'Connect, run, detach, resume, or inspect remote sessions',
  '/settings': 'Show structured settings sources and effective values',
  '/skills': 'List local and plugin skills',
  '/paste-image': 'Show native image paste and clipboard attachment state',
  '/resume': 'List, resume, fork, or rewind sessions',
  '/status': 'Show runtime status',
  '/statusline': 'Show compact status line text',
  '/trust': 'Show workspace trust and project onboarding state',
  '/subscribe-pr': 'Record or list local PR webhook subscriptions',
  '/tasks': 'List, create, or stop persistent workflow tasks',
  '/theme': 'View or change the project theme',
  '/torch': 'Record or list local Torch diagnostics probes',
  '/ultraplan': 'Create or list local ultraplan planning records',
  '/usage': 'Show current session usage summary',
  '/vim': 'View or change Vim prompt editing mode',
  '/voice': 'Show or set local voice-mode state',
  '/weixin': 'Show or configure builtin Weixin channel integration',
  '/version': 'Show the CLI version',
  '/wizard': 'Open guided setup command surface',
  '/worktree': 'Show or change active worktree session metadata',
  '/exit': 'Exit the interactive terminal app',
  '/advisor': 'Show upstream advisor command parity surface',
  '/agents-platform': 'Open or describe the upstream agents platform command surface',
  '/ant-trace': 'Show upstream internal trace command parity surface',
  '/autonomy': 'Show upstream autonomy mode command surface',
  '/backfill-sessions': 'Show upstream hidden session backfill command surface',
  '/branch': 'Create or inspect a conversation branch surface',
  '/break-cache': 'Show prompt cache break command surface',
  '/bridge-kick': 'Show bridge failure injection command surface',
  '/btw': 'Show upstream BTW command surface',
  '/bughunter': 'Show upstream hidden bughunter command surface',
  '/chrome': 'Show Claude in Chrome command surface',
  '/claim-main': 'Show pipe main-claim command surface',
  '/color': 'Show terminal color command surface',
  '/commit': 'Show commit command surface',
  '/commit-push-pr': 'Show commit, push, and PR command surface',
  '/copy': 'Show copy command surface',
  '/ctx_viz': 'Show context visualization command surface',
  '/debug-tool-call': 'Inspect tool call pairing command surface',
  '/desktop': 'Show desktop integration command surface',
  '/effort': 'Show model effort command surface',
  '/export': 'Show transcript export command surface',
  '/extra-usage': 'Show extra usage command surface',
  '/fast': 'Show fast mode command surface',
  '/feedback': 'Show feedback command surface',
  '/files': 'Show session files command surface',
  '/force-snip': 'Show forced history snip command surface',
  '/fork': 'Create a conversation fork surface',
  '/good-claude': 'Show upstream hidden positive feedback command surface',
  '/heapdump': 'Show heap dump diagnostic command surface',
  '/history': 'Show connected peer history command surface',
  '/hooks': 'Show hook configuration command surface',
  '/ide': 'Show IDE integration command surface',
  '/init': 'Show project initialization command surface',
  '/init-verifiers': 'Show verifier initialization command surface',
  '/insights': 'Show session insights command surface',
  '/install': 'Show native install command surface',
  '/install-github-app': 'Show GitHub app setup command surface',
  '/install-slack-app': 'Show Slack app setup command surface',
  '/issue': 'Show issue command surface',
  '/job': 'Classify a job request into agent, workflow, monitor, review, or diagnostic execution',
  '/lang': 'Show language command surface',
  '/local-memory': 'Show local memory command surface',
  '/local-vault': 'Show local vault command surface',
  '/login': 'Show login command surface',
  '/logout': 'Show logout command surface',
  '/memory-stores': 'Show remote memory stores command surface',
  '/mobile': 'Show mobile command surface',
  '/mock-limits': 'Show mock limits command surface',
  '/oauth-refresh': 'Show OAuth refresh command surface',
  '/onboarding': 'Show first-run project trust and setup flow',
  '/passes': 'Show passes command surface',
  '/perf-issue': 'Show performance issue command surface',
  '/pipe-status': 'Show pipe status command surface',
  '/pipes': 'Show pipe command surface',
  '/plan': 'Enter plan mode command surface',
  '/poor': 'Show poor mode command surface',
  '/pr-comments': 'Show pull request comments command surface',
  '/privacy-settings': 'Show privacy settings command surface',
  '/provider': 'Show provider command surface',
  '/rate-limit-options': 'Show rate limit options command surface',
  '/recap': 'Show recap command surface',
  '/release-notes': 'Show release notes command surface',
  '/reload-plugins': 'Show plugin reload command surface',
  '/remote-control': 'Show remote control command surface',
  '/remote-control-server': 'Show remote control server command surface',
  '/remote-env': 'Show remote environment command surface',
  '/rename': 'Show session rename command surface',
  '/reset-limits': 'Show limit reset command surface',
  '/review': 'Show pull request review command surface',
  '/rewind': 'Show rewind command surface',
  '/sandbox': 'Show sandbox and permission isolation state',
  '/schedule': 'Create, run, or list local cron-style workflow schedules',
  '/security-review': 'Show security review command surface',
  '/send': 'Show peer send command surface',
  '/session': 'Show remote session command surface',
  '/share': 'Show share command surface',
  '/skill-learning': 'Show skill learning command surface',
  '/skill-search': 'Show skill search command surface',
  '/skill-store': 'Show skill store command surface',
  '/stats': 'Show stats command surface',
  '/stickers': 'Show stickers command surface',
  '/summary': 'Show summary command surface',
  '/tag': 'Show tag command surface',
  '/teleport': 'Show teleport command surface',
  '/terminal-setup': 'Show terminal setup command surface',
  '/think-back': 'Show think-back command surface',
  '/thinkback-play': 'Show thinkback playback command surface',
  '/triggers': 'Show scheduled triggers command surface',
  '/tui': 'Show TUI command surface',
  '/ultrareview': 'Show ultra review command surface',
  '/upgrade': 'Show upgrade command surface',
  '/vault': 'Show vault command surface',
  '/web-setup': 'Show web remote setup command surface',
  '/workflows': 'Show workflow scripts command surface',
}

export const SLASH_COMMAND_ARGUMENT_DESCRIPTIONS: Partial<
  Record<string, Record<string, string>>
> = {
  '/add-dir': {
    '<path>': 'Directory to add; accepts comma-separated paths',
  },
  '/acp': {
    link: 'Open a local ACP JSONL client link: /acp link [client]',
    send: 'Send through an ACP JSONL queue: /acp send <sessionId> <message>',
    list: 'List local ACP links',
  },
  '/autofix-pr': {
    plan: 'Create a local autofix PR plan: /autofix-pr plan <repo> <summary>',
    mutate: 'Prepare a local autofix PR mutation artifact: /autofix-pr mutate <repo> <summary>',
    list: 'List local autofix PR plans',
  },
  '/message-action': {
    '<messageId> <action>': 'Record copy, retry, edit, delete, pin, or rate for a message',
  },
  '/buddy': {
    start: 'Start a local buddy session: /buddy start <objective>',
    list: 'List local buddy sessions',
  },
  '/chicago-mcp': {
    register: 'Register a local Chicago MCP profile: /chicago-mcp register [name] [endpoint]',
    list: 'List local Chicago MCP profiles',
  },
  '/resume': {
    '--checkpoints': 'List transcript checkpoints',
    '--fork': 'Fork the selected session',
    '--rewind': 'Fork a session at a transcript checkpoint',
    '--rewind-files': 'Restore file snapshots at a checkpoint',
  },
  '/agents': {
    builtin: 'List built-in Explore and Plan agents',
    run: 'Run a built-in agent: /agents run <explore|plan> <prompt>',
  },
  '/assistant': {
    focused: 'Set focused mode',
    assistant: 'Set assistant mode',
    proactive: 'Set proactive assistant mode',
  },
  '/brief': {
    create: 'Create a local brief: /brief create <title> -- <body>',
    list: 'List local briefs',
  },
  '/channels': {
    register: 'Register a channel: /channels register <name> [local|github|push] [target]',
    list: 'List channels',
  },
  '/coordinator': {
    run: 'Launch local coordinator workers: /coordinator run <prompt>',
    list: 'List coordinator runs',
  },
  '/proactive': {
    schedule: 'Schedule a proactive tick: /proactive schedule <prompt>',
    list: 'List proactive ticks',
  },
  '/schedule': {
    add: 'Create a cron-style schedule: /schedule add <name> <command> [args...]',
    run: 'Run due schedules',
    list: 'List schedules and runs',
  },
  '/push': {
    send: 'Queue a local push notification: /push send <title> -- <body>',
    list: 'List queued local push notifications',
  },
  '/subscribe-pr': {
    '<repo> <pr_number>': 'Record a local PR webhook subscription',
    list: 'List local PR webhook subscriptions',
  },
  '/ultraplan': {
    list: 'List local ultraplan records',
    '<prompt>': 'Create a local ultraplan record',
  },
  '/daemon': {
    start: 'Start the local remote-control daemon state',
    status: 'Show daemon status',
    stop: 'Stop the local remote-control daemon state',
  },
  '/tasks': {
    runner: 'Run or list local headless runners: /tasks runner <environment|self-hosted|list> [name]',
    template: 'Create, run, or list task templates: /tasks template <create|run|list>',
    workflow: 'Run or list workflow scripts: /tasks workflow <run|list> [name] <command> [args...]',
  },
  '/torch': {
    probe: 'Record a local Torch probe: /torch probe <target>',
    list: 'List local Torch probes',
  },
  '/voice': {
    check: 'Check microphone backend and STT availability',
    on: 'Enable voice mode after microphone and STT checks',
    off: 'Disable local voice-mode state',
    start: 'Start push-to-talk recording: /voice start [sessionId]',
    stop: 'Stop push-to-talk recording: /voice stop <sessionId>',
  },
  '/monitor': {
    start: 'Start a monitor command: /monitor start <name> <command> [args...]',
    output: 'Read monitor output: /monitor output <id>',
    stop: 'Stop a monitor: /monitor stop <id>',
  },
  '/remote': {
    connect: 'Create a loopback remote session: /remote connect [name] [root]',
    ssh: 'Create a real SSH-compatible remote session: /remote ssh <host> [root] [sshCommand] [sshArgs...]',
    run: 'Run a command: /remote run <sessionId> <command> [args...]',
    setup: 'Prepare local remote-control setup state and smoke metadata',
    pipes: 'List registered local pipe IPC endpoints',
    'pipe-register': 'Register a local pipe IPC endpoint',
    'lan-register': 'Register or bind a LAN TCP pipe endpoint',
    send: 'Send a pipe IPC message, using TCP for LAN endpoints when available',
    'uds-start': 'Start a Unix-domain-socket inbox',
    'uds-send': 'Send a message to a Unix-domain-socket inbox',
    detach: 'Detach a session: /remote detach <sessionId>',
    resume: 'Resume a detached session: /remote resume <sessionId>',
    trigger: 'Append a bridge trigger: /remote trigger <sessionId> <name>',
    capture: 'Capture recent remote transcript lines',
  },
  '/skills': {
    feedback: 'Record local skill feedback: /skills feedback <skill> <helpful|needs_improvement|not_used> [note]',
    generate: 'Create a local skill markdown file: /skills generate <name> -- <instructions>',
    learn: 'Record local skill learning: /skills learn <skill> -- <lesson>',
    search: 'Search ranked local skills: /skills search [query]',
    store: 'Inspect local skill store index/cache: /skills store [summary|index|cache|refresh]',
  },
  '/theme': {
    default: 'Use the default theme',
    dark: 'Use the dark theme',
    light: 'Use the light theme',
    auto: 'Follow terminal color capability',
  },
  '/vim': {
    on: 'Enable Vim prompt editing',
    off: 'Disable Vim prompt editing',
    toggle: 'Toggle Vim prompt editing',
  },
}

export const KEYBINDING_SECTIONS = [
  {
    name: 'Prompt',
    bindings: [
      ['Enter', 'submit prompt'],
      ['Shift+Enter', 'insert newline'],
      ['Tab', 'accept selected completion'],
      ['Up / Down', 'history or completion selection'],
      ['Up / Esc with queued input', 'move editable queued prompts back to input'],
      ['Ctrl+R', 'reverse history search'],
      ['Ctrl+A / Ctrl+E', 'move to line start/end'],
      ['Ctrl+B / Ctrl+F', 'move left/right'],
      ['Alt+B / Alt+F', 'move word left/right'],
      ['Ctrl+U / Ctrl+K', 'delete to line start/end'],
      ['Ctrl+W', 'delete previous word'],
      ['Ctrl+C', 'copy selection or abort running request'],
      ['Ctrl+D', 'exit when idle'],
    ],
  },
  {
    name: 'Vim prompt mode',
    bindings: [
      ['Esc', 'normal mode'],
      ['i / a', 'enter insert mode before/after cursor'],
      ['h / l / b / w / 0 / $', 'normal-mode motions'],
      ['x', 'delete character under cursor'],
      ['dd', 'delete current line'],
      ['Enter', 'submit prompt from normal mode'],
    ],
  },
  {
    name: 'TUI',
    bindings: [
      ['PageUp / PageDown', 'scroll message window'],
      ['Mouse drag', 'select prompt or screen text'],
      ['Esc', 'clear selection or close overlay'],
    ],
  },
] as const

export type WritableStreamLike = {
  write(chunk: string): void
}

export type CommandIO = {
  stdout: WritableStreamLike
  stderr: WritableStreamLike
}

export type SlashCommandOptions = {
  model?: string
  permissionMode?: string
  allowedTools?: string[]
  tools?: string[]
  disallowedTools?: string[]
  addDir?: string[]
  additionalDirectories?: string[]
  resume?: string | boolean
  sessionId?: string
  vimMode?: boolean
}

export type SlashCommandResult = {
  exitRequested: boolean
  additionalDirectories?: string[]
}

export class UnknownSlashCommandError extends Error {
  exitCode = 1

  constructor(command: string) {
    super(`unknown command: ${command}`)
    this.name = 'UnknownSlashCommandError'
  }
}

export class SessionNotFoundError extends Error {
  exitCode = 1

  constructor() {
    super('no session found to resume')
    this.name = 'SessionNotFoundError'
  }
}

export function slashCommandHelp(): string {
  return [
    'Available commands:',
    ...SLASH_COMMAND_NAMES,
    '',
  ].join('\n')
}

export async function runSlashCommand(args: {
  command: string
  options?: SlashCommandOptions
  io: CommandIO
  cwd?: string
  version: string
}): Promise<SlashCommandResult> {
  const options = args.options ?? {}
  const cwd = args.cwd ?? process.cwd()
  const [commandName, ...commandArgs] = args.command.trim().split(/\s+/)

  switch (commandName) {
    case '/add-dir':
      return printAddDir({
        io: args.io,
        currentDirectories: options.additionalDirectories ?? options.addDir,
        directories: commandArgs,
      })
    case '/acp':
      await printAcp({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/agents':
      await printAgents({ io: args.io, cwd, commandArgs, options })
      return { exitRequested: false }
    case '/assistant':
      await printAssistant({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/attach':
      await printAttach({ io: args.io, cwd, sessionId: commandArgs[0] })
      return { exitRequested: false }
    case '/autofix-pr':
      await printAutofixPr({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/background':
      await printBackground({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/brief':
      await printBrief({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/buddy':
      await printBuddy({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/channels':
      await printChannels({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/chicago-mcp':
      await printChicagoMcp({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/help':
      args.io.stdout.write(formatCommandScreen(buildHelpV2Screen({
        commandNames: SLASH_COMMAND_NAMES,
        descriptions: SLASH_COMMAND_DESCRIPTIONS,
        filter: commandArgs.join(' '),
      })))
      return { exitRequested: false }
    case '/clear':
      args.io.stdout.write('Cleared current terminal view. Session transcript is preserved.\n')
      return { exitRequested: false }
    case '/compact':
      await printContext({ options, io: args.io, cwd, compact: true })
      return { exitRequested: false }
    case '/config':
      await printConfig({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/context':
      await printContext({ options, io: args.io, cwd })
      return { exitRequested: false }
    case '/coordinator':
      await printCoordinator({ io: args.io, cwd, commandArgs, options })
      return { exitRequested: false }
    case '/cost':
      await printUsage({ options, io: args.io, cwd, label: 'Cost' })
      return { exitRequested: false }
    case '/daemon':
      await printDaemon({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/detach':
      await printDetach({ io: args.io, cwd, sessionId: commandArgs[0] })
      return { exitRequested: false }
    case '/diff':
      await printDiff({ io: args.io, cwd })
      return { exitRequested: false }
    case '/doctor':
      await printDoctor({ options, io: args.io, cwd, version: args.version })
      return { exitRequested: false }
    case '/env':
      printEnv({ io: args.io, cwd })
      return { exitRequested: false }
    case '/features':
      printFeatures({ io: args.io })
      return { exitRequested: false }
    case '/health':
      await printHardening({ io: args.io, cwd, version: args.version })
      return { exitRequested: false }
    case '/keybindings':
      printKeybindings({ io: args.io })
      return { exitRequested: false }
    case '/memory':
      await printMemory({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/message-action':
      await printMessageAction({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/mcp':
      await printMcp({ io: args.io, cwd })
      return { exitRequested: false }
    case '/model':
      await printModel({ options, io: args.io, cwd })
      return { exitRequested: false }
    case '/monitor':
      await printMonitor({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/output-style':
      await printOutputStyle({
        io: args.io,
        cwd,
        outputStyleName: commandArgs[0],
      })
      return { exitRequested: false }
    case '/parity':
      await printHardening({
        io: args.io,
        cwd,
        version: args.version,
        mode: parseParityMode(commandArgs),
        focus: parseParityFocus(commandArgs),
      })
      return { exitRequested: false }
    case '/permissions':
      await printPermissions({ options, io: args.io, cwd })
      return { exitRequested: false }
    case '/provider':
      await printProvider({ options, io: args.io, cwd })
      return { exitRequested: false }
    case '/proactive':
      await printProactive({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/push':
      await printPush({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/rate-limit-options':
      printRateLimitOptions({ io: args.io })
      return { exitRequested: false }
    case '/skills':
      await printSkills({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/plugin':
      await printPlugin({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/peers':
      await printPeers({ io: args.io, cwd })
      return { exitRequested: false }
    case '/resume':
      await printResumeList({
        io: args.io,
        cwd,
        ...parseResumeCommandArgs(commandArgs),
      })
      return { exitRequested: false }
    case '/remote':
      await printRemote({ io: args.io, cwd, commandArgs, options })
      return { exitRequested: false }
    case '/remote-env':
      await printRemoteEnv({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/settings':
      args.io.stdout.write(formatCommandScreen(await collectSettingsScreen({ cwd })))
      return { exitRequested: false }
    case '/sandbox':
      args.io.stdout.write(formatCommandScreen(await collectSandboxScreen(cwd)))
      return { exitRequested: false }
    case '/schedule':
      await printSchedule({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/onboarding':
      args.io.stdout.write(formatCommandScreen(buildOnboardingScreen(cwd)))
      return { exitRequested: false }
    case '/paste-image':
      args.io.stdout.write(formatCommandScreen(buildNativeImagePasteScreen({
        supported: true,
        detail: 'interactive TUI uses the native clipboard image adapter when the terminal exposes one',
      })))
      return { exitRequested: false }
    case '/status':
      await printStatus({ options, io: args.io, cwd, version: args.version })
      return { exitRequested: false }
    case '/statusline':
      await printStatusLine({ options, io: args.io, cwd, version: args.version })
      return { exitRequested: false }
    case '/trust':
      args.io.stdout.write(formatCommandScreen(await collectTrustScreen(cwd)))
      return { exitRequested: false }
    case '/subscribe-pr':
      await printSubscribePr({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/tasks':
      await printTasks({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/theme':
      await printTheme({
        io: args.io,
        cwd,
        themeName: commandArgs[0],
      })
      return { exitRequested: false }
    case '/torch':
      await printTorch({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/ultraplan':
      await printUltraplan({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/usage':
      await printUsage({ options, io: args.io, cwd })
      return { exitRequested: false }
    case '/vim':
      await printVim({
        io: args.io,
        cwd,
        arg: commandArgs[0],
        options,
      })
      return { exitRequested: false }
    case '/voice':
      await printVoice({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/weixin':
      await printWeixin({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/version':
      args.io.stdout.write(`${args.version}\n`)
      return { exitRequested: false }
    case '/wizard':
      args.io.stdout.write(formatCommandScreen(buildWizardScreen()))
      return { exitRequested: false }
    case '/worktree':
      await printWorktree({ io: args.io, cwd, commandArgs })
      return { exitRequested: false }
    case '/exit':
      args.io.stdout.write('bye\n')
      return { exitRequested: true }
    default:
      if (commandName && commandName in COMMAND_ALIAS_ROUTES) {
        return runSlashCommand({
          ...args,
          cwd,
          options,
          command: COMMAND_ALIAS_ROUTES[commandName](commandArgs),
        })
      }
      if (isCommandSpecificSurface(commandName)) {
        await printCommandSpecificSurface({
          io: args.io,
          cwd,
          commandName,
          commandArgs,
        })
        return { exitRequested: false }
      }
      if (isKnownSlashCommand(commandName)) {
        printUpstreamParityCommandSurface({
          io: args.io,
          commandName,
          commandArgs,
        })
        return { exitRequested: false }
      }
      throw new UnknownSlashCommandError(commandName ?? args.command)
  }
}

function isCommandSpecificSurface(commandName: string | undefined): commandName is typeof COMMAND_SPECIFIC_SURFACE_NAMES[number] {
  return Boolean(commandName && COMMAND_SPECIFIC_SURFACE_NAMES.includes(commandName as typeof COMMAND_SPECIFIC_SURFACE_NAMES[number]))
}

async function printCommandSpecificSurface(args: {
  io: CommandIO
  cwd: string
  commandName: typeof COMMAND_SPECIFIC_SURFACE_NAMES[number]
  commandArgs: string[]
}) {
  if (args.commandName === '/init') {
    await printInitCommand(args)
    return
  }
  if (
    args.commandName === '/login' ||
    args.commandName === '/logout' ||
    args.commandName === '/oauth-refresh'
  ) {
    await printAuthCommand(args)
    return
  }
  if (args.commandName === '/reload-plugins') {
    const result = await reconcilePluginMarketplace(args.cwd)
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'local-runtime',
          sideEffect: 'plugin marketplace state reconciled and registry rediscovered',
          restored: result.restored,
          missing: result.missing,
          plugins: result.registry.plugins.map(plugin => plugin.name),
          skills: result.registry.skills.map(skill => skill.name),
          mcpServers: result.registry.mcpServers.map(([name]) => name),
          mcpTools: result.registry.mcpTools.map(tool => tool.name),
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (args.commandName === '/job') {
    const prompt = args.commandArgs.join(' ').trim() || 'classify local workflow job'
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'local-runtime',
          sideEffect: 'job classifier record persisted',
          classification: await classifyWorkflowJob(args.cwd, { prompt }),
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (isAgentWorkflowCommand(args.commandName)) {
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(
          args,
          await agentWorkflowCommandPayload(args.cwd, args.commandName, args.commandArgs),
        ),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (args.commandName === '/copy') {
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'local-runtime',
          sideEffect: 'no clipboard mutation in headless command mode',
          text: args.commandArgs.join(' '),
          reason: 'clipboard writes are handled by the interactive TUI selection pipeline',
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (args.commandName === '/break-cache') {
    const snapshot = getDefaultProviderRuntime().snapshot()
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'local-runtime',
          sideEffect: 'provider cache break diagnostics read from local runtime state',
          cacheBreaks: snapshot.cacheBreaks,
          usage: snapshot.usage,
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (args.commandName === '/local-vault' || args.commandName === '/vault') {
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'secret-safe-local',
          sideEffect: 'read vault key names from environment only; secret values are never printed or persisted',
          vaultKeys: localVaultKeyNames(process.env),
          tool: 'VaultHttpFetch',
          permissionRules: [
            'VaultHttpFetch(<vault-key>@<host>)',
            'VaultHttpFetch(<vault-key>@*)',
          ],
          requestedAction: args.commandArgs[0] ?? 'list',
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (isPlatformCommand(args.commandName)) {
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(
          args,
          await platformCommandPayload(args.cwd, args.commandName, args.commandArgs),
        ),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (args.commandName === '/bridge-kick') {
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'local-runtime',
          sideEffect: 'remote bridge reconnect recorded',
          event: await kickBridge(args.cwd, args.commandArgs.join(' ') || 'manual'),
          daemon: await readDaemonState(args.cwd),
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (args.commandName === '/teleport') {
    const session = await connectRemote(args.cwd, {
      name: args.commandArgs[0] ?? 'teleport',
      transport: 'loopback',
    })
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'local-runtime',
          sideEffect: 'created loopback teleport session',
          session,
        }),
        null,
        2,
      )}\n`,
    )
    return
  }

  args.io.stdout.write(
    `${JSON.stringify(commandSpecificResult(args, commandSpecificPayload(args.commandName)), null, 2)}\n`,
  )
}

function localVaultKeyNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter(key => key.startsWith('MY_CLAUDE_CODE_VAULT_') && env[key])
    .map(key => key.slice('MY_CLAUDE_CODE_VAULT_'.length).toLowerCase().replace(/_/g, '-'))
    .sort((left, right) => left.localeCompare(right))
}

function isAgentWorkflowCommand(
  commandName: typeof COMMAND_SPECIFIC_SURFACE_NAMES[number],
): boolean {
  return (
    commandName === '/ant-trace' ||
    commandName === '/bughunter' ||
    commandName === '/ctx_viz' ||
    commandName === '/debug-tool-call' ||
    commandName === '/feedback' ||
    commandName === '/good-claude' ||
    commandName === '/heapdump' ||
    commandName === '/issue' ||
    commandName === '/perf-issue' ||
    commandName === '/pr-comments' ||
    commandName === '/release-notes' ||
    commandName === '/review' ||
    commandName === '/security-review' ||
    commandName === '/share' ||
    commandName === '/stickers' ||
    commandName === '/tag' ||
    commandName === '/think-back' ||
    commandName === '/thinkback-play'
  )
}

async function agentWorkflowCommandPayload(
  cwd: string,
  commandName: typeof COMMAND_SPECIFIC_SURFACE_NAMES[number],
  commandArgs: string[],
): Promise<Record<string, unknown>> {
  const kind = commandName.slice(1).replace(/^think-back$/, 'thinkback')
  const summary = commandArgs.join(' ').trim() || `${kind} command invoked`
  if (commandName === '/review' || commandName === '/security-review') {
    const review = await recordReviewArtifactMutation(cwd, {
      title: commandName.slice(1),
      artifact: summary,
      annotations: [],
      summary,
    })
    const event = await recordWorkflowEvent(cwd, {
      kind: commandName === '/review' ? 'review' : 'security-review',
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
    kind: kind as Parameters<typeof recordWorkflowEvent>[1]['kind'],
    summary,
    payload: { args: commandArgs },
  })
  return {
    behaviorStatus: 'local-runtime',
    sideEffect: 'workflow diagnostic/review event persisted',
    event,
  }
}

function isPlatformCommand(
  commandName: typeof COMMAND_SPECIFIC_SURFACE_NAMES[number],
): boolean {
  return (
    commandName === '/chrome' ||
    commandName === '/desktop' ||
    commandName === '/mobile' ||
    commandName === '/install-github-app' ||
    commandName === '/install-slack-app' ||
    commandName === '/ide'
  )
}

async function platformCommandPayload(
  cwd: string,
  commandName: typeof COMMAND_SPECIFIC_SURFACE_NAMES[number],
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

  if (commandName === '/chrome') {
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

  if (commandName === '/ide') {
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

  if (commandName === '/desktop' || commandName === '/mobile') {
    return {
      behaviorStatus: 'local-runtime',
      sideEffect: 'read platform app bridge state',
      platform: commandName.slice(1),
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
    app: commandName === '/install-github-app' ? 'github' : 'slack',
    lifecycle: ['check', 'authorize', 'install', 'verify'],
    secretHandling: 'tokens and OAuth codes must be supplied by environment or browser flow; raw secrets are never persisted',
    requestedAction: commandArgs[0] ?? 'status',
  }
}

async function printInitCommand(args: {
  io: CommandIO
  cwd: string
  commandName: typeof COMMAND_SPECIFIC_SURFACE_NAMES[number]
  commandArgs: string[]
}) {
  const memoryPath = join(args.cwd, 'CLAUDE.md')
  let created = false
  try {
    await readFile(memoryPath, 'utf8')
  } catch {
    await writeFile(
      memoryPath,
      [
        '# Project Instructions',
        '',
        'Add project-specific guidance for my-claude-code here.',
        '',
      ].join('\n'),
      'utf8',
    )
    created = true
  }
  await mkdir(join(args.cwd, '.my-claude-code'), { recursive: true })
  args.io.stdout.write(
    `${JSON.stringify(
      commandSpecificResult(args, {
        behaviorStatus: 'local-runtime',
        sideEffect: created ? 'created CLAUDE.md' : 'CLAUDE.md already exists',
        files: [memoryPath],
      }),
      null,
      2,
    )}\n`,
  )
}

async function printAuthCommand(args: {
  io: CommandIO
  cwd: string
  commandName: typeof COMMAND_SPECIFIC_SURFACE_NAMES[number]
  commandArgs: string[]
}) {
  if (args.commandName === '/logout') {
    await rm(authStatePath(args.cwd), { force: true })
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'local-runtime',
          authenticated: false,
          sideEffect: 'removed local auth state',
        }),
        null,
        2,
      )}\n`,
    )
    return
  }

  const existing = await readAuthState(args.cwd)
  const credential = resolveAuthCredential()
  if (!credential && !existing) {
    args.io.stdout.write(
      `${JSON.stringify(
        commandSpecificResult(args, {
          behaviorStatus: 'auth-required',
          authenticated: false,
          sideEffect: 'no auth state written',
          next: 'Set ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, or MY_CLAUDE_CODE_OAUTH_TOKEN in the environment and run /login.',
        }),
        null,
        2,
      )}\n`,
    )
    return
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
  args.io.stdout.write(
    `${JSON.stringify(
      commandSpecificResult(args, {
        behaviorStatus: 'local-runtime',
        authenticated: true,
        sideEffect:
          args.commandName === '/oauth-refresh'
            ? 'refreshed local auth state metadata'
            : 'wrote local auth state metadata',
        provider: record.provider,
        credentialSource: record.credentialSource,
        tokenHash: record.tokenHash,
        expiresAt: record.expiresAt,
        secretHandling: 'raw credential values are never printed or persisted',
      }),
      null,
      2,
    )}\n`,
  )
}

function commandSpecificResult(
  args: {
    commandName: string
    commandArgs: string[]
  },
  payload: Record<string, unknown>,
) {
  return {
    command: args.commandName,
    description: SLASH_COMMAND_DESCRIPTIONS[args.commandName] ?? 'Upstream Claude Code command',
    args: args.commandArgs,
    parity: {
      surface: 'registered',
      source: `claude-code/src/commands/${args.commandName.slice(1)}`,
      strictVersion: 'V1.3',
      commandSpecific: true,
    },
    ...payload,
  }
}

function commandSpecificPayload(commandName: typeof COMMAND_SPECIFIC_SURFACE_NAMES[number]): Record<string, unknown> {
  if (
    commandName === '/stickers' ||
    commandName === '/upgrade'
  ) {
    return {
      behaviorStatus: 'external-integration-gated',
      sideEffect: 'no network call performed',
      next: 'Platform and marketplace integrations are implemented in V1.7/V1.8.',
    }
  }
  if (
    commandName === '/ant-trace' ||
    commandName === '/heapdump' ||
    commandName === '/perf-issue' ||
    commandName === '/break-cache' ||
    commandName === '/mock-limits' ||
    commandName === '/backfill-sessions'
  ) {
    return {
      behaviorStatus: 'diagnostic-local',
      sideEffect: 'diagnostic command evaluated without uploading local data',
      workflowRuntime: 'V2.0 agent workflow diagnostic artifacts',
    }
  }
  if (
    commandName === '/feedback' ||
    commandName === '/good-claude' ||
    commandName === '/bughunter' ||
    commandName === '/issue' ||
    commandName === '/review' ||
    commandName === '/security-review' ||
    commandName === '/pr-comments'
  ) {
    return {
      behaviorStatus: 'local-runtime',
      sideEffect: 'workflow/review event persisted by V2.0 agent workflow runtime',
    }
  }
  if (commandName === '/local-vault' || commandName === '/vault') {
    return {
      behaviorStatus: 'secret-safe-local',
      sideEffect: 'no secret values are read or written by command listing',
      next: 'V1.9 owns vault storage and retrieval parity.',
    }
  }
  if (commandName === '/ide') {
    return {
      behaviorStatus: 'platform-gated',
      sideEffect: 'IDE connection not mutated from headless command mode',
      next: 'V1.7 owns IDE/LSP runtime parity.',
    }
  }
  if (commandName === '/teleport' || commandName === '/remote-env' || commandName === '/bridge-kick') {
    return {
      behaviorStatus: 'remote-gated',
      sideEffect: 'no remote transport mutation performed',
      next: 'V1.5 owns remote transport parity.',
    }
  }
  return {
    behaviorStatus: 'command-specific',
    sideEffect: 'command-specific surface handled without falling back to unknown command',
  }
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

function isKnownSlashCommand(commandName: string | undefined): commandName is string {
  return Boolean(commandName && SLASH_COMMAND_NAMES.includes(commandName))
}

function printUpstreamParityCommandSurface(args: {
  io: CommandIO
  commandName: string
  commandArgs: string[]
}) {
  const description = SLASH_COMMAND_DESCRIPTIONS[args.commandName] ?? 'Upstream Claude Code command surface'
  const argumentsDescription = SLASH_COMMAND_ARGUMENT_DESCRIPTIONS[args.commandName] ?? {}
  args.io.stdout.write(
    `${JSON.stringify(
      {
        command: args.commandName,
        description,
        args: args.commandArgs,
        parity: {
          surface: 'registered',
          source: `claude-code/src/commands/${args.commandName.slice(1)}`,
          strictVersion: 'V1.3',
          behaviorStatus: 'pending-real-runtime',
        },
        arguments: argumentsDescription,
        next: 'Implement the command-specific interactive, noninteractive, permission, exit-code, and side-effect behavior from the upstream source module.',
      },
      null,
      2,
    )}\n`,
  )
}

export async function resolveResumeContext(args: {
  cwd: string
  continueLatest?: boolean
  resume?: string | boolean
  sessionId?: string
}) {
  const shouldResume = args.continueLatest || args.resume !== undefined
  if (!shouldResume) {
    return undefined
  }

  const session =
    typeof args.resume === 'string'
      ? await resolveSession(args.cwd, args.resume)
      : args.sessionId
        ? await resolveSession(args.cwd, args.sessionId)
        : await resolveLatestSession(args.cwd)

  if (!session) {
    throw new SessionNotFoundError()
  }

  return replaySession(session)
}

function printAddDir(args: {
  io: CommandIO
  currentDirectories?: string[]
  directories: string[]
}): SlashCommandResult {
  const added = parseAddDirCommandArgs(args.directories)
  const next = uniqueStrings([...(args.currentDirectories ?? []), ...added])

  if (added.length === 0) {
    args.io.stdout.write(
      `Additional directories: ${next.length > 0 ? next.join(', ') : '(none)'}\n`,
    )
    args.io.stdout.write('Use /add-dir <path>[,<path>...] to add directories.\n')
    return {
      exitRequested: false,
      additionalDirectories: next,
    }
  }

  args.io.stdout.write(
    `Additional directories: ${next.length > 0 ? next.join(', ') : '(none)'}\n`,
  )
  return {
    exitRequested: false,
    additionalDirectories: next,
  }
}

async function printAcp(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, client, ...rest] = args.commandArgs
  if (action === 'link') {
    args.io.stdout.write(
      `${JSON.stringify(await linkAcpSession(args.cwd, { client }), null, 2)}\n`,
    )
    return
  }
  if (action === 'send') {
    const body = rest.join(' ').trim()
    if (!client || !body) {
      args.io.stdout.write('Usage: /acp send <sessionId> <message>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await sendAcpMessage(args.cwd, { sessionId: client, body }), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(`${JSON.stringify({ acp: await readAcpSessions(args.cwd) }, null, 2)}\n`)
}

async function printAutofixPr(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, repo, ...summaryParts] = args.commandArgs
  if (action === 'plan') {
    const summary = summaryParts.join(' ').trim()
    if (!repo || !summary) {
      args.io.stdout.write('Usage: /autofix-pr plan <repo> <summary>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await planAutofixPr(args.cwd, { repo, summary }), null, 2)}\n`,
    )
    return
  }
  if (action === 'mutate') {
    const summary = summaryParts.join(' ').trim()
    if (!repo || !summary) {
      args.io.stdout.write('Usage: /autofix-pr mutate <repo> <summary>\n')
      return
    }
    const event = await recordWorkflowEvent(args.cwd, {
      kind: 'review',
      summary,
      payload: {
        repo,
        mutation: 'autofix-pr',
      },
    })
    args.io.stdout.write(
      `${JSON.stringify(
        {
          repo,
          summary,
          status: 'mutation-prepared',
          event,
        },
        null,
        2,
      )}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ plans: await readAutofixPrPlans(args.cwd) }, null, 2)}\n`,
  )
}

async function printBuddy(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...objectiveParts] = args.commandArgs
  if (action === 'start') {
    const objective = objectiveParts.join(' ').trim()
    if (!objective) {
      args.io.stdout.write('Usage: /buddy start <objective>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await startBuddySession(args.cwd, { objective }), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ buddies: await readBuddySessions(args.cwd) }, null, 2)}\n`,
  )
}

async function printChicagoMcp(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, name, endpoint] = args.commandArgs
  if (action === 'register') {
    args.io.stdout.write(
      `${JSON.stringify(
        await registerChicagoMcpProfile(args.cwd, {
          name: name || 'chicago',
          endpoint: endpoint || 'local://chicago-mcp',
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ profiles: await readChicagoMcpProfiles(args.cwd) }, null, 2)}\n`,
  )
}

async function printStatus(args: {
  options: {
    model?: string
    permissionMode?: string
  }
  io: CommandIO
  cwd: string
  version: string
}) {
  const settings = await loadSettings(args.cwd)
  const context = await sessionContextStats(args.cwd)
  args.io.stdout.write(
    `${JSON.stringify(
      {
        version: args.version,
        model: args.options.model ?? settings.model ?? 'deepseek-v4-flash',
        permissionMode:
          args.options.permissionMode ?? settings.permissionMode ?? 'default',
        toolCount: getBuiltinTools().length,
        sessionId: context?.session.id,
        tokenBudget: context?.stats.tokenBudget,
        promptCache: context?.stats.promptCache,
      },
      null,
      2,
    )}\n`,
  )
}

async function printDoctor(args: {
  options: {
    model?: string
    permissionMode?: string
  }
  io: CommandIO
  cwd: string
  version: string
}) {
  args.io.stdout.write(formatCommandScreen(await collectDoctorScreen({
    cwd: args.cwd,
    version: args.version,
    model: args.options.model,
    permissionMode: args.options.permissionMode,
  })))
}

async function printContext(args: {
  options: {
    resume?: string | boolean
    sessionId?: string
    additionalDirectories?: string[]
    addDir?: string[]
  }
  io: CommandIO
  cwd: string
  compact?: boolean
}) {
  const resume = await resolveResumeContext({
    cwd: args.cwd,
    resume: args.options.resume,
    sessionId: args.options.sessionId,
  })
  const context = resume
    ? await replaySession(resume.session)
    : await sessionContextStats(args.cwd, args.options.sessionId)

  if (!context) {
    args.io.stdout.write('No session context found.\n')
    return
  }

  const runtimeContext = await buildRuntimeContext({
    cwd: args.cwd,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userContext: context.summary,
    additionalDirectories: args.options.additionalDirectories ?? args.options.addDir,
  })

  if (args.compact) {
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
    args.io.stdout.write(
      [
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
      ].join('\n'),
    )
    return
  }

  args.io.stdout.write(
    `${JSON.stringify(
      {
        sessionId: context.session.id,
        promptCount: context.session.promptCount,
        eventCount: context.stats.eventCount,
        estimatedTokens: context.stats.estimatedTokens,
        inputTokens: context.stats.inputTokens,
        outputTokens: context.stats.outputTokens,
        cacheCreationInputTokens: context.stats.cacheCreationInputTokens,
        cacheReadInputTokens: context.stats.cacheReadInputTokens,
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
      },
      null,
      2,
    )}\n`,
  )
}

async function printModel(args: {
  options: {
    model?: string
  }
  io: CommandIO
  cwd: string
}) {
  const settings = await loadSettings(args.cwd)
  const model = args.options.model ?? settings.model ?? 'deepseek-v4-flash'
  const resolved = getDefaultProviderRuntime().registry.resolve(model)
  args.io.stdout.write(`${resolved.model}\n`)
}

async function printProvider(args: {
  options: {
    model?: string
  }
  io: CommandIO
  cwd: string
}) {
  const settings = await loadSettings(args.cwd)
  const requestedModel = args.options.model ?? settings.model ?? 'deepseek-v4-flash'
  const runtime = getDefaultProviderRuntime()
  const resolved = runtime.registry.resolve(requestedModel)
  const snapshot = runtime.snapshot()

  args.io.stdout.write(
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  )
}

function printRateLimitOptions(args: {
  io: CommandIO
}) {
  const snapshot = getDefaultProviderRuntime().snapshot()
  args.io.stdout.write(
    `${JSON.stringify(
      {
        balances: snapshot.balances,
        providers: snapshot.providers.map(provider => ({
          name: provider.name,
          defaultModel: provider.defaultModel,
          rateLimit: provider.rateLimit,
          apiKeyConfigured: provider.apiKeyConfigured,
        })),
        errors: snapshot.errors.filter(error => error.kind === 'rate_limit'),
      },
      null,
      2,
    )}\n`,
  )
}

async function printConfig(args: {
  io: CommandIO
  cwd: string
  commandArgs?: string[]
}) {
  const action = args.commandArgs?.[0]
  if (action === 'sync-upload') {
    const result = await uploadUserSettingsSnapshot({
      cwd: args.cwd,
      path: args.commandArgs?.[1],
    })
    args.io.stdout.write(
      `${JSON.stringify({ action, ...result }, null, 2)}\n`,
    )
    return
  }
  if (action === 'sync-download') {
    const result = await downloadUserSettingsSnapshot({
      cwd: args.cwd,
      path: args.commandArgs?.[1],
    })
    args.io.stdout.write(
      `${JSON.stringify({ action, ...result }, null, 2)}\n`,
    )
    return
  }

  const loaded = await loadSettingsWithSources(args.cwd)
  const settings = loaded.settings
  args.io.stdout.write(
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  )
}

async function printDiff(args: {
  io: CommandIO
  cwd: string
}) {
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
}

function printEnv(args: {
  io: CommandIO
  cwd: string
}) {
  args.io.stdout.write(
    [
      'Environment:',
      `cwd: ${args.cwd}`,
      `node: ${process.versions.node}`,
      `bun: ${typeof Bun === 'undefined' ? 'unavailable' : Bun.version}`,
      `shell: ${process.env.SHELL ?? '(unknown)'}`,
      `NODE_ENV: ${process.env.NODE_ENV ?? 'unset'}`,
      '',
    ].join('\n'),
  )
}

function printFeatures(args: {
  io: CommandIO
}) {
  const features = summarizeFeatureFlags(process.env.MY_CLAUDE_CODE_FEATURES)
  args.io.stdout.write(
    `${JSON.stringify(
      {
        features: features.map(feature => ({
          name: feature.name,
          group: feature.group,
          targetVersion: feature.targetVersion,
          parityState: feature.parityState,
          enabled: feature.enabled,
          enabledBy: feature.enabledBy,
          userVisible: feature.userVisible,
          secretSafeDefault: feature.secretSafeDefault,
          notes: feature.notes,
        })),
        summary: {
          total: features.length,
          enabled: features.filter(feature => feature.enabled).length,
          covered: features.filter(feature => feature.parityState === 'Covered').length,
          disabledParity: features.filter(feature => feature.parityState === 'Disabled-Parity').length,
          planned: features.filter(feature => feature.parityState === 'Planned').length,
        },
      },
      null,
      2,
    )}\n`,
  )
}

async function printHardening(args: {
  io: CommandIO
  cwd: string
  version: string
  mode?: HardeningMode
  focus?: readonly string[]
}) {
  args.io.stdout.write(
    `${JSON.stringify(
      await collectHardeningReport({
        cwd: args.cwd,
        version: args.version,
        mode: args.mode,
        focus: args.focus,
        slashCommandCount: SLASH_COMMAND_NAMES.length,
        slashCommandNames: SLASH_COMMAND_NAMES,
        genericSlashCommandNames: GENERIC_UPSTREAM_COMMAND_NAMES,
      }),
      null,
      2,
    )}\n`,
  )
}

async function printMemory(args: {
  io: CommandIO
  cwd: string
  commandArgs?: string[]
}) {
  const action = args.commandArgs?.[0] ?? 'summary'
  if (action === 'rank') {
    const prompt = args.commandArgs?.slice(1).join(' ')
    args.io.stdout.write(
      `${JSON.stringify(await rankMemoryStoreEntries(args.cwd, prompt), null, 2)}\n`,
    )
    return
  }
  if (action === 'extract') {
    const text = args.commandArgs?.slice(1).join(' ').trim()
    if (!text) {
      args.io.stdout.write('Usage: /memory extract <text>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify({ memories: await extractMemories(args.cwd, { text }) }, null, 2)}\n`,
    )
    return
  }
  if (action === 'sync-team') {
    args.io.stdout.write(
      `${JSON.stringify(await syncTeamMemory(args.cwd, args.commandArgs?.[1]), null, 2)}\n`,
    )
    return
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
  const ranking = await rankMemoryStoreEntries(args.cwd, args.commandArgs?.slice(1).join(' '))
  lines.push(`localMemoryStores: ${new Set(storeEntries.map(entry => entry.store)).size}`)
  lines.push(`localMemoryEntries: ${storeEntries.length}`)
  lines.push(`rankedMemoryEntries: ${ranking.entries.map(entry => `${entry.store}/${entry.key}:${entry.score ?? 0}`).join(', ') || '(none)'}`)
  lines.push('commands: /memory rank <prompt>, /memory extract <text>, /memory sync-team [team]')

  args.io.stdout.write(`${lines.join('\n')}\n`)
}

async function printMessageAction(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [messageId, action, ...reasonParts] = args.commandArgs
  if (!messageId || !isMessageAction(action)) {
    args.io.stdout.write('Usage: /message-action <messageId> <copy|retry|edit|delete|pin|rate> [reason]\n')
    return
  }
  args.io.stdout.write(
    `${JSON.stringify(
      await recordMessageAction(args.cwd, {
        messageId,
        action,
        reason: reasonParts.join(' ').trim() || undefined,
      }),
      null,
      2,
    )}\n`,
  )
}

function isMessageAction(value: string | undefined): value is 'copy' | 'retry' | 'edit' | 'delete' | 'pin' | 'rate' {
  return value === 'copy' || value === 'retry' || value === 'edit' || value === 'delete' || value === 'pin' || value === 'rate'
}

async function printMcp(args: {
  io: CommandIO
  cwd: string
}) {
  const registry = await discoverExtensionRegistry(args.cwd)
  args.io.stdout.write(
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  )
}

async function printSkills(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs

  if (action === 'search') {
    const query = rest.join(' ').trim()
    await refreshSkillStoreIndex(args.cwd)
    args.io.stdout.write(
      `${JSON.stringify(
        {
          query,
          results: await searchSkills(args.cwd, query),
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  if (action === 'store') {
    const storeAction = rest[0] ?? 'summary'
    if (!['summary', 'index', 'cache', 'refresh'].includes(storeAction)) {
      args.io.stdout.write('Usage: /skills store [summary|index|cache|refresh]\n')
      return
    }
    const index = storeAction === 'refresh'
      ? await refreshSkillStoreIndex(args.cwd)
      : await readSkillStoreIndex(args.cwd)
    if (storeAction === 'cache') {
      args.io.stdout.write(`${JSON.stringify(await readSkillStoreCache(args.cwd), null, 2)}\n`)
      return
    }
    if (storeAction === 'index' || storeAction === 'refresh') {
      args.io.stdout.write(`${JSON.stringify(index, null, 2)}\n`)
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        {
          version: index.version,
          entries: index.entries.length,
          resolved: index.resolved.length,
          conflicts: index.conflicts,
          cachePath: index.cachePath,
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  if (action === 'generate') {
    const separatorIndex = rest.indexOf('--')
    const nameParts = separatorIndex === -1 ? rest.slice(0, 1) : rest.slice(0, separatorIndex)
    const instructionParts =
      separatorIndex === -1 ? rest.slice(1) : rest.slice(separatorIndex + 1)
    const name = nameParts.join(' ').trim()
    const instructions = instructionParts.join(' ').trim()
    if (!name || !instructions) {
      args.io.stdout.write('Usage: /skills generate <name> -- <instructions>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await generateSkill(args.cwd, { name, instructions }), null, 2)}\n`,
    )
    return
  }

  if (action === 'learn') {
    const separatorIndex = rest.indexOf('--')
    const skillParts = separatorIndex === -1 ? rest.slice(0, 1) : rest.slice(0, separatorIndex)
    const lessonParts =
      separatorIndex === -1 ? rest.slice(1) : rest.slice(separatorIndex + 1)
    const skillName = skillParts.join(' ').trim()
    const lesson = lessonParts.join(' ').trim()
    if (!skillName || !lesson) {
      args.io.stdout.write('Usage: /skills learn <skill> -- <lesson>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        await recordSkillLearning(args.cwd, {
          skillName,
          lesson,
          source: 'manual',
        }),
        null,
        2,
      )}\n`,
    )
    return
  }

  if (action === 'feedback') {
    const [, skillName, outcome, ...note] = args.commandArgs
    if (!skillName || !isSkillImprovementOutcome(outcome)) {
      args.io.stdout.write(
        'Usage: /skills feedback <skill> <helpful|needs_improvement|not_used> [note]\n',
      )
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        await recordSkillImprovementFeedback(args.cwd, {
          skillName,
          outcome,
          note: note.join(' ') || undefined,
        }),
        null,
        2,
      )}\n`,
    )
    return
  }

  const registry = await discoverExtensionRegistry(args.cwd)
  const feedback = await readSkillImprovementFeedback(args.cwd)
  const learning = await readSkillLearning(args.cwd)
  const skillStore = await readSkillStoreIndex(args.cwd)
  args.io.stdout.write(
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  )
}

function isSkillImprovementOutcome(
  value: string | undefined,
): value is 'helpful' | 'needs_improvement' | 'not_used' {
  return value === 'helpful' || value === 'needs_improvement' || value === 'not_used'
}

async function printPlugin(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, pluginName, commandName] = args.commandArgs

  if (action === 'marketplace') {
    args.io.stdout.write(
      `${JSON.stringify({
        marketplace: await readPluginMarketplace(args.cwd),
        installed: (await readPluginInstallState(args.cwd)).plugins,
      }, null, 2)}\n`,
    )
    return
  }

  if (action === 'install' && pluginName) {
    args.io.stdout.write(
      `${JSON.stringify(await installMarketplacePlugin(args.cwd, pluginName), null, 2)}\n`,
    )
    return
  }

  if (action === 'update' && pluginName) {
    args.io.stdout.write(
      `${JSON.stringify(await updateMarketplacePlugin(args.cwd, pluginName), null, 2)}\n`,
    )
    return
  }

  if ((action === 'enable' || action === 'disable') && pluginName) {
    args.io.stdout.write(
      `${JSON.stringify(
        await setPluginEnabled(args.cwd, pluginName, action === 'enable'),
        null,
        2,
      )}\n`,
    )
    return
  }

  if (action === 'reload') {
    const result = await reconcilePluginMarketplace(args.cwd)
    args.io.stdout.write(
      `${JSON.stringify({
        plugins: result.plugins,
        restored: result.restored,
        missing: result.missing,
        loadedPlugins: result.registry.plugins.map(plugin => plugin.name),
        mcpServers: result.registry.mcpServers.map(([name]) => name),
        mcpTools: result.registry.mcpTools.map(tool => tool.name),
      }, null, 2)}\n`,
    )
    return
  }

  const registry = await discoverExtensionRegistry(args.cwd)

  if (action === 'run' && pluginName && commandName) {
    const plugin = registry.plugins.find(candidate => candidate.name === pluginName)
    const command = plugin?.commands.find(candidate => candidate.name === commandName)
    if (!plugin || !command) {
      args.io.stdout.write(`Plugin command not found: ${pluginName} ${commandName}\n`)
      return
    }
    args.io.stdout.write(`${command.content}\n`)
    return
  }

  args.io.stdout.write(
    `${JSON.stringify(
      {
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
        usage:
          '/plugin marketplace | install <plugin> | update <plugin> | enable <plugin> | disable <plugin> | reload | run <plugin> <command>',
      },
      null,
      2,
    )}\n`,
  )
}

async function printAgents(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
  options: SlashCommandOptions
}) {
  const [action, name, ...promptParts] = args.commandArgs
  if (action === 'builtin') {
    args.io.stdout.write(
      `${JSON.stringify({ builtInAgents: listBuiltInAgents() }, null, 2)}\n`,
    )
    return
  }
  if (action === 'run') {
    const prompt = promptParts.join(' ').trim()
    if ((name !== 'explore' && name !== 'plan') || !prompt) {
      args.io.stdout.write('Usage: /agents run <explore|plan> <prompt>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        await runBuiltInAgent(
          args.cwd,
          { name, prompt },
          {
            cwd: args.cwd,
            permissionMode: parsePermissionMode(args.options.permissionMode),
            allowedTools: args.options.allowedTools,
            disallowedTools: args.options.disallowedTools,
          },
        ),
        null,
        2,
      )}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify(
      {
        agents: await listAgents(args.cwd),
        builtInAgents: listBuiltInAgents(),
      },
      null,
      2,
    )}\n`,
  )
}

async function printAssistant(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const mode = args.commandArgs[0]
  if (mode === 'focused' || mode === 'assistant' || mode === 'proactive') {
    args.io.stdout.write(
      `${JSON.stringify(await setAssistantMode(args.cwd, { mode }), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ assistant: await readAssistantMode(args.cwd) }, null, 2)}\n`,
  )
}

async function printBrief(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'create') {
    const separatorIndex = rest.indexOf('--')
    const titleParts = separatorIndex === -1 ? rest.slice(0, 1) : rest.slice(0, separatorIndex)
    const bodyParts = separatorIndex === -1 ? rest.slice(1) : rest.slice(separatorIndex + 1)
    const title = titleParts.join(' ').trim()
    const body = bodyParts.join(' ').trim()
    if (!title || !body) {
      args.io.stdout.write('Usage: /brief create <title> -- <body>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await createBrief(args.cwd, { title, body }), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ briefs: await readBriefs(args.cwd) }, null, 2)}\n`,
  )
}

async function printChannels(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, name, kind, target] = args.commandArgs
  if (action === 'register') {
    if (!name) {
      args.io.stdout.write('Usage: /channels register <name> [local|github|push] [target]\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        await registerKairosChannel(args.cwd, {
          name,
          kind: isKairosChannelKind(kind) ? kind : 'local',
          target: isKairosChannelKind(kind) ? target : kind,
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ channels: await readKairosChannels(args.cwd) }, null, 2)}\n`,
  )
}

async function printWeixin(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, subaction, value] = args.commandArgs
  if (action === 'login' && subaction === 'clear') {
    await rm(weixinStatePath(args.cwd), { force: true })
    args.io.stdout.write(`${JSON.stringify({
      package: '@claude-code-best/weixin',
      status: 'cleared',
      accountConfigured: false,
    }, null, 2)}\n`)
    return
  }

  if (action === 'login') {
    const state = {
      package: '@claude-code-best/weixin',
      status: 'login-required',
      accountConfigured: false,
      channel: 'plugin:weixin@builtin',
      next: 'Scan QR in the real Weixin package flow, then enable with --channels plugin:weixin@builtin.',
      secretHandling: 'raw cookies, tokens, and QR payloads are never persisted by this local command surface',
      updatedAt: new Date().toISOString(),
    }
    await writeJsonFile(weixinStatePath(args.cwd), state)
    args.io.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }

  if (action === 'access' && subaction === 'pair' && value) {
    const state = {
      ...(await readJsonFile<Record<string, unknown>>(weixinStatePath(args.cwd), {})),
      package: '@claude-code-best/weixin',
      status: 'paired',
      channel: 'plugin:weixin@builtin',
      pairedCodeHash: createHash('sha256').update(value).digest('hex'),
      updatedAt: new Date().toISOString(),
    }
    await writeJsonFile(weixinStatePath(args.cwd), state)
    args.io.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }

  if (action === 'serve') {
    const channel = await registerKairosChannel(args.cwd, {
      name: 'weixin',
      kind: 'weixin',
      target: 'plugin:weixin@builtin',
    })
    args.io.stdout.write(`${JSON.stringify({
      package: '@claude-code-best/weixin',
      status: 'serving',
      mcpServer: 'plugin:weixin:weixin',
      tools: ['reply', 'send_typing'],
      channel,
    }, null, 2)}\n`)
    return
  }

  args.io.stdout.write(`${JSON.stringify({
    package: '@claude-code-best/weixin',
    status: 'available',
    commands: [
      'weixin login',
      'weixin login clear',
      'weixin access pair <code>',
      'weixin serve',
    ],
    state: await readJsonFile<Record<string, unknown>>(weixinStatePath(args.cwd), {}),
    channels: (await readKairosChannels(args.cwd)).filter(channel => channel.kind === 'weixin'),
  }, null, 2)}\n`)
}

function isKairosChannelKind(value: string | undefined): value is 'local' | 'github' | 'push' | 'weixin' {
  return value === 'local' || value === 'github' || value === 'push' || value === 'weixin'
}

function weixinStatePath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'weixin', 'state.json')
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback
    }
    throw error
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function printPush(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'send') {
    const separatorIndex = rest.indexOf('--')
    const titleParts = separatorIndex === -1 ? rest.slice(0, 1) : rest.slice(0, separatorIndex)
    const bodyParts = separatorIndex === -1 ? rest.slice(1) : rest.slice(separatorIndex + 1)
    const title = titleParts.join(' ').trim()
    const body = bodyParts.join(' ').trim()
    if (!title || !body) {
      args.io.stdout.write('Usage: /push send <title> -- <body>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await queuePushNotification(args.cwd, { title, body }), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ notifications: await readPushNotifications(args.cwd) }, null, 2)}\n`,
  )
}

async function printCoordinator(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
  options: SlashCommandOptions
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'run') {
    const prompt = rest.join(' ').trim()
    if (!prompt) {
      args.io.stdout.write('Usage: /coordinator run <prompt>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        await runCoordinator(
          args.cwd,
          { prompt },
          {
            cwd: args.cwd,
            permissionMode: parsePermissionMode(args.options.permissionMode),
            allowedTools: args.options.allowedTools,
            disallowedTools: args.options.disallowedTools,
          },
        ),
        null,
        2,
      )}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ coordinator: await readCoordinatorRuns(args.cwd) }, null, 2)}\n`,
  )
}

async function printDaemon(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const action = args.commandArgs[0] ?? 'status'
  if (action === 'start') {
    args.io.stdout.write(`${JSON.stringify(await startDaemon(args.cwd), null, 2)}\n`)
    return
  }
  if (action === 'heartbeat') {
    args.io.stdout.write(`${JSON.stringify(await heartbeatDaemon(args.cwd), null, 2)}\n`)
    return
  }
  if (action === 'stop') {
    args.io.stdout.write(`${JSON.stringify(await stopDaemon(args.cwd), null, 2)}\n`)
    return
  }
  if (action === 'status') {
    args.io.stdout.write(`${JSON.stringify(await readDaemonState(args.cwd), null, 2)}\n`)
    return
  }
  args.io.stdout.write('Usage: /daemon [start|heartbeat|status|stop]\n')
}

async function printPeers(args: {
  io: CommandIO
  cwd: string
}) {
  args.io.stdout.write(
    `${JSON.stringify({ peers: await readRemoteSessions(args.cwd) }, null, 2)}\n`,
  )
}

async function printAttach(args: {
  io: CommandIO
  cwd: string
  sessionId?: string
}) {
  if (!args.sessionId) {
    args.io.stdout.write('Usage: /attach <sessionId>\n')
    return
  }
  args.io.stdout.write(
    `${JSON.stringify(await resumeRemote(args.cwd, args.sessionId), null, 2)}\n`,
  )
}

async function printDetach(args: {
  io: CommandIO
  cwd: string
  sessionId?: string
}) {
  if (!args.sessionId) {
    args.io.stdout.write('Usage: /detach <sessionId>\n')
    return
  }
  args.io.stdout.write(
    `${JSON.stringify(await detachRemote(args.cwd, args.sessionId), null, 2)}\n`,
  )
}

async function printRemote(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
  options: SlashCommandOptions
}) {
  try {
    const [action, ...rest] = args.commandArgs
    if (!action) {
      args.io.stdout.write(
        `${JSON.stringify({ remote: await readRemoteSessions(args.cwd) }, null, 2)}\n`,
      )
      return
    }

    if (action === 'connect') {
      const [name, root] = rest
      args.io.stdout.write(
        `${JSON.stringify(
          await connectRemote(args.cwd, {
            name,
            root,
            transport: 'loopback',
          }),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'ssh') {
      const [host, root, sshCommand, ...sshArgs] = rest
      if (!host) {
        args.io.stdout.write('Usage: /remote ssh <host> [root] [sshCommand] [sshArgs...]\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await connectRemote(args.cwd, {
            name: host,
            host,
            root,
            transport: 'ssh',
            sshCommand,
            sshArgs: sshArgs.length > 0 ? sshArgs : undefined,
          }),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'setup') {
      args.io.stdout.write(
        `${JSON.stringify(await setupRemote(args.cwd, { name: rest[0] }), null, 2)}\n`,
      )
      return
    }

    if (action === 'pipes' || action === 'pipe-status') {
      args.io.stdout.write(
        `${JSON.stringify({
          pipes: await readPipeEndpoints(args.cwd),
          udsInboxes: await readUdsInboxes(args.cwd),
        }, null, 2)}\n`,
      )
      return
    }

    if (action === 'env') {
      const [name, ...valueParts] = rest
      if (!name) {
        args.io.stdout.write(
          `${JSON.stringify({ env: await readRemoteEnv(args.cwd) }, null, 2)}\n`,
        )
        return
      }
      if (valueParts.length === 0) {
        args.io.stdout.write('Usage: /remote env <NAME> <VALUE>\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await setRemoteEnv(args.cwd, {
            name,
            value: valueParts.join(' '),
          }),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'bridge-kick') {
      args.io.stdout.write(
        `${JSON.stringify(await kickBridge(args.cwd, rest.join(' ') || 'manual'), null, 2)}\n`,
      )
      return
    }

    if (action === 'pipe-register') {
      const [name, role, sessionId] = rest
      if (!name) {
        args.io.stdout.write('Usage: /remote pipe-register <name> [standalone|master|sub] [sessionId]\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await registerPipeEndpoint(args.cwd, {
            name,
            role: isPipeRole(role) ? role : 'standalone',
            sessionId: isPipeRole(role) ? sessionId : role,
          }),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'lan-register') {
      const [name, host, portRaw, role, sessionId] = rest
      const port = Number(portRaw)
      if (!name || !host || !Number.isInteger(port) || port < 0) {
        args.io.stdout.write('Usage: /remote lan-register <name> <host> <port> [standalone|master|sub] [sessionId]\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await registerLanPipeEndpoint(args.cwd, {
            name,
            host,
            port,
            role: isPipeRole(role) ? role : 'standalone',
            sessionId: isPipeRole(role) ? sessionId : role,
          }),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'send') {
      const [targetName, ...body] = rest
      if (!targetName || body.length === 0) {
        args.io.stdout.write('Usage: /remote send <pipeName> <message>\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await sendPipeMessage(args.cwd, {
            targetName,
            body: body.join(' '),
            type: 'chat',
          }),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'uds-start') {
      args.io.stdout.write(
        `${JSON.stringify(await startUdsInbox(args.cwd, { name: rest[0] ?? 'main' }), null, 2)}\n`,
      )
      return
    }

    if (action === 'uds-send') {
      const [nameOrBody, ...bodyParts] = rest
      if (!nameOrBody) {
        args.io.stdout.write('Usage: /remote uds-send [name] <message>\n')
        return
      }
      const name = bodyParts.length > 0 ? nameOrBody : 'main'
      const body = bodyParts.length > 0 ? bodyParts.join(' ') : nameOrBody
      args.io.stdout.write(
        `${JSON.stringify(await sendUdsInboxMessage(args.cwd, { name, body }), null, 2)}\n`,
      )
      return
    }

    if (action === 'run') {
      const [sessionId, command, ...commandArgs] = rest
      if (!sessionId || !command) {
        args.io.stdout.write('Usage: /remote run <sessionId> <command> [args...]\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await runRemoteCommand(
            args.cwd,
            {
              sessionId,
              command,
              args: commandArgs,
            },
            { permissionMode: parsePermissionMode(args.options.permissionMode) },
          ),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'detach') {
      await printDetach({ io: args.io, cwd: args.cwd, sessionId: rest[0] })
      return
    }

    if (action === 'resume' || action === 'attach') {
      await printAttach({ io: args.io, cwd: args.cwd, sessionId: rest[0] })
      return
    }

    if (action === 'trigger') {
      const [sessionId, name] = rest
      if (!sessionId || !name) {
        args.io.stdout.write('Usage: /remote trigger <sessionId> <name>\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await triggerRemote(args.cwd, { sessionId, name }),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'capture') {
      const [sessionId, lines] = rest
      args.io.stdout.write(
        `${JSON.stringify(
          await captureTerminal(args.cwd, {
            sessionId,
            lines: lines ? Number(lines) : undefined,
          }),
          null,
          2,
        )}\n`,
      )
      return
    }

    if (action === 'peers') {
      await printPeers({ io: args.io, cwd: args.cwd })
      return
    }

    args.io.stdout.write(
      'Usage: /remote [connect|ssh|run|detach|resume|trigger|capture|peers|env|bridge-kick|pipe-register|lan-register|send|pipes|uds-start|uds-send]\n',
    )
  } catch (error) {
    args.io.stdout.write(
      `Remote error: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

async function printRemoteEnv(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [name, ...valueParts] = args.commandArgs
  if (!name) {
    args.io.stdout.write(`${JSON.stringify({ env: await readRemoteEnv(args.cwd) }, null, 2)}\n`)
    return
  }
  if (valueParts.length === 0) {
    args.io.stdout.write('Usage: /remote-env <NAME> <VALUE>\n')
    return
  }
  args.io.stdout.write(
    `${JSON.stringify(
      await setRemoteEnv(args.cwd, {
        name,
        value: valueParts.join(' '),
      }),
      null,
      2,
    )}\n`,
  )
}

function isPipeRole(value: string | undefined): value is 'standalone' | 'master' | 'sub' {
  return value === 'standalone' || value === 'master' || value === 'sub'
}

async function printTasks(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'create') {
    const title = rest.join(' ').trim()
    if (!title) {
      args.io.stdout.write('Usage: /tasks create <title>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await createTask(args.cwd, { title }), null, 2)}\n`,
    )
    return
  }
  if (action === 'stop' && rest[0]) {
    args.io.stdout.write(
      `${JSON.stringify(await stopTask(args.cwd, rest[0]), null, 2)}\n`,
    )
    return
  }
  if (action === 'runner') {
    const [kind, name] = rest
    if (kind === 'list' || !kind) {
      args.io.stdout.write(
        `${JSON.stringify(
          {
            profiles: await readRunnerProfiles(args.cwd),
            runs: await readRunnerRuns(args.cwd),
          },
          null,
          2,
        )}\n`,
      )
      return
    }
    if (kind === 'environment' || kind === 'byoc') {
      args.io.stdout.write(
        `${JSON.stringify(
          await runEnvironmentRunner(args.cwd, { name }),
          null,
          2,
        )}\n`,
      )
      return
    }
    if (kind === 'self-hosted') {
      args.io.stdout.write(
        `${JSON.stringify(
          await runSelfHostedRunner(args.cwd, { name }),
          null,
          2,
        )}\n`,
      )
      return
    }
    args.io.stdout.write('Usage: /tasks runner <environment|self-hosted|list> [name]\n')
    return
  }
  if (action === 'template') {
    const [templateAction, name, ...templateRest] = rest
    if (templateAction === 'list' || !templateAction) {
      args.io.stdout.write(
        `${JSON.stringify({ templates: await readTaskTemplates(args.cwd) }, null, 2)}\n`,
      )
      return
    }
    if (templateAction === 'create') {
      const title = templateRest.join(' ').trim()
      if (!name || !title) {
        args.io.stdout.write('Usage: /tasks template create <name> <title>\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await createTaskTemplate(args.cwd, { name, title }),
          null,
          2,
        )}\n`,
      )
      return
    }
    if (templateAction === 'run' && name) {
      args.io.stdout.write(
        `${JSON.stringify(await runTaskTemplate(args.cwd, { name }), null, 2)}\n`,
      )
      return
    }
    args.io.stdout.write('Usage: /tasks template <create|run|list> [name] [title]\n')
    return
  }
  if (action === 'workflow') {
    const [workflowAction, nameOrCommand, maybeCommand, ...workflowArgs] = rest
    if (workflowAction === 'list' || !workflowAction) {
      args.io.stdout.write(
        `${JSON.stringify({ workflows: await readWorkflowScriptRuns(args.cwd) }, null, 2)}\n`,
      )
      return
    }
    if (workflowAction === 'run') {
      const name = maybeCommand ? nameOrCommand : undefined
      const command = maybeCommand ?? nameOrCommand
      if (!command) {
        args.io.stdout.write('Usage: /tasks workflow run [name] <command> [args...]\n')
        return
      }
      args.io.stdout.write(
        `${JSON.stringify(
          await runWorkflowScript(args.cwd, {
            name,
            command,
            args: workflowArgs,
          }),
          null,
          2,
        )}\n`,
      )
      return
    }
    args.io.stdout.write('Usage: /tasks workflow <run|list> [name] <command> [args...]\n')
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ tasks: await readTasks(args.cwd) }, null, 2)}\n`,
  )
}

async function printMonitor(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'start') {
    const [name, command, ...commandArgs] = rest
    if (!name || !command) {
      args.io.stdout.write('Usage: /monitor start <name> <command> [args...]\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        await startMonitor(args.cwd, {
          name,
          command,
          args: commandArgs,
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (action === 'output' && rest[0]) {
    args.io.stdout.write(`${await readMonitorOutput(args.cwd, rest[0])}\n`)
    return
  }
  if (action === 'stop' && rest[0]) {
    args.io.stdout.write(
      `${JSON.stringify(await stopMonitor(args.cwd, rest[0]), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ monitors: await readMonitors(args.cwd) }, null, 2)}\n`,
  )
}

async function printProactive(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'schedule') {
    const prompt = rest.join(' ').trim()
    if (!prompt) {
      args.io.stdout.write('Usage: /proactive schedule <prompt>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await scheduleProactiveTick(args.cwd, { prompt }), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ proactive: await readProactiveTicks(args.cwd) }, null, 2)}\n`,
  )
}

async function printSchedule(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, name, command, ...rest] = args.commandArgs
  if (action === 'add') {
    if (!name) {
      args.io.stdout.write('Usage: /schedule add <name> [command] [args...]\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        await scheduleCronWorkflow(args.cwd, {
          name,
          command,
          args: rest,
          prompt: command ? undefined : name,
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (action === 'run') {
    args.io.stdout.write(
      `${JSON.stringify({ runs: await runDueCronWorkflows(args.cwd) }, null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify(await readAgentWorkflowState(args.cwd), null, 2)}\n`,
  )
}

async function printSubscribePr(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const allowedEvents = ['comment', 'review', 'ci', 'merge', 'close'] as const
  const [repo, prNumberRaw, ...events] = args.commandArgs
  if (!repo || repo === 'list') {
    args.io.stdout.write(
      `${JSON.stringify(
        { subscriptions: await readGithubWebhookSubscriptions(args.cwd) },
        null,
        2,
      )}\n`,
    )
    return
  }
  const pr_number = Number(prNumberRaw)
  if (!Number.isInteger(pr_number) || pr_number <= 0) {
    args.io.stdout.write('Usage: /subscribe-pr <owner/repo> <pr_number> [comment|review|ci|merge|close...]\n')
    return
  }
  if (events.some(event => !allowedEvents.includes(event as typeof allowedEvents[number]))) {
    args.io.stdout.write('Usage: /subscribe-pr <owner/repo> <pr_number> [comment|review|ci|merge|close...]\n')
    return
  }
  args.io.stdout.write(
    `${JSON.stringify(
      await subscribeGithubWebhook(args.cwd, {
        repo,
        pr_number,
        events: events as Array<typeof allowedEvents[number]>,
      }),
      null,
      2,
    )}\n`,
  )
}

async function printTorch(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...targetParts] = args.commandArgs
  if (action === 'probe') {
    const target = targetParts.join(' ').trim()
    if (!target) {
      args.io.stdout.write('Usage: /torch probe <target>\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await recordTorchProbe(args.cwd, { target }), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ probes: await readTorchProbes(args.cwd) }, null, 2)}\n`,
  )
}

async function printVoice(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'on' || action === 'off') {
    const provider = parseVoiceProvider(rest[0])
    args.io.stdout.write(
      `${JSON.stringify(await setVoiceMode(args.cwd, {
        enabled: action === 'on',
        ...(provider ? { provider } : {}),
      }), null, 2)}\n`,
    )
    return
  }
  if (action === 'check') {
    args.io.stdout.write(`${JSON.stringify(await checkVoiceRuntime(), null, 2)}\n`)
    return
  }
  if (action === 'start') {
    args.io.stdout.write(
      `${JSON.stringify(await startVoiceRuntimeRecording(args.cwd, { sessionId: rest[0] }), null, 2)}\n`,
    )
    return
  }
  if (action === 'stop') {
    if (!rest[0]) {
      args.io.stdout.write('Usage: /voice stop <sessionId>\n')
      return
    }
    args.io.stdout.write(`${JSON.stringify(await stopVoiceRuntimeRecording({ sessionId: rest[0] }), null, 2)}\n`)
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ voice: await readVoiceMode(args.cwd) }, null, 2)}\n`,
  )
}

function parseVoiceProvider(value: string | undefined): 'anthropic' | 'doubao' | 'deepseek' | undefined {
  return value === 'anthropic' || value === 'doubao' || value === 'deepseek'
    ? value
    : undefined
}

async function printUltraplan(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action] = args.commandArgs
  if (action === 'list' || !action) {
    args.io.stdout.write(
      `${JSON.stringify({ ultraplans: await readUltraplans(args.cwd) }, null, 2)}\n`,
    )
    return
  }
  const prompt = args.commandArgs.join(' ').trim()
  args.io.stdout.write(
    `${JSON.stringify(await createUltraplan(args.cwd, { prompt }), null, 2)}\n`,
  )
}

async function printBackground(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'start') {
    const [name, command, ...commandArgs] = rest
    if (!name || !command) {
      args.io.stdout.write('Usage: /background start <name> <command> [args...]\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(
        await startBackgroundJob(args.cwd, {
          name,
          command,
          args: commandArgs,
        }),
        null,
        2,
      )}\n`,
    )
    return
  }
  if (action === 'output' && rest[0]) {
    args.io.stdout.write(await readBackgroundOutput(args.cwd, rest[0]))
    return
  }
  if (action === 'stop' && rest[0]) {
    args.io.stdout.write(
      `${JSON.stringify(await stopBackgroundJob(args.cwd, rest[0]), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify({ background: await readBackgroundJobs(args.cwd) }, null, 2)}\n`,
  )
}

async function printWorktree(args: {
  io: CommandIO
  cwd: string
  commandArgs: string[]
}) {
  const [action, ...rest] = args.commandArgs
  if (action === 'enter') {
    const [path, branch] = rest
    if (!path) {
      args.io.stdout.write('Usage: /worktree enter <path> [branch]\n')
      return
    }
    args.io.stdout.write(
      `${JSON.stringify(await enterWorktree(args.cwd, { path, branch }), null, 2)}\n`,
    )
    return
  }
  if (action === 'exit') {
    args.io.stdout.write(
      `${JSON.stringify(await exitWorktree(args.cwd), null, 2)}\n`,
    )
    return
  }
  args.io.stdout.write(
    `${JSON.stringify(await readWorktreeState(args.cwd), null, 2)}\n`,
  )
}

async function printOutputStyle(args: {
  io: CommandIO
  cwd: string
  outputStyleName?: string
}) {
  if (args.outputStyleName) {
    const parsed = OutputStyleNameSchema.safeParse(args.outputStyleName)
    if (!parsed.success) {
      args.io.stdout.write(
        [
          `Unknown output style: ${args.outputStyleName}`,
          `Available output styles: ${OUTPUT_STYLE_NAMES.join(', ')}`,
          '',
        ].join('\n'),
      )
      return
    }

    const settings = await setProjectSetting(args.cwd, 'outputStyle', parsed.data)
    args.io.stdout.write(
      [
        'Output style:',
        `active: ${settings.outputStyle ?? 'default'}`,
        `available: ${OUTPUT_STYLE_NAMES.join(', ')}`,
        'Saved project output style.',
        '',
      ].join('\n'),
    )
    return
  }

  const settings = await loadSettings(args.cwd)
  args.io.stdout.write(
    [
      'Output style:',
      `active: ${settings.outputStyle ?? 'default'}`,
      `available: ${OUTPUT_STYLE_NAMES.join(', ')}`,
      '',
    ].join('\n'),
  )
}

function printKeybindings(args: {
  io: CommandIO
}) {
  args.io.stdout.write(
    [
      'Keybindings:',
      ...KEYBINDING_SECTIONS.flatMap(section => [
        `${section.name}:`,
        ...section.bindings.map(([key, description]) => `  ${key}: ${description}`),
      ]),
      '',
    ].join('\n'),
  )
}

async function printVim(args: {
  io: CommandIO
  cwd: string
  arg?: string
  options: {
    vimMode?: boolean
  }
}) {
  const settings = await loadSettings(args.cwd)
  const current = args.options.vimMode ?? settings.vimMode ?? false
  const next = parseVimModeArg(args.arg, current)

  if (next === undefined) {
    args.io.stdout.write(
      [
        `Unknown vim mode: ${args.arg}`,
        'Usage: /vim [on|off|toggle]',
        '',
      ].join('\n'),
    )
    return
  }

  if (next === current && !args.arg) {
    args.io.stdout.write(`vimMode: ${current ? 'on' : 'off'}\n`)
    return
  }

  await setProjectSetting(args.cwd, 'vimMode', next)
  args.io.stdout.write(`vimMode: ${next ? 'on' : 'off'}\nSaved project vim mode.\n`)
}

async function printResumeList(args: {
  io: CommandIO
  cwd: string
  sessionId?: string
  action?: ResumeAction
  recordId?: string
}) {
  if (args.sessionId) {
    const session = await resolveSession(args.cwd, args.sessionId)
    if (!session) {
      args.io.stdout.write(`No session found: ${args.sessionId}\n`)
      return
    }

    if (args.action === 'checkpoints') {
      const checkpoints = await listSessionCheckpoints(session, 8)
      args.io.stdout.write(
        [
          `Checkpoints for ${session.id}:`,
          ...(checkpoints.length === 0
            ? ['No transcript checkpoints found.']
            : checkpoints.map(checkpoint =>
                `${checkpoint.recordId} | ${checkpoint.createdAt} | ${checkpoint.label}`,
              )),
          '',
        ].join('\n'),
      )
      return
    }

    if (args.action === 'fork') {
      const fork = await forkSession({
        cwd: args.cwd,
        sourceSessionId: session.id,
      })
      args.io.stdout.write(
        fork
          ? `Forked ${session.id} -> ${fork.id}\n`
          : `Could not fork session: ${session.id}\n`,
      )
      return
    }

    if (args.action === 'rewind') {
      const recordId =
        args.recordId ?? (await listSessionCheckpoints(session, 2))[1]?.recordId
      if (!recordId) {
        args.io.stdout.write(`No rewind checkpoint found for ${session.id}\n`)
        return
      }

      const fork = await forkSession({
        cwd: args.cwd,
        sourceSessionId: session.id,
        truncateAfterRecordId: recordId,
        mode: 'rewind',
      })
      args.io.stdout.write(
        fork
          ? `Rewound ${session.id} at ${recordId} -> ${fork.id}\n`
          : `Could not rewind ${session.id} at ${recordId}\n`,
      )
      return
    }

    if (args.action === 'rewind-files') {
      const recordId =
        args.recordId ?? (await listSessionCheckpoints(session, 2))[1]?.recordId
      if (!recordId) {
        args.io.stdout.write(`No file rewind checkpoint found for ${session.id}\n`)
        return
      }

      const result = await rewindFilesToCheckpoint({
        cwd: args.cwd,
        session,
        checkpointRecordId: recordId,
      })
      args.io.stdout.write(
        [
          `Rewound files for ${session.id} at ${recordId}.`,
          `restoredFiles: ${result.restoredFiles.length > 0 ? result.restoredFiles.join(', ') : '(none)'}`,
          `missingSnapshots: ${result.missingSnapshots.length > 0 ? result.missingSnapshots.join(', ') : '(none)'}`,
          `worktreeConflicts: ${result.worktreeConflicts.length > 0 ? result.worktreeConflicts.join(', ') : '(none)'}`,
          '',
        ].join('\n'),
      )
      return
    }

    args.io.stdout.write(`${(await replaySession(session)).summary}\n`)
    return
  }

  const sessions = await listSessions(args.cwd)
  args.io.stdout.write(formatCommandScreen(buildResumeScreen(sessions)))
}

type ResumeAction = 'checkpoints' | 'fork' | 'rewind' | 'rewind-files'

function parseResumeCommandArgs(args: string[]): {
  sessionId?: string
  action?: ResumeAction
  recordId?: string
} {
  const [sessionId, ...rest] = args
  const actionIndex = rest.findIndex(value => value.startsWith('--'))
  if (actionIndex === -1) {
    return { sessionId }
  }

  const action = parseResumeAction(rest[actionIndex])
  return {
    sessionId,
    action,
    recordId: rest[actionIndex + 1],
  }
}

function parseResumeAction(value: string): ResumeAction | undefined {
  switch (value) {
    case '--checkpoints':
      return 'checkpoints'
    case '--fork':
      return 'fork'
    case '--rewind':
      return 'rewind'
    case '--rewind-files':
      return 'rewind-files'
    default:
      return undefined
  }
}

function parseAddDirCommandArgs(args: string[]): string[] {
  return args
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
}

function parseParityMode(args: string[]): HardeningMode {
  if (args.some(arg => arg === '--strict' || arg === 'strict')) {
    return 'strict'
  }
  return args.some(arg => arg === '--full' || arg === '--full-ecosystem' || arg === 'full')
    ? 'full-ecosystem'
    : 'release'
}

function parseParityFocus(args: string[]): string[] {
  return args
    .filter(arg =>
      arg === '--tui' ||
      arg === 'tui' ||
      arg === '--remote' ||
      arg === 'remote' ||
      arg === '--platform' ||
      arg === 'platform' ||
      arg === '--voice' ||
      arg === 'voice' ||
      arg === '--memory' ||
      arg === 'memory' ||
      arg === '--agent-workflows' ||
      arg === 'agent-workflows' ||
      arg === '--source-inventory' ||
      arg === 'source-inventory'
    )
    .map(arg => arg.replace(/^--/, ''))
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
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

async function printStatusLine(args: {
  options: {
    model?: string
    permissionMode?: string
  }
  io: CommandIO
  cwd: string
  version: string
}) {
  const settings = await loadSettings(args.cwd)
  const context = await sessionContextStats(args.cwd)
  const usage = context
    ? ` | tokens ${context.stats.tokenBudget.used}/${context.stats.tokenBudget.limit} | cache ${Math.round(context.stats.promptCache.hitRate * 100)}%`
    : ''
  args.io.stdout.write(
    `my-claude-code ${args.version} | ${args.options.model ?? settings.model ?? 'deepseek-v4-flash'} | ${args.options.permissionMode ?? settings.permissionMode ?? 'default'}${usage}\n`,
  )
}

async function printUsage(args: {
  options: {
    sessionId?: string
  }
  io: CommandIO
  cwd: string
  label?: string
}) {
  const context = await sessionContextStats(args.cwd, args.options.sessionId)
  if (!context) {
    args.io.stdout.write(`No ${args.label?.toLowerCase() ?? 'usage'} found.\n`)
    return
  }

  args.io.stdout.write(
    [
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
    ].join('\n'),
  )
}

async function printTheme(args: {
  io: CommandIO
  cwd: string
  themeName?: string
}) {
  if (args.themeName) {
    const parsed = ThemeNameSchema.safeParse(args.themeName)
    if (!parsed.success) {
      args.io.stdout.write(
        [
          `Unknown theme: ${args.themeName}`,
          `Available themes: ${THEME_NAMES.join(', ')}`,
          '',
        ].join('\n'),
      )
      return
    }

    const settings = await setProjectSetting(args.cwd, 'theme', parsed.data)
    args.io.stdout.write(
      formatCommandScreen(buildThemeScreen(
        settings.theme ?? 'default',
        'Saved project theme.',
      )),
    )
    return
  }

  const settings = await loadSettings(args.cwd)
  args.io.stdout.write(formatCommandScreen(buildThemeScreen(
    settings.theme ?? 'default',
  )))
}

async function printPermissions(args: {
  options: {
    permissionMode?: string
    allowedTools?: string[]
    tools?: string[]
    disallowedTools?: string[]
  }
  io: CommandIO
  cwd: string
}) {
  const loaded = await loadSettingsWithSources(args.cwd)
  const settings = loaded.settings
  const allowedTools =
    args.options.allowedTools ?? args.options.tools ?? settings.allowedTools ?? []
  const disallowedTools =
    args.options.disallowedTools ?? settings.disallowedTools ?? []

  args.io.stdout.write(
    [
      `permissionMode: ${args.options.permissionMode ?? settings.permissionMode ?? 'default'}`,
      `allowedTools: ${allowedTools.length > 0 ? allowedTools.join(', ') : '(all registered tools)'}`,
      `disallowedTools: ${disallowedTools.length > 0 ? disallowedTools.join(', ') : '(none)'}`,
      `settingsSources: ${loaded.sources.filter(source => source.exists).map(source => source.kind).join(', ') || '(none)'}`,
      `registeredTools: ${getBuiltinTools().map(tool => tool.name).join(', ')}`,
      '',
    ].join('\n'),
  )
}
