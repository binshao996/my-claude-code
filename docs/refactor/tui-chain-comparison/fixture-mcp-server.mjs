
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
const server = new McpServer({ name: 'tui-fixture', version: '1.0.0' })
server.tool('echo', 'Echo input for TUI MCP parity test', { text: z.string().optional() }, async ({ text }) => ({ content: [{ type: 'text', text: text ?? 'fixture-ok' }] }))
server.resource('fixture-note', 'fixture://note', async uri => ({ contents: [{ uri: uri.href, text: 'fixture resource' }] }))
server.prompt('fixture-prompt', 'Fixture prompt', {}, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'fixture prompt' } }] }))
await server.connect(new StdioServerTransport())
