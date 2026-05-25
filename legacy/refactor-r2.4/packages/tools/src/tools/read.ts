import { readFile } from 'node:fs/promises'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'
import { resolveExistingPathInsideCwd } from '../pathSafety.js'

const MAX_READ_RESULT_CHARS = 20_000

const ReadInputSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
})

type ReadInput = z.infer<typeof ReadInputSchema>

export const readTool: Tool<ReadInput> = {
  name: 'Read',
  description: 'Read a UTF-8 text file from the current workspace.',
  inputSchema: ReadInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to read.' },
      offset: { type: 'number', description: '1-based line offset.' },
      limit: { type: 'number', description: 'Maximum number of lines.' },
    },
    required: ['file_path'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context) {
    await resolveExistingPathInsideCwd(context.cwd, input.file_path)
    return { decision: 'allow' }
  },
  async execute(input, context) {
    const filePath = await resolveExistingPathInsideCwd(context.cwd, input.file_path)
    const content = await readFile(filePath, 'utf8')
    const lines = content.split(/\r?\n/)
    const startIndex = Math.max((input.offset ?? 1) - 1, 0)
    const selectedLines =
      input.limit === undefined
        ? lines.slice(startIndex)
        : lines.slice(startIndex, startIndex + input.limit)
    const numbered = selectedLines
      .map((line, index) => `${startIndex + index + 1}\t${line}`)
      .join('\n')

    if (numbered.length <= MAX_READ_RESULT_CHARS) {
      return numbered
    }

    return `${numbered.slice(0, MAX_READ_RESULT_CHARS)}\n[truncated: Read output exceeded ${MAX_READ_RESULT_CHARS} chars]`
  },
}
