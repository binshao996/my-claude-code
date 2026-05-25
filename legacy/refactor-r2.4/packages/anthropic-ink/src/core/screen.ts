export type ScreenStyle = unknown

export type ScreenCell = {
  char: string
  style: ScreenStyle
  noSelect: boolean
  softWrap: boolean
}

export type ScreenSize = {
  width: number
  height: number
}

export type ScreenPoint = {
  x: number
  y: number
}

export type ScreenRect = ScreenPoint & ScreenSize

export type WriteTextOptions = {
  style?: ScreenStyle
  noSelect?: boolean
  softWrap?: boolean
  wrap?: boolean
}

export type SnapshotOptions = {
  trimEnd?: boolean
}

export type BlitOptions = {
  source?: Partial<ScreenRect>
  target?: Partial<ScreenPoint>
  sourceX?: number
  sourceY?: number
  srcX?: number
  srcY?: number
  targetX?: number
  targetY?: number
  dstX?: number
  dstY?: number
  x?: number
  y?: number
  width?: number
  height?: number
}

export type SelectionRange =
  | {
      start: Partial<ScreenPoint> & { col?: number; row?: number }
      end: Partial<ScreenPoint> & { col?: number; row?: number }
    }
  | {
      startX: number
      startY: number
      endX: number
      endY: number
    }
  | ScreenRect

export type WriteTextResult = {
  x: number
  y: number
  written: number
}

export class Screen {
  width: number
  height: number
  cells: ScreenCell[]
  noSelect: Uint8Array
  softWrap: boolean[]
  private contentEnd: number[]

  constructor(size: ScreenSize)
  constructor(width: number, height: number)
  constructor(sizeOrWidth: ScreenSize | number, height?: number) {
    const size = normalizeSize(sizeOrWidth, height)
    this.width = size.width
    this.height = size.height
    this.cells = Array.from({ length: this.width * this.height }, () => emptyCell())
    this.noSelect = new Uint8Array(this.width * this.height)
    this.softWrap = Array.from({ length: this.height }, () => false)
    this.contentEnd = Array.from({ length: this.height }, () => 0)
  }

  cellAt(x: number, y: number): ScreenCell | undefined {
    const index = this.indexOf(x, y)
    return index < 0 ? undefined : this.cells[index]
  }

  writeText(x: number, y: number, text: string, options: WriteTextOptions = {}): WriteTextResult {
    if (this.width === 0 || this.height === 0) {
      return { x: normalizeInteger(x), y: normalizeInteger(y), written: 0 }
    }

    let cursorX = normalizeInteger(x)
    let cursorY = normalizeInteger(y)
    let written = 0
    const wrap = options.wrap ?? true

    if (options.softWrap && cursorY >= 0 && cursorY < this.height) {
      this.setSoftWrap(cursorY, true)
    }

    for (const char of splitText(text)) {
      if (cursorY >= this.height) break

      if (char === '\r') {
        cursorX = 0
        continue
      }

      if (char === '\n') {
        cursorX = 0
        cursorY++
        continue
      }

      if (char === '\t') {
        const spaces = 4 - positiveModulo(cursorX, 4)
        for (let index = 0; index < spaces; index++) {
          const result = this.writeText(cursorX, cursorY, ' ', {
            ...options,
            softWrap: options.softWrap || this.isSoftWrapRow(cursorY),
            wrap,
          })
          cursorX = result.x
          cursorY = result.y
          written += result.written
        }
        continue
      }

      const charWidth = cellWidth(char)
      if (charWidth === 0) continue

      if (cursorY < 0) {
        cursorX += charWidth
        continue
      }

      if (cursorX < 0) {
        cursorX += charWidth
        continue
      }

      if (cursorX + charWidth > this.width) {
        if (!wrap) break
        cursorX = 0
        cursorY++
        if (cursorY >= this.height) break
        this.setSoftWrap(cursorY, true)
      }

      this.putCell(cursorX, cursorY, {
        char,
        style: options.style,
        noSelect: Boolean(options.noSelect),
        softWrap: Boolean(options.softWrap) || this.isSoftWrapRow(cursorY),
      })
      cursorX += charWidth
      written++
    }

    return { x: cursorX, y: cursorY, written }
  }

  clearRect(rect: ScreenRect): void
  clearRect(x: number, y: number, width: number, height: number): void
  clearRect(rectOrX: ScreenRect | number, y?: number, width?: number, height?: number): void {
    const rect =
      typeof rectOrX === 'number' ? rectFromArgs(rectOrX, y, width, height) : rectFromArgs(rectOrX)
    const clipped = clipRect(rect, this.width, this.height)
    if (!clipped) return

    for (let row = clipped.y; row < clipped.y + clipped.height; row++) {
      let startX = clipped.x
      let endX = clipped.x + clipped.width

      if (startX > 0 && this.isSpacerAt(startX, row) && this.isWideAt(startX - 1, row)) {
        startX--
      }

      if (endX < this.width && endX > 0 && this.isWideAt(endX - 1, row)) {
        endX++
      }

      for (let col = startX; col < endX; col++) {
        this.setEmptyAt(col, row)
      }

      if (startX === 0 && endX >= this.width) {
        this.softWrap[row] = false
        this.contentEnd[row] = 0
      } else {
        this.recomputeContentEnd(row)
      }
    }
  }

  blit(source: Screen, options: BlitOptions = {}): void {
    const blitRect = normalizeBlit(source, this, options)
    if (!blitRect) return

    this.clearRect(blitRect.targetX, blitRect.targetY, blitRect.width, blitRect.height)

    for (let row = 0; row < blitRect.height; row++) {
      const sourceY = blitRect.sourceY + row
      const targetY = blitRect.targetY + row
      this.setSoftWrap(targetY, source.isSoftWrapRow(sourceY))

      for (let col = 0; col < blitRect.width; col++) {
        const sourceX = blitRect.sourceX + col
        const targetX = blitRect.targetX + col
        const sourceCell = source.cellAt(sourceX, sourceY)
        if (!sourceCell || sourceCell.char === '') continue

        this.putCell(targetX, targetY, {
          ...sourceCell,
          noSelect: source.isNoSelect(sourceX, sourceY),
          softWrap: sourceCell.softWrap || source.isSoftWrapRow(sourceY),
        })
      }
    }
  }

  shiftRows(top: number, bottom: number, offset: number): void {
    if (this.width === 0 || this.height === 0) return

    const start = clamp(normalizeInteger(top), 0, this.height - 1)
    const end = clamp(normalizeInteger(bottom), 0, this.height - 1)
    const shift = normalizeInteger(offset)
    if (shift === 0 || start > end) return

    const previousCells = this.cells.map(cloneCell)
    const previousNoSelect = new Uint8Array(this.noSelect)
    const previousSoftWrap = [...this.softWrap]
    const previousContentEnd = [...this.contentEnd]

    for (let row = start; row <= end; row++) {
      const sourceRow = row + shift
      if (sourceRow < start || sourceRow > end) {
        this.clearRow(row)
        continue
      }

      for (let col = 0; col < this.width; col++) {
        const targetIndex = this.indexOfUnchecked(col, row)
        const sourceIndex = this.indexOfUnchecked(col, sourceRow)
        this.cells[targetIndex] = cloneCell(previousCells[sourceIndex])
        this.noSelect[targetIndex] = previousNoSelect[sourceIndex] ?? 0
      }
      this.softWrap[row] = previousSoftWrap[sourceRow] ?? false
      this.contentEnd[row] = previousContentEnd[sourceRow] ?? 0
    }
  }

  snapshotLines(options: SnapshotOptions = {}): string[] {
    const lines: string[] = []

    for (let row = 0; row < this.height; row++) {
      let line = ''
      for (let col = 0; col < this.width; col++) {
        const cell = this.cells[this.indexOfUnchecked(col, row)]
        if (cell?.char === '') continue
        line += cell?.char ?? ' '
      }
      lines.push(options.trimEnd ? line.replace(/\s+$/, '') : line)
    }

    return lines
  }

  extractSelectableText(range?: SelectionRange): string {
    const bounds = selectionBounds(range, this.width, this.height)
    if (!bounds) return ''

    const lines: string[] = []
    for (let row = bounds.start.y; row <= bounds.end.y; row++) {
      const startX = row === bounds.start.y ? bounds.start.x : 0
      const endX = row === bounds.end.y ? bounds.end.x : this.width - 1
      const nextRowContinues = row < bounds.end.y && this.isSoftWrapRow(row + 1)
      const text = this.extractRowText(row, startX, endX, !nextRowContinues)

      if (this.isSoftWrapRow(row) && lines.length > 0) {
        lines[lines.length - 1] += text
      } else {
        lines.push(text)
      }
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }

    return lines.join('\n')
  }

  setSoftWrap(row: number, softWrap = true): void {
    const normalizedRow = normalizeInteger(row)
    if (normalizedRow < 0 || normalizedRow >= this.height) return

    this.softWrap[normalizedRow] = softWrap
    for (let col = 0; col < this.width; col++) {
      this.cells[this.indexOfUnchecked(col, normalizedRow)].softWrap = softWrap
    }
  }

  markNoSelectRect(rect: ScreenRect, noSelect?: boolean): void
  markNoSelectRect(x: number, y: number, width: number, height: number, noSelect?: boolean): void
  markNoSelectRect(
    rectOrX: ScreenRect | number,
    yOrNoSelect?: number | boolean,
    width?: number,
    height?: number,
    noSelect = true,
  ): void {
    const rect =
      typeof rectOrX === 'number'
        ? rectFromArgs(rectOrX, yOrNoSelect as number, width, height)
        : rectFromArgs(rectOrX)
    const value = typeof yOrNoSelect === 'boolean' ? yOrNoSelect : noSelect
    const clipped = clipRect(rect, this.width, this.height)
    if (!clipped) return

    for (let row = clipped.y; row < clipped.y + clipped.height; row++) {
      for (let col = clipped.x; col < clipped.x + clipped.width; col++) {
        const index = this.indexOfUnchecked(col, row)
        this.cells[index].noSelect = value
        this.noSelect[index] = value ? 1 : 0
      }
    }
  }

  private extractRowText(row: number, startX: number, endX: number, trimEnd: boolean): string {
    let text = ''
    const from = clamp(startX, 0, this.width - 1)
    const contentEnd = this.contentEnd[row] ?? 0
    const lastWritten = contentEnd > 0 ? contentEnd - 1 : -1
    const to = Math.min(clamp(endX, 0, this.width - 1), lastWritten)
    if (to < from) return ''

    for (let col = from; col <= to; col++) {
      if (this.isNoSelect(col, row)) continue
      const cell = this.cells[this.indexOfUnchecked(col, row)]
      if (cell.char === '') continue
      text += cell.char
    }

    return trimEnd ? text.replace(/\s+$/, '') : text
  }

  private putCell(x: number, y: number, cell: ScreenCell): void {
    if (!this.inBounds(x, y)) return
    const width = cellWidth(cell.char)
    if (width === 2 && x + 1 >= this.width) return

    this.prepareForWrite(x, y)
    if (width === 2) {
      this.prepareForWrite(x + 1, y)
    }

    const index = this.indexOfUnchecked(x, y)
    const nextCell = cloneCell(cell)
    this.cells[index] = nextCell
    this.noSelect[index] = nextCell.noSelect ? 1 : 0
    this.contentEnd[y] = Math.max(this.contentEnd[y] ?? 0, x + width)

    if (width === 2) {
      const spacerIndex = this.indexOfUnchecked(x + 1, y)
      this.cells[spacerIndex] = {
        char: '',
        style: nextCell.style,
        noSelect: nextCell.noSelect,
        softWrap: nextCell.softWrap,
      }
      this.noSelect[spacerIndex] = nextCell.noSelect ? 1 : 0
    }
  }

  private prepareForWrite(x: number, y: number): void {
    if (!this.inBounds(x, y)) return

    if (this.isSpacerAt(x, y) && x > 0 && this.isWideAt(x - 1, y)) {
      this.setEmptyAt(x - 1, y)
    }

    if (this.isWideAt(x, y) && x + 1 < this.width && this.isSpacerAt(x + 1, y)) {
      this.setEmptyAt(x + 1, y)
    }

    this.setEmptyAt(x, y)
  }

  private clearRow(row: number): void {
    for (let col = 0; col < this.width; col++) {
      this.setEmptyAt(col, row)
    }
    this.softWrap[row] = false
    this.contentEnd[row] = 0
  }

  private setEmptyAt(x: number, y: number): void {
    if (!this.inBounds(x, y)) return
    const index = this.indexOfUnchecked(x, y)
    this.cells[index] = emptyCell()
    this.noSelect[index] = 0
  }

  private recomputeContentEnd(row: number): void {
    for (let col = this.width - 1; col >= 0; col--) {
      const cell = this.cells[this.indexOfUnchecked(col, row)]
      if (cell.char !== '' && cell.char !== ' ') {
        this.contentEnd[row] = col + cellWidth(cell.char)
        return
      }
    }

    this.contentEnd[row] = 0
  }

  private isNoSelect(x: number, y: number): boolean {
    const index = this.indexOf(x, y)
    return index >= 0 && (this.cells[index].noSelect || this.noSelect[index] === 1)
  }

  private isSoftWrapRow(row: number): boolean {
    if (row < 0 || row >= this.height) return false
    if (this.softWrap[row]) return true

    for (let col = 0; col < this.width; col++) {
      if (this.cells[this.indexOfUnchecked(col, row)].softWrap) return true
    }

    return false
  }

  private isSpacerAt(x: number, y: number): boolean {
    return this.cellAt(x, y)?.char === ''
  }

  private isWideAt(x: number, y: number): boolean {
    const cell = this.cellAt(x, y)
    return Boolean(cell && cell.char !== '' && cellWidth(cell.char) === 2)
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height
  }

  private indexOf(x: number, y: number): number {
    const col = normalizeInteger(x)
    const row = normalizeInteger(y)
    return this.inBounds(col, row) ? this.indexOfUnchecked(col, row) : -1
  }

  private indexOfUnchecked(x: number, y: number): number {
    return y * this.width + x
  }
}

export function createScreen(size: ScreenSize): Screen
export function createScreen(width: number, height: number): Screen
export function createScreen(sizeOrWidth: ScreenSize | number, height?: number): Screen {
  return typeof sizeOrWidth === 'number'
    ? new Screen(sizeOrWidth, height ?? 0)
    : new Screen(sizeOrWidth)
}

export function writeText(
  screen: Screen,
  x: number,
  y: number,
  text: string,
  options?: WriteTextOptions,
): WriteTextResult {
  return screen.writeText(x, y, text, options)
}

export function clearRect(screen: Screen, rect: ScreenRect): void
export function clearRect(screen: Screen, x: number, y: number, width: number, height: number): void
export function clearRect(
  screen: Screen,
  rectOrX: ScreenRect | number,
  y?: number,
  width?: number,
  height?: number,
): void {
  if (typeof rectOrX === 'number') {
    screen.clearRect(rectOrX, y ?? 0, width ?? 0, height ?? 0)
    return
  }

  screen.clearRect(rectOrX)
}

export function blit(target: Screen, source: Screen, options?: BlitOptions): void {
  target.blit(source, options)
}

export function shiftRows(screen: Screen, top: number, bottom: number, offset: number): void {
  screen.shiftRows(top, bottom, offset)
}

export function snapshotLines(screen: Screen, options?: SnapshotOptions): string[] {
  return screen.snapshotLines(options)
}

export function extractSelectableText(screen: Screen, range?: SelectionRange): string {
  return screen.extractSelectableText(range)
}

export function markNoSelectRect(screen: Screen, rect: ScreenRect, noSelect?: boolean): void
export function markNoSelectRect(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
  noSelect?: boolean,
): void
export function markNoSelectRect(
  screen: Screen,
  rectOrX: ScreenRect | number,
  yOrNoSelect?: number | boolean,
  width?: number,
  height?: number,
  noSelect?: boolean,
): void {
  if (typeof rectOrX === 'number') {
    screen.markNoSelectRect(rectOrX, yOrNoSelect as number, width ?? 0, height ?? 0, noSelect)
    return
  }

  screen.markNoSelectRect(rectOrX, typeof yOrNoSelect === 'boolean' ? yOrNoSelect : true)
}

function emptyCell(): ScreenCell {
  return {
    char: ' ',
    style: undefined,
    noSelect: false,
    softWrap: false,
  }
}

function cloneCell(cell: ScreenCell): ScreenCell {
  return {
    char: cell.char,
    style: cell.style,
    noSelect: cell.noSelect,
    softWrap: cell.softWrap,
  }
}

function normalizeSize(sizeOrWidth: ScreenSize | number, height?: number): ScreenSize {
  if (typeof sizeOrWidth === 'number') {
    return {
      width: Math.max(0, normalizeInteger(sizeOrWidth)),
      height: Math.max(0, normalizeInteger(height ?? 0)),
    }
  }

  return {
    width: Math.max(0, normalizeInteger(sizeOrWidth.width)),
    height: Math.max(0, normalizeInteger(sizeOrWidth.height)),
  }
}

function rectFromArgs(rect: ScreenRect): ScreenRect
function rectFromArgs(x: number, y?: number, width?: number, height?: number): ScreenRect
function rectFromArgs(rectOrX: ScreenRect | number, y = 0, width = 0, height = 0): ScreenRect {
  if (typeof rectOrX === 'number') {
    return {
      x: normalizeInteger(rectOrX),
      y: normalizeInteger(y),
      width: normalizeInteger(width),
      height: normalizeInteger(height),
    }
  }

  return {
    x: normalizeInteger(rectOrX.x),
    y: normalizeInteger(rectOrX.y),
    width: normalizeInteger(rectOrX.width),
    height: normalizeInteger(rectOrX.height),
  }
}

function clipRect(rect: ScreenRect, width: number, height: number): ScreenRect | undefined {
  if (rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return undefined

  const startX = clamp(rect.x, 0, width)
  const startY = clamp(rect.y, 0, height)
  const endX = clamp(rect.x + rect.width, 0, width)
  const endY = clamp(rect.y + rect.height, 0, height)

  if (startX >= endX || startY >= endY) return undefined

  return {
    x: startX,
    y: startY,
    width: endX - startX,
    height: endY - startY,
  }
}

function normalizeBlit(source: Screen, target: Screen, options: BlitOptions) {
  let sourceX = normalizeInteger(options.source?.x ?? options.sourceX ?? options.srcX ?? 0)
  let sourceY = normalizeInteger(options.source?.y ?? options.sourceY ?? options.srcY ?? 0)
  let targetX = normalizeInteger(
    options.target?.x ?? options.targetX ?? options.dstX ?? options.x ?? 0,
  )
  let targetY = normalizeInteger(
    options.target?.y ?? options.targetY ?? options.dstY ?? options.y ?? 0,
  )
  let width = normalizeInteger(options.source?.width ?? options.width ?? source.width)
  let height = normalizeInteger(options.source?.height ?? options.height ?? source.height)

  if (sourceX < 0) {
    targetX -= sourceX
    width += sourceX
    sourceX = 0
  }

  if (sourceY < 0) {
    targetY -= sourceY
    height += sourceY
    sourceY = 0
  }

  if (targetX < 0) {
    sourceX -= targetX
    width += targetX
    targetX = 0
  }

  if (targetY < 0) {
    sourceY -= targetY
    height += targetY
    targetY = 0
  }

  width = Math.min(width, source.width - sourceX, target.width - targetX)
  height = Math.min(height, source.height - sourceY, target.height - targetY)

  if (width <= 0 || height <= 0) return undefined

  return {
    sourceX,
    sourceY,
    targetX,
    targetY,
    width,
    height,
  }
}

function selectionBounds(
  range: SelectionRange | undefined,
  width: number,
  height: number,
): { start: ScreenPoint; end: ScreenPoint } | undefined {
  if (width <= 0 || height <= 0) return undefined

  let start: ScreenPoint
  let end: ScreenPoint

  if (!range) {
    start = { x: 0, y: 0 }
    end = { x: width - 1, y: height - 1 }
  } else if ('start' in range) {
    start = pointFromRange(range.start)
    end = pointFromRange(range.end)
  } else if ('startX' in range) {
    start = { x: normalizeInteger(range.startX), y: normalizeInteger(range.startY) }
    end = { x: normalizeInteger(range.endX), y: normalizeInteger(range.endY) }
  } else {
    if (range.width <= 0 || range.height <= 0) return undefined
    start = { x: normalizeInteger(range.x), y: normalizeInteger(range.y) }
    end = {
      x: normalizeInteger(range.x + range.width - 1),
      y: normalizeInteger(range.y + range.height - 1),
    }
  }

  if (comparePoints(start, end) > 0) {
    const previousStart = start
    start = end
    end = previousStart
  }

  if (end.y < 0 || start.y >= height) return undefined

  return {
    start: {
      x: clamp(start.x, 0, width - 1),
      y: clamp(start.y, 0, height - 1),
    },
    end: {
      x: clamp(end.x, 0, width - 1),
      y: clamp(end.y, 0, height - 1),
    },
  }
}

function pointFromRange(point: Partial<ScreenPoint> & { col?: number; row?: number }): ScreenPoint {
  return {
    x: normalizeInteger(point.x ?? point.col ?? 0),
    y: normalizeInteger(point.y ?? point.row ?? 0),
  }
}

function comparePoints(left: ScreenPoint, right: ScreenPoint): number {
  if (left.y !== right.y) return left.y < right.y ? -1 : 1
  if (left.x !== right.x) return left.x < right.x ? -1 : 1
  return 0
}

function splitText(text: string): string[] {
  return Array.from(text)
}

function cellWidth(char: string): 0 | 1 | 2 {
  if (char.length === 0) return 0
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined) return 0
  if (isCombiningMark(codePoint)) return 0
  return isWideCodePoint(codePoint) || isEmoji(char) ? 2 : 1
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )
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

function isEmoji(char: string): boolean {
  return /\p{Extended_Pictographic}/u.test(char)
}

function normalizeInteger(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}
