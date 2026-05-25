import { describe, expect, it } from 'bun:test'
import {
  buildScreenSelectionRows,
  hitTestScreenRows,
  normalizeNoSelectRanges,
  normalizeScreenSelection,
  screenPointFromTerminalMouse,
  selectablePointFromHit,
  selectedScreenText,
  selectionPartsForRow,
  selectionSliceForRow,
} from './screenSelection.js'

describe('screen-level TUI selection', () => {
  it('builds selectable rows across message, overlay, and prompt panes', () => {
    const rows = buildScreenSelectionRows({
      status: 'session s1',
      messages: [
        { id: 'm1', role: 'user', text: 'hello' },
        { id: 'm2', role: 'assistant', text: 'first\nsecond' },
      ],
      overlays: ['permission: Write(file)'],
      promptValue: 'next prompt',
    })

    expect(rows).toEqual([
      { pane: 'status', text: 'session s1', selectable: false },
      { pane: 'messages', text: '› hello', selectable: true },
      { pane: 'messages', text: '● first', selectable: true },
      { pane: 'messages', text: '  second', selectable: true },
      { pane: 'overlay', text: 'permission: Write(file)', selectable: true },
      { pane: 'prompt', text: '> next prompt', selectable: true },
    ])
  })

  it('extracts copy text across panes while skipping non-selectable rows', () => {
    const rows = buildScreenSelectionRows({
      status: 'session s1',
      messages: [
        { id: 'm1', role: 'assistant', text: 'alpha' },
        { id: 'm2', role: 'tool', text: 'tool output' },
      ],
      promptValue: 'draft',
    })

    expect(
      selectedScreenText(rows, {
        anchor: { row: 0, column: 0 },
        focus: { row: 3, column: 7 },
      }),
    ).toBe('● alpha\n✻ tool output\n> draft')
  })

  it('normalizes reversed selections', () => {
    expect(
      normalizeScreenSelection({
        anchor: { row: 3, column: 8 },
        focus: { row: 1, column: 2 },
      }),
    ).toEqual({
      start: { row: 1, column: 2 },
      end: { row: 3, column: 8 },
    })
  })

  it('builds hidden message rows and row highlight slices', () => {
    const rows = buildScreenSelectionRows({
      status: 'session s1',
      olderHiddenMessages: 2,
      newerHiddenMessages: 1,
      messages: [{ id: 'm1', role: 'assistant', text: 'alpha' }],
      promptValue: 'draft',
    })

    expect(rows.map((row) => row.text)).toEqual([
      'session s1',
      '2 earlier messages hidden',
      '● alpha',
      '1 newer messages hidden',
      '> draft',
    ])
    expect(rows[1]?.selectable).toBe(false)
    expect(
      selectionSliceForRow(2, '● alpha', {
        anchor: { row: 2, column: 2 },
        focus: { row: 2, column: 7 },
      }),
    ).toEqual({
      before: '● ',
      selected: 'alpha',
      after: '',
    })
    expect(screenPointFromTerminalMouse({ row: 3, column: 5 })).toEqual({
      row: 2,
      column: 4,
    })
  })

  it('wraps selectable rows to terminal columns', () => {
    const rows = buildScreenSelectionRows({
      messages: [{ id: 'm1', role: 'assistant', text: 'abcdefghijkl' }],
      promptValue: 'draft',
      noSelectDecorations: true,
      columns: 8,
    })

    expect(rows).toEqual([
      {
        pane: 'messages',
        text: '● abcdef',
        selectable: true,
        noSelectRanges: [{ start: 0, end: 2 }],
      },
      {
        pane: 'messages',
        text: '  ghijkl',
        selectable: true,
        noSelectRanges: [{ start: 0, end: 2 }],
      },
      {
        pane: 'prompt',
        text: '> draft',
        selectable: true,
        noSelectRanges: [{ start: 0, end: 2 }],
      },
    ])
  })

  it('can build selection rows from the same clipped rows rendered by ScrollBox', () => {
    const rows = buildScreenSelectionRows({
      status: 'session s1',
      messages: [{ id: 'm1', role: 'assistant', text: 'hidden\nvisible' }],
      messageRows: [
        {
          message: { id: 'm1', role: 'assistant', text: 'hidden\nvisible' },
          rows: ['  visible'],
        },
      ],
      promptValue: 'draft',
      noSelectDecorations: true,
    })

    expect(rows.map(row => row.text)).toEqual([
      'session s1',
      '  visible',
      '> draft',
    ])
  })

  it('keeps transient activity rows in the screen model but out of copied text', () => {
    const rows = buildScreenSelectionRows({
      messages: [{ id: 'm1', role: 'assistant', text: 'answer' }],
      activityRows: ['✻ Thinking…'],
      promptValue: 'next',
    })

    expect(rows.map(row => row.text)).toEqual([
      '● answer',
      '✻ Thinking…',
      '> next',
    ])
    expect(rows[1]?.selectable).toBe(false)
    expect(
      selectedScreenText(rows, {
        anchor: { row: 0, column: 0 },
        focus: { row: 2, column: 6 },
      }),
    ).toBe('● answer\n> next')
  })

  it('honors NoSelect ranges for fullscreen copy and hit-test selection', () => {
    const rows = buildScreenSelectionRows({
      messages: [{ id: 'm1', role: 'assistant', text: 'alpha' }],
      promptValue: 'draft',
      noSelectDecorations: true,
    })

    expect(rows).toEqual([
      {
        pane: 'messages',
        text: '● alpha',
        selectable: true,
        noSelectRanges: [{ start: 0, end: 2 }],
      },
      {
        pane: 'prompt',
        text: '> draft',
        selectable: true,
        noSelectRanges: [{ start: 0, end: 2 }],
      },
    ])
    expect(
      selectedScreenText(rows, {
        anchor: { row: 0, column: 0 },
        focus: { row: 1, column: 7 },
      }),
    ).toBe('alpha\ndraft')

    const gutterHit = hitTestScreenRows(rows, { row: 0, column: 1 })
    expect(gutterHit?.insideNoSelect).toBe(true)
    expect(selectablePointFromHit(gutterHit as NonNullable<typeof gutterHit>)).toEqual({
      row: 0,
      column: 2,
    })
    expect(
      selectionSliceForRow(0, rows[0], {
        anchor: { row: 0, column: 0 },
        focus: { row: 0, column: 9 },
      }),
    ).toEqual({
      before: '● ',
      selected: 'alpha',
      after: '',
    })
  })

  it('normalizes and drains internal NoSelect ranges from selected text', () => {
    const row = {
      pane: 'messages' as const,
      text: '[AI] alpha {meta} beta',
      selectable: true,
      noSelectRanges: [
        { start: 11, end: 17 },
        { start: -4, end: 4 },
        { start: 2, end: 5 },
      ],
    }

    expect(normalizeNoSelectRanges(row.noSelectRanges, row.text.length)).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 17 },
    ])
    expect(
      selectedScreenText([row], {
        anchor: { row: 0, column: 0 },
        focus: { row: 0, column: row.text.length },
      }),
    ).toBe('alpha  beta')
    expect(
      selectionPartsForRow(0, row, {
        anchor: { row: 0, column: 0 },
        focus: { row: 0, column: row.text.length },
      }),
    ).toEqual([
      { text: '[AI] ', selected: false },
      { text: 'alpha ', selected: true },
      { text: '{meta}', selected: false },
      { text: ' beta', selected: true },
    ])
  })
})
