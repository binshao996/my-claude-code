import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { discoverLiveMcpResources } from './mcpDiscovery.js'

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.my-claude-code',
  'node_modules',
  'dist',
  'claude-code',
])

export const DEFAULT_QUEUED_COMMAND_COMPLETIONS = [
  'build',
  'lint',
  'test',
  'typecheck',
] as const

export const DEFAULT_SLACK_CHANNEL_COMPLETIONS = [
  'general',
  'dev',
  'incidents',
] as const

export const DEFAULT_IDE_MENTION_COMPLETIONS = [
  'current-file',
  'selection',
  'diagnostics',
  'open-tabs',
] as const

export const DEFAULT_IMAGE_ATTACHMENT_COMPLETIONS = [
  'clipboard',
  'screenshot',
  'file',
] as const

export const DEFAULT_VOICE_ACTION_COMPLETIONS = [
  'dictate',
  'push-to-talk',
  'stop',
] as const

export type PromptPlatformCompletionSources = {
  slackChannels: string[]
  ideMentions: string[]
  imageAttachments: string[]
  voiceActions: string[]
}

export async function collectPromptCompletionFilePaths(
  cwd: string,
  options: {
    limit?: number
    maxDepth?: number
  } = {},
): Promise<string[]> {
  const limit = options.limit ?? 200
  const maxDepth = options.maxDepth ?? 4
  const files: string[] = []

  await walkDirectory({
    cwd,
    directory: cwd,
    depth: 0,
    maxDepth,
    limit,
    files,
  })

  return files.sort((left, right) => left.localeCompare(right))
}

export async function collectPromptCompletionMcpResources(
  cwd: string,
): Promise<string[]> {
  const candidates = [
    join(cwd, '.my-claude-code', 'mcp-resources.json'),
    join(cwd, '.mcp', 'resources.json'),
  ]
  const resources = new Set<string>()

  for (const candidate of candidates) {
    for (const resource of await readResourceFile(candidate)) {
      resources.add(resource)
    }
  }

  for (const resource of await discoverLiveMcpResources(cwd)) {
    resources.add(resource)
  }

  return [...resources].sort((left, right) => left.localeCompare(right))
}

export async function collectPromptCompletionAgents(
  cwd: string,
): Promise<string[]> {
  const agents = new Set<string>()
  for (const directory of [
    join(cwd, '.my-claude-code', 'agents'),
    join(cwd, '.claude', 'agents'),
  ]) {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isFile() && ['.md', '.json'].includes(extname(entry.name))) {
        agents.add(basename(entry.name, extname(entry.name)))
      }
    }
  }

  return [...agents].sort((left, right) => left.localeCompare(right))
}

export async function collectPromptPlatformCompletionSources(
  cwd: string,
): Promise<PromptPlatformCompletionSources> {
  const sources: PromptPlatformCompletionSources = {
    slackChannels: [...DEFAULT_SLACK_CHANNEL_COMPLETIONS],
    ideMentions: [...DEFAULT_IDE_MENTION_COMPLETIONS],
    imageAttachments: [...DEFAULT_IMAGE_ATTACHMENT_COMPLETIONS],
    voiceActions: [...DEFAULT_VOICE_ACTION_COMPLETIONS],
  }

  for (const path of [
    join(cwd, '.my-claude-code', 'completions.json'),
    join(cwd, '.claude', 'completions.json'),
  ]) {
    const parsed = await readJsonFile(path)
    if (!parsed || typeof parsed !== 'object') {
      continue
    }

    const object = parsed as {
      slackChannels?: unknown
      slack?: unknown
      ideMentions?: unknown
      ide?: unknown
      imageAttachments?: unknown
      images?: unknown
      voiceActions?: unknown
      voice?: unknown
    }
    appendUnique(sources.slackChannels, readStringList(
      object.slackChannels ?? object.slack,
    ))
    appendUnique(sources.ideMentions, readStringList(object.ideMentions ?? object.ide))
    appendUnique(sources.imageAttachments, readStringList(
      object.imageAttachments ?? object.images,
    ))
    appendUnique(sources.voiceActions, readStringList(
      object.voiceActions ?? object.voice,
    ))
  }

  return {
    slackChannels: sortUnique(sources.slackChannels),
    ideMentions: sortUnique(sources.ideMentions),
    imageAttachments: sortUnique(sources.imageAttachments),
    voiceActions: sortUnique(sources.voiceActions),
  }
}

async function walkDirectory(args: {
  cwd: string
  directory: string
  depth: number
  maxDepth: number
  limit: number
  files: string[]
}) {
  if (args.depth > args.maxDepth || args.files.length >= args.limit) {
    return
  }

  let entries: Dirent[]
  try {
    entries = await readdir(args.directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (args.files.length >= args.limit) {
      return
    }

    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue
    }

    const path = join(args.directory, entry.name)
    if (entry.isDirectory()) {
      await walkDirectory({
        ...args,
        directory: path,
        depth: args.depth + 1,
      })
      continue
    }

    if (entry.isFile()) {
      args.files.push(relative(args.cwd, path))
    }
  }
}

async function readResourceFile(path: string): Promise<string[]> {
  const parsed = await readJsonFile(path)
  if (!parsed) {
    return []
  }

  if (Array.isArray(parsed)) {
    return parsed.flatMap(readResourceEntry)
  }

  if (parsed && typeof parsed === 'object' && Array.isArray(
    (parsed as { resources?: unknown }).resources,
  )) {
    return (parsed as { resources: unknown[] }).resources.flatMap(readResourceEntry)
  }

  return []
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readResourceEntry(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  const object = value as {
    uri?: unknown
    url?: unknown
    name?: unknown
  }
  if (typeof object.uri === 'string') {
    return [object.uri]
  }

  if (typeof object.url === 'string') {
    return [object.url]
  }

  if (typeof object.name === 'string') {
    return [object.name]
  }

  return []
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(entry => {
    if (typeof entry === 'string') {
      return [entry]
    }

    if (!entry || typeof entry !== 'object') {
      return []
    }

    const object = entry as {
      id?: unknown
      name?: unknown
      label?: unknown
    }
    for (const key of [object.id, object.name, object.label]) {
      if (typeof key === 'string') {
        return [key]
      }
    }

    return []
  })
}

function appendUnique(target: string[], values: string[]) {
  const seen = new Set(target)
  for (const value of values) {
    if (!seen.has(value)) {
      target.push(value)
      seen.add(value)
    }
  }
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}
