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

type TuiRuntimeReport = {
  version: 'r2.8'
  generatedAt: string
  status: 'pass' | 'fail'
  inkPackageName: string | null
  inkWorkspaceDependency: string | null
  roots: RootReport[]
  runtimeFiles: RuntimeFileReport[]
  legacyActivePaths: string[]
}

const cwd = process.cwd()
const shouldWrite = process.argv.includes('--write')
const reportPath = 'docs/refactor/r2.8-tui-runtime-cutover-report.json'

const roots = [
  ['claude-code/packages/@ant/ink', 'packages/@ant/ink'],
  ['claude-code/src/components', 'src/components'],
  ['claude-code/src/screens', 'src/screens'],
  ['claude-code/src/vim', 'src/vim'],
] as const

const runtimeFiles = [
  'packages/@ant/ink/package.json',
  'packages/@ant/ink/src/index.ts',
  'packages/@ant/ink/src/core/reconciler.ts',
  'packages/@ant/ink/src/core/renderer.ts',
  'packages/@ant/ink/src/core/render-to-screen.ts',
  'packages/@ant/ink/src/core/screen.ts',
  'packages/@ant/ink/src/core/selection.ts',
  'packages/@ant/ink/src/core/termio/parser.ts',
  'packages/@ant/ink/src/components/AlternateScreen.tsx',
  'packages/@ant/ink/src/components/NoSelect.tsx',
  'packages/@ant/ink/src/components/ScrollBox.tsx',
  'packages/@ant/ink/src/hooks/use-input.ts',
  'packages/@ant/ink/src/hooks/use-selection.ts',
  'packages/@ant/ink/src/hooks/use-terminal-viewport.ts',
  'packages/@ant/ink/src/theme/Spinner.tsx',
  'packages/@ant/ink/src/theme/ThemeProvider.tsx',
  'src/components/App.tsx',
  'src/components/FullscreenLayout.tsx',
  'src/components/Markdown.tsx',
  'src/components/MarkdownTable.tsx',
  'src/components/Messages.tsx',
  'src/components/PromptInput/PromptInput.tsx',
  'src/components/PromptInput/PromptInputFooter.tsx',
  'src/components/PromptInput/inputPaste.ts',
  'src/components/ScrollKeybindingHandler.tsx',
  'src/components/Spinner/index.ts',
  'src/components/TextInput.tsx',
  'src/context/overlayContext.tsx',
  'src/dialogLaunchers.tsx',
  'src/history.ts',
  'src/interactiveHelpers.tsx',
  'src/main.tsx',
  'src/replLauncher.tsx',
  'src/screens/REPL.tsx',
] as const

const legacyActivePaths = [
  'packages/anthropic-ink',
  'packages/tui',
].filter(path => existsSync(join(cwd, path)))

const rootReports = roots.map(([upstreamRoot, localRoot]) =>
  compareRoot(upstreamRoot, localRoot),
)
const runtimeFileReports = runtimeFiles.map(checkRuntimeFile)
const packageJson = readJson('packages/@ant/ink/package.json') as { name?: string } | null
const rootPackageJson = readJson('package.json') as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} | null
const inkWorkspaceDependency =
  rootPackageJson?.dependencies?.['@anthropic/ink'] ??
  rootPackageJson?.devDependencies?.['@anthropic/ink'] ??
  null
const status =
  rootReports.every(root => root.status === 'pass') &&
  runtimeFileReports.every(file => file.status === 'byte-identical') &&
  legacyActivePaths.length === 0 &&
  packageJson?.name === '@anthropic/ink' &&
  inkWorkspaceDependency === 'workspace:*'
    ? 'pass'
    : 'fail'

const report: TuiRuntimeReport = {
  version: 'r2.8',
  generatedAt: new Date().toISOString(),
  status,
  inkPackageName: packageJson?.name ?? null,
  inkWorkspaceDependency,
  roots: rootReports,
  runtimeFiles: runtimeFileReports,
  legacyActivePaths,
}

if (shouldWrite) {
  writeJson(reportPath, report)
}

console.log(JSON.stringify({
  status: report.status,
  inkPackageName: report.inkPackageName,
  inkWorkspaceDependency: report.inkWorkspaceDependency,
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
