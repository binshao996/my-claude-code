export type LspDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  message: string
  line: number
  character: number
  source: 'my-claude-code-lsp'
}

export function collectTextDiagnostics(text: string): LspDiagnostic[] {
  return text.split(/\r?\n/).flatMap<LspDiagnostic>((line, index) => {
    if (line.includes('TODO') || line.includes('FIXME')) {
      return [{
        severity: 'info',
        message: 'tracked code marker',
        line: index + 1,
        character: line.search(/TODO|FIXME/u) + 1,
        source: 'my-claude-code-lsp' as const,
      }]
    }
    if (line.length > 120) {
      return [{
        severity: 'warning',
        message: 'line exceeds 120 characters',
        line: index + 1,
        character: 121,
        source: 'my-claude-code-lsp' as const,
      }]
    }
    return []
  })
}
