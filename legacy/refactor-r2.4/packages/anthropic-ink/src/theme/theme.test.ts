import { describe, expect, it } from 'bun:test'
import {
  getThemePalette,
  resolveTheme,
  themePreviewRows,
  type ThemePalette,
} from './theme.js'

describe('@anthropic/ink theme core', () => {
  it('resolves explicit theme settings without reading the environment', () => {
    expect(resolveTheme('default', { COLORFGBG: '0;15' })).toBe('default')
    expect(resolveTheme('dark', { COLORFGBG: '0;15' })).toBe('dark')
    expect(resolveTheme('light', { COLORFGBG: '15;0' })).toBe('light')
  })

  it('resolves auto to dark from COLORFGBG and COLORTERM hints', () => {
    expect(resolveTheme('auto', { COLORFGBG: '15;0' })).toBe('dark')
    expect(resolveTheme('auto', { COLORTERM: 'truecolor-dark' })).toBe('dark')
  })

  it('resolves auto to light from COLORFGBG and TERM_PROGRAM hints', () => {
    expect(resolveTheme('auto', { COLORFGBG: '0;15' })).toBe('light')
    expect(resolveTheme('auto', { TERM_PROGRAM: 'light-terminal' })).toBe('light')
  })

  it('falls back to the default theme when auto has no useful terminal hint', () => {
    expect(resolveTheme('auto', {
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'vscode',
    })).toBe('default')
  })

  it('returns palettes with the shared color fields', () => {
    const expectedFields = [
      'name',
      'foreground',
      'background',
      'muted',
      'accent',
      'border',
      'success',
      'warning',
      'error',
      'selection',
    ].sort()

    for (const name of ['default', 'dark', 'light'] as const) {
      const palette = getThemePalette(name)
      expect(Object.keys(palette).sort()).toEqual(expectedFields)
      expect(palette.name).toBe(name)
      expect(palette.accent).toBeString()
      expect(palette.error).toBeString()
    }
  })

  it('builds structured preview rows from the resolved palette', () => {
    const palette: ThemePalette = getThemePalette('dark')
    const rows = themePreviewRows('auto', { COLORFGBG: '15;0' })

    expect(rows).toEqual(
      expect.arrayContaining([
        {
          label: 'theme',
          value: 'auto -> dark',
          foreground: palette.accent,
          background: palette.background,
        },
        {
          label: 'description',
          value: 'follow terminal color capability',
          foreground: palette.muted,
          background: palette.background,
        },
        {
          label: 'error',
          value: 'Error state',
          foreground: palette.error,
          background: palette.background,
        },
      ]),
    )
    expect(rows.map(row => row.label)).toEqual([
      'theme',
      'description',
      'text',
      'muted',
      'accent',
      'success',
      'warning',
      'error',
    ])
  })
})
