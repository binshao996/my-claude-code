import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  join,
  parse,
  resolve,
} from 'node:path'
import { z } from 'zod/v4'
import { resolvePermission } from './permissions.js'
import type {
  Tool,
  ToolExecutionContext,
  ToolInput,
} from './types.js'

const MCP_PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_MCP_TIMEOUT_MS = 1_500

export type McpServerConfig = {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  disabled?: boolean
}

export type McpToolDescriptor = {
  name: string
  serverName: string
  toolName: string
  description?: string
  inputSchema: InputJsonSchema
  readOnlyHint?: boolean
  destructiveHint?: boolean
}

export type McpResourceDescriptor = {
  serverName: string
  uri: string
  name?: string
}

export type SkillDescriptor = {
  name: string
  description?: string
  content: string
  path?: string
  source: 'bundled' | 'project' | 'plugin'
}

export type SkillStoreEntry = {
  id: string
  name: string
  description?: string
  source: SkillDescriptor['source']
  path?: string
  contentHash: string
  selected: boolean
}

export type SkillStoreConflict = {
  name: string
  selectedId: string
  candidates: Array<{
    id: string
    source: SkillDescriptor['source']
    path?: string
  }>
  resolution: 'project_over_plugin_over_bundled'
}

export type SkillStoreIndex = {
  version: '1.4'
  generatedAt: string
  entries: SkillStoreEntry[]
  resolved: SkillStoreEntry[]
  conflicts: SkillStoreConflict[]
  cachePath: string
}

export type SkillStoreCache = {
  version: '1.4'
  generatedAt: string
  skills: Array<SkillStoreEntry & { content: string }>
}

export type SkillSearchResult = {
  name: string
  description?: string
  source: SkillDescriptor['source']
  path?: string
  score: number
  matched: boolean
  feedbackScore: number
  learningScore: number
  conflictResolved: boolean
}

export type SkillImprovementFeedback = {
  skillName: string
  outcome: 'helpful' | 'needs_improvement' | 'not_used'
  note?: string
  createdAt: string
}

type SkillFeedbackInput = Omit<SkillImprovementFeedback, 'createdAt'>

export type SkillGenerationRecord = {
  name: string
  description?: string
  trigger?: string
  path: string
  status: 'created' | 'exists'
  createdAt: string
}

type SkillGenerateInput = {
  name: string
  description?: string
  trigger?: string
  instructions: string
}

export type SkillLearningRecord = {
  skillName: string
  lesson: string
  source: 'manual' | 'feedback' | 'task'
  createdAt: string
}

type SkillLearningInput = Omit<SkillLearningRecord, 'createdAt' | 'source'> & {
  source?: SkillLearningRecord['source']
}

export type PluginManifest = {
  name: string
  description?: string
  commands?: PluginCommandDescriptor[]
  skills?: Array<{
    name: string
    description?: string
    content?: string
    path?: string
  }>
  mcpServers?: Record<string, McpServerConfig>
}

export type PluginMarketplaceEntry = {
  name: string
  version: string
  description?: string
  manifest: PluginManifest
}

export type InstalledPluginRecord = {
  name: string
  version: string
  enabled: boolean
  source: 'marketplace'
  path: string
  installedAt: string
  updatedAt: string
}

export type PluginInstallState = {
  plugins: InstalledPluginRecord[]
}

export type PluginLifecycleResult = {
  plugin: InstalledPluginRecord
  status: 'installed' | 'updated' | 'enabled' | 'disabled' | 'unchanged'
}

export type PluginReconcileResult = {
  plugins: InstalledPluginRecord[]
  restored: string[]
  missing: string[]
  registry: ExtensionRegistry
}

export type PluginCommandDescriptor = {
  name: string
  description?: string
  content: string
}

export type PluginDescriptor = {
  name: string
  description?: string
  path: string
  commands: PluginCommandDescriptor[]
  skills: SkillDescriptor[]
  mcpServers: Record<string, McpServerConfig>
}

export type ExtensionRegistry = {
  tools: Tool[]
  deferredTools: Tool[]
  skills: SkillDescriptor[]
  plugins: PluginDescriptor[]
  mcpServers: Array<[string, McpServerConfig]>
  mcpTools: McpToolDescriptor[]
  mcpResources: McpResourceDescriptor[]
}

export type ExtensionRegistryOptions = {
  pluginDirs?: string[]
  timeoutMs?: number
}

export const EXTENSION_TOOL_SURFACE_NAMES = [
  'Skill',
  'SkillSearch',
  'SkillStore',
  'SkillGenerate',
  'SkillFeedback',
  'SkillLearning',
  'SkillLearningList',
  'ListMcpResources',
  'ReadMcpResource',
  'SearchExtraTools',
  'ExecuteTool',
  'MCPTool',
  'McpAuthTool',
] as const

type InputJsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

type JsonRpcMessage = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

type StdioMcpRequest = {
  method: string
  params?: unknown
  onResult(result: unknown): void
}

export async function discoverExtensionRegistry(
  cwd: string,
  options: ExtensionRegistryOptions = {},
): Promise<ExtensionRegistry> {
  const plugins = await loadPlugins(cwd, options)
  const discoveredSkills = [
    ...loadBundledSkills(),
    ...(await loadProjectSkills(cwd)),
    ...plugins.flatMap(plugin => plugin.skills),
  ]
  const store = await refreshSkillStoreIndex(cwd, discoveredSkills)
  const skills = resolveSkillConflicts(discoveredSkills)
  const pluginMcpServers = Object.fromEntries(
    plugins.flatMap(plugin =>
      Object.entries(plugin.mcpServers).map(([name, config]) => [
        `${plugin.name}_${name}`,
        config,
      ]),
    ),
  )
  const mcpServers = await collectMcpServerConfigs(cwd, pluginMcpServers)
  const mcpTools = await discoverMcpTools(cwd, mcpServers, options)
  const mcpResources = await discoverMcpResources(cwd, mcpServers, options)
  const deferredTools = plugins.flatMap(plugin =>
    plugin.commands.map(command => pluginCommandTool(plugin, command)),
  )

  return {
    tools: [
      skillTool(skills),
      skillSearchTool(discoveredSkills, store.conflicts),
      skillStoreTool(discoveredSkills),
      skillGenerateTool(),
      skillFeedbackTool(),
      skillLearningTool(),
      skillLearningListTool(),
      listMcpResourcesTool(mcpResources),
      readMcpResourceTool(mcpServers, options),
      genericMcpTool(mcpServers, options),
      mcpAuthTool(mcpServers),
      ...mcpTools.map(tool => mcpToolAdapter(tool, mcpServers, options)),
      ...deferredDiscoveryTools(),
    ],
    deferredTools,
    skills,
    plugins,
    mcpServers,
    mcpTools,
    mcpResources,
  }
}

export function getExtensionToolSurfaceNames(): string[] {
  return [...EXTENSION_TOOL_SURFACE_NAMES]
}

export function loadBundledSkills(): SkillDescriptor[] {
  return [
    {
      name: 'claude-api',
      description:
        'Build apps with the Claude API, Anthropic SDKs, streaming, tool use, and Agent SDK patterns.',
      source: 'bundled',
      content: CLAUDE_API_SKILL_CONTENT,
    },
  ]
}

export async function loadProjectSkills(cwd: string): Promise<SkillDescriptor[]> {
  const directories = [
    join(cwd, '.claude', 'skills'),
    join(cwd, '.my-claude-code', 'skills'),
  ]
  const skills = await Promise.all(
    directories.map(directory => loadSkillsDirectory(directory, 'project')),
  )
  return skills.flat().sort((left, right) => left.name.localeCompare(right.name))
}

const CLAUDE_API_SKILL_CONTENT = [
  '# Claude API App Builder',
  '',
  'Use this skill when the task is to build or debug an app that calls Claude through the Messages API, Anthropic SDKs, or an Agent SDK style runtime.',
  '',
  '## Core mental model',
  '',
  '- The app owns product state, authentication, files, persistence, and UI.',
  '- The provider request is a compact description of the current task: system instructions, conversation messages, optional tool definitions, and provider options.',
  '- Tool use is a contract. The model asks for a named tool with JSON input; the app validates, executes, stores the real result locally, and sends back the result needed for the next model turn.',
  '- Streaming is transport, not business logic. Parse events, update UI incrementally, and keep the final transcript identical to the non-streaming result.',
  '- Prompt caching works best when stable prefixes stay byte-identical. Put long stable policy and tool descriptions before volatile user/task content.',
  '',
  '## Implementation checklist',
  '',
  '1. Read API keys from environment variables. Never commit keys, log keys, or persist raw secrets in app state.',
  '2. Choose one request boundary: build one system message, append normalized conversation messages, attach tool schemas, then call the provider.',
  '3. Validate all user-controlled tool input before executing filesystem, shell, browser, network, or database work.',
  '4. Persist the full local transcript separately from the smaller provider request so compacting context does not destroy diagnostics.',
  '5. Add retry handling for rate limits and transient network failures; do not retry non-idempotent tool side effects automatically.',
  '6. Test the app with a fake provider response, a tool-use response, a streaming response, and an error response.',
  '',
  '## TypeScript shape',
  '',
  '```ts',
  'import Anthropic from "@anthropic-ai/sdk"',
  '',
  'const client = new Anthropic({',
  '  apiKey: process.env.ANTHROPIC_API_KEY,',
  '})',
  '',
  'const response = await client.messages.create({',
  '  model: "claude-sonnet-4-5",',
  '  max_tokens: 1024,',
  '  system: "You are a focused assistant for this app.",',
  '  messages: [{ role: "user", content: "Summarize this issue." }],',
  '})',
  '```',
  '',
  '## Tool-use shape',
  '',
  'Define tools with narrow JSON schemas, execute only after validation, and send concise results back to the model. Store large raw outputs in local files or app storage, then return a short reference plus the important excerpt.',
  '',
  '```ts',
  'const tools = [{',
  '  name: "read_issue",',
  '  description: "Read one issue by numeric id.",',
  '  input_schema: {',
  '    type: "object",',
  '    properties: { id: { type: "number" } },',
  '    required: ["id"],',
  '  },',
  '}]',
  '```',
  '',
  '## Streaming shape',
  '',
  'Treat stream events as patches to the current assistant turn. Keep a durable final message after the stream completes, and surface partial text only as UI state.',
  '',
  '## Common failure modes',
  '',
  '- Mixing runtime memory with provider context: compact the provider request, not the app transcript.',
  '- Passing unbounded tool output back into the next request: summarize or store large results and return a reference.',
  '- Scattering multiple unrelated system messages: generate one sectioned system instruction so ordering is predictable.',
  '- Letting model-proposed tool input bypass permission checks: validate every call the same way a user action would be validated.',
].join('\n')

export async function recordSkillImprovementFeedback(
  cwd: string,
  feedback: Omit<SkillImprovementFeedback, 'createdAt'> & { createdAt?: string },
): Promise<SkillImprovementFeedback> {
  const record: SkillImprovementFeedback = {
    skillName: feedback.skillName,
    outcome: feedback.outcome,
    note: feedback.note,
    createdAt: feedback.createdAt ?? new Date().toISOString(),
  }
  const path = skillImprovementFeedbackPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

export async function readSkillImprovementFeedback(
  cwd: string,
): Promise<SkillImprovementFeedback[]> {
  try {
    const content = await readFile(skillImprovementFeedbackPath(cwd), 'utf8')
    return content
      .split('\n')
      .filter(Boolean)
      .map(line => SkillImprovementFeedbackSchema.parse(JSON.parse(line)))
  } catch {
    return []
  }
}

export async function generateSkill(
  cwd: string,
  input: SkillGenerateInput,
): Promise<SkillGenerationRecord> {
  const name = normalizeIdentifier(input.name)
  const path = join(cwd, '.my-claude-code', 'skills', `${name}.md`)
  const createdAt = new Date().toISOString()
  const recordBase = {
    name,
    description: input.description,
    trigger: input.trigger,
    path,
    createdAt,
  }

  try {
    await readFile(path, 'utf8')
    return {
      ...recordBase,
      status: 'exists',
    }
  } catch {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, renderGeneratedSkillMarkdown({
      name,
      description: input.description,
      trigger: input.trigger,
      instructions: input.instructions,
    }), 'utf8')
    return {
      ...recordBase,
      status: 'created',
    }
  }
}

export async function recordSkillLearning(
  cwd: string,
  input: SkillLearningInput,
): Promise<SkillLearningRecord> {
  const record: SkillLearningRecord = {
    skillName: normalizeIdentifier(input.skillName),
    lesson: input.lesson,
    source: input.source ?? 'manual',
    createdAt: new Date().toISOString(),
  }
  const path = skillLearningPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

export async function readSkillLearning(cwd: string): Promise<SkillLearningRecord[]> {
  try {
    const content = await readFile(skillLearningPath(cwd), 'utf8')
    return content
      .split('\n')
      .filter(Boolean)
      .map(line => SkillLearningRecordSchema.parse(JSON.parse(line)))
  } catch {
    return []
  }
}

export async function refreshSkillStoreIndex(
  cwd: string,
  skills?: SkillDescriptor[],
): Promise<SkillStoreIndex> {
  const discoveredSkills = skills ?? [
    ...loadBundledSkills(),
    ...(await loadProjectSkills(cwd)),
    ...(await loadPlugins(cwd)).flatMap(plugin => plugin.skills),
  ]
  const generatedAt = new Date().toISOString()
  const resolvedSkills = resolveSkillConflicts(discoveredSkills)
  const resolvedIds = new Set(resolvedSkills.map(skill => skillStoreEntryId(skill)))
  const entries = discoveredSkills.map(skill => skillStoreEntry(skill, resolvedIds))
  const cache: SkillStoreCache = {
    version: '1.4',
    generatedAt,
    skills: discoveredSkills.map(skill => ({
      ...skillStoreEntry(skill, resolvedIds),
      content: skill.content,
    })),
  }
  const index: SkillStoreIndex = {
    version: '1.4',
    generatedAt,
    entries,
    resolved: entries.filter(entry => entry.selected),
    conflicts: skillStoreConflicts(discoveredSkills),
    cachePath: skillStoreCachePath(cwd),
  }

  await mkdir(skillStoreRoot(cwd), { recursive: true })
  await writeFile(skillStoreCachePath(cwd), JSON.stringify(cache, null, 2), 'utf8')
  await writeFile(skillStoreIndexPath(cwd), JSON.stringify(index, null, 2), 'utf8')
  return index
}

export async function readSkillStoreIndex(cwd: string): Promise<SkillStoreIndex> {
  try {
    return SkillStoreIndexSchema.parse(
      JSON.parse(await readFile(skillStoreIndexPath(cwd), 'utf8')),
    )
  } catch {
    return refreshSkillStoreIndex(cwd)
  }
}

export async function readSkillStoreCache(cwd: string): Promise<SkillStoreCache> {
  try {
    return SkillStoreCacheSchema.parse(
      JSON.parse(await readFile(skillStoreCachePath(cwd), 'utf8')),
    )
  } catch {
    await refreshSkillStoreIndex(cwd)
    return SkillStoreCacheSchema.parse(
      JSON.parse(await readFile(skillStoreCachePath(cwd), 'utf8')),
    )
  }
}

export async function searchSkills(
  cwd: string,
  query = '',
  skills?: SkillDescriptor[],
): Promise<SkillSearchResult[]> {
  const index = skills
    ? await refreshSkillStoreIndex(cwd, skills)
    : await readSkillStoreIndex(cwd)
  const cache = skills
    ? await readSkillStoreCache(cwd)
    : await readSkillStoreCache(cwd)
  const selectedIds = new Set(index.resolved.map(entry => entry.id))
  const selectedSkills = cache.skills.filter(skill => selectedIds.has(skill.id))
  const feedback = await readSkillImprovementFeedback(cwd)
  const learning = await readSkillLearning(cwd)
  const conflicts = new Set(index.conflicts.map(conflict => conflict.name))
  const normalizedQuery = normalizeSearchText(query)
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)

  return selectedSkills
    .map(skill => {
      const feedbackScore = skillFeedbackScore(skill.name, feedback)
      const learningScore = skillLearningScore(skill.name, learning, tokens)
      const matchScore = skillTextMatchScore(skill, normalizedQuery, tokens)
      return {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.path,
        score: matchScore + skillSourceScore(skill.source) + feedbackScore + learningScore,
        matched: tokens.length === 0 || matchScore > 0,
        feedbackScore,
        learningScore,
        conflictResolved: conflicts.has(skill.name),
      }
    })
    .filter(result => tokens.length === 0 || result.matched)
    .sort((left, right) =>
      right.score - left.score ||
      left.name.localeCompare(right.name) ||
      left.source.localeCompare(right.source),
    )
}

export async function loadPlugins(
  cwd: string,
  options: Pick<ExtensionRegistryOptions, 'pluginDirs'> = {},
): Promise<PluginDescriptor[]> {
  const state = await readPluginInstallState(cwd)
  const roots = [
    join(cwd, '.claude', 'plugins'),
    join(cwd, '.my-claude-code', 'plugins'),
    ...(options.pluginDirs ?? []).map(directory => resolve(cwd, directory)),
  ]
  const plugins: PluginDescriptor[] = []

  for (const root of roots) {
    for (const directory of await pluginDirectories(root)) {
      const plugin = await loadPlugin(directory)
      if (plugin && isPluginEnabled(plugin.name, state)) {
        plugins.push(plugin)
      }
    }
  }

  return plugins.sort((left, right) => left.name.localeCompare(right.name))
}

export async function readPluginMarketplace(cwd: string): Promise<PluginMarketplaceEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(pluginMarketplacePath(cwd), 'utf8'))
    const entries = Array.isArray(parsed?.plugins) ? parsed.plugins : []
    return entries
      .flatMap((entry: unknown) => normalizePluginMarketplaceEntry(entry))
      .sort((left: PluginMarketplaceEntry, right: PluginMarketplaceEntry) =>
        left.name.localeCompare(right.name),
      )
  } catch {
    return []
  }
}

export async function readPluginInstallState(cwd: string): Promise<PluginInstallState> {
  try {
    const parsed = JSON.parse(await readFile(pluginInstallStatePath(cwd), 'utf8'))
    const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : []
    return {
      plugins: plugins
        .flatMap((plugin: unknown) => normalizeInstalledPluginRecord(cwd, plugin))
        .sort((left: InstalledPluginRecord, right: InstalledPluginRecord) =>
          left.name.localeCompare(right.name),
        ),
    }
  } catch {
    return { plugins: [] }
  }
}

export async function installMarketplacePlugin(
  cwd: string,
  pluginName: string,
): Promise<PluginLifecycleResult> {
  const entry = await resolveMarketplaceEntry(cwd, pluginName)
  const state = await readPluginInstallState(cwd)
  const existing = state.plugins.find(plugin => plugin.name === entry.name)
  const now = new Date().toISOString()
  const plugin = await writeMarketplacePlugin(cwd, entry, {
    enabled: existing?.enabled ?? true,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  })
  await writePluginInstallState(cwd, upsertInstalledPlugin(state, plugin))
  return {
    plugin,
    status: existing
      ? existing.version === entry.version ? 'unchanged' : 'updated'
      : 'installed',
  }
}

export async function updateMarketplacePlugin(
  cwd: string,
  pluginName: string,
): Promise<PluginLifecycleResult> {
  const entry = await resolveMarketplaceEntry(cwd, pluginName)
  const state = await readPluginInstallState(cwd)
  const existing = state.plugins.find(plugin => plugin.name === entry.name)
  const now = new Date().toISOString()
  const plugin = await writeMarketplacePlugin(cwd, entry, {
    enabled: existing?.enabled ?? true,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  })
  await writePluginInstallState(cwd, upsertInstalledPlugin(state, plugin))
  return {
    plugin,
    status: existing?.version === entry.version ? 'unchanged' : 'updated',
  }
}

export async function setPluginEnabled(
  cwd: string,
  pluginName: string,
  enabled: boolean,
): Promise<PluginLifecycleResult> {
  const state = await readPluginInstallState(cwd)
  const name = normalizeIdentifier(pluginName)
  const existing = state.plugins.find(plugin => plugin.name === name)
  if (!existing) {
    throw new Error(`Plugin is not installed: ${name}`)
  }
  const plugin = {
    ...existing,
    enabled,
    updatedAt: new Date().toISOString(),
  }
  await writePluginInstallState(cwd, upsertInstalledPlugin(state, plugin))
  return {
    plugin,
    status: enabled ? 'enabled' : 'disabled',
  }
}

export async function reconcilePluginMarketplace(
  cwd: string,
  options: ExtensionRegistryOptions = {},
): Promise<PluginReconcileResult> {
  const marketplace = await readPluginMarketplace(cwd)
  const state = await readPluginInstallState(cwd)
  const restored: string[] = []
  const missing: string[] = []
  let nextState = state

  for (const plugin of state.plugins) {
    const entry = marketplace.find(candidate => candidate.name === plugin.name)
    if (!entry) {
      missing.push(plugin.name)
      continue
    }
    if (!plugin.enabled) {
      continue
    }
    if (await pluginManifestExists(plugin.path)) {
      continue
    }
    const restoredPlugin = await writeMarketplacePlugin(cwd, entry, {
      enabled: true,
      installedAt: plugin.installedAt,
      updatedAt: new Date().toISOString(),
    })
    nextState = upsertInstalledPlugin(nextState, restoredPlugin)
    restored.push(plugin.name)
  }

  await writePluginInstallState(cwd, nextState)
  return {
    plugins: nextState.plugins,
    restored,
    missing,
    registry: await discoverExtensionRegistry(cwd, options),
  }
}

export async function collectMcpServerConfigs(
  cwd: string,
  pluginServers: Record<string, McpServerConfig> = {},
): Promise<Array<[string, McpServerConfig]>> {
  const servers = new Map<string, McpServerConfig>()
  const seenSignatures = new Set<string>()

  for (const path of mcpConfigPaths(cwd)) {
    const parsed = await readMcpConfig(path)
    for (const [name, config] of Object.entries(parsed)) {
      const signature = mcpServerSignature(name, config)
      if (!servers.has(name) && !seenSignatures.has(signature)) {
        servers.set(name, config)
        seenSignatures.add(signature)
      }
    }
  }

  for (const [name, config] of Object.entries(pluginServers)) {
    const signature = mcpServerSignature(name, config)
    if (!servers.has(name) && !seenSignatures.has(signature)) {
      servers.set(name, config)
      seenSignatures.add(signature)
    }
  }

  return [...servers.entries()]
}

async function loadSkillsDirectory(
  directory: string,
  source: SkillDescriptor['source'],
): Promise<SkillDescriptor[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const skills = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => readSkillFile(join(directory, entry.name), source)),
    )
    return skills.filter((skill): skill is SkillDescriptor => Boolean(skill))
  } catch {
    return []
  }
}

async function readSkillFile(
  path: string,
  source: SkillDescriptor['source'],
): Promise<SkillDescriptor | undefined> {
  try {
    const parsed = parseMarkdownFrontmatter(await readFile(path, 'utf8'))
    const name =
      parsed.frontmatter.name ??
      parsed.frontmatter.title ??
      basename(path, extname(path))
    return {
      name,
      description:
        parsed.frontmatter.description ?? parsed.frontmatter.when_to_use,
      content: parsed.body.trim(),
      path,
      source,
    }
  } catch {
    return undefined
  }
}

const SkillImprovementFeedbackSchema = z.object({
  skillName: z.string().min(1),
  outcome: z.enum(['helpful', 'needs_improvement', 'not_used']),
  note: z.string().optional(),
  createdAt: z.string(),
})

const SkillLearningRecordSchema = z.object({
  skillName: z.string().min(1),
  lesson: z.string().min(1),
  source: z.enum(['manual', 'feedback', 'task']),
  createdAt: z.string(),
})

const SkillStoreEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.enum(['bundled', 'project', 'plugin']),
  path: z.string().optional(),
  contentHash: z.string().min(1),
  selected: z.boolean(),
})

const SkillStoreConflictSchema = z.object({
  name: z.string().min(1),
  selectedId: z.string().min(1),
  candidates: z.array(z.object({
    id: z.string().min(1),
    source: z.enum(['bundled', 'project', 'plugin']),
    path: z.string().optional(),
  })),
  resolution: z.literal('project_over_plugin_over_bundled'),
})

const SkillStoreIndexSchema = z.object({
  version: z.literal('1.4'),
  generatedAt: z.string(),
  entries: z.array(SkillStoreEntrySchema),
  resolved: z.array(SkillStoreEntrySchema),
  conflicts: z.array(SkillStoreConflictSchema),
  cachePath: z.string(),
})

const SkillStoreCacheSchema = z.object({
  version: z.literal('1.4'),
  generatedAt: z.string(),
  skills: z.array(SkillStoreEntrySchema.extend({
    content: z.string(),
  })),
})

function skillImprovementFeedbackPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'skill-improvement.jsonl')
}

function skillLearningPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'skill-learning.jsonl')
}

function skillStoreRoot(cwd: string): string {
  return join(cwd, '.my-claude-code', 'skill-store')
}

function skillStoreIndexPath(cwd: string): string {
  return join(skillStoreRoot(cwd), 'index.json')
}

function skillStoreCachePath(cwd: string): string {
  return join(skillStoreRoot(cwd), 'cache.json')
}

function renderGeneratedSkillMarkdown(input: SkillGenerateInput): string {
  return [
    '---',
    `name: ${input.name}`,
    input.description ? `description: ${input.description}` : undefined,
    input.trigger ? `when_to_use: ${input.trigger}` : undefined,
    '---',
    '',
    input.instructions.trim(),
    '',
  ].filter(line => line !== undefined).join('\n')
}

function resolveSkillConflicts(skills: SkillDescriptor[]): SkillDescriptor[] {
  const byName = new Map<string, SkillDescriptor[]>()
  for (const skill of skills) {
    const candidates = byName.get(skill.name) ?? []
    candidates.push(skill)
    byName.set(skill.name, candidates)
  }

  return [...byName.values()]
    .map(candidates => [...candidates].sort(compareSkillResolution)[0])
    .sort((left, right) => left.name.localeCompare(right.name))
}

function skillStoreEntry(
  skill: SkillDescriptor,
  resolvedIds: Set<string>,
): SkillStoreEntry {
  return {
    id: skillStoreEntryId(skill),
    name: skill.name,
    description: skill.description,
    source: skill.source,
    path: skill.path,
    contentHash: createHash('sha256').update(skill.content).digest('hex'),
    selected: resolvedIds.has(skillStoreEntryId(skill)),
  }
}

function skillStoreEntryId(skill: SkillDescriptor): string {
  return createHash('sha256')
    .update(skill.source)
    .update('\0')
    .update(skill.name)
    .update('\0')
    .update(skill.path ?? '')
    .update('\0')
    .update(skill.content)
    .digest('hex')
}

function skillStoreConflicts(skills: SkillDescriptor[]): SkillStoreConflict[] {
  const byName = new Map<string, SkillDescriptor[]>()
  for (const skill of skills) {
    const candidates = byName.get(skill.name) ?? []
    candidates.push(skill)
    byName.set(skill.name, candidates)
  }

  return [...byName.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .map(([name, candidates]) => {
      const sorted = [...candidates].sort(compareSkillResolution)
      return {
        name,
        selectedId: skillStoreEntryId(sorted[0]),
        candidates: sorted.map(skill => ({
          id: skillStoreEntryId(skill),
          source: skill.source,
          path: skill.path,
        })),
        resolution: 'project_over_plugin_over_bundled' as const,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function compareSkillResolution(left: SkillDescriptor, right: SkillDescriptor): number {
  return skillSourceResolutionRank(right.source) - skillSourceResolutionRank(left.source) ||
    (left.path ?? '').localeCompare(right.path ?? '') ||
    left.content.localeCompare(right.content)
}

function skillSourceResolutionRank(source: SkillDescriptor['source']): number {
  if (source === 'project') {
    return 3
  }
  if (source === 'plugin') {
    return 2
  }
  return 1
}

function skillSourceScore(source: SkillDescriptor['source']): number {
  return skillSourceResolutionRank(source) * 2
}

function skillFeedbackScore(
  skillName: string,
  feedback: SkillImprovementFeedback[],
): number {
  return feedback
    .filter(record => sameSkillName(record.skillName, skillName))
    .reduce((score, record) => {
      if (record.outcome === 'helpful') {
        return score + 20
      }
      if (record.outcome === 'needs_improvement') {
        return score - 10
      }
      return score - 5
    }, 0)
}

function skillLearningScore(
  skillName: string,
  learning: SkillLearningRecord[],
  tokens: string[],
): number {
  return learning
    .filter(record => sameSkillName(record.skillName, skillName))
    .reduce((score, record) => {
      const lesson = normalizeSearchText(record.lesson)
      const tokenScore = tokens.filter(token => lesson.includes(token)).length * 6
      return score + 12 + tokenScore
    }, 0)
}

function skillTextMatchScore(
  skill: Pick<SkillStoreCache['skills'][number], 'name' | 'description' | 'content'>,
  normalizedQuery: string,
  tokens: string[],
): number {
  if (tokens.length === 0) {
    return 1
  }
  const name = normalizeSearchText(skill.name)
  const description = normalizeSearchText(skill.description ?? '')
  const content = normalizeSearchText(skill.content)
  let score = 0

  if (normalizedQuery && name === normalizedQuery) {
    score += 100
  } else if (normalizedQuery && name.includes(normalizedQuery)) {
    score += 60
  }
  if (normalizedQuery && description.includes(normalizedQuery)) {
    score += 25
  }
  if (normalizedQuery && content.includes(normalizedQuery)) {
    score += 10
  }

  for (const token of tokens) {
    if (name.includes(token)) {
      score += 15
    }
    if (description.includes(token)) {
      score += 6
    }
    if (content.includes(token)) {
      score += 2
    }
  }

  return score
}

function sameSkillName(left: string, right: string): boolean {
  return normalizeIdentifier(left).toLowerCase() === normalizeIdentifier(right).toLowerCase()
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, ' ').trim()
}

async function pluginDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const directories = entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name))

    if (entries.some(entry => entry.isFile() && entry.name === 'plugin.json')) {
      directories.push(root)
    }

    return directories
  } catch {
    return []
  }
}

async function loadPlugin(directory: string): Promise<PluginDescriptor | undefined> {
  try {
    const manifest = normalizePluginManifest(
      JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8')),
    )
    if (!manifest) {
      return undefined
    }

    return {
      name: manifest.name,
      description: manifest.description,
      path: directory,
      commands: manifest.commands ?? [],
      skills: await loadPluginSkills(directory, manifest),
      mcpServers: manifest.mcpServers ?? {},
    }
  } catch {
    return undefined
  }
}

async function loadPluginSkills(
  directory: string,
  manifest: PluginManifest,
): Promise<SkillDescriptor[]> {
  const inline = await Promise.all(
    (manifest.skills ?? []).map(async skill => {
      if (skill.content) {
        return {
          name: skill.name,
          description: skill.description,
          content: skill.content,
          source: 'plugin' as const,
          path: join(directory, 'plugin.json'),
        }
      }
      if (skill.path) {
        return readSkillFile(resolve(directory, skill.path), 'plugin')
      }
      return undefined
    }),
  )
  return [
    ...inline.filter((skill): skill is SkillDescriptor => Boolean(skill)),
    ...(await loadSkillsDirectory(join(directory, 'skills'), 'plugin')),
  ]
}

function normalizePluginManifest(value: unknown): PluginManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const object = value as Record<string, unknown>
  if (typeof object.name !== 'string' || !object.name.trim()) {
    return undefined
  }

  return {
    name: normalizeIdentifier(object.name),
    ...(typeof object.description === 'string'
      ? { description: object.description }
      : {}),
    commands: normalizePluginCommands(object.commands),
    skills: normalizePluginSkills(object.skills),
    mcpServers: normalizeMcpServers(object.mcpServers),
  }
}

function normalizePluginMarketplaceEntry(value: unknown): PluginMarketplaceEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }
  const object = value as Record<string, unknown>
  if (typeof object.name !== 'string' || typeof object.version !== 'string') {
    return []
  }
  const manifest = normalizePluginManifest(object.manifest ?? object)
  if (!manifest) {
    return []
  }
  return [{
    name: normalizeIdentifier(object.name),
    version: object.version,
    ...(typeof object.description === 'string'
      ? { description: object.description }
      : {}),
    manifest: {
      ...manifest,
      name: normalizeIdentifier(manifest.name || object.name),
      description:
        manifest.description ??
        (typeof object.description === 'string' ? object.description : undefined),
    },
  }]
}

function normalizeInstalledPluginRecord(
  cwd: string,
  value: unknown,
): InstalledPluginRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }
  const object = value as Record<string, unknown>
  if (
    typeof object.name !== 'string' ||
    typeof object.version !== 'string' ||
    typeof object.enabled !== 'boolean'
  ) {
    return []
  }
  const name = normalizeIdentifier(object.name)
  return [{
    name,
    version: object.version,
    enabled: object.enabled,
    source: 'marketplace',
    path: typeof object.path === 'string'
      ? object.path
      : defaultPluginInstallPath(cwd, name),
    installedAt: typeof object.installedAt === 'string'
      ? object.installedAt
      : new Date(0).toISOString(),
    updatedAt: typeof object.updatedAt === 'string'
      ? object.updatedAt
      : new Date(0).toISOString(),
  }]
}

function normalizePluginCommands(value: unknown): PluginCommandDescriptor[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap(command => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return []
    }
    const object = command as Record<string, unknown>
    if (typeof object.name !== 'string' || typeof object.content !== 'string') {
      return []
    }
    return [{
      name: normalizeIdentifier(object.name),
      content: object.content,
      ...(typeof object.description === 'string'
        ? { description: object.description }
        : {}),
    }]
  })
}

function normalizePluginSkills(value: unknown): PluginManifest['skills'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap(skill => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      return []
    }
    const object = skill as Record<string, unknown>
    if (typeof object.name !== 'string') {
      return []
    }
    return [{
      name: normalizeIdentifier(object.name),
      ...(typeof object.description === 'string'
        ? { description: object.description }
        : {}),
      ...(typeof object.content === 'string' ? { content: object.content } : {}),
      ...(typeof object.path === 'string' ? { path: object.path } : {}),
    }]
  })
}

function normalizeMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, config]) => {
      const normalized = normalizeMcpServerConfig(config)
      return normalized ? [[normalizeIdentifier(name), normalized]] : []
    }),
  )
}

function normalizeMcpServerConfig(value: unknown): McpServerConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const object = value as Record<string, unknown>
  const args = Array.isArray(object.args)
    ? object.args.filter((arg): arg is string => typeof arg === 'string')
    : undefined
  const env = normalizeStringRecord(object.env)
  return {
    ...(typeof object.type === 'string' ? { type: object.type } : {}),
    ...(typeof object.command === 'string' ? { command: object.command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(typeof object.url === 'string' ? { url: object.url } : {}),
    ...(typeof object.disabled === 'boolean' ? { disabled: object.disabled } : {}),
  }
}

async function readMcpConfig(path: string): Promise<Record<string, McpServerConfig>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const servers = parsed?.mcpServers
    return normalizeMcpServers(servers)
  } catch {
    return {}
  }
}

function mcpConfigPaths(cwd: string, maxDepth = 8): string[] {
  const paths = [
    join(cwd, '.my-claude-code', 'mcp.json'),
    join(cwd, '.my-claude-code', 'mcp.local.json'),
  ]
  let directory = cwd
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    paths.push(join(directory, '.mcp.json'))
    if (directory === parse(directory).root) {
      break
    }
    directory = dirname(directory)
  }
  if (process.env.HOME) {
    paths.push(join(process.env.HOME, '.my-claude-code', 'mcp.json'))
  }
  return paths
}

async function discoverMcpTools(
  cwd: string,
  servers: Array<[string, McpServerConfig]>,
  options: Pick<ExtensionRegistryOptions, 'timeoutMs'>,
): Promise<McpToolDescriptor[]> {
  const discovered = await Promise.all(
    servers.map(async ([serverName, config]) => {
      if (!isRunnableStdioConfig(config)) {
        return []
      }
      let result: unknown
      await runStdioMcpRequests(serverName, config, cwd, [{
        method: 'tools/list',
        params: {},
        onResult(value) {
          result = value
        },
      }], options)
      return readMcpTools(serverName, result)
    }),
  )
  return discovered.flat().sort((left, right) => left.name.localeCompare(right.name))
}

async function discoverMcpResources(
  cwd: string,
  servers: Array<[string, McpServerConfig]>,
  options: Pick<ExtensionRegistryOptions, 'timeoutMs'>,
): Promise<McpResourceDescriptor[]> {
  const discovered = await Promise.all(
    servers.map(async ([serverName, config]) => {
      if (!isRunnableStdioConfig(config)) {
        return []
      }
      let result: unknown
      await runStdioMcpRequests(serverName, config, cwd, [{
        method: 'resources/list',
        params: {},
        onResult(value) {
          result = value
        },
      }], options)
      return readMcpResources(serverName, result)
    }),
  )
  return discovered.flat().sort((left, right) => left.uri.localeCompare(right.uri))
}

async function callMcpTool(
  cwd: string,
  servers: Array<[string, McpServerConfig]>,
  serverName: string,
  toolName: string,
  input: Record<string, unknown>,
  options: Pick<ExtensionRegistryOptions, 'timeoutMs'>,
): Promise<unknown> {
  const config = servers.find(([name]) => name === serverName)?.[1]
  if (!config) {
    throw new Error(`MCP server not found: ${serverName}`)
  }
  let result: unknown
  await runStdioMcpRequests(serverName, config, cwd, [{
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: input,
    },
    onResult(value) {
      result = value
    },
  }], options)
  return result
}

async function readMcpResource(
  cwd: string,
  servers: Array<[string, McpServerConfig]>,
  serverName: string,
  uri: string,
  options: Pick<ExtensionRegistryOptions, 'timeoutMs'>,
): Promise<unknown> {
  const config = servers.find(([name]) => name === serverName)?.[1]
  if (!config) {
    throw new Error(`MCP server not found: ${serverName}`)
  }
  let result: unknown
  await runStdioMcpRequests(serverName, config, cwd, [{
    method: 'resources/read',
    params: { uri },
    onResult(value) {
      result = value
    },
  }], options)
  return result
}

function runStdioMcpRequests(
  serverName: string,
  config: McpServerConfig,
  cwd: string,
  requests: StdioMcpRequest[],
  options: Pick<ExtensionRegistryOptions, 'timeoutMs'>,
): Promise<void> {
  if (!isRunnableStdioConfig(config)) {
    return Promise.resolve()
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(config.command as string, config.args ?? [], {
      cwd,
      env: {
        ...process.env,
        ...(config.env ?? {}),
      },
    })
    let buffer = ''
    let finished = false
    let requestIndex = 0
    const timeout = setTimeout(() => {
      finish(new Error(`MCP server timed out: ${serverName}`))
    }, options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS)

    const finish = (error?: Error) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timeout)
      child.stdin.destroy()
      child.kill()
      if (error) {
        reject(error)
        return
      }
      resolvePromise()
    }
    const send = (message: JsonRpcMessage) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const sendNextRequest = () => {
      const request = requests[requestIndex]
      if (!request) {
        finish()
        return
      }
      send({
        jsonrpc: '2.0',
        id: requestIndex + 2,
        method: request.method,
        params: request.params,
      })
    }

    child.once('error', finish)
    child.once('exit', () => finish())
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const message = parseJsonRpcMessage(line)
        if (!message) {
          continue
        }
        if (message.id === 1) {
          if (message.error || !isValidInitializeResult(message.result)) {
            finish(new Error(`MCP server initialize failed: ${serverName}`))
            continue
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          sendNextRequest()
          continue
        }
        if (typeof message.id === 'number' && message.id >= 2) {
          const expectedIndex = message.id - 2
          const request = requests[expectedIndex]
          if (!request) {
            continue
          }
          if (message.error) {
            finish(new Error(`MCP request failed: ${serverName} ${request.method}`))
            continue
          }
          request.onResult(message.result)
          requestIndex = expectedIndex + 1
          sendNextRequest()
        }
      }
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: `my-claude-code:${serverName}`,
          version: '0.6.0',
        },
      },
    })
  })
}

function mcpToolAdapter(
  descriptor: McpToolDescriptor,
  servers: Array<[string, McpServerConfig]>,
  options: Pick<ExtensionRegistryOptions, 'timeoutMs'>,
): Tool {
  return {
    name: descriptor.name,
    description:
      descriptor.description ??
      `MCP tool ${descriptor.toolName} from server ${descriptor.serverName}`,
    inputSchema: z.record(z.string(), z.unknown()),
    inputJSONSchema: descriptor.inputSchema,
    isReadOnly: () => descriptor.readOnlyHint === true,
    isDestructive: () => descriptor.destructiveHint === true,
    isConcurrencySafe: () => descriptor.readOnlyHint === true,
    checkPermissions: () =>
      descriptor.readOnlyHint === true
        ? { decision: 'allow' }
        : {
            decision: 'ask',
            reason: `${descriptor.name} is an external MCP tool`,
          },
    execute: async (input, context) =>
      renderMcpResult(
        await callMcpTool(
          context.cwd,
          servers,
          descriptor.serverName,
          descriptor.toolName,
          input,
          options,
        ),
      ),
  }
}

function listMcpResourcesTool(resources: McpResourceDescriptor[]): Tool {
  return {
    name: 'ListMcpResources',
    description: 'List resources exposed by configured MCP servers.',
    inputSchema: z.object({
      serverName: z.string().optional(),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' },
      },
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async input =>
      JSON.stringify(
        resources.filter(resource =>
          input.serverName ? resource.serverName === input.serverName : true,
        ),
        null,
        2,
      ),
  }
}

function readMcpResourceTool(
  servers: Array<[string, McpServerConfig]>,
  options: Pick<ExtensionRegistryOptions, 'timeoutMs'>,
): Tool {
  return {
    name: 'ReadMcpResource',
    description: 'Read a resource exposed by a configured MCP server.',
    inputSchema: z.object({
      serverName: z.string().min(1),
      uri: z.string().min(1),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' },
        uri: { type: 'string' },
      },
      required: ['serverName', 'uri'],
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) => {
      const serverName = String(input.serverName)
      const uri = String(input.uri)
      return renderMcpResult(
        await readMcpResource(context.cwd, servers, serverName, uri, options),
      )
    },
  }
}

function genericMcpTool(
  servers: Array<[string, McpServerConfig]>,
  options: Pick<ExtensionRegistryOptions, 'timeoutMs'>,
): Tool {
  return {
    name: 'MCPTool',
    description: 'Call a configured MCP tool by server and tool name.',
    inputSchema: z.object({
      serverName: z.string().min(1),
      toolName: z.string().min(1),
      input: z.record(z.string(), z.unknown()).default({}),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' },
        toolName: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['serverName', 'toolName'],
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false,
    checkPermissions: input => ({
      decision: 'ask',
      reason: `MCP tool ${String(input.serverName)}:${String(input.toolName)} requires permission`,
    }),
    execute: async (input, context) =>
      renderMcpResult(
        await callMcpTool(
          context.cwd,
          servers,
          String(input.serverName),
          String(input.toolName),
          input.input && typeof input.input === 'object' && !Array.isArray(input.input)
            ? input.input as Record<string, unknown>
            : {},
          options,
        ),
      ),
  }
}

function mcpAuthTool(servers: Array<[string, McpServerConfig]>): Tool {
  return {
    name: 'McpAuthTool',
    description: 'Inspect configured MCP server auth, approval, and transport state without printing secrets.',
    inputSchema: z.object({
      serverName: z.string().optional(),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' },
      },
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async input =>
      JSON.stringify(
        servers
          .filter(([name]) => input.serverName ? name === input.serverName : true)
          .map(([name, config]) => ({
            serverName: name,
            transport: config.type ?? 'stdio',
            configured: true,
            disabled: config.disabled === true,
            runnable: isRunnableStdioConfig(config),
            secretHandling: 'server env values are never printed',
          })),
        null,
        2,
      ),
  }
}

function skillTool(skills: SkillDescriptor[]): Tool {
  return {
    name: 'Skill',
    description: 'Load a local or plugin skill by name and return its instructions.',
    inputSchema: z.object({
      name: z.string().min(1),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async input => {
      const skill = skills.find(candidate => candidate.name === input.name)
      if (!skill) {
        return `Skill not found: ${input.name}\nAvailable skills: ${skills.map(item => item.name).join(', ') || '(none)'}`
      }
      return [
        `# Skill: ${skill.name}`,
        skill.description ? `Description: ${skill.description}` : undefined,
        skill.path ? `Source: ${skill.path}` : undefined,
        '',
        skill.content,
      ].filter(Boolean).join('\n')
    },
  }
}

function skillSearchTool(
  skills: SkillDescriptor[],
  conflicts: SkillStoreConflict[],
): Tool<{ query?: string }> {
  return {
    name: 'SkillSearch',
    description: 'Search local, bundled, and plugin skills using the local skill-store ranking cache.',
    inputSchema: z.object({
      query: z.string().optional(),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) => JSON.stringify({
      query: input.query ?? '',
      results: await searchSkills(context.cwd, input.query ?? '', skills),
      conflicts,
    }, null, 2),
  }
}

function skillStoreTool(
  skills: SkillDescriptor[],
): Tool<{ action?: 'summary' | 'index' | 'cache' | 'refresh' }> {
  return {
    name: 'SkillStore',
    description: 'Inspect or refresh the local skill store index and cache.',
    inputSchema: z.object({
      action: z.enum(['summary', 'index', 'cache', 'refresh']).optional(),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['summary', 'index', 'cache', 'refresh'],
        },
      },
    },
    isReadOnly: input => input.action !== 'refresh',
    isDestructive: () => false,
    isConcurrencySafe: input => input.action !== 'refresh',
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) => {
      const action = input.action ?? 'summary'
      const index = action === 'refresh'
        ? await refreshSkillStoreIndex(context.cwd, skills)
        : await readSkillStoreIndex(context.cwd)

      if (action === 'cache') {
        return JSON.stringify(await readSkillStoreCache(context.cwd), null, 2)
      }
      if (action === 'index' || action === 'refresh') {
        return JSON.stringify(index, null, 2)
      }
      return JSON.stringify({
        version: index.version,
        entries: index.entries.length,
        resolved: index.resolved.length,
        conflicts: index.conflicts,
        cachePath: index.cachePath,
      }, null, 2)
    },
  }
}

function skillGenerateTool(): Tool<SkillGenerateInput> {
  return {
    name: 'SkillGenerate',
    description: 'Create a local project skill markdown file from explicit instructions.',
    inputSchema: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      trigger: z.string().optional(),
      instructions: z.string().min(1),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        trigger: { type: 'string' },
        instructions: { type: 'string' },
      },
      required: ['name', 'instructions'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) => {
      const record = await generateSkill(context.cwd, input)
      return JSON.stringify(record, null, 2)
    },
  }
}

function skillFeedbackTool(): Tool<SkillFeedbackInput> {
  return {
    name: 'SkillFeedback',
    description: 'Record local feedback about whether a skill helped the current task.',
    inputSchema: z.object({
      skillName: z.string().min(1),
      outcome: z.enum(['helpful', 'needs_improvement', 'not_used']),
      note: z.string().optional(),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        skillName: { type: 'string' },
        outcome: {
          type: 'string',
          enum: ['helpful', 'needs_improvement', 'not_used'],
        },
        note: { type: 'string' },
      },
      required: ['skillName', 'outcome'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) => {
      const record = await recordSkillImprovementFeedback(context.cwd, input)
      return JSON.stringify(record, null, 2)
    },
  }
}

function skillLearningTool(): Tool<SkillLearningInput> {
  return {
    name: 'SkillLearning',
    description: 'Record an explicit local lesson that should improve future skill use.',
    inputSchema: z.object({
      skillName: z.string().min(1),
      lesson: z.string().min(1),
      source: z.enum(['manual', 'feedback', 'task']).optional(),
    }),
    inputJSONSchema: {
      type: 'object',
      properties: {
        skillName: { type: 'string' },
        lesson: { type: 'string' },
        source: {
          type: 'string',
          enum: ['manual', 'feedback', 'task'],
        },
      },
      required: ['skillName', 'lesson'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (input, context) => {
      const record = await recordSkillLearning(context.cwd, input)
      return JSON.stringify(record, null, 2)
    },
  }
}

function skillLearningListTool(): Tool {
  return {
    name: 'SkillLearningList',
    description: 'List explicit local skill-learning records.',
    inputSchema: z.object({}),
    inputJSONSchema: {
      type: 'object',
      properties: {},
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async (_input, context) => JSON.stringify({
      learning: await readSkillLearning(context.cwd),
    }, null, 2),
  }
}

function pluginCommandTool(
  plugin: Pick<PluginDescriptor, 'name'>,
  command: PluginCommandDescriptor,
): Tool {
  const name = `plugin__${plugin.name}__${command.name}`
  return {
    name,
    description:
      command.description ?? `Run plugin command ${command.name} from ${plugin.name}`,
    inputSchema: z.object({}).catchall(z.unknown()),
    inputJSONSchema: {
      type: 'object',
      properties: {},
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => ({ decision: 'allow' }),
    execute: async () => command.content,
  }
}

function deferredDiscoveryTools(): Tool[] {
  return [
    {
      name: 'SearchExtraTools',
      description: 'Search deferred tools that are not loaded into the initial provider tool list.',
      inputSchema: z.object({
        query: z.string().optional(),
      }),
      inputJSONSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      checkPermissions: () => ({ decision: 'allow' }),
      execute: async (input, context) => {
        const query =
          typeof input.query === 'string' ? input.query.toLowerCase() : undefined
        return JSON.stringify(
          (context.deferredTools ?? [])
            .filter(tool =>
              query
                ? `${tool.name}\n${tool.description}`.toLowerCase().includes(query)
                : true,
            )
            .map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputJSONSchema,
            })),
          null,
          2,
        )
      },
    },
    {
      name: 'ExecuteTool',
      description: 'Execute a deferred tool by name after SearchExtraTools discovers it.',
      inputSchema: z.object({
        name: z.string().min(1),
        input: z.record(z.string(), z.unknown()).optional(),
      }),
      inputJSONSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          input: { type: 'object' },
        },
        required: ['name'],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => false,
      checkPermissions: () => ({ decision: 'allow' }),
      execute: async (input, context) => {
        const name = String(input.name)
        const tool = findDeferredTool(name, context)
        if (!tool) {
          return `Deferred tool not found: ${name}`
        }
        const deferredInput = isRecord(input.input) ? input.input : {}
        const parsed = tool.inputSchema.safeParse(deferredInput)
        if (!parsed.success) {
          return `invalid input for ${tool.name}: ${parsed.error.message}`
        }
        const permission = await resolvePermission(
          tool,
          parsed.data as ToolInput,
          context,
          `deferred-${tool.name}`,
        )
        if (permission.decision !== 'allow') {
          return permission.reason ?? `${tool.name} was not allowed`
        }
        return tool.execute(parsed.data as ToolInput, context)
      },
    },
  ]
}

function findDeferredTool(
  name: string,
  context: ToolExecutionContext | undefined,
): Tool | undefined {
  return context?.deferredTools?.find(tool => tool.name === name)
}

function parseMarkdownFrontmatter(content: string): {
  frontmatter: Record<string, string>
  body: string
} {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content }
  }
  const end = content.indexOf('\n---', 4)
  if (end === -1) {
    return { frontmatter: {}, body: content }
  }
  const raw = content.slice(4, end)
  const body = content.slice(end + 4)
  const frontmatter: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator === -1) {
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key && value) {
      frontmatter[key] = value
    }
  }
  return { frontmatter, body }
}

function readMcpTools(serverName: string, result: unknown): McpToolDescriptor[] {
  const tools = result && typeof result === 'object'
    ? (result as { tools?: unknown }).tools
    : undefined
  if (!Array.isArray(tools)) {
    return []
  }

  return tools.flatMap(tool => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      return []
    }
    const object = tool as {
      name?: unknown
      description?: unknown
      inputSchema?: unknown
      annotations?: {
        readOnlyHint?: unknown
        destructiveHint?: unknown
      }
    }
    if (typeof object.name !== 'string') {
      return []
    }
    const toolName = normalizeIdentifier(object.name)
    return [{
      name: `mcp__${serverName}__${toolName}`,
      serverName,
      toolName,
      ...(typeof object.description === 'string'
        ? { description: object.description }
        : {}),
      inputSchema: normalizeInputJsonSchema(object.inputSchema),
      ...(typeof object.annotations?.readOnlyHint === 'boolean'
        ? { readOnlyHint: object.annotations.readOnlyHint }
        : {}),
      ...(typeof object.annotations?.destructiveHint === 'boolean'
        ? { destructiveHint: object.annotations.destructiveHint }
        : {}),
    }]
  })
}

function readMcpResources(serverName: string, result: unknown): McpResourceDescriptor[] {
  const resources = result && typeof result === 'object'
    ? (result as { resources?: unknown }).resources
    : undefined
  if (!Array.isArray(resources)) {
    return []
  }
  return resources.flatMap(resource => {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
      return []
    }
    const object = resource as { uri?: unknown; name?: unknown }
    if (typeof object.uri !== 'string') {
      return []
    }
    return [{
      serverName,
      uri: object.uri,
      ...(typeof object.name === 'string' ? { name: object.name } : {}),
    }]
  })
}

function renderMcpResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return String(result ?? '')
  }
  const content = (result as { content?: unknown }).content
  if (Array.isArray(content)) {
    return content.map(item => {
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
        return String((item as { text?: unknown }).text ?? '')
      }
      return JSON.stringify(item)
    }).join('\n')
  }
  const contents = (result as { contents?: unknown }).contents
  if (Array.isArray(contents)) {
    return contents.map(item => JSON.stringify(item)).join('\n')
  }
  return JSON.stringify(result, null, 2)
}

function normalizeInputJsonSchema(value: unknown): InputJsonSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'object', properties: {} }
  }
  const object = value as {
    type?: unknown
    properties?: unknown
    required?: unknown
  }
  return {
    type: 'object',
    properties:
      object.properties && typeof object.properties === 'object' && !Array.isArray(object.properties)
        ? object.properties as Record<string, unknown>
        : {},
    ...(Array.isArray(object.required)
      ? { required: object.required.filter((item): item is string => typeof item === 'string') }
      : {}),
  }
}

function isRunnableStdioConfig(config: McpServerConfig): boolean {
  return Boolean(!config.disabled && config.command && (!config.type || config.type === 'stdio'))
}

function isValidInitializeResult(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === 'object' &&
      typeof (result as { protocolVersion?: unknown }).protocolVersion === 'string',
  )
}

function parseJsonRpcMessage(line: string): JsonRpcMessage | undefined {
  try {
    const parsed = JSON.parse(line.trim())
    return parsed && typeof parsed === 'object' ? parsed as JsonRpcMessage : undefined
  } catch {
    return undefined
  }
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
}

function mcpServerSignature(name: string, config: McpServerConfig): string {
  return createHash('sha256')
    .update(name)
    .update('\0')
    .update(JSON.stringify({
      type: config.type ?? 'stdio',
      command: config.command,
      args: config.args ?? [],
      url: config.url,
    }))
    .digest('hex')
}

function pluginMarketplacePath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'plugin-marketplace.json')
}

function pluginInstallStatePath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'plugins-state.json')
}

function defaultPluginInstallPath(cwd: string, pluginName: string): string {
  return join(cwd, '.my-claude-code', 'plugins', pluginName)
}

async function resolveMarketplaceEntry(
  cwd: string,
  pluginName: string,
): Promise<PluginMarketplaceEntry> {
  const name = normalizeIdentifier(pluginName)
  const entry = (await readPluginMarketplace(cwd))
    .find(candidate => candidate.name === name)
  if (!entry) {
    throw new Error(`Plugin not found in marketplace index: ${name}`)
  }
  return entry
}

async function writeMarketplacePlugin(
  cwd: string,
  entry: PluginMarketplaceEntry,
  timestamps: {
    enabled: boolean
    installedAt: string
    updatedAt: string
  },
): Promise<InstalledPluginRecord> {
  const path = defaultPluginInstallPath(cwd, entry.name)
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'plugin.json'),
    `${JSON.stringify({
      ...entry.manifest,
      name: entry.name,
      description: entry.manifest.description ?? entry.description,
    }, null, 2)}\n`,
    'utf8',
  )
  return {
    name: entry.name,
    version: entry.version,
    enabled: timestamps.enabled,
    source: 'marketplace',
    path,
    installedAt: timestamps.installedAt,
    updatedAt: timestamps.updatedAt,
  }
}

async function writePluginInstallState(
  cwd: string,
  state: PluginInstallState,
): Promise<void> {
  await mkdir(dirname(pluginInstallStatePath(cwd)), { recursive: true })
  await writeFile(
    pluginInstallStatePath(cwd),
    `${JSON.stringify({
      plugins: state.plugins.sort((left, right) => left.name.localeCompare(right.name)),
    }, null, 2)}\n`,
    'utf8',
  )
}

function upsertInstalledPlugin(
  state: PluginInstallState,
  plugin: InstalledPluginRecord,
): PluginInstallState {
  return {
    plugins: [
      ...state.plugins.filter(candidate => candidate.name !== plugin.name),
      plugin,
    ].sort((left, right) => left.name.localeCompare(right.name)),
  }
}

function isPluginEnabled(name: string, state: PluginInstallState): boolean {
  const plugin = state.plugins.find(candidate => candidate.name === name)
  return plugin ? plugin.enabled : true
}

async function pluginManifestExists(directory: string): Promise<boolean> {
  try {
    await readFile(join(directory, 'plugin.json'), 'utf8')
    return true
  } catch {
    return false
  }
}

export async function ensureExtensionDirectories(cwd: string): Promise<void> {
  await Promise.all([
    mkdir(join(cwd, '.claude', 'skills'), { recursive: true }),
    mkdir(join(cwd, '.my-claude-code', 'plugins'), { recursive: true }),
  ])
}
