import { useState } from 'react'
import { Box, Text, useInput, useTheme } from '@anthropic/ink'
import {
  buildResumePreviewRows,
  filterResumeSessions,
} from '@my-claude-code/commands'
import type { SessionMetadata } from '@my-claude-code/session'
import type { SessionRestorePlan } from '@my-claude-code/session'

export function ResumePicker(props: {
  sessions: SessionMetadata[]
  selectedIndex: number
  restorePlans?: Record<string, SessionRestorePlan>
  onSelectedIndexChange(index: number): void
  onSelect(session: SessionMetadata): void
  onFork(session: SessionMetadata): void
  onRewind(session: SessionMetadata): void
  onCancel(): void
}) {
  const theme = useTheme()
  const [filter, setFilter] = useState('')
  const visibleSessions = filterResumeSessions(props.sessions, filter)
  const selectedIndex = Math.max(
    0,
    Math.min(props.selectedIndex, visibleSessions.length - 1),
  )
  const selected = visibleSessions[selectedIndex]
  const previewRows = buildResumePreviewRows(
    selected,
    selected ? props.restorePlans?.[selected.id] : undefined,
  )

  useInput((input, key) => {
    if (key.escape) {
      if (filter) {
        setFilter('')
        props.onSelectedIndexChange(0)
        return
      }

      props.onCancel()
      return
    }

    if (key.backspace || key.delete) {
      if (filter) {
        setFilter(current => current.slice(0, -1))
        props.onSelectedIndexChange(0)
      }
      return
    }

    if (key.upArrow || (!filter && input === 'k')) {
      if (visibleSessions.length === 0) {
        return
      }

      props.onSelectedIndexChange(Math.max(0, selectedIndex - 1))
      return
    }

    if (key.downArrow || (!filter && input === 'j')) {
      if (visibleSessions.length === 0) {
        return
      }

      props.onSelectedIndexChange(
        Math.min(visibleSessions.length - 1, selectedIndex + 1),
      )
      return
    }

    if (key.pageUp) {
      if (visibleSessions.length === 0) {
        return
      }

      props.onSelectedIndexChange(Math.max(0, selectedIndex - 10))
      return
    }

    if (key.pageDown) {
      if (visibleSessions.length === 0) {
        return
      }

      props.onSelectedIndexChange(
        Math.min(visibleSessions.length - 1, selectedIndex + 10),
      )
      return
    }

    if (key.return) {
      const session = visibleSessions[selectedIndex]
      if (session) {
        props.onSelect(session)
      }
      return
    }

    if (input === 'f') {
      const session = visibleSessions[selectedIndex]
      if (session) {
        props.onFork(session)
      }
      return
    }

    if (input === 'r') {
      const session = visibleSessions[selectedIndex]
      if (session) {
        props.onRewind(session)
      }
      return
    }

    if (input && !key.ctrl && !key.meta) {
      setFilter(current => `${current}${input}`)
      props.onSelectedIndexChange(0)
    }
  }, { isActive: true })

  return (
    <Box borderStyle="round" borderColor={theme.palette.border} flexDirection="column" paddingX={1}>
      <Text color={theme.palette.accent}>Resume session</Text>
      <Text color={theme.palette.muted}>
        filter: {filter || '(type to search)'}
      </Text>
      {props.sessions.length === 0 ? (
        <Text>No sessions found.</Text>
      ) : visibleSessions.length === 0 ? (
        <Text>No sessions match.</Text>
      ) : (
        visibleSessions.map((session, index) => (
          <Text key={session.id} color={index === selectedIndex ? theme.palette.accent : theme.palette.foreground}>
            {index === selectedIndex ? '› ' : '  '}
            {session.id} | {session.promptCount} prompt
            {session.promptCount === 1 ? '' : 's'} | {session.lastPrompt ?? ''}
          </Text>
        ))
      )}
      {visibleSessions.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.palette.accent}>Preview</Text>
          {previewRows?.map(row => (
            <Text key={row.label} color={theme.palette.foreground}>
              {row.label}: {row.value}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text color={theme.palette.muted}>Type filter, ↑/↓ or j/k choose, PageUp/PageDown jump, Enter resume, f fork, r rewind, Esc clear/cancel.</Text>
    </Box>
  )
}
