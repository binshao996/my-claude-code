import { runPluginCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const pluginCommand = createNativeCommand({
  slash: '/plugin',
  source: 'claude-code/src/commands/plugin',
  run: runPluginCommand,
})

export default pluginCommand
