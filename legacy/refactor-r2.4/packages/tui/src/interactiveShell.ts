import { randomUUID } from 'node:crypto'
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process'
import { createInterface } from 'node:readline'
import { query, textDeltaFromEvent } from '@my-claude-code/agent-runtime'
import { runSlashCommand } from '@my-claude-code/commands'
import { sessionContextStats } from '@my-claude-code/session'
import { DEFAULT_INTERACTIVE_MAX_TURNS } from './tuiTypes.js'

export type InteractiveShellOptions = {
  model?: string
  maxTurns?: number
  permissionMode?: string
  systemPrompt?: string
  appendSystemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  userContext?: string
  sessionId?: string
  transcriptPath?: string
  additionalDirectories?: string[]
  vimMode?: boolean
  cwd?: string
  version?: string
  queryRuntime?: typeof query
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export async function runInteractiveShell(
  options: InteractiveShellOptions = {},
): Promise<void> {
  const input = options.input ?? defaultInput
  const output = options.output ?? defaultOutput
  const readline = createInterface({ input, terminal: false })
  const cwd = options.cwd ?? process.cwd()
  const sessionId = options.sessionId ?? randomUUID()
  const queryRuntime = options.queryRuntime ?? query
  let userContext = options.userContext

  output.write('my-claude-code interactive shell\n')
  output.write(`Session ${sessionId}\n`)
  output.write('Type /help for commands, /exit to quit.\n')
  output.write('> ')

  try {
    for await (const line of readline) {
      const prompt = line.trim()
      if (!prompt) {
        output.write('> ')
        continue
      }

      if (prompt.startsWith('/')) {
        try {
          const result = await runSlashCommand({
            command: prompt,
            options: {
              model: options.model,
              permissionMode: options.permissionMode,
              allowedTools: options.allowedTools,
              disallowedTools: options.disallowedTools,
              sessionId,
              vimMode: options.vimMode,
            },
            io: {
              stdout: output,
              stderr: output,
            },
            cwd,
            version: options.version ?? '1.0.0',
          })
          if (result.exitRequested) {
            return
          }
        } catch (error) {
          output.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
        }
        output.write('> ')
        continue
      }

      for await (const event of queryRuntime({
        prompt,
        cwd,
        model: options.model,
        maxTurns: options.maxTurns ?? DEFAULT_INTERACTIVE_MAX_TURNS,
        permissionMode: options.permissionMode,
        systemPrompt: options.systemPrompt,
        appendSystemPrompt: options.appendSystemPrompt,
        allowedTools: options.allowedTools,
        disallowedTools: options.disallowedTools,
        userContext,
        sessionId,
        transcriptPath: options.transcriptPath,
        additionalDirectories: options.additionalDirectories,
      })) {
        if (event.type === 'terminal') {
          if (event.exitCode !== 0) {
            output.write(`error: ${event.reason ?? event.status}\n`)
          }
          continue
        }

        if (
          event.type === 'tool_execution_start' ||
          event.type === 'tool_execution_result'
        ) {
          output.write(`[${event.name}] ${event.type === 'tool_execution_start' ? 'running' : 'done'}\n`)
          continue
        }

        const text = textDeltaFromEvent(event)
        if (text) {
          output.write(text)
        }
      }

      output.write('\n')
      userContext = (await sessionContextStats(cwd, sessionId))?.summary ?? userContext
      output.write('> ')
    }
  } finally {
    readline.close()
  }
}
