import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const STORE_REGEX = /^(?!\.)[^/\\:]{1,255}$/
const KEY_REGEX = /^[A-Za-z0-9._-]{1,128}$/
const MAX_MEMORY_CHARS = 12_000
const MAX_EXTRACTED_MEMORIES = 12

export type MemoryStoreEntry = {
  store: string
  key: string
  path: string
  chars: number
  updatedAt: string
  contentHash: string
  score?: number
  matches?: string[]
}

export type MemoryRankingResult = {
  prompt: string
  generatedAt: string
  cacheKey: string
  entries: MemoryStoreEntry[]
}

export type ExtractedMemoryRecord = {
  id: string
  store: string
  key: string
  memory: string
  source: 'text' | 'transcript' | 'session'
  createdAt: string
}

export type AgentMemorySnapshot = {
  id: string
  agentId: string
  sessionId?: string
  summary: string
  memories: string[]
  createdAt: string
}

export type SessionMemorySnapshot = {
  sessionId: string
  summary: string
  providerCacheBreaks: Array<{ recordId: string; reason: string }>
  createdAt: string
}

export type TeamMemorySyncRecord = {
  id: string
  teamName: string
  memoryPath: string
  sourceEventCount: number
  createdAt: string
}

export async function listMemoryStoreEntries(cwd: string): Promise<MemoryStoreEntry[]> {
  const root = memoryRoot(cwd)
  const stores = await safeReaddir(root)
  const result: MemoryStoreEntry[] = []
  for (const storeEntry of stores.filter(entry => entry.isDirectory())) {
    const store = storeEntry.name
    if (!STORE_REGEX.test(store)) {
      continue
    }
    const files = await safeReaddir(join(root, store))
    for (const file of files.filter(entry => entry.isFile() && entry.name.endsWith('.md'))) {
      const key = basename(file.name, '.md')
      if (!KEY_REGEX.test(key)) {
        continue
      }
      const path = join(root, store, file.name)
      const content = await readFile(path, 'utf8').catch(() => '')
      const fileStat = await stat(path).catch(() => undefined)
      result.push({
        store,
        key,
        path,
        chars: content.length,
        updatedAt: new Date(fileStat?.mtimeMs ?? 0).toISOString(),
        contentHash: hash(content),
      })
    }
  }
  return result.sort((left, right) =>
    `${left.store}/${left.key}`.localeCompare(`${right.store}/${right.key}`),
  )
}

export async function rankMemoryStoreEntries(
  cwd: string,
  prompt: string | undefined,
  limit = 8,
): Promise<MemoryRankingResult> {
  const entries = await listMemoryStoreEntries(cwd)
  const terms = relevantTerms(prompt)
  const ranked = await Promise.all(entries.map(async entry => {
    const content = await readFile(entry.path, 'utf8').catch(() => '')
    const lower = content.toLowerCase()
    const matches = terms.filter(term => lower.includes(term))
    const score = matches.length * 10 +
      matches.reduce((total, term) => total + Math.max(1, 12 - term.length), 0) +
      Math.min(5, Math.ceil(content.length / 2000))
    return { ...entry, score, matches }
  }))
  const result: MemoryRankingResult = {
    prompt: prompt ?? '',
    generatedAt: new Date().toISOString(),
    cacheKey: hash(`${prompt ?? ''}\n${entries.map(entry => `${entry.path}:${entry.contentHash}`).join('\n')}`),
    entries: ranked
      .filter(entry => entry.score > 0 || terms.length === 0)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) ||
        `${left.store}/${left.key}`.localeCompare(`${right.store}/${right.key}`))
      .slice(0, limit),
  }
  await writeJsonFile(memoryRankingCachePath(cwd), result)
  return result
}

export async function readRankedMemorySnippets(
  cwd: string,
  prompt: string | undefined,
  limit = 5,
): Promise<Array<MemoryStoreEntry & { snippet: string }>> {
  const ranking = await rankMemoryStoreEntries(cwd, prompt, limit)
  return Promise.all(ranking.entries.map(async entry => ({
    ...entry,
    snippet: truncate(await readFile(entry.path, 'utf8').catch(() => ''), MAX_MEMORY_CHARS),
  })))
}

export async function extractMemories(cwd: string, input: {
  text: string
  store?: string
  source?: ExtractedMemoryRecord['source']
}): Promise<ExtractedMemoryRecord[]> {
  const store = sanitizeStore(input.store ?? 'extracted')
  const candidates = input.text
    .split(/\r?\n+/)
    .map(line => line.replace(/^[-*]\s+/, '').trim())
    .filter(line => line.length >= 12)
    .filter(line => !line.startsWith('{') && !line.startsWith('```'))
    .slice(0, MAX_EXTRACTED_MEMORIES)
  const records: ExtractedMemoryRecord[] = []
  for (const memory of candidates) {
    const key = sanitizeKey(`${new Date().toISOString().slice(0, 10)}-${hash(memory).slice(0, 10)}`)
    const record: ExtractedMemoryRecord = {
      id: `mem_${randomUUID()}`,
      store,
      key,
      memory,
      source: input.source ?? 'text',
      createdAt: new Date().toISOString(),
    }
    await writeMemoryEntry(cwd, store, key, [
      `source: ${record.source}`,
      `createdAt: ${record.createdAt}`,
      '',
      memory,
      '',
    ].join('\n'))
    records.push(record)
  }
  return records
}

export async function writeAgentMemorySnapshot(cwd: string, input: {
  agentId: string
  sessionId?: string
  summary: string
  memories?: string[]
}): Promise<AgentMemorySnapshot> {
  const snapshot: AgentMemorySnapshot = {
    id: `agent_mem_${randomUUID()}`,
    agentId: sanitizeKey(input.agentId),
    sessionId: input.sessionId,
    summary: input.summary,
    memories: input.memories ?? [],
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(agentMemorySnapshotPath(cwd, snapshot.agentId), snapshot)
  await writeMemoryEntry(cwd, 'agents', snapshot.agentId, [
    `agentId: ${snapshot.agentId}`,
    snapshot.sessionId ? `sessionId: ${snapshot.sessionId}` : undefined,
    `createdAt: ${snapshot.createdAt}`,
    '',
    snapshot.summary,
    ...snapshot.memories.map(memory => `- ${memory}`),
    '',
  ].filter(Boolean).join('\n'))
  return snapshot
}

export async function writeSessionMemorySnapshot(cwd: string, input: {
  sessionId: string
  summary: string
  providerCacheBreaks?: Array<{ recordId: string; reason: string }>
}): Promise<SessionMemorySnapshot> {
  const snapshot: SessionMemorySnapshot = {
    sessionId: sanitizeKey(input.sessionId),
    summary: input.summary,
    providerCacheBreaks: input.providerCacheBreaks ?? [],
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(sessionMemoryPath(cwd, snapshot.sessionId), snapshot)
  await writeMemoryEntry(cwd, 'sessions', snapshot.sessionId, [
    `sessionId: ${snapshot.sessionId}`,
    `createdAt: ${snapshot.createdAt}`,
    '',
    snapshot.summary,
    ...snapshot.providerCacheBreaks.map(cacheBreak =>
      `- cache break ${cacheBreak.recordId}: ${cacheBreak.reason}`),
    '',
  ].join('\n'))
  return snapshot
}

export async function readSessionMemory(cwd: string, sessionId?: string): Promise<SessionMemorySnapshot | undefined> {
  if (!sessionId) {
    return undefined
  }
  try {
    return JSON.parse(await readFile(sessionMemoryPath(cwd, sessionId), 'utf8')) as SessionMemorySnapshot
  } catch {
    return undefined
  }
}

export async function syncTeamMemory(cwd: string, teamName?: string): Promise<TeamMemorySyncRecord> {
  const current = await readJsonFile<{ teamName?: string }>(join(cwd, '.my-claude-code', 'teams', 'current.json'), {})
  const resolvedTeamName = sanitizeStore(teamName ?? current.teamName ?? 'default')
  const events = await readJsonFile<Array<Record<string, unknown>>>(
    join(cwd, '.my-claude-code', 'teams', 'events.json'),
    [],
  )
  const relevantEvents = events.filter(event =>
    !event.teamName || event.teamName === resolvedTeamName,
  )
  const content = [
    `team: ${resolvedTeamName}`,
    `syncedAt: ${new Date().toISOString()}`,
    '',
    ...relevantEvents.slice(-50).map(event =>
      `- ${String(event.type ?? 'event')} ${String(event.status ?? 'unknown')} ${String(event.summary ?? '')}`.trim(),
    ),
    '',
  ].join('\n')
  const memoryPath = await writeMemoryEntry(cwd, 'team', resolvedTeamName, content)
  const record: TeamMemorySyncRecord = {
    id: `team_mem_${randomUUID()}`,
    teamName: resolvedTeamName,
    memoryPath,
    sourceEventCount: relevantEvents.length,
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(join(cwd, '.my-claude-code', 'team-memory-sync.json'), record)
  return record
}

export function memoryRoot(cwd: string): string {
  return join(cwd, '.my-claude-code', 'local-memory')
}

async function writeMemoryEntry(cwd: string, store: string, key: string, content: string): Promise<string> {
  const path = join(memoryRoot(cwd), sanitizeStore(store), `${sanitizeKey(key)}.md`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

function memoryRankingCachePath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'memory-cache.json')
}

function agentMemorySnapshotPath(cwd: string, agentId: string): string {
  return join(cwd, '.my-claude-code', 'agent-memory-snapshots', `${sanitizeKey(agentId)}.json`)
}

function sessionMemoryPath(cwd: string, sessionId: string): string {
  return join(cwd, '.my-claude-code', 'session-memory', `${sanitizeKey(sessionId)}.json`)
}

async function safeReaddir(path: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function sanitizeStore(value: string): string {
  return STORE_REGEX.test(value) ? value : 'default'
}

function sanitizeKey(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return KEY_REGEX.test(normalized) ? normalized : hash(value).slice(0, 16)
}

function relevantTerms(prompt: string | undefined): string[] {
  return [...new Set(
    (prompt ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map(term => term.trim())
      .filter(term => term.length >= 3),
  )].slice(0, 16)
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n[truncated: memory entry exceeded ${maxChars} chars]`
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
