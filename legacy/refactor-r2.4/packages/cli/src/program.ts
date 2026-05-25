import {
  Command as CommanderCommand,
  CommanderError,
} from '@commander-js/extra-typings'
import { readFile } from 'node:fs/promises'
import {
  DEFAULT_SYSTEM_PROMPT,
  query,
  textDeltaFromEvent,
} from '@my-claude-code/agent-runtime'
import type { QueryEvent, ToolExecutionEvent } from '@my-claude-code/core'
import {
  resolveResumeContext,
  runSlashCommand,
} from '@my-claude-code/commands'
import {
  createDeepSeekCompatibilitySpikeResult,
  runDeepSeekLiveCompatibilitySpike,
} from '@my-claude-code/model-provider'
import { loadSettings } from '@my-claude-code/settings'
import { runTerminalApp } from '@my-claude-code/tui'
import { loadDevelopmentEnv } from './devEnv.js'
import { startMcpEntrypoint } from './mcpEntrypoint.js'
import { CLI_NAME, PRODUCT_NAME, VERSION } from './version.js'

export type WritableStreamLike = {
  write(chunk: string): void
}

export type CliIO = {
  stdout: WritableStreamLike
  stderr: WritableStreamLike
}

export type CliRuntime = {
  query: typeof query
}

type OutputFormat = 'text' | 'json' | 'stream-json'
type InputFormat = 'text' | 'stream-json'

export function createProgram(
  io: CliIO,
  runtime: CliRuntime = {
    query,
  },
): CommanderCommand {
  loadDevelopmentEnv()

  const program = new CommanderCommand()

  program
    .name(CLI_NAME)
    .description('Claude Code-like coding agent')
    .version(`${VERSION} (${PRODUCT_NAME})`, '-v, --version', 'Output the version number')
    .helpOption('-h, --help', 'Display help for command')
    .argument('[prompt...]', 'Prompt for headless print mode or slash command')
    .configureOutput({
      writeOut: message => io.stdout.write(message),
      writeErr: message => io.stderr.write(message),
      outputError: (message, write) => write(`error: ${message}`),
    })
    .exitOverride()
    .option('-p, --print [prompt]', 'Print mode (headless)')
    .option('--output-format <format>', 'Print mode output format: text, json, or stream-json', parseOutputFormat)
    .option('--input-format <format>', 'Print mode input format: text or stream-json', parseInputFormat)
    .option('--json-schema <schema>', 'JSON schema string for structured print mode output', parseJsonSchema)
    .option('--include-partial-messages', 'Include partial assistant deltas in stream-json output')
    .option('--include-hook-events', 'Include non-message runtime events in stream-json output')
    .option('--model <model>', 'Override which model is used')
    .option('--system-prompt <prompt>', 'Override the default system prompt')
    .option('--system-prompt-file <path>', 'Read the system prompt override from a file')
    .option('--append-system-prompt <prompt>', 'Append extra text to the system prompt')
    .option('--append-system-prompt-file <path>', 'Append extra system prompt text from a file')
    .option('--dump-system-prompt', 'Print the effective system prompt and exit')
    .option('--max-turns <n>', 'Maximum number of query loop turns', parsePositiveInteger)
    .option('--permission-mode <mode>', 'Permission mode for tool execution')
    .option('--allowed-tools <tools>', 'Comma-separated allowed tool rules', parseCommaList)
    .option('--tools <tools>', 'Alias for --allowed-tools', parseCommaList)
    .option('--disallowed-tools <tools>', 'Comma-separated disallowed tool rules', parseCommaList)
    .option('--continue', 'Continue the latest session')
    .option('--resume [sessionId]', 'Resume a session by id, or latest when omitted')
    .option('--session-id <id>', 'Use an explicit session id')
    .option('--vim', 'Enable Vim keybindings in the interactive TTY prompt')
    .option('--no-vim', 'Disable Vim keybindings in the interactive TTY prompt')
    .option('--fork', 'Fork a session when used with /resume <sessionId>')
    .option('--rewind [recordId]', 'Rewind a session when used with /resume <sessionId>')
    .option(
      '--rewind-files [recordId]',
      'Restore file snapshots when used with /resume <sessionId>',
    )
    .option('--checkpoints', 'List transcript checkpoints when used with /resume <sessionId>')
    .option('--full', 'Run full ecosystem parity when used with /parity')
    .option('--full-ecosystem', 'Alias for --full when used with /parity')
    .option('--strict', 'Run strict source-level parity when used with /parity')
    .option('--remote', 'Run remote parity checks when used with /parity')
    .option('--tui', 'Run TUI/Ink parity checks when used with /parity')
    .option('--platform', 'Run browser/computer-use/IDE/platform parity checks when used with /parity')
    .option('--voice', 'Run voice/audio/notification parity checks when used with /parity')
    .option('--memory', 'Run memory/context/vault/team parity checks when used with /parity')
    .option('--agent-workflows', 'Run agent workflow/review/automation parity checks when used with /parity')
    .option('--source-inventory', 'Run V2.1 source inventory closure parity checks when used with /parity')
    .option('--add-dir <dirs>', 'Comma-separated additional directories', parseCommaList)
    .option('--plugin-dir <dirs>', 'Comma-separated local plugin directories', parseCommaList)
    .option('--transcript-path <path>', 'Write transcript JSONL to this path')
    .option('--mcp', 'Run the stdio MCP server entrypoint')
    .option('--compatibility-spike', 'Print V0.1 DeepSeek compatibility spike result as JSON')
    .option(
      '--compatibility-spike-live',
      'Run live DeepSeek compatibility spike using DEEPSEEK_API_KEY',
    )
    .action(async (promptArg, options) => {
      const prompt = normalizePromptArg(promptArg)

      if (options.mcp) {
        await startMcpEntrypoint({
          cwd: process.cwd(),
          io,
        })
        return
      }

      if (options.compatibilitySpike) {
        io.stdout.write(
          `${JSON.stringify(createDeepSeekCompatibilitySpikeResult(), null, 2)}\n`,
        )
        return
      }

      if (options.compatibilitySpikeLive) {
        io.stdout.write(
          `${JSON.stringify(await runDeepSeekLiveCompatibilitySpike(), null, 2)}\n`,
        )
        return
      }

      const systemPromptOptions = await resolveSystemPromptOptionValues(options)

      if (options.dumpSystemPrompt) {
        io.stdout.write(`${renderDumpedSystemPrompt(systemPromptOptions)}\n`)
        return
      }

      const slashCommand = prompt?.startsWith('/')
        ? prompt
        : normalizeTopLevelSlashCommand(prompt)

      if (slashCommand) {
        await runSlashCommand({
          command: appendSlashCommandFlags(slashCommand, options),
          options: {
            ...options,
            vimMode: options.vim,
          },
          io,
          cwd: process.cwd(),
          version: VERSION,
        })
        return
      }

      if (options.print !== undefined) {
        await runPrintMode({
          prompt:
            typeof options.print === 'string'
              ? options.print
              : prompt,
          options: {
            ...options,
            ...systemPromptOptions,
          },
          io,
          runtime,
        })
        return
      }

      const settings = await loadSettings()
      const resume = await resolveResumeContext({
        cwd: process.cwd(),
        continueLatest: options.continue,
        resume: options.resume,
        sessionId: options.sessionId,
      })
      await runTerminalApp({
        model: options.model ?? settings.model,
        maxTurns: options.maxTurns,
        permissionMode: options.permissionMode ?? settings.permissionMode,
        allowedTools: options.allowedTools ?? options.tools ?? settings.allowedTools,
        disallowedTools: options.disallowedTools ?? settings.disallowedTools,
        userContext: resume?.summary,
        messages: resume?.providerMessages,
        sessionId: resume?.session.id ?? options.sessionId,
        transcriptPath: resume?.session.transcriptPath ?? options.transcriptPath,
        additionalDirectories: options.addDir,
        pluginDirs: options.pluginDir,
        systemPrompt: systemPromptOptions.systemPrompt,
        appendSystemPrompt: systemPromptOptions.appendSystemPrompt,
        vimMode: options.vim ?? settings.vimMode,
        version: VERSION,
      })
    })

  return program
}

export async function runCli(
  argv = process.argv,
  io: CliIO = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
  runtime?: CliRuntime,
): Promise<number> {
  const program = createProgram(io, runtime)

  try {
    await program.parseAsync(argv, { from: 'node' })
    return 0
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode
    }

    io.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new CommanderError(1, 'invalidArgument', '--max-turns must be >= 1')
  }

  return parsed
}

function parseCommaList(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function parseOutputFormat(value: string): OutputFormat {
  if (value === 'text' || value === 'json' || value === 'stream-json') {
    return value
  }

  throw new CommanderError(
    1,
    'invalidArgument',
    '--output-format must be text, json, or stream-json',
  )
}

function parseInputFormat(value: string): InputFormat {
  if (value === 'text' || value === 'stream-json') {
    return value
  }

  throw new CommanderError(
    1,
    'invalidArgument',
    '--input-format must be text or stream-json',
  )
}

function parseJsonSchema(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Throw the stable Commander error below.
  }

  throw new CommanderError(
    1,
    'invalidArgument',
    '--json-schema must be a JSON object',
  )
}

async function resolveSystemPromptOptionValues(options: {
  systemPrompt?: string
  systemPromptFile?: string
  appendSystemPrompt?: string
  appendSystemPromptFile?: string
}): Promise<{
  systemPrompt?: string
  appendSystemPrompt?: string
}> {
  const systemPrompt = options.systemPromptFile
    ? await readFile(options.systemPromptFile, 'utf8')
    : options.systemPrompt
  const appendSystemPromptFromFile = options.appendSystemPromptFile
    ? await readFile(options.appendSystemPromptFile, 'utf8')
    : undefined
  const appendSystemPrompt = [
    options.appendSystemPrompt,
    appendSystemPromptFromFile,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n\n') || undefined

  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
  }
}

function renderDumpedSystemPrompt(options: {
  systemPrompt?: string
  appendSystemPrompt?: string
}): string {
  return [
    options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    options.appendSystemPrompt,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n\n')
}

function normalizePromptArg(
  promptArg: string[] | string | undefined,
): string | undefined {
  if (Array.isArray(promptArg)) {
    return promptArg.length > 0 ? promptArg.join(' ') : undefined
  }

  return promptArg
}

function normalizeTopLevelSlashCommand(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return undefined
  }

  const [command] = prompt.trim().split(/\s+/, 1)
  if (command === 'doctor' || command === 'weixin') {
    return `/${prompt}`
  }

  return undefined
}

function appendSlashCommandFlags(
  prompt: string,
  options: {
    fork?: boolean
    rewind?: string | boolean
    rewindFiles?: string | boolean
    checkpoints?: boolean
    full?: boolean
    fullEcosystem?: boolean
    strict?: boolean
    remote?: boolean
    tui?: boolean
    platform?: boolean
    voice?: boolean
    memory?: boolean
    agentWorkflows?: boolean
    sourceInventory?: boolean
  },
): string {
  if (prompt.startsWith('/parity')) {
    const command = [prompt]
    if (options.strict) {
      command.push('--strict')
    } else if (options.full || options.fullEcosystem) {
      command.push('--full')
    }
    if (options.remote) {
      command.push('--remote')
    }
    if (options.tui) {
      command.push('--tui')
    }
    if (options.platform) {
      command.push('--platform')
    }
    if (options.voice) {
      command.push('--voice')
    }
    if (options.memory) {
      command.push('--memory')
    }
    if (options.agentWorkflows) {
      command.push('--agent-workflows')
    }
    if (options.sourceInventory) {
      command.push('--source-inventory')
    }
    return command.join(' ')
  }

  if (!prompt.startsWith('/resume')) {
    return prompt
  }

  const command = [prompt]
  if (options.checkpoints) {
    command.push('--checkpoints')
  }

  if (options.fork) {
    command.push('--fork')
  }

  if (options.rewind !== undefined) {
    command.push('--rewind')
    if (typeof options.rewind === 'string') {
      command.push(options.rewind)
    }
  }

  if (options.rewindFiles !== undefined) {
    command.push('--rewind-files')
    if (typeof options.rewindFiles === 'string') {
      command.push(options.rewindFiles)
    }
  }

  return command.join(' ')
}

async function runPrintMode(args: {
  prompt?: string
  options: {
    model?: string
    maxTurns?: number
    permissionMode?: string
    systemPrompt?: string
    appendSystemPrompt?: string
    systemPromptFile?: string
    appendSystemPromptFile?: string
    allowedTools?: string[]
    tools?: string[]
    disallowedTools?: string[]
    outputFormat?: OutputFormat
    inputFormat?: InputFormat
    jsonSchema?: Record<string, unknown>
    includePartialMessages?: boolean
    includeHookEvents?: boolean
    continue?: boolean
    resume?: string | boolean
    sessionId?: string
    addDir?: string[]
    pluginDir?: string[]
    transcriptPath?: string
  }
  io: CliIO
  runtime: CliRuntime
}) {
  if (!args.prompt) {
    throw new CommanderError(1, 'missingPrompt', 'print mode requires a prompt')
  }

  let terminalExitCode = 0
  let wroteText = false
  let collectedText = ''
  const outputFormat = args.options.outputFormat ?? 'text'
  const settings = await loadSettings()
  const resume = await resolveResumeContext({
    cwd: process.cwd(),
    continueLatest: args.options.continue,
    resume: args.options.resume,
    sessionId: args.options.sessionId,
  })

  for await (const event of args.runtime.query({
    prompt: args.prompt,
    model: args.options.model ?? settings.model,
    maxTurns: args.options.maxTurns,
    permissionMode: args.options.permissionMode ?? settings.permissionMode,
    systemPrompt: args.options.systemPrompt,
    appendSystemPrompt: args.options.appendSystemPrompt,
    allowedTools: args.options.allowedTools ?? args.options.tools ?? settings.allowedTools,
    disallowedTools: args.options.disallowedTools ?? settings.disallowedTools,
    userContext: resume?.summary,
    messages: resume?.providerMessages,
    sessionId: resume?.session.id ?? args.options.sessionId,
    transcriptPath: resume?.session.transcriptPath ?? args.options.transcriptPath,
    additionalDirectories: args.options.addDir,
    pluginDirs: args.options.pluginDir,
  })) {
    if (outputFormat === 'stream-json') {
      writeStreamJsonEvent({
        io: args.io,
        event,
        includePartialMessages: args.options.includePartialMessages,
        includeHookEvents: args.options.includeHookEvents,
      })
    }

    if (event.type === 'terminal') {
      terminalExitCode = event.exitCode
      if (event.exitCode !== 0) {
        args.io.stderr.write(`error: ${event.reason ?? event.status}\n`)
      }
      continue
    }

    if (
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_result'
    ) {
      continue
    }

    const text = textDeltaFromEvent(event)
    if (text) {
      wroteText = true
      if (outputFormat === 'json' || outputFormat === 'stream-json') {
        collectedText += text
      } else {
        args.io.stdout.write(text)
      }
    }
  }

  if (outputFormat === 'json' || outputFormat === 'stream-json') {
    writeJsonLine(args.io.stdout, buildPrintResult({
      text: collectedText,
      exitCode: terminalExitCode,
      jsonSchema: args.options.jsonSchema,
    }))
  } else if (wroteText) {
    args.io.stdout.write('\n')
  }

  if (terminalExitCode !== 0) {
    throw new CommanderError(
      terminalExitCode,
      'agentTerminal',
      'agent terminal failed',
    )
  }
}

function writeStreamJsonEvent(args: {
  io: CliIO
  event: QueryEvent | ToolExecutionEvent | { type: 'terminal'; exitCode: number }
  includePartialMessages?: boolean
  includeHookEvents?: boolean
}) {
  if (
    args.event.type === 'content_block_delta' &&
    args.event.delta.type === 'text_delta'
  ) {
    if (args.includePartialMessages) {
      writeJsonLine(args.io.stdout, {
        type: 'assistant_delta',
        delta: args.event.delta.text,
      })
    }
    return
  }

  if (
    args.event.type === 'tool_execution_start' ||
    args.event.type === 'tool_execution_result'
  ) {
    writeJsonLine(args.io.stdout, {
      type: 'tool',
      event: args.event,
    })
    return
  }

  if (args.includeHookEvents && args.event.type !== 'terminal') {
    writeJsonLine(args.io.stdout, {
      type: 'event',
      event: args.event,
    })
  }
}

function buildPrintResult(args: {
  text: string
  exitCode: number
  jsonSchema?: Record<string, unknown>
}) {
  const structured = args.jsonSchema
    ? parseStructuredResult(args.text)
    : {
        ok: true,
        value: args.text,
      }
  const validation = args.jsonSchema
    ? validateJsonSchemaSubset(structured.value, args.jsonSchema)
    : undefined

  return {
    type: 'result',
    subtype: args.exitCode === 0 && (validation?.valid ?? true) ? 'success' : 'error',
    is_error: args.exitCode !== 0 || validation?.valid === false,
    result: structured.value,
    ...(args.jsonSchema
      ? {
          json_schema_validation: validation,
        }
      : {}),
  }
}

function parseStructuredResult(text: string): {
  ok: boolean
  value: unknown
} {
  try {
    return {
      ok: true,
      value: JSON.parse(text),
    }
  } catch {
    return {
      ok: false,
      value: text,
    }
  }
}

function validateJsonSchemaSubset(
  value: unknown,
  schema: Record<string, unknown>,
): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []
  validateSchemaNode(value, schema, '$', errors)
  return {
    valid: errors.length === 0,
    errors,
  }
}

function validateSchemaNode(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
) {
  const type = typeof schema.type === 'string' ? schema.type : undefined
  if (type && !matchesJsonSchemaType(value, type)) {
    errors.push(`${path} must be ${type}`)
    return
  }

  if (type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
    return
  }

  const objectValue =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []
  for (const key of required) {
    if (!(key in objectValue)) {
      errors.push(`${path}.${key} is required`)
    }
  }

  for (const [key, childSchema] of Object.entries(
    schema.properties as Record<string, unknown>,
  )) {
    if (key in objectValue && childSchema && typeof childSchema === 'object') {
      validateSchemaNode(
        objectValue[key],
        childSchema as Record<string, unknown>,
        `${path}.${key}`,
        errors,
      )
    }
  }
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function writeJsonLine(stream: WritableStreamLike, value: unknown) {
  stream.write(`${JSON.stringify(value)}\n`)
}
