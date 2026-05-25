import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { handleMcpMessage } from './mcpEntrypoint.js'
import { StructuredIO } from './structuredIO.js'
import {
  HybridTransport,
  SSETransport,
  WebSocketTransport,
  getTransportForUrl,
  parseSSEFrames,
} from './transports.js'

class MemoryWriter {
  value = ''

  write(chunk: string) {
    this.value += chunk
  }
}

describe('strict SDK entrypoints and CLI transports', () => {
  it('parses structured SDK input and resolves control responses', async () => {
    let pushInput: (chunk: string) => void = () => {}
    const input = {
      async *[Symbol.asyncIterator]() {
        yield await new Promise<string>(resolve => {
          pushInput = resolve
        })
      },
    }
    const writer = new MemoryWriter()
    const structured = new StructuredIO(input, writer)
    const drain = (async () => {
      for await (const _message of structured.read()) {
        // Drain non-control messages so response dispatch remains active.
      }
    })()

    const responsePromise = structured.sendRequest(
      {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        input: { file_path: 'README.md' },
        tool_use_id: 'toolu_1',
      },
      {
        requestId: 'req_1',
      },
    )
    expect(JSON.parse(writer.value)).toMatchObject({
      type: 'control_request',
      request_id: 'req_1',
    })

    pushInput('{"type":"control_response","request_id":"req_1","response":{"behavior":"allow"}}\n')
    await expect(responsePromise).resolves.toMatchObject({
      request_id: 'req_1',
      response: { behavior: 'allow' },
    })
    await drain
  })

  it('selects websocket, hybrid, and SSE transports and parses SSE frames', () => {
    expect(getTransportForUrl(new URL('ws://example.test/session'))).toBeInstanceOf(
      WebSocketTransport,
    )
    expect(
      getTransportForUrl(new URL('wss://example.test/session'), {
        usePostForWrites: true,
      }),
    ).toBeInstanceOf(HybridTransport)
    expect(
      getTransportForUrl(new URL('wss://example.test/session'), {
        useSSE: true,
      }),
    ).toBeInstanceOf(SSETransport)

    expect(
      parseSSEFrames('event: client_event\nid: 1\ndata: {"type":"user"}\n\npartial'),
    ).toEqual({
      frames: [
        {
          event: 'client_event',
          id: '1',
          data: '{"type":"user"}',
        },
      ],
      remaining: 'partial',
    })
  })

  it('exposes local tools through the MCP JSON-RPC entrypoint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-'))

    try {
      writeFileSync(join(cwd, 'hello.txt'), 'hello from mcp', 'utf8')
      const list = await handleMcpMessage(
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        cwd,
      )
      expect(list?.result).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'Read',
          }),
        ]),
      })

      const call = await handleMcpMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'Read',
            arguments: {
              file_path: 'hello.txt',
            },
          },
        }),
        cwd,
      )
      expect(JSON.stringify(call?.result)).toContain('hello from mcp')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
