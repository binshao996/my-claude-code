import { describe, expect, it } from 'bun:test'
import { getVoiceStreamStatus } from './audio.js'

describe('voice STT provider status', () => {
  it('does not treat a DeepSeek chat key as an STT credential', () => {
    expect(getVoiceStreamStatus({ DEEPSEEK_API_KEY: 'redacted' })).toMatchObject({
      available: false,
      provider: 'deepseek',
      auth: 'api-key',
      endpoint: 'https://api.deepseek.com/chat/completions',
      reason: expect.stringContaining('does not expose a speech-to-text/audio transcription endpoint'),
    })
  })

  it('supports explicit DeepSeek voice selection with a clear missing-capability reason', () => {
    expect(getVoiceStreamStatus({ MY_CLAUDE_CODE_VOICE_PROVIDER: 'deepseek' })).toMatchObject({
      available: false,
      provider: 'deepseek',
      auth: 'missing',
      reason: expect.stringContaining('DeepSeek voice provider requires DEEPSEEK_API_KEY'),
    })
  })
})
