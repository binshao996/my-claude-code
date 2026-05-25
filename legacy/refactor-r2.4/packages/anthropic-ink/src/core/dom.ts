import {
  hitTestNodes,
  mouseBubblePath,
  type HitTestNode,
  type MouseBubblePath,
  type MousePoint,
  normalizeRect,
  type Rect,
} from '../hitTest.js'
import { isNoSelectElement } from '../noSelect.js'
import { Screen, type ScreenStyle } from './screen.js'

export type RendererDOMNode = {
  id: string
  rect: Rect
  parentId?: string
  text?: string
  style?: ScreenStyle
  overlay?: boolean
  zIndex?: number
  order?: number
  noSelect?: boolean
  pointerEvents?: 'auto' | 'none'
}

export type RendererDOMRegistry = {
  nodes: RendererDOMNode[]
  byId: Map<string, RendererDOMNode>
}

export type RendererDOMFrame = {
  screen: Screen
  registry: RendererDOMRegistry
  overlayRects: Rect[]
  paintedNodeIds: string[]
}

export type RendererHit = {
  target?: RendererDOMNode
  path: RendererDOMNode[]
}

export function createRendererDOMRegistry(
  nodes: RendererDOMNode[] = [],
): RendererDOMRegistry {
  const normalizedWithoutInheritance = nodes.map((node, index) =>
    normalizeRendererDOMNode(node, index),
  )
  const byId = new Map(normalizedWithoutInheritance.map(node => [node.id, node]))
  const normalized = normalizedWithoutInheritance.map(node =>
    inheritNoSelect(node, byId),
  )
  return {
    nodes: normalized,
    byId: new Map(normalized.map(node => [node.id, node])),
  }
}

export function rendererDOMNodeFromElement(
  element: unknown,
  node: RendererDOMNode,
): RendererDOMNode {
  return {
    ...node,
    noSelect: node.noSelect || isNoSelectElement(element),
  }
}

export function upsertRendererDOMNode(
  registry: RendererDOMRegistry,
  node: RendererDOMNode,
): RendererDOMRegistry {
  const next = registry.nodes.filter(candidate => candidate.id !== node.id)
  next.push(node)
  return createRendererDOMRegistry(next)
}

export function removeRendererDOMNode(
  registry: RendererDOMRegistry,
  id: string,
): RendererDOMRegistry {
  const removed = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const node of registry.nodes) {
      if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
        removed.add(node.id)
        changed = true
      }
    }
  }

  return createRendererDOMRegistry(
    registry.nodes.filter(node => !removed.has(node.id)),
  )
}

export function rendererDOMPaintOrder(
  registry: RendererDOMRegistry | RendererDOMNode[],
): RendererDOMNode[] {
  const nodes = Array.isArray(registry)
    ? createRendererDOMRegistry(registry).nodes
    : registry.nodes

  return [...nodes].sort((left, right) => {
    const layerDelta = Number(Boolean(left.overlay)) - Number(Boolean(right.overlay))
    if (layerDelta !== 0) return layerDelta

    const zIndexDelta = (left.zIndex ?? 0) - (right.zIndex ?? 0)
    if (zIndexDelta !== 0) return zIndexDelta

    return (left.order ?? 0) - (right.order ?? 0)
  })
}

export function paintRendererDOMToScreen(
  screen: Screen,
  registry: RendererDOMRegistry | RendererDOMNode[],
  options: {
    clearRects?: Rect[]
  } = {},
): Screen {
  for (const rect of options.clearRects ?? []) {
    screen.clearRect(normalizeRect(rect))
  }

  for (const node of rendererDOMPaintOrder(registry)) {
    if (!node.text) continue

    const rect = normalizeRect(node.rect)
    screen.clearRect(rect)
    screen.writeText(rect.x, rect.y, clipTextToRect(node.text, rect), {
      style: node.style,
      noSelect: node.noSelect,
      wrap: true,
    })
  }

  return screen
}

export function renderRendererDOMFrame(args: {
  width: number
  height: number
  nodes?: RendererDOMNode[]
  registry?: RendererDOMRegistry
  previousOverlayRects?: Rect[]
  screen?: Screen
}): RendererDOMFrame {
  const registry = args.registry ?? createRendererDOMRegistry(args.nodes ?? [])
  const screen = args.screen ?? new Screen(args.width, args.height)
  const paintOrder = rendererDOMPaintOrder(registry)

  paintRendererDOMToScreen(screen, registry, {
    clearRects: args.previousOverlayRects,
  })

  return {
    screen,
    registry,
    overlayRects: paintOrder
      .filter(node => node.overlay)
      .map(node => normalizeRect(node.rect)),
    paintedNodeIds: paintOrder.filter(node => node.text).map(node => node.id),
  }
}

export function hitTestRendererDOM(
  registry: RendererDOMRegistry | RendererDOMNode[],
  point: MousePoint,
): RendererDOMNode | undefined {
  const normalized = Array.isArray(registry)
    ? createRendererDOMRegistry(registry)
    : registry
  const target = hitTestNodes(normalized.nodes.map(toHitTestNode), point)
  return target ? normalized.byId.get(target.id) : undefined
}

export function rendererDOMBubblePath(
  registry: RendererDOMRegistry | RendererDOMNode[],
  point: MousePoint,
): RendererHit {
  const normalized = Array.isArray(registry)
    ? createRendererDOMRegistry(registry)
    : registry
  const path = mouseBubblePath(
    normalized.nodes.map(toHitTestNode),
    point,
  ) as MouseBubblePath

  return {
    ...(path.target ? { target: normalized.byId.get(path.target.id) } : {}),
    path: path.path
      .map(node => normalized.byId.get(node.id))
      .filter((node): node is RendererDOMNode => Boolean(node)),
  }
}

function normalizeRendererDOMNode(
  node: RendererDOMNode,
  index: number,
): RendererDOMNode {
  return {
    ...node,
    rect: normalizeRect(node.rect),
    order: node.order ?? index,
  }
}

function inheritNoSelect(
  node: RendererDOMNode,
  byId: Map<string, RendererDOMNode>,
  seen = new Set<string>(),
): RendererDOMNode {
  if (node.noSelect || !node.parentId || seen.has(node.id)) {
    return node
  }

  seen.add(node.id)
  const parent = byId.get(node.parentId)
  if (!parent) {
    return node
  }

  return inheritNoSelect(parent, byId, seen).noSelect
    ? { ...node, noSelect: true }
    : node
}

function toHitTestNode(node: RendererDOMNode): HitTestNode {
  return {
    id: node.id,
    rect: node.rect,
    parentId: node.parentId,
    zIndex: node.zIndex,
    overlay: node.overlay,
    order: node.order,
    pointerEvents: node.pointerEvents,
  }
}

function clipTextToRect(text: string, rect: Rect): string {
  if (rect.width <= 0 || rect.height <= 0) {
    return ''
  }

  return text
    .split(/\r?\n/)
    .slice(0, rect.height)
    .map(line => line.slice(0, rect.width))
    .join('\n')
}
