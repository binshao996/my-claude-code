export type ScreenCell = {
  char: string
}

export type ScreenBuffer = {
  width: number
  height: number
  rows: string[]
  cursor?: ScreenCursor
}

export type ScreenCursor = {
  row: number
  column: number
  visible: boolean
}

export type ScreenBufferPatch =
  | {
      type: 'clear'
    }
  | {
      type: 'write'
      row: number
      column: number
      text: string
    }
  | {
      type: 'cursor'
      row: number
      column: number
      visible: boolean
    }

export function createScreenBuffer(args: {
  width: number
  height: number
  rows?: string[]
  cursor?: Partial<ScreenCursor>
}): ScreenBuffer {
  const width = Math.max(1, Math.floor(args.width))
  const height = Math.max(1, Math.floor(args.height))
  const rows = Array.from({ length: height }, (_, index) =>
    normalizeScreenRow(args.rows?.[index] ?? '', width),
  )

  return {
    width,
    height,
    rows,
    ...(args.cursor ? { cursor: normalizeScreenCursor(args.cursor, width, height) } : {}),
  }
}

export function resizeScreenBuffer(
  buffer: ScreenBuffer,
  size: {
    width: number
    height: number
  },
): ScreenBuffer {
  return createScreenBuffer({
    width: size.width,
    height: size.height,
    rows: buffer.rows,
    cursor: buffer.cursor,
  })
}

export function diffScreenBuffers(
  previous: ScreenBuffer | undefined,
  next: ScreenBuffer,
): ScreenBufferPatch[] {
  if (!previous || previous.width !== next.width || previous.height !== next.height) {
    return [
      { type: 'clear' },
      ...next.rows.flatMap((row, index) =>
        row.trimEnd()
          ? [{ type: 'write' as const, row: index, column: 0, text: row.trimEnd() }]
          : [],
      ),
      ...(next.cursor ? [screenCursorPatch(next.cursor)] : []),
    ]
  }

  const patches: ScreenBufferPatch[] = []
  for (let row = 0; row < next.height; row++) {
    const previousRow = previous.rows[row] ?? ''
    const nextRow = next.rows[row] ?? ''
    const patch = diffScreenRow(previousRow, nextRow, row)
    if (patch) {
      patches.push(patch)
    }
  }

  if (!sameCursor(previous.cursor, next.cursor) && next.cursor) {
    patches.push(screenCursorPatch(next.cursor))
  }

  return patches
}

export function applyScreenBufferPatches(
  previous: ScreenBuffer | undefined,
  patches: ScreenBufferPatch[],
  size: {
    width: number
    height: number
  },
): ScreenBuffer {
  let current = previous ?? createScreenBuffer(size)
  for (const patch of patches) {
    if (patch.type === 'clear') {
      current = createScreenBuffer(size)
      continue
    }

    if (patch.type === 'write') {
      const rows = [...current.rows]
      const row = normalizeScreenRow(rows[patch.row] ?? '', current.width)
      rows[patch.row] = normalizeScreenRow(
        `${row.slice(0, patch.column)}${patch.text}${row.slice(patch.column + patch.text.length)}`,
        current.width,
      )
      current = {
        ...current,
        rows,
      }
      continue
    }

    if (patch.type === 'cursor') {
      current = {
        ...current,
        cursor: normalizeScreenCursor(patch, current.width, current.height),
      }
    }
  }

  return current
}

function screenCursorPatch(cursor: ScreenCursor): ScreenBufferPatch {
  return {
    type: 'cursor',
    row: cursor.row,
    column: cursor.column,
    visible: cursor.visible,
  }
}

function normalizeScreenCursor(
  cursor: Partial<ScreenCursor>,
  width: number,
  height: number,
): ScreenCursor {
  return {
    row: Math.max(0, Math.min(height - 1, Math.floor(cursor.row ?? 0))),
    column: Math.max(0, Math.min(width - 1, Math.floor(cursor.column ?? 0))),
    visible: Boolean(cursor.visible),
  }
}

function sameCursor(
  previous: ScreenCursor | undefined,
  next: ScreenCursor | undefined,
): boolean {
  return (
    previous?.row === next?.row &&
    previous?.column === next?.column &&
    previous?.visible === next?.visible
  )
}

function diffScreenRow(
  previous: string,
  next: string,
  row: number,
): ScreenBufferPatch | undefined {
  if (previous === next) {
    return undefined
  }

  let start = 0
  while (start < next.length && previous[start] === next[start]) {
    start++
  }

  let previousEnd = previous.length - 1
  let nextEnd = next.length - 1
  while (
    previousEnd >= start &&
    nextEnd >= start &&
    previous[previousEnd] === next[nextEnd]
  ) {
    previousEnd--
    nextEnd--
  }

  return {
    type: 'write',
    row,
    column: start,
    text: next.slice(start, nextEnd + 1),
  }
}

function normalizeScreenRow(row: string, width: number): string {
  if (row.length >= width) {
    return row.slice(0, width)
  }

  return row.padEnd(width, ' ')
}
