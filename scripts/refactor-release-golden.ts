import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBootstrapState } from '../src/bootstrap/state.js'
import {
  migrateBypassPermissionsAcceptedToSettings,
  migrateSonnet45ToSonnet46,
} from '../src/migrations/index.js'
import { buildFileIndex } from '../src/native-ts/file-index/index.js'
import { evaluatePolicyLimit } from '../src/services/policyLimits/index.js'
import { trackDiagnostic } from '../src/services/diagnosticTracking.js'
import { createLangfuseTrace } from '../src/services/langfuse/index.js'
import { createPerfettoInstant } from '../src/utils/telemetry/perfettoTracing.js'
import { AsyncHookRegistry } from '../src/utils/hooks/AsyncHookRegistry.js'

type ReleaseGolden = {
  version: string
  cases: Array<{
    name: string
    expect: Record<string, unknown>
  }>
}

type GoldenFailure = {
  caseName: string
  reason: string
}

const fixturePath = 'docs/refactor/golden/release/r2.1-control-release-golden.json'
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as ReleaseGolden
const failures: GoldenFailure[] = []

for (const testCase of fixture.cases) {
  try {
    switch (testCase.name) {
      case 'hook-ordering':
        await verifyHookOrdering(testCase.expect)
        break
      case 'telemetry-redaction':
        verifyTelemetryRedaction(testCase.expect)
        break
      case 'policy-deny':
        verifyPolicyDeny(testCase.expect)
        break
      case 'release-smoke':
        verifyReleaseSmoke(testCase.expect)
        break
      default:
        failures.push({ caseName: testCase.name, reason: 'unknown R2.1 golden case' })
    }
  } catch (error) {
    failures.push({
      caseName: testCase.name,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

console.log(JSON.stringify({
  fixture: fixturePath,
  status: failures.length === 0 ? 'pass' : 'fail',
  cases: fixture.cases.length,
  failures,
}, null, 2))

if (failures.length > 0) {
  process.exit(1)
}
process.exit(0)

async function verifyHookOrdering(expect: Record<string, unknown>): Promise<void> {
  const calls: string[] = []
  const registry = new AsyncHookRegistry()
  registry.register({
    id: 'blocker',
    event: 'PreToolUse',
    order: 2,
    run: () => {
      calls.push('blocker')
      return { decision: 'block', reason: 'blocked by golden' }
    },
  })
  registry.register({
    id: 'first',
    event: 'PreToolUse',
    order: 1,
    run: () => {
      calls.push('first')
      return { decision: 'allow' }
    },
  })
  registry.register({
    id: 'after',
    event: 'PreToolUse',
    order: 3,
    run: () => {
      calls.push('after')
      return { decision: 'allow' }
    },
  })
  const results = await registry.run('PreToolUse', { cwd: process.cwd(), toolName: 'Bash' })
  assertJsonEqual(calls, expect.results, 'results')
  assertEqual(results.at(-1)?.decision, expect.finalDecision, 'finalDecision')
}

function verifyTelemetryRedaction(expect: Record<string, unknown>): void {
  const diagnostic = trackDiagnostic('startup', { apiKey: 'secret-value' })
  assertEqual(diagnostic.name, expect.eventName, 'eventName')
  assertEqual((diagnostic.attributes.apiKey as { redacted?: boolean }).redacted, expect.redacted, 'redacted')
  assertEqual(createPerfettoInstant('startup').ph, expect.perfettoPh, 'perfettoPh')
  assertEqual(createLangfuseTrace('completion', { token: 'secret' }).name, expect.langfuseName, 'langfuseName')
}

function verifyPolicyDeny(expect: Record<string, unknown>): void {
  const decision = evaluatePolicyLimit([
    { name: 'managed-deny', deny: ['Bash(*)'] },
  ], 'Bash(*)')
  assertEqual(decision.decision, expect.decision, 'decision')
  assertEqual(decision.rule, expect.rule, 'rule')
}

function verifyReleaseSmoke(expect: Record<string, unknown>): void {
  const bootstrap = createBootstrapState({
    version: '1.0.0',
    cwd: process.cwd(),
    terminalSetup: true,
    updateAvailable: false,
  })
  assertEqual(bootstrap.terminalSetup, expect.terminalSetup, 'terminalSetup')

  const migratedPermissions = migrateBypassPermissionsAcceptedToSettings({
    bypassPermissionsAccepted: true,
  })
  assertEqual(migratedPermissions.permissionMode, expect.migratedPermissionMode, 'migratedPermissionMode')

  const migratedModel = migrateSonnet45ToSonnet46({
    model: 'sonnet-4.5',
    enableSonnet46: true,
  })
  assertEqual(migratedModel.model, expect.migratedModel, 'migratedModel')

  const dir = mkdtempSync(join(tmpdir(), 'r2-1-release-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    assertAtLeast(buildFileIndex(dir).length, Number(expect.fileIndexAtLeast), 'fileIndexAtLeast')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertAtLeast(actual: number, expected: number, label: string): void {
  if (actual < expected) {
    throw new Error(`${label}: expected at least ${expected}, got ${actual}`)
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
