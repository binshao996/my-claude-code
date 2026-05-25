import { describe, expect, it } from 'bun:test'
import {
  markdownToDisplayText,
  messageRowsForDisplay,
} from './messageMarkdown.js'

describe('TUI markdown display renderer', () => {
  it('strips inline markdown markers from terminal display text', () => {
    expect(markdownToDisplayText('- **Born:** September 10, 1964')).toBe(
      '- Born: September 10, 1964',
    )
    expect(markdownToDisplayText('See [docs](https://example.test) and `code`')).toBe(
      'See docs (https://example.test) and code',
    )
  })

  it('wraps list continuations under the list body instead of column zero', () => {
    expect(messageRowsForDisplay({
      id: 'm1',
      role: 'assistant',
      text: '- **Background:** English teacher before entering the internet business',
    }, 32)).toEqual([
      '● • Background: English teacher',
      '    before entering the',
      '    internet business',
    ])
  })

  it('renders markdown tables as aligned terminal rows without raw separator syntax', () => {
    expect(messageRowsForDisplay({
      id: 'm1',
      role: 'assistant',
      text: [
        'Key Facts',
        '',
        '| | |',
        '|---|---|',
        '| **Born** | October 29, 1971, in Dongfang County |',
        '| Hometown | Shantou, Guangdong |',
      ].join('\n'),
    }, 80)).toEqual([
      '● Key Facts',
      '  ',
      '  Born      October 29, 1971, in Dongfang County',
      '  Hometown  Shantou, Guangdong',
    ])
  })

  it('wraps long unordered list rows with only the first row carrying the bullet', () => {
    expect(messageRowsForDisplay({
      id: 'm1',
      role: 'assistant',
      text: '- Founded Tencent with co-founders and built QQ into a major messaging platform',
    }, 42)).toEqual([
      '● • Founded Tencent with co-founders and',
      '    built QQ into a major messaging',
      '    platform',
    ])
  })
})
