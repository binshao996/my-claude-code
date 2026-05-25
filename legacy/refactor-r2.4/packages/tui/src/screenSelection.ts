import type { TuiMessage } from './tuiTypes.js'
import { messageRolePrefix, messageRowsForDisplay } from './messageMarkdown.js'
import { wrapTerminalText } from './windowing.js'

export type ScreenPane = 'status' | 'messages' | 'prompt' | 'overlay'

export type ScreenSelectionPoint = {
  row: number
  column: number
}

export type ScreenColumnRange = {
  start: number
  end: number
}

export type ScreenSelection = {
  anchor: ScreenSelectionPoint
  focus: ScreenSelectionPoint
}

export type ScreenSelectableRow = {
  pane: ScreenPane
  text: string
  selectable?: boolean
  noSelectRanges?: ScreenColumnRange[]
}

export type ScreenSelectionRowSlice = {
  before: string
  selected: string
  after: string
}

export type ScreenSelectionRowPart = {
  text: string
  selected: boolean
}

export function buildScreenSelectionRows(args: {
  status?: string
  statusRows?: string[]
  messages: TuiMessage[]
  messageRows?: Array<{
    message: TuiMessage
    rows: string[]
  }>
  olderHiddenMessages?: number
  newerHiddenMessages?: number
  activityRows?: string[]
  promptValue?: string
  promptPrefix?: string
  overlays?: string[]
  noSelectDecorations?: boolean
  columns?: number
}): ScreenSelectableRow[] {
  const rows: ScreenSelectableRow[] = []
  for (const statusRow of args.statusRows ?? []) {
    pushWrappedScreenRows(rows, {
      pane: 'status',
      text: statusRow,
      selectable: false,
      columns: args.columns,
    })
  }
  if (!args.statusRows && args.status) {
    pushWrappedScreenRows(rows, {
      pane: 'status',
      text: args.status,
      selectable: false,
      columns: args.columns,
    })
  }

  if (args.olderHiddenMessages && args.olderHiddenMessages > 0) {
    pushWrappedScreenRows(rows, {
      pane: 'messages',
      text: `${args.olderHiddenMessages} earlier messages hidden`,
      selectable: false,
      columns: args.columns,
    })
  }

  const messageRows = args.messageRows ??
    args.messages.map(message => ({
      message,
      rows: messageRowsForDisplay(message, args.columns),
    }))

  for (const { message, rows: displayRows } of messageRows) {
    for (const row of displayRows) {
      rows.push({
        pane: 'messages',
        text: row,
        selectable: true,
        noSelectRanges: args.noSelectDecorations
          ? noSelectDecorationRanges(row, message.role)
          : undefined,
      })
    }
  }

  if (args.newerHiddenMessages && args.newerHiddenMessages > 0) {
    pushWrappedScreenRows(rows, {
      pane: 'messages',
      text: `${args.newerHiddenMessages} newer messages hidden`,
      selectable: false,
      columns: args.columns,
    })
  }

  for (const activityRow of args.activityRows ?? []) {
    pushWrappedScreenRows(rows, {
      pane: 'messages',
      text: activityRow,
      selectable: false,
      columns: args.columns,
    })
  }

  for (const overlay of args.overlays ?? []) {
    for (const line of overlay.split('\n')) {
      pushWrappedScreenRows(rows, {
        pane: 'overlay',
        text: line,
        selectable: true,
        columns: args.columns,
      })
    }
  }

  if (args.promptValue !== undefined) {
    const prefix = args.promptPrefix ?? '> '
    const lines = args.promptValue.split('\n')
    for (const [index, line] of lines.entries()) {
      const linePrefix = index === 0 ? prefix : ' '.repeat(prefix.length)
      pushWrappedScreenRows(rows, {
        pane: 'prompt',
        text: `${linePrefix}${line}`,
        selectable: true,
        noSelectPrefixLength: args.noSelectDecorations ? linePrefix.length : undefined,
        columns: args.columns,
      })
    }
  }

  return rows
}

function pushWrappedScreenRows(
  rows: ScreenSelectableRow[],
  args: {
    pane: ScreenPane
    text: string
    selectable: boolean
    noSelectPrefixLength?: number
    columns?: number
  },
) {
  for (const [index, text] of wrapTerminalText(args.text, args.columns).entries()) {
    rows.push({
      pane: args.pane,
      text,
      selectable: args.selectable,
      noSelectRanges:
        index === 0 && args.noSelectPrefixLength !== undefined && args.noSelectPrefixLength > 0
          ? [{ start: 0, end: Math.min(args.noSelectPrefixLength, text.length) }]
          : undefined,
    })
  }
}

export function selectedScreenText(
  rows: ScreenSelectableRow[],
  selection: ScreenSelection | undefined,
): string {
  if (!selection) {
    return ''
  }

  const bounds = normalizeScreenSelection(selection)
  const selected: string[] = []
  for (let rowIndex = bounds.start.row; rowIndex <= bounds.end.row; rowIndex++) {
    const row = rows[rowIndex]
    if (!row?.selectable) {
      continue
    }

    const startColumn = rowIndex === bounds.start.row ? bounds.start.column : 0
    const endColumn = rowIndex === bounds.end.row ? bounds.end.column : row.text.length
    const text = selectableTextSlice(row.text, startColumn, endColumn, row.noSelectRanges)
    if (text || bounds.start.row === bounds.end.row) {
      selected.push(text)
    }
  }

  return selected.join('\n')
}

export function selectionSliceForRow(
  rowIndex: number,
  row: string | ScreenSelectableRow,
  selection: ScreenSelection | undefined,
): ScreenSelectionRowSlice | undefined {
  if (!selection) {
    return undefined
  }

  const bounds = normalizeScreenSelection(selection)
  const rowText = typeof row === 'string' ? row : row.text
  const noSelectRanges = typeof row === 'string' ? undefined : row.noSelectRanges
  if (rowIndex < bounds.start.row || rowIndex > bounds.end.row) {
    return undefined
  }

  const startColumn = rowIndex === bounds.start.row ? bounds.start.column : 0
  const endColumn = rowIndex === bounds.end.row ? bounds.end.column : rowText.length
  const selectableRange = trimNoSelectEdges(
    {
      start: Math.max(0, Math.min(rowText.length, startColumn)),
      end: Math.max(0, Math.min(rowText.length, endColumn)),
    },
    noSelectRanges,
  )
  const start = selectableRange.start
  const end = Math.max(start, selectableRange.end)
  if (start === end) {
    return undefined
  }

  return {
    before: rowText.slice(0, start),
    selected: rowText.slice(start, end),
    after: rowText.slice(end),
  }
}

export function selectionPartsForRow(
  rowIndex: number,
  row: string | ScreenSelectableRow,
  selection: ScreenSelection | undefined,
): ScreenSelectionRowPart[] | undefined {
  if (!selection) {
    return undefined
  }

  const bounds = normalizeScreenSelection(selection)
  const rowText = typeof row === 'string' ? row : row.text
  const noSelectRanges = typeof row === 'string' ? undefined : row.noSelectRanges
  if (rowIndex < bounds.start.row || rowIndex > bounds.end.row) {
    return undefined
  }

  const startColumn = rowIndex === bounds.start.row ? bounds.start.column : 0
  const endColumn = rowIndex === bounds.end.row ? bounds.end.column : rowText.length
  const selectedRange = {
    start: Math.max(0, Math.min(rowText.length, startColumn)),
    end: Math.max(0, Math.min(rowText.length, endColumn)),
  }
  if (selectedRange.start >= selectedRange.end) {
    return undefined
  }

  const selectedRanges = selectableColumnRanges(selectedRange, noSelectRanges, rowText.length)
  if (selectedRanges.length === 0) {
    return undefined
  }

  const breakpoints = new Set([0, rowText.length, selectedRange.start, selectedRange.end])
  for (const range of normalizeNoSelectRanges(noSelectRanges, rowText.length)) {
    breakpoints.add(range.start)
    breakpoints.add(range.end)
  }
  for (const range of selectedRanges) {
    breakpoints.add(range.start)
    breakpoints.add(range.end)
  }

  const columns = [...breakpoints].sort((left, right) => left - right)
  const parts: ScreenSelectionRowPart[] = []
  for (let index = 0; index < columns.length - 1; index++) {
    const start = columns[index] as number
    const end = columns[index + 1] as number
    if (start === end) {
      continue
    }

    const text = rowText.slice(start, end)
    if (!text) {
      continue
    }

    parts.push({
      text,
      selected: selectedRanges.some((range) => start >= range.start && end <= range.end),
    })
  }

  return parts
}

export type ScreenHit = {
  rowIndex: number
  column: number
  row: ScreenSelectableRow
  selectable: boolean
  insideNoSelect: boolean
}

export function normalizeNoSelectRanges(
  ranges: ScreenColumnRange[] | undefined,
  rowLength = Number.POSITIVE_INFINITY,
): ScreenColumnRange[] {
  const max = Number.isFinite(rowLength)
    ? Math.max(0, Math.floor(rowLength))
    : Number.POSITIVE_INFINITY
  const normalized = (ranges ?? [])
    .map((range) => ({
      start: Math.max(0, Math.min(max, Math.floor(range.start))),
      end: Math.max(0, Math.min(max, Math.floor(range.end))),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: ScreenColumnRange[] = []

  for (const range of normalized) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end) {
      merged.push(range)
      continue
    }

    previous.end = Math.max(previous.end, range.end)
  }

  return merged
}

export function hitTestScreenRows(
  rows: ScreenSelectableRow[],
  point: ScreenSelectionPoint,
): ScreenHit | undefined {
  const normalized = normalizePoint(point)
  const row = rows[normalized.row]
  if (!row) {
    return undefined
  }

  const column = Math.max(0, Math.min(row.text.length, normalized.column))
  return {
    rowIndex: normalized.row,
    column,
    row,
    selectable: Boolean(row.selectable),
    insideNoSelect: isColumnNoSelect(column, row.noSelectRanges),
  }
}

export function selectablePointFromHit(hit: ScreenHit): ScreenSelectionPoint | undefined {
  if (!hit.selectable) {
    return undefined
  }

  return {
    row: hit.rowIndex,
    column: nearestSelectableColumn(hit.column, hit.row.text.length, hit.row.noSelectRanges),
  }
}

export function screenPointFromTerminalMouse(args: {
  row: number
  column: number
}): ScreenSelectionPoint {
  return {
    row: Math.max(0, args.row - 1),
    column: Math.max(0, args.column - 1),
  }
}

export function normalizeScreenSelection(selection: ScreenSelection): {
  start: ScreenSelectionPoint
  end: ScreenSelectionPoint
} {
  const anchor = normalizePoint(selection.anchor)
  const focus = normalizePoint(selection.focus)
  if (anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)) {
    return { start: anchor, end: focus }
  }

  return { start: focus, end: anchor }
}

function normalizePoint(point: ScreenSelectionPoint): ScreenSelectionPoint {
  return {
    row: Math.max(0, Math.floor(point.row)),
    column: Math.max(0, Math.floor(point.column)),
  }
}

function sliceColumns(text: string, startColumn: number, endColumn: number): string {
  const start = Math.max(0, Math.min(text.length, startColumn))
  const end = Math.max(start, Math.min(text.length, endColumn))
  return text.slice(start, end)
}

function selectableTextSlice(
  text: string,
  startColumn: number,
  endColumn: number,
  noSelectRanges: ScreenColumnRange[] | undefined,
): string {
  return selectableColumnRanges(
    {
      start: startColumn,
      end: endColumn,
    },
    noSelectRanges,
    text.length,
  )
    .map((range) => sliceColumns(text, range.start, range.end))
    .join('')
}

function trimNoSelectEdges(
  range: ScreenColumnRange,
  noSelectRanges: ScreenColumnRange[] | undefined,
): ScreenColumnRange {
  if (!noSelectRanges?.length) {
    return range
  }

  let start = range.start
  let end = range.end
  while (start < end && isColumnNoSelect(start, noSelectRanges)) {
    start++
  }
  while (end > start && isColumnNoSelect(end - 1, noSelectRanges)) {
    end--
  }

  return { start, end }
}

function selectableColumnRanges(
  range: ScreenColumnRange,
  noSelectRanges: ScreenColumnRange[] | undefined,
  rowLength: number,
): ScreenColumnRange[] {
  const selectedRange = {
    start: Math.max(0, Math.min(rowLength, Math.floor(range.start))),
    end: Math.max(0, Math.min(rowLength, Math.floor(range.end))),
  }
  if (selectedRange.end <= selectedRange.start) {
    return []
  }

  const noSelect = normalizeNoSelectRanges(noSelectRanges, rowLength)
  const ranges: ScreenColumnRange[] = []
  let cursor = selectedRange.start
  for (const blocked of noSelect) {
    if (blocked.end <= cursor) {
      continue
    }
    if (blocked.start >= selectedRange.end) {
      break
    }
    if (blocked.start > cursor) {
      ranges.push({
        start: cursor,
        end: Math.min(blocked.start, selectedRange.end),
      })
    }
    cursor = Math.max(cursor, blocked.end)
  }

  if (cursor < selectedRange.end) {
    ranges.push({
      start: cursor,
      end: selectedRange.end,
    })
  }

  return ranges
}

function nearestSelectableColumn(
  column: number,
  rowLength: number,
  noSelectRanges: ScreenColumnRange[] | undefined,
): number {
  const normalized = normalizeNoSelectRanges(noSelectRanges, rowLength)
  if (!normalized.length || !isColumnNoSelect(column, normalized)) {
    return column
  }

  for (let next = column; next <= rowLength; next++) {
    if (!isColumnNoSelect(next, normalized)) {
      return next
    }
  }

  for (let previous = column; previous >= 0; previous--) {
    if (!isColumnNoSelect(previous, normalized)) {
      return previous
    }
  }

  return column
}

function isColumnNoSelect(
  column: number,
  noSelectRanges: ScreenColumnRange[] | undefined,
): boolean {
  return Boolean(noSelectRanges?.some((range) => column >= range.start && column < range.end))
}

function noSelectDecorationRanges(
  row: string,
  role: TuiMessage['role'],
): ScreenColumnRange[] | undefined {
  const rolePrefix = messageRolePrefix(role)
  if (rolePrefix && row.startsWith(rolePrefix)) {
    return [{ start: 0, end: rolePrefix.length }]
  }

  const leadingSpaces = row.match(/^ +/)?.[0].length ?? 0
  return leadingSpaces > 0 ? [{ start: 0, end: leadingSpaces }] : undefined
}
