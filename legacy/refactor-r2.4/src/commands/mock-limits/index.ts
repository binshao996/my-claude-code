import { runMockLimitsCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const mock_limitsCommand = createNativeCommand({
  slash: '/mock-limits',
  source: 'claude-code/src/commands/mock-limits',
  run: runMockLimitsCommand,
})

export default mock_limitsCommand
