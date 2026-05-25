import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { z } from 'zod/v4'
import { resolvePathInsideCwd } from '../pathSafety.js'
import type { Tool } from '../types.js'

const WriteInputSchema = z.object({
  file_path: z.string().min(1),
  content: z.string(),
})

type WriteInput = z.infer<typeof WriteInputSchema>

export const writeTool: Tool<WriteInput> = {
  name: 'Write',
  description: 'Write a UTF-8 text file inside the current workspace.',
  inputSchema: WriteInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to write.' },
      content: { type: 'string', description: 'Complete file content.' },
    },
    required: ['file_path', 'content'],
  },
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  async checkPermissions(input, context) {
    await resolvePathInsideCwd(context.cwd, input.file_path)
    return {
      decision: 'ask',
      reason: `Write wants to modify ${input.file_path}`,
    }
  },
  async execute(input, context) {
    const filePath = await resolvePathInsideCwd(context.cwd, input.file_path)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, input.content, 'utf8')
    return `Wrote ${relative(context.cwd, filePath)}`
  },
}
