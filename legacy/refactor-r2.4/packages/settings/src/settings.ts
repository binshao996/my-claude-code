import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'

export const THEME_NAMES = ['default', 'dark', 'light', 'auto'] as const
export const ThemeNameSchema = z.enum(THEME_NAMES)
export type ThemeName = z.infer<typeof ThemeNameSchema>

export const OUTPUT_STYLE_NAMES = ['default', 'Explanatory', 'Learning'] as const
export const OutputStyleNameSchema = z.enum(OUTPUT_STYLE_NAMES)
export type OutputStyleName = z.infer<typeof OutputStyleNameSchema>

export const SettingsSchema = z.object({
  model: z.string().min(1).optional(),
  permissionMode: z
    .enum(['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'])
    .optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  disallowedTools: z.array(z.string().min(1)).optional(),
  theme: ThemeNameSchema.optional(),
  outputStyle: OutputStyleNameSchema.optional(),
  vimMode: z.boolean().optional(),
}).strip()

export type Settings = z.infer<typeof SettingsSchema>

export type SettingsSourceKind =
  | 'user'
  | 'claude-project'
  | 'project'
  | 'local'
  | 'managed'

export type SettingsSource = {
  kind: SettingsSourceKind
  path: string
  exists: boolean
  settings?: Settings
}

export type LoadedSettings = {
  settings: Settings
  sources: SettingsSource[]
}

export function projectSettingsPath(cwd = process.cwd()): string {
  return join(cwd, '.my-claude-code', 'settings.json')
}

export function localProjectSettingsPath(cwd = process.cwd()): string {
  return join(cwd, '.my-claude-code', 'settings.local.json')
}

export function userSettingsPath(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.HOME ? join(env.HOME, '.my-claude-code', 'settings.json') : undefined
}

export function managedSettingsPath(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.MY_CLAUDE_CODE_MANAGED_SETTINGS_PATH
}

export function settingsSourceCandidates(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Array<{ kind: SettingsSourceKind; path: string }> {
  return [
    userSettingsPath(env)
      ? { kind: 'user' as const, path: userSettingsPath(env) as string }
      : undefined,
    { kind: 'claude-project' as const, path: join(cwd, '.claude', 'settings.json') },
    { kind: 'project' as const, path: projectSettingsPath(cwd) },
    { kind: 'local' as const, path: localProjectSettingsPath(cwd) },
    managedSettingsPath(env)
      ? { kind: 'managed' as const, path: managedSettingsPath(env) as string }
      : undefined,
  ].filter((source): source is { kind: SettingsSourceKind; path: string } =>
    Boolean(source),
  )
}

export async function loadSettings(cwd = process.cwd()): Promise<Settings> {
  return (await loadSettingsWithSources(cwd)).settings
}

export async function loadSettingsWithSources(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedSettings> {
  let settings: Settings = {}
  const sources: SettingsSource[] = []

  for (const candidate of settingsSourceCandidates(cwd, env)) {
    const source = await readSettingsSource(candidate.kind, candidate.path)
    sources.push(source)
    if (source.settings) {
      settings = mergeSettings(settings, source.settings)
    }
  }

  return { settings, sources }
}

export async function saveProjectSettings(
  cwd: string,
  settings: Settings,
): Promise<Settings> {
  const parsed = SettingsSchema.parse(settings)
  const path = projectSettingsPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return parsed
}

export async function updateProjectSettings(
  cwd: string,
  updater: (settings: Settings) => Settings,
): Promise<Settings> {
  const current = await readSettingsFile(projectSettingsPath(cwd))
  return saveProjectSettings(cwd, updater(current))
}

export async function setProjectSetting<Key extends keyof Settings>(
  cwd: string,
  key: Key,
  value: Settings[Key],
): Promise<Settings> {
  return updateProjectSettings(cwd, current => ({
    ...current,
    [key]: value,
  }))
}

export async function appendProjectSettingsRule(
  cwd: string,
  field: 'allowedTools' | 'disallowedTools',
  rule: string,
): Promise<Settings> {
  const effective = await loadSettings(cwd)
  const nextRules = uniqueRules([...(effective[field] ?? []), rule])

  return updateProjectSettings(cwd, current => ({
    ...current,
    [field]: nextRules,
  }))
}

async function readSettingsFile(path: string): Promise<Settings> {
  return (await readSettingsSource('project', path)).settings ?? {}
}

async function readSettingsSource(
  kind: SettingsSourceKind,
  path: string,
): Promise<SettingsSource> {
  try {
    const settings = SettingsSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    return {
      kind,
      path,
      exists: true,
      settings,
    }
  } catch (error) {
    if (isNotFound(error)) {
      return {
        kind,
        path,
        exists: false,
      }
    }

    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function uniqueRules(rules: string[]): string[] {
  return [...new Set(rules)]
}

function mergeSettings(base: Settings, overlay: Settings): Settings {
  return {
    ...base,
    ...overlay,
    allowedTools: mergeRules(base.allowedTools, overlay.allowedTools),
    disallowedTools: mergeRules(base.disallowedTools, overlay.disallowedTools),
  }
}

function mergeRules(
  base: string[] | undefined,
  overlay: string[] | undefined,
): string[] | undefined {
  if (!base && !overlay) {
    return undefined
  }

  return uniqueRules([...(base ?? []), ...(overlay ?? [])])
}
