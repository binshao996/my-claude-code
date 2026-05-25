import { runLocalMemoryCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const local_memoryCommand = createNativeCommand({
  slash: '/local-memory',
  source: 'claude-code/src/commands/local-memory',
  run: runLocalMemoryCommand,
})

export default local_memoryCommand
