import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { connectVoiceStream, type VoiceStreamWebSocketFactory } from './stream.js'

class FakeWebSocket extends EventEmitter {
  readyState = 0
  sent: Array<string | Buffer> = []

  send(data: string | Buffer) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }

  open() {
    this.readyState = 1
    this.emit('open')
  }

  message(value: unknown) {
    this.emit('message', JSON.stringify(value))
  }
}

describe('voice stream STT adapter', () => {
  it('speaks the voice_stream websocket protocol and finalizes transcript segments', async () => {
    const socket = new FakeWebSocket()
    const factory: VoiceStreamWebSocketFactory = () => socket
    const connection = connectVoiceStream({
      endpoint: 'wss://voice.example/api/ws/speech_to_text/voice_stream',
      token: 'secret-token',
      keepAliveMs: 50_000,
      finalizeTimeoutMs: 50,
      webSocketFactory: factory,
      keyterms: ['Claude Code'],
    })

    socket.open()
    expect(socket.sent[0]).toBe('{"type":"KeepAlive"}')
    expect(connection.isConnected()).toBe(true)

    connection.sendAudio(Buffer.from([1, 2, 3]))
    expect(Buffer.isBuffer(socket.sent[1])).toBe(true)

    socket.message({ type: 'TranscriptText', data: 'hello' })
    socket.message({ type: 'TranscriptText', data: 'hello world' })
    const pendingFinalize = connection.finalize()
    await new Promise(resolve => setTimeout(resolve, 0))
    socket.message({ type: 'TranscriptEndpoint' })
    const finalized = await pendingFinalize

    expect(finalized).toBe('endpoint')
    expect(socket.sent).toContain('{"type":"CloseStream"}')
    expect(connection.events).toContainEqual({ type: 'ready' })
    expect(connection.events).toContainEqual({
      type: 'transcript',
      text: 'hello world',
      final: true,
    })
  })

  it('surfaces server errors without leaking auth material', () => {
    const socket = new FakeWebSocket()
    const connection = connectVoiceStream({
      endpoint: 'wss://voice.example/stream',
      token: 'secret-token',
      webSocketFactory: () => socket,
    })
    socket.open()
    socket.message({ type: 'TranscriptError', description: 'microphone rejected' })

    expect(connection.events).toContainEqual({
      type: 'error',
      message: 'microphone rejected',
      fatal: false,
    })
    expect(JSON.stringify(connection.events)).not.toContain('secret-token')
  })
})
