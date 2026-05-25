import { describe, expect, it } from 'bun:test'
import {
  emitNotificationHook,
  expireNotifications,
  UPSTREAM_NOTIFICATION_HOOKS,
  type NotificationCenterState,
} from './notifications.js'

describe('notification hook lifecycle', () => {
  it('covers upstream notification hooks and folds duplicate lifecycle records', async () => {
    expect(UPSTREAM_NOTIFICATION_HOOKS).toContain('mcp-connectivity')
    expect(UPSTREAM_NOTIFICATION_HOOKS).toContain('plugin-autoupdate')
    expect(UPSTREAM_NOTIFICATION_HOOKS).toContain('ide-lsp-initialization')

    let state: NotificationCenterState = { notifications: [] }
    state = await emitNotificationHook(state, {
      key: 'rate-limit-warning',
      hook: 'rate-limit',
      title: 'Approaching limit',
      body: 'You are approaching a limit',
      priority: 'high',
      timeoutMs: 1000,
      env: { MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS: '1' },
    })
    state = await emitNotificationHook(state, {
      key: 'rate-limit-warning',
      hook: 'rate-limit',
      title: 'Approaching limit',
      body: 'You are still approaching a limit',
      priority: 'high',
      timeoutMs: 1000,
      env: { MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS: '1' },
    })

    expect(state.notifications).toHaveLength(1)
    expect(state.notifications[0]).toMatchObject({
      hook: 'rate-limit',
      count: 2,
      dispatch: expect.objectContaining({
        status: 'unavailable',
        transport: 'none',
        bodyHash: expect.any(String),
      }),
    })

    const expired = expireNotifications(state, Date.parse(state.notifications[0].createdAt) + 1001)
    expect(expired.notifications).toHaveLength(0)
  })
})
