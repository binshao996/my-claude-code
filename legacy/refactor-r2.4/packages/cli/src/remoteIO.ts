import type { SDKStdoutMessage } from '@my-claude-code/core'
import { StructuredIO } from './structuredIO.js'
import {
  type Transport,
  type TransportOptions,
  getTransportForUrl,
} from './transports.js'

export class RemoteIO extends StructuredIO {
  private readonly transport: Transport

  constructor(
    streamUrl: string,
    initialPrompt?: AsyncIterable<string>,
    options: TransportOptions & {
      useSSE?: boolean
      usePostForWrites?: boolean
      transport?: Transport
    } = {},
  ) {
    const transport = options.transport ?? getTransportForUrl(new URL(streamUrl), options)
    const input = createRemoteInput(transport, initialPrompt)
    super(input, {
      write: message => transport.write(JSON.parse(message) as SDKStdoutMessage),
    })
    this.transport = transport
  }

  connect(): Promise<void> {
    return this.transport.connect()
  }

  close(): void {
    this.transport.close()
  }
}

function createRemoteInput(
  transport: Transport,
  initialPrompt?: AsyncIterable<string>,
): AsyncIterable<string> {
  const queue: string[] = []
  const waiters: Array<(value: IteratorResult<string>) => void> = []
  let closed = false

  const push = (value: string) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    queue.push(value)
  }
  const close = () => {
    closed = true
    for (const waiter of waiters.splice(0)) {
      waiter({ done: true, value: undefined })
    }
  }

  transport.setOnData(push)
  transport.setOnClose(close)

  if (initialPrompt) {
    void (async () => {
      for await (const chunk of initialPrompt) {
        push(`${String(chunk).replace(/\n$/, '')}\n`)
      }
    })()
  }

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          const value = queue.shift()
          if (value !== undefined) {
            return Promise.resolve({ done: false, value })
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined })
          }
          return new Promise(resolve => waiters.push(resolve))
        },
      }
    },
  }
}
