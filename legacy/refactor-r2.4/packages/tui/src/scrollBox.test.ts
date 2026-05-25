import { describe, expect, it } from 'bun:test'
import {
  createScrollContainerSnapshot,
  drainPendingScrollDelta,
  drainScrollContainerSnapshot,
  drainScrollContainerTick,
  maxScrollTop,
  offsetFromEndFromScrollTop,
  scrollTopFromOffsetFromEnd,
  virtualScrollWindow,
} from './components/ScrollBox.js'

describe('TUI ScrollBox compatibility helpers', () => {
  it('maps between @anthropic/ink-style scrollTop and offset-from-end state', () => {
    expect(maxScrollTop(30, 10)).toBe(20)
    expect(
      scrollTopFromOffsetFromEnd({
        scrollHeight: 30,
        viewportRows: 10,
        offsetFromEnd: 0,
      }),
    ).toBe(20)
    expect(
      scrollTopFromOffsetFromEnd({
        scrollHeight: 30,
        viewportRows: 10,
        offsetFromEnd: 7,
      }),
    ).toBe(13)
    expect(
      offsetFromEndFromScrollTop({
        scrollHeight: 30,
        viewportRows: 10,
        scrollTop: 13,
      }),
    ).toBe(7)
  })

  it('mounts overscan across committed and pending scroll windows', () => {
    expect(
      virtualScrollWindow({
        scrollTop: 10,
        pendingDelta: 12,
        scrollHeight: 100,
        viewportRows: 20,
        overscanRows: 5,
      }),
    ).toEqual({
      visibleStartRow: 22,
      visibleEndRow: 42,
      mountedStartRow: 5,
      mountedEndRow: 47,
      targetScrollTop: 22,
    })
  })

  it('drains pending scroll delta and sticks at bottom', () => {
    expect(
      drainPendingScrollDelta({
        scrollTop: 10,
        pendingDelta: 12,
        scrollHeight: 100,
        viewportRows: 20,
        maxDrainRows: 5,
      }),
    ).toEqual({
      scrollTop: 15,
      pendingDelta: 7,
      sticky: false,
    })
    expect(
      drainPendingScrollDelta({
        scrollTop: 78,
        pendingDelta: 10,
        scrollHeight: 100,
        viewportRows: 20,
        maxDrainRows: 10,
      }),
    ).toEqual({
      scrollTop: 80,
      pendingDelta: 0,
      sticky: true,
    })
  })

  it('models an @anthropic/ink DOM scroll container snapshot', () => {
    expect(
      createScrollContainerSnapshot({
        scrollTop: 7,
        pendingDelta: 3,
        scrollHeight: 40,
        viewportRows: 10,
        viewportTop: 2,
        width: 80,
      }),
    ).toEqual({
      scrollTop: 7,
      pendingDelta: 3,
      scrollHeight: 40,
      clientHeight: 10,
      viewportTop: 2,
      viewportRect: {
        x: 0,
        y: 2,
        width: 80,
        height: 10,
      },
      contentRect: {
        x: 0,
        y: -5,
        width: 80,
        height: 40,
      },
      sticky: false,
    })
  })

  it('drains DOM scroll container pending delta in bounded steps', () => {
    const snapshot = createScrollContainerSnapshot({
      scrollTop: 10,
      pendingDelta: 12,
      scrollHeight: 100,
      viewportRows: 20,
      viewportTop: 4,
      width: 100,
    })

    expect(drainScrollContainerSnapshot(snapshot, 5)).toEqual({
      scrollTop: 15,
      pendingDelta: 7,
      scrollHeight: 100,
      clientHeight: 20,
      viewportTop: 4,
      viewportRect: {
        x: 0,
        y: 4,
        width: 100,
        height: 20,
      },
      contentRect: {
        x: 0,
        y: -11,
        width: 100,
        height: 100,
      },
      sticky: false,
    })
  })

  it('drains DOM scroll containers across renderer ticks', () => {
    const tick = drainScrollContainerTick({
      snapshot: createScrollContainerSnapshot({
        scrollTop: 10,
        pendingDelta: 12,
        scrollHeight: 100,
        viewportRows: 20,
        viewportTop: 4,
        width: 100,
      }),
      frameBudgetRows: 5,
      maxFrames: 3,
    })

    expect(tick.didDrain).toBe(true)
    expect(tick.drainedRows).toBe(12)
    expect(tick.frames.map(frame => frame.scrollTop)).toEqual([15, 20, 22])
    expect(tick.snapshot).toMatchObject({
      scrollTop: 22,
      pendingDelta: 0,
      sticky: false,
    })
  })
})
