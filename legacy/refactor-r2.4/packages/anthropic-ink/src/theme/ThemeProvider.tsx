import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  getThemePalette,
  resolveTheme,
  type ResolvedThemeName,
  type ThemeEnv,
  type ThemePalette,
  type ThemeSetting,
} from './theme.js'

export type ThemeState = {
  activeTheme: ThemeSetting
  previewTheme?: ThemeSetting
  resolvedTheme: ResolvedThemeName
  palette: ThemePalette
}

export type ThemeController = ThemeState & {
  setActiveTheme(theme: ThemeSetting): void
  setPreviewTheme(theme: ThemeSetting | undefined): void
}

const ThemeContext = createContext<ThemeController | undefined>(undefined)

export function ThemeProvider(
  props: PropsWithChildren<{
    activeTheme?: ThemeSetting
    env?: ThemeEnv
  }>,
) {
  const [activeTheme, setActiveTheme] = useState<ThemeSetting>(
    props.activeTheme ?? 'default',
  )
  const [previewTheme, setPreviewTheme] = useState<ThemeSetting | undefined>()
  useEffect(() => {
    setActiveTheme(props.activeTheme ?? 'default')
  }, [props.activeTheme])

  const value = useMemo(
    () => createThemeController({
      activeTheme,
      previewTheme,
      env: props.env,
      setActiveTheme,
      setPreviewTheme,
    }),
    [activeTheme, previewTheme, props.env],
  )

  return (
    <ThemeContext.Provider value={value}>
      {props.children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeState {
  return useThemeController()
}

export function useThemeController(): ThemeController {
  const context = useContext(ThemeContext)
  if (!context) {
    return createThemeController({
      activeTheme: 'default',
      setActiveTheme: () => {},
      setPreviewTheme: () => {},
    })
  }

  return context
}

export function createThemeState(args: {
  activeTheme?: ThemeSetting
  previewTheme?: ThemeSetting
  env?: ThemeEnv
}): ThemeState {
  const activeTheme = args.activeTheme ?? 'default'
  const effectiveTheme = args.previewTheme ?? activeTheme
  const resolvedTheme = resolveTheme(effectiveTheme, args.env)

  return {
    activeTheme,
    previewTheme: args.previewTheme,
    resolvedTheme,
    palette: getThemePalette(resolvedTheme),
  }
}

function createThemeController(args: {
  activeTheme: ThemeSetting
  previewTheme?: ThemeSetting
  env?: ThemeEnv
  setActiveTheme(theme: ThemeSetting): void
  setPreviewTheme(theme: ThemeSetting | undefined): void
}): ThemeController {
  return {
    ...createThemeState(args),
    setActiveTheme: args.setActiveTheme,
    setPreviewTheme: args.setPreviewTheme,
  }
}
