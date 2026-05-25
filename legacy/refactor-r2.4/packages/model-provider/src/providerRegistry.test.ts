import { describe, expect, it } from 'bun:test'
import type { QueryEvent } from '@my-claude-code/core'
import {
  ModelProviderRuntime,
  ProviderRegistry,
  ProviderRuntimeError,
  classifyProviderError,
  resolveProviderModel,
} from './index.js'
import type {
  ProviderMetadata,
  ProviderModelCapabilities,
  ProviderRegistration,
  ProviderRequest,
} from './types.js'

describe('provider registry runtime', () => {
  it('resolves model aliases and exposes capabilities', () => {
    const resolved = resolveProviderModel('fast')

    expect(resolved.provider).toBe('deepseek')
    expect(resolved.model).toBe('deepseek-v4-flash')
    expect(resolved.capabilities).toMatchObject({
      supportsTextStreaming: true,
      supportsToolCallDelta: true,
      supportsUsageMapping: true,
      supportsPromptCache: true,
    })
  })

  it('aggregates usage once per request and reports balance', async () => {
    const runtime = runtimeWithStreams([
      [
        messageStart({
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 5,
        }),
        messageDelta({
          input_tokens: 10,
          output_tokens: 7,
          cache_read_input_tokens: 5,
        }),
        { type: 'message_stop' },
      ],
    ])

    await Array.fromAsync(runtime.stream(request()))
    const snapshot = runtime.snapshot({})

    expect(snapshot.usage).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 5,
      totalTokens: 22,
      requestCount: 1,
    })
    expect(snapshot.balances[0]).toMatchObject({
      provider: 'fake',
      requestLimit: 2,
      requestsUsed: 1,
      requestsRemaining: 1,
      tokenLimit: 50,
      tokensUsed: 22,
      tokensRemaining: 28,
      limited: false,
    })
  })

  it('counts provider requests even when usage is unavailable', async () => {
    const runtime = runtimeWithStreams([[{ type: 'message_stop' }]])

    await Array.fromAsync(runtime.stream(request()))

    expect(runtime.snapshot({}).usage).toMatchObject({
      totalTokens: 0,
      requestCount: 1,
    })
    expect(runtime.snapshot({}).balances[0]).toMatchObject({
      requestsUsed: 1,
      tokensUsed: 0,
    })
  })

  it('detects explicit and usage-driven cache breaks', async () => {
    const runtime = runtimeWithStreams(
      [
        [
          messageStart({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 8 }),
          messageDelta({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 8 }),
          { type: 'message_stop' },
        ],
        [
          messageStart({ input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0 }),
          messageDelta({ input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0 }),
          { type: 'message_stop' },
        ],
        [
          messageStart({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 4 }),
          messageDelta({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 4 }),
          { type: 'message_stop' },
        ],
      ],
      {
        requestLimit: 10,
        tokenLimit: 100,
      },
    )

    await Array.fromAsync(runtime.stream(request()))
    await Array.fromAsync(runtime.stream(request()))
    await Array.fromAsync(runtime.stream({
      ...request(),
      cachePolicy: { break: true, reason: 'manual test' },
    }))

    expect(runtime.snapshot({}).cacheBreaks).toEqual([
      {
        provider: 'fake',
        model: 'fake-model',
        reason: 'cache_read_dropped',
        previousCacheReadInputTokens: 8,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      {
        provider: 'fake',
        model: 'fake-model',
        reason: 'explicit',
        previousCacheReadInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: undefined,
      },
    ])
  })

  it('classifies provider errors and records rate-limit failures', async () => {
    expect(classifyProviderError(new Error('HTTP 429: slow down'))).toMatchObject({
      kind: 'rate_limit',
      retryable: true,
      status: 429,
    })
    expect(classifyProviderError(new Error('HTTP 402: balance exhausted'))).toMatchObject({
      kind: 'balance_exhausted',
      retryable: false,
      status: 402,
    })

    const runtime = runtimeWithStreams([
      [messageStart({ input_tokens: 1, output_tokens: 1 }), messageDelta({ input_tokens: 1, output_tokens: 1 })],
      [messageStart({ input_tokens: 1, output_tokens: 1 }), messageDelta({ input_tokens: 1, output_tokens: 1 })],
    ], {
      requestLimit: 1,
      tokenLimit: 100,
    })

    await Array.fromAsync(runtime.stream(request()))
    await expect(Array.fromAsync(runtime.stream(request()))).rejects.toThrow(
      ProviderRuntimeError,
    )
    expect(runtime.snapshot({}).errors.at(-1)).toMatchObject({
      provider: 'fake',
      model: 'fake-model',
      kind: 'rate_limit',
      retryable: true,
    })
  })
})

function runtimeWithStreams(
  streams: QueryEvent[][],
  rateLimit = {
    requestLimit: 2,
    tokenLimit: 50,
  },
): ModelProviderRuntime {
  const metadata: ProviderMetadata = {
    name: 'fake',
    defaultModel: 'fake-model',
    apiKeyEnvVar: 'FAKE_API_KEY',
    rateLimit: {
      windowMs: 60_000,
      ...rateLimit,
    },
    models: [fakeCapabilities()],
  }
  const registration: ProviderRegistration = {
    metadata,
    stream: async function* (_request: ProviderRequest) {
      const events = streams.shift()
      if (!events) {
        throw new Error('unexpected provider request')
      }
      yield* events
    },
  }

  return new ModelProviderRuntime({
    registry: new ProviderRegistry([registration]),
    now: () => 1_700_000_000_000,
  })
}

function fakeCapabilities(): ProviderModelCapabilities {
  return {
    provider: 'fake',
    model: 'fake-model',
    aliases: ['fake-alias'],
    contextWindowTokens: 100,
    maxOutputTokens: 20,
    supportsTextStreaming: true,
    supportsToolCallDelta: false,
    supportsThinking: false,
    supportsUsageMapping: true,
    supportsPromptCache: true,
    supportsSystemMessages: true,
    supportsTools: true,
  }
}

function request(): ProviderRequest {
  return {
    model: 'fake-alias',
    messages: [{ role: 'user', content: 'hello' }],
  }
}

function messageStart(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}): QueryEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_fake',
      role: 'assistant',
      model: 'fake-model',
      usage,
    },
  }
}

function messageDelta(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}): QueryEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage,
  }
}
