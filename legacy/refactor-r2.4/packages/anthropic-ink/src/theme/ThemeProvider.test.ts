import { describe, expect, it } from 'bun:test'
import { createThemeState } from './ThemeProvider.js'

describe('@anthropic/ink ThemeProvider state', () => {
  it('resolves active and preview themes through one global state model', () => {
    expect(createThemeState({
      activeTheme: 'auto',
      env: { COLORFGBG: '0;15' },
    })).toMatchObject({
      activeTheme: 'auto',
      resolvedTheme: 'light',
      palette: {
        name: 'light',
      },
    })

    expect(createThemeState({
      activeTheme: 'light',
      previewTheme: 'dark',
    })).toMatchObject({
      activeTheme: 'light',
      previewTheme: 'dark',
      resolvedTheme: 'dark',
      palette: {
        name: 'dark',
      },
    })
  })
})
