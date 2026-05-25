import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import {
  type Settings,
  type SettingsSourceKind,
  loadSettingsWithSources,
  saveProjectSettings,
  SettingsSchema,
} from './settings.js'

const SYNC_VERSION = 1

export const SettingsSyncSnapshotSchema = z.object({
  version: z.literal(SYNC_VERSION),
  generatedAt: z.string(),
  entries: z.record(z.string(), SettingsSchema),
}).strip()

export type SettingsSyncSnapshot = z.infer<typeof SettingsSyncSnapshotSchema>

export type SettingsSyncResult = {
  path: string
  entryCount: number
  entries: string[]
  settings?: Settings
}

export function defaultSettingsSyncPath(cwd = process.cwd()): string {
  return join(cwd, '.my-claude-code', 'settings-sync.json')
}

export async function uploadUserSettingsSnapshot(args: {
  cwd: string
  path?: string
  env?: Record<string, string | undefined>
  now?: Date
}): Promise<SettingsSyncResult> {
  const path = args.path ?? defaultSettingsSyncPath(args.cwd)
  const loaded = await loadSettingsWithSources(args.cwd, args.env)
  const entries = Object.fromEntries(
    loaded.sources
      .filter(source => source.exists && source.settings && isSyncableSource(source.kind))
      .map(source => [source.kind, source.settings as Settings]),
  )
  const snapshot: SettingsSyncSnapshot = {
    version: SYNC_VERSION,
    generatedAt: (args.now ?? new Date()).toISOString(),
    entries,
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  return {
    path,
    entryCount: Object.keys(entries).length,
    entries: Object.keys(entries).sort(),
  }
}

export async function downloadUserSettingsSnapshot(args: {
  cwd: string
  path?: string
}): Promise<SettingsSyncResult> {
  const path = args.path ?? defaultSettingsSyncPath(args.cwd)
  const snapshot = SettingsSyncSnapshotSchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  )
  const settings = mergeSettingsEntries(snapshot.entries)
  await saveProjectSettings(args.cwd, settings)
  return {
    path,
    entryCount: Object.keys(snapshot.entries).length,
    entries: Object.keys(snapshot.entries).sort(),
    settings,
  }
}

function isSyncableSource(kind: SettingsSourceKind): boolean {
  return kind === 'user' || kind === 'claude-project' || kind === 'project'
}

function mergeSettingsEntries(entries: Record<string, Settings>): Settings {
  const merged: Settings = {}
  for (const kind of ['user', 'claude-project', 'project']) {
    const settings = entries[kind]
    if (!settings) {
      continue
    }
    const allowedTools = merged.allowedTools
    const disallowedTools = merged.disallowedTools
    Object.assign(merged, settings)
    merged.allowedTools = mergeRules(allowedTools, settings.allowedTools)
    merged.disallowedTools = mergeRules(
      disallowedTools,
      settings.disallowedTools,
    )
  }
  return merged
}

function mergeRules(
  base: string[] | undefined,
  overlay: string[] | undefined,
): string[] | undefined {
  if (!base && !overlay) {
    return undefined
  }
  return [...new Set([...(base ?? []), ...(overlay ?? [])])]
}
