import type { query } from '@my-claude-code/agent-runtime'
import type { Message } from '@my-claude-code/core'

export const DEFAULT_INTERACTIVE_MAX_TURNS = 25

export type TuiMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'error'

export type TuiMessage = {
  id: string
  role: TuiMessageRole
  text: string
}

export type PermissionNotice = {
  tool: string
  decision: string
  reason: string
}

export type PermissionRequest = {
  tool: string
  reason: string
  input: Record<string, unknown>
}

export type TuiStatus = 'idle' | 'running' | 'aborting'

export type TuiRuntimeOptions = {
  model?: string
  maxTurns?: number
  permissionMode?: string
  systemPrompt?: string
  appendSystemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  userContext?: string
  messages?: Message[]
  sessionId?: string
  transcriptPath?: string
  additionalDirectories?: string[]
  pluginDirs?: string[]
  vimMode?: boolean
  cwd?: string
  version?: string
  queryRuntime?: typeof query
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}
