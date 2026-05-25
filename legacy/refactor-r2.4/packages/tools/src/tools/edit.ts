import { readFile, writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { z } from 'zod/v4'
import { resolveExistingPathInsideCwd } from '../pathSafety.js'
import type { Tool } from '../types.js'

const EditInputSchema = z.object({
  file_path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
})

type EditInput = z.infer<typeof EditInputSchema>

export const editTool: Tool<EditInput> = {
  name: 'Edit',
  description: 'Replace text in a UTF-8 file inside the current workspace.',
  inputSchema: EditInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to edit.' },
      old_string: { type: 'string', description: 'Existing text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  async checkPermissions(input, context) {
    await resolveExistingPathInsideCwd(context.cwd, input.file_path)
    return {
      decision: 'ask',
      reason: `Edit wants to modify ${input.file_path}`,
    }
  },
  async execute(input, context) {
    const filePath = await resolveExistingPathInsideCwd(context.cwd, input.file_path)
    const content = await readFile(filePath, 'utf8')
    const occurrences = countOccurrences(content, input.old_string)

    if (occurrences === 0) {
      throw new Error(`old_string was not found in ${input.file_path}`)
    }

    if (!input.replace_all && occurrences > 1) {
      throw new Error(
        `old_string appears ${occurrences} times; pass replace_all=true or make old_string unique`,
      )
    }

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string)
    await writeFile(filePath, updated, 'utf8')

    return `Edited ${relative(context.cwd, filePath)} (${input.replace_all ? occurrences : 1} replacement${occurrences === 1 ? '' : 's'})`
  },
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0

  while (true) {
    const next = content.indexOf(needle, index)
    if (next === -1) {
      return count
    }

    count += 1
    index = next + needle.length
  }
}
