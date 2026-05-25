export type ThemeSetting = 'default' | 'dark' | 'light' | 'auto'
export type ResolvedThemeName = Exclude<ThemeSetting, 'auto'>

export type ThemePalette = {
  name: ResolvedThemeName
  foreground: string | undefined
  background: string | undefined
  muted: string
  accent: string
  border: string
  success: string
  warning: string
  error: string
  selection: string
}

export type ThemePreviewRow = {
  label: string
  value: string
  foreground?: string
  background?: string
  dimColor?: boolean
}

export type ThemeEnv = Record<string, string | undefined>

const THEME_DESCRIPTIONS = {
  default: 'terminal default colors',
  dark: 'high contrast on dark terminals',
  light: 'muted contrast on light terminals',
  auto: 'follow terminal color capability',
} satisfies Record<ThemeSetting, string>

const THEME_PALETTES = {
  default: {
    name: 'default',
    foreground: undefined,
    background: undefined,
    muted: 'gray',
    accent: 'cyan',
    border: 'gray',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    selection: 'cyan',
  },
  dark: {
    name: 'dark',
    foreground: '#f8fafc',
    background: '#020617',
    muted: '#94a3b8',
    accent: '#38bdf8',
    border: '#334155',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
    selection: '#0e7490',
  },
  light: {
    name: 'light',
    foreground: '#111827',
    background: '#ffffff',
    muted: '#6b7280',
    accent: '#2563eb',
    border: '#d1d5db',
    success: '#15803d',
    warning: '#b45309',
    error: '#b91c1c',
    selection: '#bfdbfe',
  },
} satisfies Record<ResolvedThemeName, ThemePalette>

export function resolveTheme(
  setting: ThemeSetting = 'default',
  env: ThemeEnv = {},
): ResolvedThemeName {
  if (setting !== 'auto') {
    return setting
  }

  return (
    resolveColorFgBg(env.COLORFGBG) ??
    resolveThemeKeyword(env.TERM_PROGRAM) ??
    resolveThemeKeyword(env.COLORTERM) ??
    resolveThemeKeyword(env.TERM) ??
    resolveThemeKeyword(env.LC_TERMINAL) ??
    resolveThemeKeyword(env.TERMINAL_EMULATOR) ??
    'default'
  )
}

export function getThemePalette(name: ResolvedThemeName): ThemePalette {
  return THEME_PALETTES[name] ?? THEME_PALETTES.default
}

export function themePreviewRows(
  theme: ThemeSetting,
  env: ThemeEnv = {},
): ThemePreviewRow[] {
  const resolvedTheme = resolveTheme(theme, env)
  const palette = getThemePalette(resolvedTheme)
  const themeValue = theme === 'auto' ? `${theme} -> ${resolvedTheme}` : theme

  return [
    {
      label: 'theme',
      value: themeValue,
      foreground: palette.accent,
      background: palette.background,
    },
    {
      label: 'description',
      value: THEME_DESCRIPTIONS[theme],
      foreground: palette.muted,
      background: palette.background,
    },
    {
      label: 'text',
      value: 'Readable foreground text',
      foreground: palette.foreground,
      background: palette.background,
    },
    {
      label: 'muted',
      value: 'Secondary helper text',
      foreground: palette.muted,
      background: palette.background,
      dimColor: true,
    },
    {
      label: 'accent',
      value: 'Highlighted action',
      foreground: palette.accent,
      background: palette.background,
    },
    {
      label: 'success',
      value: 'Success state',
      foreground: palette.success,
      background: palette.background,
    },
    {
      label: 'warning',
      value: 'Warning state',
      foreground: palette.warning,
      background: palette.background,
    },
    {
      label: 'error',
      value: 'Error state',
      foreground: palette.error,
      background: palette.background,
    },
  ]
}

function resolveThemeKeyword(value: string | undefined): ResolvedThemeName | undefined {
  if (!value) {
    return undefined
  }

  const tokens = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.some(token => token === 'dark' || token === 'black' || token === 'night')) {
    return 'dark'
  }
  if (tokens.some(token => token === 'light' || token === 'white' || token === 'day')) {
    return 'light'
  }

  return undefined
}

function resolveColorFgBg(value: string | undefined): ResolvedThemeName | undefined {
  if (!value) {
    return undefined
  }

  const background = value
    .split(/[;:]/)
    .map(part => Number.parseInt(part, 10))
    .filter(Number.isFinite)
    .at(-1)

  if (background === undefined) {
    return undefined
  }

  if (background >= 0 && background <= 15) {
    return background <= 6 || background === 8 ? 'dark' : 'light'
  }

  if (background >= 16 && background <= 231) {
    return resolveXtermColorCube(background)
  }

  if (background >= 232 && background <= 255) {
    return background < 244 ? 'dark' : 'light'
  }

  return undefined
}

function resolveXtermColorCube(colorIndex: number): ResolvedThemeName {
  const cubeIndex = colorIndex - 16
  const red = Math.floor(cubeIndex / 36)
  const green = Math.floor((cubeIndex % 36) / 6)
  const blue = cubeIndex % 6
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 5

  return luminance < 0.5 ? 'dark' : 'light'
}
