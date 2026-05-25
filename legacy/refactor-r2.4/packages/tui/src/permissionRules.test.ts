import { describe, expect, it } from 'bun:test'
import {
  isMcpToolName,
  permissionRuleForRequest,
  permissionScopeForRequest,
  summarizePermissionRule,
} from './permissionRules.js'

describe('TUI permission rules', () => {
  it('builds scoped file permission rules', () => {
    const request = {
      tool: 'Write',
      reason: 'write requires permission',
      input: {
        file_path: 'docs/gap.md',
        content: 'gap',
      },
    }

    expect(permissionScopeForRequest(request)).toBe('docs/gap.md')
    expect(permissionRuleForRequest(request)).toBe('Write(docs/gap.md)')
  })

  it('builds scoped bash permission rules', () => {
    expect(
      permissionRuleForRequest({
        tool: 'Bash',
        reason: 'bash requires permission',
        input: {
          command: 'bun test',
        },
      }),
    ).toBe('Bash(bun test)')
  })

  it('falls back to the tool name when no stable scope exists', () => {
    expect(
      permissionRuleForRequest({
        tool: 'TestingPermission',
        reason: 'test',
        input: {},
      }),
    ).toBe('TestingPermission')
  })

  it('bridges MCP tool permissions without unsupported pattern rules', () => {
    expect(isMcpToolName('mcp__github__search')).toBe(true)
    expect(
      permissionRuleForRequest({
        tool: 'mcp__github__search',
        reason: 'mcp tool requires permission',
        input: {
          query: 'repo',
        },
      }),
    ).toBe('mcp__github__search')
  })

  it('summarizes long rules for compact TUI display', () => {
    expect(summarizePermissionRule('Bash(abcdefghijklmnopqrstuvwxyz)', 12)).toBe(
      'Bash(abcdef…',
    )
  })
})
