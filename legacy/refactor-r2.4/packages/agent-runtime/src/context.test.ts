import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildRuntimeContext } from './context.js'
import {
  extractMemories,
  syncTeamMemory,
  writeSessionMemorySnapshot,
} from '@my-claude-code/tools'

describe('V0.5 runtime context', () => {
  it('builds sectioned system context with CLAUDE.md, date, and additional directories', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-context-'))
    mkdirSync(join(cwd, 'packages', 'app'), { recursive: true })
    writeFileSync(join(cwd, 'CLAUDE.md'), 'root memory', 'utf8')
    writeFileSync(join(cwd, 'packages', 'app', 'CLAUDE.md'), 'app memory', 'utf8')

    try {
      const context = await buildRuntimeContext({
        cwd: join(cwd, 'packages', 'app'),
        systemPrompt: 'base',
        appendSystemPrompt: 'append',
        userContext: 'session summary',
        additionalDirectories: ['../shared'],
        now: new Date('2026-05-23T12:00:00.000Z'),
        includeGitStatus: false,
      })

      expect(context.systemContent).toContain('## Base instructions\nbase')
      expect(context.systemContent).toContain('## Appended instructions\nappend')
      expect(context.systemContent).toContain('## Current date\n2026-05-23')
      expect(context.systemContent).toContain('root memory')
      expect(context.systemContent).toContain('app memory')
      expect(context.systemContent).toContain('## Session context\nsession summary')
      expect(context.systemContent).toContain('## Additional directories\n../shared')
      expect(context.memoryFiles.map(file => file.chars)).toEqual([11, 10])
      expect(context.estimatedTokens).toBeGreaterThan(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('attaches relevant memory snippets for prompt terms', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-context-'))
    writeFileSync(
      join(cwd, 'CLAUDE.md'),
      [
        'Prefer focused tests.',
        'Database migrations must be reversible.',
        'Use quiet UI copy.',
      ].join('\n'),
      'utf8',
    )

    try {
      const context = await buildRuntimeContext({
        cwd,
        systemPrompt: 'base',
        prompt: 'update database migration',
        includeGitStatus: false,
      })

      expect(context.relevantMemory).toEqual([
        {
          path: join(cwd, 'CLAUDE.md'),
          snippet: '2: Database migrations must be reversible.',
        },
      ])
      expect(context.systemContent).toContain('## Relevant memory')
      expect(context.systemContent).toContain('Database migrations must be reversible.')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('injects ranked local memory, session memory, team context, and provider cache breaks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-context-'))

    try {
      await extractMemories(cwd, {
        store: 'work',
        text: 'Billing migration memories should be ranked for future prompts.',
      })
      await writeSessionMemorySnapshot(cwd, {
        sessionId: 'session_1',
        summary: 'Prior session discussed billing migrations.',
      })
      await syncTeamMemory(cwd, 'Parity Team')
      const context = await buildRuntimeContext({
        cwd,
        systemPrompt: 'base',
        prompt: 'billing migration',
        sessionId: 'session_1',
        providerCacheBreaks: [{ recordId: 'r1', reason: 'prompt_state_changed' }],
        includeGitStatus: false,
      })

      expect(context.systemContent).toContain('## Ranked local memory')
      expect(context.systemContent).toContain('## Session memory')
      expect(context.systemContent).toContain('## Team context')
      expect(context.systemContent).toContain('## Provider cache breaks')
      expect(context.localMemoryRank).toEqual(expect.arrayContaining([
        expect.objectContaining({
          store: 'work',
          matches: expect.arrayContaining(['billing', 'migration']),
        }),
      ]))
      expect(context.localMemoryRank[0]).toMatchObject({
        matches: expect.arrayContaining(['billing', 'migration']),
      })
      expect(context.sessionMemory?.sessionId).toBe('session_1')
      expect(context.providerCacheBreaks).toEqual([
        { recordId: 'r1', reason: 'prompt_state_changed' },
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
