import type { Key } from 'ink'

export type KeybindingContextName =
  | 'App'
  | 'Chat'
  | 'Autocomplete'
  | 'Scroll'
  | 'Select'
  | 'ThemePicker'
  | 'HistorySearch'
  | 'Vim'

export type KeybindingAction = string

export type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type Chord = ParsedKeystroke[]

export type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, KeybindingAction>
}

export type ParsedBinding = {
  chord: Chord
  action: KeybindingAction
  context: KeybindingContextName
}

export function parseKeystroke(input: string): ParsedKeystroke {
  const parts = input.split('+')
  const keystroke: ParsedKeystroke = {
    key: '',
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    super: false,
  }

  for (const part of parts) {
    const lower = part.toLowerCase()
    switch (lower) {
      case 'ctrl':
      case 'control':
        keystroke.ctrl = true
        break
      case 'alt':
      case 'opt':
      case 'option':
        keystroke.alt = true
        break
      case 'shift':
        keystroke.shift = true
        break
      case 'meta':
        keystroke.meta = true
        break
      case 'cmd':
      case 'command':
      case 'super':
      case 'win':
        keystroke.super = true
        break
      case 'esc':
        keystroke.key = 'escape'
        break
      case 'return':
        keystroke.key = 'enter'
        break
      case 'space':
        keystroke.key = ' '
        break
      case '↑':
        keystroke.key = 'up'
        break
      case '↓':
        keystroke.key = 'down'
        break
      case '←':
        keystroke.key = 'left'
        break
      case '→':
        keystroke.key = 'right'
        break
      default:
        keystroke.key = lower
        break
    }
  }

  return keystroke
}

export function parseChord(input: string): Chord {
  if (input === ' ') {
    return [parseKeystroke('space')]
  }

  return input.trim().split(/\s+/).map(parseKeystroke)
}

export function keystrokeToString(keystroke: ParsedKeystroke): string {
  const parts: string[] = []
  if (keystroke.ctrl) parts.push('ctrl')
  if (keystroke.alt) parts.push('alt')
  if (keystroke.shift) parts.push('shift')
  if (keystroke.meta) parts.push('meta')
  if (keystroke.super) parts.push('cmd')
  parts.push(keyToDisplayName(keystroke.key))
  return parts.join('+')
}

export function chordToString(chord: Chord): string {
  return chord.map(keystrokeToString).join(' ')
}

export function keystrokeToDisplayString(
  keystroke: ParsedKeystroke,
  platform: 'macos' | 'windows' | 'linux' | 'wsl' | 'unknown' = 'linux',
): string {
  const parts: string[] = []
  if (keystroke.ctrl) parts.push('ctrl')
  if (keystroke.alt || keystroke.meta) {
    parts.push(platform === 'macos' ? 'opt' : 'alt')
  }
  if (keystroke.shift) parts.push('shift')
  if (keystroke.super) {
    parts.push(platform === 'macos' ? 'cmd' : 'super')
  }
  parts.push(keyToDisplayName(keystroke.key))
  return parts.join('+')
}

export function chordToDisplayString(
  chord: Chord,
  platform: 'macos' | 'windows' | 'linux' | 'wsl' | 'unknown' = 'linux',
): string {
  return chord.map(keystroke => keystrokeToDisplayString(keystroke, platform)).join(' ')
}

export function getKeyName(input: string, key: Key): string | null {
  if (key.escape) return 'escape'
  if (key.return) return 'enter'
  if (key.tab) return 'tab'
  if (key.backspace) return 'backspace'
  if (key.delete) return 'delete'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.pageUp) return 'pageup'
  if (key.pageDown) return 'pagedown'
  if (key.home) return 'home'
  if (key.end) return 'end'
  if (input.length === 1) return input.toLowerCase()
  return null
}

export function matchesKeystroke(
  input: string,
  key: Key,
  target: ParsedKeystroke,
): boolean {
  const keyName = getKeyName(input, key)
  if (keyName !== target.key) return false

  const keyMeta = key.escape ? false : key.meta
  return (
    key.ctrl === target.ctrl &&
    key.shift === target.shift &&
    keyMeta === (target.alt || target.meta) &&
    key.super === target.super
  )
}

export function parseBindings(blocks: KeybindingBlock[]): ParsedBinding[] {
  const bindings: ParsedBinding[] = []
  for (const block of blocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      bindings.push({
        chord: parseChord(key),
        action,
        context: block.context,
      })
    }
  }
  return bindings
}

function keyToDisplayName(key: string): string {
  switch (key) {
    case 'escape':
      return 'Esc'
    case ' ':
      return 'Space'
    case 'enter':
      return 'Enter'
    case 'up':
      return '↑'
    case 'down':
      return '↓'
    case 'left':
      return '←'
    case 'right':
      return '→'
    case 'pageup':
      return 'PageUp'
    case 'pagedown':
      return 'PageDown'
    default:
      return key
  }
}
