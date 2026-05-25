import type { SDKPermissionMode } from './sdkSchemas.js'

export type {
  SDKAssistantMessage,
  SDKControlRequest,
  SDKControlResponse,
  SDKMcpServerConfig,
  SDKModelUsage,
  SDKOutputFormat,
  SDKPermissionMode,
  SDKPermissionUpdate,
  SDKStdinMessage,
  SDKStdoutMessage,
  SDKStreamMessage,
  SDKTool,
  SDKUserMessage,
} from './sdkSchemas.js'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type SandboxPolicy = {
  mode: SandboxMode
  networkAccess: boolean
  writableRoots: string[]
}

export type AgentSDKOptions = {
  cwd?: string
  model?: string
  permissionMode?: SDKPermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
  systemPrompt?: string
  appendSystemPrompt?: string
}
