import { useState } from 'react'
import { Box, Text, useInput, useTheme } from '@anthropic/ink'
import type {
  SessionCheckpoint,
  SessionMetadata,
} from '@my-claude-code/session'

export function CheckpointPicker(props: {
  session: SessionMetadata
  checkpoints: SessionCheckpoint[]
  onRewind(checkpoint: SessionCheckpoint): void
  onRewindFiles(checkpoint: SessionCheckpoint): void
  onCancel(): void
}) {
  const theme = useTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selected = props.checkpoints[selectedIndex]

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel()
      return
    }

    if (key.upArrow) {
      setSelectedIndex(current =>
        Math.max(0, current - 1),
      )
      return
    }

    if (key.downArrow) {
      setSelectedIndex(current =>
        Math.min(props.checkpoints.length - 1, current + 1),
      )
      return
    }

    if (key.return) {
      if (selected) {
        props.onRewind(selected)
      }
      return
    }

    if (input === 'w') {
      if (selected) {
        props.onRewindFiles(selected)
      }
    }
  }, { isActive: true })

  return (
    <Box borderStyle="round" borderColor={theme.palette.border} flexDirection="column" paddingX={1}>
      <Text color={theme.palette.accent}>Rewind {props.session.id}</Text>
      {props.checkpoints.length === 0 ? (
        <Text>No checkpoints found.</Text>
      ) : (
        props.checkpoints.map((checkpoint, index) => (
          <Text key={checkpoint.recordId} color={index === selectedIndex ? theme.palette.accent : theme.palette.foreground}>
            {index === selectedIndex ? '› ' : '  '}
            {checkpoint.recordId} | {checkpoint.label}
          </Text>
        ))
      )}
      <Text color={theme.palette.muted}>↑/↓ choose, Enter rewind session, w restore files, Esc cancel.</Text>
    </Box>
  )
}
