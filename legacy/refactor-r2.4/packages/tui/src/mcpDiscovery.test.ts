import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  callLiveMcpTool,
  collectProjectMcpServerConfigs,
  discoverLiveMcpResources,
  discoverLiveMcpTools,
  discoverStdioMcpServerResources,
  getMcpServerConnectionStates,
  McpDiscoveryError,
} from './mcpDiscovery.js'

describe('MCP live discovery', () => {
  it('loads project-scoped .mcp.json server configs', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-'))

    try {
      mkdirSync(join(cwd, 'nested'), { recursive: true })
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            demo: {
              type: 'stdio',
              command: 'node',
              args: ['server.js'],
              env: {
                DEMO: '1',
              },
            },
          },
        }),
        'utf8',
      )

      await expect(collectProjectMcpServerConfigs(join(cwd, 'nested'))).resolves.toEqual([
        [
          'demo',
          {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: {
              DEMO: '1',
            },
          },
        ],
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('discovers stdio MCP resources with initialize and resources/list', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-'))
    const serverPath = join(cwd, 'server.mjs')

    try {
      writeFileSync(
        serverPath,
        `
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
          capabilities: { resources: {} },
          serverInfo: { name: 'demo', version: '1.0.0' }
        }
      }) + '\\n')
    }
    if (message.method === 'resources/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          resources: [
            { uri: 'demo://two' },
            { uri: 'demo://one' }
          ]
        }
      }) + '\\n')
    }
  }
})
`,
        'utf8',
      )
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

      await expect(discoverLiveMcpResources(cwd, { timeoutMs: 2000 })).resolves.toEqual([
        'demo://one',
        'demo://two',
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('discovers and calls stdio MCP tools', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-'))
    const serverPath = join(cwd, 'tool-server.mjs')

    try {
      writeFileSync(
        serverPath,
        `
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
          serverInfo: { name: 'tools', version: '1.0.0' }
        }
      }) + '\\n')
    }
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo text',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } }
              }
            }
          ]
        }
      }) + '\\n')
    }
    if (message.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            { type: 'text', text: 'echo:' + message.params.arguments.text }
          ]
        }
      }) + '\\n')
    }
  }
})
`,
        'utf8',
      )
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            tools: {
              type: 'stdio',
              command: process.execPath,
              args: [serverPath],
            },
          },
        }),
        'utf8',
      )

      await expect(discoverLiveMcpTools(cwd, { timeoutMs: 2000 })).resolves.toEqual([
        {
          name: 'mcp__tools__echo',
          serverName: 'tools',
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
            serverName: 'tools',
            toolName: 'echo',
            input: { text: 'hello' },
          },
          { timeoutMs: 2000 },
        ),
      ).resolves.toEqual({
        content: [{ type: 'text', text: 'echo:hello' }],
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('injects plugin MCP servers behind an approval gate', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-'))
    const serverPath = join(cwd, 'plugin-server.mjs')

    try {
      writeFileSync(
        serverPath,
        `
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
          capabilities: { resources: {} },
          serverInfo: { name: 'plugin', version: '1.0.0' }
        }
      }) + '\\n')
    }
    if (message.method === 'resources/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { resources: [{ uri: 'plugin://resource' }] }
      }) + '\\n')
    }
  }
})
`,
        'utf8',
      )

      await expect(
        discoverLiveMcpResources(cwd, {
          timeoutMs: 2000,
          pluginServers: {
            plugin: {
              type: 'stdio',
              command: process.execPath,
              args: [serverPath],
            },
          },
        }),
      ).resolves.toEqual([])

      await expect(
        discoverLiveMcpResources(cwd, {
          timeoutMs: 2000,
          pluginServers: {
            plugin: {
              type: 'stdio',
              command: process.execPath,
              args: [serverPath],
            },
          },
          approveServer: (request) =>
            request.reason === 'plugin-server' && request.serverName === 'plugin',
        }),
      ).resolves.toEqual(['plugin://resource'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('classifies SSE/OAuth and HTTP transport states without running them as stdio', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-'))

    try {
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            needsAuth: {
              type: 'sse',
              url: 'https://example.test/mcp/sse',
              oauth: true,
              approvalState: 'approved',
            },
            remote: {
              type: 'sse',
              url: 'https://example.test/mcp/ready',
              approvalState: 'approved',
            },
            streamable: {
              type: 'streamable-http',
              url: 'https://example.test/mcp',
              approvalState: 'approved',
            },
            websocket: {
              type: 'ws',
              url: 'wss://example.test/mcp',
              approvalState: 'approved',
            },
            sdk: {
              type: 'sdk',
              approvalState: 'approved',
            },
            proxy: {
              type: 'claudeai-proxy',
              url: 'https://claude.ai/api/mcp',
              approvalState: 'approved',
            },
          },
        }),
        'utf8',
      )

      await expect(getMcpServerConnectionStates(cwd)).resolves.toEqual([
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
          serverName: 'proxy',
          transport: 'claudeai-proxy',
          source: 'project',
          phase: 'unsupported-transport',
          errorCode: 'transport_unsupported',
          configHash: expect.any(String),
          signature: 'claudeai-proxy:https://claude.ai/api/mcp',
        },
        {
          serverName: 'remote',
          transport: 'sse',
          source: 'project',
          phase: 'approved',
          configHash: expect.any(String),
          signature: 'sse:https://example.test/mcp/ready',
        },
        {
          serverName: 'sdk',
          transport: 'sdk',
          source: 'project',
          phase: 'unsupported-transport',
          errorCode: 'transport_unsupported',
          configHash: expect.any(String),
          signature: expect.stringContaining('sdk:sdk:'),
        },
        {
          serverName: 'streamable',
          transport: 'http',
          source: 'project',
          phase: 'approved',
          configHash: expect.any(String),
          signature: 'http:https://example.test/mcp',
        },
        {
          serverName: 'websocket',
          transport: 'ws',
          source: 'project',
          phase: 'approved',
          configHash: expect.any(String),
          signature: 'ws:wss://example.test/mcp',
        },
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports policy and approval states with redacted hashes and signature de-dupe', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-'))

    try {
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            blocked: {
              type: 'http',
              url: 'https://example.test/blocked',
              headers: { Authorization: 'Bearer fixture-header-value' },
              headersHelper: { command: 'print-headers', args: ['fixture-helper-value'] },
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
            duplicateA: {
              type: 'sse',
              url: 'https://example.test/dupe',
              signature: 'shared-signature',
              approvalState: 'approved',
            },
            duplicateB: {
              type: 'sse',
              url: 'https://example.test/dupe-other-name',
              signature: 'shared-signature',
              approvalState: 'approved',
            },
          },
        }),
        'utf8',
      )

      await expect(collectProjectMcpServerConfigs(cwd)).resolves.toEqual([
        [
          'blocked',
          {
            type: 'http',
            url: 'https://example.test/blocked',
            headers: { Authorization: 'Bearer fixture-header-value' },
            headersHelper: { command: 'print-headers', args: ['fixture-helper-value'] },
            oauth: { required: true, token: 'fixture-oauth-value' },
            policy: 'deny',
          },
        ],
        [
          'pending',
          {
            type: 'stdio',
            command: process.execPath,
            args: ['server.mjs'],
            env: { SECRET_TOKEN: 'fixture-env-value' },
            approvalState: 'pending',
          },
        ],
        [
          'duplicateA',
          {
            type: 'sse',
            url: 'https://example.test/dupe',
            signature: 'shared-signature',
            approvalState: 'approved',
          },
        ],
      ])

      const states = await getMcpServerConnectionStates(cwd, {
        serverPolicies: { pending: true },
      })
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
          serverName: 'duplicateA',
          transport: 'sse',
          source: 'project',
          phase: 'approved',
          configHash: expect.any(String),
          signature: 'shared-signature',
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

      const serializedStates = JSON.stringify(states)
      expect(serializedStates).not.toContain('fixture-header-value')
      expect(serializedStates).not.toContain('fixture-helper-value')
      expect(serializedStates).not.toContain('fixture-oauth-value')
      expect(serializedStates).not.toContain('fixture-env-value')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('throws classified errors for denied approval and invalid stdio initialize responses', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-mcp-'))
    const serverPath = join(cwd, 'bad-server.mjs')

    try {
      writeFileSync(
        serverPath,
        `
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  const message = JSON.parse(chunk.trim().split('\\n')[0])
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: message.id,
    result: { capabilities: {} }
  }) + '\\n')
})
`,
        'utf8',
      )
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            denied: {
              type: 'stdio',
              command: process.execPath,
              args: [serverPath],
              approvalState: 'rejected',
            },
          },
        }),
        'utf8',
      )

      await expect(
        callLiveMcpTool(
          cwd,
          {
            serverName: 'denied',
            toolName: 'echo',
            input: {},
          },
          { timeoutMs: 2000 },
        ),
      ).rejects.toMatchObject({
        name: 'McpDiscoveryError',
        code: 'approval_denied',
        serverName: 'denied',
      })

      let error: unknown
      try {
        await discoverStdioMcpServerResources(
          'bad',
          {
            type: 'stdio',
            command: process.execPath,
            args: [serverPath],
          },
          cwd,
          { timeoutMs: 2000 },
        )
      } catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(McpDiscoveryError)
      expect(error).toMatchObject({
        code: 'invalid_response',
        method: 'initialize',
        serverName: 'bad',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
