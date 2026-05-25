import { stdin as defaultInput, stdout as defaultOutput } from 'node:process'
import { runInteractiveShell } from './interactiveShell.js'
import { runInkTui } from './runInkTui.js'
import type { TuiRuntimeOptions } from './tuiTypes.js'

export type TerminalAppOptions = TuiRuntimeOptions & {
  forceLineShell?: boolean
  forceInk?: boolean
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export async function runTerminalApp(
  options: TerminalAppOptions = {},
): Promise<void> {
  if (options.forceLineShell) {
    await runInteractiveShell(options)
    return
  }

  if (options.forceInk || isInteractiveTerminal(options)) {
    await runInkTui(options)
    return
  }

  await runInteractiveShell(options)
}

function isInteractiveTerminal(options: TerminalAppOptions): boolean {
  const input = options.input ?? defaultInput
  const output = options.output ?? defaultOutput

  return hasTTY(input) && hasTTY(output)
}

function hasTTY(stream: unknown): boolean {
  return Boolean(
    stream &&
      typeof stream === 'object' &&
      'isTTY' in stream &&
      stream.isTTY,
  )
}
