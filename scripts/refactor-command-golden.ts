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
import { commandMirrors } from '../src/commands.ts'

type GoldenCase = {
  slash: string
  args?: string[]
  env?: Record<string, string>
  unsetEnv?: string[]
  setupFiles?: Record<string, string>
  expectedIncludes?: string[]
  expectedStdoutIncludes?: string[]
  expectedStdoutExcludes?: string[]
  expectedStderrIncludes?: string[]
  expectedStderrExcludes?: string[]
  expectedCombinedIncludes?: string[]
  expectedCombinedExcludes?: string[]
  expectedErrorIncludes?: string[]
  expectedExitCode?: number
  expectedExitRequested?: boolean
  expectedAdditionalDirectories?: string[]
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
  cases: GoldenCase[]
}

type WritableCapture = {
  data: string
  write(chunk: string | Uint8Array): void
}

const fixturePath =
  process.argv[2] ?? 'docs/refactor/golden/commands/r1.3-native-command-golden.json'
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFile
const bySlash = new Map(commandMirrors.map(command => [command.slash, command]))
const failures: Array<{
  slash: string
  args: string[]
  missing?: string[]
  unexpected?: string[]
  error?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  exitRequested?: boolean
  additionalDirectories?: string[]
}> = []

for (const item of fixture.cases) {
  const command = bySlash.get(item.slash)
  const cwd = mkdtempSync(join(tmpdir(), 'my-claude-command-golden-'))
  const originalEnv = new Map<string, string | undefined>()
  const stdout: WritableCapture = {
    data: '',
    write(chunk) {
      this.data += String(chunk)
    },
  }
  const stderr: WritableCapture = {
    data: '',
    write(chunk) {
      this.data += String(chunk)
    },
  }

  try {
    for (const [relativePath, content] of Object.entries(item.setupFiles ?? {})) {
      const target = join(cwd, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    for (const key of item.unsetEnv ?? []) {
      originalEnv.set(key, process.env[key])
      delete process.env[key]
    }
    for (const [key, value] of Object.entries(item.env ?? {})) {
      originalEnv.set(key, process.env[key])
      process.env[key] = value
    }
    if (!command) {
      failures.push({
        slash: item.slash,
        args: item.args ?? [],
        error: 'command mirror not registered',
      })
      continue
    }
    let result = { exitRequested: false, additionalDirectories: undefined as string[] | undefined }
    let errorMessage: string | undefined
    let exitCode = 0
    try {
      result = await command.run({
        io: { stdout, stderr },
        cwd,
        version: 'golden',
        args: item.args ?? [],
        options: {
          model: 'deepseek-v4-flash',
          permissionMode: 'default',
          additionalDirectories: [],
        },
      })
    } catch (error) {
      exitCode = 1
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    const normalizedStdout = normalizeOutput(stdout.data, cwd)
    const normalizedStderr = normalizeOutput(stderr.data, cwd)
    const normalizedCombined = `${normalizedStdout}${normalizedStderr}`
    const missing = [
      ...missingIncludes(normalizedCombined, item.expectedIncludes ?? []),
      ...missingIncludes(normalizedCombined, item.expectedCombinedIncludes ?? []),
      ...missingIncludes(normalizedStdout, item.expectedStdoutIncludes ?? []),
      ...missingIncludes(normalizedStderr, item.expectedStderrIncludes ?? []),
      ...missingIncludes(errorMessage ?? '', item.expectedErrorIncludes ?? []),
    ]
    const unexpected = [
      ...unexpectedIncludes(normalizedCombined, item.expectedCombinedExcludes ?? []),
      ...unexpectedIncludes(normalizedStdout, item.expectedStdoutExcludes ?? []),
      ...unexpectedIncludes(normalizedStderr, item.expectedStderrExcludes ?? []),
    ]
    if (item.expectedExitCode !== undefined && item.expectedExitCode !== exitCode) {
      missing.push(`exitCode=${item.expectedExitCode}`)
    }
    if (item.expectedExitRequested !== undefined && item.expectedExitRequested !== result.exitRequested) {
      missing.push(`exitRequested=${item.expectedExitRequested}`)
    }
    if (
      item.expectedAdditionalDirectories &&
      JSON.stringify(item.expectedAdditionalDirectories) !== JSON.stringify(result.additionalDirectories ?? [])
    ) {
      missing.push(`additionalDirectories=${JSON.stringify(item.expectedAdditionalDirectories)}`)
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
      const content = normalizeOutput(readFileSync(path, 'utf8'), cwd)
      missing.push(...missingIncludes(content, file.includes ?? []).map(value => `${file.path}: ${value}`))
      unexpected.push(...unexpectedIncludes(content, file.excludes ?? []).map(value => `${file.path}: ${value}`))
    }
    if (errorMessage && (item.expectedErrorIncludes ?? []).length === 0) {
      failures.push({
        slash: item.slash,
        args: item.args ?? [],
        error: errorMessage,
        stdout: normalizedStdout.slice(0, 2000),
        stderr: normalizedStderr.slice(0, 2000),
        exitCode,
      })
      continue
    }
    if (missing.length > 0 || unexpected.length > 0) {
      failures.push({
        slash: item.slash,
        args: item.args ?? [],
        missing,
        unexpected,
        stdout: normalizedStdout.slice(0, 2000),
        stderr: normalizedStderr.slice(0, 2000),
        exitCode,
        exitRequested: result.exitRequested,
        additionalDirectories: result.additionalDirectories,
      })
    }
  } catch (error) {
    failures.push({
      slash: item.slash,
      args: item.args ?? [],
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    for (const [key, value] of originalEnv.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(cwd, { recursive: true, force: true })
  }
}

const report = {
  fixture: fixturePath,
  status: failures.length > 0 ? 'fail' : 'pass',
  cases: fixture.cases.length,
  failures,
}

console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) {
  process.exit(1)
}

function normalizeOutput(output: string, cwd: string): string {
  return output
    .replaceAll(cwd, '<cwd>')
    .replaceAll(/session_[0-9a-f-]+/g, 'session_<id>')
    .replaceAll(/[0-9a-f]{64}/g, '<sha256>')
}

function missingIncludes(output: string, expected: string[]): string[] {
  return expected.filter(value => !output.includes(value))
}

function unexpectedIncludes(output: string, denied: string[]): string[] {
  return denied.filter(value => output.includes(value))
}
