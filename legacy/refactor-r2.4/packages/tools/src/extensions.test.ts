import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverExtensionRegistry,
  generateSkill,
  getExtensionToolSurfaceNames,
  installMarketplacePlugin,
  loadBundledSkills,
  loadProjectSkills,
  loadPlugins,
  readPluginInstallState,
  readPluginMarketplace,
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
} from './extensions.js'
import { runToolUse } from './runner.js'

describe('V0.6 extension registry', () => {
  it('loads the bundled Claude API app-builder skill', async () => {
    expect(loadBundledSkills()).toEqual([
      expect.objectContaining({
        name: 'claude-api',
        source: 'bundled',
        content: expect.stringContaining('Claude API App Builder'),
      }),
    ])

    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v11-'))

    try {
      const registry = await discoverExtensionRegistry(cwd)
      expect(registry.skills).toContainEqual(
        expect.objectContaining({
          name: 'claude-api',
          source: 'bundled',
        }),
      )

      const result = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_claude_api_skill',
          name: 'Skill',
          input: { name: 'claude-api' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )

      expect(result.content).toContain('# Skill: claude-api')
      expect(result.content).toContain('Anthropic SDKs')
      expect(result.content).toContain('tool use')
      expect(result.content).toContain('Streaming')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('loads local markdown skills and exposes the Skill tool', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v06-'))

    try {
      mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
      writeFileSync(
        join(cwd, '.claude', 'skills', 'review.md'),
        [
          '---',
          'name: reviewer',
          'description: Review code changes',
          '---',
          'Check tests and edge cases.',
        ].join('\n'),
        'utf8',
      )

      await expect(loadProjectSkills(cwd)).resolves.toEqual([
        expect.objectContaining({
          name: 'reviewer',
          description: 'Review code changes',
          content: 'Check tests and edge cases.',
          source: 'project',
        }),
      ])

      const registry = await discoverExtensionRegistry(cwd)
      const result = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill',
          name: 'Skill',
          input: { name: 'reviewer' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )

      expect(result.content).toContain('# Skill: reviewer')
      expect(result.content).toContain('Check tests and edge cases.')

      const feedback = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill_feedback',
          name: 'SkillFeedback',
          input: {
            skillName: 'reviewer',
            outcome: 'helpful',
            note: 'kept the review focused',
          },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(feedback.content).toContain('"skillName": "reviewer"')
      await expect(readSkillImprovementFeedback(cwd)).resolves.toEqual([
        expect.objectContaining({
          skillName: 'reviewer',
          outcome: 'helpful',
          note: 'kept the review focused',
        }),
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records skill improvement feedback locally without external sync', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v06-'))

    try {
      await expect(
        recordSkillImprovementFeedback(cwd, {
          skillName: 'planner',
          outcome: 'needs_improvement',
          note: 'missing edge cases',
          createdAt: '2026-05-24T00:00:00.000Z',
        }),
      ).resolves.toEqual({
        skillName: 'planner',
        outcome: 'needs_improvement',
        note: 'missing edge cases',
        createdAt: '2026-05-24T00:00:00.000Z',
      })
      await expect(readSkillImprovementFeedback(cwd)).resolves.toEqual([
        {
          skillName: 'planner',
          outcome: 'needs_improvement',
          note: 'missing edge cases',
          createdAt: '2026-05-24T00:00:00.000Z',
        },
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('generates local skills and records explicit skill learning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v11-'))

    try {
      await expect(
        generateSkill(cwd, {
          name: 'review-helper',
          description: 'Review local diffs',
          trigger: 'Use when reviewing code changes',
          instructions: 'Check behavior, tests, and edge cases.',
        }),
      ).resolves.toMatchObject({
        name: 'review-helper',
        status: 'created',
      })

      await expect(loadProjectSkills(cwd)).resolves.toContainEqual(
        expect.objectContaining({
          name: 'review-helper',
          description: 'Review local diffs',
          content: 'Check behavior, tests, and edge cases.',
          source: 'project',
        }),
      )

      await expect(
        recordSkillLearning(cwd, {
          skillName: 'review-helper',
          lesson: 'Always check focused tests after changing behavior.',
          source: 'task',
        }),
      ).resolves.toMatchObject({
        skillName: 'review-helper',
        lesson: 'Always check focused tests after changing behavior.',
        source: 'task',
      })
      await expect(readSkillLearning(cwd)).resolves.toEqual([
        expect.objectContaining({
          skillName: 'review-helper',
          source: 'task',
        }),
      ])

      const registry = await discoverExtensionRegistry(cwd)
      const generateResult = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill_generate',
          name: 'SkillGenerate',
          input: {
            name: 'planner',
            instructions: 'Plan before broad edits.',
          },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(generateResult.content).toContain('"status": "created"')

      const learningResult = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill_learning',
          name: 'SkillLearning',
          input: {
            skillName: 'planner',
            lesson: 'Prefer small reviewable diffs.',
          },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(learningResult.content).toContain('"skillName": "planner"')

      const listResult = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill_learning_list',
          name: 'SkillLearningList',
          input: {},
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(listResult.content).toContain('Prefer small reviewable diffs.')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('builds a V1.4 skill store index/cache and resolves name conflicts locally', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v14-skill-store-'))

    try {
      mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
      writeFileSync(
        join(cwd, '.claude', 'skills', 'conflict.md'),
        [
          '---',
          'name: conflict-skill',
          'description: Project conflict winner',
          '---',
          'project instructions win',
        ].join('\n'),
        'utf8',
      )
      mkdirSync(join(cwd, '.my-claude-code', 'plugins', 'demo'), { recursive: true })
      writeFileSync(
        join(cwd, '.my-claude-code', 'plugins', 'demo', 'plugin.json'),
        JSON.stringify({
          name: 'demo',
          skills: [{
            name: 'conflict-skill',
            description: 'Plugin conflict candidate',
            content: 'plugin instructions lose',
          }],
        }),
        'utf8',
      )

      const registry = await discoverExtensionRegistry(cwd)
      expect(registry.skills.filter(skill => skill.name === 'conflict-skill')).toHaveLength(1)
      expect(registry.skills).toContainEqual(
        expect.objectContaining({
          name: 'conflict-skill',
          source: 'project',
        }),
      )

      const index = await readSkillStoreIndex(cwd)
      expect(index).toMatchObject({
        version: '1.4',
        entries: expect.arrayContaining([
          expect.objectContaining({ name: 'conflict-skill', source: 'project', selected: true }),
          expect.objectContaining({ name: 'conflict-skill', source: 'plugin', selected: false }),
        ]),
        conflicts: [
          expect.objectContaining({
            name: 'conflict-skill',
            resolution: 'project_over_plugin_over_bundled',
          }),
        ],
      })

      const cache = await readSkillStoreCache(cwd)
      expect(cache.skills).toContainEqual(
        expect.objectContaining({
          name: 'conflict-skill',
          content: 'project instructions win',
        }),
      )
      expect(
        JSON.parse(readFileSync(join(cwd, '.my-claude-code', 'skill-store', 'cache.json'), 'utf8')),
      ).toMatchObject({ version: '1.4' })

      const result = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill_conflict',
          name: 'Skill',
          input: { name: 'conflict-skill' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(result.content).toContain('project instructions win')
      expect(result.content).not.toContain('plugin instructions lose')

      await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill_search_conflict',
          name: 'SkillSearch',
          input: { query: 'conflict' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      await expect(readSkillStoreIndex(cwd)).resolves.toMatchObject({
        conflicts: [expect.objectContaining({ name: 'conflict-skill' })],
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('ranks skill search with text matches, feedback, and learning records', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v14-skill-search-'))

    try {
      mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
      writeFileSync(
        join(cwd, '.claude', 'skills', 'alpha.md'),
        [
          '---',
          'name: alpha',
          'description: Review changes',
          '---',
          'review code carefully',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(cwd, '.claude', 'skills', 'beta.md'),
        [
          '---',
          'name: beta',
          'description: Review changes',
          '---',
          'review code carefully',
        ].join('\n'),
        'utf8',
      )
      await recordSkillImprovementFeedback(cwd, {
        skillName: 'beta',
        outcome: 'helpful',
        createdAt: '2026-05-24T00:00:00.000Z',
      })
      await recordSkillLearning(cwd, {
        skillName: 'beta',
        lesson: 'Prefer this for review ranking',
        source: 'manual',
      })

      const results = await searchSkills(cwd, 'review')
      expect(results.map(result => result.name).slice(0, 2)).toEqual(['beta', 'alpha'])
      expect(results[0]).toMatchObject({
        name: 'beta',
        feedbackScore: 20,
        learningScore: expect.any(Number),
      })

      const registry = await discoverExtensionRegistry(cwd)
      const toolResult = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill_search',
          name: 'SkillSearch',
          input: { query: 'review' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(JSON.parse(toolResult.content).results[0]).toMatchObject({
        name: 'beta',
        feedbackScore: 20,
      })

      const storeResult = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_skill_store',
          name: 'SkillStore',
          input: { action: 'summary' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(JSON.parse(storeResult.content)).toMatchObject({
        version: '1.4',
        resolved: expect.any(Number),
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('loads plugin commands as deferred tools and executes them through ExecuteTool', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v06-'))

    try {
      mkdirSync(join(cwd, '.my-claude-code', 'plugins', 'demo'), { recursive: true })
      writeFileSync(
        join(cwd, '.my-claude-code', 'plugins', 'demo', 'plugin.json'),
        JSON.stringify({
          name: 'demo',
          commands: [
            {
              name: 'hello',
              description: 'Say hello',
              content: 'hello from plugin',
            },
          ],
          skills: [
            {
              name: 'plugin_skill',
              content: 'plugin skill instructions',
            },
          ],
        }),
        'utf8',
      )

      const plugins = await loadPlugins(cwd)
      expect(plugins[0]).toMatchObject({
        name: 'demo',
        commands: [expect.objectContaining({ name: 'hello' })],
        skills: [expect.objectContaining({ name: 'plugin_skill' })],
      })

      const registry = await discoverExtensionRegistry(cwd)
      const search = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_search',
          name: 'SearchExtraTools',
          input: { query: 'hello' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
          deferredTools: registry.deferredTools,
        },
      )
      expect(search.content).toContain('plugin__demo__hello')

      const execute = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_execute',
          name: 'ExecuteTool',
          input: { name: 'plugin__demo__hello', input: {} },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
          deferredTools: registry.deferredTools,
        },
      )
      expect(execute.content).toBe('hello from plugin')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs marketplace plugin install/update/enable/disable/reload with plugin MCP lifecycle', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v14-'))
    const serverPath = join(cwd, 'server.mjs')
    const marketplacePath = join(cwd, '.my-claude-code', 'plugin-marketplace.json')
    const pluginManifestPath = join(cwd, '.my-claude-code', 'plugins', 'demo', 'plugin.json')

    try {
      writeFileSync(serverPath, mcpFixtureServer(), 'utf8')
      mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
      writeFileSync(
        marketplacePath,
        JSON.stringify({
          plugins: [{
            name: 'demo',
            version: '1.0.0',
            description: 'Demo plugin',
            manifest: {
              name: 'demo',
              commands: [{ name: 'hello', content: 'hello v1' }],
              mcpServers: {
                server: {
                  type: 'stdio',
                  command: process.execPath,
                  args: [serverPath],
                },
              },
            },
          }],
        }),
        'utf8',
      )

      await expect(readPluginMarketplace(cwd)).resolves.toEqual([
        expect.objectContaining({
          name: 'demo',
          version: '1.0.0',
        }),
      ])
      await expect(installMarketplacePlugin(cwd, 'demo')).resolves.toMatchObject({
        status: 'installed',
        plugin: {
          name: 'demo',
          enabled: true,
          version: '1.0.0',
        },
      })
      await expect(readPluginInstallState(cwd)).resolves.toMatchObject({
        plugins: [expect.objectContaining({ name: 'demo', enabled: true })],
      })

      let registry = await discoverExtensionRegistry(cwd, { timeoutMs: 2000 })
      expect(registry.plugins).toEqual([
        expect.objectContaining({
          name: 'demo',
          commands: [expect.objectContaining({ name: 'hello', content: 'hello v1' })],
        }),
      ])
      expect(registry.mcpTools).toEqual([
        expect.objectContaining({
          name: 'mcp__demo_server__echo',
          serverName: 'demo_server',
        }),
      ])

      await expect(setPluginEnabled(cwd, 'demo', false)).resolves.toMatchObject({
        status: 'disabled',
        plugin: { enabled: false },
      })
      registry = await discoverExtensionRegistry(cwd, { timeoutMs: 2000 })
      expect(registry.plugins).toEqual([])
      expect(registry.mcpTools).toEqual([])

      await expect(setPluginEnabled(cwd, 'demo', true)).resolves.toMatchObject({
        status: 'enabled',
        plugin: { enabled: true },
      })
      writeFileSync(
        marketplacePath,
        JSON.stringify({
          plugins: [{
            name: 'demo',
            version: '1.1.0',
            manifest: {
              name: 'demo',
              commands: [{ name: 'hello', content: 'hello v2' }],
              mcpServers: {
                server: {
                  type: 'stdio',
                  command: process.execPath,
                  args: [serverPath],
                },
              },
            },
          }],
        }),
        'utf8',
      )
      await expect(updateMarketplacePlugin(cwd, 'demo')).resolves.toMatchObject({
        status: 'updated',
        plugin: { version: '1.1.0' },
      })
      registry = await discoverExtensionRegistry(cwd, { timeoutMs: 2000 })
      expect(registry.plugins[0]?.commands).toEqual([
        expect.objectContaining({ name: 'hello', content: 'hello v2' }),
      ])

      rmSync(pluginManifestPath, { force: true })
      await expect(reconcilePluginMarketplace(cwd, { timeoutMs: 2000 }))
        .resolves.toMatchObject({
          restored: ['demo'],
          missing: [],
          registry: {
            plugins: [expect.objectContaining({ name: 'demo' })],
            mcpTools: [expect.objectContaining({ name: 'mcp__demo_server__echo' })],
          },
        })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('discovers stdio MCP tools/resources and adapts tools to the shared runner', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v06-'))
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

      const registry = await discoverExtensionRegistry(cwd, { timeoutMs: 2000 })
      expect(getExtensionToolSurfaceNames()).toEqual(
        expect.arrayContaining(['MCPTool', 'McpAuthTool', 'ListMcpResources', 'ReadMcpResource']),
      )
      expect(registry.mcpTools).toEqual([
        expect.objectContaining({
          name: 'mcp__demo__echo',
          serverName: 'demo',
          toolName: 'echo',
        }),
      ])
      expect(registry.mcpResources).toEqual([
        expect.objectContaining({
          serverName: 'demo',
          uri: 'demo://readme',
        }),
      ])

      const result = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_mcp',
          name: 'mcp__demo__echo',
          input: { text: 'hello' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(result.is_error).toBeUndefined()
      expect(result.content).toBe('echo:hello')

      const genericResult = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_generic_mcp',
          name: 'MCPTool',
          input: {
            serverName: 'demo',
            toolName: 'echo',
            input: { text: 'generic' },
          },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'bypassPermissions',
        },
      )
      expect(genericResult.is_error).toBeUndefined()
      expect(genericResult.content).toBe('echo:generic')

      const authResult = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_mcp_auth',
          name: 'McpAuthTool',
          input: { serverName: 'demo' },
        },
        registry.tools,
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(authResult.is_error).toBeUndefined()
      expect(authResult.content).toContain('"serverName": "demo"')
      expect(authResult.content).toContain('"secretHandling": "server env values are never printed"')
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
