import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod/v4'
import { resolveExistingPathInsideCwd } from '../pathSafety.js'
import type { Tool } from '../types.js'

const MAX_SEND_FILE_PREVIEW_CHARS = 4_000

const SendUserFileInputSchema = z.object({
  file_path: z.string().min(1),
  description: z.string().optional(),
})

type SendUserFileInput = z.infer<typeof SendUserFileInputSchema>

export const sendUserFileTool: Tool<SendUserFileInput> = {
  name: 'SendUserFile',
  description: 'Prepare a workspace file for user delivery and return a bounded preview.',
  inputSchema: SendUserFileInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to send.' },
      description: { type: 'string', description: 'Optional description of the file.' },
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
  execute: async (input, context) => {
    const path = await resolveExistingPathInsideCwd(context.cwd, input.file_path)
    const fileStat = await stat(path)
    if (!fileStat.isFile()) {
      return JSON.stringify({
        sent: false,
        file_path: path,
        error: 'Path is not a file.',
      }, null, 2)
    }
    const content = await readFile(path)
    const text = content.toString('utf8')
    return JSON.stringify({
      sent: true,
      file_path: path,
      description: input.description,
      bytes: fileStat.size,
      preview: text.length > MAX_SEND_FILE_PREVIEW_CHARS
        ? `${text.slice(0, MAX_SEND_FILE_PREVIEW_CHARS)}\n[truncated: SendUserFile preview exceeded ${MAX_SEND_FILE_PREVIEW_CHARS} chars]`
        : text,
    }, null, 2)
  },
}
