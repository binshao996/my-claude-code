import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const SyntheticOutputInputSchema = z.object({
  content: z.string(),
})

type SyntheticOutputInput = z.infer<typeof SyntheticOutputInputSchema>

export const syntheticOutputTool: Tool<SyntheticOutputInput> = {
  name: 'SyntheticOutput',
  description: 'Return synthetic output for runtime and fixture flows.',
  inputSchema: SyntheticOutputInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Synthetic content to return.' },
    },
    required: ['content'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions() {
    return { decision: 'allow' }
  },
  async execute(input) {
    return input.content
  },
}
