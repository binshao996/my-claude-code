import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEVELOPMENT_ENV_FILES = ['.env', '.env.local'] as const

export type LoadDevelopmentEnvOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  nodeEnv?: string
}

export type LoadDevelopmentEnvResult = {
  mode: 'development' | 'production'
  files: string[]
  keys: string[]
}

export function loadDevelopmentEnv(
  options: LoadDevelopmentEnvOptions = {},
): LoadDevelopmentEnvResult {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV

  if (nodeEnv === 'production') {
    return {
      mode: 'production',
      files: [],
      keys: [],
    }
  }

  const protectedKeys = new Set(Object.keys(env))
  const loadedFiles: string[] = []
  const loadedKeys = new Set<string>()

  for (const fileName of DEVELOPMENT_ENV_FILES) {
    const filePath = join(cwd, fileName)
    if (!existsSync(filePath)) {
      continue
    }

    loadedFiles.push(fileName)
    const parsed = parseDotEnv(readFileSync(filePath, 'utf8'))

    for (const [key, value] of Object.entries(parsed)) {
      if (protectedKeys.has(key)) {
        continue
      }

      env[key] = value
      loadedKeys.add(key)
    }
  }

  return {
    mode: 'development',
    files: loadedFiles,
    keys: [...loadedKeys].sort(),
  }
}

export function parseDotEnv(source: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const line of source.split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line)
    if (!parsed) {
      continue
    }

    result[parsed.key] = parsed.value
  }

  return result
}

function parseDotEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return null
  }

  const equalsIndex = trimmed.indexOf('=')
  if (equalsIndex === -1) {
    return null
  }

  const key = trimmed.slice(0, equalsIndex).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null
  }

  const rawValue = trimmed.slice(equalsIndex + 1).trim()

  return {
    key,
    value: parseDotEnvValue(rawValue),
  }
}

function parseDotEnvValue(rawValue: string): string {
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
  }

  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1)
  }

  const commentIndex = rawValue.indexOf(' #')
  if (commentIndex === -1) {
    return rawValue
  }

  return rawValue.slice(0, commentIndex).trimEnd()
}
