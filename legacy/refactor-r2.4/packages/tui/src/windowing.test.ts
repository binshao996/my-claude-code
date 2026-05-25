import { describe, expect, it } from 'bun:test'
import {
  captureMessageScrollSnapshot,
  hiddenMessageCount,
  measureMessageViewport,
  messageRowCount,
  moveMessageRowScroll,
  moveMessageScroll,
  newerHiddenMessageCount,
  restoreMessageScroll,
  terminalDisplayWidth,
  wrapTerminalText,
  windowMessageRowRangesByRows,
  windowMessagesByRows,
  windowMessages,
} from './windowing.js'

describe('TUI message windowing', () => {
  it('keeps only the newest visible messages', () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      id: `m${index}`,
      role: 'system' as const,
      text: `message ${index}`,
    }))

    expect(windowMessages(messages, 3).map(message => message.id)).toEqual([
      'm2',
      'm3',
      'm4',
    ])
    expect(hiddenMessageCount(messages, 3)).toBe(2)
  })

  it('supports scrolling into older messages', () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      role: 'system' as const,
      text: `message ${index}`,
    }))

    expect(windowMessages(messages, 3, 2).map(message => message.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
    expect(hiddenMessageCount(messages, 3, 2)).toBe(1)
    expect(newerHiddenMessageCount(messages, 2)).toBe(2)
  })

  it('moves scroll offsets by page', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: `m${index}`,
      role: 'system' as const,
      text: `message ${index}`,
    }))

    expect(moveMessageScroll(messages, 3, 0, 'older')).toBe(3)
    expect(moveMessageScroll(messages, 3, 3, 'newer')).toBe(0)
    expect(moveMessageScroll(messages, 3, 3, 'latest')).toBe(0)
    expect(moveMessageScroll(messages, 3, 6, 'older')).toBe(7)
  })

  it('handles disabled windows without throwing', () => {
    const messages = [
      {
        id: 'm1',
        role: 'system' as const,
        text: 'message',
      },
    ]

    expect(windowMessages(messages, 0)).toEqual([])
    expect(hiddenMessageCount(messages, 0)).toBe(1)
  })

  it('can window messages by rendered row count', () => {
    const messages = [
      {
        id: 'm1',
        role: 'system' as const,
        text: 'one',
      },
      {
        id: 'm2',
        role: 'assistant' as const,
        text: 'two\nthree\nfour',
      },
      {
        id: 'm3',
        role: 'tool' as const,
        text: 'five',
      },
    ]

    expect(messageRowCount(messages[1])).toBe(3)
    expect(windowMessagesByRows(messages, 3).visible.map(message => message.id)).toEqual([
      'm2',
      'm3',
    ])
    expect(
      windowMessagesByRows(messages, 3, 2).visible.map(message => message.id),
    ).toEqual(['m1', 'm2'])
    expect(moveMessageRowScroll(messages, 3, 0, 'older')).toBe(2)
    expect(moveMessageRowScroll(messages, 3, 2, 'newer')).toBe(0)
  })

  it('estimates wrapped rows from terminal columns', () => {
    const messages = [
      {
        id: 'm1',
        role: 'assistant' as const,
        text: 'abcdefghijklmnop',
      },
      {
        id: 'm2',
        role: 'system' as const,
        text: 'tail',
      },
    ]

    expect(messageRowCount(messages[0], 12)).toBe(2)
    expect(windowMessagesByRows(messages, 2, 0, 12).visible.map(message => message.id)).toEqual([
      'm1',
      'm2',
    ])
    expect(moveMessageRowScroll(messages, 2, 0, 'older', 12)).toBe(1)
  })

  it('clips a single tall message to the visible row window', () => {
    const messages = [
      {
        id: 'long',
        role: 'assistant' as const,
        text: ['one', 'two', 'three', 'four', 'five'].join('\n'),
      },
    ]

    const window = windowMessageRowRangesByRows(messages, 2)

    expect(window.ranges).toMatchObject([
      {
        message: messages[0],
        start: 0,
        end: 5,
        visibleStart: 3,
        visibleEnd: 5,
      },
    ])
    expect(window.totalRows).toBe(5)
  })

  it('uses measured Ink/Yoga heights when available', () => {
    const messages = [
      {
        id: 'm1',
        role: 'assistant' as const,
        text: 'estimated one row',
      },
      {
        id: 'm2',
        role: 'tool' as const,
        text: 'measured tall result',
      },
      {
        id: 'm3',
        role: 'system' as const,
        text: 'tail',
      },
    ]
    const measuredRows = new Map([
      ['m1', 1],
      ['m2', 6],
      ['m3', 1],
    ])

    expect(messageRowCount(messages[1], 80, measuredRows)).toBe(6)
    expect(
      windowMessagesByRows(messages, 3, 0, 80, measuredRows).visible.map(
        message => message.id,
      ),
    ).toEqual(['m2', 'm3'])
    expect(moveMessageRowScroll(messages, 3, 0, 'older', 80, measuredRows)).toBe(3)
  })

  it('uses terminal display width for CJK wrapping estimates', () => {
    expect(messageRowCount({
      id: 'cjk',
      role: 'system',
      text: '你好世界你好',
    }, 10)).toBe(2)
    expect(terminalDisplayWidth('你a')).toBe(3)
    expect(wrapTerminalText('你好ab', 4)).toEqual(['你好', 'ab'])
  })

  it('measures the message viewport from terminal size', () => {
    expect(measureMessageViewport({ rows: 40, columns: 100 })).toEqual({
      rows: 32,
      columns: 100,
    })
    expect(measureMessageViewport(undefined, {
      fallbackRows: 12,
      fallbackColumns: 8,
    })).toEqual({
      rows: 12,
      columns: undefined,
    })
  })

  it('restores scroll position by visible message anchor', () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      role: 'system' as const,
      text: `message ${index}`,
    }))
    const snapshot = captureMessageScrollSnapshot(messages, 3, 2)

    const withAppended = [
      ...messages,
      { id: 'm6', role: 'system' as const, text: 'message 6' },
    ]

    expect(snapshot.anchorId).toBe('m3')
    expect(restoreMessageScroll(withAppended, 3, snapshot)).toBe(3)
    expect(windowMessages(withAppended, 3, 3).map(message => message.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
  })
})
