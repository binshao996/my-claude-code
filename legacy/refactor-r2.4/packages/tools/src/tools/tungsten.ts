import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const TungstenInputSchema = z.object({})

type TungstenInput = z.infer<typeof TungstenInputSchema>

export const tungstenTool: Tool<TungstenInput> = {
  name: 'TungstenTool',
  description: 'Expose the upstream ant-only Tungsten tmux tool surface as disabled.',
  inputSchema: TungstenInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute() {
    return JSON.stringify(
      {
        enabled: false,
        reason: 'TungstenTool is disabled in the current upstream decompiled source.',
      },
      null,
      2,
    )
  },
}

export function clearSessionsWithTungstenUsage(): void {}

export function resetInitializationState(): void {}
