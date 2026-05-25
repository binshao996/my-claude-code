import { describe, expect, it } from 'bun:test'
import {
  type HitTestNode,
  hitTestNodes,
  mouseBubblePath,
  normalizeRect,
  rectFromDOMElement,
  updateNodeRect,
} from './hitTest.js'

describe('@anthropic/ink hit-test compatibility', () => {
  it('targets the topmost smallest node under a mouse point', () => {
    const nodes: HitTestNode[] = [
      { id: 'root', rect: { x: 0, y: 0, width: 40, height: 10 } },
      {
        id: 'button',
        parentId: 'root',
        rect: { x: 2, y: 2, width: 8, height: 2 },
      },
      {
        id: 'overlay',
        rect: { x: 1, y: 1, width: 20, height: 5 },
        zIndex: 10,
      },
    ]

    expect(hitTestNodes(nodes, { x: 3, y: 3 })?.id).toBe('overlay')
    expect(
      hitTestNodes(
        [
          ...nodes,
          {
            id: 'ignore',
            rect: { x: 0, y: 0, width: 40, height: 10 },
            zIndex: 20,
            pointerEvents: 'none',
          },
        ],
        { x: 3, y: 3 },
      )?.id,
    ).toBe('overlay')
  })

  it('builds a bubbling path from target to parent nodes', () => {
    const nodes: HitTestNode[] = [
      { id: 'root', rect: { x: 0, y: 0, width: 40, height: 10 } },
      {
        id: 'panel',
        parentId: 'root',
        rect: { x: 1, y: 1, width: 20, height: 6 },
      },
      {
        id: 'button',
        parentId: 'panel',
        rect: { x: 2, y: 2, width: 8, height: 2 },
      },
    ]

    expect(mouseBubblePath(nodes, { x: 3, y: 3 }).path.map((node) => node.id)).toEqual([
      'button',
      'panel',
      'root',
    ])
  })

  it('updates cached node rectangles', () => {
    const nodes: HitTestNode[] = [{ id: 'button', rect: { x: 0, y: 0, width: 4, height: 1 } }]

    expect(
      updateNodeRect(nodes, 'button', {
        x: 5,
        y: 6,
        width: 7,
        height: 8,
      }),
    ).toEqual([{ id: 'button', rect: { x: 5, y: 6, width: 7, height: 8 } }])
  })

  it('prioritizes overlay nodes and stable mount order for overlapping DOM rects', () => {
    const nodes: HitTestNode[] = [
      { id: 'base', rect: { x: 0, y: 0, width: 20, height: 5 }, zIndex: 100 },
      {
        id: 'overlay-root',
        rect: { x: 0, y: 0, width: 20, height: 5 },
        overlay: true,
        pointerEvents: 'none',
      },
      {
        id: 'overlay-a',
        parentId: 'overlay-root',
        rect: { x: 1, y: 1, width: 6, height: 2 },
        overlay: true,
      },
      {
        id: 'overlay-b',
        parentId: 'overlay-root',
        rect: { x: 1, y: 1, width: 6, height: 2 },
        overlay: true,
      },
    ]

    expect(hitTestNodes(nodes, { x: 2, y: 2 })?.id).toBe('overlay-b')
    expect(mouseBubblePath(nodes, { x: 2, y: 2 }).path.map((node) => node.id)).toEqual([
      'overlay-b',
      'overlay-root',
    ])
  })

  it('normalizes DOM/Yoga rectangles for renderer hit-test caches', () => {
    expect(
      normalizeRect({
        x: 1.7,
        y: -1.2,
        width: 4.2,
        height: -3,
      }),
    ).toEqual({
      x: 1,
      y: -2,
      width: 5,
      height: 0,
    })

    expect(
      rectFromDOMElement({
        yogaNode: {
          getComputedLeft: () => 4.8,
          getComputedTop: () => 3.2,
          getComputedWidth: () => 10.1,
          getComputedHeight: () => 2.4,
        },
      }),
    ).toEqual({
      x: 4,
      y: 3,
      width: 11,
      height: 3,
    })
  })
})
