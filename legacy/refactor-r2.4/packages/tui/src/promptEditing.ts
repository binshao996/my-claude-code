import {
  LOCAL_SLASH_COMMAND_NAMES,
  SLASH_COMMAND_ARGUMENT_DESCRIPTIONS,
  SLASH_COMMAND_DESCRIPTIONS,
  SLASH_COMMAND_NAMES,
} from '@my-claude-code/commands'

export type PromptBuffer = {
  value: string
  cursor: number
}

export type PromptSelection = {
  anchor: number
  focus: number
}

export type PromptSelectionRange = {
  start: number
  end: number
}

export type PromptCompletionMenu = {
  candidates: string[]
  selectedIndex: number
  details: PromptCompletionDetail[]
}

export type PromptCompletionDetail = {
  value: string
  description: string
  source?:
    | 'slash-command'
    | 'slash-argument'
    | 'file'
    | 'mcp-resource'
    | 'agent'
    | 'queued-command'
    | 'prompt-suggestion'
    | 'slack-channel'
    | 'ide-mention'
    | 'image-attachment'
    | 'voice-action'
  replacement?: string
  replaceStart?: number
  replaceEnd?: number
}

export type PromptCompletionOptions = {
  filePaths?: string[]
  mcpResources?: string[]
  agents?: string[]
  queuedCommands?: string[]
  promptSuggestions?: string[]
  slackChannels?: string[]
  ideMentions?: string[]
  imageAttachments?: string[]
  voiceActions?: string[]
}

export type PromptCompletionPayload = {
  value: string
  label: string
  description: string
  source: NonNullable<PromptCompletionDetail['source']>
  replacement: string
  replaceStart: number
  replaceEnd: number
}

export type PromptMouseEvent = {
  type: 'press' | 'drag' | 'release' | 'wheelUp' | 'wheelDown'
  column: number
  row: number
}

export type PromptVimMode = 'insert' | 'normal'

export type PromptVimPendingOperator = 'd'

export type PromptVimResult = {
  buffer: PromptBuffer
  mode: PromptVimMode
  pendingOperator?: PromptVimPendingOperator
  handled: boolean
  submit?: boolean
}

export type PromptDeletionDirection = 'backward' | 'forward'

export function normalizePromptInput(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function appendPromptInput(value: string, input: string): string {
  return `${value}${normalizePromptInput(input)}`
}

export function insertPromptInput(
  buffer: PromptBuffer,
  input: string,
): PromptBuffer {
  const normalized = normalizePromptInput(input)
  let next = {
    value: buffer.value,
    cursor: clampCursor(buffer.value, buffer.cursor),
  }

  for (const character of normalized) {
    if (isBackspaceInput(character)) {
      next = deletePromptInputBackward(next)
      continue
    }

    const cursor = clampCursor(next.value, next.cursor)
    next = {
      value: `${next.value.slice(0, cursor)}${character}${next.value.slice(cursor)}`,
      cursor: cursor + character.length,
    }
  }

  return next
}

export function deletePromptInputBackward(buffer: PromptBuffer): PromptBuffer {
  const cursor = clampCursor(buffer.value, buffer.cursor)
  if (cursor === 0) {
    return {
      value: buffer.value,
      cursor,
    }
  }

  return {
    value: `${buffer.value.slice(0, cursor - 1)}${buffer.value.slice(cursor)}`,
    cursor: cursor - 1,
  }
}

export function deletePromptInputForward(buffer: PromptBuffer): PromptBuffer {
  const cursor = clampCursor(buffer.value, buffer.cursor)
  if (cursor >= buffer.value.length) {
    return {
      value: buffer.value,
      cursor,
    }
  }

  return {
    value: `${buffer.value.slice(0, cursor)}${buffer.value.slice(cursor + 1)}`,
    cursor,
  }
}

export function deletePromptWordBackward(buffer: PromptBuffer): PromptBuffer {
  const cursor = clampCursor(buffer.value, buffer.cursor)
  const start = previousWordBoundary(buffer.value, cursor)
  return {
    value: `${buffer.value.slice(0, start)}${buffer.value.slice(cursor)}`,
    cursor: start,
  }
}

export function deletePromptLineBackward(buffer: PromptBuffer): PromptBuffer {
  const cursor = clampCursor(buffer.value, buffer.cursor)
  const start = lineStartBoundary(buffer.value, cursor)
  return {
    value: `${buffer.value.slice(0, start)}${buffer.value.slice(cursor)}`,
    cursor: start,
  }
}

export function deletePromptLineForward(buffer: PromptBuffer): PromptBuffer {
  const cursor = clampCursor(buffer.value, buffer.cursor)
  const end = lineEndBoundary(buffer.value, cursor)
  return {
    value: `${buffer.value.slice(0, cursor)}${buffer.value.slice(end)}`,
    cursor,
  }
}

export function promptSelectionRange(
  value: string,
  selection: PromptSelection | undefined,
): PromptSelectionRange | undefined {
  if (!selection) {
    return undefined
  }

  const anchor = clampCursor(value, selection.anchor)
  const focus = clampCursor(value, selection.focus)
  if (anchor === focus) {
    return undefined
  }

  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
  }
}

export function selectedPromptText(
  value: string,
  selection: PromptSelection | undefined,
): string {
  const range = promptSelectionRange(value, selection)
  return range ? value.slice(range.start, range.end) : ''
}

export function replacePromptSelection(
  buffer: PromptBuffer,
  selection: PromptSelection | undefined,
  replacement: string,
): PromptBuffer {
  const range = promptSelectionRange(buffer.value, selection)
  if (!range) {
    return insertPromptInput(buffer, replacement)
  }

  const normalized = normalizePromptInput(replacement)
  return {
    value: `${buffer.value.slice(0, range.start)}${normalized}${buffer.value.slice(range.end)}`,
    cursor: range.start + normalized.length,
  }
}

export function deletePromptSelection(
  buffer: PromptBuffer,
  selection: PromptSelection | undefined,
): PromptBuffer {
  return replacePromptSelection(buffer, selection, '')
}

export function movePromptCursor(
  buffer: PromptBuffer,
  direction:
    | 'left'
    | 'right'
    | 'home'
    | 'end'
    | 'lineStart'
    | 'lineEnd'
    | 'wordLeft'
    | 'wordRight',
): PromptBuffer {
  const cursor = clampCursor(buffer.value, buffer.cursor)
  switch (direction) {
    case 'left':
      return { value: buffer.value, cursor: Math.max(0, cursor - 1) }
    case 'right':
      return {
        value: buffer.value,
        cursor: Math.min(buffer.value.length, cursor + 1),
      }
    case 'home':
      return { value: buffer.value, cursor: 0 }
    case 'end':
      return { value: buffer.value, cursor: buffer.value.length }
    case 'lineStart':
      return {
        value: buffer.value,
        cursor: lineStartBoundary(buffer.value, cursor),
      }
    case 'lineEnd':
      return {
        value: buffer.value,
        cursor: lineEndBoundary(buffer.value, cursor),
      }
    case 'wordLeft':
      return {
        value: buffer.value,
        cursor: previousWordBoundary(buffer.value, cursor),
      }
    case 'wordRight':
      return {
        value: buffer.value,
        cursor: nextWordBoundary(buffer.value, cursor),
      }
  }
}

export function completeSlashCommand(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) {
    return value
  }

  const matches = slashCommandCandidates(trimmed)
  return matches.length === 1 ? matches[0] : value
}

export function slashCommandCandidates(value: string, limit = 6): string[] {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) {
    return []
  }

  const localMatches = LOCAL_SLASH_COMMAND_NAMES.filter(command => command.startsWith(trimmed))
  if (localMatches.length > 0) {
    return localMatches.slice(0, limit)
  }
  return SLASH_COMMAND_NAMES.filter(command => command.startsWith(trimmed)).slice(0, limit)
}

export function promptCompletionMenu(
  value: string,
  selectedIndex = 0,
  limit = 6,
  options: PromptCompletionOptions = {},
): PromptCompletionMenu {
  const details = promptCompletionDetails(value, limit, options)
  const candidates = details.map(detail => detail.value)
  return {
    candidates,
    details,
    selectedIndex:
      candidates.length === 0
        ? 0
        : Math.max(0, Math.min(candidates.length - 1, selectedIndex)),
  }
}

export function promptCompletionDetails(
  value: string,
  limit = 6,
  options: PromptCompletionOptions = {},
): PromptCompletionDetail[] {
  const slashArgumentDetails = slashCommandArgumentDetails(value, limit)
  if (slashArgumentDetails.length > 0) {
    return slashArgumentDetails
  }

  const slashDetails = slashCommandDetails(value, limit)
  if (slashDetails.length > 0) {
    return slashDetails
  }

  const token = currentCompletionToken(value)
  if (!token) {
    return promptSuggestionDetails(value, options.promptSuggestions ?? [], limit)
  }

  if (token.text.startsWith('@mcp:')) {
    return tokenReplacementDetails({
      token,
      prefix: '@mcp:',
      values: options.mcpResources ?? [],
      description: 'MCP resource',
      source: 'mcp-resource',
      limit,
    })
  }

  if (token.text.startsWith('@agent:')) {
    return tokenReplacementDetails({
      token,
      prefix: '@agent:',
      values: options.agents ?? [],
      description: 'Agent',
      source: 'agent',
      limit,
    })
  }

  if (token.text.startsWith('@ide:')) {
    return tokenReplacementDetails({
      token,
      prefix: '@ide:',
      values: options.ideMentions ?? [],
      description: 'IDE context',
      source: 'ide-mention',
      limit,
    })
  }

  if (token.text.startsWith('@image:')) {
    return tokenReplacementDetails({
      token,
      prefix: '@image:',
      values: options.imageAttachments ?? [],
      description: 'Image attachment',
      source: 'image-attachment',
      limit,
    })
  }

  if (token.text.startsWith('@voice:')) {
    return tokenReplacementDetails({
      token,
      prefix: '@voice:',
      values: options.voiceActions ?? [],
      description: 'Voice action',
      source: 'voice-action',
      limit,
    })
  }

  if (token.text.startsWith('@')) {
    return tokenReplacementDetails({
      token,
      prefix: '@',
      values: options.filePaths ?? [],
      description: 'Project file',
      source: 'file',
      limit,
    })
  }

  if (token.text.startsWith('#')) {
    return tokenReplacementDetails({
      token,
      prefix: '#',
      values: options.slackChannels ?? [],
      description: 'Slack channel',
      source: 'slack-channel',
      limit,
    })
  }

  if (token.text.startsWith('!')) {
    return tokenReplacementDetails({
      token,
      prefix: '!',
      values: options.queuedCommands ?? [],
      description: 'Queued command',
      source: 'queued-command',
      limit,
    })
  }

  return promptSuggestionDetails(value, options.promptSuggestions ?? [], limit)
}

export function movePromptCompletionSelection(
  menu: PromptCompletionMenu,
  direction: 'previous' | 'next',
): PromptCompletionMenu {
  if (menu.candidates.length === 0) {
    return menu
  }

  const delta = direction === 'next' ? 1 : -1
  return {
    ...menu,
    selectedIndex:
      (menu.selectedIndex + delta + menu.candidates.length) %
      menu.candidates.length,
  }
}

export function selectedPromptCompletion(
  menu: PromptCompletionMenu,
): PromptCompletionDetail | undefined {
  return menu.details[menu.selectedIndex]
}

export function promptCompletionPayload(
  detail: PromptCompletionDetail,
  bufferValue: string,
): PromptCompletionPayload | undefined {
  if (!detail.source) {
    return undefined
  }

  const replacement = detail.replacement ?? detail.value
  return {
    value: detail.value,
    label: detail.value,
    description: detail.description,
    source: detail.source,
    replacement,
    replaceStart: clampCursor(bufferValue, detail.replaceStart ?? 0),
    replaceEnd: clampCursor(bufferValue, detail.replaceEnd ?? bufferValue.length),
  }
}

export function promptCompletionPayloads(
  value: string,
  limit = 6,
  options: PromptCompletionOptions = {},
): PromptCompletionPayload[] {
  return promptCompletionDetails(value, limit, options).flatMap(detail => {
    const payload = promptCompletionPayload(detail, value)
    return payload ? [payload] : []
  })
}

export function promptCompletionSourceFooter(
  options: PromptCompletionOptions = {},
): string {
  const sources = [
    options.filePaths?.length ? '@file' : undefined,
    options.mcpResources?.length ? '@mcp' : undefined,
    options.agents?.length ? '@agent' : undefined,
    options.queuedCommands?.length ? '!queue' : undefined,
    options.slackChannels?.length ? '#slack' : undefined,
    options.ideMentions?.length ? '@ide' : undefined,
    options.imageAttachments?.length ? '@image' : undefined,
    options.voiceActions?.length ? '@voice' : undefined,
  ].filter((source): source is string => Boolean(source))

  return sources.length ? `  completions:${sources.join(',')}` : ''
}

export function searchPromptHistory(
  history: string[],
  query: string,
  startIndex = history.length - 1,
  options: {
    wrap?: boolean
  } = {},
): {
  index: number
  value: string
} | undefined {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return undefined
  }

  const boundedStart = Math.min(history.length - 1, Math.max(0, startIndex))
  const ranges: Array<[number, number]> = [[boundedStart, 0]]
  if (options.wrap && boundedStart < history.length - 1) {
    ranges.push([history.length - 1, boundedStart + 1])
  }

  for (const [from, to] of ranges) {
    const result = searchPromptHistoryRange(history, normalizedQuery, from, to)
    if (result) {
      return result
    }
  }

  return undefined
}

export function applyPromptVimKey(args: {
  buffer: PromptBuffer
  mode: PromptVimMode
  pendingOperator?: PromptVimPendingOperator
  keyName: string | null
  input?: string
}): PromptVimResult {
  if (args.mode === 'insert') {
    if (args.keyName !== 'escape') {
      return {
        buffer: args.buffer,
        mode: args.mode,
        pendingOperator: args.pendingOperator,
        handled: false,
      }
    }

    return {
      buffer: vimNormalBuffer(args.buffer),
      mode: 'normal',
      handled: true,
    }
  }

  const keyName = args.keyName
  const input = args.input?.toLowerCase()
  const motion = keyName ?? input ?? ''

  if (args.pendingOperator === 'd') {
    if (motion === 'd') {
      return {
        buffer: deletePromptCurrentLine(args.buffer),
        mode: 'normal',
        handled: true,
      }
    }

    return {
      buffer: args.buffer,
      mode: 'normal',
      handled: true,
    }
  }

  switch (motion) {
    case 'escape':
      return {
        buffer: vimNormalBuffer(args.buffer),
        mode: 'normal',
        handled: true,
      }
    case 'i':
      return {
        buffer: args.buffer,
        mode: 'insert',
        handled: true,
      }
    case 'a':
      return {
        buffer: movePromptCursor(args.buffer, 'right'),
        mode: 'insert',
        handled: true,
      }
    case 'h':
    case 'left':
      return vimMove(args.buffer, 'left')
    case 'l':
    case 'right':
      return vimMove(args.buffer, 'right')
    case 'b':
      return vimMove(args.buffer, 'wordLeft')
    case 'w':
      return vimMove(args.buffer, 'wordRight')
    case '0':
    case 'home':
      return vimMove(args.buffer, 'lineStart')
    case '$':
    case 'end':
      return vimMove(args.buffer, 'lineEnd')
    case 'x':
    case 'delete':
      return {
        buffer: deletePromptInputForward(args.buffer),
        mode: 'normal',
        handled: true,
      }
    case 'd':
      return {
        buffer: args.buffer,
        mode: 'normal',
        pendingOperator: 'd',
        handled: true,
      }
    case 'enter':
      return {
        buffer: args.buffer,
        mode: 'normal',
        handled: true,
        submit: true,
      }
    default:
      return {
        buffer: args.buffer,
        mode: 'normal',
        handled: true,
      }
  }
}

function searchPromptHistoryRange(
  history: string[],
  normalizedQuery: string,
  from: number,
  to: number,
): {
  index: number
  value: string
} | undefined {
  for (let index = from; index >= to; index--) {
    const value = history[index]
    if (value?.toLowerCase().includes(normalizedQuery)) {
      return {
        index,
        value,
      }
    }
  }

  return undefined
}

function vimMove(
  buffer: PromptBuffer,
  direction: Parameters<typeof movePromptCursor>[1],
): PromptVimResult {
  return {
    buffer: movePromptCursor(buffer, direction),
    mode: 'normal',
    handled: true,
  }
}

function vimNormalBuffer(buffer: PromptBuffer): PromptBuffer {
  if (buffer.value.length === 0) {
    return {
      value: buffer.value,
      cursor: 0,
    }
  }

  return {
    value: buffer.value,
    cursor: Math.min(clampCursor(buffer.value, buffer.cursor), buffer.value.length - 1),
  }
}

function deletePromptCurrentLine(buffer: PromptBuffer): PromptBuffer {
  const cursor = clampCursor(buffer.value, buffer.cursor)
  let start = lineStartBoundary(buffer.value, cursor)
  let end = lineEndBoundary(buffer.value, cursor)

  if (end < buffer.value.length) {
    end += 1
  } else if (start > 0) {
    start -= 1
  }

  return {
    value: `${buffer.value.slice(0, start)}${buffer.value.slice(end)}`,
    cursor: Math.min(start, Math.max(0, buffer.value.length - (end - start))),
  }
}

export function applyPromptCompletion(
  buffer: PromptBuffer,
  completion: string | PromptCompletionDetail | undefined,
): PromptBuffer {
  if (!completion) {
    return buffer
  }

  if (typeof completion !== 'string') {
    const replacement = completion.replacement ?? completion.value
    if (
      completion.replaceStart !== undefined &&
      completion.replaceEnd !== undefined
    ) {
      const start = clampCursor(buffer.value, completion.replaceStart)
      const end = clampCursor(buffer.value, completion.replaceEnd)
      return {
        value: `${buffer.value.slice(0, start)}${replacement}${buffer.value.slice(end)}`,
        cursor: start + replacement.length,
      }
    }

    return {
      value: replacement,
      cursor: replacement.length,
    }
  }

  return {
    value: completion,
    cursor: completion.length,
  }
}

export function completeSlashCommandBuffer(buffer: PromptBuffer): PromptBuffer {
  const completed = completeSlashCommand(buffer.value)
  return {
    value: completed,
    cursor: completed.length,
  }
}

export function insertPromptNewline(value: string): string {
  return `${value}\n`
}

export function insertPromptNewlineBuffer(buffer: PromptBuffer): PromptBuffer {
  return insertPromptInput(buffer, '\n')
}

export function renderPromptWithCursor(buffer: PromptBuffer): {
  before: string
  cursor: string
  after: string
} {
  const cursor = clampCursor(buffer.value, buffer.cursor)
  return {
    before: buffer.value.slice(0, cursor),
    cursor: buffer.value[cursor] ?? ' ',
    after: buffer.value.slice(cursor + 1),
  }
}

export function renderPromptWithSelection(
  buffer: PromptBuffer,
  selection: PromptSelection | undefined,
): {
  before: string
  selected: string
  after: string
} {
  const range = promptSelectionRange(buffer.value, selection)
  if (!range) {
    return {
      before: buffer.value,
      selected: '',
      after: '',
    }
  }

  return {
    before: buffer.value.slice(0, range.start),
    selected: buffer.value.slice(range.start, range.end),
    after: buffer.value.slice(range.end),
  }
}

export function parseSgrMouseEvent(input: string): PromptMouseEvent | undefined {
  const escapeIndex = input.indexOf(String.fromCharCode(27))
  const sequence = escapeIndex === -1 ? input : input.slice(escapeIndex + 1)
  const match = /^\[<(\d+);(\d+);(\d+)([mM])$/u.exec(sequence)
  if (!match) {
    return undefined
  }

  const button = Number(match[1])
  const column = Number(match[2])
  const row = Number(match[3])
  const suffix = match[4]
  if (!Number.isFinite(button) || !Number.isFinite(column) || !Number.isFinite(row)) {
    return undefined
  }

  if (suffix === 'm') {
    return { type: 'release', column, row }
  }

  if ((button & 64) === 64) {
    return {
      type: (button & 1) === 1 ? 'wheelDown' : 'wheelUp',
      column,
      row,
    }
  }

  return {
    type: (button & 32) === 32 ? 'drag' : 'press',
    column,
    row,
  }
}

export function sanitizeTerminalControlInput(input: string): string {
  const escapeCharacter = String.fromCharCode(27)
  return input
    .replace(
      new RegExp(`${escapeCharacter}\\[[0-9;?<]*[ -/]*[@-~]`, 'gu'),
      '',
    )
    .replace(/\[<[0-9;]+[mM]/gu, '')
    .replace(/^\[[0-9;?]*[ -/]*[@-~]$/u, '')
}

export function isBackspaceInput(input: string): boolean {
  return input === '\x7F' || input === '\b'
}

export function isDeleteInput(input: string): boolean {
  const escapeCharacter = String.fromCharCode(27)
  return (
    new RegExp(`^${escapeCharacter}\\[3(?:;[0-9:]+)?~$`, 'u').test(input) ||
    /^\[3(?:;[0-9:]+)?~$/u.test(input)
  )
}

export function promptDeletionDirection(
  input: string,
  key: { backspace?: boolean; delete?: boolean },
): PromptDeletionDirection | undefined {
  if (key.backspace || isBackspaceInput(input)) {
    return 'backward'
  }

  if (isDeleteInput(input)) {
    return 'forward'
  }

  if (key.delete) {
    // Ink 6 reports the common terminal DEL byte (\x7F) as key.delete.
    // In an interactive prompt that should behave like Backspace.
    return 'backward'
  }

  return undefined
}

export function isTerminalControlInput(input: string): boolean {
  if (!input) {
    return false
  }

  const escapeCharacter = String.fromCharCode(27)
  return (
    (input.includes(escapeCharacter) &&
      sanitizeTerminalControlInput(input).length === 0) ||
    /^\[<[0-9;]+[mM]$/u.test(input) ||
    /^\[[0-9;?]*[ -/]*[@-~]$/u.test(input)
  )
}

export function promptCursorFromMouseColumn(
  value: string,
  column: number,
  promptStartColumn = 3,
): number {
  return clampCursor(value, Math.max(0, column - promptStartColumn))
}

function clampCursor(value: string, cursor: number): number {
  return Math.max(0, Math.min(value.length, cursor))
}

function slashCommandDetails(value: string, limit: number): PromptCompletionDetail[] {
  return slashCommandCandidates(value, limit).map(candidate => ({
    value: candidate,
    description:
      SLASH_COMMAND_DESCRIPTIONS[
        candidate as keyof typeof SLASH_COMMAND_DESCRIPTIONS
      ] ?? '',
    source: 'slash-command',
  }))
}

function slashCommandArgumentDetails(
  value: string,
  limit: number,
): PromptCompletionDetail[] {
  const match = /^(\S+)\s+(\S*)$/u.exec(value.trimStart())
  if (!match) {
    return []
  }

  const command = match[1] as (typeof SLASH_COMMAND_NAMES)[number]
  const partial = match[2] ?? ''
  const descriptions = SLASH_COMMAND_ARGUMENT_DESCRIPTIONS[command]
  if (!descriptions) {
    return []
  }

  return Object.entries(descriptions)
    .filter(([argument]) => argument.startsWith(partial))
    .slice(0, limit)
    .map(([argument, description]) => ({
      value: argument,
      description,
      source: 'slash-argument',
      replacement: `${command} ${argument}`,
    }))
}

function currentCompletionToken(value: string): {
  text: string
  start: number
  end: number
} | undefined {
  const match = /(?:^|\s)(\S*)$/u.exec(value)
  const text = match?.[1]
  if (text === undefined) {
    return undefined
  }

  const end = value.length
  return {
    text,
    start: end - text.length,
    end,
  }
}

function tokenReplacementDetails(args: {
  token: {
    text: string
    start: number
    end: number
  }
  prefix: string
  values: string[]
  description: string
  source: NonNullable<PromptCompletionDetail['source']>
  limit: number
}): PromptCompletionDetail[] {
  const partial = args.token.text.slice(args.prefix.length).toLowerCase()
  return args.values
    .filter(value => value.toLowerCase().startsWith(partial))
    .slice(0, args.limit)
    .map(value => ({
      value: `${args.prefix}${value}`,
      description: args.description,
      source: args.source,
      replacement: `${args.prefix}${value}`,
      replaceStart: args.token.start,
      replaceEnd: args.token.end,
    }))
}

function promptSuggestionDetails(
  value: string,
  suggestions: string[],
  limit: number,
): PromptCompletionDetail[] {
  const normalized = value.trimStart().toLowerCase()
  if (!normalized) {
    return []
  }

  return suggestions
    .filter(suggestion => suggestion.toLowerCase().startsWith(normalized))
    .slice(0, limit)
    .map(suggestion => ({
      value: suggestion,
      description: 'Prompt suggestion',
      source: 'prompt-suggestion',
      replacement: suggestion,
    }))
}

function lineStartBoundary(value: string, cursor: number): number {
  const lineBreak = value.lastIndexOf('\n', Math.max(0, cursor - 1))
  return lineBreak === -1 ? 0 : lineBreak + 1
}

function lineEndBoundary(value: string, cursor: number): number {
  const lineBreak = value.indexOf('\n', cursor)
  return lineBreak === -1 ? value.length : lineBreak
}

function previousWordBoundary(value: string, cursor: number): number {
  let index = clampCursor(value, cursor)
  while (index > 0 && isWhitespace(value[index - 1] ?? '')) {
    index--
  }

  while (index > 0 && !isWhitespace(value[index - 1] ?? '')) {
    index--
  }

  return index
}

function nextWordBoundary(value: string, cursor: number): number {
  let index = clampCursor(value, cursor)
  while (index < value.length && !isWhitespace(value[index] ?? '')) {
    index++
  }

  while (index < value.length && isWhitespace(value[index] ?? '')) {
    index++
  }

  return index
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value)
}
