import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  readRankedMemorySnippets,
  readSessionMemory,
  type MemoryStoreEntry,
  type SessionMemorySnapshot,
} from '@my-claude-code/tools'

const execFileAsync = promisify(execFile)
const MAX_CONTEXT_SECTION_CHARS = 12_000
const MAX_GIT_STATUS_CHARS = 4_000

export type ContextSection = {
  title: string
  content: string
}

export type RuntimeContextSnapshot = {
  sections: ContextSection[]
  systemContent: string
  memoryFiles: Array<{
    path: string
    chars: number
  }>
  relevantMemory: Array<{
    path: string
    snippet: string
  }>
  localMemoryRank: Array<MemoryStoreEntry & { snippet: string }>
  sessionMemory?: SessionMemorySnapshot
  teamContext?: {
    teamName?: string
    sourceEventCount?: number
    memoryPath?: string
  }
  providerCacheBreaks: Array<{
    recordId: string
    reason: string
  }>
  gitStatus?: string
  estimatedTokens: number
}

export type RuntimeContextOptions = {
  cwd: string
  systemPrompt: string
  appendSystemPrompt?: string
  userContext?: string
  additionalDirectories?: string[]
  sessionId?: string
  providerCacheBreaks?: Array<{ recordId: string; reason: string }>
  prompt?: string
  now?: Date
  includeGitStatus?: boolean
}

export async function buildRuntimeContext(
  options: RuntimeContextOptions,
): Promise<RuntimeContextSnapshot> {
  const sections: ContextSection[] = [
    {
      title: 'Base instructions',
      content: options.systemPrompt,
    },
  ]

  if (options.appendSystemPrompt) {
    sections.push({
      title: 'Appended instructions',
      content: options.appendSystemPrompt,
    })
  }

  sections.push({
    title: 'Current date',
    content: (options.now ?? new Date()).toISOString().slice(0, 10),
  })

  const gitStatus =
    options.includeGitStatus === false
      ? undefined
      : await readGitStatusSnapshot(options.cwd)
  if (gitStatus) {
    sections.push({
      title: 'Git status',
      content: gitStatus,
    })
  }

  const memoryFiles = await readMemoryFiles({
    cwd: options.cwd,
    additionalDirectories: options.additionalDirectories,
  })
  const relevantMemory = selectRelevantMemory(memoryFiles, options.prompt)
  if (memoryFiles.length > 0) {
    sections.push({
      title: 'Memory',
      content: memoryFiles
        .map(file => `${file.path}:\n${file.content}`)
        .join('\n\n'),
    })
  }
  if (relevantMemory.length > 0) {
    sections.push({
      title: 'Relevant memory',
      content: relevantMemory
        .map(memory => `${memory.path}:\n${memory.snippet}`)
        .join('\n\n'),
    })
  }
  const localMemoryRank = await readRankedMemorySnippets(options.cwd, options.prompt)
  if (localMemoryRank.length > 0) {
    sections.push({
      title: 'Ranked local memory',
      content: localMemoryRank
        .map(memory =>
          `${memory.store}/${memory.key} score=${memory.score ?? 0} matches=${(memory.matches ?? []).join(',')}\n${memory.snippet}`)
        .join('\n\n'),
    })
  }
  const sessionMemory = await readSessionMemory(options.cwd, options.sessionId)
  if (sessionMemory) {
    sections.push({
      title: 'Session memory',
      content: [
        `sessionId: ${sessionMemory.sessionId}`,
        sessionMemory.summary,
        ...sessionMemory.providerCacheBreaks.map(cacheBreak =>
          `cache break ${cacheBreak.recordId}: ${cacheBreak.reason}`),
      ].join('\n'),
    })
  }
  const teamContext = await readTeamContext(options.cwd)
  if (teamContext) {
    sections.push({
      title: 'Team context',
      content: [
        teamContext.teamName ? `teamName: ${teamContext.teamName}` : undefined,
        teamContext.memoryPath ? `memoryPath: ${teamContext.memoryPath}` : undefined,
        `sourceEventCount: ${teamContext.sourceEventCount ?? 0}`,
      ].filter(Boolean).join('\n'),
    })
  }
  const providerCacheBreaks = options.providerCacheBreaks ?? []
  if (providerCacheBreaks.length > 0) {
    sections.push({
      title: 'Provider cache breaks',
      content: providerCacheBreaks
        .map(cacheBreak => `${cacheBreak.recordId}: ${cacheBreak.reason}`)
        .join('\n'),
    })
  }
  if (estimateTokens(renderContextSections(sections)) > 24_000) {
    sections.push({
      title: 'Context collapse',
      content: 'The runtime context is large; preserve recent user intent, compact prior transcript summaries, and keep local transcript/state as source of truth.',
    })
  }

  if (options.userContext) {
    sections.push({
      title: 'Session context',
      content: options.userContext,
    })
  }

  if (options.additionalDirectories?.length) {
    sections.push({
      title: 'Additional directories',
      content: options.additionalDirectories.join('\n'),
    })
  }

  const systemContent = renderContextSections(sections)
  return {
    sections,
    systemContent,
    gitStatus,
    memoryFiles: memoryFiles.map(file => ({
      path: file.path,
      chars: file.content.length,
    })),
    relevantMemory,
    localMemoryRank,
    sessionMemory,
    teamContext,
    providerCacheBreaks,
    estimatedTokens: estimateTokens(systemContent),
  }
}

export function renderContextSections(sections: ContextSection[]): string {
  return sections
    .filter(section => section.content.trim().length > 0)
    .map(section => `## ${section.title}\n${section.content}`)
    .join('\n\n')
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4)
}

async function readGitStatusSnapshot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'], {
      cwd,
      timeout: 1_500,
      maxBuffer: 64_000,
    })
    const value = stdout.trim()
    if (!value) {
      return undefined
    }
    return truncate(value, MAX_GIT_STATUS_CHARS)
  } catch {
    return undefined
  }
}

async function readMemoryFiles(options: {
  cwd: string
  additionalDirectories?: string[]
}): Promise<Array<{ path: string; content: string }>> {
  const candidates = uniqueStrings([
    ...claudeMdCandidates(options.cwd),
    join(options.cwd, '.claude', 'CLAUDE.md'),
    join(options.cwd, '.my-claude-code', 'memory.md'),
    ...(options.additionalDirectories ?? []).flatMap(directory =>
      claudeMdCandidates(resolve(options.cwd, directory)),
    ),
  ])
  const files: Array<{ path: string; content: string }> = []

  for (const path of candidates) {
    try {
      const content = truncate(await readFile(path, 'utf8'), MAX_CONTEXT_SECTION_CHARS)
      files.push({
        path,
        content,
      })
    } catch {
    }
  }

  return files
}

function claudeMdCandidates(cwd: string): string[] {
  const paths: string[] = []
  let cursor = resolve(cwd)
  while (true) {
    paths.push(join(cursor, 'CLAUDE.md'))
    const parent = dirname(cursor)
    if (parent === cursor) {
      break
    }
    cursor = parent
  }
  return paths.reverse()
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  return `${value.slice(0, maxChars)}\n[truncated: context section exceeded ${maxChars} chars]`
}

function selectRelevantMemory(
  files: Array<{ path: string; content: string }>,
  prompt: string | undefined,
): Array<{ path: string; snippet: string }> {
  const terms = relevantTerms(prompt)
  if (terms.length === 0) {
    return []
  }

  return files
    .flatMap(file => {
      const lines = file.content.split(/\r?\n/)
      const matches = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) =>
          terms.some(term => line.toLowerCase().includes(term)),
        )
        .slice(0, 3)

      if (matches.length === 0) {
        return []
      }

      return [{
        path: file.path,
        snippet: matches
          .map(({ line, index }) => `${index + 1}: ${line}`)
          .join('\n'),
      }]
    })
    .slice(0, 5)
}

function relevantTerms(prompt: string | undefined): string[] {
  return uniqueStrings(
    (prompt ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map(term => term.trim())
      .filter(term => term.length >= 3),
  ).slice(0, 12)
}

async function readTeamContext(cwd: string): Promise<RuntimeContextSnapshot['teamContext'] | undefined> {
  try {
    return JSON.parse(await readFile(join(cwd, '.my-claude-code', 'team-memory-sync.json'), 'utf8')) as RuntimeContextSnapshot['teamContext']
  } catch {
    try {
      const current = JSON.parse(await readFile(join(cwd, '.my-claude-code', 'teams', 'current.json'), 'utf8')) as {
        teamName?: string
      }
      return current.teamName ? { teamName: current.teamName, sourceEventCount: 0 } : undefined
    } catch {
      return undefined
    }
  }
}
