export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

export type HitTestNode = {
  id: string
  rect: Rect
  parentId?: string
  zIndex?: number
  overlay?: boolean
  order?: number
  pointerEvents?: 'auto' | 'none'
}

export type MousePoint = {
  x: number
  y: number
}

export type MouseBubblePath = {
  target?: HitTestNode
  path: HitTestNode[]
}

export type DOMRectLike = {
  x?: number
  y?: number
  left?: number
  top?: number
  width?: number
  height?: number
}

export type DOMElementLike = DOMRectLike & {
  yogaNode?: {
    getComputedLeft?: () => number
    getComputedTop?: () => number
    getComputedWidth?: () => number
    getComputedHeight?: () => number
  }
  node?: DOMRectLike
}

export function hitTestNodes(nodes: HitTestNode[], point: MousePoint): HitTestNode | undefined {
  return nodes
    .map((node, index) => ({ node, index }))
    .filter((entry) => entry.node.pointerEvents !== 'none' && pointInRect(point, entry.node.rect))
    .sort(compareHitPriority)
    .map((entry) => entry.node)
    .at(0)
}

export function mouseBubblePath(nodes: HitTestNode[], point: MousePoint): MouseBubblePath {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const target = hitTestNodes(nodes, point)
  const path: HitTestNode[] = []
  let current = target

  while (current) {
    path.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }

  return {
    ...(target ? { target } : {}),
    path,
  }
}

export function updateNodeRect(nodes: HitTestNode[], id: string, rect: Rect): HitTestNode[] {
  return nodes.map((node) => (node.id === id ? { ...node, rect: normalizeRect(rect) } : node))
}

export function normalizeRect(rect: Rect): Rect {
  return {
    x: Math.floor(readFiniteNumber(rect.x, 0)),
    y: Math.floor(readFiniteNumber(rect.y, 0)),
    width: Math.max(0, Math.ceil(readFiniteNumber(rect.width, 0))),
    height: Math.max(0, Math.ceil(readFiniteNumber(rect.height, 0))),
  }
}

export function rectFromDOMElement(
  element: DOMElementLike | null | undefined,
  fallback: Partial<Rect> = {},
): Rect {
  const yogaNode = element?.yogaNode
  const source = element?.node ?? element

  return normalizeRect({
    x: readFiniteNumber(
      yogaNode?.getComputedLeft?.(),
      readFiniteNumber(source?.x, readFiniteNumber(source?.left, fallback.x ?? 0)),
    ),
    y: readFiniteNumber(
      yogaNode?.getComputedTop?.(),
      readFiniteNumber(source?.y, readFiniteNumber(source?.top, fallback.y ?? 0)),
    ),
    width: readFiniteNumber(
      yogaNode?.getComputedWidth?.(),
      readFiniteNumber(source?.width, fallback.width ?? 0),
    ),
    height: readFiniteNumber(
      yogaNode?.getComputedHeight?.(),
      readFiniteNumber(source?.height, fallback.height ?? 0),
    ),
  })
}

function compareHitPriority(
  left: { node: HitTestNode; index: number },
  right: { node: HitTestNode; index: number },
): number {
  const layerDelta = Number(Boolean(right.node.overlay)) - Number(Boolean(left.node.overlay))
  if (layerDelta !== 0) {
    return layerDelta
  }

  const zIndexDelta = (right.node.zIndex ?? 0) - (left.node.zIndex ?? 0)
  if (zIndexDelta !== 0) {
    return zIndexDelta
  }

  const areaDelta = area(left.node.rect) - area(right.node.rect)
  if (areaDelta !== 0) {
    return areaDelta
  }

  return (right.node.order ?? right.index) - (left.node.order ?? left.index)
}

function pointInRect(point: MousePoint, rect: Rect): boolean {
  const normalized = normalizeRect(rect)
  return (
    point.x >= normalized.x &&
    point.y >= normalized.y &&
    point.x < normalized.x + normalized.width &&
    point.y < normalized.y + normalized.height
  )
}

function area(rect: Rect): number {
  const normalized = normalizeRect(rect)
  return normalized.width * normalized.height
}

function readFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
