import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acpPermissionMessage,
  acpPromptMessage,
  acpResultMessage,
  acpSessionStartMessage,
  createAcpLinkSession,
  decodeAcpJsonl,
  encodeAcpJsonl,
} from '../packages/acp-link/src/index.js'
import {
  captureTerminal,
  connectRemote,
  detachRemote,
  heartbeatDaemon,
  kickBridge,
  readBridgeEvents,
  readDaemonState,
  readPipeEndpoints,
  readRemoteEnv,
  readRemoteSessions,
  readUdsInboxes,
  registerLanPipeEndpoint,
  registerPipeEndpoint,
  resumeRemote,
  runRemoteCommand,
  sendPipeMessage,
  sendUdsInboxMessage,
  setRemoteEnv,
  setupRemote,
  startDaemon,
  startRemoteControlServer,
  startUdsInbox,
  stopDaemon,
} from '../packages/tools/src/remote.js'

type RemoteGolden = {
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

const fixturePath = 'docs/refactor/golden/transports/r1.9-remote-bridge-acp-golden.json'
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as RemoteGolden
const failures: GoldenFailure[] = []

for (const testCase of fixture.cases) {
  try {
    switch (testCase.name) {
      case 'daemon-bridge-lifecycle':
        await verifyDaemonBridgeLifecycle(testCase.expect)
        break
      case 'remote-session-runner':
        await verifyRemoteSessionRunner(testCase.expect)
        break
      case 'remote-control-http-sse':
        await verifyRemoteControlHttpSse(testCase.expect)
        break
      case 'pipe-uds-env':
        await verifyPipeUdsEnv(testCase.expect)
        break
      case 'acp-jsonl-protocol':
        verifyAcpJsonlProtocol(testCase.expect)
        break
      default:
        failures.push({ caseName: testCase.name, reason: 'unknown R1.9 golden case' })
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

async function verifyDaemonBridgeLifecycle(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-9-daemon-'))
  try {
    await startDaemon(cwd)
    await heartbeatDaemon(cwd)
    await kickBridge(cwd, 'golden')
    await stopDaemon(cwd)

    const daemon = await readDaemonState(cwd)
    assertEqual(daemon.status, expect.daemonStatus, 'daemonStatus')
    assertEqual(daemon.reconnectCount, expect.reconnectCount, 'reconnectCount')
    assertJsonEqual((await readBridgeEvents(cwd)).map(event => event.type), expect.events, 'events')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function verifyRemoteSessionRunner(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-9-remote-session-'))
  try {
    const session = await connectRemote(cwd, {
      name: 'local-fixture',
      transport: 'loopback',
    })
    assertEqual(session.transport, expect.transport, 'transport')
    const result = await runRemoteCommand(cwd, {
      sessionId: session.id,
      command: process.execPath,
      args: ['-e', 'console.log("remote-ready")'],
    })
    assertEqual(result.stdout.includes(String(expect.stdoutIncludes)), true, 'stdoutIncludes')
    await detachRemote(cwd, session.id)
    await runRemoteCommand(cwd, {
      sessionId: session.id,
      command: process.execPath,
      args: ['-e', 'console.log("detached")'],
    }).then(
      () => {
        throw new Error('expected detached remote run to fail')
      },
      error => {
        assertEqual(
          error instanceof Error && error.message.includes(String(expect.detachedError)),
          true,
          'detachedError',
        )
      },
    )
    await resumeRemote(cwd, session.id)
    const capture = await captureTerminal(cwd, { sessionId: session.id, lines: 2 })
    assertAtLeast(capture.lines.length, Number(expect.terminalLinesAtLeast), 'terminalLinesAtLeast')
    assertEqual((await readRemoteSessions(cwd))[0]?.status, expect.finalStatus, 'finalStatus')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function verifyRemoteControlHttpSse(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-9-remote-control-'))
  let server: Awaited<ReturnType<typeof startRemoteControlServer>> | undefined
  try {
    server = await startRemoteControlServer(cwd)
    const health = await fetch(`${server.url}/health`).then(response => response.json()) as {
      daemon?: { status?: string }
    }
    assertEqual(health.daemon?.status, expect.healthStatus, 'healthStatus')
    const post = await fetch(`${server.url}/worker/events`, {
      method: 'POST',
      body: 'secret-body',
    }).then(response => response.json()) as {
      event?: { type?: string; payload?: { transport?: string } }
    }
    assertEqual(post.event?.type, expect.postEventType, 'postEventType')
    assertEqual(post.event?.payload?.transport, expect.transport, 'transport')
    assertEqual(JSON.stringify(await readBridgeEvents(cwd)).includes('secret-body'), false, 'redactsBody')
  } finally {
    await server?.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function verifyPipeUdsEnv(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-9-pipe-uds-'))
  try {
    const setup = await setupRemote(cwd, { name: 'fixture' })
    assertEqual(setup.status, expect.setupStatus, 'setupStatus')

    await registerPipeEndpoint(cwd, { name: 'main', role: 'master' })
    await sendPipeMessage(cwd, { targetName: 'main', body: 'hello pipe', from: 'golden' })
    assertEqual((await readPipeEndpoints(cwd))[0]?.messageCount, expect.pipeMessageCount, 'pipeMessageCount')

    const lan = await registerLanPipeEndpoint(cwd, {
      name: 'lan-main',
      host: '127.0.0.1',
      port: 0,
    })
    assertEqual(lan.transport, expect.lanTransport, 'lanTransport')

    await startUdsInbox(cwd, { name: 'main' })
    await sendUdsInboxMessage(cwd, { name: 'main', body: 'hello uds' })
    await waitFor(async () => (await readUdsInboxes(cwd))[0]?.messageCount === 1)
    assertEqual((await readUdsInboxes(cwd))[0]?.messageCount, expect.udsMessageCount, 'udsMessageCount')

    await setRemoteEnv(cwd, { name: 'REMOTE_TOKEN', value: 'super-secret' })
    const env = await readRemoteEnv(cwd)
    assertEqual(env[0]?.name, expect.envName, 'envName')
    assertEqual(JSON.stringify(env).includes('super-secret'), false, 'redactsEnvValue')
    assertEqual(JSON.stringify(await readBridgeEvents(cwd)).includes('super-secret'), false, 'redactsBridgeEnvValue')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function verifyAcpJsonlProtocol(expect: Record<string, unknown>): void {
  const session = createAcpLinkSession({
    cwd: '/tmp/workspace',
    token: 'secret-acp-token',
    now: new Date('2026-05-25T00:00:00.000Z'),
  })
  const jsonl = encodeAcpJsonl([
    acpSessionStartMessage(session),
    acpPromptMessage(session.sessionId, 'hello'),
    acpPermissionMessage({
      sessionId: session.sessionId,
      toolName: 'Read',
      decision: 'allow',
    }),
    acpResultMessage({
      sessionId: session.sessionId,
      status: 'ok',
      content: 'done',
    }),
  ])
  const messages = decodeAcpJsonl(jsonl)
  assertJsonEqual(messages.map(message => message.type), expect.messageTypes, 'messageTypes')
  const permission = messages.find(message => message.type === 'tool.permission')
  const result = messages.find(message => message.type === 'result')
  assertEqual(permission?.type === 'tool.permission' ? permission.decision : undefined, expect.permissionDecision, 'permissionDecision')
  assertEqual(result?.type === 'result' ? result.status : undefined, expect.resultStatus, 'resultStatus')
  assertEqual(jsonl.includes('secret-acp-token'), false, 'redactsToken')
  assertEqual(session.tokenHash.length > 0, true, 'tokenHash')
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now()
  while (!(await check())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function assertEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assertAtLeast(actual: number, expected: number, field: string): void {
  if (actual < expected) {
    throw new Error(`${field}: expected at least ${expected}, got ${actual}`)
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, field: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${field}: expected ${expectedJson}, got ${actualJson}`)
  }
}
