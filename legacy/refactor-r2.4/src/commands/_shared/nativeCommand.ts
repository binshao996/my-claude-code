import {
  SLASH_COMMAND_ARGUMENT_DESCRIPTIONS,
  SLASH_COMMAND_DESCRIPTIONS,
} from '../../../packages/commands/src/slashCommands.js'
import type { CommandMirror, CommandMirrorRunArgs } from './launchCommand.js'

export function createNativeCommand(args: {
  slash: string
  source: string
  name?: string
  description?: string
  run(args: CommandMirrorRunArgs): Promise<{ exitRequested: boolean; additionalDirectories?: string[] }>
}): CommandMirror {
  const slash = args.slash
  return {
    name: args.name ?? slash.replace(/^\//, ''),
    slash,
    source: args.source,
    description:
      args.description ??
      SLASH_COMMAND_DESCRIPTIONS[slash] ??
      'Upstream Claude Code command',
    arguments: SLASH_COMMAND_ARGUMENT_DESCRIPTIONS[slash] ?? {},
    isEnabled: () => true,
    run: args.run,
  }
}
