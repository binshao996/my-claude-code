import { runAuthCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const oauth_refreshCommand = createNativeCommand({
  slash: '/oauth-refresh',
  source: 'claude-code/src/commands/oauth-refresh',
  run: args => runAuthCommand({ ...args, slash: '/oauth-refresh' }),
})

export default oauth_refreshCommand
