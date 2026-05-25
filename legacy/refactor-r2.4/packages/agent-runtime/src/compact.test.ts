import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { Message } from '@my-claude-code/core'
import {
  applyAutoCompact,
  applyAutoCompactWithSummary,
  applyToolResultBudget,
} from './compact.js'

describe('V0.5 compact helpers', () => {
  it('persists and references tool results over the budget', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-compact-'))
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_big',
            content: 'x'.repeat(120),
          },
        ],
      },
    ]

    try {
      const result = await applyToolResultBudget(messages, {
        cwd,
        sessionId: 's1',
        maxToolResultChars: 20,
        maxTotalToolResultChars: 20,
      })

      const content = result.messages[0]?.content
      const replacement =
        Array.isArray(content) && content[0]?.type === 'tool_result'
          ? String(content[0].content)
          : ''
      expect(Array.isArray(content) ? content[0] : undefined).toMatchObject({
        type: 'tool_result',
      })
      expect(replacement).toContain('[tool result truncated: 120 chars persisted at')
      expect(result.stats).toMatchObject({
        persistedResults: 1,
        truncatedResults: 1,
        originalChars: 120,
      })

      const reference = replacement
        .split('persisted at ')[1]
        ?.replace(']', '')
        .trim()
      expect(reference).toBeTruthy()
      expect(existsSync(join(cwd, reference as string))).toBe(true)
      expect(readFileSync(join(cwd, reference as string), 'utf8')).toBe('x'.repeat(120))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('creates a compact boundary message when estimated tokens exceed threshold', () => {
    mkdirSync(mkdtempSync(join(tmpdir(), 'unused-')), { recursive: true })
    const messages: Message[] = [
      { role: 'system', content: 'base' },
      { role: 'user', content: 'old context '.repeat(200) },
      { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] },
      { role: 'user', content: 'current task' },
    ]

    const result = applyAutoCompact(messages, {
      thresholdTokens: 20,
      keepLastMessages: 2,
    })

    expect(result.compacted).toBe(true)
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('compact_boundary'),
    })
    expect(result.messages.at(-1)).toEqual({ role: 'user', content: 'current task' })
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore)
  })

  it('uses an injected summarizer for compact summaries', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'base' },
      { role: 'user', content: 'old context '.repeat(80) },
      { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] },
      { role: 'user', content: 'current task' },
    ]

    const result = await applyAutoCompactWithSummary(messages, {
      thresholdTokens: 20,
      keepLastMessages: 2,
      summarizer: ({ fallbackSummary }) => `model summary: ${fallbackSummary.slice(0, 12)}`,
    })

    expect(result.compacted).toBe(true)
    expect(result.summary).toContain('model summary:')
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('summary:\nmodel summary:'),
    })
  })
})
