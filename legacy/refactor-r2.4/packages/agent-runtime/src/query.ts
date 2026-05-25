import { randomUUID } from 'node:crypto'
import type {
  ContentBlock,
  Message,
  QueryEvent,
  StopReason,
  TerminalEvent,
  ToolExecutionEvent,
  ToolResultBlock,
  ToolUseBlock,
} from '@my-claude-code/core'
import { getDefaultProviderRuntime } from '@my-claude-code/model-provider'
import type {
  ProviderRequest,
  ProviderTool,
} from '@my-claude-code/model-provider'
import {
  recordFileSnapshot,
  recordSession,
} from '@my-claude-code/session'
import {
  getBuiltinTools,
  discoverExtensionRegistry,
  isPatternToolRule,
  matchesToolNameRule,
  parsePermissionMode,
  runTools,
  toolsToProviderTools,
  toToolResultBlock,
} from '@my-claude-code/tools'
import type {
  PostToolUseHook,
  PreToolUseHook,
  PermissionPrompt,
  Tool,
  ToolResult,
} from '@my-claude-code/tools'
import {
  applyAutoCompact,
  applyAutoCompactWithSummary,
  applyToolResultBudget,
  type CompactSummarizer,
} from './compact.js'
import { buildRuntimeContext } from './context.js'
import { appendTranscript, defaultTranscriptPath } from './transcript.js'

export const DEFAULT_SYSTEM_PROMPT = [
  'You are my-claude-code, a Claude Code-like coding agent.',
  'Use the provided tools for filesystem, shell, search, and todo operations.',
  'Never claim that a file was created, edited, deleted, read, or searched unless the relevant tool_result shows success.',
  'If a tool_result has is_error=true, report the failure accurately and do not claim the requested operation succeeded.',
  'For file creation or modification, call Write or Edit. Do not simulate file changes in plain text.',
].join('\n')

export type AgentEvent = QueryEvent | TerminalEvent | ToolExecutionEvent

export type QueryProvider = (
  request: ProviderRequest,
) => AsyncIterable<QueryEvent>

export type UserPromptSubmitHook = (request: {
  prompt: string
  cwd: string
}) => string | undefined | Promise<string | undefined>

export type StopHook = (request: {
  stopReason: StopReason | undefined
  messages: Message[]
}) =>
  | { decision: 'allow' | 'block'; reason?: string }
  | undefined
  | Promise<{ decision: 'allow' | 'block'; reason?: string } | undefined>

export type QueryOptions = {
  prompt: string
  promptContent?: ContentBlock[]
  model?: string
  maxTurns?: number
  permissionMode?: string
  systemPrompt?: string
  appendSystemPrompt?: string
  userContext?: string
  messages?: Message[]
  tools?: ProviderTool[]
  toolRegistry?: Tool[]
  allowedTools?: string[]
  disallowedTools?: string[]
  additionalDirectories?: string[]
  userPromptSubmitHooks?: UserPromptSubmitHook[]
  preToolUseHooks?: PreToolUseHook[]
  postToolUseHooks?: PostToolUseHook[]
  permissionPrompt?: PermissionPrompt
  stopHooks?: StopHook[]
  signal?: AbortSignal
  cwd?: string
  sessionId?: string
  transcriptPath?: string
  provider?: QueryProvider
  autoCompactTokenThreshold?: number
  maxToolResultChars?: number
  maxTotalToolResultChars?: number
  compactSummarizer?: CompactSummarizer
  pluginDirs?: string[]
  extensionDiscoveryTimeoutMs?: number
  deferredToolRegistry?: Tool[]
}

export async function* query(
  options: QueryOptions,
): AsyncGenerator<AgentEvent, void> {
  const sessionId = options.sessionId ?? randomUUID()
  const cwd = options.cwd ?? process.cwd()
  const transcriptPath =
    options.transcriptPath ??
    defaultTranscriptPath(cwd, sessionId)

  await recordSession({
    cwd,
    sessionId,
    transcriptPath,
    prompt: options.prompt,
    model: options.model,
    permissionMode: options.permissionMode,
    additionalDirectories: options.additionalDirectories,
  })

  for await (const event of queryLoop({
    ...options,
    cwd,
    sessionId,
    transcriptPath,
  })) {
    await appendTranscript({
      transcriptPath,
      sessionId,
      event,
    })
    yield event
  }
}

export async function* queryLoop(
  options: QueryOptions,
): AsyncGenerator<AgentEvent, void> {
  const runtimeOptions = {
    ...options,
    prompt: await applyUserPromptSubmitHooks(options),
  }
  const maxTurns = options.maxTurns ?? 5

  if (maxTurns < 1) {
    yield terminal('max_turns', 1, 'maxTurns must be at least 1')
    return
  }

  const provider =
    options.provider ?? (request => getDefaultProviderRuntime().stream(request))
  const extensionRegistry = runtimeOptions.toolRegistry
    ? undefined
    : await discoverExtensionRegistry(runtimeOptions.cwd ?? process.cwd(), {
        pluginDirs: runtimeOptions.pluginDirs,
        timeoutMs: runtimeOptions.extensionDiscoveryTimeoutMs,
      })
  const deferredTools = [
    ...(runtimeOptions.deferredToolRegistry ?? []),
    ...(extensionRegistry?.deferredTools ?? []),
  ]
  const toolRegistry = filterTools(
    runtimeOptions.toolRegistry ?? [
      ...getBuiltinTools(),
      ...(extensionRegistry?.tools ?? []),
    ],
    runtimeOptions,
  )
  const providerTools = runtimeOptions.tools ?? toolsToProviderTools(toolRegistry)
  let messages = await buildRuntimeMessages(runtimeOptions)
  let hasAttemptedReactiveCompact = false

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const preparedMessages = await prepareMessagesForProvider(runtimeOptions, messages)
    const request = buildProviderRequest(
      runtimeOptions,
      preparedMessages,
      providerTools,
    )
    const collector = new AssistantMessageCollector()
    let stopReason: StopReason | undefined

    try {
      for await (const event of provider(request)) {
        collector.accept(event)

        if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason
        }

        yield event
      }
    } catch (error) {
      if (isAbortError(error)) {
        yield terminal('aborted_streaming', 130, 'streaming aborted')
        return
      }

      if (isContextTooLongError(error) && !hasAttemptedReactiveCompact) {
        hasAttemptedReactiveCompact = true
        messages = reactiveCompactMessages(messages)
        turn -= 1
        continue
      }

      if (isContextTooLongError(error)) {
        yield terminal('prompt_too_long', 1, 'context window exceeded after compact retry')
        return
      }

      yield terminal(
        'model_error',
        1,
        error instanceof Error ? error.message : String(error),
      )
      return
    }

    if (
      stopReason === 'model_context_window_exceeded' &&
      !hasAttemptedReactiveCompact
    ) {
      hasAttemptedReactiveCompact = true
      messages = reactiveCompactMessages(messages)
      turn -= 1
      continue
    }

    if (stopReason === 'model_context_window_exceeded') {
      yield terminal('prompt_too_long', 1, 'context window exceeded after compact retry')
      return
    }

    if (stopReason !== 'tool_use') {
      const stopDecision = await runStopHooks(runtimeOptions, messages, stopReason)
      if (stopDecision?.decision === 'block') {
        yield terminal(
          'hook_blocked',
          1,
          stopDecision.reason ?? 'Stop hook blocked completion',
        )
        return
      }

      yield terminal('completed', 0)
      return
    }

    const toolUses = collector.getToolUses()
    if (toolUses.length === 0) {
      yield terminal('model_error', 1, 'model stopped for tool_use without tool blocks')
      return
    }

    if (turn >= maxTurns) {
      yield terminal(
        'max_turns',
        1,
        'model requested tool use, but maxTurns does not allow another model turn',
      )
      return
    }

    const toolOutcome = yield* executeToolUses({
      toolUses,
      tools: toolRegistry,
      options: runtimeOptions,
      deferredTools,
    })

    if (toolOutcome.blockingError) {
      yield terminal('tool_error', 1, toolOutcome.blockingError)
      return
    }

    messages = [
      ...messages,
      {
        role: 'assistant',
        content: collector.getContent(),
      },
      {
        role: 'user',
        content: toolOutcome.toolResults,
      },
    ]
  }

  yield terminal('max_turns', 1, 'maximum query turns reached')
}

export function buildProviderRequest(
  options: QueryOptions,
  messages = buildMessages(options),
  tools = options.tools,
): ProviderRequest {
  return {
    model: options.model ?? 'deepseek-v4-flash',
    messages,
    tools,
    maxTokens: 4096,
    temperature: 0,
    signal: options.signal,
  }
}

export function buildMessages(options: QueryOptions): Message[] {
  const messages: Message[] = []
  const additionalDirectoryContext = options.additionalDirectories?.length
    ? `Additional directories:\n${options.additionalDirectories.join('\n')}`
    : undefined
  const systemContent = [
    options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    options.appendSystemPrompt,
    options.userContext,
    additionalDirectoryContext,
  ]
    .filter(Boolean)
    .join('\n\n')

  if (systemContent) {
    messages.push({
      role: 'system',
      content: systemContent,
    })
  }

  messages.push(...(options.messages ?? []))
  messages.push({
    role: 'user',
    content: options.promptContent ?? options.prompt,
  })

  return messages
}

export async function buildRuntimeMessages(options: QueryOptions): Promise<Message[]> {
  const context = await buildRuntimeContext({
    cwd: options.cwd ?? process.cwd(),
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    appendSystemPrompt: options.appendSystemPrompt,
    userContext: options.userContext,
    additionalDirectories: options.additionalDirectories,
    sessionId: options.sessionId,
    prompt: options.prompt,
  })
  const messages: Message[] = []
  if (context.systemContent) {
    messages.push({
      role: 'system',
      content: context.systemContent,
    })
  }
  messages.push(...(options.messages ?? []))
  messages.push({
    role: 'user',
    content: options.promptContent ?? options.prompt,
  })
  return messages
}

async function prepareMessagesForProvider(
  options: QueryOptions,
  messages: Message[],
): Promise<Message[]> {
  const compacted = await applyAutoCompactWithSummary(messages, {
    thresholdTokens: options.autoCompactTokenThreshold,
    summarizer: options.compactSummarizer,
  })
  const budgeted = await applyToolResultBudget(compacted.messages, {
    cwd: options.cwd ?? process.cwd(),
    sessionId: options.sessionId,
    maxToolResultChars: options.maxToolResultChars,
    maxTotalToolResultChars: options.maxTotalToolResultChars,
  })
  return budgeted.messages
}

function reactiveCompactMessages(messages: Message[]): Message[] {
  return applyAutoCompact(messages, {
    thresholdTokens: 1,
    keepLastMessages: 4,
  }).messages
}

function terminal(
  status: TerminalEvent['status'],
  exitCode: number,
  reason?: string,
): TerminalEvent {
  return {
    type: 'terminal',
    status,
    exitCode,
    reason,
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (error instanceof Error && error.name === 'AbortError')
}

function isContextTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(context window|prompt too long|too many tokens|413)\b/i.test(message)
}

async function* executeToolUses(args: {
  toolUses: ToolUseBlock[]
  tools: Tool[]
  options: QueryOptions
  deferredTools?: Tool[]
}): AsyncGenerator<
  ToolExecutionEvent,
  { toolResults: ToolResultBlock[]; blockingError?: string }
> {
  const toolResults = yield* runTools({
    toolUses: args.toolUses,
    tools: args.tools,
    context: {
      cwd: args.options.cwd ?? process.cwd(),
      sessionId: args.options.sessionId,
      permissionMode: parsePermissionMode(args.options.permissionMode),
      allowedTools: args.options.allowedTools,
      disallowedTools: args.options.disallowedTools,
      deferredTools: args.deferredTools,
      signal: args.options.signal,
      fileSnapshotRecorder: args.options.sessionId
        ? async ({ toolUse, tool, filePath, context }) => {
            await recordFileSnapshot({
              cwd: context.cwd,
              sessionId: args.options.sessionId as string,
              toolUseId: toolUse.id,
              toolName: tool.name,
              filePath,
            })
          }
        : undefined,
      permissionPrompt: args.options.permissionPrompt,
      preToolUseHooks: args.options.preToolUseHooks,
      postToolUseHooks: args.options.postToolUseHooks,
    },
  })

  return {
    toolResults: toolResults.map(toToolResultBlock),
    blockingError: toolResults.map(getBlockingToolError).find(Boolean),
  }
}

type MutableBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: Extract<ContentBlock, { type: 'image' }>['source'] }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; inputJson: string }
  | { type: 'tool_result'; tool_use_id: string; content?: string | Array<{ type: 'text'; text: string }>; is_error?: boolean }

class AssistantMessageCollector {
  private blocks = new Map<number, MutableBlock>()

  accept(event: QueryEvent) {
    if (event.type === 'content_block_start') {
      this.blocks.set(event.index, toMutableBlock(event.content_block))
      return
    }

    if (event.type !== 'content_block_delta') {
      return
    }

    const block = this.blocks.get(event.index)
    if (!block) {
      return
    }

    switch (event.delta.type) {
      case 'text_delta':
        if (block.type === 'text') {
          block.text += event.delta.text
        }
        break
      case 'thinking_delta':
        if (block.type === 'thinking') {
          block.thinking += event.delta.thinking
        }
        break
      case 'input_json_delta':
        if (block.type === 'tool_use') {
          block.inputJson += event.delta.partial_json
          block.input = parseToolInput(block.inputJson)
        }
        break
    }
  }

  getContent(): ContentBlock[] {
    return [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => finalizeBlock(block))
  }

  getToolUses(): ToolUseBlock[] {
    return this.getContent().filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    )
  }
}

function toMutableBlock(block: ContentBlock): MutableBlock {
  if (block.type === 'tool_use') {
    return {
      ...block,
      inputJson: '',
    }
  }

  return { ...block }
}

function finalizeBlock(block: MutableBlock): ContentBlock {
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    }
  }

  return block
}

function parseToolInput(value: string): Record<string, unknown> {
  if (!value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : { value: parsed }
  } catch {
    return {
      __invalid_json: value,
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function filterTools(tools: Tool[], options: QueryOptions): Tool[] {
  const hasRestrictiveAllowedRules = options.allowedTools?.some(
    rule => !isPatternToolRule(rule),
  )

  return tools.filter(tool => {
    if (
      hasRestrictiveAllowedRules &&
      !options.allowedTools?.some(rule => matchesToolNameRule(tool.name, rule))
    ) {
      return false
    }

    if (
      options.disallowedTools?.some(
        rule => !rule.includes('(') && matchesToolNameRule(tool.name, rule),
      )
    ) {
      return false
    }

    return true
  })
}

function getBlockingToolError(result: ToolResult): string | undefined {
  if (result.permission_decision === 'deny') {
    return `${result.name} was denied: ${result.content}`
  }

  return undefined
}

async function applyUserPromptSubmitHooks(options: QueryOptions): Promise<string> {
  let prompt = options.prompt

  for (const hook of options.userPromptSubmitHooks ?? []) {
    prompt =
      (await hook({
        prompt,
        cwd: options.cwd ?? process.cwd(),
      })) ?? prompt
  }

  return prompt
}

async function runStopHooks(
  options: QueryOptions,
  messages: Message[],
  stopReason: StopReason | undefined,
): Promise<{ decision: 'allow' | 'block'; reason?: string } | undefined> {
  for (const hook of options.stopHooks ?? []) {
    const decision = await hook({ messages, stopReason })
    if (decision) {
      return decision
    }
  }

  return undefined
}
