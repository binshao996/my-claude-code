import { runSkillStoreCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const skill_storeCommand = createNativeCommand({
  slash: '/skill-store',
  source: 'claude-code/src/commands/skill-store',
  run: runSkillStoreCommand,
})

export default skill_storeCommand
