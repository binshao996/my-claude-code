import { useCallback, type Ref } from 'react'
import {
  Box,
  measureElement,
  Text,
  type DOMElement,
  type ThemePalette,
  useTheme,
} from '@anthropic/ink'
import type { TuiMessage } from '../tuiTypes.js'
import { messageRowsForDisplay } from '../messageMarkdown.js'
import {
  selectionSliceForRow,
  type ScreenSelection,
  type ScreenSelectableRow,
} from '../screenSelection.js'
import {
  hiddenMessageCount,
  type MessageHeightMap,
  messageRowCount,
  newerHiddenMessageCount,
  windowMessageRowRangesInWindow,
  windowMessages,
} from '../windowing.js'
import {
  offsetFromEndFromScrollTop,
  ScrollBox,
  type ScrollBoxHandle,
  scrollTopFromOffsetFromEnd,
} from './ScrollBox.js'

export type MessageListHeaderRow = {
  id: string
  art?: string
  text: string
  strong?: boolean
}

export function MessageList(props: {
  messages: TuiMessage[]
  maxVisibleMessages: number
  headerRows?: MessageListHeaderRow[]
  scrollOffsetFromEnd?: number
  maxVisibleRows?: number
  columns?: number
  measuredRows?: MessageHeightMap
  onMeasure?(messageId: string, rows: number): void
  selection?: ScreenSelection
  selectionRows?: ScreenSelectableRow[]
  startRow?: number
  scrollRef?: Ref<ScrollBoxHandle>
  scrollDrainRowsPerTick?: number
  onScrollOffsetFromEndChange?(offset: number): void
}) {
  const theme = useTheme()
  if (props.maxVisibleRows !== undefined) {
    const headerRows = props.headerRows ?? []
    const headerRowCount = headerRows.length
    const messageRows = totalMessageRows(
      props.messages,
      props.columns,
      props.measuredRows,
    )
    const scrollHeight = headerRowCount + messageRows
    const viewportRows = effectiveMessageViewportRows(
      props.maxVisibleRows,
      scrollHeight,
    )
    const scrollTop = scrollTopFromOffsetFromEnd({
      scrollHeight,
      viewportRows,
      offsetFromEnd: props.scrollOffsetFromEnd ?? 0,
    })
    const windowStart = scrollTop
    const windowEnd = scrollTop + viewportRows
    const visibleHeaderRows = headerRows.slice(
      Math.max(0, windowStart),
      Math.max(0, Math.min(headerRowCount, windowEnd)),
    )
    const rowWindow = windowMessageRowRangesInWindow(
      props.messages,
      Math.max(0, windowStart - headerRowCount),
      Math.max(0, windowEnd - headerRowCount),
      props.columns,
      props.measuredRows,
    )
    const normalizedOffsetFromEnd = offsetFromEndFromScrollTop({
      scrollHeight,
      viewportRows,
      scrollTop,
    })
    let rowIndex = props.startRow ?? visibleHeaderRows.length

    return (
      <Box flexDirection="column" height={viewportRows} width="100%" overflow="hidden">
        <ScrollBox
          ref={props.scrollRef}
          viewportRows={viewportRows}
          scrollHeight={scrollHeight}
          scrollTop={scrollTop}
          stickyScroll={normalizedOffsetFromEnd === 0}
          viewportTop={0}
          maxDrainRowsPerTick={
            props.scrollDrainRowsPerTick ?? Math.max(1, Math.ceil(viewportRows / 2))
          }
          onScrollTopChange={nextScrollTop => {
            props.onScrollOffsetFromEndChange?.(
              offsetFromEndFromScrollTop({
                scrollHeight,
                viewportRows,
                scrollTop: nextScrollTop,
              }),
            )
          }}
        >
          {visibleHeaderRows.map(row => {
            return (
              <HeaderLine
                key={row.id}
                row={row}
                mutedColor={theme.palette.muted}
                foregroundColor={theme.palette.foreground ?? 'white'}
                warningColor={theme.palette.warning}
              />
            )
          })}
          {rowWindow.ranges.map(range => {
            const allRows = renderedMessageRows(range.message, props.columns)
            const rows = allRows.slice(
              range.visibleStart - range.start,
              range.visibleEnd - range.start,
            )
            const messageStartRow = rowIndex
            rowIndex += rows.length
            return (
              <MessageLine
                key={`${range.message.id}:${range.visibleStart}:${range.visibleEnd}`}
                message={range.message}
                palette={theme.palette}
                columns={props.columns}
                startRow={messageStartRow}
                rows={rows}
                selection={props.selection}
                selectionRows={props.selectionRows}
                inverse={range.message.role === 'user'}
                onMeasure={undefined}
              />
            )
          })}
        </ScrollBox>
      </Box>
    )
  }

  const hidden = hiddenMessageCount(
    props.messages,
    props.maxVisibleMessages,
    props.scrollOffsetFromEnd,
  )
  const newerHidden = newerHiddenMessageCount(
    props.messages,
    props.scrollOffsetFromEnd,
  )
  const visible = windowMessages(
    props.messages,
    props.maxVisibleMessages,
    props.scrollOffsetFromEnd,
  )

  let rowIndex = props.startRow ?? 0

  return (
    <Box flexDirection="column">
      {hidden > 0 ? (
        <HiddenMessagesRow
          text={`${hidden} earlier messages hidden`}
          rowIndex={rowIndex++}
        />
      ) : null}
      {visible.map(message => {
        const messageStartRow = rowIndex
        rowIndex += renderedMessageRowCount(message, props.columns)
        return (
          <MessageLine
            key={message.id}
            message={message}
            palette={theme.palette}
            columns={props.columns}
            startRow={messageStartRow}
            selection={props.selection}
            selectionRows={props.selectionRows}
            inverse={message.role === 'user'}
            onMeasure={props.onMeasure}
          />
        )
      })}
      {newerHidden > 0 ? (
        <HiddenMessagesRow
          text={`${newerHidden} newer messages hidden`}
          rowIndex={rowIndex++}
        />
      ) : null}
    </Box>
  )
}

function HeaderLine(props: {
  row: MessageListHeaderRow
  mutedColor: string
  foregroundColor: string
  warningColor: string
}) {
  if (!props.row.art && !props.row.text) {
    return <Text> </Text>
  }

  return (
    <Box height={1}>
      {props.row.art ? (
        <Text color={props.warningColor}>{props.row.art.padEnd(12)}</Text>
      ) : null}
      <Text color={props.row.strong ? props.foregroundColor : props.mutedColor}>
        {props.row.text}
      </Text>
    </Box>
  )
}

function MessageLine(props: {
  message: TuiMessage
  palette: ThemePalette
  columns?: number
  startRow: number
  selection?: ScreenSelection
  selectionRows?: ScreenSelectableRow[]
  onMeasure?(messageId: string, rows: number): void
  inverse?: boolean
  rows?: string[]
}) {
  const measureRef = useCallback(
    (element: DOMElement | null) =>
      measureMessageLine(element, props.message.id, props.onMeasure),
    [props.message.id, props.onMeasure],
  )
  const color = roleColor(props.message.role, props.palette)
  const rows = props.rows ?? renderedMessageRows(props.message, props.columns)
  const renderedLines = []
  let rowIndex = props.startRow
  for (const row of rows) {
    renderedLines.push(
      <SelectableTextRow
        key={`${props.message.id}:${rowIndex}`}
        text={row}
        color={color}
        columns={props.columns}
        inverse={props.inverse}
        rowIndex={rowIndex}
        selection={props.selection}
        selectionRow={props.selectionRows?.[rowIndex]}
      />,
    )
    rowIndex++
  }

  return (
    <Box
      flexDirection="column"
      ref={measureRef}
    >
      {renderedLines}
    </Box>
  )
}

function renderedMessageRows(
  message: TuiMessage,
  columns?: number,
): string[] {
  return messageRowsForDisplay(message, columns)
}

function renderedMessageRowCount(message: TuiMessage, columns?: number): number {
  return renderedMessageRows(message, columns).length
}

function HiddenMessagesRow(props: {
  text: string
  rowIndex: number
}) {
  const theme = useTheme()
  return <Text color={theme.palette.muted}>{props.text}</Text>
}

function SelectableTextRow(props: {
  text: string
  color?: string
  columns?: number
  inverse?: boolean
  rowIndex: number
  selection?: ScreenSelection
  selectionRow?: ScreenSelectableRow
}) {
  const text = props.inverse && props.columns
    ? props.text.padEnd(Math.max(props.text.length, props.columns))
    : props.text
  const slice = selectionSliceForRow(
    props.rowIndex,
    props.selectionRow ?? text,
    props.selection,
  )
  if (!slice) {
    return <Text color={props.color} inverse={props.inverse}>{text}</Text>
  }

  return (
    <Text>
      <Text color={props.color} inverse={props.inverse}>{slice.before}</Text>
      <Text inverse>{slice.selected}</Text>
      <Text color={props.color} inverse={props.inverse}>{slice.after}</Text>
    </Text>
  )
}

function totalMessageRows(
  messages: TuiMessage[],
  columns?: number,
  measuredRows?: MessageHeightMap,
): number {
  return messages.reduce(
    (total, message) => total + messageRowCount(message, columns, measuredRows),
    0,
  )
}

function effectiveMessageViewportRows(
  maxVisibleRows: number,
  scrollHeight: number,
): number {
  return Math.max(1, Math.min(maxVisibleRows, Math.max(1, scrollHeight)))
}

function measureMessageLine(
  element: DOMElement | null,
  messageId: string,
  onMeasure: ((messageId: string, rows: number) => void) | undefined,
) {
  if (!element || !onMeasure) {
    return
  }

  const measured = measureElement(element)
  if (measured.height > 0) {
    onMeasure(messageId, measured.height)
  }
}

function roleColor(
  role: TuiMessage['role'],
  palette: ThemePalette,
): string | undefined {
  switch (role) {
    case 'user':
      return palette.accent
    case 'assistant':
      return undefined
    case 'tool':
      return palette.warning
    case 'error':
      return palette.error
    case 'system':
      return palette.muted
  }
}
