import { useEffect, useState } from 'react'
import {
  Box,
  Text,
  themePreviewRows,
  useInput,
  useThemeController,
} from '@anthropic/ink'
import { THEME_NAMES, type ThemeName } from '@my-claude-code/settings'

export function ThemePicker(props: {
  activeTheme: ThemeName
  onSelect(theme: ThemeName): void
  onCancel(): void
}) {
  const initialIndex = Math.max(0, THEME_NAMES.indexOf(props.activeTheme))
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)
  const selectedTheme = THEME_NAMES[selectedIndex] ?? 'default'
  const previewRows = themePreviewRows(selectedTheme, readThemeEnv())
  const theme = useThemeController()
  const { setPreviewTheme } = theme

  useEffect(() => {
    setPreviewTheme(selectedTheme)
    return () => {
      setPreviewTheme(undefined)
    }
  }, [selectedTheme, setPreviewTheme])

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel()
      return
    }

    if (key.upArrow) {
      setSelectedIndex(current =>
        (current - 1 + THEME_NAMES.length) % THEME_NAMES.length,
      )
      return
    }

    if (key.downArrow) {
      setSelectedIndex(current => (current + 1) % THEME_NAMES.length)
      return
    }

    if (key.home) {
      setSelectedIndex(0)
      return
    }

    if (key.end) {
      setSelectedIndex(THEME_NAMES.length - 1)
      return
    }

    if (key.return) {
      props.onSelect(THEME_NAMES[selectedIndex] ?? 'default')
    }
  }, { isActive: true })

  return (
    <Box borderStyle="round" borderColor={theme.palette.border} flexDirection="column" paddingX={1}>
      <Text color={theme.palette.accent}>Theme</Text>
      {THEME_NAMES.map((theme, index) => (
        <Text key={theme} color={index === selectedIndex ? previewRows[0]?.foreground : undefined}>
          {index === selectedIndex ? '› ' : '  '}
          {theme === props.activeTheme ? '*' : ' '}
          {' '}
          {theme} - {themePreview(theme)}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.palette.accent}>Preview</Text>
        {previewRows.map(row => (
          <Text
            key={row.label}
            color={row.foreground}
            backgroundColor={row.background}
            dimColor={row.dimColor}
          >
            {row.label}: {row.value}
          </Text>
        ))}
      </Box>
      <Text dimColor>Use ↑/↓, Home/End, Enter save, Esc cancel.</Text>
    </Box>
  )
}

function themePreview(theme: ThemeName): string {
  switch (theme) {
    case 'default':
      return 'terminal default colors'
    case 'dark':
      return 'high contrast on dark terminals'
    case 'light':
      return 'muted contrast on light terminals'
    case 'auto':
      return 'follow terminal color capability'
  }
}

function readThemeEnv(): Record<string, string | undefined> {
  return {
    COLORFGBG: process.env.COLORFGBG,
    COLORTERM: process.env.COLORTERM,
    TERM: process.env.TERM,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    LC_TERMINAL: process.env.LC_TERMINAL,
    TERMINAL_EMULATOR: process.env.TERMINAL_EMULATOR,
  }
}
