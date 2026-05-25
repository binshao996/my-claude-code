import type { ReactNode } from 'react'
import { Box } from '@anthropic/ink'

export function OverlayStack(props: {
  children: ReactNode
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {props.children}
    </Box>
  )
}
