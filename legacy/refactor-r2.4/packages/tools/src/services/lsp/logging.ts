export type IdeLogEvent = {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source: 'ide' | 'lsp' | 'magic-docs' | 'prompt-suggestion'
  createdAt: string
}

export function createIdeLogEvent(
  source: IdeLogEvent['source'],
  message: string,
  level: IdeLogEvent['level'] = 'info',
): IdeLogEvent {
  return {
    level,
    message,
    source,
    createdAt: new Date().toISOString(),
  }
}
