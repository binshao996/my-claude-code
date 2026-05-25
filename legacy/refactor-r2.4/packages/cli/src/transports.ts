import type { SDKStdoutMessage } from '@my-claude-code/core'

export type Transport = {
  setOnData(callback: (data: string) => void): void
  setOnClose(callback: (code?: number) => void): void
  connect(): Promise<void>
  write(message: SDKStdoutMessage): Promise<void>
  close(): void
}

export type TransportFetch = typeof fetch

export type TransportOptions = {
  headers?: Record<string, string>
  sessionId?: string
  fetchImpl?: TransportFetch
  webSocketFactory?: (url: string, protocols?: string | string[]) => WebSocketLike
}

export type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number): void
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void
}

export class WebSocketTransport implements Transport {
  private onData?: (data: string) => void
  private onClose?: (code?: number) => void
  private socket?: WebSocketLike

  constructor(
    protected readonly url: URL,
    private readonly options: TransportOptions = {},
  ) {}

  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  setOnClose(callback: (code?: number) => void): void {
    this.onClose = callback
  }

  async connect(): Promise<void> {
    this.socket = this.options.webSocketFactory
      ? this.options.webSocketFactory(this.url.href)
      : new WebSocket(this.url.href)
    this.socket.addEventListener('message', event => {
      this.onData?.(`${String(event.data)}\n`)
    })
    this.socket.addEventListener('close', event => {
      this.onClose?.(event.code)
    })
  }

  async write(message: SDKStdoutMessage): Promise<void> {
    this.socket?.send(JSON.stringify(message))
  }

  close(): void {
    this.socket?.close()
  }
}

export class SSETransport implements Transport {
  private onData?: (data: string) => void
  private onClose?: (code?: number) => void
  private closed = false

  constructor(
    private readonly url: URL,
    private readonly options: TransportOptions = {},
  ) {}

  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  setOnClose(callback: (code?: number) => void): void {
    this.onClose = callback
  }

  async connect(): Promise<void> {
    const response = await this.fetchImpl()(this.url, {
      headers: this.options.headers,
    })
    if (!response.ok || !response.body) {
      this.onClose?.(response.status)
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!this.closed) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      const parsed = parseSSEFrames(buffer)
      buffer = parsed.remaining
      for (const frame of parsed.frames) {
        if (frame.data) {
          this.onData?.(`${frame.data}\n`)
        }
      }
    }
    this.onClose?.()
  }

  async write(message: SDKStdoutMessage): Promise<void> {
    const response = await this.fetchImpl()(this.writeUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.options.headers,
      },
      body: JSON.stringify({
        session_id: this.options.sessionId,
        message,
      }),
    })
    if (!response.ok) {
      throw new Error(`SSE transport write failed: ${response.status}`)
    }
  }

  close(): void {
    this.closed = true
  }

  private fetchImpl(): TransportFetch {
    return this.options.fetchImpl ?? fetch
  }

  private writeUrl(): URL {
    const url = new URL(this.url.href)
    url.pathname = url.pathname.replace(/\/events\/stream$/, '/events')
    return url
  }
}

export class HybridTransport extends WebSocketTransport {
  constructor(
    url: URL,
    private readonly hybridOptions: TransportOptions = {},
  ) {
    super(url, hybridOptions)
  }

  override async write(message: SDKStdoutMessage): Promise<void> {
    const response = await (this.hybridOptions.fetchImpl ?? fetch)(this.postUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.hybridOptions.headers,
      },
      body: JSON.stringify({
        session_id: this.hybridOptions.sessionId,
        message,
      }),
    })
    if (!response.ok) {
      throw new Error(`Hybrid transport write failed: ${response.status}`)
    }
  }

  private postUrl(): URL {
    const url = new URL(this.url.href)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    return url
  }
}

export function getTransportForUrl(
  url: URL,
  options: TransportOptions & {
    useSSE?: boolean
    usePostForWrites?: boolean
  } = {},
): Transport {
  if (options.useSSE) {
    const sseUrl = new URL(url.href)
    sseUrl.protocol = sseUrl.protocol === 'wss:' ? 'https:' : 'http:'
    sseUrl.pathname = `${sseUrl.pathname.replace(/\/$/, '')}/worker/events/stream`
    return new SSETransport(sseUrl, options)
  }

  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return options.usePostForWrites
      ? new HybridTransport(url, options)
      : new WebSocketTransport(url, options)
  }

  throw new Error(`Unsupported transport protocol: ${url.protocol}`)
}

export function parseSSEFrames(buffer: string): {
  frames: Array<{ event?: string; id?: string; data?: string }>
  remaining: string
} {
  const frames: Array<{ event?: string; id?: string; data?: string }> = []
  let position = 0
  const delimiter = /\r?\n\r?\n/g
  let match = delimiter.exec(buffer)
  while (match !== null) {
    const raw = buffer.slice(position, match.index)
    position = match.index + match[0].length
    const frame: { event?: string; id?: string; data?: string } = {}
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) {
        continue
      }
      const index = line.indexOf(':')
      if (index === -1) {
        continue
      }
      const key = line.slice(0, index)
      const value = line[index + 1] === ' '
        ? line.slice(index + 2)
        : line.slice(index + 1)
      if (key === 'event') {
        frame.event = value
      } else if (key === 'id') {
        frame.id = value
      } else if (key === 'data') {
        frame.data = frame.data ? `${frame.data}\n${value}` : value
      }
    }
    if (frame.data || frame.event || frame.id) {
      frames.push(frame)
    }
    match = delimiter.exec(buffer)
  }

  return {
    frames,
    remaining: buffer.slice(position),
  }
}
