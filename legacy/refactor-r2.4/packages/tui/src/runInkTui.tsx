import { AlternateScreen, render } from '@anthropic/ink'
import { TuiApp } from './TuiApp.js'
import type { TuiRuntimeOptions } from './tuiTypes.js'

export async function runInkTui(options: TuiRuntimeOptions = {}): Promise<void> {
  const instance = render(
    <AlternateScreen mouseTracking>
      <TuiApp options={options} />
    </AlternateScreen>,
    {
      stdin: options.input as NodeJS.ReadStream | undefined,
      stdout: options.output as NodeJS.WriteStream | undefined,
      stderr: options.output as NodeJS.WriteStream | undefined,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  await instance.waitUntilExit()
}
