import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractMemories,
  listMemoryStoreEntries,
  rankMemoryStoreEntries,
  syncTeamMemory,
  writeAgentMemorySnapshot,
  writeSessionMemorySnapshot,
} from './memory.js'

describe('V1.9 memory runtime', () => {
  it('extracts, ranks, caches, snapshots, and syncs memory without storing secrets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-memory-'))

    try {
      const extracted = await extractMemories(cwd, {
        store: 'work',
        text: [
          'Use reversible database migrations for billing tables.',
          'Prefer quiet dashboard copy for operational tools.',
        ].join('\n'),
      })
      expect(extracted).toHaveLength(2)
      expect(await listMemoryStoreEntries(cwd)).toHaveLength(2)

      const ranked = await rankMemoryStoreEntries(cwd, 'billing migration')
      expect(ranked.entries[0]).toMatchObject({
        store: 'work',
        matches: expect.arrayContaining(['billing', 'migration']),
      })
      expect(existsSync(join(cwd, '.my-claude-code', 'memory-cache.json'))).toBe(true)

      const agent = await writeAgentMemorySnapshot(cwd, {
        agentId: 'Explore Agent',
        sessionId: 's1',
        summary: 'Mapped billing migration files.',
        memories: ['Prefer reversible migrations.'],
      })
      expect(agent.agentId).toBe('Explore-Agent')

      const session = await writeSessionMemorySnapshot(cwd, {
        sessionId: 's1',
        summary: 'User is validating V1.9 memory parity.',
        providerCacheBreaks: [{ recordId: 'r1', reason: 'prompt_state_changed' }],
      })
      expect(session.providerCacheBreaks).toHaveLength(1)

      const team = await syncTeamMemory(cwd, 'Parity Team')
      expect(team.teamName).toBe('Parity Team')
      expect(readFileSync(team.memoryPath, 'utf8')).not.toContain('fixture-secret')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
