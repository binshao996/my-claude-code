import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getBuiltinToolModuleMirrors,
  getBuiltinTools,
  runToolUse,
  toolsToProviderTools,
} from '../packages/builtin-tools/src/index.ts'

type ModuleGolden = {
  moduleName: string
  expectedToolNames: string[]
  expectedProviderToolNames?: string[]
  expectedRuntime?: Array<'local-runtime' | 'gated-upstream-surface'>
}

type ExecutionGolden = {
  toolName: string
  input: Record<string, unknown>
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk'
  setupFiles?: Record<string, string>
  expectedContentIncludes?: string[]
  expectedContentExcludes?: string[]
  expectedIsError?: boolean
  expectedPermissionDecision?: string
  expectedFiles?: Array<{
    path: string
    exists?: boolean
    includes?: string[]
    excludes?: string[]
  }>
}

type GoldenFile = {
  version: 1
  description?: string
  modules: ModuleGolden[]
  executions: ExecutionGolden[]
}

type Failure = {
  label: string
  missing?: string[]
  unexpected?: string[]
  detail?: unknown
}

const fixturePath =
  process.argv[2] ?? 'docs/refactor/golden/tools/r1.4-builtin-tool-golden.json'
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFile
const failures: Failure[] = []
const mirrors = getBuiltinToolModuleMirrors()
const mirrorByName = new Map(mirrors.map(mirror => [mirror.moduleName, mirror]))
const providerNames = new Set(toolsToProviderTools(getBuiltinTools()).map(tool => tool.name))

for (const item of fixture.modules) {
  const mirror = mirrorByName.get(item.moduleName)
  if (!mirror) {
    failures.push({ label: item.moduleName, missing: ['module mirror'] })
    continue
  }

  const toolNames = mirror.tools.map(tool => tool.name)
  const missing = item.expectedToolNames.filter(name => !toolNames.includes(name))
  const expectedProvider = item.expectedProviderToolNames ?? item.expectedToolNames
  missing.push(...expectedProvider
    .filter(name => !providerNames.has(name))
    .map(name => `provider:${name}`))

  if (item.expectedRuntime) {
    const runtimes = new Set(mirror.metadata.map(metadata => metadata.runtime))
    missing.push(...item.expectedRuntime
      .filter(runtime => !runtimes.has(runtime))
      .map(runtime => `runtime:${runtime}`))
  }

  missing.push(...mirror.providerTools
    .filter(tool => tool.input_schema?.type !== 'object')
    .map(tool => `schema:${tool.name}`))

  if (missing.length > 0) {
    failures.push({ label: item.moduleName, missing, detail: mirror })
  }
}

for (const item of fixture.executions) {
  const cwd = mkdtempSync(join(tmpdir(), 'my-claude-tool-golden-'))
  try {
    for (const [relativePath, content] of Object.entries(item.setupFiles ?? {})) {
      const target = join(cwd, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }

    const result = await runToolUse(
      {
        type: 'tool_use',
        id: `golden_${item.toolName}`,
        name: item.toolName,
        input: item.input,
      },
      getBuiltinTools(),
      {
        cwd,
        permissionMode: item.permissionMode ?? 'default',
      },
    )
    const content = normalize(result.content, cwd)
    const missing = (item.expectedContentIncludes ?? []).filter(value => !content.includes(value))
    const unexpected = (item.expectedContentExcludes ?? []).filter(value => content.includes(value))

    if (item.expectedIsError !== undefined && item.expectedIsError !== Boolean(result.is_error)) {
      missing.push(`is_error=${item.expectedIsError}`)
    }
    if (
      item.expectedPermissionDecision !== undefined &&
      item.expectedPermissionDecision !== result.permission_decision
    ) {
      missing.push(`permission_decision=${item.expectedPermissionDecision}`)
    }

    for (const file of item.expectedFiles ?? []) {
      const path = join(cwd, file.path)
      const shouldExist = file.exists ?? true
      if (existsSync(path) !== shouldExist) {
        missing.push(`${file.path} exists=${shouldExist}`)
        continue
      }
      if (!shouldExist) {
        continue
      }
      const fileContent = normalize(readFileSync(path, 'utf8'), cwd)
      missing.push(...(file.includes ?? [])
        .filter(value => !fileContent.includes(value))
        .map(value => `${file.path}:${value}`))
      unexpected.push(...(file.excludes ?? [])
        .filter(value => fileContent.includes(value))
        .map(value => `${file.path}:${value}`))
    }

    if (missing.length > 0 || unexpected.length > 0) {
      failures.push({ label: `execute:${item.toolName}`, missing, unexpected, detail: result })
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const report = {
  fixture: fixturePath,
  status: failures.length > 0 ? 'fail' : 'pass',
  modules: fixture.modules.length,
  executions: fixture.executions.length,
  failures,
}

console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) {
  process.exit(1)
}

function normalize(value: string, cwd: string): string {
  return value
    .replaceAll(cwd, '<cwd>')
    .replaceAll(/[0-9a-f]{64}/g, '<sha256>')
    .replaceAll(/task_[0-9a-f-]+/g, 'task_<id>')
    .replaceAll(/team_[0-9a-f-]+/g, 'team_<id>')
    .replaceAll(/remote_[0-9a-f-]+/g, 'remote_<id>')
    .replaceAll(/"createdAt":"[^"]+"/g, '"createdAt":"<timestamp>"')
    .replaceAll(/"updatedAt":"[^"]+"/g, '"updatedAt":"<timestamp>"')
}
