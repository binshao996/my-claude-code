import type { TuiMessage } from './tuiTypes.js'

export function messageRowsForDisplay(
  message: TuiMessage,
  columns?: number,
): string[] {
  const prefix = messageRolePrefix(message.role)
  const blocks = markdownBlocksToDisplayLines(message.text)
  const rows: string[] = []
  let firstRow = true

  for (const block of blocks) {
    const linePrefix = firstRow ? prefix : ' '.repeat(prefix.length)
    rows.push(...wrapDisplayLine({
      prefix: linePrefix,
      text: block,
      columns,
    }))
    firstRow = false
  }

  return rows.length > 0 ? rows : [prefix]
}

export function messageRolePrefix(role: TuiMessage['role']): string {
  switch (role) {
    case 'user':
      return '› '
    case 'assistant':
      return '● '
    case 'tool':
      return '✻ '
    case 'error':
      return 'Error: '
    case 'system':
      return ''
  }
}

export function markdownToDisplayText(value: string): string {
  return stripInlineMarkdown(value)
}

function markdownBlocksToDisplayLines(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)
  const output: string[] = []
  let index = 0

  while (index < lines.length) {
    const table = readMarkdownTable(lines, index)
    if (table) {
      output.push(...renderMarkdownTable(table.rows))
      index = table.nextIndex
      continue
    }

    const line = markdownLineToDisplay(lines[index] ?? '')
    output.push(line)
    index += 1
  }

  return trimOuterBlankLines(output)
}

function markdownLineToDisplay(line: string): string {
  const heading = /^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)
  if (heading) {
    return `${heading[1] ?? ''}${stripInlineMarkdown(heading[2] ?? '')}`
  }

  const unordered = /^(\s*)[-*+]\s+(.+)$/u.exec(line)
  if (unordered) {
    return `${unordered[1] ?? ''}• ${stripInlineMarkdown(unordered[2] ?? '')}`
  }

  const ordered = /^(\s*\d+\.)\s+(.+)$/u.exec(line)
  if (ordered) {
    return `${ordered[1] ?? ''} ${stripInlineMarkdown(ordered[2] ?? '')}`
  }

  return stripInlineMarkdown(line)
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\s][^*]*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

function readMarkdownTable(
  lines: string[],
  startIndex: number,
): { rows: string[][]; nextIndex: number } | undefined {
  if (!looksLikeTableLine(lines[startIndex] ?? '')) {
    return undefined
  }

  const block: string[] = []
  let index = startIndex
  while (index < lines.length && looksLikeTableLine(lines[index] ?? '')) {
    block.push(lines[index] ?? '')
    index += 1
  }

  if (!block.some(isMarkdownTableSeparator)) {
    return undefined
  }

  const rows = block
    .filter(line => !isMarkdownTableSeparator(line))
    .map(parseMarkdownTableRow)
    .filter(row => row.some(cell => cell.length > 0))

  return {
    rows,
    nextIndex: index,
  }
}

function looksLikeTableLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.includes('|') && trimmed.split('|').length >= 3
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line)
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/u.test(cell) || cell === '')
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim()
  const body = trimmed.startsWith('|') && trimmed.endsWith('|')
    ? trimmed.slice(1, -1)
    : trimmed
  return body
    .split('|')
    .map(cell => stripInlineMarkdown(cell.trim()))
}

function renderMarkdownTable(rows: string[][]): string[] {
  if (rows.length === 0) {
    return []
  }

  const columnCount = Math.max(...rows.map(row => row.length))
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.min(
      32,
      Math.max(
        1,
        ...rows.map(row => terminalDisplayWidth(row[columnIndex] ?? '')),
      ),
    )
  )

  return rows.map(row =>
    row.map((cell, columnIndex) =>
      padDisplayEnd(cell, widths[columnIndex] ?? 1)
    ).join('  ').trimEnd()
  )
}

function trimOuterBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') {
    start += 1
  }
  while (end > start && lines[end - 1]?.trim() === '') {
    end -= 1
  }
  return lines.slice(start, end)
}

function wrapDisplayLine(args: {
  prefix: string
  text: string
  columns?: number
}): string[] {
  if (!Number.isFinite(args.columns) || args.columns === undefined || args.columns < 1) {
    return [`${args.prefix}${args.text}`]
  }

  const rows: string[] = []
  const continuationPrefix = ' '.repeat(
    args.prefix.length + markdownContinuationIndent(args.text),
  )
  let remaining = args.text
  let prefix = args.prefix

  do {
    const width = Math.max(1, Math.floor(args.columns) - terminalDisplayWidth(prefix))
    const chunk = takeDisplayChunk(remaining, width)
    rows.push(`${prefix}${chunk.text.replace(/\s+$/u, '')}`)
    remaining = remaining.slice(chunk.length).replace(/^\s+/u, '')
    prefix = continuationPrefix
  } while (remaining.length > 0)

  return rows
}

function markdownContinuationIndent(value: string): number {
  return value.match(/^(\s*(?:[-*+]\s+|•\s+|\d+\.\s+))/u)?.[1].length ?? 0
}

function takeDisplayChunk(value: string, maxWidth: number): {
  text: string
  length: number
} {
  let width = 0
  let text = ''
  let length = 0
  let lastBreak: { textLength: number; stringLength: number } | undefined

  for (const character of value) {
    const characterWidth = terminalDisplayWidth(character)
    if (text && width + characterWidth > maxWidth) {
      break
    }
    text += character
    width += characterWidth
    length += character.length
    if (/\s/u.test(character)) {
      lastBreak = {
        textLength: text.length,
        stringLength: length,
      }
    }
  }

  if (
    length < value.length &&
    lastBreak &&
    lastBreak.stringLength > 0 &&
    lastBreak.stringLength < length
  ) {
    return {
      text: text.slice(0, lastBreak.textLength),
      length: Math.max(1, lastBreak.stringLength),
    }
  }

  return {
    text,
    length: Math.max(1, length),
  }
}

export function terminalDisplayWidth(value: string): number {
  let width = 0
  for (const character of value) {
    width += isWideCharacter(character) ? 2 : 1
  }
  return width
}

function padDisplayEnd(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - terminalDisplayWidth(value)))}`
}

function isWideCharacter(character: string): boolean {
  return /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character)
}
