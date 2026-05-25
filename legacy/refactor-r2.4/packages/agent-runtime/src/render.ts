import type { QueryEvent } from '@my-claude-code/core'

export function textDeltaFromEvent(event: QueryEvent): string {
  if (
    event.type === 'content_block_delta' &&
    event.delta.type === 'text_delta'
  ) {
    return event.delta.text
  }

  return ''
}

export function collectTextDeltas(events: QueryEvent[]): string {
  return events.map(textDeltaFromEvent).join('')
}
