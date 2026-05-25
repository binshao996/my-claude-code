import { runBackfillSessionsCommand } from '../_shared/coreCommands.js'
import { createNativeCommand } from '../_shared/nativeCommand.js'

export const backfill_sessionsCommand = createNativeCommand({
  slash: '/backfill-sessions',
  source: 'claude-code/src/commands/backfill-sessions',
  run: runBackfillSessionsCommand,
})

export default backfill_sessionsCommand
