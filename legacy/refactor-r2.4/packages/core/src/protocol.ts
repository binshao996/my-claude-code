import { z } from 'zod/v4'

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const ImageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string().min(1),
  }),
})

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
})

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(TextBlockSchema)]).optional(),
  is_error: z.boolean().optional(),
})

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().default(''),
})

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ImageBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ThinkingBlockSchema,
])

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])

export const MessageSchema = z.object({
  id: z.string().optional(),
  role: MessageRoleSchema,
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
})

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
})

export const CompactMetadataSchema = z.object({
  boundary: z.boolean().optional(),
  summary: z.string().optional(),
  trigger: z.string().optional(),
})

export const StopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
  'error',
])

export const QueryEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: z.object({
      id: z.string(),
      role: z.literal('assistant'),
      model: z.string().optional(),
      usage: UsageSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number().int().nonnegative(),
    content_block: ContentBlockSchema,
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number().int().nonnegative(),
    delta: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('text_delta'),
        text: z.string(),
      }),
      z.object({
        type: z.literal('input_json_delta'),
        partial_json: z.string(),
      }),
      z.object({
        type: z.literal('thinking_delta'),
        thinking: z.string(),
      }),
    ]),
  }),
  z.object({
    type: z.literal('content_block_stop'),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({
      stop_reason: StopReasonSchema.optional(),
      stop_sequence: z.string().nullable().optional(),
    }),
    usage: UsageSchema.optional(),
  }),
  z.object({
    type: z.literal('message_stop'),
  }),
  z.object({
    type: z.literal('error'),
    error: z.object({
      type: z.string(),
      message: z.string(),
    }),
  }),
])

export const TerminalStatusSchema = z.enum([
  'completed',
  'model_error',
  'tool_error',
  'hook_blocked',
  'aborted_streaming',
  'max_turns',
  'prompt_too_long',
])

export const TerminalEventSchema = z.object({
  type: z.literal('terminal'),
  status: TerminalStatusSchema,
  exitCode: z.number().int(),
  reason: z.string().optional(),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
})

export const ContinueEventSchema = z.object({
  type: z.literal('continue'),
  reason: z.enum(['tool_use', 'max_tokens', 'user_request']),
})

export const PermissionDecisionSchema = z.enum(['allow', 'deny', 'ask'])

export const ToolExecutionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool_execution_start'),
    tool_use_id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_execution_result'),
    tool_use_id: z.string().min(1),
    name: z.string().min(1),
    content: z.string(),
    is_error: z.boolean().default(false),
    permission_decision: PermissionDecisionSchema.optional(),
  }),
])

export const TranscriptRecordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  created_at: z.string().datetime(),
  event: z.union([QueryEventSchema, TerminalEventSchema, ToolExecutionEventSchema]),
  uuid: z.string().min(1).optional(),
  parentUuid: z.string().min(1).nullable().optional(),
  logicalParentUuid: z.string().min(1).nullable().optional(),
  isSidechain: z.boolean().optional(),
  compact: CompactMetadataSchema.optional(),
  promptStateHash: z.string().min(1).optional(),
})

export type TextBlock = z.infer<typeof TextBlockSchema>
export type ImageBlock = z.infer<typeof ImageBlockSchema>
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>
export type ContentBlock = z.infer<typeof ContentBlockSchema>
export type MessageRole = z.infer<typeof MessageRoleSchema>
export type Message = z.infer<typeof MessageSchema>
export type Usage = z.infer<typeof UsageSchema>
export type CompactMetadata = z.infer<typeof CompactMetadataSchema>
export type StopReason = z.infer<typeof StopReasonSchema>
export type QueryEvent = z.infer<typeof QueryEventSchema>
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>
export type TerminalEvent = z.infer<typeof TerminalEventSchema>
export type ContinueEvent = z.infer<typeof ContinueEventSchema>
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>
export type ToolExecutionEvent = z.infer<typeof ToolExecutionEventSchema>
export type TranscriptRecord = z.infer<typeof TranscriptRecordSchema>

export function parseQueryEvent(value: unknown): QueryEvent {
  return QueryEventSchema.parse(value)
}

export function parseTranscriptRecord(value: unknown): TranscriptRecord {
  return TranscriptRecordSchema.parse(value)
}
