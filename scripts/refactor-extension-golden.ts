import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  callLiveMcpTool,
  discoverLiveMcpTools,
  getMcpServerConnectionStates,
  subscribeLiveMcpResource,
} from '../packages/mcp-client/src/index.js'
import {
  discoverExtensionRegistry,
  generateSkill,
  getExtensionToolSurfaceNames,
  installMarketplacePlugin,
  loadBundledSkills,
  readSkillImprovementFeedback,
  readSkillLearning,
  readSkillStoreCache,
  readSkillStoreIndex,
  recordSkillImprovementFeedback,
  recordSkillLearning,
  reconcilePluginMarketplace,
  searchSkills,
  setPluginEnabled,
  updateMarketplacePlugin,
} from '../packages/tools/src/extensions.js'
import { runToolUse } from '../packages/tools/src/runner.js'

type ExtensionGolden = {
  version: string
  cases: Array<{
    name: string
    expect: Record<string, unknown>
  }>
}

type GoldenFailure = {
  caseName: string
  reason: string
}

const fixturePath = 'docs/refactor/golden/runtime/r1.8-extension-ecosystem-golden.json'
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as ExtensionGolden
const failures: GoldenFailure[] = []

for (const testCase of fixture.cases) {
  try {
    switch (testCase.name) {
      case 'mcp-stdio-transport':
        await verifyMcpStdioTransport(testCase.expect)
        break
      case 'mcp-http-sse-oauth':
        await verifyMcpHttpSseOAuth(testCase.expect)
        break
      case 'mcp-approval-policy':
        await verifyMcpApprovalPolicy(testCase.expect)
        break
      case 'plugin-lifecycle':
        await verifyPluginLifecycle(testCase.expect)
        break
      case 'skill-lifecycle':
        await verifySkillLifecycle(testCase.expect)
        break
      default:
        failures.push({ caseName: testCase.name, reason: 'unknown R1.8 golden case' })
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

async function verifyMcpStdioTransport(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-8-mcp-stdio-'))
  try {
    const serverPath = join(cwd, 'server.mjs')
    writeFileSync(serverPath, mcpFixtureServer(), 'utf8')
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          demo: { type: 'stdio', command: process.execPath, args: [serverPath] },
        },
      }),
      'utf8',
    )

    const registry = await discoverExtensionRegistry(cwd, { timeoutMs: 2_000 })
    assertEqual(registry.mcpTools[0]?.name, expect.toolName, 'toolName')
    assertEqual(registry.mcpResources[0]?.uri, expect.resourceUri, 'resourceUri')
    assertEqual(getExtensionToolSurfaceNames().includes('MCPTool'), true, 'MCPTool surface')

    const result = await runToolUse(
      { type: 'tool_use', id: 'toolu_mcp', name: String(expect.toolName), input: { text: 'hello' } },
      registry.tools,
      { cwd, permissionMode: 'default' },
    )
    assertEqual(result.content, expect.toolResult, 'toolResult')

    const authResult = await runToolUse(
      { type: 'tool_use', id: 'toolu_mcp_auth', name: 'McpAuthTool', input: { serverName: 'demo' } },
      registry.tools,
      { cwd, permissionMode: 'default' },
    )
    assertEqual(
      String(authResult.content).includes('secretHandling'),
      expect.authToolMentionsSecretHandling,
      'authToolMentionsSecretHandling',
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function verifyMcpHttpSseOAuth(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-8-mcp-oauth-'))
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
            result: { resources: [{ uri: 'skill://remote/code-review' }] },
          })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }

      if (body.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [{
              name: 'search',
              description: 'Search remote',
              inputSchema: { type: 'object' },
            }],
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

    const tools = await discoverLiveMcpTools(cwd, {
      fetchImpl,
      refreshOAuthToken: async request =>
        request.serverName === 'remote' && request.refreshUrl ? 'fresh-token' : 'event-token',
    })
    assertEqual(tools[0]?.name, expect.toolName, 'toolName')

    const toolResult = await callLiveMcpTool(
      cwd,
      { serverName: 'remote', toolName: 'search', input: { query: 'parity' } },
      { fetchImpl, refreshOAuthToken: async () => 'fresh-token' },
    )
    assertEqual(JSON.stringify(toolResult).includes(String(expect.toolResult)), true, 'toolResult')

    const subscribed = await subscribeLiveMcpResource(
      cwd,
      { serverName: 'remote', uri: 'skill://remote/code-review' },
      { fetchImpl, refreshOAuthToken: async () => 'fresh-token' },
    )
    assertJsonEqual(subscribed, { subscribed: expect.subscribed }, 'subscribed')

    const states = await getMcpServerConnectionStates(cwd, {
      refreshOAuthToken: async () => 'state-token',
    })
    assertJsonEqual(
      states.map(state => [state.serverName, state.phase, state.transport]),
      expect.statePhases,
      'statePhases',
    )
    assertJsonEqual(
      requests.map(request => request.authorization),
      expect.authorizationHeaders,
      'authorizationHeaders',
    )
    assertEqual(JSON.stringify(requests).includes('state-token'), false, 'noStateTokenPersisted')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function verifyMcpApprovalPolicy(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-8-mcp-policy-'))
  try {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          needsApproval: {
            type: 'stdio',
            command: process.execPath,
            args: ['server.mjs'],
            approvalState: 'pending',
          },
          denied: {
            type: 'http',
            url: 'https://mcp.example.test/denied',
            policy: 'deny',
          },
        },
      }),
      'utf8',
    )

    const states = await getMcpServerConnectionStates(cwd, { requireServerApproval: true })
    const approval = states.find(state => state.serverName === 'needsApproval')
    const denied = states.find(state => state.serverName === 'denied')
    assertEqual(approval?.phase, expect.approvalRequired, 'approvalRequired')
    assertEqual(denied?.phase, expect.policyDenied, 'policyDenied')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function verifyPluginLifecycle(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-8-plugin-'))
  const serverPath = join(cwd, 'server.mjs')
  const marketplacePath = join(cwd, '.my-claude-code', 'plugin-marketplace.json')
  const pluginManifestPath = join(cwd, '.my-claude-code', 'plugins', 'demo', 'plugin.json')
  try {
    writeFileSync(serverPath, mcpFixtureServer(), 'utf8')
    mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
    writeMarketplace(marketplacePath, serverPath, '1.0.0', 'hello v1')

    const installed = await installMarketplacePlugin(cwd, 'demo')
    assertEqual(installed.status, expect.installStatus, 'installStatus')
    let registry = await discoverExtensionRegistry(cwd, { timeoutMs: 2_000 })
    assertEqual(registry.mcpTools[0]?.name, expect.toolName, 'toolName')

    const disabled = await setPluginEnabled(cwd, 'demo', false)
    assertEqual(disabled.status, expect.disabledStatus, 'disabledStatus')
    registry = await discoverExtensionRegistry(cwd, { timeoutMs: 2_000 })
    assertEqual(registry.plugins.length, 0, 'disabled plugins')

    const enabled = await setPluginEnabled(cwd, 'demo', true)
    assertEqual(enabled.status, expect.enabledStatus, 'enabledStatus')
    writeMarketplace(marketplacePath, serverPath, '1.1.0', String(expect.commandContent))

    const updated = await updateMarketplacePlugin(cwd, 'demo')
    assertEqual(updated.status, expect.updateStatus, 'updateStatus')
    registry = await discoverExtensionRegistry(cwd, { timeoutMs: 2_000 })
    assertEqual(registry.plugins[0]?.commands[0]?.content, expect.commandContent, 'commandContent')

    rmSync(pluginManifestPath, { force: true })
    const reconciled = await reconcilePluginMarketplace(cwd, { timeoutMs: 2_000 })
    assertJsonEqual(reconciled.restored, expect.restored, 'restored')
    assertEqual(reconciled.registry.mcpTools[0]?.name, expect.toolName, 'reconciled toolName')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function verifySkillLifecycle(expect: Record<string, unknown>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'r1-8-skill-'))
  try {
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(cwd, '.my-claude-code', 'plugins', 'demo'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'skills', 'review.md'),
      [
        '---',
        'name: review',
        'description: project review skill',
        '---',
        'project review instructions',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(cwd, '.my-claude-code', 'plugins', 'demo', 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        skills: [{ name: 'review', description: 'plugin review skill', content: 'plugin loses' }],
      }),
      'utf8',
    )

    assertEqual(loadBundledSkills()[0]?.name, expect.bundledSkill, 'bundledSkill')
    const generated = await generateSkill(cwd, {
      name: 'review-helper',
      description: 'helper',
      trigger: 'review',
      instructions: 'help review code',
    })
    assertEqual(generated.status, expect.generatedStatus, 'generatedStatus')

    await recordSkillImprovementFeedback(cwd, {
      skillName: 'review',
      outcome: 'helpful',
      note: 'good',
    })
    await recordSkillLearning(cwd, {
      skillName: 'review',
      lesson: 'Prefer concise comments',
      source: 'manual',
    })

    const registry = await discoverExtensionRegistry(cwd)
    assertEqual(registry.skills.find(skill => skill.name === 'review')?.source, 'project', 'resolved skill')
    const index = await readSkillStoreIndex(cwd)
    assertEqual(index.conflicts[0]?.resolution, expect.conflictResolution, 'conflictResolution')
    const cache = await readSkillStoreCache(cwd)
    assertEqual(cache.skills.some(skill => skill.content.includes('project review')), expect.cacheContainsContent, 'cacheContainsContent')

    const results = await searchSkills(cwd, 'review')
    assertEqual(results[0]?.name, expect.topSearchResult, 'topSearchResult')
    assertEqual((await readSkillLearning(cwd)).length, expect.learningCount, 'learningCount')
    assertEqual((await readSkillImprovementFeedback(cwd)).length, expect.feedbackCount, 'feedbackCount')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function writeMarketplace(path: string, serverPath: string, version: string, commandContent: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      plugins: [{
        name: 'demo',
        version,
        description: 'Demo plugin',
        manifest: {
          name: 'demo',
          commands: [{ name: 'hello', content: commandContent }],
          mcpServers: {
            server: { type: 'stdio', command: process.execPath, args: [serverPath] },
          },
        },
      }],
    }),
    'utf8',
  )
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
          capabilities: { tools: {}, resources: {} },
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
        result: { resources: [{ uri: 'demo://readme', name: 'Readme' }] }
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

function assertEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, field: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${field}: expected ${expectedJson}, got ${actualJson}`)
  }
}
