import { runWorkflowDiagnosticCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const bughunterCommand = createNativeCommand({
  slash: '/bughunter',
  source: 'claude-code/src/commands/bughunter',
  run: args => runWorkflowDiagnosticCommand({ ...args, slash: '/bughunter' }),
})

export default bughunterCommand
