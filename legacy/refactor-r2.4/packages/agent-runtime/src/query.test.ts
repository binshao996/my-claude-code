import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { QueryEvent } from '@my-claude-code/core'
import {
  DEFAULT_SYSTEM_PROMPT,
  buildMessages,
  buildRuntimeMessages,
  query,
  queryLoop,
} from './query.js'
import { QueryEngine } from './queryEngine.js'
import { collectTextDeltas } from './render.js'
import { readTranscript } from './transcript.js'

describe('query runtime', () => {
  it('runs through a reusable QueryEngine wrapper', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-query-engine-'))

    try {
      const engine = new QueryEngine({
        cwd,
        provider: async function* () {
          yield messageStart()
          yield textStart()
          yield textDelta('engine-ready')
          yield textStop()
          yield messageDelta('end_turn')
          yield { type: 'message_stop' }
        },
      })
      const result = await engine.run({
        prompt: 'hello engine',
        sessionId: 'engine_session',
      })

      expect(result.terminal).toMatchObject({
        type: 'terminal',
        status: 'completed',
      })
      expect(
        collectTextDeltas(
          result.events.filter(event => event.type !== 'terminal') as QueryEvent[],
        ),
      ).toBe('engine-ready')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('streams text deltas and appends transcript records', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-query-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')

    try {
      const events = await Array.fromAsync(
        query({
          prompt: 'hello',
          cwd,
          sessionId: 'session_1',
          transcriptPath,
          provider: async function* () {
            yield messageStart()
            yield textStart()
            yield textDelta('hello')
            yield textDelta(' world')
            yield textStop()
            yield messageDelta('end_turn')
            yield { type: 'message_stop' }
          },
        }),
      )

      expect(
        collectTextDeltas(
          events.filter(event => event.type !== 'terminal') as QueryEvent[],
        ),
      ).toBe('hello world')
      expect(events.at(-1)).toEqual({
        type: 'terminal',
        status: 'completed',
        exitCode: 0,
        reason: undefined,
      })

      const records = await readTranscript(transcriptPath)
      expect(records).toHaveLength(events.length)
      expect(records[0].session_id).toBe('session_1')
      expect(records.at(-1)?.event).toMatchObject({
        type: 'terminal',
        status: 'completed',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns max_turns when tool_use needs another model turn but maxTurns is exhausted', async () => {
    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'use a tool',
        maxTurns: 1,
        provider: async function* () {
          yield messageStart()
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: {},
            },
          }
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"pwd"}',
            },
          }
          yield {
            type: 'content_block_stop',
            index: 0,
          }
          yield messageDelta('tool_use')
          yield { type: 'message_stop' }
        },
      }),
    )

    expect(events.at(-1)).toMatchObject({
      type: 'terminal',
      status: 'max_turns',
      exitCode: 1,
    })
  })

  it('executes a Read tool, appends tool_result, and continues the query loop', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-query-'))
    writeFileSync(join(cwd, 'hello.txt'), 'hello from file', 'utf8')
    const requests: Array<{ messages: unknown[]; tools: unknown[] | undefined }> = []

    try {
      const events = await Array.fromAsync(
        queryLoop({
          prompt: 'read hello.txt',
          cwd,
          maxTurns: 3,
          provider: async function* (request) {
            requests.push({
              messages: request.messages,
              tools: request.tools,
            })

            if (requests.length === 1) {
              yield messageStart()
              yield {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: 'toolu_read',
                  name: 'Read',
                  input: {},
                },
              }
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'input_json_delta',
                  partial_json: '{"file_path":"hello.txt"}',
                },
              }
              yield {
                type: 'content_block_stop',
                index: 0,
              }
              yield messageDelta('tool_use')
              yield { type: 'message_stop' }
              return
            }

            yield messageStart()
            yield textStart()
            yield textDelta('read result observed')
            yield textStop()
            yield messageDelta('end_turn')
            yield { type: 'message_stop' }
          },
        }),
      )

      expect(requests).toHaveLength(2)
      expect(requests[0].tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Read' }),
          expect.objectContaining({ name: 'Bash' }),
        ]),
      )
      expect(requests[1].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: [
              expect.objectContaining({
                type: 'tool_result',
                tool_use_id: 'toolu_read',
                content: expect.stringContaining('hello from file'),
              }),
            ],
          }),
        ]),
      )
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_execution_result',
            tool_use_id: 'toolu_read',
            is_error: false,
          }),
          expect.objectContaining({
            type: 'terminal',
            status: 'completed',
          }),
        ]),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps provider tool schemas available for scoped pattern grants', async () => {
    const requests: Array<{ tools: Array<{ name: string }> | undefined }> = []

    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'inspect tools',
        allowedTools: ['Write(allowed.txt)'],
        provider: async function* (request) {
          requests.push({
            tools: request.tools?.map(tool => ({ name: tool.name })),
          })
          yield messageStart()
          yield textStart()
          yield textDelta('ok')
          yield textStop()
          yield messageDelta('end_turn')
          yield { type: 'message_stop' }
        },
      }),
    )

    expect(requests[0]?.tools).toEqual(
      expect.arrayContaining([
        { name: 'Read' },
        { name: 'Write' },
        { name: 'Bash' },
      ]),
    )
    expect(events.at(-1)).toMatchObject({ type: 'terminal', status: 'completed' })
  })

  it('discovers and executes V0.6 MCP tools through the query loop', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-query-'))
    const serverPath = join(cwd, 'mcp-server.mjs')
    const requests: Array<{ tools: Array<{ name: string }> | undefined }> = []

    try {
      writeFileSync(serverPath, mcpFixtureServer(), 'utf8')
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            demo: {
              type: 'stdio',
              command: process.execPath,
              args: [serverPath],
            },
          },
        }),
        'utf8',
      )

      const events = await Array.fromAsync(
        queryLoop({
          prompt: 'call mcp echo',
          cwd,
          maxTurns: 3,
          extensionDiscoveryTimeoutMs: 2000,
          provider: async function* (request) {
            requests.push({
              tools: request.tools?.map(tool => ({ name: tool.name })),
            })

            if (requests.length === 1) {
              yield messageStart()
              yield {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: 'toolu_mcp',
                  name: 'mcp__demo__echo',
                  input: {},
                },
              }
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'input_json_delta',
                  partial_json: '{"text":"hello"}',
                },
              }
              yield { type: 'content_block_stop', index: 0 }
              yield messageDelta('tool_use')
              yield { type: 'message_stop' }
              return
            }

            yield messageStart()
            yield textStart()
            yield textDelta('mcp observed')
            yield textStop()
            yield messageDelta('end_turn')
            yield { type: 'message_stop' }
          },
        }),
      )

      expect(requests[0]?.tools).toEqual(
        expect.arrayContaining([{ name: 'mcp__demo__echo' }]),
      )
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_execution_result',
            tool_use_id: 'toolu_mcp',
            content: 'echo:hello',
          }),
        ]),
      )
      expect(events.at(-1)).toMatchObject({ type: 'terminal', status: 'completed' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('terminates on denied write tools before the model can claim success', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-query-'))
    const requests: unknown[] = []

    try {
      const events = await Array.fromAsync(
        queryLoop({
          prompt: 'create hello1.txt',
          cwd,
          maxTurns: 3,
          provider: async function* (request) {
            requests.push(request)
            yield messageStart()
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'toolu_write',
                name: 'Write',
                input: {},
              },
            }
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: '{"file_path":"hello1.txt","content":"hello"}',
              },
            }
            yield {
              type: 'content_block_stop',
              index: 0,
            }
            yield messageDelta('tool_use')
            yield { type: 'message_stop' }
          },
        }),
      )

      expect(requests).toHaveLength(1)
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_execution_result',
            tool_use_id: 'toolu_write',
            is_error: true,
            permission_decision: 'deny',
          }),
          expect.objectContaining({
            type: 'terminal',
            status: 'tool_error',
            exitCode: 1,
          }),
        ]),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns aborted_streaming when the provider aborts', async () => {
    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'abort',
        provider: async function* () {
          if (process.env.NEVER_YIELD_IN_ABORT_TEST === '1') {
            yield messageStart()
          }
          throw new DOMException('aborted', 'AbortError')
        },
      }),
    )

    expect(events).toEqual([
      {
        type: 'terminal',
        status: 'aborted_streaming',
        exitCode: 130,
        reason: 'streaming aborted',
      },
    ])
  })

  it('applies UserPromptSubmit hooks before building provider messages', async () => {
    const requests: unknown[] = []

    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'original',
        userPromptSubmitHooks: [
          ({ prompt }) => `${prompt} plus hook`,
        ],
        provider: async function* (request) {
          requests.push(request)
          yield messageStart()
          yield textStart()
          yield textDelta('ok')
          yield textStop()
          yield messageDelta('end_turn')
          yield { type: 'message_stop' }
        },
      }),
    )

    expect(requests).toEqual([
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: 'original plus hook',
          }),
        ]),
      }),
    ])
    expect(events.at(-1)).toMatchObject({ type: 'terminal', status: 'completed' })
  })

  it('lets Stop hooks block completion', async () => {
    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'hello',
        stopHooks: [
          () => ({ decision: 'block', reason: 'blocked by stop hook' }),
        ],
        provider: async function* () {
          yield messageStart()
          yield textStart()
          yield textDelta('ok')
          yield textStop()
          yield messageDelta('end_turn')
          yield { type: 'message_stop' }
        },
      }),
    )

    expect(events.at(-1)).toMatchObject({
      type: 'terminal',
      status: 'hook_blocked',
      exitCode: 1,
      reason: 'blocked by stop hook',
    })
  })

  it('builds system prompt, user context, and user prompt messages', () => {
    expect(
      buildMessages({
        prompt: 'do work',
        systemPrompt: 'system',
        appendSystemPrompt: 'append',
        userContext: 'context',
      }),
    ).toEqual([
      {
        role: 'system',
        content: 'system\n\nappend\n\ncontext',
      },
      {
        role: 'user',
        content: 'do work',
      },
    ])
  })

  it('builds runtime messages with V0.5 context sections and CLAUDE.md memory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-query-'))
    writeFileSync(join(cwd, 'CLAUDE.md'), 'prefer focused tests', 'utf8')

    try {
      const messages = await buildRuntimeMessages({
        cwd,
        prompt: 'do work',
        systemPrompt: 'system',
        userContext: 'resume context',
      })

      const systemContent = String(messages[0]?.content)
      expect(messages[0]?.role).toBe('system')
      expect(systemContent).toContain('## Memory')
      expect(systemContent).toContain('prefer focused tests')
      expect(systemContent).toContain('resume context')
      expect(messages.at(-1)).toEqual({
        role: 'user',
        content: 'do work',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('builds runtime messages with native image prompt content blocks', async () => {
    const imageData = Buffer.from('png').toString('base64')
    const messages = await buildRuntimeMessages({
      prompt: 'describe @image:clipboard',
      promptContent: [
        { type: 'text', text: 'describe @image:clipboard' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: imageData,
          },
        },
      ],
    })

    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'describe @image:clipboard' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: imageData,
          },
        },
      ],
    })
  })

  it('applies tool result budget before the follow-up provider turn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-query-'))
    writeFileSync(join(cwd, 'big.txt'), 'x'.repeat(400), 'utf8')
    const requests: Array<{ messages: unknown[] }> = []

    try {
      const events = await Array.fromAsync(
        queryLoop({
          prompt: 'read big.txt',
          cwd,
          sessionId: 'session_budget',
          maxTurns: 3,
          maxToolResultChars: 40,
          maxTotalToolResultChars: 40,
          provider: async function* (request) {
            requests.push({ messages: request.messages })

            if (requests.length === 1) {
              yield messageStart()
              yield {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: 'toolu_read',
                  name: 'Read',
                  input: {},
                },
              }
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'input_json_delta',
                  partial_json: '{"file_path":"big.txt"}',
                },
              }
              yield {
                type: 'content_block_stop',
                index: 0,
              }
              yield messageDelta('tool_use')
              yield { type: 'message_stop' }
              return
            }

            yield messageStart()
            yield textStart()
            yield textDelta('budgeted')
            yield textStop()
            yield messageDelta('end_turn')
            yield { type: 'message_stop' }
          },
        }),
      )

      const secondRequest = requests[1]?.messages as Array<{
        role: string
        content: unknown
      }>
      const toolResultMessage = secondRequest.find(
        message => message.role === 'user' && Array.isArray(message.content),
      )
      const toolResult = Array.isArray(toolResultMessage?.content)
        ? toolResultMessage.content[0]
        : undefined
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        content: expect.stringContaining('persisted at .my-claude-code/tool-results'),
      })
      expect(
        existsSync(join(cwd, '.my-claude-code', 'tool-results')),
      ).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: 'terminal', status: 'completed' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('auto-compacts provider messages before request when threshold is exceeded', async () => {
    const requests: Array<{ messages: unknown[] }> = []
    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'current task',
        autoCompactTokenThreshold: 20,
        messages: [
          {
            role: 'user',
            content: 'old context '.repeat(200),
          },
        ],
        provider: async function* (request) {
          requests.push({ messages: request.messages })
          yield messageStart()
          yield textStart()
          yield textDelta('ok')
          yield textStop()
          yield messageDelta('end_turn')
          yield { type: 'message_stop' }
        },
      }),
    )

    expect(requests[0]?.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('compact_boundary'),
    })
    expect(events.at(-1)).toMatchObject({ type: 'terminal', status: 'completed' })
  })

  it('uses an injected compact summarizer before provider requests', async () => {
    const requests: Array<{ messages: unknown[] }> = []
    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'current task',
        autoCompactTokenThreshold: 20,
        messages: [
          {
            role: 'user',
            content: 'old context '.repeat(200),
          },
        ],
        compactSummarizer: () => 'summarized by compact model',
        provider: async function* (request) {
          requests.push({ messages: request.messages })
          yield messageStart()
          yield textStart()
          yield textDelta('ok')
          yield textStop()
          yield messageDelta('end_turn')
          yield { type: 'message_stop' }
        },
      }),
    )

    expect(requests[0]?.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('summary:\nsummarized by compact model'),
    })
    expect(events.at(-1)).toMatchObject({ type: 'terminal', status: 'completed' })
  })

  it('reactively compacts and retries once when provider reports context overflow', async () => {
    const requests: Array<{ messages: unknown[] }> = []
    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'current task',
        messages: [
          {
            role: 'user',
            content: 'old context '.repeat(200),
          },
        ],
        provider: async function* (request) {
          requests.push({ messages: request.messages })
          if (requests.length === 1) {
            throw new Error('prompt too long: context window exceeded')
          }

          yield messageStart()
          yield textStart()
          yield textDelta('after compact')
          yield textStop()
          yield messageDelta('end_turn')
          yield { type: 'message_stop' }
        },
      }),
    )

    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('compact_boundary'),
    })
    expect(events.at(-1)).toMatchObject({ type: 'terminal', status: 'completed' })
  })

  it('reports prompt_too_long when reactive compact retry still overflows', async () => {
    const events = await Array.fromAsync(
      queryLoop({
        prompt: 'current task',
        provider: async function* (request) {
          if (request.messages.length < 0) {
            yield messageStart()
          }
          throw new Error('413 prompt too long')
        },
      }),
    )

    expect(events.at(-1)).toEqual({
      type: 'terminal',
      status: 'prompt_too_long',
      exitCode: 1,
      reason: 'context window exceeded after compact retry',
    })
  })

  it('uses a default system prompt that forbids fake file-operation success', () => {
    expect(buildMessages({ prompt: 'create a file' })[0]).toEqual({
      role: 'system',
      content: DEFAULT_SYSTEM_PROMPT,
    })
  })
})

function messageStart(): QueryEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'deepseek-v4-flash',
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

function textStop(): QueryEvent {
  return {
    type: 'content_block_stop',
    index: 0,
  }
}

function messageDelta(stopReason: 'end_turn' | 'tool_use'): QueryEvent {
  return {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
  }
}

function mcpFixtureServer(): string {
  return `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'demo', version: '1.0.0' }
        }
      }) + '\\n')
    }
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{
            name: 'echo',
            description: 'Echo text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text']
            },
            annotations: { readOnlyHint: true }
          }]
        }
      }) + '\\n')
    }
    if (message.method === 'resources/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { resources: [] }
      }) + '\\n')
    }
    if (message.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'echo:' + message.params.arguments.text }] }
      }) + '\\n')
    }
  }
})
`
}
