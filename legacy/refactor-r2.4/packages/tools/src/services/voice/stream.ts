export type VoiceStreamMessage =
  | { type: 'TranscriptText'; data: string }
  | { type: 'TranscriptEndpoint' }
  | { type: 'TranscriptError'; error_code?: string; description?: string }
  | { type: 'error'; message?: string }

export type VoiceStreamEvent =
  | { type: 'ready' }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'closed' }

export type VoiceStreamConnection = {
  sendAudio(chunk: Buffer): void
  finalize(): Promise<'endpoint' | 'close' | 'timeout' | 'already_closed'>
  close(): void
  isConnected(): boolean
  events: VoiceStreamEvent[]
}

type WebSocketLike = {
  readyState: number
  send(data: string | Buffer): void
  close(): void
  addEventListener?(event: string, handler: (event: { data?: unknown; code?: number; reason?: string }) => void): void
  on?(event: string, handler: (...args: unknown[]) => void): void
}

export type VoiceStreamWebSocketFactory = (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocketLike

export type ConnectVoiceStreamOptions = {
  endpoint: string
  token: string
  provider?: 'anthropic' | 'doubao' | 'deepseek'
  language?: string
  keyterms?: string[]
  keepAliveMs?: number
  finalizeTimeoutMs?: number
  webSocketFactory?: VoiceStreamWebSocketFactory
}

const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3
const KEEPALIVE = '{"type":"KeepAlive"}'
const CLOSE_STREAM = '{"type":"CloseStream"}'

export function connectVoiceStream(
  options: ConnectVoiceStreamOptions,
): VoiceStreamConnection {
  const events: VoiceStreamEvent[] = []
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language: options.language ?? 'en',
  })
  for (const term of options.keyterms ?? []) {
    params.append('keyterms', term)
  }
  const separator = options.endpoint.includes('?') ? '&' : '?'
  const url = `${options.endpoint}${separator}${params.toString()}`
  const factory = options.webSocketFactory ?? defaultWebSocketFactory
  const ws = factory(url, {
    headers: {
      Authorization: `Bearer ${options.token}`,
      'User-Agent': 'my-claude-code',
      'x-app': 'cli',
    },
  })
  let keepAlive: ReturnType<typeof setInterval> | undefined
  let connected = false
  let finalizing = false
  let finalized = false
  let lastTranscript = ''
  let resolveFinalize: ((value: 'endpoint' | 'close' | 'timeout' | 'already_closed') => void) | undefined

  const connection: VoiceStreamConnection = {
    events,
    sendAudio(chunk) {
      if (!connected || finalized || ws.readyState !== WS_OPEN) {
        return
      }
      ws.send(Buffer.from(chunk))
    },
    finalize() {
      if (finalizing || finalized) {
        return Promise.resolve('already_closed')
      }
      finalizing = true
      return new Promise(resolve => {
        const timeout = setTimeout(() => {
          resolveFinalize?.('timeout')
        }, options.finalizeTimeoutMs ?? 5000)
        resolveFinalize = value => {
          clearTimeout(timeout)
          if (lastTranscript) {
            events.push({ type: 'transcript', text: lastTranscript, final: true })
            lastTranscript = ''
          }
          resolveFinalize = undefined
          resolve(value)
        }
        setTimeout(() => {
          finalized = true
          if (ws.readyState === WS_OPEN) {
            ws.send(CLOSE_STREAM)
          } else {
            resolveFinalize?.('already_closed')
          }
        }, 0)
      })
    },
    close() {
      finalized = true
      if (keepAlive) {
        clearInterval(keepAlive)
        keepAlive = undefined
      }
      if (ws.readyState !== WS_CLOSED && ws.readyState !== WS_CLOSING) {
        ws.close()
      }
    },
    isConnected() {
      return connected && ws.readyState === WS_OPEN
    },
  }

  onWs(ws, 'open', () => {
    connected = true
    events.push({ type: 'ready' })
    ws.send(KEEPALIVE)
    keepAlive = setInterval(() => {
      if (ws.readyState === WS_OPEN) {
        ws.send(KEEPALIVE)
      }
    }, options.keepAliveMs ?? 8000)
  })

  onWs(ws, 'message', raw => {
    const message = parseVoiceStreamMessage(raw)
    if (!message) {
      return
    }
    if (message.type === 'TranscriptText') {
      if (lastTranscript && message.data && !message.data.startsWith(lastTranscript) && !lastTranscript.startsWith(message.data)) {
        events.push({ type: 'transcript', text: lastTranscript, final: true })
      }
      lastTranscript = message.data
      events.push({ type: 'transcript', text: message.data, final: false })
      return
    }
    if (message.type === 'TranscriptEndpoint') {
      if (lastTranscript) {
        events.push({ type: 'transcript', text: lastTranscript, final: true })
        lastTranscript = ''
      }
      resolveFinalize?.('endpoint')
      return
    }
    if (message.type === 'TranscriptError') {
      events.push({
        type: 'error',
        message: message.description ?? message.error_code ?? 'unknown transcription error',
        fatal: false,
      })
      return
    }
    if (message.type === 'error') {
      events.push({ type: 'error', message: message.message ?? 'voice stream error', fatal: true })
    }
  })

  onWs(ws, 'close', () => {
    connected = false
    if (keepAlive) {
      clearInterval(keepAlive)
      keepAlive = undefined
    }
    if (lastTranscript) {
      events.push({ type: 'transcript', text: lastTranscript, final: true })
      lastTranscript = ''
    }
    events.push({ type: 'closed' })
    resolveFinalize?.('close')
  })

  onWs(ws, 'error', error => {
    events.push({ type: 'error', message: error instanceof Error ? error.message : String(error), fatal: true })
  })

  return connection
}

function parseVoiceStreamMessage(raw: unknown): VoiceStreamMessage | undefined {
  const data = typeof raw === 'object' && raw !== null && 'data' in raw
    ? (raw as { data?: unknown }).data
    : raw
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '')
  try {
    const parsed = JSON.parse(text) as VoiceStreamMessage
    return typeof parsed.type === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function onWs(
  ws: WebSocketLike,
  event: string,
  handler: (...args: unknown[]) => void,
): void {
  if (ws.addEventListener) {
    ws.addEventListener(event, eventObject => handler(eventObject.data ?? eventObject))
    return
  }
  ws.on?.(event, handler)
}

function defaultWebSocketFactory(
  url: string,
  _init: { headers: Record<string, string> },
): WebSocketLike {
  const ctor = globalThis.WebSocket as
    | (new (url: string, protocols?: string | string[]) => WebSocket)
    | undefined
  if (!ctor) {
    throw new Error('WebSocket is not available in this runtime')
  }
  return new ctor(url) as unknown as WebSocketLike
}
