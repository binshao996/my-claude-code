import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  type ContentBlock,
  type ImageBlock,
  type Message,
  TranscriptRecordSchema,
  type ToolResultBlock,
  type ToolUseBlock,
  type TranscriptRecord,
  type Usage,
} from '@my-claude-code/core'

const execFileAsync = promisify(execFile)

export type SessionMetadata = {
  id: string
  cwd: string
  transcriptPath: string
  createdAt: string
  updatedAt: string
  model?: string
  permissionMode?: string
  additionalDirectories?: string[]
  promptCount: number
  lastPrompt?: string
  parentSessionId?: string
  forkedAt?: string
  forkReason?: 'fork' | 'rewind'
  rewindRecordId?: string
}

export type SessionIndex = {
  latestSessionId?: string
  sessions: SessionMetadata[]
}

export type ReplayContext = {
  session: SessionMetadata
  summary: string
  readFiles: string[]
  stats: {
    eventCount: number
    assistantTextChars: number
    estimatedTokens: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    promptCache: PromptCacheStats
    tokenBudget: TokenBudgetStats
    toolUseCount: number
  }
  providerMessages: Message[]
  restorePlan: SessionRestorePlan
}

export type PromptCacheStats = {
  creationInputTokens: number
  readInputTokens: number
  totalInputTokens: number
  hitRate: number
}

export type TokenBudgetStats = {
  limit: number
  used: number
  remaining: number
  percentUsed: number
  source: 'provider-usage' | 'estimated'
}

export type SessionRestorePlan = {
  graphRestored: boolean
  parentSessionIds: string[]
  lineageSessionIds: string[]
  missingParentSessionIds: string[]
  branchDepth: number
  transcriptHydration: TranscriptHydration
  providerMessageHydration: ProviderMessageHydration
  providerCacheBreaks: ProviderCacheBreak[]
  compactState: CompactStateRestoration
  fileSnapshotCoverage: FileSnapshotCoverage
  additionalDirectoriesRestored: boolean
  replayedRecordCount: number
  fileMutationCount: number
  remainingGaps: string[]
}

export type TranscriptHydration = {
  status: 'empty' | 'partial' | 'complete'
  messageCount: number
  toolUseCount: number
  toolResultCount: number
}

export type ProviderMessageHydration = {
  status: 'empty' | 'partial' | 'complete'
  messageCount: number
  replayedRecordCount: number
  assistantMessageCount: number
  userToolResultMessageCount: number
  toolUseBlockCount: number
  toolResultBlockCount: number
  pairedToolResultCount: number
  unpairedToolResultCount: number
  unpairedToolResultIds: string[]
  unpairedToolResultReasons: Record<string, string>
}

export type ProviderCacheBreak = {
  recordId: string
  reason:
    | 'cache_read_dropped'
    | 'compact_boundary'
    | 'context_window_exceeded'
    | 'prompt_state_changed'
  previousCacheReadInputTokens: number
  cacheReadInputTokens: number
  previousPromptStateHash?: string
  promptStateHash?: string
  cacheCreationInputTokens?: number
}

export type CompactStateRestoration = {
  status: 'empty' | 'inferred' | 'restored'
  boundaryRecordId?: string
  summaryRecordId?: string
  compactedRecordCount: number
  replayableRecordCount: number
  summaryChars: number
}

export type FileSnapshotCoverage = {
  changed: number
  missing: number
  available: number
}

export type SessionCheckpoint = {
  recordId: string
  createdAt: string
  eventType: string
  label: string
}

export type FileSnapshotEntry = {
  path: string
  type: 'file' | 'directory' | 'symlink'
  mode?: number
  contentBase64?: string
  symlinkTarget?: string
}

export type FileSnapshotRecord = {
  id: string
  session_id: string
  created_at: string
  tool_use_id: string
  tool_name: string
  file_path: string
  existed: boolean
  kind?: 'missing' | 'file' | 'directory' | 'symlink'
  mode?: number
  encoding?: 'utf8' | 'base64'
  content?: string
  contentBase64?: string
  symlinkTarget?: string
  entries?: FileSnapshotEntry[]
}

export type FileRewindResult = {
  checkpointRecordId: string
  restoredFiles: string[]
  missingSnapshots: string[]
  worktreeConflicts: string[]
}

export type SessionGraphNode = SessionMetadata & {
  childrenIds: string[]
  depth: number
}

export type SessionGraph = {
  latestSessionId?: string
  roots: SessionGraphNode[]
  nodes: SessionGraphNode[]
}

export function sessionRoot(cwd: string): string {
  return join(cwd, '.my-claude-code')
}

export function sessionIndexPath(cwd: string): string {
  return join(sessionRoot(cwd), 'sessions.json')
}

export function sessionTranscriptPath(cwd: string, sessionId: string): string {
  return join(sessionRoot(cwd), 'transcripts', `${sessionId}.jsonl`)
}

export function fileSnapshotPath(cwd: string, sessionId: string): string {
  return join(fileSnapshotRoot(cwd), `${sessionId}.jsonl`)
}

export function fileSnapshotRoot(cwd: string): string {
  return join(sessionRoot(cwd), 'file-snapshots')
}

export async function readSessionIndex(cwd: string): Promise<SessionIndex> {
  try {
    return normalizeIndex(JSON.parse(await readFile(sessionIndexPath(cwd), 'utf8')))
  } catch (error) {
    if (isNotFound(error)) {
      return { sessions: [] }
    }

    throw error
  }
}

export async function recordSession(options: {
  cwd: string
  sessionId: string
  transcriptPath: string
  prompt: string
  model?: string
  permissionMode?: string
  additionalDirectories?: string[]
  now?: Date
}): Promise<SessionMetadata> {
  const now = (options.now ?? new Date()).toISOString()
  const index = await readSessionIndex(options.cwd)
  const existing = index.sessions.find((session) => session.id === options.sessionId)
  const session: SessionMetadata = {
    id: options.sessionId,
    cwd: options.cwd,
    transcriptPath: options.transcriptPath,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    model: options.model ?? existing?.model,
    permissionMode: options.permissionMode ?? existing?.permissionMode,
    additionalDirectories: options.additionalDirectories ?? existing?.additionalDirectories,
    promptCount: (existing?.promptCount ?? 0) + 1,
    lastPrompt: options.prompt,
  }

  const sessions = [
    session,
    ...index.sessions.filter((candidate) => candidate.id !== options.sessionId),
  ].slice(0, 50)

  await writeSessionIndex(options.cwd, {
    latestSessionId: session.id,
    sessions,
  })

  return session
}

export async function resolveSession(
  cwd: string,
  sessionId: string,
): Promise<SessionMetadata | undefined> {
  const index = await readSessionIndex(cwd)
  return index.sessions.find((session) => session.id === sessionId)
}

export async function resolveLatestSession(cwd: string): Promise<SessionMetadata | undefined> {
  const index = await readSessionIndex(cwd)
  return index.sessions.find((session) => session.id === index.latestSessionId) ?? index.sessions[0]
}

export async function listSessions(cwd: string): Promise<SessionMetadata[]> {
  return (await readSessionIndex(cwd)).sessions
}

export async function buildSessionGraph(cwd: string): Promise<SessionGraph> {
  const index = await readSessionIndex(cwd)
  const childrenByParent = new Map<string, string[]>()

  for (const session of index.sessions) {
    if (!session.parentSessionId) {
      continue
    }

    childrenByParent.set(session.parentSessionId, [
      ...(childrenByParent.get(session.parentSessionId) ?? []),
      session.id,
    ])
  }

  const nodeById = new Map<string, SessionGraphNode>()
  const depthFor = (session: SessionMetadata, seen = new Set<string>()): number => {
    if (!session.parentSessionId || seen.has(session.id)) {
      return 0
    }

    const parent = index.sessions.find((candidate) => candidate.id === session.parentSessionId)
    if (!parent) {
      return 0
    }

    return 1 + depthFor(parent, new Set([...seen, session.id]))
  }

  for (const session of index.sessions) {
    nodeById.set(session.id, {
      ...session,
      childrenIds: childrenByParent.get(session.id) ?? [],
      depth: depthFor(session),
    })
  }

  const nodes = index.sessions.map((session) => nodeById.get(session.id) as SessionGraphNode)
  return {
    latestSessionId: index.latestSessionId,
    roots: nodes.filter((node) => !node.parentSessionId || !nodeById.has(node.parentSessionId)),
    nodes,
  }
}

export async function forkSession(options: {
  cwd: string
  sourceSessionId: string
  newSessionId?: string
  truncateAfterRecordId?: string
  mode?: 'fork' | 'rewind'
  now?: Date
}): Promise<SessionMetadata | undefined> {
  const source = await resolveSession(options.cwd, options.sourceSessionId)
  if (!source) {
    return undefined
  }

  const records = await readTranscriptRecords(source.transcriptPath)
  const forkRecords = options.truncateAfterRecordId
    ? truncateRecordsAfter(records, options.truncateAfterRecordId)
    : records

  if (options.truncateAfterRecordId && !forkRecords) {
    return undefined
  }

  const now = (options.now ?? new Date()).toISOString()
  const newSessionId = options.newSessionId ?? `session_${randomUUID()}`
  const transcriptPath = sessionTranscriptPath(options.cwd, newSessionId)
  const session: SessionMetadata = {
    ...source,
    id: newSessionId,
    cwd: options.cwd,
    transcriptPath,
    createdAt: now,
    updatedAt: now,
    parentSessionId: source.id,
    forkedAt: now,
    forkReason: options.mode ?? (options.truncateAfterRecordId ? 'rewind' : 'fork'),
    rewindRecordId: options.truncateAfterRecordId,
  }

  await writeTranscriptRecords(
    transcriptPath,
    (forkRecords ?? records).map((record) => ({
      ...record,
      session_id: newSessionId,
    })),
  )

  const index = await readSessionIndex(options.cwd)
  await writeSessionIndex(options.cwd, {
    latestSessionId: session.id,
    sessions: [session, ...index.sessions.filter((candidate) => candidate.id !== session.id)].slice(
      0,
      50,
    ),
  })

  return session
}

export async function listSessionCheckpoints(
  session: SessionMetadata,
  limit = 10,
): Promise<SessionCheckpoint[]> {
  const records = await readTranscriptRecords(session.transcriptPath)
  return records
    .slice(-Math.max(0, limit))
    .reverse()
    .map((record) => ({
      recordId: record.id,
      createdAt: record.created_at,
      eventType: record.event.type,
      label: summarizeCheckpoint(record),
    }))
}

export async function recordFileSnapshot(options: {
  cwd: string
  sessionId: string
  toolUseId: string
  toolName: string
  filePath: string
  now?: Date
}): Promise<FileSnapshotRecord> {
  const absolutePath = resolveInsideCwd(options.cwd, options.filePath)
  const snapshot = await readSnapshotContent(absolutePath)
  const record: FileSnapshotRecord = {
    id: randomUUID(),
    session_id: options.sessionId,
    created_at: (options.now ?? new Date()).toISOString(),
    tool_use_id: options.toolUseId,
    tool_name: options.toolName,
    file_path: options.filePath,
    existed: snapshot.existed,
    kind: snapshot.kind,
    mode: snapshot.existed ? snapshot.mode : undefined,
    encoding: snapshot.kind === 'file' ? snapshot.encoding : undefined,
    content: snapshot.kind === 'file' ? snapshot.content : undefined,
    contentBase64: snapshot.kind === 'file' ? snapshot.contentBase64 : undefined,
    symlinkTarget: snapshot.kind === 'symlink' ? snapshot.symlinkTarget : undefined,
    entries: snapshot.kind === 'directory' ? snapshot.entries : undefined,
  }

  const path = join(fileSnapshotRoot(options.cwd), `${options.sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record)}\n`, { flag: 'a' })

  return record
}

export async function listFileSnapshots(
  cwd: string,
  sessionId: string,
): Promise<FileSnapshotRecord[]> {
  try {
    const content = await readFile(fileSnapshotPath(cwd, sessionId), 'utf8')
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FileSnapshotRecord)
  } catch (error) {
    if (isNotFound(error)) {
      return []
    }

    throw error
  }
}

export async function rewindFilesToCheckpoint(options: {
  cwd: string
  session: SessionMetadata
  checkpointRecordId: string
}): Promise<FileRewindResult> {
  const records = await readTranscriptRecords(options.session.transcriptPath)
  const checkpointIndex = records.findIndex((record) => record.id === options.checkpointRecordId)
  if (checkpointIndex === -1) {
    throw new Error(`checkpoint not found: ${options.checkpointRecordId}`)
  }

  const changedToolUses = records
    .slice(checkpointIndex + 1)
    .map((record) => record.event)
    .filter(isFileChangingToolUse)
  const snapshots = await listFileSnapshots(options.cwd, options.session.id)
  const worktreeConflicts = await changedWorktreeFiles(
    options.cwd,
    changedToolUses.map((toolUse) => toolUse.input.file_path),
  )
  const restoredFiles: string[] = []
  const missingSnapshots: string[] = []

  for (const toolUse of changedToolUses.reverse()) {
    const snapshot = snapshots.find((candidate) => candidate.tool_use_id === toolUse.tool_use_id)
    if (!snapshot) {
      missingSnapshots.push(toolUse.tool_use_id)
      continue
    }

    await restoreSnapshot(options.cwd, snapshot)
    if (!restoredFiles.includes(snapshot.file_path)) {
      restoredFiles.push(snapshot.file_path)
    }
  }

  return {
    checkpointRecordId: options.checkpointRecordId,
    restoredFiles,
    missingSnapshots,
    worktreeConflicts,
  }
}

export async function replaySession(session: SessionMetadata): Promise<ReplayContext> {
  const records = await readReplayTranscriptRecords(session.transcriptPath)
  const lineage = await collectParentSessionIds(session)
  const assistantText: string[] = []
  const readFiles = new Set<string>()
  const changedToolUseIds = new Set<string>()
  let messageCount = 0
  let toolUseCount = 0
  let toolResultCount = 0
  let fileMutationCount = 0
  const usageTotals = emptyUsageTotals()
  let currentMessageUsage: UsageTotals | undefined

  for (const record of records) {
    const event = record.event
    if (event.type === 'message_start') {
      messageCount += 1
      currentMessageUsage = normalizeUsage(event.message.usage)
    }

    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      assistantText.push(event.delta.text)
    }

    if (event.type === 'tool_execution_start') {
      toolUseCount += 1
      if (event.name === 'Read' && typeof event.input.file_path === 'string') {
        readFiles.add(event.input.file_path)
      }
      if (isFileChangingToolUse(event)) {
        changedToolUseIds.add(event.tool_use_id)
      }
    }

    if (event.type === 'message_delta' && event.usage) {
      currentMessageUsage = maxUsageTotals(
        currentMessageUsage ?? emptyUsageTotals(),
        normalizeUsage(event.usage),
      )
    }

    if (event.type === 'message_stop' && currentMessageUsage) {
      addUsageTotals(usageTotals, currentMessageUsage)
      currentMessageUsage = undefined
    }

    if (
      event.type === 'tool_execution_result' &&
      !event.is_error &&
      (event.name === 'Write' || event.name === 'Edit')
    ) {
      fileMutationCount += 1
    }

    if (event.type === 'tool_execution_result') {
      toolResultCount += 1
    }
  }

  if (currentMessageUsage) {
    addUsageTotals(usageTotals, currentMessageUsage)
  }

  const assistantTextValue = assistantText.join('')
  const providerTokenTotal =
    usageTotals.inputTokens +
    usageTotals.outputTokens +
    usageTotals.cacheCreationInputTokens +
    usageTotals.cacheReadInputTokens
  const estimatedTokens =
    providerTokenTotal > 0
      ? providerTokenTotal
      : Math.ceil((assistantTextValue.length + (session.lastPrompt?.length ?? 0)) / 4)
  const promptCache = buildPromptCacheStats(usageTotals)
  const tokenBudget = buildTokenBudgetStats(estimatedTokens, providerTokenTotal > 0)
  const transcriptHydration = buildTranscriptHydration({
    records,
    messageCount,
    toolUseCount,
    toolResultCount,
  })
  const transcriptGraphRestored = records.some((record) => record.uuid)
  const compactState = restoreCompactState(records)
  const providerReplayRecords = recordsAfterCompactBoundary(records, compactState)
  const compactSummary = compactSummaryForState(records, compactState)
  const providerMessages = hydrateProviderMessages(providerReplayRecords)
  const providerCacheBreaks = detectProviderCacheBreaks(records)
  const providerMessageHydration = buildProviderMessageHydration({
    replayedRecordCount: providerReplayRecords.length,
    providerMessages,
    providerCacheBreaks,
  })
  const fileSnapshotCoverage = await buildFileSnapshotCoverage({
    cwd: session.cwd,
    sessionId: session.id,
    changedToolUseIds,
  })
  const remainingGaps = buildRestoreGaps({
    missingParentSessionIds: lineage.missingParentSessionIds,
    fileSnapshotCoverage,
    providerMessageHydration,
    providerCacheBreaks,
    compactState,
  })
  const summary = [
    `Resuming session ${session.id}.`,
    session.lastPrompt ? `Last prompt: ${session.lastPrompt}` : undefined,
    compactState.status !== 'empty'
      ? `Compact state: ${compactState.status}; replayable records after boundary: ${compactState.replayableRecordCount}.`
      : undefined,
    compactSummary ? `Restored compact summary:\n${compactSummary.slice(-4000)}` : undefined,
    readFiles.size > 0 ? `Files read in this session: ${[...readFiles].join(', ')}` : undefined,
    assistantTextValue ? `Recent assistant output:\n${assistantTextValue.slice(-4000)}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    session,
    summary,
    readFiles: [...readFiles],
    providerMessages,
    stats: {
      eventCount: records.length,
      assistantTextChars: assistantTextValue.length,
      estimatedTokens,
      toolUseCount,
      inputTokens: usageTotals.inputTokens,
      outputTokens: usageTotals.outputTokens,
      totalTokens: providerTokenTotal,
      cacheCreationInputTokens: usageTotals.cacheCreationInputTokens,
      cacheReadInputTokens: usageTotals.cacheReadInputTokens,
      promptCache,
      tokenBudget,
    },
    restorePlan: {
      graphRestored:
        transcriptGraphRestored ||
        (Boolean(session.parentSessionId || session.forkReason) &&
          lineage.missingParentSessionIds.length === 0),
      parentSessionIds: lineage.parentSessionIds,
      lineageSessionIds: [...lineage.parentSessionIds],
      missingParentSessionIds: lineage.missingParentSessionIds,
      branchDepth: lineage.parentSessionIds.length,
      transcriptHydration,
      providerMessageHydration,
      providerCacheBreaks,
      compactState,
      fileSnapshotCoverage,
      additionalDirectoriesRestored: (session.additionalDirectories?.length ?? 0) > 0,
      replayedRecordCount: records.length,
      fileMutationCount,
      remainingGaps,
    },
  }
}

export async function sessionContextStats(cwd: string, sessionId?: string) {
  const session = sessionId ? await resolveSession(cwd, sessionId) : await resolveLatestSession(cwd)

  if (!session) {
    return undefined
  }

  return replaySession(session)
}

async function writeSessionIndex(cwd: string, index: SessionIndex) {
  const path = sessionIndexPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

async function readTranscriptRecords(transcriptPath: string): Promise<TranscriptRecord[]> {
  const content = await readFile(transcriptPath, 'utf8').catch((error) => {
    if (isNotFound(error)) {
      return ''
    }

    throw error
  })

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => TranscriptRecordSchema.parse(JSON.parse(line)))
}

async function readReplayTranscriptRecords(transcriptPath: string): Promise<TranscriptRecord[]> {
  const records = await readTranscriptRecords(transcriptPath)
  return selectGraphReplayRecords(records)
}

function selectGraphReplayRecords(records: TranscriptRecord[]): TranscriptRecord[] {
  const graphRecords = records.filter((record) => record.uuid)
  if (graphRecords.length === 0) {
    return records
  }

  const activeRecords = graphRecords.filter((record) => !record.isSidechain)
  if (activeRecords.length === 0) {
    return []
  }

  const activeUuidSet = new Set(
    activeRecords.map((record) => record.uuid).filter((uuid): uuid is string => Boolean(uuid)),
  )
  const parentUuids = new Set(
    activeRecords
      .map((record) => graphParentUuid(record))
      .filter(
        (uuid): uuid is string =>
          typeof uuid === 'string' && activeUuidSet.has(uuid),
      ),
  )
  const leaf =
    [...activeRecords].reverse().find((record) => record.uuid && !parentUuids.has(record.uuid)) ??
    activeRecords.at(-1)

  if (!leaf?.uuid) {
    return activeRecords
  }

  const byUuid = new Map(
    activeRecords.filter((record) => record.uuid).map((record) => [record.uuid as string, record]),
  )
  const selected: TranscriptRecord[] = []
  const seen = new Set<string>()
  let cursor: TranscriptRecord | undefined = leaf

  while (cursor?.uuid && !seen.has(cursor.uuid)) {
    selected.push(cursor)
    seen.add(cursor.uuid)
    const parentUuid = graphParentUuid(cursor)
    cursor = parentUuid ? byUuid.get(parentUuid) : undefined
  }

  const selectedUuidSet = new Set(selected.map((record) => record.uuid))
  return records.filter(
    (record) => record.uuid && selectedUuidSet.has(record.uuid) && !record.isSidechain,
  )
}

function graphParentUuid(record: TranscriptRecord): string | undefined {
  return record.logicalParentUuid ?? record.parentUuid ?? undefined
}

async function writeTranscriptRecords(
  transcriptPath: string,
  records: TranscriptRecord[],
): Promise<void> {
  await mkdir(dirname(transcriptPath), { recursive: true })
  await writeFile(
    transcriptPath,
    records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '',
    'utf8',
  )
}

function truncateRecordsAfter(
  records: TranscriptRecord[],
  recordId: string,
): TranscriptRecord[] | undefined {
  const index = records.findIndex((record) => record.id === recordId)
  if (index === -1) {
    return undefined
  }

  return records.slice(0, index + 1)
}

function summarizeCheckpoint(record: TranscriptRecord): string {
  const event = record.event
  switch (event.type) {
    case 'content_block_delta':
      if (event.delta.type === 'text_delta') {
        return `assistant text: ${event.delta.text.slice(0, 60)}`
      }
      return `${event.delta.type}`
    case 'tool_execution_start':
      return `tool start: ${event.name}`
    case 'tool_execution_result':
      return `tool result: ${event.name}`
    case 'terminal':
      return `terminal: ${event.status}`
    case 'message_delta':
      return `message delta: ${event.delta.stop_reason ?? 'streaming'}`
    default:
      return event.type
  }
}

async function readSnapshotContent(absolutePath: string): Promise<
  | {
      existed: true
      kind: 'file'
      mode: number
      encoding: 'utf8' | 'base64'
      content?: string
      contentBase64: string
    }
  | {
      existed: true
      kind: 'directory'
      mode: number
      entries: FileSnapshotEntry[]
    }
  | {
      existed: true
      kind: 'symlink'
      mode: number
      symlinkTarget: string
    }
  | { existed: false; kind: 'missing' }
> {
  try {
    const snapshotStat = await lstat(absolutePath)
    const mode = snapshotStat.mode & 0o777
    if (snapshotStat.isSymbolicLink()) {
      return {
        existed: true,
        kind: 'symlink',
        mode,
        symlinkTarget: await readlink(absolutePath),
      }
    }

    if (snapshotStat.isDirectory()) {
      return {
        existed: true,
        kind: 'directory',
        mode,
        entries: await readDirectorySnapshot(absolutePath),
      }
    }

    const content = await readFile(absolutePath)
    const utf8 = content.toString('utf8')
    const contentBase64 = content.toString('base64')
    const isUtf8 = Buffer.from(utf8, 'utf8').equals(content)
    return {
      existed: true,
      kind: 'file',
      mode,
      encoding: isUtf8 ? 'utf8' : 'base64',
      content: isUtf8 ? utf8 : undefined,
      contentBase64,
    }
  } catch (error) {
    if (isNotFound(error)) {
      return { existed: false, kind: 'missing' }
    }

    throw error
  }
}

async function restoreSnapshot(cwd: string, snapshot: FileSnapshotRecord): Promise<void> {
  const absolutePath = resolveInsideCwd(cwd, snapshot.file_path)
  if (!snapshot.existed) {
    await rm(absolutePath, { force: true, recursive: true })
    return
  }

  if (snapshot.kind === 'directory') {
    await rm(absolutePath, { force: true, recursive: true })
    await mkdir(absolutePath, { recursive: true })
    await chmodIfPossible(absolutePath, snapshot.mode)
    for (const entry of sortDirectorySnapshotEntries(snapshot.entries ?? [])) {
      const entryPath = resolveInsideCwd(absolutePath, entry.path)
      if (entry.type === 'directory') {
        await mkdir(entryPath, { recursive: true })
        await chmodIfPossible(entryPath, entry.mode)
        continue
      }

      await rm(entryPath, { force: true, recursive: true })
      await mkdir(dirname(entryPath), { recursive: true })
      if (entry.type === 'symlink') {
        await symlink(entry.symlinkTarget ?? '', entryPath)
      } else {
        await writeFile(entryPath, Buffer.from(entry.contentBase64 ?? '', 'base64'))
        await chmodIfPossible(entryPath, entry.mode)
      }
    }
    return
  }

  if (snapshot.kind === 'symlink') {
    await rm(absolutePath, { force: true, recursive: true })
    await mkdir(dirname(absolutePath), { recursive: true })
    await symlink(snapshot.symlinkTarget ?? '', absolutePath)
    return
  }

  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(
    absolutePath,
    snapshot.contentBase64
      ? Buffer.from(snapshot.contentBase64, 'base64')
      : (snapshot.content ?? ''),
  )
  await chmodIfPossible(absolutePath, snapshot.mode)
}

async function readDirectorySnapshot(root: string, current = root): Promise<FileSnapshotEntry[]> {
  const entries: FileSnapshotEntry[] = []
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const absolutePath = join(current, entry.name)
    const entryStat = await lstat(absolutePath)
    const path = relativeSnapshotPath(root, absolutePath)
    const mode = entryStat.mode & 0o777
    if (entry.isDirectory()) {
      entries.push({
        path,
        type: 'directory',
        mode,
      })
      entries.push(...(await readDirectorySnapshot(root, absolutePath)))
      continue
    }

    if (entry.isSymbolicLink()) {
      entries.push({
        path,
        type: 'symlink',
        mode,
        symlinkTarget: await readlink(absolutePath),
      })
      continue
    }

    if (!entryStat.isFile()) {
      continue
    }

    entries.push({
      path,
      type: 'file',
      mode,
      contentBase64: (await readFile(absolutePath)).toString('base64'),
    })
  }

  return entries
}

function sortDirectorySnapshotEntries(entries: FileSnapshotEntry[]): FileSnapshotEntry[] {
  return [...entries].sort((a, b) => {
    const typeOrder = entryTypeOrder(a.type) - entryTypeOrder(b.type)
    return typeOrder === 0 ? a.path.localeCompare(b.path) : typeOrder
  })
}

function entryTypeOrder(type: FileSnapshotEntry['type']): number {
  switch (type) {
    case 'directory':
      return 0
    case 'file':
      return 1
    case 'symlink':
      return 2
  }
}

async function chmodIfPossible(path: string, mode: number | undefined): Promise<void> {
  if (mode === undefined) {
    return
  }

  try {
    await chmod(path, mode)
  } catch {
    // Some filesystems or platforms do not support chmod on every entry type.
  }
}

function relativeSnapshotPath(root: string, absolutePath: string): string {
  return absolutePath.slice(root.length + 1)
}

function isFileChangingToolUse(event: TranscriptRecord['event']): event is Extract<
  TranscriptRecord['event'],
  { type: 'tool_execution_start' }
> & {
  name: 'Write' | 'Edit'
  input: ToolUseBlock['input'] & { file_path: string }
} {
  return (
    event.type === 'tool_execution_start' &&
    (event.name === 'Write' || event.name === 'Edit') &&
    typeof event.input.file_path === 'string'
  )
}

async function changedWorktreeFiles(cwd: string, filePaths: string[]): Promise<string[]> {
  const uniquePaths = [...new Set(filePaths)].filter(Boolean)
  if (uniquePaths.length === 0) {
    return []
  }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', ...uniquePaths], {
      cwd,
    })
    return stdout
      .split(/\r?\n/)
      .map((line) => parsePorcelainPath(line))
      .filter((path): path is string => Boolean(path))
  } catch {
    return []
  }
}

function parsePorcelainPath(line: string): string | undefined {
  if (!line.trim()) {
    return undefined
  }

  const path = line.slice(3).trim()
  const renameSeparator = ' -> '
  return path.includes(renameSeparator)
    ? path.slice(path.lastIndexOf(renameSeparator) + renameSeparator.length)
    : path
}

function resolveInsideCwd(cwd: string, filePath: string): string {
  const root = resolve(cwd)
  const absolutePath = resolve(root, filePath)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`snapshot path is outside the current workspace: ${filePath}`)
  }

  return absolutePath
}

function normalizeIndex(value: unknown): SessionIndex {
  if (!isRecord(value)) {
    return { sessions: [] }
  }

  const sessions = Array.isArray(value.sessions) ? value.sessions.filter(isSessionMetadata) : []

  return {
    latestSessionId: typeof value.latestSessionId === 'string' ? value.latestSessionId : undefined,
    sessions,
  }
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.transcriptPath === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.promptCount === 'number'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

type UsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

const DEFAULT_TOKEN_BUDGET_LIMIT = 200_000

function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
}

function normalizeUsage(usage: Usage | undefined): UsageTotals {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
  }
}

function maxUsageTotals(base: UsageTotals, overlay: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(base.inputTokens, overlay.inputTokens),
    outputTokens: Math.max(base.outputTokens, overlay.outputTokens),
    cacheCreationInputTokens: Math.max(
      base.cacheCreationInputTokens,
      overlay.cacheCreationInputTokens,
    ),
    cacheReadInputTokens: Math.max(base.cacheReadInputTokens, overlay.cacheReadInputTokens),
  }
}

function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheCreationInputTokens += source.cacheCreationInputTokens
  target.cacheReadInputTokens += source.cacheReadInputTokens
}

function buildPromptCacheStats(usage: UsageTotals): PromptCacheStats {
  const totalInputTokens =
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
  const cacheableInputTokens = usage.cacheCreationInputTokens + usage.cacheReadInputTokens

  return {
    creationInputTokens: usage.cacheCreationInputTokens,
    readInputTokens: usage.cacheReadInputTokens,
    totalInputTokens,
    hitRate:
      cacheableInputTokens === 0
        ? 0
        : Number((usage.cacheReadInputTokens / cacheableInputTokens).toFixed(4)),
  }
}

function buildTokenBudgetStats(used: number, hasProviderUsage: boolean): TokenBudgetStats {
  const remaining = Math.max(0, DEFAULT_TOKEN_BUDGET_LIMIT - used)
  return {
    limit: DEFAULT_TOKEN_BUDGET_LIMIT,
    used,
    remaining,
    percentUsed: Number(((used / DEFAULT_TOKEN_BUDGET_LIMIT) * 100).toFixed(2)),
    source: hasProviderUsage ? 'provider-usage' : 'estimated',
  }
}

function buildTranscriptHydration(options: {
  records: TranscriptRecord[]
  messageCount: number
  toolUseCount: number
  toolResultCount: number
}): TranscriptHydration {
  return {
    status:
      options.records.length === 0
        ? 'empty'
        : options.toolResultCount < options.toolUseCount
          ? 'partial'
          : 'complete',
    messageCount: options.messageCount,
    toolUseCount: options.toolUseCount,
    toolResultCount: options.toolResultCount,
  }
}

type DraftContentBlock =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'thinking'
      thinking: string
      signature: string
    }
  | {
      type: 'image'
      source: ImageBlock['source']
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      inputJson: string
    }

function hydrateProviderMessages(records: TranscriptRecord[]): Message[] {
  const messages: Message[] = []
  const pendingToolResults: ToolResultBlock[] = []
  let assistant:
    | {
        id?: string
        blocks: Map<number, DraftContentBlock>
      }
    | undefined

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) {
      return
    }

    messages.push({
      role: 'user',
      content: pendingToolResults.splice(0),
    })
  }

  const flushAssistant = () => {
    if (!assistant) {
      return
    }

    const content = [...assistant.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => finalizeDraftBlock(block))
      .filter((block): block is ContentBlock => Boolean(block))

    if (content.length > 0) {
      messages.push({
        id: assistant.id,
        role: 'assistant',
        content,
      })
    }
    assistant = undefined
  }

  for (const record of records) {
    const event = record.event
    if (event.type === 'message_start') {
      flushAssistant()
      flushToolResults()
      assistant = {
        id: event.message.id,
        blocks: new Map(),
      }
      continue
    }

    if (event.type === 'content_block_start') {
      assistant ??= { blocks: new Map() }
      assistant.blocks.set(event.index, draftBlockFromContent(event.content_block))
      continue
    }

    if (event.type === 'content_block_delta') {
      assistant ??= { blocks: new Map() }
      const block = assistant.blocks.get(event.index) ?? {
        type: 'text',
        text: '',
      }

      if (event.delta.type === 'text_delta') {
        assistant.blocks.set(event.index, {
          type: 'text',
          text: block.type === 'text' ? `${block.text}${event.delta.text}` : event.delta.text,
        })
      } else if (event.delta.type === 'thinking_delta') {
        assistant.blocks.set(event.index, {
          type: 'thinking',
          thinking:
            block.type === 'thinking'
              ? `${block.thinking}${event.delta.thinking}`
              : event.delta.thinking,
          signature: block.type === 'thinking' ? block.signature : '',
        })
      } else if (event.delta.type === 'input_json_delta') {
        if (block.type === 'tool_use') {
          assistant.blocks.set(event.index, {
            ...block,
            inputJson: `${block.inputJson}${event.delta.partial_json}`,
          })
        }
      }
      continue
    }

    if (event.type === 'message_stop') {
      flushAssistant()
      continue
    }

    if (event.type === 'tool_execution_result') {
      pendingToolResults.push(toolExecutionResultToBlock(event))
    }
  }

  flushAssistant()
  flushToolResults()
  return messages
}

function draftBlockFromContent(block: ContentBlock): DraftContentBlock {
  if (block.type === 'text') {
    return {
      type: 'text',
      text: block.text,
    }
  }

  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: block.thinking,
      signature: block.signature,
    }
  }

  if (block.type === 'image') {
    return {
      type: 'image',
      source: block.source,
    }
  }

  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
      inputJson: '',
    }
  }

  return {
    type: 'text',
    text: Array.isArray(block.content)
      ? block.content.map((item) => item.text).join('')
      : (block.content ?? ''),
  }
}

function finalizeDraftBlock(block: DraftContentBlock): ContentBlock | undefined {
  if (block.type === 'text') {
    return block.text ? { type: 'text', text: block.text } : undefined
  }

  if (block.type === 'thinking') {
    return block.thinking
      ? {
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        }
      : undefined
  }

  if (block.type === 'image') {
    return {
      type: 'image',
      source: block.source,
    }
  }

  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: block.inputJson ? parseToolInput(block.inputJson, block.input) : block.input,
  }
}

function parseToolInput(json: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback
  } catch {
    return fallback
  }
}

function toolExecutionResultToBlock(
  event: Extract<TranscriptRecord['event'], { type: 'tool_execution_result' }>,
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: event.tool_use_id,
    content: event.content,
    is_error: event.is_error,
  }
}

function buildProviderMessageHydration(options: {
  replayedRecordCount: number
  providerMessages: Message[]
  providerCacheBreaks: ProviderCacheBreak[]
}): ProviderMessageHydration {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  let assistantMessageCount = 0
  let userToolResultMessageCount = 0
  let toolUseBlockCount = 0
  let toolResultBlockCount = 0

  for (const message of options.providerMessages) {
    if (message.role === 'assistant') {
      assistantMessageCount += 1
    }

    const content = Array.isArray(message.content) ? message.content : []
    if (message.role === 'user' && content.some((block) => block.type === 'tool_result')) {
      userToolResultMessageCount += 1
    }

    for (const block of content) {
      if (block.type === 'tool_use') {
        toolUseIds.add(block.id)
        toolUseBlockCount += 1
      }
      if (block.type === 'tool_result') {
        toolResultIds.add(block.tool_use_id)
        toolResultBlockCount += 1
      }
    }
  }

  const unpairedToolResultCount = [...toolResultIds].filter((id) => !toolUseIds.has(id)).length
  const unpairedToolResultIds = [...toolResultIds].filter((id) => !toolUseIds.has(id))
  const unpairedToolResultReasons = Object.fromEntries(
    unpairedToolResultIds.map((id) => [
      id,
      options.providerCacheBreaks.length > 0
        ? 'missing tool_use in replayed provider messages after cache/compact boundary'
        : 'missing tool_use in replayed provider messages',
    ]),
  )
  const pairedToolResultCount = [...toolResultIds].filter((id) => toolUseIds.has(id)).length

  return {
    status:
      options.providerMessages.length === 0
        ? 'empty'
        : unpairedToolResultCount > 0
          ? 'partial'
          : 'complete',
    messageCount: options.providerMessages.length,
    replayedRecordCount: options.replayedRecordCount,
    assistantMessageCount,
    userToolResultMessageCount,
    toolUseBlockCount,
    toolResultBlockCount,
    pairedToolResultCount,
    unpairedToolResultCount,
    unpairedToolResultIds,
    unpairedToolResultReasons,
  }
}

function detectProviderCacheBreaks(records: TranscriptRecord[]): ProviderCacheBreak[] {
  const breaks: ProviderCacheBreak[] = []
  let previousCacheReadInputTokens = 0
  let previousPromptStateHash: string | undefined

  for (const record of records) {
    const event = record.event
    const usage = usageForCacheBreakRecord(record)
    const compactBoundary = isCompactBoundaryRecord(record)
    if (compactBoundary && previousCacheReadInputTokens > 0) {
      breaks.push({
        recordId: record.id,
        reason: 'compact_boundary',
        previousCacheReadInputTokens,
        cacheReadInputTokens: 0,
        previousPromptStateHash,
        promptStateHash: record.promptStateHash,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      })
      previousCacheReadInputTokens = 0
      continue
    }

    if (
      event.type === 'message_delta' &&
      event.delta.stop_reason === 'model_context_window_exceeded'
    ) {
      const cacheReadInputTokens = event.usage?.cache_read_input_tokens ?? 0
      breaks.push({
        recordId: record.id,
        reason: 'context_window_exceeded',
        previousCacheReadInputTokens,
        cacheReadInputTokens,
        previousPromptStateHash,
        promptStateHash: record.promptStateHash,
        cacheCreationInputTokens: event.usage?.cache_creation_input_tokens,
      })
      previousCacheReadInputTokens = cacheReadInputTokens
      continue
    }

    const cacheReadInputTokens = usage?.cache_read_input_tokens

    const promptStateChanged =
      record.promptStateHash &&
      previousPromptStateHash &&
      record.promptStateHash !== previousPromptStateHash
    if (promptStateChanged) {
      breaks.push({
        recordId: record.id,
        reason: 'prompt_state_changed',
        previousCacheReadInputTokens,
        cacheReadInputTokens: cacheReadInputTokens ?? previousCacheReadInputTokens,
        previousPromptStateHash,
        promptStateHash: record.promptStateHash,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      })
    }

    if (cacheReadInputTokens === undefined) {
      if (record.promptStateHash) {
        previousPromptStateHash = record.promptStateHash
      }
      continue
    }

    if (!promptStateChanged && previousCacheReadInputTokens > 0 && cacheReadInputTokens === 0) {
      breaks.push({
        recordId: record.id,
        reason: 'cache_read_dropped',
        previousCacheReadInputTokens,
        cacheReadInputTokens,
        previousPromptStateHash,
        promptStateHash: record.promptStateHash,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      })
    }

    previousCacheReadInputTokens = cacheReadInputTokens
    if (record.promptStateHash) {
      previousPromptStateHash = record.promptStateHash
    }
  }

  return breaks
}

function usageForCacheBreakRecord(record: TranscriptRecord): Usage | undefined {
  const event = record.event
  return event.type === 'message_start'
    ? event.message.usage
    : event.type === 'message_delta'
      ? event.usage
      : undefined
}

function restoreCompactState(records: TranscriptRecord[]): CompactStateRestoration {
  let boundaryIndex = -1
  let summaryRecordId: string | undefined
  let summaryChars = 0

  for (const [index, record] of records.entries()) {
    if (isCompactBoundaryRecord(record)) {
      boundaryIndex = index
    }

    const compactSummary = compactSummaryText(record)
    if (compactSummary) {
      summaryRecordId = record.id
      summaryChars += compactSummary.length
    }
  }

  if (boundaryIndex === -1) {
    return {
      status: 'empty',
      compactedRecordCount: 0,
      replayableRecordCount: records.length,
      summaryChars,
    }
  }

  return {
    status: summaryChars > 0 ? 'restored' : 'inferred',
    boundaryRecordId: records[boundaryIndex]?.id,
    summaryRecordId,
    compactedRecordCount: boundaryIndex + 1,
    replayableRecordCount: records.length - boundaryIndex - 1,
    summaryChars,
  }
}

function recordsAfterCompactBoundary(
  records: TranscriptRecord[],
  compactState: CompactStateRestoration,
): TranscriptRecord[] {
  if (!compactState.boundaryRecordId) {
    return records
  }

  const boundaryIndex = records.findIndex((record) => record.id === compactState.boundaryRecordId)
  const replayRecords = boundaryIndex === -1 ? records : records.slice(boundaryIndex + 1)
  return replayRecords.filter((record) => !compactSummaryText(record))
}

function compactSummaryForState(
  records: TranscriptRecord[],
  compactState: CompactStateRestoration,
): string {
  if (!compactState.summaryRecordId) {
    return ''
  }

  const summaryRecord = records.find((record) => record.id === compactState.summaryRecordId)
  return summaryRecord ? compactSummaryText(summaryRecord) : ''
}

function isCompactBoundaryRecord(record: TranscriptRecord): boolean {
  if (record.compact?.boundary) {
    return true
  }

  const event = record.event
  if (
    event.type === 'message_delta' &&
    event.delta.stop_reason === 'model_context_window_exceeded'
  ) {
    return true
  }

  if (event.type !== 'terminal') {
    return false
  }

  return [event.reason, event.stdout, event.stderr].some((value) =>
    /\b(compact|compacted|compaction|context summary)\b/i.test(value ?? ''),
  )
}

function compactSummaryText(record: TranscriptRecord): string {
  if (record.compact?.summary) {
    return record.compact.summary
  }

  const event = record.event
  if (event.type === 'terminal') {
    const text = [event.reason, event.stdout, event.stderr].filter(Boolean).join('\n')
    return /\b(compact|context summary)\b/i.test(text) ? text : ''
  }

  if (
    event.type === 'content_block_delta' &&
    event.delta.type === 'text_delta' &&
    /\b(compact summary|context summary|<compact)/i.test(event.delta.text)
  ) {
    return event.delta.text
  }

  return ''
}

async function buildFileSnapshotCoverage(options: {
  cwd: string
  sessionId: string
  changedToolUseIds: Set<string>
}): Promise<FileSnapshotCoverage> {
  const snapshots = await listFileSnapshots(options.cwd, options.sessionId)
  const snapshotToolUseIds = new Set(snapshots.map((snapshot) => snapshot.tool_use_id))
  const available = [...options.changedToolUseIds].filter((toolUseId) =>
    snapshotToolUseIds.has(toolUseId),
  ).length

  return {
    changed: options.changedToolUseIds.size,
    available,
    missing: options.changedToolUseIds.size - available,
  }
}

function buildRestoreGaps(options: {
  missingParentSessionIds: string[]
  fileSnapshotCoverage: FileSnapshotCoverage
  providerMessageHydration: ProviderMessageHydration
  providerCacheBreaks: ProviderCacheBreak[]
  compactState: CompactStateRestoration
}): string[] {
  return [
    options.compactState.status === 'inferred'
      ? 'compact state inferred without summary'
      : undefined,
    options.providerMessageHydration.status === 'partial'
      ? 'provider message hydration is partial'
      : undefined,
    options.providerCacheBreaks.length > 0
      ? `provider cache breaks detected: ${options.providerCacheBreaks.length}`
      : undefined,
    options.missingParentSessionIds.length > 0
      ? `missing parent sessions: ${options.missingParentSessionIds.join(', ')}`
      : undefined,
    options.fileSnapshotCoverage.missing > 0
      ? `missing file snapshots: ${options.fileSnapshotCoverage.missing}`
      : undefined,
  ].filter((gap): gap is string => Boolean(gap))
}

async function collectParentSessionIds(session: SessionMetadata): Promise<{
  parentSessionIds: string[]
  missingParentSessionIds: string[]
}> {
  const parentSessionIds: string[] = []
  const missingParentSessionIds: string[] = []
  const index = await readSessionIndex(session.cwd)
  const sessionById = new Map(index.sessions.map((candidate) => [candidate.id, candidate]))
  const seen = new Set([session.id])
  let parentSessionId = session.parentSessionId

  while (parentSessionId && !seen.has(parentSessionId)) {
    parentSessionIds.push(parentSessionId)
    seen.add(parentSessionId)

    const parent = sessionById.get(parentSessionId)
    if (!parent) {
      missingParentSessionIds.push(parentSessionId)
      break
    }

    parentSessionId = parent.parentSessionId
  }

  return { parentSessionIds, missingParentSessionIds }
}
