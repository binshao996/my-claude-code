import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

type FixtureCoverage = {
  upstream: string
  local: string
  status: 'byte-identical-upstream-test'
  sha256: string
}

type UpstreamTestExecution = {
  command: string
  status: 'pass' | 'fail' | 'not-run'
  exitCode: number | null
  pass: number
  fail: number
  errors: number
  files: number
  duration: string | null
  logPath: string
}

type FixtureMigrationReport = {
  version: 'r2.7'
  generatedAt: string
  status: 'pass' | 'fail'
  upstreamFixtureCount: number
  byteIdenticalFixtureCount: number
  executedFixtureCount: number
  missingExecutionCount: number
  nonDefaultFixtureCount: number
  missingFixtureCount: number
  mismatchedFixtureCount: number
  goldenSubstituteCount: 0
  execution: UpstreamTestExecution
  coverage: FixtureCoverage[]
  missingExecution: string[]
  nonDefaultFixtures: string[]
  missing: string[]
  mismatched: string[]
}

const cwd = process.cwd()
const shouldWrite = process.argv.includes('--write')
const reportPath = 'docs/refactor/fixture-migration-report.json'
const executionReportPath = 'docs/refactor/r2.7-upstream-test-execution-report.json'
const executionLogPath = '/tmp/r2.7-upstream-mirror-test.log'
const upstreamTestCommand = 'bun run test:upstream-fixtures'

const upstreamFixtures = [
  ...listFiles('claude-code/src', isBunDiscoveredTestFile),
  ...listFiles('claude-code/packages', isBunDiscoveredTestFile),
  ...listFiles('claude-code/tests', isBunDiscoveredTestFile),
].sort()
const nonDefaultFixtures = [
  ...listFiles('claude-code/src', isNonDefaultTestSupportFile),
  ...listFiles('claude-code/packages', isNonDefaultTestSupportFile),
  ...listFiles('claude-code/tests', isNonDefaultTestSupportFile),
].sort()

const coverage: FixtureCoverage[] = []
const missing: string[] = []
const mismatched: string[] = []

for (const upstream of upstreamFixtures) {
  const local = upstream.replace(/^claude-code\//, '')
  const upstreamAbsolute = join(cwd, upstream)
  const localAbsolute = join(cwd, local)
  if (!existsSync(localAbsolute)) {
    missing.push(upstream)
    continue
  }
  const upstreamHash = sha256(upstreamAbsolute)
  const localHash = sha256(localAbsolute)
  if (upstreamHash !== localHash) {
    mismatched.push(upstream)
    continue
  }
  coverage.push({
    upstream,
    local,
    status: 'byte-identical-upstream-test',
    sha256: upstreamHash,
  })
}

const execution = readExecutionReport()
const executedFiles = readExecutedFiles()
const missingExecution = upstreamFixtures
  .map(upstream => upstream.replace(/^claude-code\//, ''))
  .filter(local => !executedFiles.has(local))
const status =
  missing.length === 0 &&
  mismatched.length === 0 &&
  missingExecution.length === 0 &&
  execution.status === 'pass'
    ? 'pass'
    : 'fail'
const report: FixtureMigrationReport = {
  version: 'r2.7',
  generatedAt: new Date().toISOString(),
  status,
  upstreamFixtureCount: upstreamFixtures.length,
  byteIdenticalFixtureCount: coverage.length,
  executedFixtureCount: upstreamFixtures.length - missingExecution.length,
  missingExecutionCount: missingExecution.length,
  nonDefaultFixtureCount: nonDefaultFixtures.length,
  missingFixtureCount: missing.length,
  mismatchedFixtureCount: mismatched.length,
  goldenSubstituteCount: 0,
  execution,
  coverage,
  missingExecution,
  nonDefaultFixtures,
  missing,
  mismatched,
}

if (shouldWrite) {
  writeJson(reportPath, report)
  writeJson(executionReportPath, execution)
}

console.log(JSON.stringify({
  status,
  upstreamFixtureCount: report.upstreamFixtureCount,
  byteIdenticalFixtureCount: report.byteIdenticalFixtureCount,
  executedFixtureCount: report.executedFixtureCount,
  missingExecutionCount: report.missingExecutionCount,
  nonDefaultFixtureCount: report.nonDefaultFixtureCount,
  missingFixtureCount: report.missingFixtureCount,
  mismatchedFixtureCount: report.mismatchedFixtureCount,
  goldenSubstituteCount: report.goldenSubstituteCount,
  execution: report.execution,
  reportPath,
  executionReportPath,
}, null, 2))

if (status !== 'pass') {
  process.exit(1)
}

function readExecutionReport(): UpstreamTestExecution {
  if (!existsSync(executionLogPath)) {
    return {
      command: upstreamTestCommand,
      status: 'not-run',
      exitCode: null,
      pass: 0,
      fail: 0,
      errors: 0,
      files: 0,
      duration: null,
      logPath: executionLogPath,
    }
  }
  const log = readFileSync(executionLogPath, 'utf8')
  const pass = sumMatches(log, /\n\s*(\d+)\s+pass\b/g)
  const fail = sumMatches(log, /\n\s*(\d+)\s+fail\b/g)
  const errors = sumMatches(log, /\n\s*(\d+)\s+errors\b/g)
  const runs = Array.from(log.matchAll(/Ran\s+\d+\s+tests?\s+across\s+(\d+)\s+files?\.\s+\[([^\]]+)\]/g))
  const files = runs.reduce((total, match) => total + Number(match[1] ?? 0), 0)
  const duration = runs.length === 0 ? null : runs.map(match => match[2]).join(' + ')
  return {
    command: upstreamTestCommand,
    status: fail === 0 && errors === 0 && files > 0 ? 'pass' : 'fail',
    exitCode: fail === 0 && errors === 0 && files > 0 ? 0 : 1,
    pass,
    fail,
    errors,
    files,
    duration,
    logPath: executionLogPath,
  }
}

function readExecutedFiles(): Set<string> {
  if (!existsSync(executionLogPath)) {
    return new Set()
  }
  const log = readFileSync(executionLogPath, 'utf8')
  return new Set(
    Array.from(log.matchAll(/\n((?:src|packages|tests)\/[^:\n]+):\n/g))
      .map(match => match[1]!)
      .sort(),
  )
}

function sumMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).reduce(
    (total, match) => total + Number(match[1] ?? 0),
    0,
  )
}

function isBunDiscoveredTestFile(path: string): boolean {
  return isBunTestFile(path)
}

function isNonDefaultTestSupportFile(path: string): boolean {
  return path.includes('/__tests__/') && !isBunTestFile(path)
}

function isBunTestFile(path: string): boolean {
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.spec.tsx') ||
    path.includes('_test_') ||
    path.includes('_spec_')
  )
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

function walk(dir: string, output: string[], predicate: (path: string) => boolean): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'coverage') {
      continue
    }
    const path = join(dir, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      walk(path, output, predicate)
      continue
    }
    if (info.isFile() && predicate(normalizePath(relative(cwd, path)))) {
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

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true })
  writeFileSync(join(cwd, path), value)
}
