import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { z } from 'zod/v4'
import { resolvePathInsideCwd } from '../pathSafety.js'
import type { Tool } from '../types.js'

const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
})

type GlobInput = z.infer<typeof GlobInputSchema>

export const globTool: Tool<GlobInput> = {
  name: 'Glob',
  description: 'Find files by a glob-like pattern in the current workspace.',
  inputSchema: GlobInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Pattern such as **/*.ts.' },
      path: { type: 'string', description: 'Optional directory to search.' },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context) {
    await resolvePathInsideCwd(context.cwd, input.path ?? '.')
    return { decision: 'allow' }
  },
  async execute(input, context) {
    const root = await resolvePathInsideCwd(context.cwd, input.path ?? '.')
    const files = await listFiles(root)
    const matcher = globToRegExp(input.pattern)
    const matches = files
      .map(file => normalizePath(relative(root, file)))
      .filter(file => matcher.test(file))
      .slice(0, 200)

    return matches.length > 0 ? matches.join('\n') : 'No files matched'
  },
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue
    }

    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)))
      continue
    }

    if (entry.isFile()) {
      files.push(path)
    }
  }

  return files
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('')
    .map(char => {
      if (char === '*') {
        return '*'
      }

      if (char === '?') {
        return '?'
      }

      return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char
    })
    .join('')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
    .replaceAll('?', '[^/]')

  return new RegExp(`^${escaped}$`)
}

function normalizePath(path: string): string {
  return path.split('\\').join('/')
}
