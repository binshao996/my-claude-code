import { inspect } from 'node:util'
import vm from 'node:vm'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const ReplInputSchema = z.object({
  code: z.string().min(1),
  timeout_ms: z.number().int().positive().max(5_000).optional(),
})

type ReplInput = z.infer<typeof ReplInputSchema>

export const replTool: Tool<ReplInput> = {
  name: 'REPL',
  description: 'Execute JavaScript in a bounded local VM for small batch computations.',
  inputSchema: ReplInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript code to execute in the bounded REPL.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Optional timeout in ms, capped at 5000.',
      },
    },
    required: ['code'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions() {
    return {
      decision: 'ask',
      reason: 'REPL executes local code and requires confirmation',
    }
  },
  async execute(input) {
    const logs: string[] = []
    const sandbox = {
      console: {
        log: (...args: unknown[]) => logs.push(args.map(formatValue).join(' ')),
        error: (...args: unknown[]) => logs.push(args.map(formatValue).join(' ')),
      },
      Math,
      JSON,
      Date,
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      setTimeout: undefined,
      setInterval: undefined,
      fetch: undefined,
      process: undefined,
      require: undefined,
      Bun: undefined,
    }
    const context = vm.createContext(sandbox, {
      name: 'my-claude-code-repl',
      codeGeneration: { strings: false, wasm: false },
    })
    const script = new vm.Script(input.code, {
      filename: 'repl-input.js',
    })
    const result = script.runInContext(context, {
      timeout: input.timeout_ms ?? 1_000,
      displayErrors: true,
    })

    return JSON.stringify({
      result: formatValue(result),
      stdout: logs.join('\n'),
      tool_calls: 0,
    })
  },
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  return inspect(value, {
    depth: 4,
    breakLength: 120,
    maxArrayLength: 100,
  })
}
