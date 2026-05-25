import { describe, expect, it } from 'bun:test'
import { matchesToolNameRule, matchesToolRule } from './permissions.js'

describe('permission rule matching', () => {
  it('supports MCP server and wildcard tool rules', () => {
    expect(matchesToolNameRule('mcp__github__search', 'mcp__github')).toBe(true)
    expect(matchesToolNameRule('mcp__github__search', 'mcp__github__*')).toBe(true)
    expect(matchesToolNameRule('mcp__gitlab__search', 'mcp__github')).toBe(false)
  })

  it('keeps MCP tool matching separate from pattern matching', () => {
    expect(
      matchesToolRule(
        'mcp__github__search',
        { query: 'repo' },
        'mcp__github__search',
      ),
    ).toBe(true)
  })
})
