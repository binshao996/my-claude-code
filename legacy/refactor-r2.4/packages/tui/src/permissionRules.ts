import type { PermissionRequest } from './tuiTypes.js'

const SCOPED_INPUT_KEYS = [
  'file_path',
  'path',
  'command',
  'pattern',
  'query',
] as const

export function permissionRuleForRequest(request: PermissionRequest): string {
  if (isMcpToolName(request.tool)) {
    return request.tool
  }

  const scope = permissionScopeForRequest(request)
  return scope ? `${request.tool}(${scope})` : request.tool
}

export function isMcpToolName(toolName: string): boolean {
  return /^mcp__[^_\s][^\s]*(?:__(?:\*|[^\s]+))?$/.test(toolName)
}

export function permissionScopeForRequest(
  request: PermissionRequest,
): string | undefined {
  for (const key of SCOPED_INPUT_KEYS) {
    const value = request.input[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

export function summarizePermissionRule(rule: string, maxLength = 96): string {
  if (rule.length <= maxLength) {
    return rule
  }

  return `${rule.slice(0, Math.max(1, maxLength - 1))}…`
}
