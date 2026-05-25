import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const TEAM_LEAD_NAME = 'team-lead'

const BooleanLikeSchema = z.preprocess(value => {
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  return value
}, z.boolean())

const StructuredMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shutdown_request'),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('shutdown_response'),
    request_id: z.string().min(1),
    approve: BooleanLikeSchema,
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('plan_approval_response'),
    request_id: z.string().min(1),
    approve: BooleanLikeSchema,
    feedback: z.string().optional(),
  }),
])

const TeamCreateInputSchema = z.object({
  team_name: z.string().min(1),
  description: z.string().optional(),
  agent_type: z.string().optional(),
})

const TeamDeleteInputSchema = z.object({
  wait_ms: z.number().int().min(0).max(30_000).optional(),
})

const SendMessageInputSchema = z.object({
  to: z.string().min(1),
  summary: z.string().optional(),
  message: z.union([z.string(), StructuredMessageSchema]),
})

type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>
type TeamDeleteInput = z.infer<typeof TeamDeleteInputSchema>
type SendMessageInput = z.infer<typeof SendMessageInputSchema>
type StructuredMessage = z.infer<typeof StructuredMessageSchema>

type TeamMember = {
  agentId: string
  name: string
  agentType: string
  model?: string
  joinedAt: number
  tmuxPaneId: string
  cwd: string
  subscriptions: string[]
  isActive?: boolean
  backendType?: string
}

type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: TeamMember[]
}

type CurrentTeam = {
  teamName: string
  teamFilePath: string
  leadAgentId: string
  updatedAt: string
}

type MailboxMessage = {
  id: string
  teamName: string
  from: string
  to: string
  summary?: string
  text?: string
  structured?: StructuredMessage
  timestamp: string
  read: boolean
}

type TeamEvent = {
  id: string
  type: 'team.create' | 'team.delete' | 'message.direct' | 'message.broadcast'
  teamName?: string
  from?: string
  to?: string
  recipients?: string[]
  summary?: string
  status: 'success' | 'blocked' | 'failed'
  createdAt: string
}

export const teamCreateTool: Tool<TeamCreateInput> = {
  name: 'TeamCreate',
  description: 'Create a local team for coordinating multiple agents.',
  inputSchema: TeamCreateInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Name for the new team.' },
      description: { type: 'string', description: 'Team description or purpose.' },
      agent_type: { type: 'string', description: 'Type or role of the team lead.' },
    },
    required: ['team_name'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    const existing = await readCurrentTeam(context.cwd)
    if (existing) {
      throw new Error(
        `Already leading team "${existing.teamName}". Use TeamDelete before creating another team.`,
      )
    }

    const teamName = await uniqueTeamName(context.cwd, input.team_name)
    const leadAgentId = `${TEAM_LEAD_NAME}@${teamName}`
    const teamFilePath = teamConfigPath(context.cwd, teamName)
    const now = Date.now()
    const teamFile: TeamFile = {
      name: teamName,
      description: input.description,
      createdAt: now,
      leadAgentId,
      leadSessionId: context.sessionId,
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: input.agent_type ?? TEAM_LEAD_NAME,
          joinedAt: now,
          tmuxPaneId: '',
          cwd: context.cwd,
          subscriptions: [],
          isActive: true,
        },
      ],
    }

    await writeJsonFile(teamFilePath, teamFile)
    await mkdir(taskListDir(context.cwd, teamName), { recursive: true })
    await writeJsonFile(currentTeamPath(context.cwd), {
      teamName,
      teamFilePath,
      leadAgentId,
      updatedAt: new Date().toISOString(),
    } satisfies CurrentTeam)
    await appendTeamEvent(context.cwd, {
      type: 'team.create',
      teamName,
      status: 'success',
    })

    return JSON.stringify({
      team_name: teamName,
      team_file_path: teamFilePath,
      lead_agent_id: leadAgentId,
    })
  },
}

export const teamDeleteTool: Tool<TeamDeleteInput> = {
  name: 'TeamDelete',
  description: 'Clean up the current local team and task directories.',
  inputSchema: TeamDeleteInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      wait_ms: {
        type: 'number',
        description: 'Optional time to wait for active teammates before cleanup.',
      },
    },
  },
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    const current = await readCurrentTeam(context.cwd)
    if (!current) {
      return JSON.stringify({
        success: true,
        message: 'No team name found, nothing to clean up',
      })
    }

    const waitUntil = Date.now() + (input.wait_ms ?? 0)
    let activeMembers = await readActiveNonLeadMembers(context.cwd, current.teamName)
    while (activeMembers.length > 0 && Date.now() < waitUntil) {
      await sleep(Math.min(250, Math.max(1, waitUntil - Date.now())))
      activeMembers = await readActiveNonLeadMembers(context.cwd, current.teamName)
    }

    if (activeMembers.length > 0) {
      const memberNames = activeMembers.map(member => member.name).join(', ')
      await appendTeamEvent(context.cwd, {
        type: 'team.delete',
        teamName: current.teamName,
        status: 'blocked',
      })
      return JSON.stringify({
        success: false,
        message: `Cannot cleanup team with ${activeMembers.length} active member(s): ${memberNames}. Use shutdown_request first.`,
        team_name: current.teamName,
      })
    }

    await rm(teamDir(context.cwd, current.teamName), { recursive: true, force: true })
    await rm(taskListDir(context.cwd, current.teamName), { recursive: true, force: true })
    await rm(currentTeamPath(context.cwd), { force: true })
    await appendTeamEvent(context.cwd, {
      type: 'team.delete',
      teamName: current.teamName,
      status: 'success',
    })

    return JSON.stringify({
      success: true,
      message: `Cleaned up directories and worktrees for team "${current.teamName}"`,
      team_name: current.teamName,
    })
  },
}

export const sendMessageTool: Tool<SendMessageInput> = {
  name: 'SendMessage',
  description: 'Send a message to a teammate, broadcast to a team, or record a structured coordination response.',
  inputSchema: SendMessageInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Recipient teammate name, "*" for broadcast, or a future peer address.',
      },
      summary: {
        type: 'string',
        description: 'Required 5-10 word preview when message is a string.',
      },
      message: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['shutdown_request', 'shutdown_response', 'plan_approval_response'],
              },
              request_id: { type: 'string' },
              approve: { type: 'boolean' },
              reason: { type: 'string' },
              feedback: { type: 'string' },
            },
            required: ['type'],
          },
        ],
      },
    },
    required: ['to', 'message'],
  },
  isReadOnly: input => typeof input.message === 'string',
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions(input) {
    if (input.to.startsWith('bridge:') || input.to.startsWith('tcp:')) {
      return {
        decision: 'ask',
        reason: `SendMessage wants to contact external peer ${redactPeerAddress(input.to)}`,
      }
    }
    return { decision: 'allow' }
  },
  async execute(input, context) {
    validateSendMessageInput(input)

    if (input.to.startsWith('bridge:') || input.to.startsWith('tcp:') || input.to.startsWith('uds:')) {
      return JSON.stringify({
        success: false,
        message: `Peer transport is not connected for ${redactPeerAddress(input.to)}`,
      })
    }

    const current = await readCurrentTeam(context.cwd)
    if (!current) {
      return JSON.stringify({
        success: false,
        message: 'Not in a team context. Create a team with TeamCreate first.',
      })
    }
    const team = await readTeamFile(context.cwd, current.teamName)
    if (!team) {
      throw new Error(`Team "${current.teamName}" does not exist`)
    }

    if (input.to === '*') {
      return sendBroadcast(context.cwd, team, input)
    }

    return sendDirectMessage(context.cwd, team, input.to, input)
  },
}

function validateSendMessageInput(input: SendMessageInput): void {
  if (input.to.trim().length === 0) {
    throw new Error('to must not be empty')
  }
  if (input.to.includes('@')) {
    throw new Error('to must be a bare teammate name or "*"')
  }
  if (input.to.startsWith('uds:') && input.to.includes('#token=')) {
    throw new Error('uds addresses must not include inline auth tokens; use the ListPeers address')
  }
  if (typeof input.message === 'string') {
    if (!input.summary || input.summary.trim().length === 0) {
      throw new Error('summary is required when message is a string')
    }
    return
  }
  if (input.to === '*') {
    throw new Error('structured messages cannot be broadcast')
  }
  if (
    input.message.type === 'shutdown_response' &&
    input.to !== TEAM_LEAD_NAME
  ) {
    throw new Error(`shutdown_response must be sent to "${TEAM_LEAD_NAME}"`)
  }
  if (
    input.message.type === 'shutdown_response' &&
    !input.message.approve &&
    (!input.message.reason || input.message.reason.trim().length === 0)
  ) {
    throw new Error('reason is required when rejecting a shutdown request')
  }
}

async function sendDirectMessage(
  cwd: string,
  team: TeamFile,
  to: string,
  input: SendMessageInput,
): Promise<string> {
  const recipient = team.members.find(member => member.name === to)
  if (!recipient) {
    return JSON.stringify({
      success: false,
      message: `Teammate "${to}" not found in team "${team.name}"`,
    })
  }
  const sender = TEAM_LEAD_NAME
  const mailboxMessage = buildMailboxMessage(team.name, sender, to, input)
  await appendMailboxMessage(cwd, team.name, to, mailboxMessage)
  await appendTeamEvent(cwd, {
    type: 'message.direct',
    teamName: team.name,
    from: sender,
    to,
    summary: input.summary,
    status: 'success',
  })

  return JSON.stringify({
    success: true,
    message: `Message sent to ${to}`,
    routing: {
      sender,
      target: to,
      summary: input.summary,
      content: typeof input.message === 'string' ? input.message : undefined,
    },
  })
}

async function sendBroadcast(
  cwd: string,
  team: TeamFile,
  input: SendMessageInput,
): Promise<string> {
  if (typeof input.message !== 'string') {
    throw new Error('structured messages cannot be broadcast')
  }

  const recipients = team.members
    .filter(member => member.name !== TEAM_LEAD_NAME)
    .map(member => member.name)

  if (recipients.length === 0) {
    return JSON.stringify({
      success: false,
      message: 'No teammates to broadcast to (you are the only team member)',
      recipients,
    })
  }

  const sender = TEAM_LEAD_NAME
  await Promise.all(
    recipients.map(recipient =>
      appendMailboxMessage(
        cwd,
        team.name,
        recipient,
        buildMailboxMessage(team.name, sender, recipient, input),
      ),
    ),
  )
  await appendTeamEvent(cwd, {
    type: 'message.broadcast',
    teamName: team.name,
    from: sender,
    recipients,
    summary: input.summary,
    status: 'success',
  })

  return JSON.stringify({
    success: true,
    message: `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`,
    recipients,
    routing: {
      sender,
      target: '@team',
      summary: input.summary,
      content: input.message,
    },
  })
}

function buildMailboxMessage(
  teamName: string,
  from: string,
  to: string,
  input: SendMessageInput,
): MailboxMessage {
  return {
    id: `msg_${randomUUID()}`,
    teamName,
    from,
    to,
    summary: input.summary,
    text: typeof input.message === 'string' ? input.message : undefined,
    structured: typeof input.message === 'string' ? undefined : input.message,
    timestamp: new Date().toISOString(),
    read: false,
  }
}

async function uniqueTeamName(cwd: string, requested: string): Promise<string> {
  const base = sanitizeName(requested)
  if (!(await teamExists(cwd, base))) {
    return base
  }

  return `${base}-${randomUUID().slice(0, 8)}`
}

function sanitizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'team'
}

async function teamExists(cwd: string, teamName: string): Promise<boolean> {
  return Boolean(await readTeamFile(cwd, teamName))
}

async function readCurrentTeam(cwd: string): Promise<CurrentTeam | undefined> {
  return readJsonFile<CurrentTeam | undefined>(currentTeamPath(cwd), undefined)
}

async function readTeamFile(cwd: string, teamName: string): Promise<TeamFile | undefined> {
  return readJsonFile<TeamFile | undefined>(teamConfigPath(cwd, teamName), undefined)
}

async function readActiveNonLeadMembers(cwd: string, teamName: string): Promise<TeamMember[]> {
  const team = await readTeamFile(cwd, teamName)
  return team?.members.filter(member => member.name !== TEAM_LEAD_NAME && member.isActive !== false) ?? []
}

async function appendMailboxMessage(
  cwd: string,
  teamName: string,
  recipient: string,
  message: MailboxMessage,
): Promise<void> {
  const path = mailboxPath(cwd, teamName, recipient)
  const messages = await readJsonFile<MailboxMessage[]>(path, [])
  await writeJsonFile(path, [...messages, message])
}

async function appendTeamEvent(
  cwd: string,
  event: Omit<TeamEvent, 'id' | 'createdAt'>,
): Promise<void> {
  const path = teamEventsPath(cwd)
  const events = await readJsonFile<TeamEvent[]>(path, [])
  await writeJsonFile(path, [
    ...events,
    {
      id: `team_event_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      ...event,
    },
  ])
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function teamDir(cwd: string, teamName: string): string {
  return join(cwd, '.my-claude-code', 'teams', sanitizeName(teamName))
}

function teamConfigPath(cwd: string, teamName: string): string {
  return join(teamDir(cwd, teamName), 'config.json')
}

function currentTeamPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'teams', 'current.json')
}

function mailboxPath(cwd: string, teamName: string, recipient: string): string {
  return join(teamDir(cwd, teamName), 'inboxes', `${sanitizeName(recipient)}.json`)
}

function taskListDir(cwd: string, teamName: string): string {
  return join(cwd, '.my-claude-code', 'tasks', sanitizeName(teamName))
}

function teamEventsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'teams', 'events.json')
}

function redactPeerAddress(address: string): string {
  return address.replace(/#token=.*/, '#token=')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function listLocalTeams(cwd: string): Promise<TeamFile[]> {
  try {
    const entries = await readdir(join(cwd, '.my-claude-code', 'teams'), {
      withFileTypes: true,
    })
    const teams = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(entry => readTeamFile(cwd, entry.name)),
    )
    return teams.filter((team): team is TeamFile => Boolean(team))
  } catch {
    return []
  }
}
