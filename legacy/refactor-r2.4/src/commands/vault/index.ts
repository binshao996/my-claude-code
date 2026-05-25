import { runLocalVaultCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const vaultCommand = createNativeCommand({
  slash: '/vault',
  source: 'claude-code/src/commands/vault',
  run: args => runLocalVaultCommand({ ...args, slash: '/vault' }),
})

export default vaultCommand
