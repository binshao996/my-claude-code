import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runToolUse } from './runner.js'
import {
  captureTerminal,
  connectRemote,
  detachRemote,
  getRemoteTools,
  heartbeatDaemon,
  kickBridge,
  readPipeEndpoints,
  readBridgeEvents,
  readDaemonState,
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
} from './remote.js'

describe('V0.8 remote, bridge, daemon, and SSH MVP tools', () => {
  it('records daemon lifecycle through bridge events', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v08-'))

    try {
      await startDaemon(cwd)
      expect(await readDaemonState(cwd)).toMatchObject({
        status: 'running',
        endpoint: 'loopback://my-claude-code-daemon',
        lockPath: expect.stringContaining('daemon.lock'),
      })
      await heartbeatDaemon(cwd)
      await kickBridge(cwd, 'test-reconnect')

      await stopDaemon(cwd)
      expect(await readDaemonState(cwd)).toMatchObject({
        status: 'stopped',
        reconnectCount: 1,
      })
      expect((await readBridgeEvents(cwd)).map(event => event.type)).toEqual([
        'daemon.start',
        'daemon.heartbeat',
        'daemon.reconnect',
        'bridge.kick',
        'daemon.stop',
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('connects, runs, detaches, resumes, and captures a loopback remote session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v08-'))

    try {
      const session = await connectRemote(cwd, {
        name: 'local-fixture',
        transport: 'loopback',
      })
      const result = await runRemoteCommand(cwd, {
        sessionId: session.id,
        command: process.execPath,
        args: ['-e', 'console.log("remote-ready")'],
      })

      expect(result).toMatchObject({
        exitCode: 0,
        status: 'completed',
      })
      expect(result.stdout).toContain('remote-ready')

      await detachRemote(cwd, session.id)
      await expect(
        runRemoteCommand(cwd, {
          sessionId: session.id,
          command: process.execPath,
          args: ['-e', 'console.log("detached")'],
        }),
      ).rejects.toThrow('remote session is detached')

      await resumeRemote(cwd, session.id)
      expect(await captureTerminal(cwd, { sessionId: session.id, lines: 2 })).toMatchObject({
        sessionId: session.id,
        lines: expect.any(Array),
      })
      expect(await readRemoteSessions(cwd)).toEqual([
        expect.objectContaining({
          id: session.id,
          status: 'connected',
          lastCommand: expect.objectContaining({
            exitCode: 0,
          }),
        }),
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prepares remote setup state and local pipe IPC endpoints', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v08-'))

    try {
      const setup = await setupRemote(cwd, { name: 'fixture' })
      expect(setup).toMatchObject({
        status: 'ready',
        supportedTransports: expect.arrayContaining([
          'loopback',
          'ssh',
          'ssh-mock',
          'websocket-bridge',
          'sse-bridge',
          'hybrid-bridge',
          'pipe-ipc',
          'lan-pipe',
          'uds-inbox',
          'acp-jsonl',
        ]),
      })
      expect(await readDaemonState(cwd)).toMatchObject({
        status: 'running',
      })

      const endpoint = await registerPipeEndpoint(cwd, {
        name: 'main',
        role: 'master',
      })
      expect(endpoint).toMatchObject({
        name: 'main',
        role: 'master',
        status: 'listening',
        messageCount: 0,
      })

      const message = await sendPipeMessage(cwd, {
        targetName: 'main',
        body: 'hello pipe',
        from: 'test',
        type: 'chat',
      })
      expect(message).toMatchObject({
        targetName: 'main',
        body: 'hello pipe',
        from: 'test',
      })
      expect(await readPipeEndpoints(cwd)).toEqual([
        expect.objectContaining({
          name: 'main',
          messageCount: 1,
        }),
      ])
      expect((await readBridgeEvents(cwd)).map(event => event.type)).toEqual([
        'daemon.start',
        'remote.setup',
        'pipe.register',
        'pipe.send',
      ])
      expect(JSON.stringify(await readBridgeEvents(cwd))).not.toContain('hello pipe')

      const lanEndpoint = await registerLanPipeEndpoint(cwd, {
        name: 'lan-main',
        host: '192.0.2.10',
        port: 4488,
        role: 'sub',
      })
      expect(lanEndpoint).toMatchObject({
        name: 'lan-main',
        address: 'tcp://192.0.2.10:4488',
        transport: 'lan',
        role: 'sub',
      })
      expect((await readBridgeEvents(cwd)).at(-1)).toMatchObject({
        type: 'pipe.lan.register',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('supports SSH mock transport without requiring a real SSH host', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v08-'))

    try {
      const session = await connectRemote(cwd, {
        transport: 'ssh-mock',
        host: 'fixture.example',
      })
      const result = await runRemoteCommand(cwd, {
        sessionId: session.id,
        command: 'uname',
        args: ['-a'],
      })

      expect(result.stdout).toContain('[ssh-mock fixture.example] uname -a')
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs the real SSH transport through an ssh-compatible subprocess boundary', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v15-'))
    const sshFixture = join(cwd, 'ssh-fixture.mjs')

    try {
      writeFileSync(
        sshFixture,
        [
          'const [, , host, command] = process.argv',
          'console.log(JSON.stringify({ host, command }))',
        ].join('\n'),
        'utf8',
      )
      const session = await connectRemote(cwd, {
        transport: 'ssh',
        host: 'fixture.example',
        sshCommand: process.execPath,
        sshArgs: [sshFixture],
      })
      const result = await runRemoteCommand(cwd, {
        sessionId: session.id,
        command: 'printf',
        args: ['hello'],
      })

      expect(result.status).toBe('completed')
      expect(JSON.parse(result.stdout)).toMatchObject({
        host: 'fixture.example',
      })
      expect(JSON.parse(result.stdout).command).toContain('printf')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('serves a real remote-control HTTP/SSE bridge and accepts bridge posts', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v15-'))
    let server: Awaited<ReturnType<typeof startRemoteControlServer>> | undefined

    try {
      server = await startRemoteControlServer(cwd)
      const health = await fetch(`${server.url}/health`).then(response => response.json())
      expect(health).toMatchObject({
        daemon: { status: 'running' },
        sessions: [],
      })

      const event = await fetch(`${server.url}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: 'ping', payload: 'secret-body' }),
      }).then(response => response.json())
      expect(event).toMatchObject({
        event: {
          type: 'remote.trigger',
          payload: { transport: 'http-bridge' },
        },
      })
      expect(JSON.stringify(await readBridgeEvents(cwd))).not.toContain('secret-body')

      const workerEvent = await fetch(`${server.url}/worker/events`, {
        method: 'POST',
        body: JSON.stringify({ type: 'worker', payload: 'worker-secret' }),
      }).then(response => response.json())
      expect(workerEvent).toMatchObject({
        event: {
          type: 'remote.trigger',
          payload: { transport: 'http-bridge' },
        },
      })
      expect(JSON.stringify(await readBridgeEvents(cwd))).not.toContain('worker-secret')
    } finally {
      await server?.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('opens a real local TCP LAN pipe and delivers messages over the socket', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v15-'))

    try {
      const endpoint = await registerLanPipeEndpoint(cwd, {
        name: 'tcp-main',
        host: '127.0.0.1',
        port: 0,
      })
      expect(endpoint).toMatchObject({
        name: 'tcp-main',
        transport: 'lan',
        host: '127.0.0.1',
      })
      expect(endpoint.port).toBeGreaterThan(0)

      await expect(sendPipeMessage(cwd, {
        targetName: 'tcp-main',
        body: 'hello over tcp',
        from: 'test',
      })).resolves.toMatchObject({
        targetName: 'tcp-main',
      })
      expect((await readPipeEndpoints(cwd))[0]).toMatchObject({
        name: 'tcp-main',
        messageCount: 1,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('opens a real UDS inbox and receives socket messages', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v15-'))

    try {
      const inbox = await startUdsInbox(cwd, { name: 'main' })
      expect(inbox).toMatchObject({
        name: 'main',
        status: 'listening',
      })
      await sendUdsInboxMessage(cwd, {
        name: 'main',
        body: 'hello uds',
      })
      await waitFor(async () => (await readUdsInboxes(cwd))[0]?.messageCount === 1)
      expect(await readUdsInboxes(cwd)).toEqual([
        expect.objectContaining({
          name: 'main',
          messageCount: 1,
        }),
      ])
      expect((await readBridgeEvents(cwd)).map(event => event.type)).toContain('uds.inbox.message')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('stores remote env hashes and never persists raw values', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v15-'))

    try {
      await setRemoteEnv(cwd, {
        name: 'REMOTE_TOKEN',
        value: 'super-secret',
      })
      const records = await readRemoteEnv(cwd)
      expect(records).toEqual([
        expect.objectContaining({
          name: 'REMOTE_TOKEN',
          source: 'manual',
          valueHash: expect.any(String),
        }),
      ])
      expect(JSON.stringify(records)).not.toContain('super-secret')
      expect(JSON.stringify(await readBridgeEvents(cwd))).not.toContain('super-secret')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('blocks dangerous commands and remote path escapes by default', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v08-'))

    try {
      const session = await connectRemote(cwd, {
        transport: 'loopback',
      })

      await expect(
        runRemoteCommand(cwd, {
          sessionId: session.id,
          command: 'rm',
          args: ['-rf', '.'],
        }),
      ).rejects.toThrow('dangerous remote command requires confirmation')

      await expect(
        runRemoteCommand(cwd, {
          sessionId: session.id,
          command: process.execPath,
          args: ['-e', 'console.log("escape")'],
          path: '..',
        }),
      ).rejects.toThrow('remote path escapes session root')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('redacts session token material from remote transcripts and bridge events', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v08-'))

    try {
      const session = await connectRemote(cwd, {
        transport: 'loopback',
        token: 'secret-session-token',
      })
      const transcript = readFileSync(session.transcriptPath, 'utf8')
      const bridge = JSON.stringify(await readBridgeEvents(cwd))

      expect(transcript).not.toContain('secret-session-token')
      expect(bridge).not.toContain('secret-session-token')
      expect(bridge).not.toContain(session.tokenHash)
      expect(bridge).toContain('<redacted>')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('registers V0.8 tools and denies dangerous RemoteRun in headless mode', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v08-'))

    try {
      const connect = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_remote_connect',
          name: 'RemoteConnect',
          input: { transport: 'loopback' },
        },
        getRemoteTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      const session = JSON.parse(connect.content) as { id: string }

      const denied = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_remote_run',
          name: 'RemoteRun',
          input: {
            sessionId: session.id,
            command: 'sudo',
            args: ['whoami'],
          },
        },
        getRemoteTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )

      expect(denied.is_error).toBe(true)
      expect(denied.content).toContain('dangerous remote command requires confirmation')

      const setup = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_remote_setup',
          name: 'RemoteSetup',
          input: {},
        },
        getRemoteTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(setup.content).toContain('"lan-pipe"')

      const pipe = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_pipe_register',
          name: 'PipeRegister',
          input: { name: 'agent', role: 'sub' },
        },
        getRemoteTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(pipe.content).toContain('"name": "agent"')

      const lanPipe = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_lan_pipe_register',
          name: 'LanPipeRegister',
          input: { name: 'lan-agent', host: '192.0.2.20', port: 4490 },
        },
        getRemoteTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(lanPipe.content).toContain('"transport": "lan"')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

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
