import { describe, expect, it } from 'bun:test'
import { createScreen } from './screen.js'
import {
  createRendererDOMRegistry,
  hitTestRendererDOM,
  paintRendererDOMToScreen,
  removeRendererDOMNode,
  renderRendererDOMFrame,
  rendererDOMNodeFromElement,
  rendererDOMBubblePath,
  rendererDOMPaintOrder,
  upsertRendererDOMNode,
} from './dom.js'
import { NoSelect, isNoSelectElement } from '../noSelect.js'

describe('@anthropic/ink renderer DOM core', () => {
  it('paints overlay nodes after base nodes', () => {
    const screen = createScreen(12, 3)
    const registry = createRendererDOMRegistry([
      {
        id: 'base',
        rect: { x: 0, y: 0, width: 12, height: 1 },
        text: 'base layer',
      },
      {
        id: 'overlay',
        rect: { x: 0, y: 0, width: 12, height: 1 },
        text: 'overlay',
        overlay: true,
      },
    ])

    paintRendererDOMToScreen(screen, registry)

    expect(rendererDOMPaintOrder(registry).map(node => node.id)).toEqual([
      'base',
      'overlay',
    ])
    expect(screen.snapshotLines()).toEqual([
      'overlay     ',
      '            ',
      '            ',
    ])
  })

  it('uses overlay-aware hit-testing and bubbling paths', () => {
    const registry = createRendererDOMRegistry([
      {
        id: 'root',
        rect: { x: 0, y: 0, width: 10, height: 5 },
      },
      {
        id: 'message',
        parentId: 'root',
        rect: { x: 1, y: 1, width: 8, height: 2 },
      },
      {
        id: 'permission-overlay',
        parentId: 'root',
        rect: { x: 2, y: 1, width: 5, height: 2 },
        overlay: true,
      },
    ])

    expect(hitTestRendererDOM(registry, { x: 3, y: 1 })?.id).toBe('permission-overlay')
    expect(rendererDOMBubblePath(registry, { x: 3, y: 1 }).path.map(node => node.id)).toEqual([
      'permission-overlay',
      'root',
    ])
  })

  it('removes descendants and preserves noSelect text during paint', () => {
    const screen = createScreen(8, 1)
    const registry = removeRendererDOMNode(
      createRendererDOMRegistry([
        { id: 'root', rect: { x: 0, y: 0, width: 8, height: 1 } },
        {
          id: 'child',
          parentId: 'root',
          rect: { x: 0, y: 0, width: 8, height: 1 },
          text: 'secret',
          noSelect: true,
        },
      ]),
      'missing',
    )
    const next = upsertRendererDOMNode(registry, {
      id: 'label',
      rect: { x: 0, y: 0, width: 8, height: 1 },
      text: 'visible',
      noSelect: true,
    })

    paintRendererDOMToScreen(screen, next)

    expect(removeRendererDOMNode(next, 'root').nodes.map(node => node.id)).toEqual(['label'])
    expect(screen.extractSelectableText()).toBe('')
  })

  it('projects NoSelect component markers into selectable text extraction', () => {
    const screen = createScreen(18, 1)
    const element = NoSelect({ children: 'secret' })
    const registry = createRendererDOMRegistry([
      {
        id: 'before',
        rect: { x: 0, y: 0, width: 7, height: 1 },
        text: 'keep ',
      },
      rendererDOMNodeFromElement(element, {
        id: 'secret',
        rect: { x: 5, y: 0, width: 7, height: 1 },
        text: 'secret ',
      }),
      {
        id: 'after',
        rect: { x: 12, y: 0, width: 6, height: 1 },
        text: 'shown',
      },
    ])

    paintRendererDOMToScreen(screen, registry)

    expect(isNoSelectElement(element)).toBe(true)
    expect(screen.snapshotLines()).toEqual(['keep secret shown '])
    expect(screen.extractSelectableText()).toBe('keep shown')
  })

  it('inherits noSelect from renderer DOM ancestors', () => {
    const screen = createScreen(12, 1)
    const registry = createRendererDOMRegistry([
      {
        id: 'gutter',
        rect: { x: 0, y: 0, width: 4, height: 1 },
        noSelect: true,
      },
      {
        id: 'line-number',
        parentId: 'gutter',
        rect: { x: 0, y: 0, width: 4, height: 1 },
        text: ' 12 ',
      },
      {
        id: 'content',
        rect: { x: 4, y: 0, width: 8, height: 1 },
        text: 'return',
      },
    ])

    paintRendererDOMToScreen(screen, registry)

    expect(registry.byId.get('line-number')?.noSelect).toBe(true)
    expect(screen.extractSelectableText()).toBe('return')
  })

  it('commits renderer frames and clears stale overlay rectangles', () => {
    const screen = createScreen(12, 3)
    const firstFrame = renderRendererDOMFrame({
      width: 12,
      height: 3,
      screen,
      nodes: [
        {
          id: 'base',
          rect: { x: 0, y: 0, width: 12, height: 3 },
          text: 'base\nline',
        },
        {
          id: 'overlay',
          rect: { x: 1, y: 1, width: 6, height: 1 },
          text: 'dialog',
          overlay: true,
        },
      ],
    })

    expect(firstFrame.overlayRects).toEqual([
      { x: 1, y: 1, width: 6, height: 1 },
    ])
    expect(firstFrame.paintedNodeIds).toEqual(['base', 'overlay'])
    expect(screen.snapshotLines()).toEqual([
      'base        ',
      'ldialog     ',
      '            ',
    ])

    const nextFrame = renderRendererDOMFrame({
      width: 12,
      height: 3,
      screen,
      previousOverlayRects: firstFrame.overlayRects,
      nodes: [
        {
          id: 'base',
          rect: { x: 0, y: 0, width: 12, height: 3 },
          text: 'base\nline',
        },
      ],
    })

    expect(nextFrame.overlayRects).toEqual([])
    expect(screen.snapshotLines()).toEqual([
      'base        ',
      'line        ',
      '            ',
    ])
  })
})
