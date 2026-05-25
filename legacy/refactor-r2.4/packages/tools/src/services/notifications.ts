import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type NotificationDispatchResult = {
  status: 'delivered' | 'unavailable' | 'failed'
  transport: 'terminal-notifier' | 'osascript' | 'notify-send' | 'powershell' | 'none'
  bodyHash: string
  error?: string
}

export type NotificationPriority = 'low' | 'medium' | 'high' | 'immediate'

export const UPSTREAM_NOTIFICATION_HOOKS = [
  'startup',
  'settings-errors',
  'mcp-connectivity',
  'plugin-install',
  'plugin-autoupdate',
  'rate-limit',
  'model-migration',
  'npm-deprecation',
  'update',
  'teammate-shutdown',
  'ide-lsp-initialization',
  'fast-mode',
  'subscription-switch',
  'chrome-extension',
  'official-marketplace-recommendation',
] as const

export type NotificationHookKind = typeof UPSTREAM_NOTIFICATION_HOOKS[number]

export type NotificationRecord = {
  key: string
  hook: NotificationHookKind
  title: string
  body: string
  priority: NotificationPriority
  createdAt: string
  timeoutMs?: number
  count: number
  dispatch: NotificationDispatchResult
}

export type NotificationCenterState = {
  notifications: NotificationRecord[]
}

export async function emitNotificationHook(
  state: NotificationCenterState,
  input: {
    key: string
    hook: NotificationHookKind
    title: string
    body: string
    priority?: NotificationPriority
    timeoutMs?: number
    fold?: boolean
    env?: Record<string, string | undefined>
  },
): Promise<NotificationCenterState> {
  const dispatch = await dispatchLocalNotification({
    title: input.title,
    body: input.body,
    env: input.env,
  })
  const previousIndex = state.notifications.findIndex(record => record.key === input.key)
  const now = new Date().toISOString()
  const record: NotificationRecord = previousIndex === -1
    ? {
        key: input.key,
        hook: input.hook,
        title: input.title,
        body: input.body,
        priority: input.priority ?? 'medium',
        timeoutMs: input.timeoutMs,
        createdAt: now,
        count: 1,
        dispatch,
      }
    : {
        ...state.notifications[previousIndex],
        title: input.title,
        body: input.body,
        priority: input.priority ?? state.notifications[previousIndex].priority,
        timeoutMs: input.timeoutMs ?? state.notifications[previousIndex].timeoutMs,
        count: input.fold === false ? 1 : state.notifications[previousIndex].count + 1,
        dispatch,
      }
  const next = [...state.notifications]
  if (previousIndex === -1) {
    next.push(record)
  } else {
    next[previousIndex] = record
  }
  return { notifications: next }
}

export function expireNotifications(
  state: NotificationCenterState,
  now = Date.now(),
): NotificationCenterState {
  return {
    notifications: state.notifications.filter(record => {
      if (!record.timeoutMs) {
        return true
      }
      return Date.parse(record.createdAt) + record.timeoutMs > now
    }),
  }
}

export async function dispatchLocalNotification(input: {
  title: string
  body: string
  env?: Record<string, string | undefined>
}): Promise<NotificationDispatchResult> {
  const bodyHash = createHash('sha256').update(input.body).digest('hex')
  const env = input.env ?? process.env
  if (env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS === '1') {
    return { status: 'unavailable', transport: 'none', bodyHash, error: 'disabled by env' }
  }
  if (process.platform === 'darwin') {
    return runNotification('osascript', [
      '-e',
      `display notification ${JSON.stringify(input.body)} with title ${JSON.stringify(input.title)}`,
    ], 'osascript', bodyHash)
  }
  if (process.platform === 'linux') {
    return runNotification('notify-send', [input.title, input.body], 'notify-send', bodyHash)
  }
  if (process.platform === 'win32') {
    return runNotification('powershell.exe', [
      '-NoProfile',
      '-Command',
      `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; Write-Output ${JSON.stringify(input.title)}`,
    ], 'powershell', bodyHash)
  }
  return { status: 'unavailable', transport: 'none', bodyHash, error: `unsupported platform: ${process.platform}` }
}

async function runNotification(
  command: string,
  args: string[],
  transport: NotificationDispatchResult['transport'],
  bodyHash: string,
): Promise<NotificationDispatchResult> {
  try {
    await execFileAsync(command, args, { timeout: 5000 })
    return { status: 'delivered', transport, bodyHash }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: /ENOENT|not found|command not found/i.test(message) ? 'unavailable' : 'failed',
      transport,
      bodyHash,
      error: message,
    }
  }
}
