import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

type GateStatus = 'pass' | 'fail'

type GateCheck = {
  label: string
  status: GateStatus
  detail: string
  missing?: string[]
}

type GateReport = {
  gate: string
  status: GateStatus
  cwd: string
  generatedAt: string
  summary: {
    pass: number
    fail: number
  }
  checks: GateCheck[]
}

type InventoryBaseline = {
  generatedAt: string
  upstream: {
    sourceFiles: string[]
    packageFiles: string[]
    packages: string[]
    commandModules: string[]
    toolModules: string[]
    componentFiles: string[]
    serviceFiles: string[]
    hookFiles: string[]
    fixtureFiles: string[]
  }
  local: {
    sourceMirrorFiles: string[]
    packageFiles: string[]
    packages: string[]
  }
  gaps: {
    missingSourceMirrorFiles: string[]
    missingPackageMirrorFiles: string[]
    missingPackages: string[]
    missingCommandModules: string[]
    missingToolModules: string[]
  }
}

type FileTreeDiff = {
  missing: string[]
  extra: string[]
  different: string[]
}

const cwd = process.cwd()
const args = process.argv.slice(2)
const command = args[0] ?? 'all'
const shouldWrite = args.includes('--write')
const structureMirrorMarker = 'R1_1_STRUCTURE_MIRROR'

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const ignoredSegments = new Set(['node_modules', '.git', 'dist', 'coverage'])

const gateHandlers: Record<string, () => GateReport> = {
  structure: structureGate,
  exports: exportsGate,
  commands: commandsGate,
  tools: toolsGate,
  'tui-golden': tuiGoldenGate,
  runtime: runtimeGate,
  transports: transportsGate,
  native: nativeGate,
  fixtures: fixturesGate,
  release: releaseGate,
  'true-1to1': trueOneToOneGate,
}

if (command === 'inventory') {
  const baseline = buildInventoryBaseline()
  if (shouldWrite) {
    writeJson('docs/refactor/inventory-baseline.json', baseline)
    writeText('docs/refactor/many-to-one-debt.md', buildManyToOneDebtMarkdown())
  }
  console.log(JSON.stringify(baselineSummary(baseline), null, 2))
} else if (command === 'mirror-structure') {
  const result = mirrorStructure({ write: shouldWrite })
  console.log(JSON.stringify(result, null, 2))
} else if (command === 'all') {
  const reports = Object.entries(gateHandlers).map(([name, handler]) => [name, handler()] as const)
  const checks = reports.flatMap(([name, report]) =>
    report.checks.map(check => ({
      ...check,
      label: `${name}: ${check.label}`,
    })),
  )
  printReport({
    gate: 'all',
    status: checks.some(check => check.status === 'fail') ? 'fail' : 'pass',
    cwd,
    generatedAt: new Date().toISOString(),
    summary: summarizeChecks(checks),
    checks,
  })
} else {
  const handler = gateHandlers[command]
  if (!handler) {
    console.error(`Unknown refactor parity gate: ${command}`)
    console.error(`Available gates: inventory, all, ${Object.keys(gateHandlers).join(', ')}`)
    process.exit(2)
  }
  printReport(handler())
}

function structureGate(): GateReport {
  const baseline = buildInventoryBaseline()
  return report('structure', [
    checkMissing(
      'source mirror files',
      baseline.gaps.missingSourceMirrorFiles,
      'upstream src files must exist under local src with the same relative path',
    ),
    checkMissing(
      'package mirror files',
      baseline.gaps.missingPackageMirrorFiles,
      'upstream package source/package files must exist under local packages with the same relative path',
    ),
    checkMissing(
      'workspace packages',
      baseline.gaps.missingPackages,
      'upstream packages must have matching local package boundaries',
    ),
  ])
}

function exportsGate(): GateReport {
  const paths = [
    'src/entrypoints/cli.tsx',
    'src/entrypoints/mcp.ts',
    'src/entrypoints/agentSdkTypes.ts',
    'src/entrypoints/sandboxTypes.ts',
    'src/entrypoints/sdk/coreSchemas.ts',
    'src/entrypoints/sdk/controlSchemas.ts',
    'src/tools.ts',
    'src/commands.ts',
  ]
  const missing = paths.filter(path => !existsSync(join(cwd, path)))
  const structureOnly = paths.filter(path => isStructureOnlyPath(path))

  return report('exports', [
    checkMissing(
      'entrypoint and root exports',
      missing,
      'public upstream entrypoints and root exports must be mirrored before export diff can pass',
    ),
    checkMissing(
      'entrypoint and root implementations',
      structureOnly,
      'public upstream entrypoints and root exports must be real implementations, not R1.1 structure mirrors',
    ),
  ])
}

function commandsGate(): GateReport {
  const baseline = buildInventoryBaseline()
  if (args.includes('--entrypoints')) {
    return report('commands', [
      checkMissing(
        'command entrypoint exports',
        requiredImplementedPaths([
          'src/commands.ts',
          'src/commands/help/index.ts',
          'src/commands/mcp/index.ts',
          'src/commands/doctor/index.ts',
        ]),
        'R1.2 requires command root exports and CLI-critical command entrypoints before R1.3 command behavior migration',
      ),
    ])
  }

  if (args.includes('--high-priority')) {
    const nativeModules = baseline.upstream.commandModules
    return report('commands', [
      checkMissing(
        'native command batch modules',
        requiredImplementedPaths(nativeModules.map(name => `src/commands/${name}/index.ts`)),
        'R1.3 native command batches must have concrete local modules',
      ),
      checkMissing(
        'native command batch implementations',
        commandNativeImplementationErrors(nativeModules),
        'R1.3 native command batches must run through source-level native handlers, not command adapter mirrors',
      ),
      checkMissing(
        'native command batch registry',
        commandMirrorRegistrationErrors(nativeModules),
        'R1.3 native command batches must keep slash metadata and upstream source pointers intact',
      ),
    ])
  }

  const structureOnly = baseline.upstream.commandModules.filter(name =>
    isStructureOnlyDirectory(join('src/commands', name)),
  )
  const commandMirrorErrors = commandMirrorRegistrationErrors(baseline.upstream.commandModules)
  return report('commands', [
    checkMissing(
      'command modules',
      baseline.gaps.missingCommandModules,
      'each upstream command module must have a local src/commands/<name> mirror',
    ),
    checkMissing(
      'command implementations',
      structureOnly,
      'each upstream command module must contain migrated behavior, not only R1.1 structure mirror files',
    ),
    checkMissing(
      'command mirror registry',
      commandMirrorErrors,
      'each command mirror must expose a registered slash command and a source pointer',
    ),
    checkMissing(
      'native command batch implementations',
      commandNativeImplementationErrors(baseline.upstream.commandModules),
      'R1.3 native command batches must run through source-level native handlers, not command adapter mirrors',
    ),
  ])
}

function toolsGate(): GateReport {
  const baseline = buildInventoryBaseline()
  const structureOnly = baseline.upstream.toolModules.filter(name =>
    isStructureOnlyDirectory(join('packages/builtin-tools/src/tools', name)),
  )
  const remainingStructureMarkers = listFiles('packages/builtin-tools/src/tools', isSourceLikeFile).filter(path =>
    readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
  )
  const missingGolden = requiredImplementedPaths([
    'scripts/refactor-tool-golden.ts',
    'docs/refactor/golden/tools/r1.4-builtin-tool-golden.json',
  ])
  return report('tools', [
    checkMissing(
      'builtin tool modules',
      baseline.gaps.missingToolModules,
      'each upstream builtin tool module must have a local packages/builtin-tools/src/tools/<name> mirror',
    ),
    checkMissing(
      'builtin tool implementations',
      structureOnly,
      'each upstream builtin tool module must contain migrated behavior, not only R1.1 structure mirror files',
    ),
    checkMissing(
      'builtin tool structure markers',
      remainingStructureMarkers,
      'R1.4 tool mirror cannot leave structure-only markers under builtin tool modules',
    ),
    checkMissing(
      'builtin tool golden matrix',
      missingGolden,
      'R1.4 tool parity requires schema, provider metadata, permission, result, and side-effect golden coverage',
    ),
  ])
}

function tuiGoldenGate(): GateReport {
  const goldenPaths = requiredImplementedPaths([
    'scripts/refactor-tui-golden.ts',
    'scripts/refactor-tui-runtime-report.ts',
    'docs/refactor/r2.8-tui-runtime-cutover-report.json',
    'docs/refactor/golden/tui/manifest.json',
    'docs/refactor/golden/tui/ansi/startup.ansi',
    'docs/refactor/golden/tui/ansi/streaming.ansi',
    'docs/refactor/golden/tui/ansi/permission.ansi',
    'docs/refactor/golden/tui/ansi/overlay.ansi',
    'docs/refactor/golden/tui/ansi/markdown.ansi',
    'docs/refactor/golden/tui/ansi/scroll-selection.ansi',
    'docs/refactor/golden/tui/screenshots/startup.txt',
    'docs/refactor/golden/tui/screenshots/streaming.txt',
    'docs/refactor/golden/tui/screenshots/permission.txt',
    'docs/refactor/golden/tui/screenshots/overlay.txt',
    'docs/refactor/golden/tui/screenshots/markdown.txt',
    'docs/refactor/golden/tui/screenshots/scroll-selection.txt',
  ])
  const componentRoots = [
    'src/components/PromptInput',
    'src/components/messages',
    'src/components/permissions',
  ]
  const remainingStructureMarkers = componentRoots.flatMap(root =>
    listFiles(root, isSourceLikeFile).filter(path =>
      readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
    ),
  )
  const runtimeCutoverErrors = validateTuiRuntimeReport()

  return report('tui-golden', [
    checkMissing(
      'TUI golden fixtures',
      goldenPaths,
      'TUI golden coverage requires ANSI frames, screenshots, and upstream-shaped component mirrors',
    ),
    checkMissing(
      'TUI runtime cutover',
      runtimeCutoverErrors,
      'R2.8 requires upstream @ant/ink source, upstream component/screen roots, and no active legacy TUI facade',
    ),
    checkMissing(
      'TUI component mirror roots',
      requiredImplementedPaths(componentRoots),
      'R1.5 requires upstream-shaped PromptInput, messages, and permissions component mirror roots',
    ),
    checkMissing(
      'TUI structure markers',
      remainingStructureMarkers,
      'R1.5 component mirrors cannot leave R1.1 structure-only markers',
    ),
  ])
}

function runtimeGate(): GateReport {
  const controlPlaneOnly = args.includes('--hooks') || args.includes('--telemetry') || args.includes('--policy')
  const externalRuntimeReportPaths = [
    'scripts/refactor-external-runtime-report.ts',
    'docs/refactor/r2.9-external-runtime-cutover-report.json',
  ]
  const externalRuntimeErrors = validateExternalRuntimeReport()
  if (controlPlaneOnly) {
    const controlRoots = [
      'src/hooks',
      'src/types/hooks.ts',
      'src/schemas/hooks.ts',
      'src/utils/hooks.ts',
      'src/utils/hooks',
      'src/services/analytics',
      'src/services/diagnosticTracking.ts',
      'src/services/internalLogging.ts',
      'src/services/langfuse',
      'src/utils/telemetry',
      'src/services/policyLimits',
    ]
    const controlGoldenPaths = [
      'scripts/refactor-release-golden.ts',
      'docs/refactor/golden/release/r2.1-control-release-golden.json',
    ]
    const controlRemainingStructureMarkers = controlRoots.flatMap(root =>
      isSourceLikeFile(root)
        ? isStructureOnlyPath(root)
          ? [root]
          : []
        : listFiles(root, isSourceLikeFile).filter(path =>
            readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
          ),
    )

    return report('runtime', [
      checkMissing(
        'hooks telemetry policy mirrors',
        requiredImplementedPaths(controlRoots),
        'R2.1 requires hook, telemetry, diagnostic, internal logging, langfuse, Perfetto, and policy mirror roots',
      ),
      checkMissing(
        'hooks telemetry policy golden matrix',
        requiredImplementedPaths(controlGoldenPaths),
        'R2.1 requires hook ordering, telemetry redaction, and policy deny golden coverage',
      ),
      checkMissing(
        'hooks telemetry policy structure markers',
        controlRemainingStructureMarkers,
        'R2.1 hook, telemetry, and policy mirrors cannot leave R1.1 structure-only markers',
      ),
      checkMissing(
        'external integration runtime cutover',
        [
          ...requiredImplementedPaths(externalRuntimeReportPaths),
          ...externalRuntimeErrors,
        ],
        'R2.9 requires MCP/OAuth/plugin/skill/remote/bridge/native/browser/computer-use/weixin runtime to use upstream paths',
      ),
    ])
  }

  const runtimeRoots = [
    'src/query',
    'src/context',
    'src/state',
    'src/services/providerRegistry',
    'src/services/compact',
    'src/services/contextCollapse',
    'src/hooks',
  ]
  const goldenPaths = [
    'scripts/refactor-runtime-golden.ts',
    'docs/refactor/golden/runtime/r1.6-provider-runtime-golden.json',
  ]
  const sessionRuntimeRoots = [
    'src/context',
    'src/memdir',
    'src/state',
    'src/history.ts',
    'src/services/compact',
    'src/services/contextCollapse',
    'src/services/extractMemories',
    'src/services/SessionMemory',
    'src/services/teamMemorySync',
  ]
  const sessionGoldenPaths = [
    'scripts/refactor-session-memory-golden.ts',
    'docs/refactor/golden/runtime/r1.7-session-context-memory-golden.json',
  ]
  const extensionRuntimeRoots = [
    'src/services/mcp',
    'src/services/oauth',
    'src/services/plugins',
    'src/plugins',
    'src/skills',
    'packages/mcp-client',
  ]
  const extensionGoldenPaths = [
    'scripts/refactor-extension-golden.ts',
    'docs/refactor/golden/runtime/r1.8-extension-ecosystem-golden.json',
  ]
  const remainingStructureMarkers = runtimeRoots.flatMap(root =>
    listFiles(root, isSourceLikeFile).filter(path =>
      readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
    ),
  )
  const sessionRemainingStructureMarkers = sessionRuntimeRoots.flatMap(root =>
    isSourceLikeFile(root)
      ? isStructureOnlyPath(root)
        ? [root]
        : []
      : listFiles(root, isSourceLikeFile).filter(path =>
          readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
        ),
  )
  const extensionRemainingStructureMarkers = extensionRuntimeRoots.flatMap(root =>
    listFiles(root, isSourceLikeOrPackageFile).filter(path =>
      readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
    ),
  )

  return report('runtime', [
    checkMissing(
      'runtime mirrors',
      requiredImplementedPaths(runtimeRoots),
      'provider, query, context, session, service, and hook mirrors must exist before runtime parity can pass',
    ),
    checkMissing(
      'runtime golden matrix',
      requiredImplementedPaths(goldenPaths),
      'R1.6 runtime parity requires provider request/response, tool loop, max turns, abort, compact, and error taxonomy golden coverage',
    ),
    checkMissing(
      'runtime structure markers',
      remainingStructureMarkers,
      'R1.6 runtime mirrors cannot leave R1.1 structure-only markers',
    ),
    checkMissing(
      'session context memory mirrors',
      requiredImplementedPaths(sessionRuntimeRoots),
      'R1.7 requires transcript, resume, context, compact, memory, and team memory mirror roots',
    ),
    checkMissing(
      'session context memory golden matrix',
      requiredImplementedPaths(sessionGoldenPaths),
      'R1.7 requires transcript graph, fork/rewind, file snapshot, context request, memory ranking, and cache break golden coverage',
    ),
    checkMissing(
      'session context memory structure markers',
      sessionRemainingStructureMarkers,
      'R1.7 session/context/memory mirrors cannot leave R1.1 structure-only markers',
    ),
    checkMissing(
      'extension ecosystem mirrors',
      requiredImplementedPaths(extensionRuntimeRoots),
      'R1.8 requires MCP, OAuth, plugin, skill, and mcp-client mirror roots',
    ),
    checkMissing(
      'extension ecosystem golden matrix',
      requiredImplementedPaths(extensionGoldenPaths),
      'R1.8 requires MCP transport, OAuth, plugin lifecycle, and skill lifecycle golden coverage',
    ),
    checkMissing(
      'extension ecosystem structure markers',
      extensionRemainingStructureMarkers,
      'R1.8 MCP/OAuth/plugin/skill mirrors cannot leave R1.1 structure-only markers',
    ),
    checkMissing(
      'external integration runtime cutover',
      [
        ...requiredImplementedPaths(externalRuntimeReportPaths),
        ...externalRuntimeErrors,
      ],
      'R2.9 requires MCP/OAuth/plugin/skill/remote/bridge/native/browser/computer-use/weixin runtime to use upstream paths',
    ),
  ])
}

function transportsGate(): GateReport {
  const cliOnly = args.includes('--cli')
  const mcpOAuthOnly = args.includes('--mcp') || args.includes('--oauth')
  const remoteBridgeAcpOnly = args.includes('--remote') || args.includes('--bridge') || args.includes('--acp')
  const browserIdeOnly = args.includes('--browser') || args.includes('--ide')
  const required = cliOnly
    ? [
        'src/cli/print.ts',
        'src/cli/structuredIO.ts',
        'src/cli/remoteIO.ts',
        'src/cli/transports/Transport.ts',
        'src/cli/transports/SSETransport.ts',
        'src/cli/transports/WebSocketTransport.ts',
        'src/cli/transports/HybridTransport.ts',
        'src/cli/transports/SerialBatchEventUploader.ts',
        'src/cli/transports/WorkerStateUploader.ts',
      ]
    : mcpOAuthOnly
      ? [
          'src/services/mcp',
          'src/services/oauth',
          'packages/mcp-client',
          'scripts/refactor-extension-golden.ts',
          'docs/refactor/golden/runtime/r1.8-extension-ecosystem-golden.json',
        ]
      : remoteBridgeAcpOnly
        ? [
            'src/bridge',
            'src/remote',
            'src/daemon',
            'src/services/acp',
            'packages/acp-link',
            'packages/remote-control-server',
            'scripts/refactor-remote-golden.ts',
            'docs/refactor/golden/transports/r1.9-remote-bridge-acp-golden.json',
          ]
        : browserIdeOnly
          ? [
              'packages/tools/src/tools/webBrowser.ts',
              'packages/tools/src/tools/computerUse.ts',
              'packages/@ant/claude-for-chrome-mcp',
              'packages/@ant/computer-use-input',
              'packages/@ant/computer-use-mcp',
              'packages/@ant/computer-use-swift',
              'packages/weixin',
              'scripts/refactor-native-golden.ts',
              'docs/refactor/golden/native/r2.0-native-platform-golden.json',
            ]
    : [
        'src/cli/transports/SSETransport.ts',
        'src/cli/transports/WebSocketTransport.ts',
        'src/cli/transports/HybridTransport.ts',
        'src/services/mcp',
        'src/services/oauth',
        'src/bridge',
        'src/remote',
        'packages/acp-link',
        'packages/remote-control-server',
      ]
  return report('transports', [
    checkMissing(
      cliOnly ? 'CLI transport mirrors' : 'transport mirrors',
      requiredImplementedPaths(required),
      cliOnly
        ? 'print, structured IO, remote IO, and CLI transport modules must be implemented for R1.2'
        : mcpOAuthOnly
          ? 'R1.8 MCP/OAuth transport mirrors and golden fixtures must be implemented'
        : remoteBridgeAcpOnly
          ? 'R1.9 remote, bridge, daemon, ACP, and remote-control mirrors and golden fixtures must be implemented'
        : browserIdeOnly
          ? 'R2.0 browser, Chrome MCP, computer-use, IDE, and platform golden fixtures must be implemented'
        : 'stdio, HTTP, SSE, WebSocket, OAuth, MCP, bridge, remote, and ACP transport mirrors must exist',
    ),
    checkMissing(
      'external integration runtime cutover',
      [
        ...requiredImplementedPaths([
          'scripts/refactor-external-runtime-report.ts',
          'docs/refactor/r2.9-external-runtime-cutover-report.json',
        ]),
        ...validateExternalRuntimeReport(),
      ],
      'R2.9 transport parity requires upstream MCP/OAuth/CLI transport/remote/bridge/ACP runtime paths',
    ),
    checkMissing(
      'transport structure markers',
      remoteBridgeAcpOnly
        ? [
            'src/bridge',
            'src/remote',
            'src/daemon',
            'src/services/acp',
            'packages/acp-link',
            'packages/remote-control-server/src',
          ].flatMap(root =>
            listFiles(root, isSourceLikeOrPackageFile).filter(path =>
              readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
            ),
          )
        : browserIdeOnly
          ? [
              'packages/@ant/claude-for-chrome-mcp',
              'packages/@ant/computer-use-input',
              'packages/@ant/computer-use-mcp',
              'packages/@ant/computer-use-swift',
            ].flatMap(root =>
              listFiles(root, isSourceLikeOrPackageFile).filter(path =>
                readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
              ),
            )
        : [],
      remoteBridgeAcpOnly
        ? 'R1.9 transport mirrors cannot leave R1.1 structure-only markers'
        : browserIdeOnly
          ? 'R2.0 browser, Chrome MCP, and computer-use mirrors cannot leave R1.1 structure-only markers'
        : 'no focused transport marker check requested',
    ),
  ])
}

function nativeGate(): GateReport {
  const nativeRoots = [
    'packages/audio-capture-napi',
    'packages/color-diff-napi',
    'packages/image-processor-napi',
    'packages/modifiers-napi',
    'packages/url-handler-napi',
    'packages/@ant/computer-use-input',
    'packages/@ant/computer-use-mcp',
    'packages/@ant/computer-use-swift',
    'packages/@ant/claude-for-chrome-mcp',
    'packages/weixin',
  ]
  const nativeGoldenPaths = [
    'scripts/refactor-native-golden.ts',
    'docs/refactor/golden/native/r2.0-native-platform-golden.json',
  ]
  const nativeRemainingStructureMarkers = nativeRoots.flatMap(root =>
    listFiles(root, isSourceLikeOrPackageFile).filter(path =>
      readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
    ),
  )
  return report('native', [
    checkMissing(
      'native package mirrors',
      requiredImplementedPaths(nativeRoots),
      'native and platform package boundaries must be mirrored before native parity can pass',
    ),
    checkMissing(
      'native package golden matrix',
      requiredImplementedPaths(nativeGoldenPaths),
      'R2.0 requires build/load smoke, unsupported platform, browser, computer-use, and IDE golden coverage',
    ),
    checkMissing(
      'native package structure markers',
      nativeRemainingStructureMarkers,
      'R2.0 native and platform mirrors cannot leave R1.1 structure-only markers',
    ),
    checkMissing(
      'external integration runtime cutover',
      [
        ...requiredImplementedPaths([
          'scripts/refactor-external-runtime-report.ts',
          'docs/refactor/r2.9-external-runtime-cutover-report.json',
        ]),
        ...validateExternalRuntimeReport(),
      ],
      'R2.9 native parity requires browser, computer-use, audio, and weixin runtime paths to use upstream packages',
    ),
  ])
}

function fixturesGate(): GateReport {
  if (args.includes('--tools')) {
    return report('fixtures', [
      checkMissing(
        'tool golden fixtures',
        requiredImplementedPaths([
          'scripts/refactor-tool-golden.ts',
          'docs/refactor/golden/tools/r1.4-builtin-tool-golden.json',
        ]),
        'R1.4 tool fixtures must be migrated into recorded builtin tool golden cases',
      ),
    ])
  }
  const baseline = buildInventoryBaseline()
  const upstreamFixtures = baseline.upstream.fixtureFiles
  const fixtureReportPaths = [
    'scripts/refactor-run-upstream-fixtures.ts',
    'scripts/refactor-fixture-migration-report.ts',
    'docs/refactor/fixture-migration-report.json',
    'docs/refactor/r2.7-upstream-test-execution-report.json',
  ]
  const fixtureCoverageErrors = validateFixtureMigrationReport(upstreamFixtures)
  return report('fixtures', [
    checkMissing(
      'fixture migration artifacts',
      requiredImplementedPaths(fixtureReportPaths),
      'R2.7 requires fixture migration artifacts and a real upstream mirror test execution report',
    ),
    checkMissing(
      'upstream fixture execution coverage',
      fixtureCoverageErrors,
      'upstream tests/fixtures must exist locally byte-for-byte and pass a real bun test run; golden substitutes are forbidden',
    ),
  ])
}

function releaseGate(): GateReport {
  const releaseRoots = [
    'src/commands/upgrade',
    'src/commands/terminalSetup',
    'src/migrations',
    'src/bootstrap',
    'src/native-ts',
    'src/services/api/bootstrap.ts',
  ]
  const releaseGoldenPaths = [
    'docs/refactor/golden/release',
    'docs/refactor/golden/release/r2.1-control-release-golden.json',
    'scripts/refactor-release-golden.ts',
  ]
  const releaseRemainingStructureMarkers = releaseRoots.flatMap(root =>
    isSourceLikeFile(root)
      ? isStructureOnlyPath(root)
        ? [root]
        : []
      : listFiles(root, isSourceLikeFile).filter(path =>
          readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker),
        ),
  )
  return report('release', [
    checkMissing(
      'release and install mirrors',
      requiredImplementedPaths([...releaseRoots, ...releaseGoldenPaths]),
      'packaged CLI, install, upgrade, terminal setup, migrations, and release golden coverage are required',
    ),
    checkMissing(
      'release structure markers',
      releaseRemainingStructureMarkers,
      'R2.1 release, bootstrap, migrations, and native-ts mirrors cannot leave R1.1 structure-only markers',
    ),
  ])
}

function trueOneToOneGate(): GateReport {
  const sourceDiff = compareFileTree('claude-code/src', 'src')
  const packageDiff = compareFileTree('claude-code/packages', 'packages')
  const structureMarkerFiles = listStructureMarkerFiles()
  const manyToOneDebtRows = parseManyToOneDebtRows()
  const legacyErrors = validateLegacyRemovalReports()

  return report('true-1to1', [
    checkMissing(
      'full src file tree',
      formatTreeDiff(sourceDiff),
      'local src must have the exact same full non-ignored file tree as claude-code/src',
    ),
    checkMissing(
      'full packages file tree',
      formatTreeDiff(packageDiff),
      'local packages must have the exact same full non-ignored file tree as claude-code/packages',
    ),
    checkMissing(
      'src byte-for-byte content',
      sourceDiff.different.map(path => `src/${path}`),
      'every shared src file must be byte-for-byte identical to the upstream file',
    ),
    checkMissing(
      'packages byte-for-byte content',
      packageDiff.different.map(path => `packages/${path}`),
      'every shared package file must be byte-for-byte identical to the upstream file',
    ),
    checkMissing(
      'structure mirror markers',
      structureMarkerFiles,
      'final 1:1 parity cannot contain R1_1_STRUCTURE_MIRROR scaffold files',
    ),
    checkMissing(
      'many-to-one debt rows',
      manyToOneDebtRows,
      'final 1:1 parity requires docs/refactor/many-to-one-debt.md to contain zero debt rows in every section',
    ),
    checkMissing(
      'legacy report consistency',
      legacyErrors,
      'legacy removal evidence must agree with the real many-to-one debt file',
    ),
  ])
}

function buildInventoryBaseline(): InventoryBaseline {
  const upstreamSourceFiles = listFiles('claude-code/src', isSourceLikeFile)
  const upstreamPackageFiles = listFiles('claude-code/packages', isSourceLikeOrPackageFile)
  const localSourceMirrorFiles = listFiles('src', isSourceLikeFile)
  const localPackageFiles = listFiles('packages', isSourceLikeOrPackageFile)
  const upstreamPackages = listWorkspacePackages('claude-code/packages')
  const localPackages = listWorkspacePackages('packages')
  const commandModules = listChildDirs('claude-code/src/commands')
    .filter(name => !name.startsWith('_') && name !== '__tests__')
  const toolModules = listChildDirs('claude-code/packages/builtin-tools/src/tools')
  const localCommandModules = new Set(listChildDirs('src/commands'))
  const localToolModules = new Set(listChildDirs('packages/builtin-tools/src/tools'))

  return {
    generatedAt: new Date().toISOString(),
    upstream: {
      sourceFiles: upstreamSourceFiles,
      packageFiles: upstreamPackageFiles,
      packages: upstreamPackages,
      commandModules,
      toolModules,
      componentFiles: upstreamSourceFiles.filter(path => path.startsWith('claude-code/src/components/')),
      serviceFiles: upstreamSourceFiles.filter(path => path.startsWith('claude-code/src/services/')),
      hookFiles: upstreamSourceFiles.filter(path => path.startsWith('claude-code/src/hooks/')),
      fixtureFiles: [
        ...upstreamSourceFiles.filter(isTestFixture),
        ...upstreamPackageFiles.filter(isTestFixture),
        ...listFiles('claude-code/tests', isTestFixture),
      ].sort(),
    },
    local: {
      sourceMirrorFiles: localSourceMirrorFiles,
      packageFiles: localPackageFiles,
      packages: localPackages,
    },
    gaps: {
      missingSourceMirrorFiles: upstreamSourceFiles
        .map(path => path.replace(/^claude-code\//, ''))
        .filter(path => !existsSync(join(cwd, path))),
      missingPackageMirrorFiles: upstreamPackageFiles
        .map(path => path.replace(/^claude-code\//, ''))
        .filter(path => !existsSync(join(cwd, path))),
      missingPackages: upstreamPackages.filter(name => !localPackages.includes(name)),
      missingCommandModules: commandModules.filter(name => !localCommandModules.has(name)),
      missingToolModules: toolModules.filter(name => !localToolModules.has(name)),
    },
  }
}

function mirrorStructure(args: { write: boolean }) {
  const baseline = buildInventoryBaseline()
  const sourceWrites = baseline.gaps.missingSourceMirrorFiles
    .map(target => ({
      target,
      source: `claude-code/${target}`,
    }))
  const packageWrites = baseline.gaps.missingPackageMirrorFiles
    .map(target => ({
      target,
      source: `claude-code/${target}`,
    }))
  const writes = [...sourceWrites, ...packageWrites]

  if (args.write) {
    for (const item of writes) {
      writeMirrorFile(item.target, item.source)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: args.write ? 'write' : 'dry-run',
    sourceMirrorFiles: sourceWrites.length,
    packageMirrorFiles: packageWrites.length,
    totalFiles: writes.length,
  }
}

function writeMirrorFile(target: string, source: string): void {
  if (existsSync(join(cwd, target))) {
    return
  }
  if (target.endsWith('/package.json')) {
    writeJson(target, mirrorPackageJson(target, source))
    return
  }
  writeText(target, mirrorSourceContent(target, source))
}

function mirrorPackageJson(target: string, source: string) {
  const packageName = packageNameFromPackageJsonPath(target)
  return {
    name: packageName,
    version: '0.0.0',
    private: true,
    type: 'module',
    description: `R1.1 structure mirror for ${source}.`,
    exports: {
      '.': './src/index.ts',
    },
    xRefactorMirror: {
      marker: structureMirrorMarker,
      upstream: source,
      status: 'structure-only',
    },
  }
}

function packageNameFromPackageJsonPath(path: string): string {
  const parts = path.split('/')
  const packagesIndex = parts.indexOf('packages')
  if (packagesIndex === -1) {
    return `@my-claude-code/refactor-${parts.at(-2) ?? 'package'}`
  }
  const first = parts[packagesIndex + 1]
  if (first?.startsWith('@')) {
    return `${first}/${parts[packagesIndex + 2]}`
  }
  return first ?? `@my-claude-code/refactor-${parts.at(-2) ?? 'package'}`
}

function mirrorSourceContent(target: string, source: string): string {
  const safeName = identifierFromPath(target)
  if (target.endsWith('.d.ts')) {
    return [
      `// ${structureMirrorMarker}: ${source}`,
      `export declare const ${safeName}: {`,
      `  readonly marker: '${structureMirrorMarker}'`,
      `  readonly upstream: '${source}'`,
      "  readonly status: 'structure-only'",
      '}',
      '',
    ].join('\n')
  }
  if (
    target.endsWith('.js') ||
    target.endsWith('.jsx') ||
    target.endsWith('.mjs') ||
    target.endsWith('.cjs')
  ) {
    return [
      `// ${structureMirrorMarker}: ${source}`,
      `export const ${safeName} = {`,
      `  marker: '${structureMirrorMarker}',`,
      `  upstream: '${source}',`,
      "  status: 'structure-only',",
      '}',
      '',
    ].join('\n')
  }
  return [
    `// ${structureMirrorMarker}: ${source}`,
    `export const ${safeName} = {`,
    `  marker: '${structureMirrorMarker}',`,
    `  upstream: '${source}',`,
    "  status: 'structure-only',",
    '} as const',
    '',
  ].join('\n')
}

function identifierFromPath(path: string): string {
  const base = path
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `__${base || 'refactor_mirror'}`
}

function buildManyToOneDebtMarkdown(): string {
  const manifestPath = join(cwd, 'docs/strict-parity-manifest.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, Record<string, string>>
    : {}
  const sections = [
    ['sourceMappings', manifest.sourceMappings ?? {}],
    ['packageMappings', manifest.packageMappings ?? {}],
    ['entrypointMappings', manifest.entrypointMappings ?? {}],
    ['cliTransportMappings', manifest.cliTransportMappings ?? {}],
    ['schemaMappings', manifest.schemaMappings ?? {}],
    ['toolAliases', manifest.toolAliases ?? {}],
    ['commandAliases', manifest.commandAliases ?? {}],
  ] as const

  const lines = [
    '# Many-To-One Debt',
    '',
    'Generated by `bun run parity:inventory`.',
    '',
    'These entries are migration debt for the source-first refactor. They may be used as temporary pointers, but every many-to-one target must be eliminated before 1:1 parity can be declared.',
    '',
  ]

  for (const [name, mappings] of sections) {
    const reverse = reverseMappings(mappings)
    const debt = Object.entries(reverse)
      .filter(([, upstream]) => upstream.length > 1)
      .sort((left, right) => right[1].length - left[1].length)

    lines.push(`## ${name}`, '')
    if (debt.length === 0) {
      lines.push('No many-to-one debt detected.', '')
      continue
    }
    lines.push('| Local target | Upstream count | Upstream items |')
    lines.push('| --- | ---: | --- |')
    for (const [target, upstream] of debt) {
      lines.push(`| \`${target}\` | ${upstream.length} | ${upstream.map(item => `\`${item}\``).join('<br>')} |`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function listFiles(root: string, predicate: (path: string) => boolean): string[] {
  const absoluteRoot = join(cwd, root)
  if (!existsSync(absoluteRoot)) {
    return []
  }
  const output: string[] = []
  walk(absoluteRoot, output, predicate)
  return output.map(path => normalizePath(relative(cwd, path))).sort()
}

function listFilesRelativeToRoot(root: string, predicate: (path: string) => boolean): string[] {
  const absoluteRoot = join(cwd, root)
  if (!existsSync(absoluteRoot)) {
    return []
  }
  const output: string[] = []
  walk(absoluteRoot, output, predicate)
  return output.map(path => normalizePath(relative(absoluteRoot, path))).sort()
}

function compareFileTree(upstreamRoot: string, localRoot: string): FileTreeDiff {
  const upstreamFiles = listFilesRelativeToRoot(upstreamRoot, () => true)
  const localFiles = listFilesRelativeToRoot(localRoot, () => true)
  const upstreamSet = new Set(upstreamFiles)
  const localSet = new Set(localFiles)
  const missing = upstreamFiles.filter(path => !localSet.has(path))
  const extra = localFiles.filter(path => !upstreamSet.has(path))
  const different = upstreamFiles.filter(path => {
    if (!localSet.has(path)) {
      return false
    }
    return fileHash(join(cwd, upstreamRoot, path)) !== fileHash(join(cwd, localRoot, path))
  })
  return { missing, extra, different }
}

function formatTreeDiff(diff: FileTreeDiff): string[] {
  return [
    ...diff.missing.map(path => `missing:${path}`),
    ...diff.extra.map(path => `extra:${path}`),
  ]
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listStructureMarkerFiles(): string[] {
  return [
    ...listFiles('src', isSourceLikeFile),
    ...listFiles('packages', isSourceLikeOrPackageFile),
  ].filter(path => readFileSync(join(cwd, path), 'utf8').includes(structureMirrorMarker))
}

function parseManyToOneDebtRows(): string[] {
  const path = join(cwd, 'docs/refactor/many-to-one-debt.md')
  if (!existsSync(path)) {
    return ['docs/refactor/many-to-one-debt.md: missing']
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.startsWith('| `'))
}

function walk(dir: string, output: string[], predicate: (path: string) => boolean): void {
  for (const entry of readdirSync(dir)) {
    if (ignoredSegments.has(entry)) {
      continue
    }
    const path = join(dir, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      walk(path, output, predicate)
      continue
    }
    if (info.isFile() && predicate(path)) {
      output.push(path)
    }
  }
}

function listChildDirs(root: string): string[] {
  const absoluteRoot = join(cwd, root)
  if (!existsSync(absoluteRoot)) {
    return []
  }
  return readdirSync(absoluteRoot)
    .filter(entry => statSync(join(absoluteRoot, entry)).isDirectory())
    .sort()
}

function listWorkspacePackages(root: string): string[] {
  const absoluteRoot = join(cwd, root)
  if (!existsSync(absoluteRoot)) {
    return []
  }
  const names: string[] = []
  for (const entry of readdirSync(absoluteRoot)) {
    if (entry === 'node_modules') {
      continue
    }
    const path = join(absoluteRoot, entry)
    if (!statSync(path).isDirectory()) {
      continue
    }
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(path)) {
        const scopedPath = join(path, scoped)
        if (statSync(scopedPath).isDirectory() && existsSync(join(scopedPath, 'package.json'))) {
          names.push(`${entry}/${scoped}`)
        }
      }
      continue
    }
    if (existsSync(join(path, 'package.json'))) {
      names.push(entry)
    }
  }
  return names.sort()
}

function isSourceLikeFile(path: string): boolean {
  return sourceExtensions.has(extension(path))
}

function isSourceLikeOrPackageFile(path: string): boolean {
  return isSourceLikeFile(path) || path.endsWith('/package.json')
}

function isTestFixture(path: string): boolean {
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.spec.tsx') ||
    path.includes('_test_') ||
    path.includes('_spec_')
  )
}

function extension(path: string): string {
  const match = path.match(/(\.[^.\\/]+)$/)
  return match?.[1] ?? ''
}

function requiredExistingFiles(paths: string[]): string[] {
  return paths.filter(path => !existsSync(join(cwd, path)))
}

function requiredImplementedPaths(paths: string[]): string[] {
  return paths.filter(path => !existsSync(join(cwd, path)) || isStructureOnlyPath(path))
}

function commandMirrorRegistrationErrors(commandModules: string[]): string[] {
  const registered = readRegisteredSlashCommands()
  const errors: string[] = []
  for (const name of commandModules) {
    if (isDirectCommandMirror(name)) {
      continue
    }
    const mirrorPath = join(cwd, 'src/commands', name, 'index.ts')
    if (!existsSync(mirrorPath)) {
      errors.push(`${name}: missing index.ts`)
      continue
    }
    const content = readFileSync(mirrorPath, 'utf8')
    const slash = content.match(/slash:\s*'([^']+)'/)?.[1]
    const source = content.match(/source:\s*'([^']+)'/)?.[1]
    if (!slash) {
      errors.push(`${name}: missing slash`)
      continue
    }
    if (!registered.has(slash)) {
      errors.push(`${name}: unregistered slash ${slash}`)
    }
    if (source !== `claude-code/src/commands/${name}`) {
      errors.push(`${name}: source mismatch`)
    }
  }
  return errors
}

function commandNativeImplementationErrors(commandModules: string[]): string[] {
  const errors: string[] = []
  for (const name of commandModules) {
    if (isDirectCommandMirror(name)) {
      continue
    }
    const path = join(cwd, 'src/commands', name, 'index.ts')
    if (!existsSync(path)) {
      errors.push(`${name}: missing index.ts`)
      continue
    }
    const content = readFileSync(path, 'utf8')
    if (content.includes(structureMirrorMarker)) {
      errors.push(`${name}: still structure-only`)
    }
    if (content.includes('createCommandMirror')) {
      errors.push(`${name}: still uses adapter command mirror`)
    }
    if (!content.includes('createNativeCommand')) {
      errors.push(`${name}: missing native command wrapper`)
    }
  }
  return errors
}

function isDirectCommandMirror(name: string): boolean {
  const diff = compareFileTree(`claude-code/src/commands/${name}`, `src/commands/${name}`)
  return diff.missing.length === 0 && diff.extra.length === 0 && diff.different.length === 0
}

function readRegisteredSlashCommands(): Set<string> {
  const path = join(cwd, 'packages/commands/src/slashCommands.ts')
  if (!existsSync(path)) {
    return new Set()
  }
  const content = readFileSync(path, 'utf8')
  const commands = Array.from(content.matchAll(/'\/[a-zA-Z0-9_-]+'/g))
    .map(match => match[0].slice(1, -1))
    .filter(command => command.startsWith('/'))
  return new Set(commands)
}

function validateFixtureMigrationReport(upstreamFixtures: string[]): string[] {
  const path = join(cwd, 'docs/refactor/fixture-migration-report.json')
  if (!existsSync(path)) {
    return ['docs/refactor/fixture-migration-report.json: missing']
  }
  const report = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: string
    status?: string
    upstreamFixtureCount?: number
    byteIdenticalFixtureCount?: number
    executedFixtureCount?: number
    missingExecutionCount?: number
    nonDefaultFixtureCount?: number
    missingFixtureCount?: number
    mismatchedFixtureCount?: number
    goldenSubstituteCount?: number
    execution?: {
      command?: string
      status?: string
      exitCode?: number | null
      pass?: number
      fail?: number
      errors?: number
      files?: number
      logPath?: string
    }
    coverage?: Array<{ upstream?: string; local?: string; status?: string; sha256?: string }>
    missingExecution?: string[]
    nonDefaultFixtures?: string[]
    missing?: string[]
    mismatched?: string[]
  }
  const errors: string[] = []
  if (report.version !== 'r2.7') {
    errors.push(`fixture report version is ${report.version ?? 'missing'}, expected r2.7`)
  }
  if (report.status !== 'pass') {
    errors.push(`fixture report status is ${report.status ?? 'missing'}, expected pass`)
  }
  if (report.upstreamFixtureCount !== upstreamFixtures.length) {
    errors.push(`fixture count mismatch: report=${report.upstreamFixtureCount} upstream=${upstreamFixtures.length}`)
  }
  if (report.missingFixtureCount !== 0) {
    errors.push(`missing fixture count is ${report.missingFixtureCount}`)
  }
  if (report.mismatchedFixtureCount !== 0) {
    errors.push(`mismatched fixture count is ${report.mismatchedFixtureCount}`)
  }
  if (report.goldenSubstituteCount !== 0) {
    errors.push(`golden substitute count is ${report.goldenSubstituteCount}`)
  }
  if (report.byteIdenticalFixtureCount !== upstreamFixtures.length) {
    errors.push(`byte-identical fixture count mismatch: report=${report.byteIdenticalFixtureCount} upstream=${upstreamFixtures.length}`)
  }
  if (report.executedFixtureCount !== upstreamFixtures.length) {
    errors.push(`executed fixture count mismatch: report=${report.executedFixtureCount} upstream=${upstreamFixtures.length}`)
  }
  if (report.missingExecutionCount !== 0 || (report.missingExecution?.length ?? 0) !== 0) {
    errors.push(`missing executed fixture count is ${report.missingExecutionCount ?? 'missing'}`)
  }
  if (report.execution?.status !== 'pass' || report.execution.exitCode !== 0) {
    errors.push(`upstream mirror test execution did not pass: status=${report.execution?.status ?? 'missing'} exitCode=${report.execution?.exitCode ?? 'missing'}`)
  }
  if (report.execution?.files !== upstreamFixtures.length) {
    errors.push(`executed test file count mismatch: report=${report.execution?.files ?? 'missing'} upstream=${upstreamFixtures.length}`)
  }
  if ((report.execution?.fail ?? 0) !== 0 || (report.execution?.errors ?? 0) !== 0) {
    errors.push(`upstream mirror test execution has fail=${report.execution?.fail ?? 'missing'} errors=${report.execution?.errors ?? 'missing'}`)
  }
  const runnerPath = join(cwd, 'scripts/refactor-run-upstream-fixtures.ts')
  if (!existsSync(runnerPath)) {
    errors.push('scripts/refactor-run-upstream-fixtures.ts: missing')
  } else {
    const runner = readFileSync(runnerPath, 'utf8')
    if (!runner.includes('claude-code/**') || !runner.includes('legacy/**')) {
      errors.push('upstream mirror test runner does not exclude claude-code/legacy duplicate paths')
    }
    if (!runner.includes('skillSearch/__tests__/prefetch.test.ts')) {
      errors.push('upstream mirror test runner does not isolate skill-search stateful fixture into a separate execution')
    }
    if (!runner.includes('skillLearning/__tests__/skillLearningSmoke.test.ts')) {
      errors.push('upstream mirror test runner does not isolate skill-learning stateful fixture into a separate execution')
    }
  }
  if (report.execution?.logPath && !existsSync(report.execution.logPath)) {
    errors.push(`upstream mirror test log is missing: ${report.execution.logPath}`)
  }
  const coverageByUpstream = new Map((report.coverage ?? []).map(item => [item.upstream, item]))
  for (const upstream of upstreamFixtures) {
    const item = coverageByUpstream.get(upstream)
    if (!item) {
      errors.push(`${upstream}: missing coverage entry`)
      continue
    }
    if (item.status !== 'byte-identical-upstream-test') {
      errors.push(`${upstream}: invalid coverage status ${item.status ?? 'missing'}`)
    }
    if (!item.local) {
      errors.push(`${upstream}: missing local mirror path`)
      continue
    }
    if (!existsSync(join(cwd, item.local))) {
      errors.push(`${upstream}: local mirror path missing ${item.local}`)
      continue
    }
    const expectedLocal = upstream.replace(/^claude-code\//, '')
    if (item.local !== expectedLocal) {
      errors.push(`${upstream}: local mirror mismatch ${item.local} expected ${expectedLocal}`)
      continue
    }
    if (!item.sha256) {
      errors.push(`${upstream}: missing sha256`)
    }
  }
  return errors.slice(0, 50)
}

function validateTuiRuntimeReport(): string[] {
  const path = join(cwd, 'docs/refactor/r2.8-tui-runtime-cutover-report.json')
  if (!existsSync(path)) {
    return ['docs/refactor/r2.8-tui-runtime-cutover-report.json: missing']
  }
  const report = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: string
    status?: string
    inkPackageName?: string | null
    inkWorkspaceDependency?: string | null
    roots?: Array<{
      upstreamRoot?: string
      localRoot?: string
      upstreamFileCount?: number
      localFileCount?: number
      missing?: string[]
      extra?: string[]
      different?: string[]
      status?: string
    }>
    runtimeFiles?: Array<{ path?: string; status?: string; sha256?: string | null }>
    legacyActivePaths?: string[]
  }
  const errors: string[] = []
  if (report.version !== 'r2.8') {
    errors.push(`TUI runtime report version is ${report.version ?? 'missing'}, expected r2.8`)
  }
  if (report.status !== 'pass') {
    errors.push(`TUI runtime report status is ${report.status ?? 'missing'}, expected pass`)
  }
  if (report.inkPackageName !== '@anthropic/ink') {
    errors.push(`packages/@ant/ink package name is ${report.inkPackageName ?? 'missing'}, expected @anthropic/ink`)
  }
  if (report.inkWorkspaceDependency !== 'workspace:*') {
    errors.push(`root @anthropic/ink dependency is ${report.inkWorkspaceDependency ?? 'missing'}, expected workspace:*`)
  }
  const expectedRoots = new Set([
    'packages/@ant/ink',
    'src/components',
    'src/screens',
    'src/vim',
  ])
  const rootsByLocal = new Map((report.roots ?? []).map(root => [root.localRoot, root]))
  for (const root of expectedRoots) {
    const item = rootsByLocal.get(root)
    if (!item) {
      errors.push(`${root}: missing TUI runtime root report`)
      continue
    }
    if (item.status !== 'pass') {
      errors.push(`${root}: runtime root status is ${item.status ?? 'missing'}`)
    }
    if ((item.missing?.length ?? 0) !== 0 || (item.extra?.length ?? 0) !== 0 || (item.different?.length ?? 0) !== 0) {
      errors.push(`${root}: root diff remains missing=${item.missing?.length ?? 'missing'} extra=${item.extra?.length ?? 'missing'} different=${item.different?.length ?? 'missing'}`)
    }
    const upstreamRoot = `claude-code/${root}`
    const diff = compareFileTree(upstreamRoot, root)
    if (diff.missing.length !== 0 || diff.extra.length !== 0 || diff.different.length !== 0) {
      errors.push(`${root}: current file tree/hash no longer matches ${upstreamRoot}`)
    }
  }
  const runtimeFiles = report.runtimeFiles ?? []
  if (runtimeFiles.length < 20) {
    errors.push(`TUI runtime file evidence is too small: ${runtimeFiles.length}`)
  }
  const badRuntimeFiles = runtimeFiles.filter(item => item.status !== 'byte-identical' || !item.sha256)
  if (badRuntimeFiles.length !== 0) {
    errors.push(`TUI runtime file evidence has ${badRuntimeFiles.length} non-byte-identical item(s)`)
  }
  const requiredRuntimeFiles = [
    'packages/@ant/ink/src/core/reconciler.ts',
    'packages/@ant/ink/src/core/renderer.ts',
    'packages/@ant/ink/src/core/render-to-screen.ts',
    'packages/@ant/ink/src/core/screen.ts',
    'packages/@ant/ink/src/core/selection.ts',
    'packages/@ant/ink/src/components/NoSelect.tsx',
    'packages/@ant/ink/src/components/ScrollBox.tsx',
    'src/components/PromptInput/PromptInput.tsx',
    'src/components/Messages.tsx',
    'src/components/Markdown.tsx',
    'src/components/Spinner/index.ts',
    'src/screens/REPL.tsx',
  ]
  const runtimeByPath = new Set(runtimeFiles.map(item => item.path))
  for (const runtimeFile of requiredRuntimeFiles) {
    if (!runtimeByPath.has(runtimeFile)) {
      errors.push(`${runtimeFile}: missing TUI runtime evidence`)
    }
  }
  if ((report.legacyActivePaths?.length ?? 0) !== 0) {
    errors.push(`active legacy TUI paths remain: ${report.legacyActivePaths?.join(', ')}`)
  }
  for (const legacyPath of ['packages/anthropic-ink', 'packages/tui']) {
    if (existsSync(join(cwd, legacyPath))) {
      errors.push(`${legacyPath}: active legacy path exists`)
    }
  }
  return errors.slice(0, 50)
}

function validateExternalRuntimeReport(): string[] {
  const path = join(cwd, 'docs/refactor/r2.9-external-runtime-cutover-report.json')
  if (!existsSync(path)) {
    return ['docs/refactor/r2.9-external-runtime-cutover-report.json: missing']
  }
  const report = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: string
    status?: string
    roots?: Array<{
      upstreamRoot?: string
      localRoot?: string
      missing?: string[]
      extra?: string[]
      different?: string[]
      status?: string
    }>
    runtimeFiles?: Array<{ path?: string; status?: string; sha256?: string | null }>
    workspaceDependencies?: Array<{
      name?: string
      packageRoot?: string
      upstreamPackageName?: string | null
      packageName?: string | null
      status?: string
    }>
    legacyActivePaths?: string[]
  }
  const errors: string[] = []
  if (report.version !== 'r2.9') {
    errors.push(`external runtime report version is ${report.version ?? 'missing'}, expected r2.9`)
  }
  if (report.status !== 'pass') {
    errors.push(`external runtime report status is ${report.status ?? 'missing'}, expected pass`)
  }
  const expectedRoots = new Set([
    'src/services/mcp',
    'src/services/oauth',
    'src/services/plugins',
    'src/plugins',
    'src/skills',
    'src/bridge',
    'src/daemon',
    'src/remote',
    'src/server',
    'src/services/acp',
    'src/ssh',
    'src/cli/transports',
    'packages/mcp-client',
    'packages/remote-control-server',
    'packages/acp-link',
    'packages/agent-tools',
    'packages/audio-capture-napi',
    'packages/@ant/claude-for-chrome-mcp',
    'packages/@ant/computer-use-input',
    'packages/@ant/computer-use-mcp',
    'packages/@ant/computer-use-swift',
    'packages/weixin',
  ])
  const rootsByLocal = new Map((report.roots ?? []).map(root => [root.localRoot, root]))
  for (const root of expectedRoots) {
    const item = rootsByLocal.get(root)
    if (!item) {
      errors.push(`${root}: missing external runtime root report`)
      continue
    }
    if (item.status !== 'pass') {
      errors.push(`${root}: external runtime root status is ${item.status ?? 'missing'}`)
    }
    if ((item.missing?.length ?? 0) !== 0 || (item.extra?.length ?? 0) !== 0 || (item.different?.length ?? 0) !== 0) {
      errors.push(`${root}: root diff remains missing=${item.missing?.length ?? 'missing'} extra=${item.extra?.length ?? 'missing'} different=${item.different?.length ?? 'missing'}`)
    }
    const upstreamRoot = `claude-code/${root}`
    const diff = compareFileTree(upstreamRoot, root)
    if (diff.missing.length !== 0 || diff.extra.length !== 0 || diff.different.length !== 0) {
      errors.push(`${root}: current file tree/hash no longer matches ${upstreamRoot}`)
    }
  }
  const runtimeFiles = report.runtimeFiles ?? []
  if (runtimeFiles.length < 30) {
    errors.push(`external runtime file evidence is too small: ${runtimeFiles.length}`)
  }
  const badRuntimeFiles = runtimeFiles.filter(item => item.status !== 'byte-identical' || !item.sha256)
  if (badRuntimeFiles.length !== 0) {
    errors.push(`external runtime file evidence has ${badRuntimeFiles.length} non-byte-identical item(s)`)
  }
  const requiredRuntimeFiles = [
    'src/services/mcp/client.ts',
    'src/services/oauth/client.ts',
    'src/services/plugins/PluginInstallationManager.ts',
    'src/bridge/bridgeApi.ts',
    'src/daemon/main.ts',
    'src/remote/RemoteSessionManager.ts',
    'src/server/server.ts',
    'src/services/acp/bridge.ts',
    'src/cli/transports/SSETransport.ts',
    'packages/mcp-client/src/index.ts',
    'packages/remote-control-server/src/index.ts',
    'packages/acp-link/src/server.ts',
    'packages/@ant/claude-for-chrome-mcp/src/mcpServer.ts',
    'packages/@ant/computer-use-mcp/src/mcpServer.ts',
    'packages/weixin/src/index.ts',
  ]
  const runtimeByPath = new Set(runtimeFiles.map(item => item.path))
  for (const runtimeFile of requiredRuntimeFiles) {
    if (!runtimeByPath.has(runtimeFile)) {
      errors.push(`${runtimeFile}: missing external runtime evidence`)
    }
  }
  const expectedWorkspaceDependencies = new Map([
    ['@ant/claude-for-chrome-mcp', 'packages/@ant/claude-for-chrome-mcp'],
    ['@ant/computer-use-input', 'packages/@ant/computer-use-input'],
    ['@ant/computer-use-mcp', 'packages/@ant/computer-use-mcp'],
    ['@ant/computer-use-swift', 'packages/@ant/computer-use-swift'],
    ['acp-link', 'packages/acp-link'],
    ['agent-tools', 'packages/agent-tools'],
    ['audio-capture-napi', 'packages/audio-capture-napi'],
    ['mcp-client', 'packages/mcp-client'],
    ['remote-control-server', 'packages/remote-control-server'],
    ['weixin', 'packages/weixin'],
  ])
  const dependencyByName = new Map((report.workspaceDependencies ?? []).map(dependency => [dependency.name, dependency]))
  for (const [dependency, packageRoot] of expectedWorkspaceDependencies) {
    const item = dependencyByName.get(dependency)
    if (!item) {
      errors.push(`${dependency}: missing workspace dependency evidence`)
      continue
    }
    if (item.status !== 'workspace' || item.packageName !== item.upstreamPackageName || item.packageRoot !== packageRoot) {
      errors.push(`${dependency}: expected upstream package at ${packageRoot}, got ${item.packageRoot ?? 'missing'} name=${item.packageName ?? 'missing'} upstreamName=${item.upstreamPackageName ?? 'missing'}`)
    }
  }
  if ((report.legacyActivePaths?.length ?? 0) !== 0) {
    errors.push(`active legacy external paths remain: ${report.legacyActivePaths?.join(', ')}`)
  }
  for (const legacyPath of [
    'packages/tools/src/extensions.ts',
    'packages/tools/src/remote.ts',
    'packages/mcp-client/src/mockTransport.ts',
  ]) {
    if (existsSync(join(cwd, legacyPath))) {
      errors.push(`${legacyPath}: active legacy path exists`)
    }
  }
  return errors.slice(0, 50)
}

function validateLegacyRemovalReports(): string[] {
  const errors: string[] = []
  const manyToOnePath = join(cwd, 'docs/refactor/many-to-one-debt.md')
  if (!existsSync(manyToOnePath)) {
    errors.push('docs/refactor/many-to-one-debt.md: missing')
  } else {
    const debtRows = parseManyToOneDebtRows()
    if (debtRows.length > 0) {
      errors.push(`docs/refactor/many-to-one-debt.md: ${debtRows.length} debt row(s) remain`)
    }
  }
  const legacyReportPath = join(cwd, 'docs/refactor/legacy-removal-report.json')
  if (!existsSync(legacyReportPath)) {
    errors.push('docs/refactor/legacy-removal-report.json: missing')
  } else {
    const report = JSON.parse(readFileSync(legacyReportPath, 'utf8')) as {
      strictParityManifest?: { refactorCompletionGate?: boolean }
      manyToOneDebt?: { status?: string }
    }
    if (report.strictParityManifest?.refactorCompletionGate !== false) {
      errors.push('strict parity manifest is still marked as a refactor completion gate')
    }
    if (report.manyToOneDebt?.status !== 'zero') {
      errors.push('legacy many-to-one debt status is not zero')
    }
  }
  return errors
}

function isStructureOnlyPath(path: string): boolean {
  const absolutePath = join(cwd, path)
  if (!existsSync(absolutePath)) {
    return false
  }
  const info = statSync(absolutePath)
  if (info.isDirectory()) {
    return isStructureOnlyDirectory(path)
  }
  return isStructureOnlyFile(absolutePath)
}

function isStructureOnlyDirectory(path: string): boolean {
  const absolutePath = join(cwd, path)
  if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
    return false
  }
  const files = listFiles(path, isSourceLikeFile)
  return files.length > 0 && files.every(file => isStructureOnlyFile(join(cwd, file)))
}

function isStructureOnlyFile(path: string): boolean {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return false
  }
  return readFileSync(path, 'utf8').includes(structureMirrorMarker)
}

function checkMissing(label: string, missing: string[], detail: string): GateCheck {
  return missing.length > 0
    ? {
        label,
        status: 'fail',
        detail: `${detail}; ${missing.length} missing`,
        missing: missing.slice(0, 50),
      }
    : {
        label,
        status: 'pass',
        detail,
      }
}

function report(gate: string, checks: GateCheck[]): GateReport {
  return {
    gate,
    status: checks.some(check => check.status === 'fail') ? 'fail' : 'pass',
    cwd,
    generatedAt: new Date().toISOString(),
    summary: summarizeChecks(checks),
    checks,
  }
}

function summarizeChecks(checks: GateCheck[]): GateReport['summary'] {
  return {
    pass: checks.filter(check => check.status === 'pass').length,
    fail: checks.filter(check => check.status === 'fail').length,
  }
}

function printReport(gateReport: GateReport): void {
  console.log(JSON.stringify(gateReport, null, 2))
  if (gateReport.status === 'fail') {
    process.exit(1)
  }
}

function baselineSummary(baseline: InventoryBaseline) {
  return {
    generatedAt: baseline.generatedAt,
    upstream: {
      sourceFiles: baseline.upstream.sourceFiles.length,
      packageFiles: baseline.upstream.packageFiles.length,
      packages: baseline.upstream.packages.length,
      commandModules: baseline.upstream.commandModules.length,
      toolModules: baseline.upstream.toolModules.length,
      fixtures: baseline.upstream.fixtureFiles.length,
    },
    local: {
      sourceMirrorFiles: baseline.local.sourceMirrorFiles.length,
      packageFiles: baseline.local.packageFiles.length,
      packages: baseline.local.packages.length,
    },
    gaps: {
      missingSourceMirrorFiles: baseline.gaps.missingSourceMirrorFiles.length,
      missingPackageMirrorFiles: baseline.gaps.missingPackageMirrorFiles.length,
      missingPackages: baseline.gaps.missingPackages.length,
      missingCommandModules: baseline.gaps.missingCommandModules.length,
      missingToolModules: baseline.gaps.missingToolModules.length,
    },
  }
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(path: string, value: string): void {
  const absolutePath = join(cwd, path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, value, 'utf8')
}

function reverseMappings(mappings: Record<string, string>): Record<string, string[]> {
  const reverse: Record<string, string[]> = {}
  for (const [upstream, local] of Object.entries(mappings)) {
    reverse[local] ??= []
    reverse[local].push(upstream)
  }
  return reverse
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}
