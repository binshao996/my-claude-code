import { runWorkflowDiagnosticCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const ctx_vizCommand = createNativeCommand({
  slash: '/ctx_viz',
  source: 'claude-code/src/commands/ctx_viz',
  run: args => runWorkflowDiagnosticCommand({ ...args, slash: '/ctx_viz' }),
})

export default ctx_vizCommand
