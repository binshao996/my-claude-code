import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import {
  checkVoiceAvailability,
  getActiveVoiceRecordings,
  getVoiceStreamStatus,
  startVoiceRecording,
  stopVoiceRecording,
  type VoiceAvailability,
  type VoiceProvider,
  type VoiceRecordingSession,
} from './services/voice/audio.js'
import type { Tool } from './types.js'

export type AcpSessionRecord = {
  id: string
  client: string
  transport: 'jsonl'
  status: 'connected'
  inboxPath: string
  outboxPath: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

export type AutofixPrPlanRecord = {
  id: string
  repo: string
  branch: string
  summary: string
  status: 'planned'
  createdAt: string
}

export type BuddySessionRecord = {
  id: string
  name: string
  objective: string
  status: 'active'
  createdAt: string
}

export type ChicagoMcpProfileRecord = {
  name: string
  endpoint: string
  status: 'registered'
  createdAt: string
}

export type TorchProbeRecord = {
  id: string
  target: string
  status: 'recorded'
  createdAt: string
}

export type VoiceModeState = {
  enabled: boolean
  provider: VoiceProvider
  status: 'ready' | 'disabled' | 'unavailable'
  availability: VoiceAvailability
  stt: ReturnType<typeof getVoiceStreamStatus>
  updatedAt: string
}

const AcpLinkInputSchema = z.object({
  client: z.string().min(1).default('local-acp-client'),
})

const AcpSendInputSchema = z.object({
  sessionId: z.string().min(1),
  body: z.string(),
  role: z.enum(['client', 'server']).default('client'),
})

const AutofixPrPlanInputSchema = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1).default('autofix/local'),
  summary: z.string().min(1),
})

const BuddyStartInputSchema = z.object({
  name: z.string().min(1).default('buddy'),
  objective: z.string().min(1),
})

const ChicagoMcpRegisterInputSchema = z.object({
  name: z.string().min(1).default('chicago'),
  endpoint: z.string().min(1).default('local://chicago-mcp'),
})

const TorchProbeInputSchema = z.object({
  target: z.string().min(1),
})

const VoiceModeSetInputSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['anthropic', 'doubao', 'deepseek']).optional(),
  language: z.string().min(1).optional(),
})

const VoiceRecordingStartInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
})

const VoiceRecordingStopInputSchema = z.object({
  sessionId: z.string().min(1),
})

export function getEcosystemTools(): Tool[] {
  return [
    acpLinkTool(),
    acpSendTool(),
    acpListTool,
    autofixPrPlanTool(),
    autofixPrListTool,
    buddyStartTool(),
    buddyListTool,
    chicagoMcpRegisterTool(),
    chicagoMcpListTool,
    torchProbeTool(),
    torchListTool,
    voiceModeSetTool(),
    voiceModeStateTool,
    voiceCheckTool,
    voiceRecordingStartTool(),
    voiceRecordingStopTool(),
    voiceRecordingListTool,
  ]
}

export async function linkAcpSession(
  cwd: string,
  rawInput: z.input<typeof AcpLinkInputSchema>,
): Promise<AcpSessionRecord> {
  const input = AcpLinkInputSchema.parse(rawInput)
  const record: AcpSessionRecord = {
    id: `acp_${randomUUID()}`,
    client: input.client,
    transport: 'jsonl',
    status: 'connected',
    inboxPath: acpInboxPath(cwd, input.client),
    outboxPath: acpOutboxPath(cwd, input.client),
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await writeJsonFile(acpPath(cwd), [...(await readAcpSessions(cwd)), record])
  return record
}

export async function readAcpSessions(cwd: string): Promise<AcpSessionRecord[]> {
  return readJsonFile(acpPath(cwd), [])
}

export async function sendAcpMessage(
  cwd: string,
  rawInput: z.input<typeof AcpSendInputSchema>,
): Promise<{ sessionId: string; status: 'sent'; bodyChars: number }> {
  const input = AcpSendInputSchema.parse(rawInput)
  const sessions = await readAcpSessions(cwd)
  const session = sessions.find(candidate => candidate.id === input.sessionId)
  if (!session || session.status !== 'connected') {
    throw new Error(`ACP session not connected: ${input.sessionId}`)
  }
  const record = {
    id: `acp_msg_${randomUUID()}`,
    role: input.role,
    body: input.body,
    createdAt: new Date().toISOString(),
  }
  await appendJsonLine(
    input.role === 'client' ? session.outboxPath : session.inboxPath,
    record,
  )
  await writeJsonFile(acpPath(cwd), sessions.map(candidate =>
    candidate.id === session.id
      ? {
          ...candidate,
          messageCount: candidate.messageCount + 1,
          updatedAt: record.createdAt,
        }
      : candidate,
  ))
  return {
    sessionId: input.sessionId,
    status: 'sent',
    bodyChars: input.body.length,
  }
}

export async function planAutofixPr(
  cwd: string,
  rawInput: z.input<typeof AutofixPrPlanInputSchema>,
): Promise<AutofixPrPlanRecord> {
  const input = AutofixPrPlanInputSchema.parse(rawInput)
  const record: AutofixPrPlanRecord = {
    id: `autofix_${randomUUID()}`,
    repo: input.repo,
    branch: input.branch,
    summary: input.summary,
    status: 'planned',
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(autofixPrPath(cwd), [...(await readAutofixPrPlans(cwd)), record])
  return record
}

export async function readAutofixPrPlans(cwd: string): Promise<AutofixPrPlanRecord[]> {
  return readJsonFile(autofixPrPath(cwd), [])
}

export async function startBuddySession(
  cwd: string,
  rawInput: z.input<typeof BuddyStartInputSchema>,
): Promise<BuddySessionRecord> {
  const input = BuddyStartInputSchema.parse(rawInput)
  const record: BuddySessionRecord = {
    id: `buddy_${randomUUID()}`,
    name: input.name,
    objective: input.objective,
    status: 'active',
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(buddyPath(cwd), [...(await readBuddySessions(cwd)), record])
  return record
}

export async function readBuddySessions(cwd: string): Promise<BuddySessionRecord[]> {
  return readJsonFile(buddyPath(cwd), [])
}

export async function registerChicagoMcpProfile(
  cwd: string,
  rawInput: z.input<typeof ChicagoMcpRegisterInputSchema>,
): Promise<ChicagoMcpProfileRecord> {
  const input = ChicagoMcpRegisterInputSchema.parse(rawInput)
  const previous = await readChicagoMcpProfiles(cwd)
  const record: ChicagoMcpProfileRecord = {
    name: input.name,
    endpoint: input.endpoint,
    status: 'registered',
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(chicagoMcpPath(cwd), [
    ...previous.filter(profile => profile.name !== input.name),
    record,
  ].sort((left, right) => left.name.localeCompare(right.name)))
  return record
}

export async function readChicagoMcpProfiles(
  cwd: string,
): Promise<ChicagoMcpProfileRecord[]> {
  return readJsonFile(chicagoMcpPath(cwd), [])
}

export async function recordTorchProbe(
  cwd: string,
  input: z.infer<typeof TorchProbeInputSchema>,
): Promise<TorchProbeRecord> {
  const record: TorchProbeRecord = {
    id: `torch_${randomUUID()}`,
    target: input.target,
    status: 'recorded',
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(torchPath(cwd), [...(await readTorchProbes(cwd)), record])
  return record
}

export async function readTorchProbes(cwd: string): Promise<TorchProbeRecord[]> {
  return readJsonFile(torchPath(cwd), [])
}

export async function setVoiceMode(
  cwd: string,
  input: z.infer<typeof VoiceModeSetInputSchema>,
): Promise<VoiceModeState> {
  const availability = await checkVoiceAvailability()
  const stt = getVoiceStreamStatus({
    ...process.env,
    ...(input.provider ? { MY_CLAUDE_CODE_VOICE_PROVIDER: input.provider } : {}),
  })
  const state: VoiceModeState = {
    enabled: input.enabled && availability.available && stt.available,
    provider: input.provider ?? stt.provider,
    status: !input.enabled
      ? 'disabled'
      : availability.available && stt.available
        ? 'ready'
        : 'unavailable',
    availability,
    stt,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonFile(voicePath(cwd), state)
  return state
}

export async function readVoiceMode(cwd: string): Promise<VoiceModeState> {
  return readJsonFile(voicePath(cwd), {
    enabled: false,
    provider: 'anthropic',
    status: 'disabled',
    availability: {
      available: false,
      backend: 'unavailable',
      permission: 'unknown',
      reason: 'voice mode has not been checked in this workspace',
    },
    stt: {
      available: false,
      provider: 'anthropic',
      endpoint: 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream',
      auth: 'missing',
      reason: 'voice mode has not been checked in this workspace',
    },
    updatedAt: new Date(0).toISOString(),
  })
}

export async function checkVoiceRuntime(): Promise<{
  availability: VoiceAvailability
  stt: ReturnType<typeof getVoiceStreamStatus>
}> {
  return {
    availability: await checkVoiceAvailability(),
    stt: getVoiceStreamStatus(),
  }
}

export async function startVoiceRuntimeRecording(
  cwd: string,
  input: z.infer<typeof VoiceRecordingStartInputSchema>,
): Promise<VoiceRecordingSession> {
  return startVoiceRecording(cwd, input)
}

export async function stopVoiceRuntimeRecording(
  input: z.infer<typeof VoiceRecordingStopInputSchema>,
): Promise<VoiceRecordingSession> {
  return stopVoiceRecording(input.sessionId)
}

function acpLinkTool(): Tool<z.infer<typeof AcpLinkInputSchema>> {
  return {
    name: 'AcpLink',
    description: 'Open a local ACP JSONL client link with inbox and outbox queues.',
    inputSchema: AcpLinkInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: { client: { type: 'string' } },
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) =>
      JSON.stringify(await linkAcpSession(context.cwd, input), null, 2),
  }
}

function acpSendTool(): Tool<z.infer<typeof AcpSendInputSchema>> {
  return {
    name: 'AcpSend',
    description: 'Send a message through an ACP JSONL inbox or outbox queue.',
    inputSchema: AcpSendInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        body: { type: 'string' },
        role: { type: 'string', enum: ['client', 'server'] },
      },
      required: ['sessionId', 'body'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) =>
      JSON.stringify(await sendAcpMessage(context.cwd, input), null, 2),
  }
}

const acpListTool: Tool = listTool('AcpList', 'List local ACP links.', async cwd => ({
  acp: await readAcpSessions(cwd),
}))

function autofixPrPlanTool(): Tool<z.infer<typeof AutofixPrPlanInputSchema>> {
  return {
    name: 'AutofixPrPlan',
    description: 'Create a local autofix PR plan without mutating git or GitHub.',
    inputSchema: AutofixPrPlanInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        branch: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['repo', 'summary'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) =>
      JSON.stringify(await planAutofixPr(context.cwd, input), null, 2),
  }
}

const autofixPrListTool: Tool = listTool(
  'AutofixPrList',
  'List local autofix PR plans.',
  async cwd => ({ plans: await readAutofixPrPlans(cwd) }),
)

function buddyStartTool(): Tool<z.infer<typeof BuddyStartInputSchema>> {
  return {
    name: 'BuddyStart',
    description: 'Start a local buddy helper session record.',
    inputSchema: BuddyStartInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        objective: { type: 'string' },
      },
      required: ['objective'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) =>
      JSON.stringify(await startBuddySession(context.cwd, input), null, 2),
  }
}

const buddyListTool: Tool = listTool('BuddyList', 'List local buddy sessions.', async cwd => ({
  buddies: await readBuddySessions(cwd),
}))

function chicagoMcpRegisterTool(): Tool<z.infer<typeof ChicagoMcpRegisterInputSchema>> {
  return {
    name: 'ChicagoMcpRegister',
    description: 'Register a local Chicago MCP profile without contacting internal services.',
    inputSchema: ChicagoMcpRegisterInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        endpoint: { type: 'string' },
      },
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) =>
      JSON.stringify(await registerChicagoMcpProfile(context.cwd, input), null, 2),
  }
}

const chicagoMcpListTool: Tool = listTool(
  'ChicagoMcpList',
  'List local Chicago MCP profiles.',
  async cwd => ({ profiles: await readChicagoMcpProfiles(cwd) }),
)

function torchProbeTool(): Tool<z.infer<typeof TorchProbeInputSchema>> {
  return {
    name: 'TorchProbe',
    description: 'Record a local Torch diagnostics probe target.',
    inputSchema: TorchProbeInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) =>
      JSON.stringify(await recordTorchProbe(context.cwd, input), null, 2),
  }
}

const torchListTool: Tool = listTool('TorchList', 'List local Torch probes.', async cwd => ({
  probes: await readTorchProbes(cwd),
}))

function voiceModeSetTool(): Tool<z.infer<typeof VoiceModeSetInputSchema>> {
  return {
    name: 'VoiceModeSet',
    description: 'Set voice-mode state after checking microphone and STT availability.',
    inputSchema: VoiceModeSetInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        provider: { type: 'string', enum: ['anthropic', 'doubao', 'deepseek'] },
        language: { type: 'string' },
      },
      required: ['enabled'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) =>
      JSON.stringify(await setVoiceMode(context.cwd, input), null, 2),
  }
}

const voiceModeStateTool: Tool = listTool(
  'VoiceModeState',
  'Read local voice-mode state.',
  async cwd => ({ voice: await readVoiceMode(cwd) }),
)

const voiceCheckTool: Tool = listTool(
  'VoiceCheck',
  'Check microphone backend and voice STT availability.',
  async () => checkVoiceRuntime(),
)

function voiceRecordingStartTool(): Tool<z.infer<typeof VoiceRecordingStartInputSchema>> {
  return {
    name: 'VoiceRecordingStart',
    description: 'Start a push-to-talk voice recording session.',
    inputSchema: VoiceRecordingStartInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) =>
      JSON.stringify(await startVoiceRuntimeRecording(context.cwd, input), null, 2),
  }
}

function voiceRecordingStopTool(): Tool<z.infer<typeof VoiceRecordingStopInputSchema>> {
  return {
    name: 'VoiceRecordingStop',
    description: 'Stop a push-to-talk voice recording session.',
    inputSchema: VoiceRecordingStopInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async input =>
      JSON.stringify(await stopVoiceRuntimeRecording(input), null, 2),
  }
}

const voiceRecordingListTool: Tool = listTool(
  'VoiceRecordingList',
  'List active push-to-talk voice recording sessions.',
  async () => ({ recordings: getActiveVoiceRecordings() }),
)

function listTool(
  name: string,
  description: string,
  read: (cwd: string) => Promise<Record<string, unknown>>,
): Tool {
  return {
    name,
    description,
    inputSchema: z.object({}),
    inputJSONSchema: {
      type: 'object',
      properties: {},
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (_input, context) => JSON.stringify(await read(context.cwd), null, 2),
  }
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const previous = await readFile(path, 'utf8').catch(() => '')
  await writeFile(path, `${previous}${JSON.stringify(value)}\n`, 'utf8')
}

function ecosystemRoot(cwd: string): string {
  return join(cwd, '.my-claude-code', 'ecosystem')
}

function acpPath(cwd: string): string {
  return join(ecosystemRoot(cwd), 'acp.json')
}

function acpInboxPath(cwd: string, client: string): string {
  return join(ecosystemRoot(cwd), 'acp', `${safeFileName(client)}.inbox.jsonl`)
}

function acpOutboxPath(cwd: string, client: string): string {
  return join(ecosystemRoot(cwd), 'acp', `${safeFileName(client)}.outbox.jsonl`)
}

function autofixPrPath(cwd: string): string {
  return join(ecosystemRoot(cwd), 'autofix-pr.json')
}

function buddyPath(cwd: string): string {
  return join(ecosystemRoot(cwd), 'buddy.json')
}

function chicagoMcpPath(cwd: string): string {
  return join(ecosystemRoot(cwd), 'chicago-mcp.json')
}

function torchPath(cwd: string): string {
  return join(ecosystemRoot(cwd), 'torch.json')
}

function voicePath(cwd: string): string {
  return join(ecosystemRoot(cwd), 'voice.json')
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-')
}
