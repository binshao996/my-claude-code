import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { QueryEvent, ToolExecutionEvent, TranscriptRecord } from '@my-claude-code/core'
import { buildRuntimeContext } from '@my-claude-code/agent-runtime'
import {
  buildSessionGraph,
  forkSession,
  recordFileSnapshot,
  recordSession,
  replaySession,
  rewindFilesToCheckpoint,
  sessionTranscriptPath,
} from '@my-claude-code/session'
import {
  extractMemories,
  rankMemoryStoreEntries,
  readSessionMemory,
  syncTeamMemory,
  writeSessionMemorySnapshot,
} from '@my-claude-code/tools'

type SessionMemoryGolden = {
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

const fixturePath = 'docs/refactor/golden/runtime/r1.7-session-context-memory-golden.json'
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as SessionMemoryGolden
const failures: GoldenFailure[] = []
const cwd = mkdtempSync(join(tmpdir(), 'r1-7-session-memory-'))
const now = new Date('2026-05-25T00:00:00.000Z')

try {
  const setup = await setupWorkspace(cwd)
  for (const testCase of fixture.cases) {
    try {
      switch (testCase.name) {
        case 'transcript-resume-graph':
          await verifyTranscriptResumeGraph(setup, testCase.expect)
          break
        case 'fork-rewind-restore-plan':
          await verifyForkRewindRestorePlan(setup, testCase.expect)
          break
        case 'file-snapshot-coverage':
          await verifyFileSnapshotCoverage(setup, testCase.expect)
          break
        case 'context-request':
          await verifyContextRequest(setup, testCase.expect)
          break
        case 'memory-ranking':
          await verifyMemoryRanking(setup, testCase.expect)
          break
        case 'provider-cache-break':
          await verifyProviderCacheBreak(setup, testCase.expect)
          break
        default:
          failures.push({
            caseName: testCase.name,
            reason: 'unknown R1.7 golden case',
          })
      }
    } catch (error) {
      failures.push({
        caseName: testCase.name,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
} finally {
  rmSync(cwd, { recursive: true, force: true })
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

async function setupWorkspace(root: string) {
  await mkdir(join(root, '.claude'), { recursive: true })
  await mkdir(join(root, 'extra'), { recursive: true })
  await mkdir(join(root, '.my-claude-code', 'local-memory', 'project'), { recursive: true })
  await mkdir(join(root, '.my-claude-code', 'teams'), { recursive: true })

  await writeFile(join(root, 'CLAUDE.md'), 'Project memory mentions Alice and runtime context.\n', 'utf8')
  await writeFile(join(root, 'extra', 'CLAUDE.md'), 'Additional directory memory is restored.\n', 'utf8')
  await writeFile(
    join(root, '.my-claude-code', 'local-memory', 'project', 'alice.md'),
    'Alice owns the transcript graph and memory ranking fixture.\n',
    'utf8',
  )
  await writeFile(
    join(root, '.my-claude-code', 'teams', 'current.json'),
    `${JSON.stringify({ teamName: 'alpha' })}\n`,
    'utf8',
  )
  await writeFile(
    join(root, '.my-claude-code', 'teams', 'events.json'),
    `${JSON.stringify([{ teamName: 'alpha', type: 'note', status: 'done', summary: 'team memory event' }])}\n`,
    'utf8',
  )

  const sessionId = 'session_parent'
  const transcriptPath = sessionTranscriptPath(root, sessionId)
  await recordSession({
    cwd: root,
    sessionId,
    transcriptPath,
    prompt: 'remember Alice and read notes',
    model: 'claude-3-5-sonnet-latest',
    additionalDirectories: ['extra'],
    now,
  })

  await writeFile(join(root, 'notes.txt'), 'before\n', 'utf8')
  await recordFileSnapshot({
    cwd: root,
    sessionId,
    toolUseId: 'toolu_write',
    toolName: 'Write',
    filePath: 'notes.txt',
    now,
  })
  await writeFile(join(root, 'notes.txt'), 'after\n', 'utf8')

  const records = transcriptRecords(sessionId)
  await writeTranscript(transcriptPath, records)
  const fork = await forkSession({
    cwd: root,
    sourceSessionId: sessionId,
    newSessionId: 'session_child',
    truncateAfterRecordId: 'rec_tool_result',
    mode: 'rewind',
    now,
  })
  if (!fork) {
    throw new Error('failed to create fork session')
  }

  await writeSessionMemorySnapshot(root, {
    sessionId,
    summary: 'session summary',
    providerCacheBreaks: [{ recordId: 'rec_msg2', reason: 'cache_read_dropped' }],
  })
  const teamSync = await syncTeamMemory(root, 'alpha')

  return {
    cwd: root,
    sessionId,
    transcriptPath,
    forkSessionId: fork.id,
    teamSync,
  }
}

async function verifyTranscriptResumeGraph(
  setup: Awaited<ReturnType<typeof setupWorkspace>>,
  expect: Record<string, unknown>,
): Promise<void> {
  const graph = await buildSessionGraph(setup.cwd)
  const fork = graph.nodes.find(node => node.id === setup.forkSessionId)
  const replay = await replaySession(fork ?? fail('missing fork graph node'))
  assertEqual(replay.restorePlan.graphRestored, expect.graphRestored, 'graphRestored')
  assertEqual(replay.restorePlan.branchDepth, expect.branchDepth, 'branchDepth')
  assertJsonEqual(replay.restorePlan.parentSessionIds, expect.parentSessionIds, 'parentSessionIds')
  assertEqual(
    replay.restorePlan.transcriptHydration.status,
    expect.transcriptHydration,
    'transcriptHydration',
  )
  assertAtLeast(replay.providerMessages.length, Number(expect.providerMessagesAtLeast), 'providerMessages')
}

async function verifyForkRewindRestorePlan(
  setup: Awaited<ReturnType<typeof setupWorkspace>>,
  expect: Record<string, unknown>,
): Promise<void> {
  const graph = await buildSessionGraph(setup.cwd)
  const fork = graph.nodes.find(node => node.id === setup.forkSessionId) ?? fail('missing fork')
  const replay = await replaySession(fork)
  assertEqual(fork.forkReason, expect.forkReason, 'forkReason')
  assertEqual(fork.rewindRecordId, expect.rewindRecordId, 'rewindRecordId')
  assertEqual(replay.restorePlan.replayedRecordCount, expect.replayedRecordCount, 'replayedRecordCount')
  assertEqual(
    replay.restorePlan.additionalDirectoriesRestored,
    expect.additionalDirectoriesRestored,
    'additionalDirectoriesRestored',
  )
}

async function verifyFileSnapshotCoverage(
  setup: Awaited<ReturnType<typeof setupWorkspace>>,
  expect: Record<string, unknown>,
): Promise<void> {
  const session = (await buildSessionGraph(setup.cwd)).nodes.find(node => node.id === setup.sessionId) ??
    fail('missing parent session')
  const replay = await replaySession(session)
  assertEqual(replay.restorePlan.fileSnapshotCoverage.changed, expect.changed, 'changed')
  assertEqual(replay.restorePlan.fileSnapshotCoverage.available, expect.available, 'available')
  assertEqual(replay.restorePlan.fileSnapshotCoverage.missing, expect.missing, 'missing')
  const rewind = await rewindFilesToCheckpoint({
    cwd: setup.cwd,
    session,
    checkpointRecordId: 'rec_msg2',
  })
  assertJsonEqual(rewind.restoredFiles, expect.restoredFiles, 'restoredFiles')
}

async function verifyContextRequest(
  setup: Awaited<ReturnType<typeof setupWorkspace>>,
  expect: Record<string, unknown>,
): Promise<void> {
  const context = await buildRuntimeContext({
    cwd: setup.cwd,
    systemPrompt: 'system',
    sessionId: setup.sessionId,
    prompt: 'Alice runtime context',
    additionalDirectories: ['extra'],
    providerCacheBreaks: [{ recordId: 'rec_msg2', reason: 'cache_read_dropped' }],
    includeGitStatus: false,
    now,
  })
  assertEqual(context.memoryFiles.some(file => file.path.endsWith('CLAUDE.md')), expect.hasProjectMemory, 'hasProjectMemory')
  assertEqual(context.systemContent.includes('extra'), expect.hasAdditionalDirectory, 'hasAdditionalDirectory')
  assertEqual(context.providerCacheBreaks.length > 0, expect.hasCacheBreak, 'hasCacheBreak')
  assertAtLeast(context.sections.length, Number(expect.sectionCountAtLeast), 'sectionCount')
}

async function verifyMemoryRanking(
  setup: Awaited<ReturnType<typeof setupWorkspace>>,
  expect: Record<string, unknown>,
): Promise<void> {
  const ranking = await rankMemoryStoreEntries(setup.cwd, 'Alice transcript graph')
  assertEqual(ranking.entries[0]?.store, expect.topStore, 'topStore')
  assertEqual(ranking.entries[0]?.key, expect.topKey, 'topKey')
  const extracted = await extractMemories(setup.cwd, {
    text: 'Alice prefers deterministic transcript graph tests.',
    store: 'project',
  })
  assertAtLeast(extracted.length, Number(expect.extractedAtLeast), 'extractedAtLeast')
  const sessionMemory = await readSessionMemory(setup.cwd, setup.sessionId)
  assertEqual(sessionMemory?.summary, expect.sessionMemory, 'sessionMemory')
  assertEqual(setup.teamSync.sourceEventCount, expect.teamEventCount, 'teamEventCount')
}

async function verifyProviderCacheBreak(
  setup: Awaited<ReturnType<typeof setupWorkspace>>,
  expect: Record<string, unknown>,
): Promise<void> {
  const session = (await buildSessionGraph(setup.cwd)).nodes.find(node => node.id === setup.sessionId) ??
    fail('missing parent session')
  const replay = await replaySession(session)
  const cacheBreak = replay.restorePlan.providerCacheBreaks.find(item => item.reason === expect.reason)
  if (!cacheBreak) {
    throw new Error(`missing cache break: ${String(expect.reason)}`)
  }
  assertEqual(cacheBreak.previousCacheReadInputTokens, expect.previousCacheReadInputTokens, 'previousCacheReadInputTokens')
  assertEqual(cacheBreak.cacheReadInputTokens, expect.cacheReadInputTokens, 'cacheReadInputTokens')
}

function transcriptRecords(sessionId: string): TranscriptRecord[] {
  return [
    record('rec_msg1', sessionId, messageStart({ cache_read_input_tokens: 12 }), 'u1', undefined, 'state-a'),
    record('rec_tool_block', sessionId, toolUseStart('toolu_read', 'Read', { file_path: 'notes.txt' }), 'u2', 'u1'),
    record('rec_tool_delta', sessionId, inputJsonDelta('{"file_path":"notes.txt"}'), 'u3', 'u2'),
    record('rec_tool_block_stop', sessionId, contentBlockStop(), 'u4', 'u3'),
    record('rec_tool_message_delta', sessionId, messageDelta('tool_use'), 'u5', 'u4'),
    record('rec_tool_message_stop', sessionId, messageStop(), 'u6', 'u5'),
    record('rec_tool_start', sessionId, toolExecutionStart('toolu_read', 'Read', { file_path: 'notes.txt' }), 'u7', 'u6'),
    record('rec_tool_result', sessionId, toolExecutionResult('toolu_read', 'Read', 'before'), 'u8', 'u7'),
    record('rec_msg2', sessionId, messageStart({ cache_read_input_tokens: 0 }), 'u9', 'u8', 'state-a'),
    record('rec_text', sessionId, textDelta('assistant says hello'), 'u10', 'u9'),
    record('rec_msg_delta_end', sessionId, messageDelta('end_turn'), 'u11', 'u10'),
    record('rec_stop', sessionId, messageStop(), 'u12', 'u11'),
    record('rec_write_start', sessionId, toolExecutionStart('toolu_write', 'Write', { file_path: 'notes.txt' }), 'u13', 'u12'),
    record('rec_write_result', sessionId, toolExecutionResult('toolu_write', 'Write', 'wrote notes.txt'), 'u14', 'u13'),
  ]
}

function record(
  id: string,
  sessionId: string,
  event: TranscriptRecord['event'],
  uuid: string,
  parentUuid?: string,
  promptStateHash?: string,
): TranscriptRecord {
  return {
    id,
    session_id: sessionId,
    created_at: now.toISOString(),
    event,
    uuid,
    parentUuid,
    promptStateHash,
  }
}

async function writeTranscript(path: string, records: TranscriptRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${records.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')
}

function messageStart(usage: { cache_read_input_tokens?: number }): QueryEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg',
      role: 'assistant',
      model: 'claude-3-5-sonnet-latest',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        ...usage,
      },
    },
  }
}

function toolUseStart(id: string, name: string, input: Record<string, unknown>): QueryEvent {
  return {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id,
      name,
      input,
    },
  }
}

function inputJsonDelta(partialJson: string): QueryEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: partialJson,
    },
  }
}

function contentBlockStop(): QueryEvent {
  return {
    type: 'content_block_stop',
    index: 0,
  }
}

function messageDelta(stopReason: 'tool_use' | 'end_turn'): QueryEvent {
  return {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
  }
}

function messageStop(): QueryEvent {
  return { type: 'message_stop' }
}

function textDelta(text: string): QueryEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'text_delta',
      text,
    },
  }
}

function toolExecutionStart(
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): ToolExecutionEvent {
  return {
    type: 'tool_execution_start',
    tool_use_id: toolUseId,
    name,
    input,
  }
}

function toolExecutionResult(
  toolUseId: string,
  name: string,
  content: string,
): ToolExecutionEvent {
  return {
    type: 'tool_execution_result',
    tool_use_id: toolUseId,
    name,
    content,
    is_error: false,
  }
}

function assertEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assertAtLeast(actual: number, expected: number, field: string): void {
  if (actual < expected) {
    throw new Error(`${field}: expected at least ${expected}, got ${actual}`)
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, field: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${field}: expected ${expectedJson}, got ${actualJson}`)
  }
}

function fail(message: string): never {
  throw new Error(message)
}
