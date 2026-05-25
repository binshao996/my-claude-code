import { describe, expect, it } from 'bun:test'
import { statusLineRows } from './StatusLine.js'

describe('TUI status line voice indicator', () => {
  it('renders voice provider, status, and recording state in the header rows', () => {
    const idleRows = statusLineRows({
      sessionId: '123456789',
      cwd: '/tmp/project',
      status: 'idle',
      voice: {
        enabled: true,
        status: 'ready',
        provider: 'anthropic',
      },
    })
    expect(idleRows.at(-1)?.text).toContain('voice ready:anthropic')

    const recordingRows = statusLineRows({
      sessionId: '123456789',
      cwd: '/tmp/project',
      status: 'idle',
      voice: {
        enabled: true,
        status: 'ready',
        provider: 'anthropic',
        recording: true,
      },
    })
    expect(recordingRows.at(-1)?.text).toContain('voice recording:anthropic')
  })
})
