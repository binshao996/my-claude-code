import { describe, expect, it } from 'bun:test'
import { commitMeasuredMessageRows } from './messageMeasurement.js'

describe('TUI message measurement commit guard', () => {
  it('commits only finite changed row measurements', () => {
    const measuredRows = new Map<string, number>()

    expect(commitMeasuredMessageRows(measuredRows, 'msg_1', 1.2)).toBe(true)
    expect(measuredRows.get('msg_1')).toBe(2)
    expect(commitMeasuredMessageRows(measuredRows, 'msg_1', 1.8)).toBe(false)
    expect(commitMeasuredMessageRows(measuredRows, 'msg_1', 3)).toBe(true)
    expect(commitMeasuredMessageRows(measuredRows, 'msg_2', 0)).toBe(false)
    expect(commitMeasuredMessageRows(measuredRows, 'msg_2', Number.NaN)).toBe(false)
  })
})
