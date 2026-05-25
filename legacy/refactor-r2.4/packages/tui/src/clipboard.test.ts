import { describe, expect, it } from 'bun:test'
import {
  clipboardCommandForPlatform,
  copyTextToSystemClipboard,
  imageClipboardCommandForPlatform,
  readImageFromSystemClipboard,
} from './clipboard.js'

describe('system clipboard helpers', () => {
  it('selects the platform clipboard command', () => {
    expect(clipboardCommandForPlatform('darwin')).toEqual({
      command: 'pbcopy',
      args: [],
    })
    expect(clipboardCommandForPlatform('win32')).toEqual({
      command: 'clip',
      args: [],
    })
    expect(clipboardCommandForPlatform('freebsd')).toBeUndefined()
  })

  it('reports false when no clipboard command is available', async () => {
    await expect(copyTextToSystemClipboard('hello', null)).resolves.toBe(false)
  })

  it('selects native image clipboard commands', () => {
    expect(imageClipboardCommandForPlatform('darwin')?.command).toBe('osascript')
    expect(imageClipboardCommandForPlatform('linux')).toMatchObject({
      command: 'xclip',
      mediaType: 'image/png',
    })
    expect(imageClipboardCommandForPlatform('freebsd')).toBeUndefined()
  })

  it('reads image clipboard bytes through an injected command', async () => {
    await expect(readImageFromSystemClipboard({
      command: 'printf',
      args: ['png-bytes'],
      mediaType: 'image/png',
      output: 'binary',
    })).resolves.toMatchObject({
      mediaType: 'image/png',
      dataBase64: Buffer.from('png-bytes').toString('base64'),
      byteLength: 9,
    })
  })
})
