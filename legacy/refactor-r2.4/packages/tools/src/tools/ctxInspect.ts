import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const CtxInspectInputSchema = z.object({
  query: z.string().min(1).optional(),
})

type CtxInspectInput = z.infer<typeof CtxInspectInputSchema>

export const ctxInspectTool: Tool<CtxInspectInput> = {
  name: 'CtxInspect',
  description: 'Inspect current runtime context size, permissions, session, and available deferred tools.',
  inputSchema: CtxInspectInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional focus string to include in the context summary.',
      },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async (input, context) => {
    const contextMessages = Array.isArray((context as { messages?: unknown[] }).messages)
      ? ((context as { messages?: unknown[] }).messages ?? [])
      : []
    const serialized = JSON.stringify(contextMessages)
    const estimatedTokens = Math.ceil(serialized.length / 4)
    return JSON.stringify({
      total_tokens: estimatedTokens,
      message_count: contextMessages.length,
      context_window_model: 'runtime-default',
      prompt_caching_enabled: true,
      session_memory_enabled: Boolean(context.sessionId),
      context_collapse_enabled: true,
      memory_ranking_enabled: true,
      provider_cache_break_detection_enabled: true,
      summary: [
        input.query ? `Focus: ${input.query}` : 'Overall context summary',
        `Session: ${context.sessionId ?? '(none)'}`,
        `Permission mode: ${context.permissionMode}`,
        `Allowed tools: ${(context.allowedTools ?? []).join(', ') || '(default)'}`,
        `Disallowed tools: ${(context.disallowedTools ?? []).join(', ') || '(none)'}`,
        `Deferred tools: ${context.deferredTools?.length ?? 0}`,
      ].join('\n'),
    }, null, 2)
  },
}
