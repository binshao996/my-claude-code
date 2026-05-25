import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const TestingPermissionInputSchema = z.object({
  decision: z.enum(['allow', 'deny', 'ask']).default('ask'),
  content: z.string().optional(),
})

type TestingPermissionInput = z.infer<typeof TestingPermissionInputSchema>

export const testingPermissionTool: Tool<TestingPermissionInput> = {
  name: 'TestingPermission',
  description: 'Test-only permission fixture tool for permission flow coverage.',
  inputSchema: TestingPermissionInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['allow', 'deny', 'ask'] },
      content: { type: 'string' },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions(input) {
    return {
      decision: input.decision,
      reason: input.decision === 'allow' ? undefined : `TestingPermission ${input.decision}`,
    }
  },
  async execute(input) {
    return input.content ?? 'TestingPermission executed'
  },
}
