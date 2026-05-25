import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const execAsync = promisify(exec)
const MAX_BASH_OUTPUT_CHARS = 20_000

const BashInputSchema = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().max(120_000).optional(),
})

type BashInput = z.infer<typeof BashInputSchema>

export const bashTool: Tool<BashInput> = {
  name: 'Bash',
  description: 'Run a shell command in the current workspace.',
  inputSchema: BashInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run.' },
      timeout_ms: { type: 'number', description: 'Optional timeout in ms.' },
    },
    required: ['command'],
  },
  isReadOnly: input => isSafeReadOnlyCommand(input.command),
  isDestructive: input => isDangerousCommand(input.command),
  isConcurrencySafe: () => false,
  checkPermissions(input) {
    if (isDangerousCommand(input.command)) {
      return {
        decision: 'deny',
        reason: `Bash command requires confirmation: ${input.command}`,
      }
    }

    if (isSafeReadOnlyCommand(input.command)) {
      return { decision: 'allow' }
    }

    return {
      decision: 'ask',
      reason: `Bash command is not classified as read-only: ${input.command}`,
    }
  },
  async execute(input, context) {
    const result = await execAsync(input.command, {
      cwd: context.cwd,
      timeout: input.timeout_ms ?? 30_000,
      maxBuffer: 1_000_000,
      signal: context.signal,
    })
    return truncate(formatBashResult(result.stdout, result.stderr))
  },
}

function isDangerousCommand(command: string): boolean {
  const normalized = command.trim()
  return [
    /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/,
    /\bsudo\b/,
    /\bchmod\s+-R\b/,
    /\bchown\s+-R\b/,
    /\bmkfs\b/,
    /\bdd\s+.*\bof=/,
    />\s*\/dev\/sd[a-z]/,
    /:\(\)\s*\{\s*:\|:/,
  ].some(pattern => pattern.test(normalized))
}

function isSafeReadOnlyCommand(command: string): boolean {
  const normalized = command.trim()
  return [
    /^pwd$/,
    /^ls(\s|$)/,
    /^cat\s+/,
    /^sed\s+-n\s+/,
    /^grep\s+/,
    /^rg(\s|$)/,
    /^find\s+/,
    /^git\s+(status|diff|log|show)(\s|$)/,
    /^bun\s+(test|run\s+test)(\s|$)/,
    /^pnpm\s+(test|run\s+test)(\s|$)/,
    /^npm\s+(test|run\s+test)(\s|$)/,
  ].some(pattern => pattern.test(normalized))
}

function formatBashResult(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return `stdout:\n${stdout}\nstderr:\n${stderr}`
  }

  if (stdout) {
    return stdout
  }

  if (stderr) {
    return `stderr:\n${stderr}`
  }

  return '(no output)'
}

function truncate(value: string): string {
  if (value.length <= MAX_BASH_OUTPUT_CHARS) {
    return value
  }

  return `${value.slice(0, MAX_BASH_OUTPUT_CHARS)}\n[truncated: Bash output exceeded ${MAX_BASH_OUTPUT_CHARS} chars]`
}
