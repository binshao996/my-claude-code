import { describe, expect, it } from 'bun:test'
import {
  chordToDisplayString,
  getKeyName,
  keystrokeToString,
  matchesKeystroke,
  parseBindings,
  parseChord,
  parseKeystroke,
} from './keybindings.js'

describe('@anthropic/ink keybinding compatibility', () => {
  it('parses Claude Code-style key strings and chords', () => {
    expect(parseKeystroke('ctrl+shift+k')).toEqual({
      key: 'k',
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      super: false,
    })
    expect(parseChord('ctrl+x ctrl+e')).toEqual([
      {
        key: 'x',
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        super: false,
      },
      {
        key: 'e',
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        super: false,
      },
    ])
    expect(keystrokeToString(parseKeystroke('cmd+return'))).toBe('cmd+Enter')
    expect(chordToDisplayString(parseChord('alt+left'), 'macos')).toBe('opt+←')
  })

  it('matches Ink key objects while treating escape meta as legacy noise', () => {
    expect(getKeyName('', {
      escape: true,
    } as Parameters<typeof getKeyName>[1])).toBe('escape')
    expect(matchesKeystroke('', {
      escape: true,
      ctrl: false,
      shift: false,
      meta: true,
      super: false,
    } as Parameters<typeof matchesKeystroke>[1], parseKeystroke('escape'))).toBe(true)
    expect(matchesKeystroke('b', {
      ctrl: false,
      shift: false,
      meta: true,
      super: false,
    } as Parameters<typeof matchesKeystroke>[1], parseKeystroke('alt+b'))).toBe(true)
  })

  it('parses binding blocks with context names', () => {
    expect(parseBindings([
      {
        context: 'Chat',
        bindings: {
          'ctrl+r': 'history:search',
        },
      },
    ])).toEqual([
      {
        context: 'Chat',
        action: 'history:search',
        chord: [parseKeystroke('ctrl+r')],
      },
    ])
  })
})
