import { runWorkflowDiagnosticCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const ant_traceCommand = createNativeCommand({
  slash: '/ant-trace',
  source: 'claude-code/src/commands/ant-trace',
  run: args => runWorkflowDiagnosticCommand({ ...args, slash: '/ant-trace' }),
})

export default ant_traceCommand
