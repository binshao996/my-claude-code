export type IdeSelection = {
  filePath: string
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
  text: string
}

export type IdeDiffSummary = {
  filePath: string
  addedLines: number
  removedLines: number
  changed: boolean
}

export function normalizeIdeSelection(selection: IdeSelection): IdeSelection {
  const startsAfterEnd =
    selection.startLine > selection.endLine ||
    (selection.startLine === selection.endLine && selection.startCharacter > selection.endCharacter)

  return startsAfterEnd
    ? {
        ...selection,
        startLine: selection.endLine,
        startCharacter: selection.endCharacter,
        endLine: selection.startLine,
        endCharacter: selection.startCharacter,
      }
    : selection
}

export function summarizeIdeDiff(filePath: string, before: string, after: string): IdeDiffSummary {
  const beforeLines = before.split(/\r?\n/)
  const afterLines = after.split(/\r?\n/)
  const sharedLength = Math.min(beforeLines.length, afterLines.length)
  let changedSharedLines = 0
  for (let index = 0; index < sharedLength; index += 1) {
    if (beforeLines[index] !== afterLines[index]) {
      changedSharedLines += 1
    }
  }
  return {
    filePath,
    addedLines: Math.max(0, afterLines.length - beforeLines.length) + changedSharedLines,
    removedLines: Math.max(0, beforeLines.length - afterLines.length) + changedSharedLines,
    changed: before !== after,
  }
}
