import { Box, type DOMElement } from 'ink'
import {
  type PropsWithChildren,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import type { Rect } from './hitTest.js'

export type ScrollBoxHandle = {
  scrollTo(y: number): void
  scrollBy(dy: number): void
  scrollToElement(element: ScrollBoxElementTarget, offset?: number): void
  scrollToBottom(): void
  getScrollTop(): number
  getPendingDelta(): number
  getScrollHeight(): number
  getFreshScrollHeight(): number
  getViewportHeight(): number
  getViewportTop(): number
  isSticky(): boolean
  subscribe(listener: () => void): () => void
  setClampBounds(min: number | undefined, max: number | undefined): void
}

export type ScrollBoxElementTarget =
  | DOMElement
  | Rect
  | {
      y?: number
      top?: number
      computedTop?: number
      yogaNode?: {
        getComputedTop(): number
      }
      rect?: {
        y?: number
        top?: number
      }
    }

export type VirtualScrollWindow = {
  visibleStartRow: number
  visibleEndRow: number
  mountedStartRow: number
  mountedEndRow: number
  targetScrollTop: number
}

export type PendingDeltaDrain = {
  scrollTop: number
  pendingDelta: number
  sticky: boolean
}

export type ScrollContainerSnapshot = {
  scrollTop: number
  pendingDelta: number
  scrollHeight: number
  clientHeight: number
  viewportTop: number
  viewportRect: Rect
  contentRect: Rect
  sticky: boolean
}

export type ScrollContainerTick = {
  snapshot: ScrollContainerSnapshot
  frames: ScrollContainerSnapshot[]
  drainedRows: number
  didDrain: boolean
}

export function ScrollBox(
  props: PropsWithChildren<{
    ref?: Ref<ScrollBoxHandle>
    viewportRows: number
    scrollHeight: number
    scrollTop: number
    stickyScroll?: boolean
    viewportTop?: number
    maxDrainRowsPerTick?: number
    onScrollTopChange(scrollTop: number): void
  }>,
) {
  const stickyRef = useRef(Boolean(props.stickyScroll))
  const pendingDeltaRef = useRef(0)
  const listenersRef = useRef(new Set<() => void>())
  const clampBoundsRef = useRef<{
    min?: number
    max?: number
  }>({})

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) {
      listener()
    }
  }, [])

  const setScrollTop = useCallback(
    (nextScrollTop: number, sticky = false, clearPending = true) => {
      const normalized = clampScrollTop({
        scrollTop: nextScrollTop,
        scrollHeight: props.scrollHeight,
        viewportRows: props.viewportRows,
        clampMin: clampBoundsRef.current.min,
        clampMax: clampBoundsRef.current.max,
      })
      stickyRef.current = sticky
      if (clearPending) {
        pendingDeltaRef.current = 0
      }
      props.onScrollTopChange(normalized)
      notify()
    },
    [notify, props.onScrollTopChange, props.scrollHeight, props.viewportRows],
  )

  const drainPendingTick = useCallback(() => {
    if (pendingDeltaRef.current === 0) {
      return
    }

    const maxDrainRows = Math.max(
      1,
      Math.floor(props.maxDrainRowsPerTick ?? Math.abs(pendingDeltaRef.current)),
    )
    const drained = drainPendingScrollDelta({
      scrollTop: props.scrollTop,
      pendingDelta: pendingDeltaRef.current,
      scrollHeight: props.scrollHeight,
      viewportRows: props.viewportRows,
      maxDrainRows,
      clampMin: clampBoundsRef.current.min,
      clampMax: clampBoundsRef.current.max,
    })

    pendingDeltaRef.current = drained.pendingDelta
    setScrollTop(drained.scrollTop, drained.sticky, false)
  }, [
    props.maxDrainRowsPerTick,
    props.scrollHeight,
    props.scrollTop,
    props.viewportRows,
    setScrollTop,
  ])

  useEffect(() => {
    drainPendingTick()
  }, [drainPendingTick])

  useImperativeHandle(
    props.ref,
    (): ScrollBoxHandle => ({
      scrollTo(y: number) {
        setScrollTop(y, false)
      },
      scrollBy(dy: number) {
        pendingDeltaRef.current += Math.floor(dy)
        drainPendingTick()
      },
      scrollToElement(element: ScrollBoxElementTarget, offset = 0) {
        setScrollTop(
          scrollTopForElement({
            element,
            offset,
            scrollHeight: props.scrollHeight,
            viewportRows: props.viewportRows,
            clampMin: clampBoundsRef.current.min,
            clampMax: clampBoundsRef.current.max,
          }),
          false,
        )
      },
      scrollToBottom() {
        setScrollTop(maxScrollTop(props.scrollHeight, props.viewportRows), true)
      },
      getScrollTop() {
        return props.scrollTop
      },
      getPendingDelta() {
        return pendingDeltaRef.current
      },
      getScrollHeight() {
        return props.scrollHeight
      },
      getFreshScrollHeight() {
        return props.scrollHeight
      },
      getViewportHeight() {
        return props.viewportRows
      },
      getViewportTop() {
        return props.viewportTop ?? 0
      },
      isSticky() {
        return stickyRef.current
      },
      subscribe(listener: () => void) {
        listenersRef.current.add(listener)
        return () => {
          listenersRef.current.delete(listener)
        }
      },
      setClampBounds(min: number | undefined, max: number | undefined) {
        clampBoundsRef.current = { min, max }
      },
    }),
    [
      drainPendingTick,
      props.scrollHeight,
      props.scrollTop,
      props.viewportRows,
      props.viewportTop,
      setScrollTop,
    ],
  )

  return (
    <Box flexDirection="column" height={props.viewportRows} overflow="hidden">
      {props.children}
    </Box>
  )
}

export function virtualScrollWindow(args: {
  scrollTop: number
  pendingDelta?: number
  scrollHeight: number
  viewportRows: number
  overscanRows?: number
}): VirtualScrollWindow {
  const targetScrollTop = clampScrollTop({
    scrollTop: args.scrollTop + Math.floor(args.pendingDelta ?? 0),
    scrollHeight: args.scrollHeight,
    viewportRows: args.viewportRows,
  })
  const viewportRows = Math.max(1, Math.ceil(args.viewportRows))
  const scrollHeight = Math.max(0, Math.ceil(args.scrollHeight))
  const overscanRows = Math.max(0, Math.ceil(args.overscanRows ?? viewportRows))
  const travelStart = Math.min(args.scrollTop, targetScrollTop)
  const travelEnd = Math.max(args.scrollTop, targetScrollTop) + viewportRows

  return {
    visibleStartRow: targetScrollTop,
    visibleEndRow: Math.min(scrollHeight, targetScrollTop + viewportRows),
    mountedStartRow: Math.max(0, travelStart - overscanRows),
    mountedEndRow: Math.min(scrollHeight, travelEnd + overscanRows),
    targetScrollTop,
  }
}

export function drainPendingScrollDelta(args: {
  scrollTop: number
  pendingDelta: number
  scrollHeight: number
  viewportRows: number
  maxDrainRows: number
  clampMin?: number
  clampMax?: number
}): PendingDeltaDrain {
  const pending = Math.floor(args.pendingDelta)
  if (pending === 0) {
    return {
      scrollTop: clampScrollTop(args),
      pendingDelta: 0,
      sticky: false,
    }
  }

  const maxStep = Math.max(1, Math.floor(args.maxDrainRows))
  const requestedStep = Math.sign(pending) * Math.min(Math.abs(pending), maxStep)
  const nextScrollTop = clampScrollTop({
    scrollTop: args.scrollTop + requestedStep,
    scrollHeight: args.scrollHeight,
    viewportRows: args.viewportRows,
    clampMin: args.clampMin,
    clampMax: args.clampMax,
  })
  const actualStep = nextScrollTop - clampScrollTop(args)
  const remaining = pending - actualStep
  const min = Math.max(0, Math.floor(args.clampMin ?? 0))
  const max = Math.min(
    maxScrollTop(args.scrollHeight, args.viewportRows),
    Math.floor(args.clampMax ?? Number.POSITIVE_INFINITY),
  )

  return {
    scrollTop: nextScrollTop,
    pendingDelta: nextScrollTop === min || nextScrollTop === max ? 0 : remaining,
    sticky: pending > 0 && nextScrollTop >= max,
  }
}

export function createScrollContainerSnapshot(args: {
  scrollTop: number
  pendingDelta?: number
  scrollHeight: number
  viewportRows: number
  viewportTop?: number
  width?: number
  clampMin?: number
  clampMax?: number
}): ScrollContainerSnapshot {
  const clientHeight = Math.max(1, Math.ceil(args.viewportRows))
  const scrollHeight = Math.max(0, Math.ceil(args.scrollHeight))
  const scrollTop = clampScrollTop({
    scrollTop: args.scrollTop,
    scrollHeight,
    viewportRows: clientHeight,
    clampMin: args.clampMin,
    clampMax: args.clampMax,
  })
  const viewportTop = Math.max(0, Math.floor(args.viewportTop ?? 0))
  const width = Math.max(0, Math.ceil(args.width ?? 0))
  const max = Math.min(
    maxScrollTop(scrollHeight, clientHeight),
    Math.floor(args.clampMax ?? Number.POSITIVE_INFINITY),
  )

  return {
    scrollTop,
    pendingDelta: Math.floor(args.pendingDelta ?? 0),
    scrollHeight,
    clientHeight,
    viewportTop,
    viewportRect: {
      x: 0,
      y: viewportTop,
      width,
      height: clientHeight,
    },
    contentRect: {
      x: 0,
      y: viewportTop - scrollTop,
      width,
      height: scrollHeight,
    },
    sticky: scrollTop >= max,
  }
}

export function drainScrollContainerSnapshot(
  snapshot: ScrollContainerSnapshot,
  maxDrainRows: number,
): ScrollContainerSnapshot {
  const drained = drainPendingScrollDelta({
    scrollTop: snapshot.scrollTop,
    pendingDelta: snapshot.pendingDelta,
    scrollHeight: snapshot.scrollHeight,
    viewportRows: snapshot.clientHeight,
    maxDrainRows,
  })

  return createScrollContainerSnapshot({
    scrollTop: drained.scrollTop,
    pendingDelta: drained.pendingDelta,
    scrollHeight: snapshot.scrollHeight,
    viewportRows: snapshot.clientHeight,
    viewportTop: snapshot.viewportTop,
    width: snapshot.viewportRect.width,
  })
}

export function drainScrollContainerTick(args: {
  snapshot: ScrollContainerSnapshot
  frameBudgetRows: number
  maxFrames?: number
}): ScrollContainerTick {
  const frames: ScrollContainerSnapshot[] = []
  let current = args.snapshot
  const maxFrames = Math.max(1, Math.floor(args.maxFrames ?? 1))
  const frameBudgetRows = Math.max(1, Math.floor(args.frameBudgetRows))
  let drainedRows = 0

  for (let frame = 0; frame < maxFrames; frame++) {
    if (current.pendingDelta === 0) {
      break
    }

    const next = drainScrollContainerSnapshot(current, frameBudgetRows)
    drainedRows += Math.abs(next.scrollTop - current.scrollTop)
    frames.push(next)
    current = next
  }

  return {
    snapshot: current,
    frames,
    drainedRows,
    didDrain: frames.length > 0,
  }
}

export function maxScrollTop(scrollHeight: number, viewportRows: number): number {
  return Math.max(0, Math.ceil(scrollHeight) - Math.max(1, Math.ceil(viewportRows)))
}

export function scrollTopFromOffsetFromEnd(args: {
  scrollHeight: number
  viewportRows: number
  offsetFromEnd: number
}): number {
  return Math.max(
    0,
    maxScrollTop(args.scrollHeight, args.viewportRows) -
      Math.max(0, Math.floor(args.offsetFromEnd)),
  )
}

export function offsetFromEndFromScrollTop(args: {
  scrollHeight: number
  viewportRows: number
  scrollTop: number
}): number {
  return Math.max(
    0,
    maxScrollTop(args.scrollHeight, args.viewportRows) - Math.max(0, Math.floor(args.scrollTop)),
  )
}

export function scrollTopForElement(args: {
  element: ScrollBoxElementTarget
  offset?: number
  scrollHeight: number
  viewportRows: number
  clampMin?: number
  clampMax?: number
}): number {
  return clampScrollTop({
    scrollTop: elementTop(args.element) - Math.floor(args.offset ?? 0),
    scrollHeight: args.scrollHeight,
    viewportRows: args.viewportRows,
    clampMin: args.clampMin,
    clampMax: args.clampMax,
  })
}

function elementTop(element: ScrollBoxElementTarget): number {
  const candidate = element as ScrollBoxElementTarget & {
    y?: number
    top?: number
    computedTop?: number
    yogaNode?: {
      getComputedTop(): number
    }
    rect?: {
      y?: number
      top?: number
    }
  }
  const top =
    candidate.yogaNode?.getComputedTop() ??
    candidate.computedTop ??
    candidate.y ??
    candidate.top ??
    candidate.rect?.y ??
    candidate.rect?.top ??
    0
  return Math.max(0, Math.floor(top))
}

function clampScrollTop(args: {
  scrollTop: number
  scrollHeight: number
  viewportRows: number
  clampMin?: number
  clampMax?: number
}): number {
  const min = Math.max(0, Math.floor(args.clampMin ?? 0))
  const max = Math.min(
    maxScrollTop(args.scrollHeight, args.viewportRows),
    Math.floor(args.clampMax ?? Number.POSITIVE_INFINITY),
  )
  return Math.max(min, Math.min(max, Math.floor(args.scrollTop)))
}
