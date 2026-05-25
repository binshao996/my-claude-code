import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  buildSessionGraph,
  forkSession,
  listFileSnapshots,
  listSessionCheckpoints,
  listSessions,
  recordFileSnapshot,
  recordSession,
  replaySession,
  rewindFilesToCheckpoint,
  resolveLatestSession,
  sessionIndexPath,
} from './sessionStore.js'

describe('session store', () => {
  it('records latest session metadata', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))

    try {
      const session = await recordSession({
        cwd,
        sessionId: 'session_1',
        transcriptPath: join(cwd, 'transcript.jsonl'),
        prompt: 'hello',
        model: 'deepseek-v4-flash',
      })

      expect(session.promptCount).toBe(1)
      await recordSession({
        cwd,
        sessionId: 'session_1',
        transcriptPath: join(cwd, 'transcript.jsonl'),
        prompt: 'again',
      })

      await expect(resolveLatestSession(cwd)).resolves.toMatchObject({
        id: 'session_1',
        promptCount: 2,
        lastPrompt: 'again',
      })
      await expect(listSessions(cwd)).resolves.toHaveLength(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('replays transcript into a compact resume context', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    writeFileSync(
      transcriptPath,
      [
        record({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'assistant text' },
        }),
        record({
          type: 'tool_execution_start',
          tool_use_id: 'toolu_1',
          name: 'Read',
          input: { file_path: 'README.md' },
        }),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'read',
      })
      const replay = await replaySession(session)

      expect(replay.summary).toContain('assistant text')
      expect(replay.readFiles).toEqual(['README.md'])
      expect(replay.stats.toolUseCount).toBe(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('summarizes provider usage, prompt cache, token budget, and restore gaps', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    writeFileSync(
      transcriptPath,
      [
        record({
          type: 'message_start',
          message: {
            id: 'msg_1',
            role: 'assistant',
            model: 'deepseek-v4-flash',
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
            },
          },
        }),
        record({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'cached response' },
        }),
        record({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        }),
        record({ type: 'message_stop' }),
        record({
          type: 'tool_execution_result',
          tool_use_id: 'toolu_edit',
          name: 'Edit',
          content: 'updated',
          is_error: false,
        }),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'continue',
      })
      const replay = await replaySession(session)

      expect(replay.stats).toMatchObject({
        estimatedTokens: 200,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 200,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 30,
        promptCache: {
          creationInputTokens: 20,
          readInputTokens: 30,
          totalInputTokens: 150,
          hitRate: 0.6,
        },
        tokenBudget: {
          used: 200,
          remaining: 199800,
          source: 'provider-usage',
        },
      })
      expect(replay.restorePlan).toMatchObject({
        graphRestored: false,
        replayedRecordCount: 5,
        fileMutationCount: 1,
      })
      expect(replay.providerMessages).toEqual([
        {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'text', text: 'cached response' }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_edit',
              content: 'updated',
              is_error: false,
            },
          ],
        },
      ])
      expect(replay.restorePlan.providerMessageHydration).toMatchObject({
        status: 'partial',
        messageCount: 2,
        assistantMessageCount: 1,
        userToolResultMessageCount: 1,
        toolResultBlockCount: 1,
        unpairedToolResultCount: 1,
      })
      expect(replay.restorePlan.remainingGaps).toContain('provider message hydration is partial')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('forks and rewinds sessions by copying transcript records', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    const firstRecord = record(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'first' },
      },
      'record_first',
    )
    const secondRecord = record(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' second' },
      },
      'record_second',
    )
    writeFileSync(transcriptPath, `${firstRecord}${secondRecord}`, 'utf8')

    try {
      await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'start',
      })

      const fork = await forkSession({
        cwd,
        sourceSessionId: 's1',
        newSessionId: 's1_fork',
        now: new Date('2026-05-23T00:00:00.000Z'),
      })
      const rewind = await forkSession({
        cwd,
        sourceSessionId: 's1',
        newSessionId: 's1_rewind',
        truncateAfterRecordId: 'record_first',
        mode: 'rewind',
        now: new Date('2026-05-23T00:01:00.000Z'),
      })

      expect(fork).toMatchObject({
        id: 's1_fork',
        parentSessionId: 's1',
        forkReason: 'fork',
      })
      expect(rewind).toMatchObject({
        id: 's1_rewind',
        parentSessionId: 's1',
        forkReason: 'rewind',
        rewindRecordId: 'record_first',
      })
      if (!fork || !rewind) {
        throw new Error('expected fork and rewind sessions')
      }

      await expect(replaySession(fork)).resolves.toMatchObject({
        stats: { eventCount: 2 },
      })
      await expect(replaySession(rewind)).resolves.toMatchObject({
        stats: { eventCount: 1 },
      })
      expect((await listSessions(cwd))[0]?.id).toBe('s1_rewind')
      expect(await buildSessionGraph(cwd)).toMatchObject({
        latestSessionId: 's1_rewind',
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 's1',
            childrenIds: expect.arrayContaining(['s1_fork', 's1_rewind']),
            depth: 0,
          }),
          expect.objectContaining({
            id: 's1_rewind',
            parentSessionId: 's1',
            depth: 1,
          }),
        ]),
      })
      expect(await listSessionCheckpoints(fork, 1)).toEqual([
        expect.objectContaining({
          recordId: 'record_second',
          eventType: 'content_block_delta',
        }),
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports multi-level fork and rewind lineage in restore plans', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    const firstRecord = record(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'first' },
      },
      'lineage_first',
    )
    const secondRecord = record(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' second' },
      },
      'lineage_second',
    )
    writeFileSync(transcriptPath, `${firstRecord}${secondRecord}`, 'utf8')

    try {
      await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'start',
      })
      const fork = await forkSession({
        cwd,
        sourceSessionId: 's1',
        newSessionId: 's1_fork',
      })
      const rewind = await forkSession({
        cwd,
        sourceSessionId: 's1_fork',
        newSessionId: 's1_fork_rewind',
        truncateAfterRecordId: 'lineage_first',
        mode: 'rewind',
      })

      if (!fork || !rewind) {
        throw new Error('expected fork and rewind sessions')
      }

      await expect(replaySession(rewind)).resolves.toMatchObject({
        restorePlan: {
          graphRestored: true,
          parentSessionIds: ['s1_fork', 's1'],
          lineageSessionIds: ['s1_fork', 's1'],
          missingParentSessionIds: [],
          branchDepth: 2,
          replayedRecordCount: 1,
        },
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records missing parent ids in restore plans', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 'child.jsonl')
    writeFileSync(transcriptPath, record({ type: 'message_stop' }, 'child_stop'), 'utf8')

    try {
      const session = {
        id: 'child',
        cwd,
        transcriptPath,
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        promptCount: 1,
        parentSessionId: 'missing_parent',
      }
      mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
      writeFileSync(
        sessionIndexPath(cwd),
        `${JSON.stringify({ latestSessionId: 'child', sessions: [session] })}\n`,
        'utf8',
      )

      const replay = await replaySession(session)

      expect(replay.restorePlan).toMatchObject({
        graphRestored: false,
        parentSessionIds: ['missing_parent'],
        lineageSessionIds: ['missing_parent'],
        missingParentSessionIds: ['missing_parent'],
        branchDepth: 1,
      })
      expect(replay.restorePlan.remainingGaps).toContain('missing parent sessions: missing_parent')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports file snapshot coverage for changed tool uses', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    const trackedPath = join(cwd, 'tracked.txt')
    writeFileSync(trackedPath, 'before', 'utf8')
    writeFileSync(
      transcriptPath,
      [
        record(
          {
            type: 'tool_execution_start',
            tool_use_id: 'toolu_write',
            name: 'Write',
            input: { file_path: 'tracked.txt' },
          },
          'write_start',
        ),
        record(
          {
            type: 'tool_execution_start',
            tool_use_id: 'toolu_edit',
            name: 'Edit',
            input: { file_path: 'missing-snapshot.txt' },
          },
          'edit_start',
        ),
        record(
          {
            type: 'tool_execution_start',
            tool_use_id: 'toolu_read',
            name: 'Read',
            input: { file_path: 'README.md' },
          },
          'read_start',
        ),
        record(
          {
            type: 'tool_execution_result',
            tool_use_id: 'toolu_write',
            name: 'Write',
            content: 'updated',
            is_error: false,
          },
          'write_result',
        ),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'edit',
        additionalDirectories: [join(cwd, 'extra')],
      })
      await recordFileSnapshot({
        cwd,
        sessionId: 's1',
        toolUseId: 'toolu_write',
        toolName: 'Write',
        filePath: 'tracked.txt',
      })

      const replay = await replaySession(session)

      expect(replay.restorePlan).toMatchObject({
        fileMutationCount: 1,
        transcriptHydration: {
          status: 'partial',
          messageCount: 0,
          toolUseCount: 3,
          toolResultCount: 1,
        },
        fileSnapshotCoverage: {
          changed: 2,
          available: 1,
          missing: 1,
        },
        additionalDirectoriesRestored: true,
      })
      expect(replay.restorePlan.remainingGaps).toContain('missing file snapshots: 1')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('hydrates provider messages with tool use and result blocks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    writeFileSync(
      transcriptPath,
      [
        record(
          {
            type: 'message_start',
            message: {
              id: 'msg_tool',
              role: 'assistant',
              model: 'deepseek-v4-flash',
              usage: {
                input_tokens: 10,
                output_tokens: 0,
                cache_read_input_tokens: 8,
              },
            },
          },
          'msg_tool_start',
        ),
        record(
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_read',
              name: 'Read',
              input: {},
            },
          },
          'tool_block_start',
        ),
        record(
          {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"file_path":"README.md"}',
            },
          },
          'tool_block_delta',
        ),
        record({ type: 'content_block_stop', index: 0 }, 'tool_block_stop'),
        record({ type: 'message_stop' }, 'msg_tool_stop'),
        record(
          {
            type: 'tool_execution_result',
            tool_use_id: 'toolu_read',
            name: 'Read',
            content: 'read result',
            is_error: false,
          },
          'tool_result',
        ),
        record(
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              input_tokens: 20,
              output_tokens: 5,
              cache_read_input_tokens: 0,
            },
          },
          'cache_break',
        ),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'read',
      })
      const replay = await replaySession(session)

      expect(replay.providerMessages).toEqual([
        {
          id: 'msg_tool',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read',
              content: 'read result',
              is_error: false,
            },
          ],
        },
      ])
      expect(replay.restorePlan.providerMessageHydration).toMatchObject({
        status: 'complete',
        messageCount: 2,
        toolUseBlockCount: 1,
        toolResultBlockCount: 1,
        unpairedToolResultCount: 0,
      })
      expect(replay.restorePlan.providerCacheBreaks).toEqual([
        {
          recordId: 'cache_break',
          reason: 'cache_read_dropped',
          previousCacheReadInputTokens: 8,
          cacheReadInputTokens: 0,
        },
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('groups tool results and reports compact/cache restoration state', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    writeFileSync(
      transcriptPath,
      [
        record(
          {
            type: 'message_start',
            message: {
              id: 'msg_before_compact',
              role: 'assistant',
              usage: {
                input_tokens: 8,
                output_tokens: 1,
                cache_read_input_tokens: 12,
              },
            },
          },
          'msg_before_compact_start',
        ),
        record({ type: 'message_stop' }, 'msg_before_compact_stop'),
        record(
          {
            type: 'terminal',
            status: 'completed',
            exitCode: 0,
            reason: 'compact summary restored',
            stdout: 'Context summary: prior work compressed',
          },
          'compact_boundary',
        ),
        record(
          {
            type: 'message_start',
            message: {
              id: 'msg_tools',
              role: 'assistant',
              usage: {
                input_tokens: 10,
                output_tokens: 1,
                cache_read_input_tokens: 0,
              },
            },
          },
          'msg_tools_start',
        ),
        record(
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_a',
              name: 'Read',
              input: { file_path: 'a.txt' },
            },
          },
          'tool_a_start',
        ),
        record(
          {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'toolu_b',
              name: 'Read',
              input: { file_path: 'b.txt' },
            },
          },
          'tool_b_start',
        ),
        record({ type: 'message_stop' }, 'msg_tools_stop'),
        record(
          {
            type: 'tool_execution_result',
            tool_use_id: 'toolu_a',
            name: 'Read',
            content: 'a result',
            is_error: false,
          },
          'tool_a_result',
        ),
        record(
          {
            type: 'tool_execution_result',
            tool_use_id: 'toolu_b',
            name: 'Read',
            content: 'b result',
            is_error: false,
          },
          'tool_b_result',
        ),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'continue',
      })
      const replay = await replaySession(session)

      expect(replay.providerMessages).toEqual([
        {
          id: 'msg_tools',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_a',
              name: 'Read',
              input: { file_path: 'a.txt' },
            },
            {
              type: 'tool_use',
              id: 'toolu_b',
              name: 'Read',
              input: { file_path: 'b.txt' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_a',
              content: 'a result',
              is_error: false,
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_b',
              content: 'b result',
              is_error: false,
            },
          ],
        },
      ])
      expect(replay.restorePlan.providerMessageHydration).toMatchObject({
        status: 'complete',
        replayedRecordCount: 6,
        userToolResultMessageCount: 1,
        toolUseBlockCount: 2,
        toolResultBlockCount: 2,
        pairedToolResultCount: 2,
        unpairedToolResultCount: 0,
        unpairedToolResultIds: [],
      })
      expect(replay.restorePlan.providerCacheBreaks).toEqual([
        {
          recordId: 'compact_boundary',
          reason: 'compact_boundary',
          previousCacheReadInputTokens: 12,
          cacheReadInputTokens: 0,
        },
      ])
      expect(replay.restorePlan.compactState).toMatchObject({
        status: 'restored',
        boundaryRecordId: 'compact_boundary',
        summaryRecordId: 'compact_boundary',
        compactedRecordCount: 3,
        replayableRecordCount: 6,
      })
      expect(replay.summary).toContain('Restored compact summary')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('replays the selected message graph leaf and excludes sidechain records', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    writeFileSync(
      transcriptPath,
      [
        record(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'root' },
          },
          'root_record',
          { uuid: 'uuid_root' },
        ),
        record(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' sidechain' },
          },
          'sidechain_record',
          {
            uuid: 'uuid_sidechain',
            parentUuid: 'uuid_root',
            isSidechain: true,
          },
        ),
        record(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' branch_a' },
          },
          'branch_a_record',
          {
            uuid: 'uuid_branch_a',
            parentUuid: 'uuid_root',
          },
        ),
        record(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' branch_b' },
          },
          'branch_b_record',
          {
            uuid: 'uuid_branch_b',
            logicalParentUuid: 'uuid_root',
          },
        ),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'resume leaf',
      })
      const replay = await replaySession(session)

      expect(replay.summary).toContain('root branch_b')
      expect(replay.summary).not.toContain('sidechain')
      expect(replay.summary).not.toContain('branch_a')
      expect(replay.restorePlan).toMatchObject({
        graphRestored: true,
        replayedRecordCount: 2,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('uses structured compact metadata and keeps compact summary out of provider messages', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    writeFileSync(
      transcriptPath,
      [
        record(
          {
            type: 'message_start',
            message: {
              id: 'msg_before',
              role: 'assistant',
              usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 9 },
            },
          },
          'before_start',
        ),
        record({ type: 'message_stop' }, 'before_stop'),
        record({ type: 'message_stop' }, 'structured_boundary', {
          compact: {
            boundary: true,
            summary: 'structured compact summary',
            trigger: 'manual',
          },
        }),
        record(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'structured compact summary' },
          },
          'summary_after_boundary',
          {
            compact: { summary: 'structured compact summary' },
          },
        ),
        record(
          {
            type: 'message_start',
            message: {
              id: 'msg_after',
              role: 'assistant',
              usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0 },
            },
          },
          'after_start',
        ),
        record(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'after compact' },
          },
          'after_text',
        ),
        record({ type: 'message_stop' }, 'after_stop'),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'continue',
      })
      const replay = await replaySession(session)

      expect(replay.providerMessages).toEqual([
        {
          id: 'msg_after',
          role: 'assistant',
          content: [{ type: 'text', text: 'after compact' }],
        },
      ])
      expect(replay.summary).toContain('Restored compact summary')
      expect(replay.summary).toContain('structured compact summary')
      expect(replay.restorePlan.compactState).toMatchObject({
        status: 'restored',
        boundaryRecordId: 'structured_boundary',
        summaryRecordId: 'summary_after_boundary',
        compactedRecordCount: 3,
        replayableRecordCount: 4,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports prompt-state cache breaks and diagnostic tool-result pairing reasons', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    writeFileSync(
      transcriptPath,
      [
        record(
          {
            type: 'message_start',
            message: {
              id: 'msg_cached',
              role: 'assistant',
              usage: {
                input_tokens: 10,
                output_tokens: 1,
                cache_read_input_tokens: 12,
                cache_creation_input_tokens: 0,
              },
            },
          },
          'cached_start',
          { promptStateHash: 'hash_a' },
        ),
        record({ type: 'message_stop' }, 'cached_stop'),
        record(
          {
            type: 'message_start',
            message: {
              id: 'msg_changed',
              role: 'assistant',
              usage: {
                input_tokens: 11,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 6,
              },
            },
          },
          'changed_start',
          { promptStateHash: 'hash_b' },
        ),
        record({ type: 'message_stop' }, 'changed_stop'),
        record(
          {
            type: 'tool_execution_result',
            tool_use_id: 'toolu_missing',
            name: 'Read',
            content: 'orphan result',
            is_error: false,
          },
          'orphan_result',
        ),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'continue',
      })
      const replay = await replaySession(session)

      expect(replay.restorePlan.providerCacheBreaks).toEqual([
        expect.objectContaining({
          recordId: 'changed_start',
          reason: 'prompt_state_changed',
          previousPromptStateHash: 'hash_a',
          promptStateHash: 'hash_b',
          previousCacheReadInputTokens: 12,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 6,
        }),
      ])
      expect(replay.restorePlan.providerMessageHydration).toMatchObject({
        status: 'partial',
        unpairedToolResultIds: ['toolu_missing'],
        unpairedToolResultReasons: {
          toolu_missing:
            'missing tool_use in replayed provider messages after cache/compact boundary',
        },
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records file snapshots and restores files to a checkpoint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    const filePath = join(cwd, 'hello.txt')
    writeFileSync(filePath, 'before', 'utf8')
    writeFileSync(
      transcriptPath,
      [
        record({ type: 'message_stop' }, 'checkpoint'),
        record(
          {
            type: 'tool_execution_start',
            tool_use_id: 'toolu_edit',
            name: 'Edit',
            input: { file_path: 'hello.txt' },
          },
          'edit_start',
        ),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'edit',
      })
      await recordFileSnapshot({
        cwd,
        sessionId: 's1',
        toolUseId: 'toolu_edit',
        toolName: 'Edit',
        filePath: 'hello.txt',
        now: new Date('2026-05-23T00:00:00.000Z'),
      })
      writeFileSync(filePath, 'after', 'utf8')

      const result = await rewindFilesToCheckpoint({
        cwd,
        session,
        checkpointRecordId: 'checkpoint',
      })

      expect(readFileSync(filePath, 'utf8')).toBe('before')
      expect(result).toEqual({
        checkpointRecordId: 'checkpoint',
        restoredFiles: ['hello.txt'],
        missingSnapshots: [],
        worktreeConflicts: [],
      })
      expect(await listFileSnapshots(cwd, 's1')).toEqual([
        expect.objectContaining({
          tool_use_id: 'toolu_edit',
          file_path: 'hello.txt',
          existed: true,
          kind: 'file',
          encoding: 'utf8',
          content: 'before',
        }),
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports git worktree conflicts before restoring file snapshots', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    const filePath = join(cwd, 'hello.txt')
    writeFileSync(filePath, 'before', 'utf8')
    writeFileSync(
      transcriptPath,
      [
        record({ type: 'message_stop' }, 'checkpoint'),
        record(
          {
            type: 'tool_execution_start',
            tool_use_id: 'toolu_edit',
            name: 'Edit',
            input: { file_path: 'hello.txt' },
          },
          'edit_start',
        ),
      ].join(''),
      'utf8',
    )

    try {
      execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd })
      execFileSync('git', ['add', 'hello.txt'], { cwd })
      execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'ignore' })

      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'edit',
      })
      await recordFileSnapshot({
        cwd,
        sessionId: 's1',
        toolUseId: 'toolu_edit',
        toolName: 'Edit',
        filePath: 'hello.txt',
      })
      writeFileSync(filePath, 'after', 'utf8')

      const result = await rewindFilesToCheckpoint({
        cwd,
        session,
        checkpointRecordId: 'checkpoint',
      })

      expect(readFileSync(filePath, 'utf8')).toBe('before')
      expect(result.worktreeConflicts).toEqual(['hello.txt'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('restores binary files and directory snapshots with metadata', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-session-'))
    mkdirSync(join(cwd, '.my-claude-code', 'transcripts'), { recursive: true })
    mkdirSync(join(cwd, 'assets'), { recursive: true })
    mkdirSync(join(cwd, 'assets', 'empty'), { recursive: true })
    const transcriptPath = join(cwd, '.my-claude-code', 'transcripts', 's1.jsonl')
    const binaryPath = join(cwd, 'image.bin')
    const dirFilePath = join(cwd, 'assets', 'a.bin')
    const symlinkPath = join(cwd, 'assets', 'link-to-a')
    writeFileSync(binaryPath, Buffer.from([0, 255, 1, 2]))
    writeFileSync(dirFilePath, Buffer.from([3, 4, 5]))
    chmodSync(dirFilePath, 0o640)
    if (process.platform !== 'win32') {
      symlinkSync('a.bin', symlinkPath)
    }
    writeFileSync(
      transcriptPath,
      [
        record({ type: 'message_stop' }, 'checkpoint'),
        record(
          {
            type: 'tool_execution_start',
            tool_use_id: 'toolu_binary',
            name: 'Write',
            input: { file_path: 'image.bin' },
          },
          'binary_start',
        ),
        record(
          {
            type: 'tool_execution_start',
            tool_use_id: 'toolu_dir',
            name: 'Write',
            input: { file_path: 'assets' },
          },
          'dir_start',
        ),
      ].join(''),
      'utf8',
    )

    try {
      const session = await recordSession({
        cwd,
        sessionId: 's1',
        transcriptPath,
        prompt: 'edit binary',
      })
      await recordFileSnapshot({
        cwd,
        sessionId: 's1',
        toolUseId: 'toolu_binary',
        toolName: 'Write',
        filePath: 'image.bin',
      })
      await recordFileSnapshot({
        cwd,
        sessionId: 's1',
        toolUseId: 'toolu_dir',
        toolName: 'Write',
        filePath: 'assets',
      })
      writeFileSync(binaryPath, Buffer.from([9, 9]))
      rmSync(join(cwd, 'assets'), { recursive: true, force: true })

      const result = await rewindFilesToCheckpoint({
        cwd,
        session,
        checkpointRecordId: 'checkpoint',
      })

      expect(readFileSync(binaryPath)).toEqual(Buffer.from([0, 255, 1, 2]))
      expect(readFileSync(dirFilePath)).toEqual(Buffer.from([3, 4, 5]))
      expect(lstatSync(dirFilePath).mode & 0o777).toBe(0o640)
      expect(lstatSync(join(cwd, 'assets', 'empty')).isDirectory()).toBe(true)
      if (process.platform !== 'win32') {
        expect(readlinkSync(symlinkPath)).toBe('a.bin')
      }
      expect(result.restoredFiles).toEqual(['assets', 'image.bin'])
      expect(await listFileSnapshots(cwd, 's1')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_path: 'image.bin',
            kind: 'file',
            encoding: 'base64',
          }),
          expect.objectContaining({
            file_path: 'assets',
            kind: 'directory',
            entries: expect.arrayContaining([
              expect.objectContaining({
                path: 'a.bin',
                type: 'file',
                contentBase64: Buffer.from([3, 4, 5]).toString('base64'),
              }),
              expect.objectContaining({
                path: 'empty',
                type: 'directory',
              }),
              ...(process.platform === 'win32'
                ? []
                : [
                    expect.objectContaining({
                      path: 'link-to-a',
                      type: 'symlink',
                      symlinkTarget: 'a.bin',
                    }),
                  ]),
            ]),
          }),
        ]),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function record(
  event: unknown,
  id: string = crypto.randomUUID(),
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    id,
    session_id: 's1',
    created_at: new Date().toISOString(),
    event,
    ...extra,
  })}\n`
}
