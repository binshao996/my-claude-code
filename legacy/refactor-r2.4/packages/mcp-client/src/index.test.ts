import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  callLiveMcpTool,
  collectProjectMcpServerConfigs,
  discoverLiveMcpTools,
  getMcpServerConnectionStates,
  McpDiscoveryError,
  subscribeLiveMcpResource,
} from './index.js'

describe('mcp-client package', () => {
  it('discovers and calls stdio MCP tools through the package API', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-client-'))
    const serverPath = join(cwd, 'server.mjs')

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

      await expect(discoverLiveMcpTools(cwd, { timeoutMs: 2_000 })).resolves.toEqual([
        {
          name: 'mcp__demo__echo',
          serverName: 'demo',
          toolName: 'echo',
          description: 'Echo text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
          },
        },
      ])
      await expect(
        callLiveMcpTool(
          cwd,
          {
            serverName: 'demo',
            toolName: 'echo',
            input: { text: 'hello' },
          },
          { timeoutMs: 2_000 },
        ),
      ).resolves.toEqual({
        content: [{ type: 'text', text: 'echo:hello' }],
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('enforces OAuth, approval, and managed policy gates before transport use', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-client-'))

    try {
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            blocked: {
              type: 'http',
              url: 'https://example.test/blocked',
              headers: { Authorization: 'Bearer fixture-header-value' },
              oauth: { required: true, token: 'fixture-oauth-value' },
              managedPolicy: { denied: true },
            },
            pending: {
              type: 'stdio',
              command: process.execPath,
              args: ['server.mjs'],
              env: { SECRET_TOKEN: 'fixture-env-value' },
              approvalState: 'pending',
            },
            needsAuth: {
              type: 'sse',
              url: 'https://example.test/mcp/sse',
              oauth: true,
              approvalState: 'approved',
            },
          },
        }),
        'utf8',
      )

      const states = await getMcpServerConnectionStates(cwd)
      expect(states).toEqual([
        {
          serverName: 'blocked',
          transport: 'http',
          source: 'project',
          phase: 'policy-denied',
          errorCode: 'policy_denied',
          configHash: expect.any(String),
          signature: 'http:https://example.test/blocked',
        },
        {
          serverName: 'needsAuth',
          transport: 'sse',
          source: 'project',
          phase: 'oauth-required',
          errorCode: 'oauth_required',
          configHash: expect.any(String),
          signature: 'sse:https://example.test/mcp/sse',
        },
        {
          serverName: 'pending',
          transport: 'stdio',
          source: 'project',
          phase: 'approval-required',
          errorCode: 'approval_required',
          configHash: expect.any(String),
          signature: `stdio:${process.execPath}:${JSON.stringify(['server.mjs'])}`,
        },
      ])
      expect(JSON.stringify(states)).not.toContain('fixture-header-value')
      expect(JSON.stringify(states)).not.toContain('fixture-oauth-value')
      expect(JSON.stringify(states)).not.toContain('fixture-env-value')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('throws typed MCP errors for blocked tool calls', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-client-'))

    try {
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            blocked: {
              type: 'stdio',
              command: process.execPath,
              args: ['server.mjs'],
              policy: 'deny',
            },
          },
        }),
        'utf8',
      )

      const configs = await collectProjectMcpServerConfigs(cwd)
      expect(configs).toEqual([
        [
          'blocked',
          {
            type: 'stdio',
            command: process.execPath,
            args: ['server.mjs'],
            policy: 'deny',
          },
        ],
      ])

      await expect(
        callLiveMcpTool(cwd, {
          serverName: 'blocked',
          toolName: 'echo',
          input: {},
        }),
      ).rejects.toMatchObject({
        name: 'McpDiscoveryError',
        code: 'policy_denied',
      } satisfies Partial<McpDiscoveryError>)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs remote HTTP/SSE MCP requests with OAuth refresh and resource subscribe', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-client-'))
    const requests: Array<{ url: string; authorization?: string; body: unknown }> = []

    try {
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            remote: {
              type: 'http',
              url: 'https://mcp.example.test/rpc',
              oauth: {
                required: true,
                refreshUrl: 'https://auth.example.test/token',
                clientId: 'my-claude-code',
                scopes: ['tools.read'],
              },
              approvalState: 'approved',
            },
            events: {
              type: 'sse',
              url: 'https://mcp.example.test/sse',
              oauth: true,
              approvalState: 'approved',
            },
          },
        }),
        'utf8',
      )

      const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get('authorization') ?? undefined,
          body,
        })

        if (String(url).endsWith('/sse')) {
          return new Response(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                resources: [{ uri: 'skill://remote/code-review' }],
              },
            })}\n\n`,
            {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            },
          )
        }

        if (body.method === 'tools/list') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [{ name: 'search', description: 'Search remote', inputSchema: { type: 'object' } }],
            },
          })
        }
        if (body.method === 'tools/call') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: `remote:${body.params.name}` }] },
          })
        }
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { subscribed: body.params.uri },
        })
      }

      await expect(
        discoverLiveMcpTools(cwd, {
          fetchImpl,
          refreshOAuthToken: async request =>
            request.serverName === 'remote' && request.refreshUrl ? 'fresh-token' : 'event-token',
        }),
      ).resolves.toEqual([
        {
          name: 'mcp__remote__search',
          serverName: 'remote',
          toolName: 'search',
          description: 'Search remote',
          inputSchema: { type: 'object' },
        },
      ])
      await expect(
        callLiveMcpTool(
          cwd,
          { serverName: 'remote', toolName: 'search', input: { query: 'parity' } },
          {
            fetchImpl,
            refreshOAuthToken: async () => 'fresh-token',
          },
        ),
      ).resolves.toEqual({ content: [{ type: 'text', text: 'remote:search' }] })
      await expect(
        subscribeLiveMcpResource(
          cwd,
          { serverName: 'remote', uri: 'skill://remote/code-review' },
          {
            fetchImpl,
            refreshOAuthToken: async () => 'fresh-token',
          },
        ),
      ).resolves.toEqual({ subscribed: 'skill://remote/code-review' })
      const states = await getMcpServerConnectionStates(cwd, {
        refreshOAuthToken: async () => 'state-token',
      })
      expect(states.map(state => [state.serverName, state.phase, state.transport])).toEqual([
        ['events', 'approved', 'sse'],
        ['remote', 'approved', 'http'],
      ])
      expect(requests.map(request => request.authorization)).toEqual([
        'Bearer fresh-token',
        'Bearer event-token',
        'Bearer fresh-token',
        'Bearer fresh-token',
      ])
      expect(JSON.stringify(requests)).not.toContain('state-token')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

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
              properties: { text: { type: 'string' } }
            }
          }]
        }
      }) + '\\n')
    }
    if (message.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: 'echo:' + message.params.arguments.text }]
        }
      }) + '\\n')
    }
  }
})
`
}
