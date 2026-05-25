import { spawn } from 'node:child_process'

export type ClipboardCommand = {
  command: string
  args: string[]
}

export type ClipboardImage = {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  dataBase64: string
  byteLength: number
}

export type ClipboardImageCommand = ClipboardCommand & {
  mediaType: ClipboardImage['mediaType']
  output?: 'binary' | 'darwin-osascript-data'
}

export function clipboardCommandForPlatform(
  platform = process.platform,
): ClipboardCommand | undefined {
  switch (platform) {
    case 'darwin':
      return { command: 'pbcopy', args: [] }
    case 'win32':
      return { command: 'clip', args: [] }
    case 'linux':
      return { command: 'xclip', args: ['-selection', 'clipboard'] }
    default:
      return undefined
  }
}

export function imageClipboardCommandForPlatform(
  platform = process.platform,
): ClipboardImageCommand | undefined {
  switch (platform) {
    case 'darwin':
      return {
        command: 'osascript',
        args: [
          '-e',
          'try',
          '-e',
          'the clipboard as «class PNGf»',
          '-e',
          'on error',
          '-e',
          'return ""',
          '-e',
          'end try',
        ],
        mediaType: 'image/png',
        output: 'darwin-osascript-data',
      }
    case 'linux':
      return {
        command: 'xclip',
        args: ['-selection', 'clipboard', '-t', 'image/png', '-o'],
        mediaType: 'image/png',
        output: 'binary',
      }
    case 'win32':
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-Command',
          [
            'Add-Type -AssemblyName System.Windows.Forms;',
            'Add-Type -AssemblyName System.Drawing;',
            '$img=[Windows.Forms.Clipboard]::GetImage();',
            'if ($null -eq $img) { exit 2 }',
            '$ms=New-Object IO.MemoryStream;',
            '$img.Save($ms,[Drawing.Imaging.ImageFormat]::Png);',
            '[Console]::OpenStandardOutput().Write($ms.ToArray(),0,[int]$ms.Length)',
          ].join(' '),
        ],
        mediaType: 'image/png',
        output: 'binary',
      }
    default:
      return undefined
  }
}

export async function copyTextToSystemClipboard(
  text: string,
  command: ClipboardCommand | null = clipboardCommandForPlatform() ?? null,
): Promise<boolean> {
  if (!command) {
    return false
  }

  return new Promise(resolve => {
    const child = spawn(command.command, command.args, {
      stdio: ['pipe', 'ignore', 'ignore'],
    })

    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
    child.stdin.end(text)
  })
}

export async function readImageFromSystemClipboard(
  command: ClipboardImageCommand | null = imageClipboardCommandForPlatform() ?? null,
): Promise<ClipboardImage | undefined> {
  if (!command) {
    return undefined
  }

  const output = await spawnBuffered(command)
  if (!output || output.length === 0) {
    return undefined
  }

  const bytes = command.output === 'darwin-osascript-data'
    ? parseDarwinOsascriptData(output)
    : output
  if (!bytes || bytes.length === 0) {
    return undefined
  }

  return {
    mediaType: command.mediaType,
    dataBase64: bytes.toString('base64'),
    byteLength: bytes.length,
  }
}

async function spawnBuffered(command: ClipboardCommand): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    const child = spawn(command.command, command.args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    child.stdout.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.on('error', () => resolve(undefined))
    child.on('close', code => {
      resolve(code === 0 ? Buffer.concat(chunks) : undefined)
    })
  })
}

function parseDarwinOsascriptData(output: Buffer): Buffer | undefined {
  const text = output.toString('utf8').trim()
  const hex = text.match(/(?:«data PNGf)?([0-9A-Fa-f]{16,})(?:»)?/)?.[1]
  return hex ? Buffer.from(hex, 'hex') : undefined
}
