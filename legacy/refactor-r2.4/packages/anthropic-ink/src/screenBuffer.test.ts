import { describe, expect, it } from 'bun:test'
import {
  applyScreenBufferPatches,
  createScreenBuffer,
  diffScreenBuffers,
  resizeScreenBuffer,
} from './screenBuffer.js'

describe('@anthropic/ink screen buffer compatibility', () => {
  it('creates fixed-size padded screen buffers', () => {
    expect(createScreenBuffer({
      width: 5,
      height: 2,
      rows: ['abc', 'abcdef'],
    })).toEqual({
      width: 5,
      height: 2,
      rows: ['abc  ', 'abcde'],
    })
  })

  it('diffs full clears and row writes', () => {
    const next = createScreenBuffer({
      width: 8,
      height: 2,
      rows: ['hello', 'world'],
    })

    expect(diffScreenBuffers(undefined, next)).toEqual([
      { type: 'clear' },
      { type: 'write', row: 0, column: 0, text: 'hello' },
      { type: 'write', row: 1, column: 0, text: 'world' },
    ])
  })

  it('applies minimal row patches', () => {
    const previous = createScreenBuffer({
      width: 8,
      height: 1,
      rows: ['hello'],
    })
    const next = createScreenBuffer({
      width: 8,
      height: 1,
      rows: ['hallo'],
    })
    const patches = diffScreenBuffers(previous, next)

    expect(patches).toEqual([
      { type: 'write', row: 0, column: 1, text: 'a' },
    ])
    expect(applyScreenBufferPatches(previous, patches, {
      width: 8,
      height: 1,
    })).toEqual(next)
  })

  it('diffs and applies cursor patches', () => {
    const previous = createScreenBuffer({
      width: 8,
      height: 2,
      rows: ['hello'],
      cursor: { row: 0, column: 1, visible: true },
    })
    const next = createScreenBuffer({
      width: 8,
      height: 2,
      rows: ['hello'],
      cursor: { row: 1, column: 4, visible: false },
    })
    const patches = diffScreenBuffers(previous, next)

    expect(patches).toEqual([
      { type: 'cursor', row: 1, column: 4, visible: false },
    ])
    expect(applyScreenBufferPatches(previous, patches, {
      width: 8,
      height: 2,
    })).toEqual(next)
  })

  it('resizes buffers and clamps cursor position', () => {
    expect(resizeScreenBuffer(
      createScreenBuffer({
        width: 8,
        height: 3,
        rows: ['abcdefghi', 'two', 'three'],
        cursor: { row: 2, column: 7, visible: true },
      }),
      {
        width: 4,
        height: 2,
      },
    )).toEqual({
      width: 4,
      height: 2,
      rows: ['abcd', 'two '],
      cursor: { row: 1, column: 3, visible: true },
    })
  })
})
