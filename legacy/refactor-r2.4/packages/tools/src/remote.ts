import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises'
import {
  connect as connectSocket,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net'
import {
  dirname,
  join,
  resolve,
  sep,
} from 'node:path'
import { promisify } from 'node:util'
import { startRemoteControlServerRuntime } from '@my-claude-code/remote-control-server'
import { z } from 'zod/v4'
import type {
  PermissionMode,
  Tool,
} from './types.js'

const execFileAsync = promisify(execFile)
const lanPipeServers = new Map<string, NetServer>()
const udsInboxServers = new Map<string, NetServer>()

export type DaemonStatus = 'running' | 'stopped'

export type DaemonState = {
  status: DaemonStatus
  pid?: number
  endpoint?: string
  bridgePath: string
  lockPath?: string
  heartbeatAt?: string
  reconnectCount?: number
  startedAt?: string
  stoppedAt?: string
  updatedAt: string
}

export type BridgeEventType =
  | 'daemon.start'
  | 'daemon.heartbeat'
  | 'daemon.reconnect'
  | 'daemon.stop'
  | 'bridge.kick'
  | 'remote.setup'
  | 'remote.connect'
  | 'remote.env'
  | 'remote.run'
  | 'remote.detach'
  | 'remote.resume'
  | 'remote.trigger'
  | 'pipe.register'
  | 'pipe.lan.register'
  | 'pipe.send'
  | 'uds.inbox.start'
  | 'uds.inbox.message'
  | 'terminal.capture'

export type BridgeEvent = {
  id: string
  type: BridgeEventType
  sessionId?: string
  createdAt: string
  payload: Record<string, unknown>
}

export type RemoteTransport = 'loopback' | 'ssh-mock' | 'ssh'
export type RemoteSessionStatus = 'connected' | 'detached' | 'closed'

export type RemoteSession = {
  id: string
  name: string
  transport: RemoteTransport
  host?: string
  sshCommand?: string
  sshArgs?: string[]
  root: string
  status: RemoteSessionStatus
  tokenHash: string
  transcriptPath: string
  createdAt: string
  updatedAt: string
  attachedAt?: string
  detachedAt?: string
  lastCommand?: {
    command: string
    args: string[]
    exitCode: number
    ranAt: string
  }
}

export type RemoteCommandResult = {
  sessionId: string
  command: string
  args: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  status: 'completed' | 'failed'
}

export type RemoteSetupReport = {
  status: 'ready'
  cwd: string
  daemon: DaemonState
  bridgePath: string
  setupPath: string
  supportedTransports: Array<RemoteTransport | 'pipe-ipc' | 'lan-pipe' | 'uds-inbox' | 'websocket-bridge' | 'sse-bridge' | 'hybrid-bridge' | 'acp-jsonl'>
  commands: string[]
  warnings: string[]
  updatedAt: string
}

export type RemoteEnvRecord = {
  name: string
  valueHash: string
  source: 'manual' | 'inherited'
  updatedAt: string
}

export type RemoteControlServerHandle = {
  url: string
  close(): Promise<void>
}

export type UdsInbox = {
  name: string
  address: string
  status: 'listening' | 'closed'
  messageCount: number
  createdAt: string
  updatedAt: string
}

export type PipeRole = 'standalone' | 'master' | 'sub'

export type PipeEndpoint = {
  name: string
  address: string
  transport: 'local' | 'lan'
  role: PipeRole
  status: 'listening' | 'attached' | 'closed'
  host?: string
  port?: number
  sessionId?: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

export type PipeMessage = {
  id: string
  from: string
  targetName: string
  type: 'chat' | 'control' | 'ping'
  body: string
  createdAt: string
}

const DaemonStartInputSchema = z.object({})

const RemoteConnectInputSchema = z.object({
  name: z.string().min(1).optional(),
  transport: z.enum(['loopback', 'ssh-mock', 'ssh']).default('loopback'),
  host: z.string().min(1).optional(),
  sshCommand: z.string().min(1).optional(),
  sshArgs: z.array(z.string()).optional(),
  root: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
})

const RemoteSessionIdInputSchema = z.object({
  sessionId: z.string().min(1),
})

const RemoteRunInputSchema = z.object({
  sessionId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  path: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
})

const RemoteTriggerInputSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
})

const TerminalCaptureInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  lines: z.number().int().positive().max(200).optional(),
})

const RemoteSetupInputSchema = z.object({
  name: z.string().min(1).optional(),
})

const RemoteEnvInputSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  source: z.enum(['manual', 'inherited']).default('manual'),
})

const PipeRegisterInputSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['standalone', 'master', 'sub']).default('standalone'),
  transport: z.enum(['local', 'lan']).default('local'),
  host: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  sessionId: z.string().min(1).optional(),
})

const LanPipeRegisterInputSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(0).max(65_535),
  role: z.enum(['standalone', 'master', 'sub']).default('standalone'),
  sessionId: z.string().min(1).optional(),
})

const PipeSendInputSchema = z.object({
  targetName: z.string().min(1),
  body: z.string(),
  from: z.string().min(1).optional(),
  type: z.enum(['chat', 'control', 'ping']).default('chat'),
})

const UdsInboxInputSchema = z.object({
  name: z.string().min(1).default('main'),
})

const UdsInboxSendInputSchema = z.object({
  name: z.string().min(1).default('main'),
  body: z.string(),
  from: z.string().min(1).optional(),
})

export function getRemoteTools(): Tool[] {
  return [
    daemonStartTool,
    daemonHeartbeatTool,
    daemonStatusTool,
    daemonStopTool,
    bridgeKickTool,
    remoteSetupTool,
    remoteConnectTool,
    remoteRunTool,
    remoteDetachTool,
    remoteResumeTool,
    remoteTriggerTool,
    pipeRegisterTool,
    lanPipeRegisterTool,
    pipeSendTool,
    pipeListTool,
    udsInboxStartTool,
    udsInboxSendTool,
    udsInboxListTool,
    listPeersTool,
    remoteEnvSetTool,
    remoteEnvListTool,
    terminalCaptureTool,
  ]
}

export async function setupRemote(
  cwd: string,
  input: z.infer<typeof RemoteSetupInputSchema> = {},
): Promise<RemoteSetupReport> {
  const daemon = (await readDaemonState(cwd)).status === 'running'
    ? await readDaemonState(cwd)
    : await startDaemon(cwd)
  const now = new Date().toISOString()
  const report: RemoteSetupReport = {
    status: 'ready',
    cwd,
    daemon,
    bridgePath: bridgePath(cwd),
    setupPath: remoteSetupPath(cwd),
    supportedTransports: [
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
    ],
    commands: [
      '/daemon start',
      '/remote connect [name] [root]',
      '/remote ssh <host> [root]',
      '/remote env <NAME> <VALUE>',
      '/remote bridge-kick [reason]',
      '/remote pipe-register <name> [standalone|master|sub]',
      '/remote lan-register <name> <host> <port> [standalone|master|sub]',
      '/remote send <pipeName> <message>',
      '/remote uds-start [name]',
      '/remote uds-send [name] <message>',
    ],
    warnings: [],
    updatedAt: now,
  }
  await writeJsonFile(remoteSetupPath(cwd), {
    ...report,
    name: input.name ?? 'local-remote-setup',
  })
  await appendBridgeEvent(cwd, {
    type: 'remote.setup',
    payload: {
      name: input.name ?? 'local-remote-setup',
      supportedTransports: report.supportedTransports,
      bridgePath: report.bridgePath,
    },
  })
  return report
}

export async function startDaemon(cwd: string): Promise<DaemonState> {
  const now = new Date().toISOString()
  const state: DaemonState = {
    status: 'running',
    pid: process.pid,
    endpoint: 'loopback://my-claude-code-daemon',
    bridgePath: bridgePath(cwd),
    lockPath: daemonLockPath(cwd),
    heartbeatAt: now,
    reconnectCount: 0,
    startedAt: now,
    updatedAt: now,
  }
  await mkdir(dirname(daemonLockPath(cwd)), { recursive: true })
  await writeFile(daemonLockPath(cwd), `${process.pid}\n`, 'utf8')
  await writeJsonFile(daemonPath(cwd), state)
  await appendBridgeEvent(cwd, {
    type: 'daemon.start',
    payload: {
      endpoint: state.endpoint,
      pid: state.pid,
    },
  })
  return state
}

export async function heartbeatDaemon(cwd: string): Promise<DaemonState> {
  const previous = await readDaemonState(cwd)
  const now = new Date().toISOString()
  const state: DaemonState = {
    ...previous,
    status: 'running',
    heartbeatAt: now,
    updatedAt: now,
    bridgePath: bridgePath(cwd),
    lockPath: previous.lockPath ?? daemonLockPath(cwd),
  }
  await writeJsonFile(daemonPath(cwd), state)
  await appendBridgeEvent(cwd, {
    type: 'daemon.heartbeat',
    payload: {
      endpoint: state.endpoint,
      heartbeatAt: state.heartbeatAt,
    },
  })
  return state
}

export async function recordDaemonReconnect(
  cwd: string,
  reason = 'manual',
): Promise<DaemonState> {
  const previous = (await readDaemonState(cwd)).status === 'running'
    ? await readDaemonState(cwd)
    : await startDaemon(cwd)
  const now = new Date().toISOString()
  const state: DaemonState = {
    ...previous,
    status: 'running',
    heartbeatAt: now,
    reconnectCount: (previous.reconnectCount ?? 0) + 1,
    updatedAt: now,
  }
  await writeJsonFile(daemonPath(cwd), state)
  await appendBridgeEvent(cwd, {
    type: 'daemon.reconnect',
    payload: {
      reason,
      reconnectCount: state.reconnectCount,
    },
  })
  return state
}

export async function stopDaemon(cwd: string): Promise<DaemonState> {
  const previous = await readDaemonState(cwd)
  const now = new Date().toISOString()
  const state: DaemonState = {
    ...previous,
    status: 'stopped',
    stoppedAt: now,
    updatedAt: now,
    bridgePath: bridgePath(cwd),
  }
  await writeJsonFile(daemonPath(cwd), state)
  await appendBridgeEvent(cwd, {
    type: 'daemon.stop',
    payload: {
      previousStatus: previous.status,
    },
  })
  return state
}

export async function readDaemonState(cwd: string): Promise<DaemonState> {
  return readJsonFile<DaemonState>(daemonPath(cwd), {
    status: 'stopped',
    bridgePath: bridgePath(cwd),
    updatedAt: new Date(0).toISOString(),
  })
}

export async function connectRemote(
  cwd: string,
  input: z.infer<typeof RemoteConnectInputSchema>,
): Promise<RemoteSession> {
  const now = new Date().toISOString()
  const root = resolve(cwd, input.root ?? '.')
  const sessionId = `remote_${randomUUID()}`
  const token = input.token ?? randomUUID()
  const session: RemoteSession = {
    id: sessionId,
    name: input.name ?? input.host ?? 'loopback',
    transport: input.transport,
    host: input.host,
    sshCommand: input.transport === 'ssh' ? input.sshCommand ?? 'ssh' : undefined,
    sshArgs: input.transport === 'ssh' ? input.sshArgs ?? ['-o', 'BatchMode=yes'] : undefined,
    root,
    status: 'connected',
    tokenHash: hashToken(token),
    transcriptPath: remoteTranscriptPath(cwd, sessionId),
    createdAt: now,
    updatedAt: now,
    attachedAt: now,
  }

  await writeRemoteSessions(cwd, [...(await readRemoteSessions(cwd)), session])
  await appendRemoteTranscript(cwd, session.id, {
    type: 'remote.connect',
    sessionId: session.id,
    transport: session.transport,
    host: session.host,
    root: session.root,
    tokenRedacted: true,
  })
  await appendBridgeEvent(cwd, {
    type: 'remote.connect',
    sessionId: session.id,
    payload: sanitizeSession(session),
  })
  return session
}

export async function readRemoteSessions(cwd: string): Promise<RemoteSession[]> {
  return readJsonFile<RemoteSession[]>(remoteSessionsPath(cwd), [])
}

export async function readRemoteSession(
  cwd: string,
  sessionId: string,
): Promise<RemoteSession> {
  const session = (await readRemoteSessions(cwd)).find(candidate => candidate.id === sessionId)
  if (!session) {
    throw new Error(`remote session not found: ${sessionId}`)
  }
  return session
}

export async function detachRemote(
  cwd: string,
  sessionId: string,
): Promise<RemoteSession> {
  const now = new Date().toISOString()
  const session = await updateRemoteSession(cwd, sessionId, current => ({
    ...current,
    status: 'detached',
    detachedAt: now,
    updatedAt: now,
  }))
  await appendRemoteTranscript(cwd, sessionId, {
    type: 'remote.detach',
    sessionId,
  })
  await appendBridgeEvent(cwd, {
    type: 'remote.detach',
    sessionId,
    payload: sanitizeSession(session),
  })
  return session
}

export async function resumeRemote(
  cwd: string,
  sessionId: string,
): Promise<RemoteSession> {
  const now = new Date().toISOString()
  const session = await updateRemoteSession(cwd, sessionId, current => ({
    ...current,
    status: 'connected',
    attachedAt: now,
    updatedAt: now,
  }))
  await appendRemoteTranscript(cwd, sessionId, {
    type: 'remote.resume',
    sessionId,
  })
  await appendBridgeEvent(cwd, {
    type: 'remote.resume',
    sessionId,
    payload: sanitizeSession(session),
  })
  return session
}

export async function runRemoteCommand(
  cwd: string,
  input: z.infer<typeof RemoteRunInputSchema>,
  options: { permissionMode?: PermissionMode } = {},
): Promise<RemoteCommandResult> {
  const session = await readRemoteSession(cwd, input.sessionId)
  if (session.status !== 'connected') {
    throw new Error(`remote session is ${session.status}; resume it before running commands`)
  }

  const args = input.args ?? []
  assertSafeRemoteCommand(input.command, args, options.permissionMode ?? 'default')
  const commandCwd = resolveRemotePath(session.root, input.path)
  let result: RemoteCommandResult

  if (session.transport === 'ssh-mock') {
    result = {
      sessionId: session.id,
      command: input.command,
      args,
      cwd: commandCwd,
      exitCode: 0,
      stdout: `[ssh-mock ${session.host ?? 'unknown'}] ${[input.command, ...args].join(' ')}\n`,
      stderr: '',
      status: 'completed',
    }
  } else if (session.transport === 'ssh') {
    result = await runSshCommand(session, commandCwd, input.command, args, input.timeoutMs)
  } else {
    result = await runLoopbackCommand(session.id, commandCwd, input.command, args, input.timeoutMs)
  }

  const now = new Date().toISOString()
  await updateRemoteSession(cwd, session.id, current => ({
    ...current,
    updatedAt: now,
    lastCommand: {
      command: input.command,
      args,
      exitCode: result.exitCode,
      ranAt: now,
    },
  }))
  await appendRemoteTranscript(cwd, session.id, {
    type: 'remote.run',
    sessionId: session.id,
    command: input.command,
    args,
    cwd: commandCwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  })
  await appendBridgeEvent(cwd, {
    type: 'remote.run',
    sessionId: session.id,
    payload: {
      command: input.command,
      args,
      cwd: commandCwd,
      exitCode: result.exitCode,
      status: result.status,
    },
  })
  return result
}

export async function kickBridge(
  cwd: string,
  reason = 'manual',
): Promise<BridgeEvent> {
  await recordDaemonReconnect(cwd, reason)
  return appendBridgeEvent(cwd, {
    type: 'bridge.kick',
    payload: { reason },
  })
}

export async function setRemoteEnv(
  cwd: string,
  rawInput: z.input<typeof RemoteEnvInputSchema>,
): Promise<RemoteEnvRecord> {
  const input = RemoteEnvInputSchema.parse(rawInput)
  const now = new Date().toISOString()
  const record: RemoteEnvRecord = {
    name: input.name,
    valueHash: hashToken(input.value),
    source: input.source,
    updatedAt: now,
  }
  const previous = await readRemoteEnv(cwd)
  await writeJsonFile(remoteEnvPath(cwd), [
    ...previous.filter(item => item.name !== input.name),
    record,
  ].sort((left, right) => left.name.localeCompare(right.name)))
  await appendBridgeEvent(cwd, {
    type: 'remote.env',
    payload: {
      name: record.name,
      source: record.source,
      valueHash: '<redacted>',
    },
  })
  return record
}

export async function readRemoteEnv(cwd: string): Promise<RemoteEnvRecord[]> {
  return readJsonFile<RemoteEnvRecord[]>(remoteEnvPath(cwd), [])
}

export async function startRemoteControlServer(
  cwd: string,
  options: {
    host?: string
    port?: number
  } = {},
): Promise<RemoteControlServerHandle> {
  await startDaemon(cwd)
  const handle = await startRemoteControlServerRuntime({
    host: options.host,
    port: options.port,
    onHeartbeat: async () => {
      await heartbeatDaemon(cwd)
    },
    onHealth: async () => ({
      daemon: await readDaemonState(cwd),
      sessions: await readRemoteSessions(cwd),
    }),
    onSessions: async () => ({
      sessions: (await readRemoteSessions(cwd)).map(sanitizeSession),
    }),
    onEvent: async eventInput => appendBridgeEvent(cwd, {
      type: 'remote.trigger',
      payload: {
        transport: eventInput.transport,
        bodyHash: eventInput.bodyHash,
      },
    }),
  })
  const daemon = await readDaemonState(cwd)
  await writeJsonFile(daemonPath(cwd), {
    ...daemon,
    endpoint: handle.url,
    updatedAt: new Date().toISOString(),
  })
  return handle
}

export async function triggerRemote(
  cwd: string,
  input: z.infer<typeof RemoteTriggerInputSchema>,
): Promise<BridgeEvent> {
  await readRemoteSession(cwd, input.sessionId)
  const event = await appendBridgeEvent(cwd, {
    type: 'remote.trigger',
    sessionId: input.sessionId,
    payload: {
      name: input.name,
      payload: input.payload ?? {},
    },
  })
  await appendRemoteTranscript(cwd, input.sessionId, {
    type: 'remote.trigger',
    sessionId: input.sessionId,
    name: input.name,
    payload: input.payload ?? {},
  })
  return event
}

export async function readBridgeEvents(cwd: string): Promise<BridgeEvent[]> {
  try {
    const content = await readFile(bridgePath(cwd), 'utf8')
    return content
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as BridgeEvent)
  } catch {
    return []
  }
}

export async function captureTerminal(
  cwd: string,
  input: z.infer<typeof TerminalCaptureInputSchema> = {},
): Promise<{
  sessionId?: string
  lines: string[]
}> {
  const lineCount = input.lines ?? 40
  const sessionId =
    input.sessionId ?? (await readRemoteSessions(cwd)).at(-1)?.id
  if (!sessionId) {
    return { lines: [] }
  }
  const session = await readRemoteSession(cwd, sessionId)
  let lines: string[] = []
  try {
    lines = (await readFile(session.transcriptPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .slice(-lineCount)
  } catch {
    lines = []
  }
  await appendBridgeEvent(cwd, {
    type: 'terminal.capture',
    sessionId,
    payload: { lines: lines.length },
  })
  return { sessionId, lines }
}

export async function registerPipeEndpoint(
  cwd: string,
  rawInput: z.input<typeof PipeRegisterInputSchema>,
): Promise<PipeEndpoint> {
  const input = PipeRegisterInputSchema.parse(rawInput)
  const now = new Date().toISOString()
  const pipes = await readPipeEndpoints(cwd)
  const previous = pipes.find(pipe => pipe.name === input.name)
  if (input.transport === 'lan' && (!input.host || input.port === undefined)) {
    throw new Error('LAN pipe registration requires host and port')
  }
  const lanListener = input.transport === 'lan'
    ? await maybeStartLanPipeServer(cwd, input.name, input.host, input.port)
    : undefined
  const endpoint: PipeEndpoint = {
    name: input.name,
    address: lanListener?.address ?? pipeAddress(cwd, input),
    transport: input.transport,
    role: input.role,
    status: input.sessionId ? 'attached' : 'listening',
    host: input.transport === 'lan' ? lanListener?.host ?? input.host : undefined,
    port: input.transport === 'lan' ? lanListener?.port ?? input.port : undefined,
    sessionId: input.sessionId,
    messageCount: previous?.messageCount ?? 0,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  await writeJsonFile(pipeEndpointsPath(cwd), [
    ...pipes.filter(pipe => pipe.name !== input.name),
    endpoint,
  ].sort((left, right) => left.name.localeCompare(right.name)))
  await appendBridgeEvent(cwd, {
    type: input.transport === 'lan' ? 'pipe.lan.register' : 'pipe.register',
    sessionId: input.sessionId,
    payload: {
      name: endpoint.name,
      address: endpoint.address,
      transport: endpoint.transport,
      role: endpoint.role,
      status: endpoint.status,
    },
  })
  return endpoint
}

export async function registerLanPipeEndpoint(
  cwd: string,
  input: z.input<typeof LanPipeRegisterInputSchema>,
): Promise<PipeEndpoint> {
  return registerPipeEndpoint(cwd, {
    ...input,
    transport: 'lan',
  })
}

export async function readPipeEndpoints(cwd: string): Promise<PipeEndpoint[]> {
  return readJsonFile<PipeEndpoint[]>(pipeEndpointsPath(cwd), [])
}

export async function sendPipeMessage(
  cwd: string,
  rawInput: z.input<typeof PipeSendInputSchema>,
): Promise<PipeMessage> {
  const input = PipeSendInputSchema.parse(rawInput)
  const pipes = await readPipeEndpoints(cwd)
  const target = pipes.find(pipe => pipe.name === input.targetName)
  if (!target || target.status === 'closed') {
    throw new Error(`pipe endpoint not found: ${input.targetName}`)
  }
  const message: PipeMessage = {
    id: `pipe_${randomUUID()}`,
    from: input.from ?? 'local',
    targetName: input.targetName,
    type: input.type,
    body: input.body,
    createdAt: new Date().toISOString(),
  }
  if (target.transport === 'lan' && target.host && target.port) {
    await writeLanPipeMessage(target.host, target.port, message)
  }
  await appendJsonLine(pipeMessagesPath(cwd), message)
  await writeJsonFile(pipeEndpointsPath(cwd), pipes.map(pipe =>
    pipe.name === target.name
      ? {
          ...pipe,
          messageCount: pipe.messageCount + 1,
          updatedAt: message.createdAt,
        }
      : pipe,
  ))
  await appendBridgeEvent(cwd, {
    type: 'pipe.send',
    sessionId: target.sessionId,
    payload: {
      from: message.from,
      targetName: message.targetName,
      type: message.type,
      bodyChars: message.body.length,
    },
  })
  return message
}

export async function startUdsInbox(
  cwd: string,
  rawInput: z.input<typeof UdsInboxInputSchema> = {},
): Promise<UdsInbox> {
  const input = UdsInboxInputSchema.parse(rawInput)
  const now = new Date().toISOString()
  const previous = (await readUdsInboxes(cwd)).find(inbox => inbox.name === input.name)
  const address = udsInboxAddress(cwd, input.name)
  const key = udsInboxServerKey(cwd, input.name)
  if (!udsInboxServers.has(key)) {
    if (process.platform !== 'win32') {
      await unlink(address).catch(() => undefined)
    }
    await mkdir(dirname(address), { recursive: true })
    const server = createNetServer(socket => {
      readSocketLines(socket, async line => {
        await appendJsonLine(udsInboxMessagesPath(cwd, input.name), {
          ...objectFromJsonLine(line),
          receivedAt: new Date().toISOString(),
        })
        await incrementUdsInbox(cwd, input.name)
        await appendBridgeEvent(cwd, {
          type: 'uds.inbox.message',
          payload: {
            name: input.name,
            bodyChars: line.length,
          },
        })
      })
    })
    await listenNetServer(server, address)
    udsInboxServers.set(key, server)
  }

  const inbox: UdsInbox = {
    name: input.name,
    address,
    status: 'listening',
    messageCount: previous?.messageCount ?? 0,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  await writeUdsInboxes(cwd, [
    ...(await readUdsInboxes(cwd)).filter(item => item.name !== input.name),
    inbox,
  ])
  await appendBridgeEvent(cwd, {
    type: 'uds.inbox.start',
    payload: {
      name: inbox.name,
      address: inbox.address,
    },
  })
  return inbox
}

export async function sendUdsInboxMessage(
  cwd: string,
  rawInput: z.input<typeof UdsInboxSendInputSchema>,
): Promise<{ name: string; bodyChars: number; status: 'sent' }> {
  const input = UdsInboxSendInputSchema.parse(rawInput)
  const inbox = (await readUdsInboxes(cwd)).find(item => item.name === input.name)
  if (!inbox || inbox.status !== 'listening') {
    throw new Error(`UDS inbox not found: ${input.name}`)
  }
  await writeSocketMessage(inbox.address, {
    id: `uds_${randomUUID()}`,
    from: input.from ?? 'local',
    body: input.body,
    createdAt: new Date().toISOString(),
  })
  return {
    name: input.name,
    bodyChars: input.body.length,
    status: 'sent',
  }
}

export async function readUdsInboxes(cwd: string): Promise<UdsInbox[]> {
  return readJsonFile<UdsInbox[]>(udsInboxPath(cwd), [])
}

async function maybeStartLanPipeServer(
  cwd: string,
  name: string,
  host: string | undefined,
  port: number | undefined,
): Promise<{ host: string; port: number; address: string } | undefined> {
  if (!host || port === undefined || !isLocalHost(host)) {
    return undefined
  }
  const key = lanPipeServerKey(cwd, name)
  if (lanPipeServers.has(key)) {
    return {
      host,
      port,
      address: `tcp://${host}:${port}`,
    }
  }
  const server = createNetServer(socket => {
    readSocketLines(socket, async line => {
      const message = objectFromJsonLine(line)
      await appendJsonLine(pipeInboxPath(cwd, name), {
        ...message,
        targetName: name,
        receivedAt: new Date().toISOString(),
      })
    })
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
  lanPipeServers.set(key, server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error(`LAN pipe did not bind to tcp address: ${name}`)
  }
  return {
    host: address.address,
    port: address.port,
    address: `tcp://${address.address}:${address.port}`,
  }
}

async function writeLanPipeMessage(
  host: string,
  port: number,
  message: PipeMessage,
): Promise<void> {
  await writeSocketMessage({ host, port }, message)
}

async function writeSocketMessage(
  target: string | { host: string; port: number },
  message: unknown,
): Promise<void> {
  const line = `${JSON.stringify(message)}\n`
  await new Promise<void>((resolvePromise, reject) => {
    const socket = typeof target === 'string'
      ? connectSocket(target)
      : connectSocket(target.port, target.host)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.end(line, () => resolvePromise())
    })
  })
}

function readSocketLines(
  socket: Socket,
  onLine: (line: string) => void | Promise<void>,
) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        void onLine(line)
      }
      newline = buffer.indexOf('\n')
    }
  })
}

async function listenNetServer(server: NetServer, address: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(address, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
}

async function incrementUdsInbox(cwd: string, name: string): Promise<void> {
  const inboxes = await readUdsInboxes(cwd)
  await writeUdsInboxes(cwd, inboxes.map(inbox =>
    inbox.name === name
      ? {
          ...inbox,
          messageCount: inbox.messageCount + 1,
          updatedAt: new Date().toISOString(),
        }
      : inbox,
  ))
}

async function writeUdsInboxes(cwd: string, inboxes: UdsInbox[]): Promise<void> {
  await writeJsonFile(
    udsInboxPath(cwd),
    inboxes.sort((left, right) => left.name.localeCompare(right.name)),
  )
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return { body: value }
  }
}

function objectFromJsonLine(value: string): Record<string, unknown> {
  const parsed = safeParseJson(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : { body: String(parsed) }
}

function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function isDangerousRemoteCommand(command: string, args: string[] = []): boolean {
  const commandLine = [command, ...args].join(' ').toLowerCase()
  const executable = command.split(/[\\/]/).at(-1)?.toLowerCase() ?? command.toLowerCase()

  return (
    (executable === 'rm' && args.some(arg => arg.includes('r')) && args.some(arg => arg.includes('f'))) ||
    /\bsudo\b/.test(commandLine) ||
    /\b(curl|wget)\b.*\|\s*(sh|bash)\b/.test(commandLine) ||
    /\bchmod\s+-r\s+777\b/.test(commandLine) ||
    /\bmkfs(\.|\s|$)/.test(commandLine) ||
    /\bdd\s+if=/.test(commandLine) ||
    /:\(\)\s*\{/.test(commandLine) ||
    /\b(shutdown|reboot)\b/.test(commandLine)
  )
}

function assertSafeRemoteCommand(
  command: string,
  args: string[],
  permissionMode: PermissionMode,
) {
  if (permissionMode === 'bypassPermissions') {
    return
  }
  if (isDangerousRemoteCommand(command, args)) {
    throw new Error(`dangerous remote command requires confirmation: ${[command, ...args].join(' ')}`)
  }
}

async function runLoopbackCommand(
  sessionId: string,
  cwd: string,
  command: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<RemoteCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return {
      sessionId,
      command,
      args,
      cwd,
      exitCode: 0,
      stdout,
      stderr,
      status: 'completed',
    }
  } catch (error) {
    const failure = error as Error & {
      code?: number
      stdout?: string
      stderr?: string
    }
    return {
      sessionId,
      command,
      args,
      cwd,
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
      status: 'failed',
    }
  }
}

async function runSshCommand(
  session: RemoteSession,
  cwd: string,
  command: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<RemoteCommandResult> {
  const sshCommand = session.sshCommand ?? 'ssh'
  const sshArgs = session.sshArgs ?? ['-o', 'BatchMode=yes']
  const host = session.host
  if (!host) {
    throw new Error(`SSH remote session requires host: ${session.id}`)
  }
  const remoteCommand = [
    'cd',
    shellQuote(cwd),
    '&&',
    shellQuote(command),
    ...args.map(shellQuote),
  ].join(' ')
  try {
    const { stdout, stderr } = await execFileAsync(sshCommand, [...sshArgs, host, remoteCommand], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return {
      sessionId: session.id,
      command,
      args,
      cwd,
      exitCode: 0,
      stdout,
      stderr,
      status: 'completed',
    }
  } catch (error) {
    const failure = error as Error & {
      code?: number
      stdout?: string
      stderr?: string
    }
    return {
      sessionId: session.id,
      command,
      args,
      cwd,
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
      status: 'failed',
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function updateRemoteSession(
  cwd: string,
  sessionId: string,
  update: (session: RemoteSession) => RemoteSession,
): Promise<RemoteSession> {
  const sessions = await readRemoteSessions(cwd)
  const index = sessions.findIndex(session => session.id === sessionId)
  if (index === -1) {
    throw new Error(`remote session not found: ${sessionId}`)
  }
  const next = update(sessions[index])
  const updated = [...sessions]
  updated[index] = next
  await writeRemoteSessions(cwd, updated)
  return next
}

async function writeRemoteSessions(cwd: string, sessions: RemoteSession[]) {
  await writeJsonFile(remoteSessionsPath(cwd), sessions)
}

async function appendBridgeEvent(
  cwd: string,
  event: Omit<BridgeEvent, 'id' | 'createdAt'>,
): Promise<BridgeEvent> {
  const record: BridgeEvent = {
    ...event,
    id: `bridge_${randomUUID()}`,
    createdAt: new Date().toISOString(),
  }
  await appendJsonLine(bridgePath(cwd), record)
  return record
}

async function appendRemoteTranscript(
  cwd: string,
  sessionId: string,
  event: Record<string, unknown>,
) {
  await appendJsonLine(remoteTranscriptPath(cwd, sessionId), {
    ...event,
    createdAt: new Date().toISOString(),
  })
}

async function appendJsonLine(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const previous = await readFile(path, 'utf8').catch(() => '')
  await writeFile(path, `${previous}${JSON.stringify(value)}\n`, 'utf8')
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJsonFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function resolveRemotePath(root: string, path = '.'): string {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, path)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`remote path escapes session root: ${path}`)
  }
  return target
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sanitizeSession(session: RemoteSession): Omit<RemoteSession, 'tokenHash'> & {
  tokenHash: string
} {
  return {
    ...session,
    tokenHash: '<redacted>',
  }
}

function remoteRoot(cwd: string): string {
  return join(cwd, '.my-claude-code', 'remote')
}

function daemonPath(cwd: string): string {
  return join(remoteRoot(cwd), 'daemon.json')
}

function daemonLockPath(cwd: string): string {
  return join(remoteRoot(cwd), 'daemon.lock')
}

function bridgePath(cwd: string): string {
  return join(remoteRoot(cwd), 'bridge.jsonl')
}

function remoteSetupPath(cwd: string): string {
  return join(remoteRoot(cwd), 'setup.json')
}

function remoteSessionsPath(cwd: string): string {
  return join(remoteRoot(cwd), 'sessions.json')
}

function remoteEnvPath(cwd: string): string {
  return join(remoteRoot(cwd), 'env.json')
}

function remoteTranscriptPath(cwd: string, sessionId: string): string {
  return join(remoteRoot(cwd), 'transcripts', `${sessionId}.jsonl`)
}

function pipeEndpointsPath(cwd: string): string {
  return join(remoteRoot(cwd), 'pipes.json')
}

function pipeMessagesPath(cwd: string): string {
  return join(remoteRoot(cwd), 'pipe-messages.jsonl')
}

function pipeInboxPath(cwd: string, name: string): string {
  return join(remoteRoot(cwd), 'pipe-inbox', `${safeFileName(name)}.jsonl`)
}

function udsInboxPath(cwd: string): string {
  return join(remoteRoot(cwd), 'uds-inboxes.json')
}

function udsInboxMessagesPath(cwd: string, name: string): string {
  return join(remoteRoot(cwd), 'uds-inbox', `${safeFileName(name)}.jsonl`)
}

function udsInboxAddress(cwd: string, name: string): string {
  const safeName = safeFileName(name)
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\my-claude-code-uds-${safeName}`
  }
  return join(remoteRoot(cwd), 'uds', `${safeName}.sock`)
}

function lanPipeServerKey(cwd: string, name: string): string {
  return `${resolve(cwd)}:${name}`
}

function udsInboxServerKey(cwd: string, name: string): string {
  return `${resolve(cwd)}:${name}`
}

function pipeAddress(cwd: string, input: z.infer<typeof PipeRegisterInputSchema>): string {
  if (input.transport === 'lan' && input.host && input.port) {
    return `tcp://${input.host}:${input.port}`
  }
  const safeName = input.name.replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\my-claude-code-${safeName}`
  }
  return join(remoteRoot(cwd), 'pipes', `${safeName}.sock`)
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-')
}

const daemonStartTool: Tool<z.infer<typeof DaemonStartInputSchema>> = {
  name: 'DaemonStart',
  description: 'Start the local remote-control daemon state and bridge endpoint.',
  inputSchema: DaemonStartInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await startDaemon(context.cwd), null, 2)
  },
}

const daemonHeartbeatTool: Tool = {
  name: 'DaemonHeartbeat',
  description: 'Refresh the remote-control daemon heartbeat and emit a bridge event.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await heartbeatDaemon(context.cwd), null, 2)
  },
}

const daemonStatusTool: Tool = {
  name: 'DaemonStatus',
  description: 'Read the local remote-control daemon state.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readDaemonState(context.cwd), null, 2)
  },
}

const daemonStopTool: Tool = {
  name: 'DaemonStop',
  description: 'Stop the local remote-control daemon state.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await stopDaemon(context.cwd), null, 2)
  },
}

const bridgeKickTool: Tool<{ reason?: string }> = {
  name: 'BridgeKick',
  description: 'Force a remote bridge reconnect and emit a bridge kick event.',
  inputSchema: z.object({
    reason: z.string().optional(),
  }),
  inputJSONSchema: {
    type: 'object',
    properties: { reason: { type: 'string' } },
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await kickBridge(context.cwd, input.reason), null, 2)
  },
}

const remoteSetupTool: Tool<z.infer<typeof RemoteSetupInputSchema>> = {
  name: 'RemoteSetup',
  description: 'Prepare local remote-control state, bridge log, and supported transport metadata.',
  inputSchema: RemoteSetupInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await setupRemote(context.cwd, input), null, 2)
  },
}

const remoteConnectTool: Tool<z.infer<typeof RemoteConnectInputSchema>> = {
  name: 'RemoteConnect',
  description: 'Create a remote session using loopback, real SSH, or SSH mock transport.',
  inputSchema: RemoteConnectInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      transport: { type: 'string', enum: ['loopback', 'ssh', 'ssh-mock'] },
      host: { type: 'string' },
      sshCommand: { type: 'string' },
      sshArgs: { type: 'array', items: { type: 'string' } },
      root: { type: 'string' },
      token: { type: 'string' },
    },
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await connectRemote(context.cwd, input), null, 2)
  },
}

const remoteRunTool: Tool<z.infer<typeof RemoteRunInputSchema>> = {
  name: 'RemoteRun',
  description: 'Run a command inside an attached remote session with path and dangerous-command guards.',
  inputSchema: RemoteRunInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      command: { type: 'string' },
      args: {
        type: 'array',
        items: { type: 'string' },
      },
      path: { type: 'string' },
      timeoutMs: { type: 'number' },
    },
    required: ['sessionId', 'command'],
  },
  isReadOnly: () => false,
  isDestructive: input => isDangerousRemoteCommand(input.command, input.args ?? []),
  isConcurrencySafe: () => false,
  checkPermissions: (input, context) =>
    isDangerousRemoteCommand(input.command, input.args ?? []) &&
    context.permissionMode !== 'bypassPermissions'
      ? {
          decision: 'ask',
          reason: `dangerous remote command requires confirmation: ${[input.command, ...(input.args ?? [])].join(' ')}`,
        }
      : { decision: 'allow' },
  async execute(input, context) {
    return JSON.stringify(
      await runRemoteCommand(context.cwd, input, {
        permissionMode: context.permissionMode,
      }),
      null,
      2,
    )
  },
}

const remoteDetachTool: Tool<z.infer<typeof RemoteSessionIdInputSchema>> = {
  name: 'RemoteDetach',
  description: 'Detach a remote session while preserving its transcript and state.',
  inputSchema: RemoteSessionIdInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await detachRemote(context.cwd, input.sessionId), null, 2)
  },
}

const remoteResumeTool: Tool<z.infer<typeof RemoteSessionIdInputSchema>> = {
  name: 'RemoteResume',
  description: 'Resume and reattach a detached remote session.',
  inputSchema: RemoteSessionIdInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await resumeRemote(context.cwd, input.sessionId), null, 2)
  },
}

const remoteTriggerTool: Tool<z.infer<typeof RemoteTriggerInputSchema>> = {
  name: 'RemoteTriggerTool',
  description: 'Append a remote bridge trigger event for an attached session.',
  inputSchema: RemoteTriggerInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      name: { type: 'string' },
      payload: { type: 'object' },
    },
    required: ['sessionId', 'name'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await triggerRemote(context.cwd, input), null, 2)
  },
}

const pipeRegisterTool: Tool<z.infer<typeof PipeRegisterInputSchema>> = {
  name: 'PipeRegister',
  description: 'Register a local pipe endpoint for pipe IPC and remote bridge routing.',
  inputSchema: PipeRegisterInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      role: { type: 'string', enum: ['standalone', 'master', 'sub'] },
      sessionId: { type: 'string' },
    },
    required: ['name'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await registerPipeEndpoint(context.cwd, input), null, 2)
  },
}

const lanPipeRegisterTool: Tool<z.infer<typeof LanPipeRegisterInputSchema>> = {
  name: 'LanPipeRegister',
  description: 'Register a LAN-addressed pipe endpoint for remote bridge routing.',
  inputSchema: LanPipeRegisterInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'number' },
      role: { type: 'string', enum: ['standalone', 'master', 'sub'] },
      sessionId: { type: 'string' },
    },
    required: ['name', 'host', 'port'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await registerLanPipeEndpoint(context.cwd, input), null, 2)
  },
}

const pipeSendTool: Tool<z.infer<typeof PipeSendInputSchema>> = {
  name: 'PipeSend',
  description: 'Append a local pipe IPC message for a registered endpoint.',
  inputSchema: PipeSendInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      targetName: { type: 'string' },
      body: { type: 'string' },
      from: { type: 'string' },
      type: { type: 'string', enum: ['chat', 'control', 'ping'] },
    },
    required: ['targetName', 'body'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await sendPipeMessage(context.cwd, input), null, 2)
  },
}

const pipeListTool: Tool = {
  name: 'PipeList',
  description: 'List registered local pipe IPC endpoints.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify({ pipes: await readPipeEndpoints(context.cwd) }, null, 2)
  },
}

const udsInboxStartTool: Tool<z.infer<typeof UdsInboxInputSchema>> = {
  name: 'UdsInboxStart',
  description: 'Start a real Unix-domain-socket inbox for remote bridge messages.',
  inputSchema: UdsInboxInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await startUdsInbox(context.cwd, input), null, 2)
  },
}

const udsInboxSendTool: Tool<z.infer<typeof UdsInboxSendInputSchema>> = {
  name: 'UdsInboxSend',
  description: 'Send a message to a real Unix-domain-socket inbox.',
  inputSchema: UdsInboxSendInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      body: { type: 'string' },
      from: { type: 'string' },
    },
    required: ['body'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await sendUdsInboxMessage(context.cwd, input), null, 2)
  },
}

const udsInboxListTool: Tool = {
  name: 'UdsInboxList',
  description: 'List active Unix-domain-socket inbox records.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify({ inboxes: await readUdsInboxes(context.cwd) }, null, 2)
  },
}

const remoteEnvSetTool: Tool<z.infer<typeof RemoteEnvInputSchema>> = {
  name: 'RemoteEnvSet',
  description: 'Store a remote environment variable hash without persisting the raw value.',
  inputSchema: RemoteEnvInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      value: { type: 'string' },
      source: { type: 'string', enum: ['manual', 'inherited'] },
    },
    required: ['name', 'value'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await setRemoteEnv(context.cwd, input), null, 2)
  },
}

const remoteEnvListTool: Tool = {
  name: 'RemoteEnvList',
  description: 'List remote environment variable hashes.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify({ env: await readRemoteEnv(context.cwd) }, null, 2)
  },
}

const listPeersTool: Tool = {
  name: 'ListPeersTool',
  description: 'List known remote peers and their attach status.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(
      (await readRemoteSessions(context.cwd)).map(sanitizeSession),
      null,
      2,
    )
  },
}

const terminalCaptureTool: Tool<z.infer<typeof TerminalCaptureInputSchema>> = {
  name: 'TerminalCaptureTool',
  description: 'Capture recent remote transcript lines for terminal-panel parity.',
  inputSchema: TerminalCaptureInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      lines: { type: 'number' },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await captureTerminal(context.cwd, input), null, 2)
  },
}
