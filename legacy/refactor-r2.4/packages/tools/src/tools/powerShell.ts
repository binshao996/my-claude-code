import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const execFileAsync = promisify(execFile)
const MAX_POWERSHELL_OUTPUT_CHARS = 20_000

const PowerShellInputSchema = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().max(120_000).optional(),
})

type PowerShellInput = z.infer<typeof PowerShellInputSchema>

export const powerShellTool: Tool<PowerShellInput> = {
  name: 'PowerShell',
  description: 'Run a PowerShell command in the current workspace.',
  inputSchema: PowerShellInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'PowerShell command to run.' },
      timeout_ms: { type: 'number', description: 'Optional timeout in ms.' },
    },
    required: ['command'],
  },
  isReadOnly: input => isSafeReadOnlyPowerShellCommand(input.command),
  isDestructive: input => isDangerousPowerShellCommand(input.command),
  isConcurrencySafe: () => false,
  checkPermissions(input) {
    if (isDangerousPowerShellCommand(input.command)) {
      return {
        decision: 'deny',
        reason: `PowerShell command requires confirmation: ${input.command}`,
      }
    }

    if (isSafeReadOnlyPowerShellCommand(input.command)) {
      return { decision: 'allow' }
    }

    return {
      decision: 'ask',
      reason: `PowerShell command is not classified as read-only: ${input.command}`,
    }
  },
  async execute(input, context) {
    const shellPath = await findPowerShell()
    if (!shellPath) {
      return JSON.stringify({
        exitCode: 127,
        stdout: '',
        stderr: 'PowerShell is not available on this system.',
      })
    }

    try {
      const result = await execFileAsync(
        shellPath,
        ['-NoProfile', '-NonInteractive', '-Command', input.command],
        {
          cwd: context.cwd,
          timeout: input.timeout_ms ?? 30_000,
          maxBuffer: 1_000_000,
          signal: context.signal,
        },
      )
      return formatPowerShellResult(0, result.stdout, result.stderr)
    } catch (error) {
      const maybeError = error as {
        code?: number | string
        stdout?: string
        stderr?: string
        message?: string
      }
      return formatPowerShellResult(
        typeof maybeError.code === 'number' ? maybeError.code : 1,
        maybeError.stdout ?? '',
        maybeError.stderr ?? maybeError.message ?? String(error),
      )
    }
  },
}

async function findPowerShell(): Promise<string | null> {
  for (const command of ['pwsh', 'powershell']) {
    try {
      const result = await execFileAsync('which', [command], {
        timeout: 2_000,
        maxBuffer: 10_000,
      })
      const resolved = result.stdout.trim().split('\n')[0]
      if (resolved) {
        return resolved
      }
    } catch {
      // Try the next executable name.
    }
  }

  return null
}

function isDangerousPowerShellCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  return [
    /\bremove-item\b/,
    /\brm\b/,
    /\bdel\b/,
    /\berase\b/,
    /\bset-content\b/,
    /\bout-file\b/,
    />/,
    /\bnew-item\b/,
    /\bstart-process\b/,
    /\binvoke-expression\b/,
    /\biex\b/,
    /\binvoke-webrequest\b/,
    /\biwr\b/,
    /\binvoke-restmethod\b/,
    /\birm\b/,
  ].some(pattern => pattern.test(normalized))
}

function isSafeReadOnlyPowerShellCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  const statements = normalized.split(/\s*(?:;|\||\r?\n)\s*/).filter(Boolean)
  return statements.length > 0 && statements.every(isSafeReadOnlyStatement)
}

function isSafeReadOnlyStatement(statement: string): boolean {
  return [
    /^(get-location|pwd)(\s|$)/,
    /^(get-childitem|gci|ls|dir)(\s|$)/,
    /^(get-content|cat|type)(\s|$)/,
    /^(select-string|sls|findstr)(\s|$)/,
    /^(test-path|get-item|resolve-path|get-command|get-filehash|get-acl|format-hex)(\s|$)/,
    /^(get-process|get-service)(\s|$)/,
    /^(write-output|write-host|echo)(\s|$)/,
  ].some(pattern => pattern.test(statement))
}

function formatPowerShellResult(exitCode: number, stdout: string, stderr: string): string {
  return truncate(JSON.stringify({
    exitCode,
    stdout,
    stderr,
  }))
}

function truncate(value: string): string {
  if (value.length <= MAX_POWERSHELL_OUTPUT_CHARS) {
    return value
  }

  return `${value.slice(0, MAX_POWERSHELL_OUTPUT_CHARS)}\n[truncated: PowerShell output exceeded ${MAX_POWERSHELL_OUTPUT_CHARS} chars]`
}
