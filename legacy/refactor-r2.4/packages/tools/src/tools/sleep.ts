import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const SleepInputSchema = z.object({
  duration_seconds: z.number().positive().max(3600),
})

type SleepInput = z.infer<typeof SleepInputSchema>

export const sleepTool: Tool<SleepInput> = {
  name: 'Sleep',
  description: 'Wait for a specified duration without holding a shell process.',
  inputSchema: SleepInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      duration_seconds: {
        type: 'number',
        description: 'How long to sleep in seconds.',
      },
    },
    required: ['duration_seconds'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async (input, context) => {
    const startedAt = Date.now()
    const durationMs = Math.ceil(input.duration_seconds * 1000)
    const interrupted = await waitForSleep(durationMs, context.signal)
    const sleptSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
    return JSON.stringify({
      slept_seconds: sleptSeconds,
      interrupted,
    }, null, 2)
  },
}

function waitForSleep(durationMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(true)
  }
  return new Promise(resolve => {
    let settled = false
    const finish = (interrupted: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(interrupted)
    }
    const onAbort = () => finish(true)
    const timer = setTimeout(() => finish(false), durationMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
