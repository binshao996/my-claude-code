import { useInsertionEffect, type PropsWithChildren } from 'react'
import { Box, useStdout } from 'ink'

const ENTER_ALT_SCREEN = '\x1B[?1049h'
const EXIT_ALT_SCREEN = '\x1B[?1049l'
const CLEAR_AND_HOME = '\x1B[2J\x1B[H'
const ENABLE_MOUSE_TRACKING = '\x1B[?1000h\x1B[?1002h\x1B[?1003h\x1B[?1006h'
const DISABLE_MOUSE_TRACKING = '\x1B[?1006l\x1B[?1003l\x1B[?1002l\x1B[?1000l'

export function AlternateScreen({
  children,
  mouseTracking = true,
}: PropsWithChildren<{ mouseTracking?: boolean }>) {
  const { stdout } = useStdout()
  const rows = Number.isFinite(stdout.rows) && stdout.rows > 0
    ? stdout.rows
    : 24

  useInsertionEffect(() => {
    stdout.write(
      `${ENTER_ALT_SCREEN}${CLEAR_AND_HOME}${
        mouseTracking ? ENABLE_MOUSE_TRACKING : ''
      }`,
    )

    return () => {
      stdout.write(
        `${mouseTracking ? DISABLE_MOUSE_TRACKING : ''}${EXIT_ALT_SCREEN}`,
      )
    }
  }, [mouseTracking, stdout])

  return (
    <Box flexDirection="column" height={rows} width="100%" flexShrink={0}>
      {children}
    </Box>
  )
}
