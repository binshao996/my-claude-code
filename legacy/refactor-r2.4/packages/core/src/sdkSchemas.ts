import { z } from 'zod/v4'
import {
  MessageSchema,
  PermissionDecisionSchema,
  QueryEventSchema,
  ToolExecutionEventSchema,
  UsageSchema,
} from './protocol.js'

export const SDKModelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadInputTokens: z.number().nonnegative().default(0),
  cacheCreationInputTokens: z.number().nonnegative().default(0),
  webSearchRequests: z.number().nonnegative().default(0),
  costUSD: z.number().nonnegative().default(0),
  contextWindow: z.number().nonnegative().default(0),
  maxOutputTokens: z.number().nonnegative().default(0),
})

export const SDKOutputFormatSchema = z.object({
  type: z.literal('json_schema'),
  schema: z.record(z.string(), z.unknown()),
})

export const SDKMcpServerConfigSchema = z.union([
  z.object({
    type: z.literal('stdio').optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('sdk'),
    name: z.string(),
  }),
])

export const SDKPermissionModeSchema = z.enum([
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
])

export const SDKPermissionUpdateSchema = z.object({
  type: z.enum(['addRules', 'replaceRules', 'removeRules']),
  rules: z.array(z.string()),
  behavior: z.enum(['allow', 'deny']).optional(),
})

export const SDKToolUseSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})

export const SDKUserMessageSchema = z.object({
  type: z.literal('user'),
  message: MessageSchema.extend({
    role: z.literal('user'),
  }),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
})

export const SDKAssistantMessageSchema = z.object({
  type: z.literal('assistant'),
  message: MessageSchema.extend({
    role: z.literal('assistant'),
  }),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  usage: UsageSchema.optional(),
})

export const SDKSystemMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(),
  message: MessageSchema.extend({
    role: z.literal('system'),
  }),
})

export const SDKResultMessageSchema = z.object({
  type: z.literal('result'),
  subtype: z.enum(['success', 'error']),
  is_error: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

export const SDKStreamMessageSchema = z.union([
  SDKUserMessageSchema,
  SDKAssistantMessageSchema,
  SDKSystemMessageSchema,
  SDKResultMessageSchema,
])

export const SDKControlInitializeRequestSchema = z.object({
  subtype: z.literal('initialize'),
  hooks: z.record(z.string(), z.unknown()).optional(),
  sdkMcpServers: z.array(z.string()).optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  systemPrompt: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  promptSuggestions: z.boolean().optional(),
  agentProgressSummaries: z.boolean().optional(),
})

export const SDKControlPermissionRequestSchema = z.object({
  subtype: z.literal('can_use_tool'),
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string(),
  permission_suggestions: z.array(SDKPermissionUpdateSchema).optional(),
  decision_reason: z.string().optional(),
  description: z.string().optional(),
})

export const SDKControlRequestPayloadSchema = z.discriminatedUnion('subtype', [
  SDKControlInitializeRequestSchema,
  z.object({ subtype: z.literal('interrupt') }),
  SDKControlPermissionRequestSchema,
  z.object({
    subtype: z.literal('set_permission_mode'),
    mode: SDKPermissionModeSchema,
  }),
  z.object({
    subtype: z.literal('set_model'),
    model: z.string().optional(),
  }),
  z.object({
    subtype: z.literal('mcp_status'),
  }),
  z.object({
    subtype: z.literal('get_context_usage'),
  }),
])

export const SDKControlRequestSchema = z.object({
  type: z.literal('control_request'),
  request_id: z.string(),
  request: SDKControlRequestPayloadSchema,
})

export const SDKControlResponseSchema = z.object({
  type: z.literal('control_response'),
  request_id: z.string(),
  response: z.unknown().optional(),
  error: z.string().optional(),
})

export const SDKPermissionResponseSchema = z.object({
  behavior: PermissionDecisionSchema,
  updatedInput: z.record(z.string(), z.unknown()).optional(),
})

export const SDKStdoutMessageSchema = z.union([
  QueryEventSchema,
  ToolExecutionEventSchema,
  SDKStreamMessageSchema,
  SDKControlRequestSchema,
  z.object({ type: z.literal('keep_alive') }),
])

export const SDKStdinMessageSchema = z.union([
  SDKUserMessageSchema,
  SDKControlResponseSchema,
])

export const SDKToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
})

export const SandboxPermissionRequestSchema = z.object({
  type: z.literal('sandbox_permission_request'),
  id: z.string(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  network: z.boolean().optional(),
})

export const SandboxPermissionResponseSchema = z.object({
  type: z.literal('sandbox_permission_response'),
  id: z.string(),
  decision: PermissionDecisionSchema,
  reason: z.string().optional(),
})

export function parseSDKStdinMessage(value: unknown): SDKStdinMessage {
  return SDKStdinMessageSchema.parse(value)
}

export function parseSDKStdoutMessage(value: unknown): SDKStdoutMessage {
  return SDKStdoutMessageSchema.parse(value)
}

export type SDKModelUsage = z.infer<typeof SDKModelUsageSchema>
export type SDKOutputFormat = z.infer<typeof SDKOutputFormatSchema>
export type SDKMcpServerConfig = z.infer<typeof SDKMcpServerConfigSchema>
export type SDKPermissionMode = z.infer<typeof SDKPermissionModeSchema>
export type SDKPermissionUpdate = z.infer<typeof SDKPermissionUpdateSchema>
export type SDKUserMessage = z.infer<typeof SDKUserMessageSchema>
export type SDKAssistantMessage = z.infer<typeof SDKAssistantMessageSchema>
export type SDKStreamMessage = z.infer<typeof SDKStreamMessageSchema>
export type SDKControlRequest = z.infer<typeof SDKControlRequestSchema>
export type SDKControlResponse = z.infer<typeof SDKControlResponseSchema>
export type SDKStdinMessage = z.infer<typeof SDKStdinMessageSchema>
export type SDKStdoutMessage = z.infer<typeof SDKStdoutMessageSchema>
export type SDKTool = z.infer<typeof SDKToolSchema>
