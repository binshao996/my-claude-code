import { Box, Text, useInput, useTheme } from '@anthropic/ink'
import type {
  PermissionNotice,
  PermissionRequest,
} from '../tuiTypes.js'

export function PermissionPanel(props: {
  request?: PermissionRequest
  notice?: PermissionNotice
  rule?: string
  queueCount?: number
  onAllowOnce(): void
  onAllowSession(): void
  onAllowPersist(): void
  onDenyOnce(): void
  onDenySession(): void
  onDenyPersist(): void
  onAllowQueueSession(): void
  onAllowQueuePersist(): void
  onDenyQueueSession(): void
  onDenyQueuePersist(): void
  onDismiss(): void
}) {
  const theme = useTheme()
  useInput((input, key) => {
    if (props.request) {
      if (input === 'A') {
        props.onAllowQueueSession()
        return
      }

      if (input === 'P') {
        props.onAllowQueuePersist()
        return
      }

      if (input === 'D') {
        props.onDenyQueueSession()
        return
      }

      if (input === 'X') {
        props.onDenyQueuePersist()
        return
      }

      const normalized = input.toLowerCase()
      if (normalized === 'y') {
        props.onAllowOnce()
        return
      }

      if (normalized === 's') {
        props.onAllowSession()
        return
      }

      if (normalized === 'p') {
        props.onAllowPersist()
        return
      }

      if (normalized === 'n' || key.escape) {
        props.onDenyOnce()
        return
      }

      if (normalized === 'd') {
        props.onDenySession()
        return
      }

      if (normalized === 'x') {
        props.onDenyPersist()
        return
      }
      return
    }

    if (props.notice && key.escape) {
      props.onDismiss()
    }
  }, { isActive: Boolean(props.request ?? props.notice) })

  if (!props.request && !props.notice) {
    return null
  }

  if (props.request) {
    return (
      <Box borderStyle="round" borderColor={theme.palette.warning} flexDirection="column" paddingX={1}>
        <Text color={theme.palette.warning}>Permission required</Text>
        {props.queueCount && props.queueCount > 1 ? (
          <Text color={theme.palette.muted}>{props.queueCount} queued requests</Text>
        ) : null}
        <Text color={theme.palette.foreground}>{props.request.tool}</Text>
        {props.rule ? <Text color={theme.palette.muted}>{props.rule}</Text> : null}
        <Text color={theme.palette.foreground}>{props.request.reason}</Text>
        <Text color={theme.palette.muted}>
          y allow once  s allow session  p persist allow
        </Text>
        <Text color={theme.palette.muted}>
          n deny once  d deny session  x persist deny  Esc deny once
        </Text>
        {props.queueCount && props.queueCount > 1 ? (
          <Text color={theme.palette.muted}>
            A allow all session  P persist all  D deny all session  X persist all deny
          </Text>
        ) : null}
      </Box>
    )
  }

  const notice = props.notice
  if (!notice) {
    return null
  }

  return (
    <Box borderStyle="round" borderColor={theme.palette.warning} flexDirection="column" paddingX={1}>
      <Text color={theme.palette.warning}>Permission</Text>
      <Text color={theme.palette.foreground}>
        {notice.tool} returned {notice.decision}
      </Text>
      <Text color={theme.palette.foreground}>{notice.reason}</Text>
      <Text color={theme.palette.muted}>Press Esc to dismiss.</Text>
    </Box>
  )
}
