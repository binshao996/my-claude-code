import type { TuiMessage } from './tuiTypes.js'
import { messageRowsForDisplay } from './messageMarkdown.js'

export type MessageScrollSnapshot = {
  anchorId?: string
  scrollOffsetFromEnd: number
}

export type TerminalSizeLike = {
  rows?: number
  columns?: number
}

export type MessageViewport = {
  rows: number
  columns?: number
}

export type MessageHeightMap = ReadonlyMap<string, number>

export type WindowedMessageRowRange = {
  message: TuiMessage
  index: number
  start: number
  end: number
  visibleStart: number
  visibleEnd: number
}

export function measureMessageViewport(
  output: unknown,
  options: {
    reservedRows?: number
    fallbackRows?: number
    fallbackColumns?: number
  } = {},
): MessageViewport {
  const reservedRows = options.reservedRows ?? 8
  const fallbackRows = options.fallbackRows ?? 20
  const outputSize = isTerminalSizeLike(output) ? output : undefined
  const rows = readPositiveNumber(outputSize?.rows)
  const columns =
    readPositiveNumber(outputSize?.columns) ??
    readPositiveNumber(options.fallbackColumns)

  return {
    rows: rows ? Math.max(5, rows - reservedRows) : fallbackRows,
    columns: columns && columns >= 10 ? Math.floor(columns) : undefined,
  }
}

export function windowMessages(
  messages: TuiMessage[],
  maxVisibleMessages: number,
  scrollOffsetFromEnd = 0,
): TuiMessage[] {
  if (maxVisibleMessages < 1) {
    return []
  }

  const safeOffset = Math.max(0, scrollOffsetFromEnd)
  const end = Math.max(maxVisibleMessages, messages.length - safeOffset)
  const start = Math.max(0, end - maxVisibleMessages)

  return messages.slice(start, end)
}

export function hiddenMessageCount(
  messages: TuiMessage[],
  maxVisibleMessages: number,
  scrollOffsetFromEnd = 0,
): number {
  return Math.max(
    0,
    messages.length - Math.max(0, maxVisibleMessages) - Math.max(0, scrollOffsetFromEnd),
  )
}

export function newerHiddenMessageCount(
  messages: TuiMessage[],
  scrollOffsetFromEnd = 0,
): number {
  return Math.min(messages.length, Math.max(0, scrollOffsetFromEnd))
}

export function moveMessageScroll(
  messages: TuiMessage[],
  maxVisibleMessages: number,
  currentOffset: number,
  direction: 'older' | 'newer' | 'latest',
): number {
  const maxOffset = Math.max(0, messages.length - maxVisibleMessages)
  switch (direction) {
    case 'older':
      return Math.min(maxOffset, currentOffset + maxVisibleMessages)
    case 'newer':
      return Math.max(0, currentOffset - maxVisibleMessages)
    case 'latest':
      return 0
  }
}

export function moveMessageRowScroll(
  messages: TuiMessage[],
  maxVisibleRows: number,
  currentOffsetRows: number,
  direction: 'older' | 'newer' | 'latest',
  columns?: number,
  measuredRows?: MessageHeightMap,
): number {
  const totalRows = messages.reduce(
    (total, message) => total + messageRowCount(message, columns, measuredRows),
    0,
  )
  const maxOffset = Math.max(0, totalRows - maxVisibleRows)
  switch (direction) {
    case 'older':
      return Math.min(maxOffset, currentOffsetRows + maxVisibleRows)
    case 'newer':
      return Math.max(0, currentOffsetRows - maxVisibleRows)
    case 'latest':
      return 0
  }
}

export function captureMessageScrollSnapshot(
  messages: TuiMessage[],
  maxVisibleMessages: number,
  scrollOffsetFromEnd = 0,
): MessageScrollSnapshot {
  const visible = windowMessages(
    messages,
    maxVisibleMessages,
    scrollOffsetFromEnd,
  )
  return {
    anchorId: visible.at(-1)?.id,
    scrollOffsetFromEnd: Math.max(0, scrollOffsetFromEnd),
  }
}

export function restoreMessageScroll(
  messages: TuiMessage[],
  maxVisibleMessages: number,
  snapshot: MessageScrollSnapshot,
): number {
  if (!snapshot.anchorId) {
    return Math.min(
      Math.max(0, snapshot.scrollOffsetFromEnd),
      Math.max(0, messages.length - maxVisibleMessages),
    )
  }

  const anchorIndex = messages.findIndex(
    message => message.id === snapshot.anchorId,
  )
  if (anchorIndex === -1) {
    return Math.min(
      Math.max(0, snapshot.scrollOffsetFromEnd),
      Math.max(0, messages.length - maxVisibleMessages),
    )
  }

  return Math.min(
    Math.max(0, messages.length - anchorIndex - 1),
    Math.max(0, messages.length - maxVisibleMessages),
  )
}

export function messageRowCount(
  message: TuiMessage,
  columns?: number,
  measuredRows?: MessageHeightMap,
): number {
  const measured = readMeasuredRows(measuredRows, message.id)
  if (measured !== undefined) {
    return measured
  }

  return messageRowsForDisplay(message, columns).length
}

export function wrapTerminalText(value: string, columns?: number): string[] {
  if (!Number.isFinite(columns) || columns === undefined || columns < 1) {
    return [value]
  }

  const width = Math.max(1, Math.floor(columns))
  const rows: string[] = []
  let current = ''
  let currentWidth = 0

  for (const character of value) {
    const characterWidth = characterDisplayWidth(character)
    if (current && currentWidth + characterWidth > width) {
      rows.push(current)
      current = ''
      currentWidth = 0
    }

    current += character
    currentWidth += characterWidth
  }

  rows.push(current)
  return rows
}

export function terminalDisplayWidth(value: string): number {
  return displayWidth(value)
}

export function windowMessagesByRows(
  messages: TuiMessage[],
  maxVisibleRows: number,
  scrollOffsetRowsFromEnd = 0,
  columns?: number,
  measuredRows?: MessageHeightMap,
): {
  visible: TuiMessage[]
  olderHidden: number
  newerHidden: number
  scrollOffsetRowsFromEnd: number
} {
  const window = windowMessageRowRangesByRows(
    messages,
    maxVisibleRows,
    scrollOffsetRowsFromEnd,
    columns,
    measuredRows,
  )

  return {
    visible: window.ranges.map(range => range.message),
    olderHidden: window.olderHidden,
    newerHidden: window.newerHidden,
    scrollOffsetRowsFromEnd: window.scrollOffsetRowsFromEnd,
  }
}

export function windowMessageRowRangesByRows(
  messages: TuiMessage[],
  maxVisibleRows: number,
  scrollOffsetRowsFromEnd = 0,
  columns?: number,
  measuredRows?: MessageHeightMap,
): {
  ranges: WindowedMessageRowRange[]
  olderHidden: number
  newerHidden: number
  scrollOffsetRowsFromEnd: number
  windowStart: number
  windowEnd: number
  totalRows: number
} {
  if (maxVisibleRows < 1) {
    return {
      ranges: [],
      olderHidden: messages.length,
      newerHidden: 0,
      scrollOffsetRowsFromEnd: 0,
      windowStart: 0,
      windowEnd: 0,
      totalRows: 0,
    }
  }

  const ranges = messageRowRanges(messages, columns, measuredRows)
  const totalRows = ranges.at(-1)?.end ?? 0
  const maxOffset = Math.max(0, totalRows - maxVisibleRows)
  const safeOffset = Math.min(
    maxOffset,
    Math.max(0, scrollOffsetRowsFromEnd),
  )
  const windowEnd = totalRows - safeOffset
  const windowStart = Math.max(0, windowEnd - maxVisibleRows)
  const visibleRanges = ranges.filter(
    range => range.end > windowStart && range.start < windowEnd,
  )
  const firstVisible = visibleRanges[0]?.index ?? messages.length
  const lastVisible = visibleRanges.at(-1)?.index ?? -1

  return {
    ranges: visibleRanges.map(range => ({
      ...range,
      message: messages[range.index] as TuiMessage,
      visibleStart: Math.max(range.start, windowStart),
      visibleEnd: Math.min(range.end, windowEnd),
    })),
    olderHidden: firstVisible,
    newerHidden: Math.max(0, messages.length - lastVisible - 1),
    scrollOffsetRowsFromEnd: safeOffset,
    windowStart,
    windowEnd,
    totalRows,
  }
}

export function windowMessageRowRangesInWindow(
  messages: TuiMessage[],
  windowStart: number,
  windowEnd: number,
  columns?: number,
  measuredRows?: MessageHeightMap,
): {
  ranges: WindowedMessageRowRange[]
  olderHidden: number
  newerHidden: number
  windowStart: number
  windowEnd: number
  totalRows: number
} {
  const ranges = messageRowRanges(messages, columns, measuredRows)
  const totalRows = ranges.at(-1)?.end ?? 0
  const safeStart = Math.max(0, Math.min(totalRows, Math.floor(windowStart)))
  const safeEnd = Math.max(safeStart, Math.min(totalRows, Math.ceil(windowEnd)))
  const visibleRanges = ranges.filter(
    range => range.end > safeStart && range.start < safeEnd,
  )
  const firstVisible = visibleRanges[0]?.index ?? messages.length
  const lastVisible = visibleRanges.at(-1)?.index ?? -1

  return {
    ranges: visibleRanges.map(range => ({
      ...range,
      message: messages[range.index] as TuiMessage,
      visibleStart: Math.max(range.start, safeStart),
      visibleEnd: Math.min(range.end, safeEnd),
    })),
    olderHidden: firstVisible,
    newerHidden: Math.max(0, messages.length - lastVisible - 1),
    windowStart: safeStart,
    windowEnd: safeEnd,
    totalRows,
  }
}

function messageRowRanges(
  messages: TuiMessage[],
  columns?: number,
  measuredRows?: MessageHeightMap,
): Array<{
  index: number
  start: number
  end: number
}> {
  let cursor = 0
  return messages.map((message, index) => {
    const start = cursor
    cursor += messageRowCount(message, columns, measuredRows)
    return {
      index,
      start,
      end: cursor,
    }
  })
}

function readMeasuredRows(
  measuredRows: MessageHeightMap | undefined,
  messageId: string,
): number | undefined {
  const measured = measuredRows?.get(messageId)
  if (!Number.isFinite(measured) || measured === undefined || measured < 1) {
    return undefined
  }

  return Math.ceil(measured)
}

function readPositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function isTerminalSizeLike(value: unknown): value is TerminalSizeLike {
  return typeof value === 'object' && value !== null
}

function displayWidth(value: string): number {
  let width = 0
  for (const character of value) {
    width += characterDisplayWidth(character)
  }

  return width
}

function characterDisplayWidth(character: string): number {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined) {
    return 0
  }

  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0
  }

  if (isCombiningMark(codePoint)) {
    return 0
  }

  return isWideCodePoint(codePoint) ? 2 : 1
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  )
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  )
}
