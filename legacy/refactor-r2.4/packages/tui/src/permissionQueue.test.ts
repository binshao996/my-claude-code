import { describe, expect, it } from 'bun:test'
import {
  activePermissionRequest,
  permissionRulesForQueue,
  removePermissionRequest,
  resolvePermissionQueue,
  type QueuedPermissionRequest,
} from './permissionQueue.js'

describe('TUI permission queue', () => {
  it('keeps permission prompts ordered and removable', () => {
    const queue = [
      permission('p1', 'Write', { file_path: 'a.txt' }),
      permission('p2', 'Bash', { command: 'bun test' }),
    ]

    expect(activePermissionRequest(queue)?.id).toBe('p1')
    expect(removePermissionRequest(queue, 'p1').map(request => request.id)).toEqual([
      'p2',
    ])
  })

  it('builds unique scoped rules for batch authorization', () => {
    const queue = [
      permission('p1', 'Write', { file_path: 'a.txt' }),
      permission('p2', 'Write', { file_path: 'a.txt' }),
      permission('p3', 'mcp__github__search', { query: 'repo' }),
    ]

    expect(permissionRulesForQueue(queue)).toEqual([
      'Write(a.txt)',
      'mcp__github__search',
    ])
  })

  it('resolves all queued permission requests', () => {
    const decisions: string[] = []
    const queue = [
      permission('p1', 'Write', { file_path: 'a.txt' }, decisions),
      permission('p2', 'Bash', { command: 'pwd' }, decisions),
    ]

    resolvePermissionQueue(queue, request => ({
      decision: 'deny',
      reason: `denied ${request.tool}`,
    }))

    expect(decisions).toEqual(['deny:denied Write', 'deny:denied Bash'])
  })
})

function permission(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  decisions: string[] = [],
): QueuedPermissionRequest {
  return {
    id,
    tool,
    input,
    reason: `${tool} asks`,
    resolve(decision) {
      decisions.push(`${decision.decision}:${decision.reason ?? ''}`)
    },
  }
}
