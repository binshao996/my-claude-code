import { runWorkflowDiagnosticCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const reviewCommand = createNativeCommand({
  slash: '/review',
  source: 'claude-code/src/commands/review',
  run: args => runWorkflowDiagnosticCommand({ ...args, slash: '/review' }),
})

export default reviewCommand
