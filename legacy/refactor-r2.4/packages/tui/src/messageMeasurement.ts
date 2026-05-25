export type MutableMessageHeightMap = Map<string, number>

export function commitMeasuredMessageRows(
  measuredRows: MutableMessageHeightMap,
  messageId: string,
  rows: number,
): boolean {
  if (!Number.isFinite(rows) || rows <= 0) {
    return false
  }

  const normalizedRows = Math.max(1, Math.ceil(rows))
  if (measuredRows.get(messageId) === normalizedRows) {
    return false
  }

  measuredRows.set(messageId, normalizedRows)
  return true
}
