import type {
  PermissionDecision,
  ToolExecutionEvent,
  ToolResultBlock,
  ToolUseBlock,
} from '@my-claude-code/core'
import type { z } from 'zod/v4'

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'

export type PermissionCheck = {
  decision: PermissionDecision
  reason?: string
}

export type ToolInput = Record<string, unknown>

export type ToolExecutionContext = {
  cwd: string
  permissionMode: PermissionMode
  sessionId?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  deferredTools?: Tool[]
  signal?: AbortSignal
  fileSnapshotRecorder?: FileSnapshotRecorder
  permissionPrompt?: PermissionPrompt
  preToolUseHooks?: PreToolUseHook[]
  postToolUseHooks?: PostToolUseHook[]
}

export type FileSnapshotRecorder = (request: {
  tool: Tool
  toolUse: ToolUseBlock
  input: ToolInput
  context: ToolExecutionContext
  filePath: string
}) => void | Promise<void>

export type PermissionPrompt = (request: {
  tool: Tool
  input: ToolInput
  reason?: string
  context: ToolExecutionContext
}) => PermissionCheck | undefined | Promise<PermissionCheck | undefined>

export type PreToolUseHook = (request: {
  tool: Tool
  toolUse: ToolUseBlock
  input: ToolInput
  context: ToolExecutionContext
}) => PermissionCheck | undefined | Promise<PermissionCheck | undefined>

export type PostToolUseHook = (request: {
  tool: Tool
  toolUse: ToolUseBlock
  input: ToolInput
  result: ToolResult
  context: ToolExecutionContext
}) => ToolResult | undefined | Promise<ToolResult | undefined>

export type ToolResult = {
  tool_use_id: string
  name: string
  content: string
  is_error?: boolean
  permission_decision?: PermissionDecision
}

export type Tool<TInput extends ToolInput = ToolInput> = {
  name: string
  description: string
  inputSchema: z.ZodType<TInput>
  inputJSONSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  isReadOnly(input: TInput): boolean
  isDestructive(input: TInput): boolean
  isConcurrencySafe(input: TInput): boolean
  checkPermissions(
    input: TInput,
    context: ToolExecutionContext,
  ): PermissionCheck | Promise<PermissionCheck>
  execute(input: TInput, context: ToolExecutionContext): Promise<string>
}

export function toToolResultBlock(result: ToolResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: result.tool_use_id,
    content: result.content,
    is_error: result.is_error,
  }
}

export function toolExecutionResultEvent(
  result: ToolResult,
): ToolExecutionEvent {
  return {
    type: 'tool_execution_result',
    tool_use_id: result.tool_use_id,
    name: result.name,
    content: result.content,
    is_error: result.is_error ?? false,
    permission_decision: result.permission_decision,
  }
}
