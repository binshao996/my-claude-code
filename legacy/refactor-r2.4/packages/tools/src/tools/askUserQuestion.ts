import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const AskUserQuestionInputSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
})

type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>

export const askUserQuestionTool: Tool<AskUserQuestionInput> = {
  name: 'AskUserQuestion',
  description: 'Ask the user a clarifying question. In headless mode this returns an unavailable result.',
  inputSchema: AskUserQuestionInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Question to ask the user.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional answer choices.',
      },
    },
    required: ['question'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions() {
    return { decision: 'allow' }
  },
  async execute(input) {
    const options = input.options?.length
      ? ` Options: ${input.options.join(' | ')}`
      : ''
    return `Headless mode cannot ask the user interactively. Question: ${input.question}${options}`
  },
}
