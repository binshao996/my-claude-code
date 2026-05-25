import { randomUUID } from 'node:crypto'
import {
  type SDKControlRequest,
  type SDKControlResponse,
  type SDKStdinMessage,
  type SDKStdoutMessage,
  parseSDKStdinMessage,
  parseSDKStdoutMessage,
} from '@my-claude-code/core'

export type StructuredIOWriter = {
  write(chunk: string): void | Promise<void>
}

type PendingRequest = {
  resolve(value: SDKControlResponse): void
  reject(error: Error): void
  timeout?: ReturnType<typeof setTimeout>
}

export class StructuredIO {
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly prependQueue: SDKStdinMessage[] = []
  private inputClosed = false

  constructor(
    private readonly input: AsyncIterable<string>,
    private readonly output: StructuredIOWriter,
  ) {}

  async *read(): AsyncGenerator<SDKStdinMessage> {
    let buffer = ''

    while (this.prependQueue.length > 0) {
      yield this.prependQueue.shift() as SDKStdinMessage
    }

    for await (const chunk of this.input) {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const message = this.parseLine(line)
        if (!message) {
          continue
        }
        if (message.type === 'control_response') {
          this.resolveControlResponse(message)
          continue
        }
        yield message
      }

      while (this.prependQueue.length > 0) {
        yield this.prependQueue.shift() as SDKStdinMessage
      }
    }

    const tail = this.parseLine(buffer)
    if (tail) {
      if (tail.type === 'control_response') {
        this.resolveControlResponse(tail)
      } else {
        yield tail
      }
    }
    this.inputClosed = true
    this.rejectPending(new Error('structured input closed'))
  }

  prependUserMessage(content: string): void {
    this.prependQueue.push({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      uuid: randomUUID(),
      session_id: '',
      parent_tool_use_id: null,
    })
  }

  async write(message: SDKStdoutMessage): Promise<void> {
    parseSDKStdoutMessage(message)
    await this.output.write(`${JSON.stringify(message)}\n`)
  }

  async sendRequest(
    request: SDKControlRequest['request'],
    options: { requestId?: string; timeoutMs?: number } = {},
  ): Promise<SDKControlResponse> {
    if (this.inputClosed) {
      throw new Error('structured input is closed')
    }

    const request_id = options.requestId ?? randomUUID()
    const controlRequest: SDKControlRequest = {
      type: 'control_request',
      request_id,
      request,
    }
    const response = new Promise<SDKControlResponse>((resolve, reject) => {
      const timeout = options.timeoutMs
        ? setTimeout(() => {
            this.pendingRequests.delete(request_id)
            reject(new Error(`control request timed out: ${request_id}`))
          }, options.timeoutMs)
        : undefined
      this.pendingRequests.set(request_id, { resolve, reject, timeout })
    })
    await this.write(controlRequest)
    return response
  }

  private parseLine(line: string): SDKStdinMessage | undefined {
    const trimmed = line.trim()
    if (!trimmed) {
      return undefined
    }
    return parseSDKStdinMessage(JSON.parse(trimmed))
  }

  private resolveControlResponse(response: SDKControlResponse): void {
    const pending = this.pendingRequests.get(response.request_id)
    if (!pending) {
      return
    }
    this.pendingRequests.delete(response.request_id)
    if (pending.timeout) {
      clearTimeout(pending.timeout)
    }
    if (response.error) {
      pending.reject(new Error(response.error))
      return
    }
    pending.resolve(response)
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.timeout) {
        clearTimeout(pending.timeout)
      }
      pending.reject(error)
      this.pendingRequests.delete(requestId)
    }
  }
}
