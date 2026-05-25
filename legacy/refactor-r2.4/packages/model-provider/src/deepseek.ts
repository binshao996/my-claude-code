import type { ContentBlock, QueryEvent, StopReason, Usage } from '@my-claude-code/core'
import type {
  ProviderCompatibilityResult,
  ProviderMessage,
  ProviderMetadata,
  ModelProvider,
  ProviderRequest,
  ProviderTool,
} from './types.js'

export const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEFAULT_DEEPSEEK_BASE_URL =
  'https://api.deepseek.com/chat/completions'

export const deepSeekMetadata: ProviderMetadata = {
  name: 'deepseek',
  displayName: 'DeepSeek',
  defaultModel: DEFAULT_DEEPSEEK_MODEL,
  apiKeyEnvVar: DEEPSEEK_API_KEY_ENV,
  baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
  rateLimit: {
    windowMs: 60_000,
    requestLimit: 60,
    tokenLimit: 200_000,
  },
  models: [
    {
      provider: 'deepseek',
      model: DEFAULT_DEEPSEEK_MODEL,
      aliases: ['default', 'deepseek', 'deepseek-chat', 'deepseek-v4', 'fast'],
      displayName: 'DeepSeek V4 Flash',
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
      supportsTextStreaming: true,
      supportsToolCallDelta: true,
      supportsThinking: true,
      supportsUsageMapping: true,
      supportsPromptCache: true,
      supportsSystemMessages: true,
      supportsTools: true,
    },
    {
      provider: 'deepseek',
      model: 'deepseek-r1',
      aliases: ['deepseek-reasoner', 'reasoner', 'thinking'],
      displayName: 'DeepSeek R1',
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
      supportsTextStreaming: true,
      supportsToolCallDelta: true,
      supportsThinking: true,
      supportsUsageMapping: true,
      supportsPromptCache: true,
      supportsSystemMessages: true,
      supportsTools: true,
    },
  ],
}

export const deepSeekProvider: ModelProvider = {
  metadata: deepSeekMetadata,
  stream: streamDeepSeekQuery,
}

type DeepSeekFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'insufficient_system_resource'
  | null

type DeepSeekDeltaToolCall = {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

export type DeepSeekChatCompletionChunk = {
  id?: string
  model?: string
  choices?: Array<{
    index: number
    delta?: {
      role?: 'assistant'
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: DeepSeekDeltaToolCall[]
    }
    finish_reason?: DeepSeekFinishReason
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
  error?: {
    type?: string
    message?: string
  }
}

type ToolAccumulator = {
  blockIndex: number
  id: string
  name: string
  inputJson: string
  closed: boolean
}

export type DeepSeekLiveSpikeReport = ProviderCompatibilityResult & {
  live: true
  status: 'passed' | 'failed'
  endpoint: string
  apiKeyEnvVar: typeof DEEPSEEK_API_KEY_ENV
  probes: {
    thinkingStreaming: boolean
    textStreaming: boolean
    toolCallDelta: boolean
    usageMapping: boolean
    stopReasonMapping: boolean
  }
  requiresReasoningContentForToolCalls: true
  eventCounts: Partial<Record<QueryEvent['type'], number>>
  errors: string[]
}

export type DeepSeekLiveSpikeOptions = {
  apiKey?: string
  endpoint?: string
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export type DeepSeekStreamOptions = {
  apiKey?: string
  endpoint?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class DeepSeekStreamAdapter {
  private messageStarted = false
  private messageStopped = false
  private nextBlockIndex = 0
  private thinkingBlockIndex: number | undefined
  private thinkingBlockClosed = false
  private textBlockIndex: number | undefined
  private textBlockClosed = false
  private toolBlocks = new Map<number, ToolAccumulator>()

  accept(chunk: DeepSeekChatCompletionChunk): QueryEvent[] {
    const events: QueryEvent[] = []

    if (chunk.error) {
      events.push({
        type: 'error',
        error: {
          type: chunk.error.type ?? 'provider_error',
          message: chunk.error.message ?? 'DeepSeek provider error',
        },
      })
      return events
    }

    this.ensureMessageStarted(events, chunk)

    if ((chunk.choices?.length ?? 0) === 0 && chunk.usage) {
      events.push({
        type: 'message_delta',
        delta: {},
        usage: mapDeepSeekUsage(chunk.usage),
      })
      return events
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      const reasoningContent = delta?.reasoning_content
      if (reasoningContent !== undefined && reasoningContent !== null) {
        const thinkingBlockIndex = this.ensureThinkingBlockStarted(events)
        if (reasoningContent !== '') {
          events.push({
            type: 'content_block_delta',
            index: thinkingBlockIndex,
            delta: {
              type: 'thinking_delta',
              thinking: reasoningContent,
            },
          })
        }
      }

      if (delta?.content) {
        this.closeThinkingBlock(events)
        const textBlockIndex = this.ensureTextBlockStarted(events)
        events.push({
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: {
            type: 'text_delta',
            text: delta.content,
          },
        })
      }

      for (const toolCall of delta?.tool_calls ?? []) {
        this.closeThinkingBlock(events)
        this.closeTextBlock(events)
        const block = this.ensureToolBlockStarted(events, toolCall)
        const partialJson = toolCall.function?.arguments

        if (partialJson) {
          block.inputJson += partialJson
          events.push({
            type: 'content_block_delta',
            index: block.blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: partialJson,
            },
          })
        }
      }

      if (choice.finish_reason) {
        events.push(...this.closeOpenBlocks())
        events.push({
          type: 'message_delta',
          delta: {
            stop_reason: mapDeepSeekStopReason(choice.finish_reason),
            stop_sequence: null,
          },
          usage: mapDeepSeekUsage(chunk.usage),
        })
        this.emitMessageStop(events)
      }
    }

    return events
  }

  acceptSSELine(line: string): QueryEvent[] {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      return []
    }

    const payload = trimmed.slice('data:'.length).trim()
    if (payload === '[DONE]') {
      return this.done()
    }

    return this.accept(JSON.parse(payload) as DeepSeekChatCompletionChunk)
  }

  done(): QueryEvent[] {
    const events = this.closeOpenBlocks()
    if (this.messageStarted) {
      this.emitMessageStop(events)
    }
    return events
  }

  private ensureMessageStarted(
    events: QueryEvent[],
    chunk: DeepSeekChatCompletionChunk,
  ) {
    if (this.messageStarted) {
      return
    }

    this.messageStarted = true
    events.push({
      type: 'message_start',
      message: {
        id: chunk.id ?? 'deepseek-message',
        role: 'assistant',
        model: chunk.model ?? DEFAULT_DEEPSEEK_MODEL,
        usage: mapDeepSeekUsage(chunk.usage),
      },
    })
  }

  private ensureTextBlockStarted(events: QueryEvent[]): number {
    if (this.textBlockIndex !== undefined) {
      return this.textBlockIndex
    }

    this.textBlockIndex = this.nextBlockIndex
    this.nextBlockIndex += 1
    events.push({
      type: 'content_block_start',
      index: this.textBlockIndex,
      content_block: {
        type: 'text',
        text: '',
      },
    })

    return this.textBlockIndex
  }

  private ensureThinkingBlockStarted(events: QueryEvent[]): number {
    if (this.thinkingBlockIndex !== undefined) {
      return this.thinkingBlockIndex
    }

    this.thinkingBlockIndex = this.nextBlockIndex
    this.nextBlockIndex += 1
    events.push({
      type: 'content_block_start',
      index: this.thinkingBlockIndex,
      content_block: {
        type: 'thinking',
        thinking: '',
        signature: '',
      },
    })

    return this.thinkingBlockIndex
  }

  private ensureToolBlockStarted(
    events: QueryEvent[],
    toolCall: DeepSeekDeltaToolCall,
  ): ToolAccumulator {
    const existing = this.toolBlocks.get(toolCall.index)
    if (existing) {
      return existing
    }

    const block: ToolAccumulator = {
      blockIndex: this.nextBlockIndex,
      id: toolCall.id ?? `toolu_deepseek_${toolCall.index}`,
      name: toolCall.function?.name ?? 'unknown',
      inputJson: '',
      closed: false,
    }
    this.nextBlockIndex += 1
    this.toolBlocks.set(toolCall.index, block)

    events.push({
      type: 'content_block_start',
      index: block.blockIndex,
      content_block: {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: {},
      },
    })

    return block
  }

  private closeOpenBlocks(): QueryEvent[] {
    const events: QueryEvent[] = []

    this.closeThinkingBlock(events)
    this.closeTextBlock(events)

    for (const block of this.toolBlocks.values()) {
      if (!block.closed) {
        events.push({
          type: 'content_block_stop',
          index: block.blockIndex,
        })
        block.closed = true
      }
    }

    return events
  }

  private closeThinkingBlock(events: QueryEvent[]) {
    if (
      this.thinkingBlockIndex === undefined ||
      this.thinkingBlockClosed === true
    ) {
      return
    }

    events.push({
      type: 'content_block_stop',
      index: this.thinkingBlockIndex,
    })
    this.thinkingBlockClosed = true
  }

  private closeTextBlock(events: QueryEvent[]) {
    if (this.textBlockIndex === undefined || this.textBlockClosed === true) {
      return
    }

    events.push({
      type: 'content_block_stop',
      index: this.textBlockIndex,
    })
    this.textBlockClosed = true
  }

  private emitMessageStop(events: QueryEvent[]) {
    if (this.messageStopped) {
      return
    }

    events.push({ type: 'message_stop' })
    this.messageStopped = true
  }
}

export function mapDeepSeekStopReason(
  finishReason: Exclude<DeepSeekFinishReason, null>,
): StopReason {
  switch (finishReason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    case 'insufficient_system_resource':
      return 'error'
  }
}

export function mapDeepSeekUsage(
  usage: DeepSeekChatCompletionChunk['usage'],
): Usage | undefined {
  if (!usage) {
    return undefined
  }

  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  }
}

export function createDeepSeekCompatibilitySpikeResult(): ProviderCompatibilityResult {
  return {
    provider: 'deepseek',
    model: DEFAULT_DEEPSEEK_MODEL,
    supportsTextStreaming: true,
    supportsToolCallDelta: true,
    supportsUsageMapping: true,
    requiresPromptWrappedToolCalls: false,
    notes: [
      'V0.1 validates OpenAI-compatible streaming chunks locally.',
      'Live API verification should use --compatibility-spike-live with DEEPSEEK_API_KEY.',
    ],
  }
}

export async function runDeepSeekLiveCompatibilitySpike(
  options: DeepSeekLiveSpikeOptions = {},
): Promise<DeepSeekLiveSpikeReport> {
  const apiKey = options.apiKey ?? process.env[DEEPSEEK_API_KEY_ENV]
  if (!apiKey) {
    throw new Error(
      `${DEEPSEEK_API_KEY_ENV} is required for live DeepSeek compatibility spike`,
    )
  }

  const endpoint = options.endpoint ?? DEFAULT_DEEPSEEK_BASE_URL
  const model = options.model ?? DEFAULT_DEEPSEEK_MODEL
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const errors: string[] = []
  const eventCounts: Partial<Record<QueryEvent['type'], number>> = {}

  const textEvents = await runDeepSeekStreamingRequest({
    apiKey,
    endpoint,
    fetchImpl,
    timeoutMs,
    body: createTextStreamingProbeBody(model),
  }).catch(error => {
    errors.push(`text streaming probe failed: ${formatError(error)}`)
    return [] satisfies QueryEvent[]
  })

  const toolEvents = await runDeepSeekStreamingRequest({
    apiKey,
    endpoint,
    fetchImpl,
    timeoutMs,
    body: createToolCallProbeBody(model),
  }).catch(error => {
    errors.push(`tool-call probe failed: ${formatError(error)}`)
    return [] satisfies QueryEvent[]
  })

  for (const event of [...textEvents, ...toolEvents]) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1
  }

  const probes = {
    thinkingStreaming: [...textEvents, ...toolEvents].some(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'thinking_delta' &&
        event.delta.thinking.length > 0,
    ),
    textStreaming: textEvents.some(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text.length > 0,
    ),
    toolCallDelta: toolEvents.some(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'input_json_delta' &&
        event.delta.partial_json.length > 0,
    ),
    usageMapping: [...textEvents, ...toolEvents].some(
      event => event.type === 'message_delta' && event.usage !== undefined,
    ),
    stopReasonMapping: [...textEvents, ...toolEvents].some(
      event =>
        event.type === 'message_delta' &&
        event.delta.stop_reason !== undefined,
    ),
  }

  const status = Object.values(probes).every(Boolean) ? 'passed' : 'failed'

  return {
    provider: 'deepseek',
    model,
    live: true,
    status,
    endpoint,
    apiKeyEnvVar: DEEPSEEK_API_KEY_ENV,
    supportsTextStreaming: probes.textStreaming,
    supportsToolCallDelta: probes.toolCallDelta,
    supportsUsageMapping: probes.usageMapping,
    requiresPromptWrappedToolCalls: !probes.toolCallDelta,
    requiresReasoningContentForToolCalls: true,
    probes,
    eventCounts,
    errors,
    notes: [
      'Live spike used the OpenAI-compatible chat completions streaming endpoint.',
      'The API key was read only from environment/options and is not included in this report.',
    ],
  }
}

export async function* streamDeepSeekQuery(
  request: ProviderRequest,
  options: DeepSeekStreamOptions = {},
): AsyncGenerator<QueryEvent, void> {
  const apiKey = request.apiKey ?? options.apiKey ?? process.env[DEEPSEEK_API_KEY_ENV]
  if (!apiKey) {
    throw new Error(`${DEEPSEEK_API_KEY_ENV} is required for DeepSeek requests`)
  }

  yield* streamDeepSeekEvents({
    apiKey,
    endpoint: options.endpoint ?? DEFAULT_DEEPSEEK_BASE_URL,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: request.signal,
    body: createDeepSeekChatCompletionBody(request),
  })
}

export function createDeepSeekChatCompletionBody(request: ProviderRequest) {
  return {
    model: request.model,
    messages: request.messages.flatMap(toDeepSeekMessages),
    tools: request.tools?.map(toDeepSeekTool),
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature ?? 0,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  }
}

export function createTextStreamingProbeBody(model = DEFAULT_DEEPSEEK_MODEL) {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly this lowercase word and nothing else: pong',
      },
    ],
    max_tokens: 512,
    temperature: 0,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  }
}

export function createToolCallProbeBody(model = DEFAULT_DEEPSEEK_MODEL) {
  return {
    model,
    messages: [
      {
        role: 'user',
        content:
          'Call the probe_echo tool with {"value":"pong"}. Do not answer in text.',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'probe_echo',
          description: 'Echoes a short string for compatibility testing.',
          parameters: {
            type: 'object',
            properties: {
              value: {
                type: 'string',
              },
            },
            required: ['value'],
          },
        },
      },
    ],
    max_tokens: 512,
    temperature: 0,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  }
}

async function runDeepSeekStreamingRequest(options: {
  apiKey: string
  endpoint: string
  fetchImpl: typeof fetch
  timeoutMs: number
  body: Record<string, unknown>
}): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []

  for await (const event of streamDeepSeekEvents(options)) {
    events.push(event)
  }

  return events
}

async function* streamDeepSeekEvents(options: {
  apiKey: string
  endpoint: string
  fetchImpl: typeof fetch
  timeoutMs: number
  signal?: AbortSignal
  body: Record<string, unknown>
}): AsyncGenerator<QueryEvent, void> {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), options.timeoutMs)
  const signal = anySignal([abortController.signal, options.signal])

  try {
    const response = await options.fetchImpl(options.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.body),
      signal,
    })

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${truncate(await response.text(), 500)}`,
      )
    }

    if (!response.body) {
      throw new Error('DeepSeek response body is empty')
    }

    const adapter = new DeepSeekStreamAdapter()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        for (const event of adapter.acceptSSELine(line)) {
          yield event
        }
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      for (const event of adapter.acceptSSELine(buffer)) {
        yield event
      }
    }
  } finally {
    clearTimeout(timeout)
  }
}

function toDeepSeekMessages(message: ProviderMessage): Array<Record<string, unknown>> {
  if (typeof message.content === 'string') {
    return [{
      role: message.role,
      content: message.content,
    }]
  }

  if (message.role === 'assistant') {
    const text = contentBlocksToText(message.content)
    const reasoningContent = contentBlocksToReasoningContent(message.content)
    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map(block => ({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }))

    return [{
      role: 'assistant',
      content: text || null,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }]
  }

  const messages: Array<Record<string, unknown>> = []
  const nonToolText = contentBlocksToText(message.content)
  if (nonToolText) {
    messages.push({
      role: message.role,
      content: nonToolText,
    })
  }

  for (const block of message.content) {
    if (block.type !== 'tool_result') {
      continue
    }

    messages.push({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: toolResultText(block),
    })
  }

  return messages
}

function contentBlocksToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content
  }

  return content
    .map(block => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'thinking':
          return ''
        case 'image':
          return `[image:${block.source.media_type};base64:${block.source.data.length} chars]`
        case 'tool_result':
        case 'tool_use':
          return ''
      }

      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function contentBlocksToReasoningContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return ''
  }

  return content
    .map(block => block.type === 'thinking' ? block.thinking : '')
    .filter(Boolean)
    .join('\n')
}

function toolResultText(block: Extract<ContentBlock, { type: 'tool_result' }>): string {
  if (typeof block.content === 'string') {
    return block.content
  }

  return (block.content ?? [])
    .map(item => item.text)
    .filter(Boolean)
    .join('\n')
}

function toDeepSeekTool(tool: ProviderTool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema,
    },
  }
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const filtered = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  if (filtered.length === 1) {
    return filtered[0]
  }

  const abortController = new AbortController()
  const abort = () => abortController.abort()

  for (const signal of filtered) {
    if (signal.aborted) {
      abort()
      break
    }

    signal.addEventListener('abort', abort, { once: true })
  }

  return abortController.signal
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...`
}
