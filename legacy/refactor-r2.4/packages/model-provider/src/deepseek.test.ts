import { describe, expect, it } from 'bun:test'
import { QueryEventSchema } from '@my-claude-code/core'
import {
  DeepSeekStreamAdapter,
  createDeepSeekChatCompletionBody,
  createTextStreamingProbeBody,
  createDeepSeekCompatibilitySpikeResult,
  createToolCallProbeBody,
  mapDeepSeekStopReason,
  mapDeepSeekUsage,
  streamDeepSeekQuery,
} from './index.js'

describe('DeepSeek stream adapter', () => {
  it('maps text deltas into Claude-compatible query events', () => {
    const adapter = new DeepSeekStreamAdapter()
    const events = adapter.accept({
      id: 'chatcmpl_1',
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'hello' },
          finish_reason: null,
        },
      ],
    })

    for (const event of events) {
      QueryEventSchema.parse(event)
    }

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
    ])
  })

  it('maps split tool-call JSON deltas and stop reason', () => {
    const adapter = new DeepSeekStreamAdapter()

    const first = adapter.accept({
      id: 'chatcmpl_2',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'Bash', arguments: '{"command"' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })

    const second = adapter.accept({
      id: 'chatcmpl_2',
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: ':"pwd"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })

    const events = [...first, ...second]

    for (const event of events) {
      QueryEventSchema.parse(event)
    }

    expect(
      events
        .filter(event => event.type === 'content_block_delta')
        .map(event => event.delta),
    ).toEqual([
      { type: 'input_json_delta', partial_json: '{"command"' },
      { type: 'input_json_delta', partial_json: ':"pwd"}' },
    ])
    expect(events.at(-2)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { input_tokens: 12, output_tokens: 8 },
    })
  })

  it('parses SSE data lines', () => {
    const adapter = new DeepSeekStreamAdapter()
    const chunkEvents = adapter.acceptSSELine(
      'data: {"id":"chatcmpl_3","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}',
    )
    const doneEvents = adapter.acceptSSELine('data: [DONE]')

    expect(chunkEvents.length).toBe(3)
    expect(doneEvents.map(event => event.type)).toEqual([
      'content_block_stop',
      'message_stop',
    ])
  })

  it('maps DeepSeek reasoning_content into thinking blocks', () => {
    const adapter = new DeepSeekStreamAdapter()
    const reasoningEvents = adapter.accept({
      id: 'chatcmpl_reasoning',
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: 'thinking',
          },
          finish_reason: null,
        },
      ],
    })
    const textEvents = adapter.accept({
      id: 'chatcmpl_reasoning',
      choices: [
        {
          index: 0,
          delta: {
            content: 'answer',
          },
          finish_reason: 'stop',
        },
      ],
    })

    const events = [...reasoningEvents, ...textEvents]

    for (const event of events) {
      QueryEventSchema.parse(event)
    }

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[1]).toMatchObject({
      type: 'content_block_start',
      content_block: { type: 'thinking' },
    })
    expect(events[2]).toMatchObject({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'thinking' },
    })
  })

  it('maps usage-only stream chunks', () => {
    const adapter = new DeepSeekStreamAdapter()
    const events = adapter.accept({
      id: 'chatcmpl_4',
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      choices: [],
    })

    expect(events).toEqual([
      {
        type: 'message_start',
        message: {
          id: 'chatcmpl_4',
          role: 'assistant',
          model: 'deepseek-v4-flash',
          usage: { input_tokens: 3, output_tokens: 5 },
        },
      },
      {
        type: 'message_delta',
        delta: {},
        usage: { input_tokens: 3, output_tokens: 5 },
      },
    ])
  })

  it('maps usage and finish reasons', () => {
    expect(
      mapDeepSeekUsage({
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      }),
    ).toEqual({ input_tokens: 1, output_tokens: 2 })
    expect(mapDeepSeekStopReason('stop')).toBe('end_turn')
    expect(mapDeepSeekStopReason('length')).toBe('max_tokens')
    expect(mapDeepSeekStopReason('content_filter')).toBe('refusal')
    expect(mapDeepSeekStopReason('insufficient_system_resource')).toBe('error')
  })

  it('records the V0.1 compatibility conclusion', () => {
    expect(createDeepSeekCompatibilitySpikeResult()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      supportsTextStreaming: true,
      supportsToolCallDelta: true,
      supportsUsageMapping: true,
      requiresPromptWrappedToolCalls: false,
    })
  })

  it('builds live spike request bodies without secrets', () => {
    expect(createTextStreamingProbeBody()).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(JSON.stringify(createToolCallProbeBody())).toContain('probe_echo')
    expect(JSON.stringify(createToolCallProbeBody())).not.toContain(
      'tool_choice',
    )
    expect(JSON.stringify(createToolCallProbeBody())).not.toContain(
      'DEEPSEEK_API_KEY',
    )
  })

  it('builds chat completion request bodies from provider requests', () => {
    expect(
      createDeepSeekChatCompletionBody({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 32,
      }),
    ).toMatchObject({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('maps Claude tool_use and tool_result blocks to DeepSeek tool messages', () => {
    const body = createDeepSeekChatCompletionBody({
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will search.' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'WebSearch',
              input: { query: 'Jack Ma' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'result text',
            },
          ],
        },
      ],
    })

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: 'I will search.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'WebSearch',
              arguments: '{"query":"Jack Ma"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'result text',
      },
    ])
    expect(JSON.stringify(body.messages)).not.toContain(
      '{"id":"call_1","name":"WebSearch","input"',
    )
  })

  it('passes assistant thinking history back as DeepSeek reasoning_content', () => {
    const body = createDeepSeekChatCompletionBody({
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private reasoning', signature: '' },
            { type: 'text', text: 'public answer' },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
    })

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: 'public answer',
        reasoning_content: 'private reasoning',
      },
      {
        role: 'user',
        content: 'continue',
      },
    ])
  })

  it('streams live request events through a fetch-compatible fixture', async () => {
    const fetchCalls: RequestInit[] = []
    const events: string[] = [
      'data: {"id":"chatcmpl_stream","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl_stream","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n',
      'data: [DONE]\n',
    ]

    const result = await Array.fromAsync(
      streamDeepSeekQuery(
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'hello' }],
          apiKey: 'test-key',
        },
        {
          fetchImpl: (async (_url, init) => {
            fetchCalls.push(init ?? {})
            return new Response(events.join(''), {
              status: 200,
            })
          }) as typeof fetch,
        },
      ),
    )

    expect(fetchCalls[0].headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    })
    expect(result.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })
})
