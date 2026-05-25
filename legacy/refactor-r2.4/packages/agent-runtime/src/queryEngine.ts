import type { TerminalEvent } from '@my-claude-code/core'
import {
  type AgentEvent,
  type QueryOptions,
  query,
  queryLoop,
} from './query.js'

export type QueryEngineRunResult = {
  events: AgentEvent[]
  terminal?: TerminalEvent
}

export class QueryEngine {
  constructor(private readonly defaults: Partial<QueryOptions> = {}) {}

  stream(options: QueryOptions): AsyncGenerator<AgentEvent, void> {
    return query({
      ...this.defaults,
      ...options,
    })
  }

  streamLoop(options: QueryOptions): AsyncGenerator<AgentEvent, void> {
    return queryLoop({
      ...this.defaults,
      ...options,
    })
  }

  async run(options: QueryOptions): Promise<QueryEngineRunResult> {
    const events = await Array.fromAsync(this.stream(options))
    return {
      events,
      terminal: events.findLast(
        (event): event is TerminalEvent => event.type === 'terminal',
      ),
    }
  }
}
