import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const ExitPlanModeInputSchema = z.object({
  plan: z.string().min(1).optional(),
})

type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>

export const exitPlanModeV2Tool: Tool<ExitPlanModeInput> = {
  name: 'ExitPlanModeV2',
  description: 'Exit plan mode after presenting or accepting a plan.',
  inputSchema: ExitPlanModeInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'Plan summary.' },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions() {
    return { decision: 'allow' }
  },
  async execute(input) {
    return input.plan ? `Exited plan mode with plan:\n${input.plan}` : 'Exited plan mode'
  },
}
