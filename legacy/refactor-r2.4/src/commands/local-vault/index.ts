import { runLocalVaultCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const local_vaultCommand = createNativeCommand({
  slash: '/local-vault',
  source: 'claude-code/src/commands/local-vault',
  run: args => runLocalVaultCommand({ ...args, slash: '/local-vault' }),
})

export default local_vaultCommand
