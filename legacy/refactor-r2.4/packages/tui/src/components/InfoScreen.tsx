import { useState } from 'react'
import { Box, Text, useInput, useTheme } from '@anthropic/ink'
import type { CommandScreen } from '@my-claude-code/commands'

export function InfoScreen(props: {
  screen: CommandScreen
  onClose(): void
}) {
  const theme = useTheme()
  const bodyRows = commandScreenBodyRows(props.screen)
  const maxVisibleBodyRows = 14
  const maxOffset = Math.max(0, bodyRows.length - maxVisibleBodyRows)
  const [offset, setOffset] = useState(0)

  useInput((_input, key) => {
    if (key.escape) {
      props.onClose()
      return
    }

    if (key.upArrow) {
      setOffset(current => Math.max(0, current - 1))
      return
    }

    if (key.downArrow) {
      setOffset(current => Math.min(maxOffset, current + 1))
      return
    }

    if (key.pageUp) {
      setOffset(current => Math.max(0, current - maxVisibleBodyRows))
      return
    }

    if (key.pageDown) {
      setOffset(current => Math.min(maxOffset, current + maxVisibleBodyRows))
    }
  }, { isActive: true })
  const visibleRows = bodyRows.slice(offset, offset + maxVisibleBodyRows)

  return (
    <Box borderStyle="round" borderColor={theme.palette.border} flexDirection="column" paddingX={1}>
      <Text color={theme.palette.accent}>{props.screen.title}</Text>
      {offset > 0 ? <Text color={theme.palette.muted}>{offset} row(s) above</Text> : null}
      {visibleRows.map(row => (
        <Text key={row.key} color={row.color ?? theme.palette.foreground}>
          {row.text}
        </Text>
      ))}
      {offset < maxOffset ? <Text color={theme.palette.muted}>{maxOffset - offset} row(s) below</Text> : null}
      {props.screen.footer ? (
        <Text color={theme.palette.muted}>{props.screen.footer}</Text>
      ) : null}
      <Text color={theme.palette.muted}>↑/↓ or PageUp/PageDown scroll. Esc close.</Text>
    </Box>
  )
}

function commandScreenBodyRows(screen: CommandScreen): Array<{
  key: string
  text: string
  color?: string
}> {
  return [
    ...(screen.rows ?? []).map(row => ({
      key: `row:${row.label}`,
      text: `${row.label}: ${row.value}`,
    })),
    ...(screen.items ?? []).map((item, index) => ({
      key: `item:${index}:${item}`,
      text: item,
    })),
    ...(screen.checks ?? []).map(check => ({
      key: `check:${check.label}`,
      text: `${check.label}: ${check.status}${check.detail ? ` - ${check.detail}` : ''}`,
      color: checkColor(check.status),
    })),
  ]
}

function checkColor(status: 'ok' | 'warning' | 'error'): string {
  switch (status) {
    case 'ok':
      return 'green'
    case 'warning':
      return 'yellow'
    case 'error':
      return 'red'
  }
}
