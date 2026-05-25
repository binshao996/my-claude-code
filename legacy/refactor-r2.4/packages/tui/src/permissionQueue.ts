import type { PermissionCheck } from '@my-claude-code/tools'
import type { PermissionRequest } from './tuiTypes.js'
import { permissionRuleForRequest } from './permissionRules.js'

export type QueuedPermissionRequest = PermissionRequest & {
  id: string
  resolve(decision: PermissionCheck): void
}

export function activePermissionRequest(
  queue: QueuedPermissionRequest[],
): QueuedPermissionRequest | undefined {
  return queue[0]
}

export function removePermissionRequest(
  queue: QueuedPermissionRequest[],
  requestId: string,
): QueuedPermissionRequest[] {
  return queue.filter(request => request.id !== requestId)
}

export function permissionRulesForQueue(
  queue: QueuedPermissionRequest[],
): string[] {
  return [...new Set(queue.map(permissionRuleForRequest))]
}

export function resolvePermissionQueue(
  queue: QueuedPermissionRequest[],
  decisionForRequest: (request: QueuedPermissionRequest) => PermissionCheck,
): void {
  for (const request of queue) {
    request.resolve(decisionForRequest(request))
  }
}
