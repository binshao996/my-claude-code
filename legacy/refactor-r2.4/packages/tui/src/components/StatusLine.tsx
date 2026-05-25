import { Box, Text, useTheme } from '@anthropic/ink'
import type { TuiStatus } from '../tuiTypes.js'

export function StatusLine(props: {
  sessionId: string
  cwd: string
  version?: string
  model?: string
  permissionMode?: string
  status: TuiStatus
  tokenBudget?: {
    used: number
    limit: number
  }
  promptCacheHitRate?: number
  voice?: {
    enabled: boolean
    status: string
    provider: string
    recording?: boolean
  }
}) {
  const theme = useTheme()
  const statusColor = props.status === 'idle'
    ? theme.palette.muted
    : props.status === 'running'
      ? theme.palette.accent
      : theme.palette.warning
  const headerRows = statusLineRows(props)

  return (
    <Box flexDirection="column" marginBottom={1}>
      {headerRows.map(row => (
        <Box key={row.text}>
          <Text color={theme.palette.warning}>{row.art.padEnd(12)}</Text>
          <Text color={row.strong ? theme.palette.foreground : statusColor}>
            {row.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export function statusLineRows(props: {
  sessionId: string
  cwd: string
  version?: string
  model?: string
  permissionMode?: string
  status: TuiStatus
  tokenBudget?: {
    used: number
    limit: number
  }
  promptCacheHitRate?: number
  voice?: {
    enabled: boolean
    status: string
    provider: string
    recording?: boolean
  }
}): Array<{ art: string; text: string; strong?: boolean }> {
  const usage = props.tokenBudget
    ? `tokens ${props.tokenBudget.used}/${props.tokenBudget.limit}`
    : 'tokens -'
  const cache = props.promptCacheHitRate === undefined
    ? 'cache -'
    : `cache ${Math.round(props.promptCacheHitRate * 100)}%`
  const voice = props.voice
    ? ` · voice ${props.voice.recording ? 'recording' : props.voice.enabled ? props.voice.status : 'off'}:${props.voice.provider}`
    : ''
  return [
    {
      art: '  ██  ██  ',
      text: `my-claude-code v${props.version ?? '1.0.0'}`,
      strong: true,
    },
    {
      art: '██████████',
      text: `${props.model ?? 'deepseek-v4-flash'} · API Usage Billing`,
    },
    {
      art: '██ ██ ██',
      text: compactHomePath(props.cwd),
    },
    {
      art: '  ██  ██  ',
      text: `└ Session ${shortSessionId(props.sessionId)} · ${props.status} · ${usage} · ${cache} · permission ${props.permissionMode ?? 'default'}${voice}`,
    },
  ]
}

export function statusLineSelectionRows(props: Parameters<typeof statusLineRows>[0]): string[] {
  return [
    ...statusLineRows(props).map(row => `${row.art.padEnd(12)}${row.text}`),
    '',
  ]
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
}

function compactHomePath(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(home)
    ? `~${path.slice(home.length)}`
    : path
}
