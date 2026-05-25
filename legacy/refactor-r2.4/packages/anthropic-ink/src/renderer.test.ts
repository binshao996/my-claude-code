import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'bun:test'
import { normalizeRenderOptions } from './renderer.js'

describe('@anthropic/ink renderer compatibility', () => {
  it('drops undefined streams so Ink can keep its process defaults', () => {
    expect(normalizeRenderOptions({
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      exitOnCtrlC: false,
      patchConsole: false,
    })).toEqual({
      exitOnCtrlC: false,
      patchConsole: false,
    })
  })

  it('preserves explicitly supplied streams', () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream

    expect(normalizeRenderOptions({
      stdout,
      patchConsole: false,
    })).toEqual({
      stdout,
      patchConsole: false,
    })
  })
})
