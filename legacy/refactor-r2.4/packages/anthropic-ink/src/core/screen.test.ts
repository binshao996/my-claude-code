import { describe, expect, it } from 'bun:test'
import { createScreen, extractSelectableText, Screen, snapshotLines } from './screen.js'

describe('@anthropic/ink core screen', () => {
  it('stores style and noSelect on written cells', () => {
    const style = { color: 'red', bold: true }
    const screen = createScreen({ width: 6, height: 1 })

    screen.writeText(0, 0, 'ab', { style, noSelect: true })
    screen.writeText(2, 0, 'cd')

    expect(screen.width).toBe(6)
    expect(screen.height).toBe(1)
    expect(screen.cells[0]).toEqual({
      char: 'a',
      style,
      noSelect: true,
      softWrap: false,
    })
    expect(screen.cells[1]).toEqual({
      char: 'b',
      style,
      noSelect: true,
      softWrap: false,
    })
    expect(screen.extractSelectableText()).toBe('cd')
  })

  it('writes wide characters with a spacer cell', () => {
    const screen = new Screen(5, 1)

    screen.writeText(0, 0, 'A界B')

    expect(screen.cells.map((cell) => cell.char)).toEqual(['A', '界', '', 'B', ' '])
    expect(screen.snapshotLines()).toEqual(['A界B '])
    expect(extractSelectableText(screen)).toBe('A界B')
  })

  it('clears wide boundaries and blits cell metadata', () => {
    const source = createScreen(6, 2)
    const target = createScreen(8, 2)
    const style = 'accent'

    source.writeText(0, 0, '12界5')
    source.clearRect(3, 0, 1, 1)
    expect(source.snapshotLines()).toEqual(['12  5 ', '      '])

    source.writeText(0, 1, 'xy', { style, noSelect: true })
    target.blit(source, {
      sourceX: 0,
      sourceY: 1,
      targetX: 2,
      targetY: 0,
      width: 2,
      height: 1,
    })

    expect(target.snapshotLines()).toEqual(['  xy    ', '        '])
    expect(target.cells[2]).toEqual({
      char: 'x',
      style,
      noSelect: true,
      softWrap: false,
    })
    expect(target.extractSelectableText()).toBe('')
  })

  it('shifts rows with cells, noSelect, and softWrap metadata', () => {
    const screen = createScreen(5, 3)

    screen.writeText(0, 0, 'zero')
    screen.writeText(0, 1, 'one', { noSelect: true })
    screen.writeText(0, 2, 'two', { softWrap: true })

    screen.shiftRows(0, 2, 1)

    expect(snapshotLines(screen)).toEqual(['one  ', 'two  ', '     '])
    expect(screen.cells[0].noSelect).toBe(true)
    expect(screen.noSelect[0]).toBe(1)
    expect(screen.cells[5].softWrap).toBe(true)
    expect(screen.softWrap[1]).toBe(true)
  })

  it('extracts selectable text without spacers and joins soft-wrapped rows', () => {
    const screen = createScreen(7, 3)

    screen.writeText(0, 0, '01 ', { noSelect: true })
    screen.writeText(3, 0, 'foo')
    screen.writeText(0, 1, '界bar', { softWrap: true })
    screen.writeText(0, 2, 'baz')

    expect(screen.extractSelectableText()).toBe('foo界bar\nbaz')
    expect(
      screen.extractSelectableText({
        start: { x: 3, y: 0 },
        end: { x: 1, y: 1 },
      }),
    ).toBe('foo界')
  })
})
