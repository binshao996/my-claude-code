import { createHash, randomUUID } from 'node:crypto'

export type AcpLinkMessage =
  | {
      type: 'session.start'
      id: string
      sessionId: string
      cwd: string
      createdAt: string
    }
  | {
      type: 'prompt'
      id: string
      sessionId: string
      prompt: string
      createdAt: string
    }
  | {
      type: 'tool.permission'
      id: string
      sessionId: string
      toolName: string
      decision: 'allow' | 'deny'
      createdAt: string
    }
  | {
      type: 'result'
      id: string
      sessionId: string
      status: 'ok' | 'error'
      content: string
      createdAt: string
    }

export type AcpLinkSession = {
  sessionId: string
  cwd: string
  tokenHash: string
  createdAt: string
}

export function createAcpLinkSession(input: {
  cwd: string
  token?: string
  now?: Date
}): AcpLinkSession {
  return {
    sessionId: `acp_${randomUUID()}`,
    cwd: input.cwd,
    tokenHash: hashAcpSecret(input.token ?? randomUUID()),
    createdAt: (input.now ?? new Date()).toISOString(),
  }
}

export function acpSessionStartMessage(session: AcpLinkSession): AcpLinkMessage {
  return {
    type: 'session.start',
    id: `msg_${randomUUID()}`,
    sessionId: session.sessionId,
    cwd: session.cwd,
    createdAt: new Date().toISOString(),
  }
}

export function acpPromptMessage(
  sessionId: string,
  prompt: string,
): AcpLinkMessage {
  return {
    type: 'prompt',
    id: `msg_${randomUUID()}`,
    sessionId,
    prompt,
    createdAt: new Date().toISOString(),
  }
}

export function acpPermissionMessage(input: {
  sessionId: string
  toolName: string
  decision: 'allow' | 'deny'
}): AcpLinkMessage {
  return {
    type: 'tool.permission',
    id: `msg_${randomUUID()}`,
    sessionId: input.sessionId,
    toolName: input.toolName,
    decision: input.decision,
    createdAt: new Date().toISOString(),
  }
}

export function acpResultMessage(input: {
  sessionId: string
  status: 'ok' | 'error'
  content: string
}): AcpLinkMessage {
  return {
    type: 'result',
    id: `msg_${randomUUID()}`,
    sessionId: input.sessionId,
    status: input.status,
    content: input.content,
    createdAt: new Date().toISOString(),
  }
}

export function encodeAcpJsonl(messages: AcpLinkMessage[]): string {
  return `${messages.map(message => JSON.stringify(message)).join('\n')}\n`
}

export function decodeAcpJsonl(input: string): AcpLinkMessage[] {
  return input
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => validateAcpMessage(JSON.parse(line) as Record<string, unknown>))
}

export function hashAcpSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

function validateAcpMessage(message: Record<string, unknown>): AcpLinkMessage {
  if (
    typeof message.id !== 'string' ||
    typeof message.sessionId !== 'string' ||
    typeof message.createdAt !== 'string'
  ) {
    throw new Error('invalid ACP JSONL message envelope')
  }

  switch (message.type) {
    case 'session.start':
      if (typeof message.cwd !== 'string') {
        throw new Error('invalid ACP session.start message')
      }
      return message as AcpLinkMessage
    case 'prompt':
      if (typeof message.prompt !== 'string') {
        throw new Error('invalid ACP prompt message')
      }
      return message as AcpLinkMessage
    case 'tool.permission':
      if (
        typeof message.toolName !== 'string' ||
        (message.decision !== 'allow' && message.decision !== 'deny')
      ) {
        throw new Error('invalid ACP tool.permission message')
      }
      return message as AcpLinkMessage
    case 'result':
      if (
        typeof message.content !== 'string' ||
        (message.status !== 'ok' && message.status !== 'error')
      ) {
        throw new Error('invalid ACP result message')
      }
      return message as AcpLinkMessage
    default:
      throw new Error(`unsupported ACP JSONL message type: ${String(message.type)}`)
  }
}

export const acpLinkMirror = {
  upstream: 'claude-code/packages/acp-link',
  local: 'packages/acp-link/src/index.ts',
  status: 'r1.9-remote-bridge-daemon-acp-mirror',
  golden: 'docs/refactor/golden/transports/r1.9-remote-bridge-acp-golden.json',
} as const
