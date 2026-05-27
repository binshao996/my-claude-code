import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

type RootReport = {
  upstreamRoot: string
  localRoot: string
  upstreamFileCount: number
  localFileCount: number
  missing: string[]
  extra: string[]
  different: string[]
  status: 'pass' | 'fail'
}

type RuntimeFileReport = {
  path: string
  upstream: string
  local: string
  sha256: string | null
  status: 'byte-identical' | 'missing' | 'different'
}

type PackageDependencyReport = {
  name: string
  packageRoot: string
  upstreamPackageName: string | null
  packageName: string | null
  status: 'workspace' | 'missing' | 'name-mismatch'
}

type ExternalRuntimeReport = {
  version: 'r2.9'
  generatedAt: string
  status: 'pass' | 'fail'
  roots: RootReport[]
  runtimeFiles: RuntimeFileReport[]
  workspaceDependencies: PackageDependencyReport[]
  legacyActivePaths: string[]
}

const cwd = process.cwd()
const shouldWrite = process.argv.includes('--write')
const reportPath = 'docs/refactor/r2.9-external-runtime-cutover-report.json'

const roots = [
  ['claude-code/src/services/mcp', 'src/services/mcp'],
  ['claude-code/src/services/oauth', 'src/services/oauth'],
  ['claude-code/src/services/plugins', 'src/services/plugins'],
  ['claude-code/src/plugins', 'src/plugins'],
  ['claude-code/src/skills', 'src/skills'],
  ['claude-code/src/bridge', 'src/bridge'],
  ['claude-code/src/daemon', 'src/daemon'],
  ['claude-code/src/remote', 'src/remote'],
  ['claude-code/src/server', 'src/server'],
  ['claude-code/src/services/acp', 'src/services/acp'],
  ['claude-code/src/ssh', 'src/ssh'],
  ['claude-code/src/cli/transports', 'src/cli/transports'],
  ['claude-code/packages/mcp-client', 'packages/mcp-client'],
  ['claude-code/packages/remote-control-server', 'packages/remote-control-server'],
  ['claude-code/packages/acp-link', 'packages/acp-link'],
  ['claude-code/packages/agent-tools', 'packages/agent-tools'],
  ['claude-code/packages/audio-capture-napi', 'packages/audio-capture-napi'],
  ['claude-code/packages/@ant/claude-for-chrome-mcp', 'packages/@ant/claude-for-chrome-mcp'],
  ['claude-code/packages/@ant/computer-use-input', 'packages/@ant/computer-use-input'],
  ['claude-code/packages/@ant/computer-use-mcp', 'packages/@ant/computer-use-mcp'],
  ['claude-code/packages/@ant/computer-use-swift', 'packages/@ant/computer-use-swift'],
  ['claude-code/packages/weixin', 'packages/weixin'],
] as const

const runtimeFiles = [
  'src/services/mcp/client.ts',
  'src/services/mcp/MCPConnectionManager.tsx',
  'src/services/mcp/auth.ts',
  'src/services/oauth/client.ts',
  'src/services/oauth/auth-code-listener.ts',
  'src/services/plugins/PluginInstallationManager.ts',
  'src/services/plugins/pluginOperations.ts',
  'src/plugins/builtinPlugins.ts',
  'src/skills/bundledSkills.ts',
  'src/skills/mcpSkills.ts',
  'src/bridge/bridgeApi.ts',
  'src/bridge/bridgeMain.ts',
  'src/bridge/remoteBridgeCore.ts',
  'src/daemon/main.ts',
  'src/remote/RemoteSessionManager.ts',
  'src/server/server.ts',
  'src/services/acp/bridge.ts',
  'src/ssh/SSHSessionManager.ts',
  'src/cli/remoteIO.ts',
  'src/cli/transports/SSETransport.ts',
  'src/cli/transports/WebSocketTransport.ts',
  'src/cli/transports/HybridTransport.ts',
  'src/cli/transports/SerialBatchEventUploader.ts',
  'src/cli/transports/WorkerStateUploader.ts',
  'packages/mcp-client/src/index.ts',
  'packages/mcp-client/src/transport/InProcessTransport.ts',
  'packages/remote-control-server/src/index.ts',
  'packages/remote-control-server/src/transport/sse-writer.ts',
  'packages/remote-control-server/src/transport/ws-handler.ts',
  'packages/acp-link/src/server.ts',
  'packages/agent-tools/src/registry.ts',
  'packages/audio-capture-napi/src/index.ts',
  'packages/@ant/claude-for-chrome-mcp/src/mcpServer.ts',
  'packages/@ant/computer-use-input/src/index.ts',
  'packages/@ant/computer-use-mcp/src/mcpServer.ts',
  'packages/@ant/computer-use-swift/src/index.ts',
  'packages/weixin/src/index.ts',
] as const

const workspaceDependencies = [
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
] as const

const legacyActivePaths = [
  'packages/tools/src/extensions.ts',
  'packages/tools/src/remote.ts',
  'packages/mcp-client/src/mockTransport.ts',
].filter(path => existsSync(join(cwd, path)))

const rootReports = roots.map(([upstreamRoot, localRoot]) =>
  compareRoot(upstreamRoot, localRoot),
)
const runtimeFileReports = runtimeFiles.map(checkRuntimeFile)
const workspaceDependencyReports = workspaceDependencies.map(([name, packageRoot]) =>
  checkWorkspaceDependency(name, packageRoot),
)
const status =
  rootReports.every(root => root.status === 'pass') &&
  runtimeFileReports.every(file => file.status === 'byte-identical') &&
  workspaceDependencyReports.every(dependency => dependency.status === 'workspace') &&
  legacyActivePaths.length === 0
    ? 'pass'
    : 'fail'

const report: ExternalRuntimeReport = {
  version: 'r2.9',
  generatedAt: new Date().toISOString(),
  status,
  roots: rootReports,
  runtimeFiles: runtimeFileReports,
  workspaceDependencies: workspaceDependencyReports,
  legacyActivePaths,
}

if (shouldWrite) {
  writeJson(reportPath, report)
}

console.log(JSON.stringify({
  status: report.status,
  roots: report.roots.map(root => ({
    localRoot: root.localRoot,
    upstreamFileCount: root.upstreamFileCount,
    localFileCount: root.localFileCount,
    missing: root.missing.length,
    extra: root.extra.length,
    different: root.different.length,
    status: root.status,
  })),
  runtimeFiles: {
    total: report.runtimeFiles.length,
    byteIdentical: report.runtimeFiles.filter(file => file.status === 'byte-identical').length,
    missing: report.runtimeFiles.filter(file => file.status === 'missing').length,
    different: report.runtimeFiles.filter(file => file.status === 'different').length,
  },
  workspaceDependencies: report.workspaceDependencies,
  legacyActivePaths: report.legacyActivePaths,
  reportPath,
}, null, 2))

if (report.status !== 'pass') {
  process.exit(1)
}

function compareRoot(upstreamRoot: string, localRoot: string): RootReport {
  const upstreamFiles = listFilesRelativeToRoot(upstreamRoot)
  const localFiles = listFilesRelativeToRoot(localRoot)
  const upstreamSet = new Set(upstreamFiles)
  const localSet = new Set(localFiles)
  const missing = upstreamFiles.filter(path => !localSet.has(path))
  const extra = localFiles.filter(path => !upstreamSet.has(path))
  const different = upstreamFiles.filter(path => {
    if (!localSet.has(path)) {
      return false
    }
    return sha256(join(cwd, upstreamRoot, path)) !== sha256(join(cwd, localRoot, path))
  })
  return {
    upstreamRoot,
    localRoot,
    upstreamFileCount: upstreamFiles.length,
    localFileCount: localFiles.length,
    missing,
    extra,
    different,
    status: missing.length === 0 && extra.length === 0 && different.length === 0 ? 'pass' : 'fail',
  }
}

function checkRuntimeFile(path: string): RuntimeFileReport {
  const upstream = `claude-code/${path}`
  const upstreamAbsolute = join(cwd, upstream)
  const localAbsolute = join(cwd, path)
  if (!existsSync(upstreamAbsolute) || !existsSync(localAbsolute)) {
    return { path, upstream, local: path, sha256: null, status: 'missing' }
  }
  const upstreamHash = sha256(upstreamAbsolute)
  const localHash = sha256(localAbsolute)
  return {
    path,
    upstream,
    local: path,
    sha256: localHash,
    status: upstreamHash === localHash ? 'byte-identical' : 'different',
  }
}

function checkWorkspaceDependency(name: string, packageRoot: string): PackageDependencyReport {
  const packageJson = readJson(`${packageRoot}/package.json`) as { name?: string } | null
  const upstreamPackageJson = readJson(`claude-code/${packageRoot}/package.json`) as { name?: string } | null
  const upstreamPackageName = upstreamPackageJson?.name ?? null
  const packageName = packageJson?.name ?? null
  return {
    name,
    packageRoot,
    upstreamPackageName,
    packageName,
    status: packageName === null || upstreamPackageName === null
      ? 'missing'
      : packageName === upstreamPackageName
        ? 'workspace'
        : 'name-mismatch',
  }
}

function listFilesRelativeToRoot(root: string): string[] {
  const absoluteRoot = join(cwd, root)
  if (!existsSync(absoluteRoot)) {
    return []
  }
  const output: string[] = []
  walk(absoluteRoot, output)
  return output.map(path => normalizePath(relative(absoluteRoot, path))).sort()
}

function walk(dir: string, output: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'coverage') {
      continue
    }
    const path = join(dir, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      walk(path, output)
      continue
    }
    if (info.isFile()) {
      output.push(path)
    }
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function readJson(path: string): unknown | null {
  const absolute = join(cwd, path)
  if (!existsSync(absolute)) {
    return null
  }
  return JSON.parse(readFileSync(absolute, 'utf8'))
}

function writeJson(path: string, value: unknown): void {
  const absolute = join(cwd, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
}
