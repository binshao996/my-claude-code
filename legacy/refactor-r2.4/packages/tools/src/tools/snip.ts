import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const SnipInputSchema = z.object({
  message_ids: z.array(z.string().min(1)),
  reason: z.string().optional(),
})

type SnipInput = z.infer<typeof SnipInputSchema>

export const snipTool: Tool<SnipInput> = {
  name: 'Snip',
  description: 'Record intent to snip messages from provider context and replace them with a compact summary.',
  inputSchema: SnipInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      message_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Message ids to snip from history.',
      },
      reason: {
        type: 'string',
        description: 'Reason or summary for the snipped messages.',
      },
    },
    required: ['message_ids'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async input =>
    JSON.stringify({
      snipped_count: input.message_ids.length,
      summary: input.reason ?? `Snipped ${input.message_ids.length} messages`,
    }, null, 2),
}
