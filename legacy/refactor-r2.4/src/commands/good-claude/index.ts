import { runWorkflowDiagnosticCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const good_claudeCommand = createNativeCommand({
  slash: '/good-claude',
  source: 'claude-code/src/commands/good-claude',
  run: args => runWorkflowDiagnosticCommand({ ...args, slash: '/good-claude' }),
})

export default good_claudeCommand
