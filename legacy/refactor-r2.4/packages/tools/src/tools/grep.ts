import { readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { z } from 'zod/v4'
import { resolvePathInsideCwd } from '../pathSafety.js'
import type { Tool } from '../types.js'

const MAX_GREP_MATCHES = 100

const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  case_sensitive: z.boolean().optional(),
})

type GrepInput = z.infer<typeof GrepInputSchema>

export const grepTool: Tool<GrepInput> = {
  name: 'Grep',
  description: 'Search text files in the current workspace with a regular expression.',
  inputSchema: GrepInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search.' },
      path: { type: 'string', description: 'Optional file or directory.' },
      case_sensitive: { type: 'boolean', description: 'Use case-sensitive search.' },
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
    const regexp = new RegExp(input.pattern, input.case_sensitive ? 'u' : 'iu')
    const matches: string[] = []

    for (const file of files) {
      const content = await readFile(file, 'utf8').catch(() => undefined)
      if (content === undefined) {
        continue
      }

      const lines = content.split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if (regexp.test(line)) {
          matches.push(`${relative(context.cwd, file)}:${index + 1}:${line}`)
          if (matches.length >= MAX_GREP_MATCHES) {
            return `${matches.join('\n')}\n[truncated: reached ${MAX_GREP_MATCHES} matches]`
          }
        }
      }
    }

    return matches.length > 0 ? matches.join('\n') : 'No matches found'
  },
}

async function listFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined)
  if (!entries) {
    return [path]
  }

  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue
    }

    const child = resolve(path, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(child)))
    } else if (entry.isFile()) {
      files.push(child)
    }
  }

  return files
}
