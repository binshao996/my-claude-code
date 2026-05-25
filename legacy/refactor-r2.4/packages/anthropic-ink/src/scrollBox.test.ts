import { describe, expect, it } from 'bun:test'
import { scrollTopForElement } from './scrollBox.js'

describe('@anthropic/ink ScrollBox compatibility', () => {
  it('computes scrollToElement targets from Yoga top with offset', () => {
    expect(scrollTopForElement({
      element: {
        yogaNode: {
          getComputedTop: () => 42,
        },
      },
      offset: 1,
      scrollHeight: 100,
      viewportRows: 10,
    })).toBe(41)
  })

  it('clamps scrollToElement targets to viewport bounds', () => {
    expect(scrollTopForElement({
      element: { y: 200 },
      scrollHeight: 100,
      viewportRows: 10,
    })).toBe(90)

    expect(scrollTopForElement({
      element: { top: 2 },
      scrollHeight: 100,
      viewportRows: 10,
      clampMin: 8,
    })).toBe(8)
  })

  it('accepts rect-like element targets', () => {
    expect(scrollTopForElement({
      element: {
        rect: {
          top: 12,
        },
      },
      offset: 2,
      scrollHeight: 40,
      viewportRows: 5,
    })).toBe(10)
  })
})
