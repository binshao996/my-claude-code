import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const TodoWriteInputSchema = z.object({
  todos: z.array(
    z.object({
      id: z.string().min(1),
      content: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'completed']),
      priority: z.enum(['high', 'medium', 'low']).optional(),
    }),
  ),
})

type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>

export const todoWriteTool: Tool<TodoWriteInput> = {
  name: 'TodoWrite',
  description: 'Persist the current task todo list for this workspace session.',
  inputSchema: TodoWriteInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['id', 'content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions() {
    return { decision: 'allow' }
  },
  async execute(input, context) {
    const path = join(context.cwd, '.my-claude-code', 'todos', 'latest.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(input.todos, null, 2)}\n`, 'utf8')
    return `Updated ${input.todos.length} todo${input.todos.length === 1 ? '' : 's'}`
  },
}
