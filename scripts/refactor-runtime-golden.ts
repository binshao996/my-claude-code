import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueryEvent, Usage } from '@my-claude-code/core'
import {
  applyAutoCompact,
  queryLoop,
} from '@my-claude-code/agent-runtime'
import {
  ProviderRegistry,
  classifyProviderError,
  createModelProviderRuntime,
  type ProviderModelCapabilities,
  type ProviderRequest,
} from '@my-claude-code/model-provider'

type RuntimeGolden = {
  version: string
  cases: Array<{
    name: string
    expect: Record<string, unknown>
  }>
}

type RuntimeFailure = {
  caseName: string
  reason: string
}

const fixturePath = 'docs/refactor/golden/runtime/r1.6-provider-runtime-golden.json'
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as RuntimeGolden
const failures: RuntimeFailure[] = []

for (const testCase of fixture.cases) {
  try {
    switch (testCase.name) {
      case 'provider-resolve':
        verifyProviderResolve(testCase.expect)
        break
      case 'provider-usage-balance-cache':
        await verifyProviderUsageBalanceCache(testCase.expect)
        break
      case 'provider-error-taxonomy':
        verifyProviderErrorTaxonomy(testCase.expect)
        break
      case 'query-tool-loop':
        await verifyQueryToolLoop(testCase.expect)
        break
      case 'query-max-turns':
        await verifyQueryMaxTurns(testCase.expect)
        break
      case 'query-abort':
        await verifyQueryAbort(testCase.expect)
        break
      case 'compact-retry':
        verifyCompactRetry(testCase.expect)
        break
      default:
        failures.push({
          caseName: testCase.name,
          reason: 'unknown runtime golden case',
        })
    }
  } catch (error) {
    failures.push({
      caseName: testCase.name,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

console.log(JSON.stringify({
  fixture: fixturePath,
  status: failures.length === 0 ? 'pass' : 'fail',
  cases: fixture.cases.length,
  failures,
}, null, 2))

if (failures.length > 0) {
  process.exit(1)
}

function verifyProviderResolve(expect: Record<string, unknown>): void {
  const registry = new ProviderRegistry([fakeAnthropicProvider()])
  const resolved = registry.resolve('sonnet')
  assertEqual(resolved.provider, expect.provider, 'provider')
  assertEqual(resolved.requestedModel, expect.requestedModel, 'requestedModel')
  assertEqual(resolved.model, expect.model, 'model')
  assertEqual(
    resolved.capabilities.supportsThinking,
    expect.supportsThinking,
    'supportsThinking',
  )
  assertEqual(
    resolved.capabilities.supportsPromptCache,
    expect.supportsPromptCache,
    'supportsPromptCache',
  )
}

async function verifyProviderUsageBalanceCache(expect: Record<string, unknown>): Promise<void> {
  const runtime = createModelProviderRuntime({
    registry: new ProviderRegistry([fakeAnthropicProvider()]),
    now: () => Date.parse('2026-05-25T00:00:00.000Z'),
  })

  for await (const _event of runtime.stream({
    model: 'sonnet',
    messages: [{ role: 'user', content: 'hello' }],
    cachePolicy: { break: true, reason: 'test' },
  })) {
    // Drain stream to force usage aggregation.
  }

  const snapshot = runtime.snapshot({})
  assertEqual(snapshot.usage.requestCount, expect.requestCount, 'requestCount')
  assertEqual(snapshot.usage.totalTokens, expect.totalTokens, 'totalTokens')
  assertEqual(snapshot.cacheBreaks[0]?.reason, expect.cacheBreakReason, 'cacheBreakReason')
  assertEqual(
    snapshot.balances.find(balance => balance.provider === 'anthropic')?.requestsRemaining,
    expect.requestsRemaining,
    'requestsRemaining',
  )
}

function verifyProviderErrorTaxonomy(expect: Record<string, unknown>): void {
  assertEqual(
    classifyProviderError(new Error('HTTP 429 rate limit')).kind,
    expect.rateLimit,
    'rateLimit',
  )
  assertEqual(
    classifyProviderError(new Error('HTTP 401 invalid API key')).kind,
    expect.authentication,
    'authentication',
  )
  assertEqual(
    classifyProviderError(new Error('HTTP 413 context window too long')).kind,
    expect.contextLength,
    'contextLength',
  )
  assertEqual(
    classifyProviderError(new Error('network fetch failed')).kind,
    expect.network,
    'network',
  )
}

async function verifyQueryToolLoop(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-6-runtime-golden-'))
  const requests: ProviderRequest[] = []
  try {
    writeFileSync(join(cwd, 'hello.txt'), 'hello from runtime golden', 'utf8')
    const events = await Array.fromAsync(queryLoop({
      prompt: 'read hello.txt',
      cwd,
      maxTurns: 3,
      provider: async function* (request) {
        requests.push(request)
        if (requests.length === 1) {
          yield messageStart()
          yield toolUseStart('toolu_read', 'Read')
          yield toolInputDelta('{"file_path":"hello.txt"}')
          yield contentBlockStop()
          yield messageDelta('tool_use')
          yield messageStop()
          return
        }

        yield messageStart()
        yield textStart()
        yield textDelta('read result observed')
        yield contentBlockStop()
        yield messageDelta('end_turn')
        yield messageStop()
      },
    }))

    const terminal = events.findLast(event => event.type === 'terminal')
    const toolResult = events.find(event =>
      event.type === 'tool_execution_result' &&
      event.name === expect.tool
    )
    const secondRequestContent = JSON.stringify(requests.at(1)?.messages ?? [])
    assertEqual(terminal?.status, expect.terminal, 'terminal')
    assertEqual(requests.length, expect.requestCount, 'requestCount')
    if (!toolResult || !secondRequestContent.includes(String(expect.resultContains))) {
      throw new Error('tool result was not propagated into the follow-up provider request')
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function verifyQueryMaxTurns(expect: Record<string, unknown>): Promise<void> {
  const events = await Array.fromAsync(queryLoop({
    prompt: 'needs tool',
    maxTurns: 1,
    provider: async function* () {
      yield messageStart()
      yield toolUseStart('toolu_read', 'Read')
      yield toolInputDelta('{"file_path":"hello.txt"}')
      yield contentBlockStop()
      yield messageDelta('tool_use')
      yield messageStop()
    },
  }))
  assertEqual(events.findLast(event => event.type === 'terminal')?.status, expect.terminal, 'terminal')
}

async function verifyQueryAbort(expect: Record<string, unknown>): Promise<void> {
  const events = await Array.fromAsync(queryLoop({
    prompt: 'abort',
    provider: async function* () {
      throw new DOMException('aborted', 'AbortError')
    },
  }))
  assertEqual(events.findLast(event => event.type === 'terminal')?.status, expect.terminal, 'terminal')
}

function verifyCompactRetry(expect: Record<string, unknown>): void {
  const result = applyAutoCompact([
    { role: 'user', content: 'first message '.repeat(100) },
    { role: 'assistant', content: 'second message '.repeat(100) },
    { role: 'user', content: 'latest' },
  ], {
    thresholdTokens: 10,
    keepLastMessages: 1,
  })
  assertEqual(result.compacted, expect.compacted, 'compacted')
  if (!result.summary?.includes(String(expect.summaryContains))) {
    throw new Error('compact summary did not include expected marker')
  }
}

function fakeAnthropicProvider() {
  const capabilities: ProviderModelCapabilities = {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    aliases: ['sonnet'],
    displayName: 'Claude 3.5 Sonnet',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsTextStreaming: true,
    supportsToolCallDelta: true,
    supportsThinking: true,
    supportsUsageMapping: true,
    supportsPromptCache: true,
    supportsSystemMessages: true,
    supportsTools: true,
  }

  return {
    metadata: {
      name: 'anthropic' as const,
      displayName: 'Anthropic',
      defaultModel: 'claude-3-5-sonnet-latest',
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      models: [capabilities],
      rateLimit: {
        windowMs: 60_000,
        requestLimit: 2,
        tokenLimit: 100,
      },
    },
    stream: async function* () {
      yield {
        type: 'message_start',
        message: {
          id: 'msg_provider',
          role: 'assistant',
          model: 'claude-3-5-sonnet-latest',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        },
      } satisfies QueryEvent
      yield messageDelta('end_turn', {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      })
      yield messageStop()
    },
  }
}

function messageStart(): QueryEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-3-5-sonnet-latest',
    },
  }
}

function textStart(): QueryEvent {
  return {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }
}

function textDelta(text: string): QueryEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }
}

function toolUseStart(id: string, name: string): QueryEvent {
  return {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id,
      name,
      input: {},
    },
  }
}

function toolInputDelta(partialJson: string): QueryEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: partialJson,
    },
  }
}

function contentBlockStop(): QueryEvent {
  return {
    type: 'content_block_stop',
    index: 0,
  }
}

function messageDelta(
  stopReason: 'end_turn' | 'tool_use',
  usage?: Usage,
): QueryEvent {
  return {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage,
  } as QueryEvent
}

function messageStop(): QueryEvent {
  return {
    type: 'message_stop',
  }
}

function assertEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${String(expected)}, got ${String(actual)}`)
  }
}
