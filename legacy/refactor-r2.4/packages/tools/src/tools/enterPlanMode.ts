import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const EnterPlanModeInputSchema = z.object({
  reason: z.string().optional(),
})

type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>

export const enterPlanModeTool: Tool<EnterPlanModeInput> = {
  name: 'EnterPlanMode',
  description: 'Enter plan mode before making changes.',
  inputSchema: EnterPlanModeInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why plan mode is needed.' },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions() {
    return { decision: 'allow' }
  },
  async execute(input) {
    return `Entered plan mode${input.reason ? `: ${input.reason}` : ''}`
  },
}
