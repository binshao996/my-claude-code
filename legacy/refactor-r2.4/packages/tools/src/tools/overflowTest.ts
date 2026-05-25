import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const OverflowTestInputSchema = z.object({
  tokenCount: z.number().int().positive().max(100_000).default(4096),
  marker: z.string().min(1).optional(),
})

export const overflowTestTool: Tool<z.infer<typeof OverflowTestInputSchema>> = {
  name: 'OverflowTest',
  description: 'Generate a bounded synthetic overflow payload for local context-limit tests.',
  inputSchema: OverflowTestInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      tokenCount: { type: 'number' },
      marker: { type: 'string' },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async input => {
    const marker = input.marker ?? 'overflow'
    const requestedTokens = input.tokenCount
    const preview = Array.from({ length: Math.min(requestedTokens, 64) }, (_, index) =>
      `${marker}_${index}`,
    ).join(' ')

    return JSON.stringify({
      kind: 'overflow-test',
      requestedTokens,
      previewTokens: Math.min(requestedTokens, 64),
      truncated: requestedTokens > 64,
      preview,
    }, null, 2)
  },
}
