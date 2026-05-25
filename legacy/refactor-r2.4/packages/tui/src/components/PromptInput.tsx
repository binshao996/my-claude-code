import { useState } from 'react'
import { Box, getKeyName, Text, useInput } from '@anthropic/ink'
import {
  applyPromptVimKey,
  applyPromptCompletion,
  completeSlashCommandBuffer,
  deletePromptLineBackward,
  deletePromptLineForward,
  deletePromptInputBackward,
  deletePromptInputForward,
  deletePromptSelection,
  deletePromptWordBackward,
  insertPromptInput,
  insertPromptNewlineBuffer,
  isTerminalControlInput,
  movePromptCompletionSelection,
  movePromptCursor,
  parseSgrMouseEvent,
  promptDeletionDirection,
  promptCompletionMenu,
  promptCompletionSourceFooter,
  promptCursorFromMouseColumn,
  promptSelectionRange,
  renderPromptWithSelection,
  renderPromptWithCursor,
  replacePromptSelection,
  sanitizeTerminalControlInput,
  searchPromptHistory,
  selectedPromptCompletion,
  selectedPromptText,
} from '../promptEditing.js'
import {
  selectionSliceForRow,
  type ScreenSelection,
  type ScreenSelectableRow,
} from '../screenSelection.js'
import { copyTextToSystemClipboard } from '../clipboard.js'
import type {
  PromptVimMode,
  PromptVimPendingOperator,
} from '../promptEditing.js'

export function PromptInput(props: {
  value: string
  cursor: number
  columns?: number
  history: string[]
  historyIndex?: number
  isRunning: boolean
  onChange(value: string, cursor?: number): void
  onSubmit(value: string): void
  onHistoryIndexChange(index: number | undefined): void
  onAbort(): void
  onExit(): void
  onPermissionDismiss(): void
  onClipboardResult?(result: { ok: boolean; textLength: number }): void
  screenSelection?: ScreenSelection
  screenSelectionRows?: ScreenSelectableRow[]
  screenSelectionStartRow?: number
  screenSelectionText?: string
  onScreenSelectionCopy?(result: { ok: boolean; textLength: number }): void
  completionFilePaths?: string[]
  completionMcpResources?: string[]
  completionAgents?: string[]
  completionQueuedCommands?: string[]
  completionPromptSuggestions?: string[]
  completionSlackChannels?: string[]
  completionIdeMentions?: string[]
  completionImageAttachments?: string[]
  completionVoiceActions?: string[]
  voiceIndicator?: string
  onVoiceShortcut?(): void
  editableQueuedCommandCount?: number
  onEditQueuedCommands?(): boolean
  vimMode?: boolean
  disabled?: boolean
}) {
  const [completionIndex, setCompletionIndex] = useState(0)
  const [selectionAnchor, setSelectionAnchor] = useState<number | undefined>()
  const [historySearchQuery, setHistorySearchQuery] = useState<string>()
  const [historySearchStartIndex, setHistorySearchStartIndex] = useState<
    number | undefined
  >()
  const [vimInputMode, setVimInputMode] = useState<PromptVimMode>('insert')
  const [vimPendingOperator, setVimPendingOperator] =
    useState<PromptVimPendingOperator>()
  const selection =
    selectionAnchor === undefined
      ? undefined
      : { anchor: selectionAnchor, focus: props.cursor }
  const selectionText = selectedPromptText(props.value, selection)

  useInput((input, key) => {
    const menu = buildPromptCompletionMenu(props, completionIndex)
    const mouse = parseSgrMouseEvent(input)
    const deletionDirection = promptDeletionDirection(input, key)
    const backspace = deletionDirection === 'backward'
    const forwardDelete = deletionDirection === 'forward'
    const historySearchResult =
      historySearchQuery === undefined
        ? undefined
        : searchPromptHistory(
            props.history,
            historySearchQuery,
            historySearchStartIndex ?? props.history.length - 1,
            { wrap: true },
          )

    if (historySearchQuery !== undefined) {
      if (key.escape || (key.ctrl && input === 'c')) {
        setHistorySearchQuery(undefined)
        setHistorySearchStartIndex(undefined)
        return
      }

      if (key.return || key.tab) {
        if (historySearchResult) {
          props.onHistoryIndexChange(historySearchResult.index)
          props.onChange(historySearchResult.value, historySearchResult.value.length)
        }
        setHistorySearchQuery(undefined)
        setHistorySearchStartIndex(undefined)
        return
      }

      if (key.ctrl && input === 'r') {
        const nextStart = historySearchResult
          ? historySearchResult.index - 1
          : props.history.length - 1
        setHistorySearchStartIndex(
          nextStart < 0 ? props.history.length - 1 : nextStart,
        )
        return
      }

      if (backspace || forwardDelete) {
        setHistorySearchQuery(current => current?.slice(0, -1) ?? '')
        setHistorySearchStartIndex(undefined)
        return
      }

      if (input && !key.ctrl && !key.meta) {
        const sanitizedInput = sanitizeTerminalControlInput(input)
        if (!sanitizedInput || isTerminalControlInput(input)) {
          return
        }
        setHistorySearchQuery(current => `${current ?? ''}${sanitizedInput}`)
        setHistorySearchStartIndex(undefined)
        return
      }

      return
    }

    if (mouse) {
      if (mouse.type === 'wheelUp' || mouse.type === 'wheelDown') {
        return
      }
      if (
        props.screenSelectionStartRow !== undefined &&
        mouse.row - 1 < props.screenSelectionStartRow
      ) {
        return
      }
      const nextCursor = promptCursorFromMouseColumn(props.value, mouse.column)
      if (mouse.type === 'press') {
        setSelectionAnchor(nextCursor)
      } else if (mouse.type === 'drag') {
        setSelectionAnchor(current => current ?? props.cursor)
      } else if (mouse.type === 'release' && nextCursor === selectionAnchor) {
        setSelectionAnchor(undefined)
      }
      props.onChange(props.value, nextCursor)
      return
    }

    if (key.escape) {
      if (selectionText) {
        setSelectionAnchor(undefined)
        return
      }

      if (props.vimMode && vimInputMode === 'insert') {
        const result = applyPromptVimKey({
          buffer: {
            value: props.value,
            cursor: props.cursor,
          },
          mode: vimInputMode,
          pendingOperator: vimPendingOperator,
          keyName: 'escape',
        })
        setVimInputMode(result.mode)
        setVimPendingOperator(result.pendingOperator)
        props.onChange(result.buffer.value, result.buffer.cursor)
        return
      }

      if (
        (props.editableQueuedCommandCount ?? 0) > 0 &&
        props.onEditQueuedCommands?.()
      ) {
        return
      }

      props.onPermissionDismiss()
      return
    }

    if (key.ctrl && (input === ' ' || input === '@')) {
      props.onVoiceShortcut?.()
      return
    }

    if (
      props.vimMode &&
      vimInputMode === 'normal' &&
      !key.ctrl &&
      !key.meta &&
      !key.super
    ) {
      const result = applyPromptVimKey({
        buffer: {
          value: props.value,
          cursor: props.cursor,
        },
        mode: vimInputMode,
        pendingOperator: vimPendingOperator,
        keyName: getKeyName(input, key),
        input,
      })
      if (result.handled) {
        setSelectionAnchor(undefined)
        setVimInputMode(result.mode)
        setVimPendingOperator(result.pendingOperator)
        props.onChange(result.buffer.value, result.buffer.cursor)
        if (result.submit) {
          props.onSubmit(result.buffer.value)
        }
        return
      }
    }

    if (key.ctrl && input === 'c') {
      if (selectionText) {
        void copyTextToSystemClipboard(selectionText).then(ok => {
          props.onClipboardResult?.({
            ok,
            textLength: selectionText.length,
          })
        })
        setSelectionAnchor(undefined)
        return
      }

      if (props.screenSelectionText) {
        const text = props.screenSelectionText
        void copyTextToSystemClipboard(text).then(ok => {
          props.onScreenSelectionCopy?.({
            ok,
            textLength: text.length,
          })
        })
        return
      }

      props.onAbort()
      return
    }

    if (key.ctrl && input === 'd') {
      props.onExit()
      return
    }

    if (key.ctrl && input === 'r') {
      setHistorySearchQuery('')
      setHistorySearchStartIndex(undefined)
      setSelectionAnchor(undefined)
      return
    }

    if (key.ctrl && input === 'a') {
      moveCursor('lineStart', key.shift)
      return
    }

    if (key.ctrl && input === 'e') {
      moveCursor('lineEnd', key.shift)
      return
    }

    if (key.ctrl && input === 'b') {
      moveCursor('left', key.shift)
      return
    }

    if (key.ctrl && input === 'f') {
      moveCursor('right', key.shift)
      return
    }

    if (key.meta && input === 'b') {
      moveCursor('wordLeft', key.shift)
      return
    }

    if (key.meta && input === 'f') {
      moveCursor('wordRight', key.shift)
      return
    }

    if (key.ctrl && input === 'w') {
      const next = selectionText
        ? deletePromptSelection(
            {
              value: props.value,
              cursor: props.cursor,
            },
            selection,
          )
        : deletePromptWordBackward({
            value: props.value,
            cursor: props.cursor,
          })
      setSelectionAnchor(undefined)
      props.onChange(next.value, next.cursor)
      return
    }

    if (key.ctrl && input === 'u') {
      const next = selectionText
        ? deletePromptSelection(
            {
              value: props.value,
              cursor: props.cursor,
            },
            selection,
          )
        : deletePromptLineBackward({
            value: props.value,
            cursor: props.cursor,
          })
      setSelectionAnchor(undefined)
      props.onChange(next.value, next.cursor)
      return
    }

    if (key.ctrl && input === 'k') {
      const next = selectionText
        ? deletePromptSelection(
            {
              value: props.value,
              cursor: props.cursor,
            },
            selection,
          )
        : deletePromptLineForward({
            value: props.value,
            cursor: props.cursor,
          })
      setSelectionAnchor(undefined)
      props.onChange(next.value, next.cursor)
      return
    }

    if (key.tab) {
      const selected = selectedPromptCompletion(menu)
      const completed = selected
        ? applyPromptCompletion(
            {
              value: props.value,
              cursor: props.cursor,
            },
            selected,
          )
        : completeSlashCommandBuffer({
            value: props.value,
            cursor: props.cursor,
          })
      setCompletionIndex(0)
      setSelectionAnchor(undefined)
      props.onChange(completed.value, completed.cursor)
      return
    }

    if (key.return && key.shift) {
      const next = selectionText
        ? replacePromptSelection(
            {
              value: props.value,
              cursor: props.cursor,
            },
            selection,
            '\n',
          )
        : insertPromptNewlineBuffer({
            value: props.value,
            cursor: props.cursor,
          })
      setSelectionAnchor(undefined)
      props.onChange(next.value, next.cursor)
      return
    }

    if (key.return) {
      props.onSubmit(props.value)
      return
    }

    if (backspace || forwardDelete) {
      const next = selectionText
        ? deletePromptSelection(
            {
              value: props.value,
              cursor: props.cursor,
            },
            selection,
          )
        : backspace
          ? deletePromptInputBackward({
              value: props.value,
              cursor: props.cursor,
            })
          : deletePromptInputForward({
              value: props.value,
              cursor: props.cursor,
            })
      setSelectionAnchor(undefined)
      props.onChange(next.value, next.cursor)
      return
    }

    if (key.leftArrow || key.rightArrow || key.home || key.end) {
      moveCursor(
        key.leftArrow
          ? 'left'
          : key.rightArrow
            ? 'right'
            : key.home
              ? 'lineStart'
              : 'lineEnd',
        key.shift,
      )
      return
    }

    if (key.upArrow || (key.ctrl && input === 'p')) {
      if (menu.candidates.length > 1) {
        setCompletionIndex(
          movePromptCompletionSelection(menu, 'previous').selectedIndex,
        )
        return
      }

      if (
        (props.editableQueuedCommandCount ?? 0) > 0 &&
        props.onEditQueuedCommands?.()
      ) {
        return
      }

      const nextIndex =
        props.historyIndex === undefined
          ? props.history.length - 1
          : Math.max(0, props.historyIndex - 1)
      if (nextIndex >= 0) {
        setSelectionAnchor(undefined)
        props.onHistoryIndexChange(nextIndex)
        const historyValue = props.history[nextIndex] ?? ''
        props.onChange(historyValue, historyValue.length)
      }
      return
    }

    if (key.downArrow || (key.ctrl && input === 'n')) {
      if (menu.candidates.length > 1) {
        setCompletionIndex(
          movePromptCompletionSelection(menu, 'next').selectedIndex,
        )
        return
      }

      if (props.historyIndex === undefined) {
        return
      }

      const nextIndex = props.historyIndex + 1
      if (nextIndex >= props.history.length) {
        setSelectionAnchor(undefined)
        props.onHistoryIndexChange(undefined)
        props.onChange('', 0)
        return
      }

      setSelectionAnchor(undefined)
      props.onHistoryIndexChange(nextIndex)
      const historyValue = props.history[nextIndex] ?? ''
      props.onChange(historyValue, historyValue.length)
      return
    }

    if (input && !key.ctrl && !key.meta) {
      const sanitizedInput = sanitizeTerminalControlInput(input)
      if (!sanitizedInput || isTerminalControlInput(input)) {
        return
      }
      props.onHistoryIndexChange(undefined)
      setCompletionIndex(0)
      setSelectionAnchor(undefined)
      setVimPendingOperator(undefined)
      const next = selectionText
        ? replacePromptSelection(
            {
              value: props.value,
              cursor: props.cursor,
            },
            selection,
            sanitizedInput,
          )
        : insertPromptInput(
            {
              value: props.value,
              cursor: props.cursor,
            },
            sanitizedInput,
          )
      props.onChange(next.value, next.cursor)
    }
  }, { isActive: !props.disabled })

  const moveCursor = (
    direction: Parameters<typeof movePromptCursor>[1],
    extendSelection = false,
  ) => {
    const next = movePromptCursor(
      {
        value: props.value,
        cursor: props.cursor,
      },
      direction,
    )
    if (extendSelection) {
      setSelectionAnchor(current => current ?? props.cursor)
    } else {
      setSelectionAnchor(undefined)
    }
    props.onChange(next.value, next.cursor)
  }

  const rendered = renderPromptWithCursor({
    value: props.value,
    cursor: props.cursor,
  })
  const selected = renderPromptWithSelection(
    {
      value: props.value,
      cursor: props.cursor,
    },
    selection,
  )
  const hasSelection = Boolean(promptSelectionRange(props.value, selection))
  const menu = buildPromptCompletionMenu(props, completionIndex)
  const historySearchResult =
    historySearchQuery === undefined
      ? undefined
      : searchPromptHistory(
          props.history,
          historySearchQuery,
          historySearchStartIndex ?? props.history.length - 1,
          { wrap: true },
        )
  const vimFooter = props.vimMode
    ? `  vim:${vimInputMode}${vimPendingOperator ? `(${vimPendingOperator})` : ''}`
    : ''
  const queueFooter = props.editableQueuedCommandCount
    ? `  queued:${props.editableQueuedCommandCount}`
    : ''
  const completionFooter = promptCompletionSourceFooter(completionOptionsFromProps(props))
  const footer = historySearchQuery !== undefined
    ? `history search: ${historySearchQuery || '(type to search)'}${
        historySearchResult ? `  -> ${historySearchResult.value}` : '  no match'
      }  Ctrl+R next`
    : menu.candidates.length
    ? 'Tab accept  Up/Down/Ctrl+P/N choose  Esc dismiss'
    : props.screenSelectionText
      ? 'Ctrl+C copy selection  Esc clear selection'
      : `Enter submit  Shift+Enter newline  Ctrl+R history  Ctrl+A/E/B/F move  Ctrl+U/K/W edit  Ctrl+D exit${vimFooter}${queueFooter}${completionFooter}${props.voiceIndicator ? `  ${props.voiceIndicator}` : ''}`
  const separator = '─'.repeat(Math.max(1, Math.min(props.columns ?? 80, 160)))

  return (
    <Box flexDirection="column">
      {props.value.includes('\n') ? (
        <Text dimColor>multiline</Text>
      ) : null}
      <Text dimColor>{separator}</Text>
      <Box>
        <Text color={props.isRunning ? 'yellow' : 'cyan'}>
          {props.isRunning ? '… ' : '> '}
        </Text>
        {props.screenSelection && props.screenSelectionStartRow !== undefined ? (
          <ScreenSelectedPrompt
            value={props.value}
            prefix={props.isRunning ? '… ' : '> '}
            startRow={props.screenSelectionStartRow}
            selection={props.screenSelection}
            rows={props.screenSelectionRows}
          />
        ) : hasSelection ? (
          <>
            <Text>{selected.before}</Text>
            <Text inverse>{selected.selected}</Text>
            <Text>{selected.after}</Text>
          </>
        ) : (
          <>
            <Text>{rendered.before}</Text>
            <Text inverse>{rendered.cursor}</Text>
            <Text>{rendered.after}</Text>
          </>
        )}
      </Box>
      <Text dimColor>{separator}</Text>
      {menu.candidates.length > 1 ? (
        <Box flexDirection="column">
          {menu.candidates.map((candidate, index) => (
            <Text
              key={candidate}
              color={index === menu.selectedIndex ? 'cyan' : undefined}
            >
              {index === menu.selectedIndex ? '› ' : '  '}
              {candidate}
              {menu.details[index]?.description
                ? `  ${menu.details[index]?.description}`
                : ''}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text color="yellow">[CAVEMAN]</Text>
      <Text dimColor>{footer}</Text>
    </Box>
  )
}

function buildPromptCompletionMenu(
  props: {
    value: string
    completionFilePaths?: string[]
    completionMcpResources?: string[]
    completionAgents?: string[]
    completionQueuedCommands?: string[]
    completionPromptSuggestions?: string[]
    completionSlackChannels?: string[]
    completionIdeMentions?: string[]
    completionImageAttachments?: string[]
    completionVoiceActions?: string[]
  },
  completionIndex: number,
) {
  return promptCompletionMenu(props.value, completionIndex, 6, completionOptionsFromProps(props))
}

function completionOptionsFromProps(props: {
  completionFilePaths?: string[]
  completionMcpResources?: string[]
  completionAgents?: string[]
  completionQueuedCommands?: string[]
  completionPromptSuggestions?: string[]
  completionSlackChannels?: string[]
  completionIdeMentions?: string[]
  completionImageAttachments?: string[]
  completionVoiceActions?: string[]
}) {
  return {
    filePaths: props.completionFilePaths,
    mcpResources: props.completionMcpResources,
    agents: props.completionAgents,
    queuedCommands: props.completionQueuedCommands,
    promptSuggestions: props.completionPromptSuggestions,
    slackChannels: props.completionSlackChannels,
    ideMentions: props.completionIdeMentions,
    imageAttachments: props.completionImageAttachments,
    voiceActions: props.completionVoiceActions,
  }
}

function ScreenSelectedPrompt(props: {
  value: string
  prefix: string
  startRow: number
  selection: ScreenSelection
  rows?: ScreenSelectableRow[]
}) {
  const lines = props.value.split('\n')
  const renderedLines = []
  let rowIndex = props.startRow
  for (const line of lines) {
    const isFirstLine = rowIndex === props.startRow
    const prefix = isFirstLine ? '' : ' '.repeat(props.prefix.length)
    const fullRow = `${isFirstLine ? props.prefix : ' '.repeat(props.prefix.length)}${line}`
    const text = `${prefix}${line}`
    const slice = selectionSliceForRow(
      rowIndex,
      props.rows?.[rowIndex] ?? fullRow,
      props.selection,
    )
    if (!slice) {
      renderedLines.push(<Text key={`prompt:${rowIndex}`}>{text}</Text>)
      rowIndex++
      continue
    }

    const lineOffset = isFirstLine ? props.prefix.length : 0
    renderedLines.push(
      <Text key={`prompt:${rowIndex}`}>
        <Text>{slice.before.slice(lineOffset)}</Text>
        <Text inverse>{slice.selected}</Text>
        <Text>{slice.after}</Text>
      </Text>,
    )
    rowIndex++
  }

  return (
    <>
      {renderedLines}
    </>
  )
}
