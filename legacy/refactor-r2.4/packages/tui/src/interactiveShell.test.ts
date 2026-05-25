import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'bun:test'
import { runInteractiveShell } from './interactiveShell.js'

describe('interactive shell', () => {
  it('handles /help and /exit without calling the model', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const shell = runInteractiveShell({ input, output })
    input.write('/help\n')
    input.write('/exit\n')
    await shell

    expect(text).toContain('interactive shell')
    expect(text).toContain('Help:')
    expect(text).toContain('/context')
    expect(text).toContain('bye')
  })

  it('routes V0.4 slash commands inside the interactive shell', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const shell = runInteractiveShell({
      input,
      output,
      model: 'deepseek-v4-flash',
      permissionMode: 'acceptEdits',
      sessionId: 'session_tui',
      version: '0.4.0',
    })
    input.write('/status\n')
    input.write('/permissions\n')
    input.write('/exit\n')
    await shell

    expect(text).toContain('"version": "0.4.0"')
    expect(text).toContain('permissionMode: acceptEdits')
    expect(text).toContain('registeredTools:')
    expect(text).not.toContain('\n/status\n')
    expect(text).not.toContain('\n/permissions\n')
  })

  it('keeps the shell open after an unknown slash command', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const shell = runInteractiveShell({ input, output })
    input.write('/missing\n')
    input.write('/exit\n')
    await shell

    expect(text).toContain('error: unknown command: /missing')
    expect(text).toContain('bye')
  })

  it('reuses one shell session id and forwards runtime options to query', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const prompts: string[] = []
    const sessionIds: Array<string | undefined> = []
    const additionalDirectories: Array<string[] | undefined> = []
    const userContexts: Array<string | undefined> = []
    const systemPrompts: Array<string | undefined> = []
    const appendSystemPrompts: Array<string | undefined> = []

    const shell = runInteractiveShell({
      input,
      output,
      sessionId: 'session_tui',
      additionalDirectories: ['../shared'],
      systemPrompt: 'system',
      appendSystemPrompt: 'append',
      userContext: 'resumed context',
      queryRuntime: async function* (options) {
        prompts.push(options.prompt)
        sessionIds.push(options.sessionId)
        additionalDirectories.push(options.additionalDirectories)
        userContexts.push(options.userContext)
        systemPrompts.push(options.systemPrompt)
        appendSystemPrompts.push(options.appendSystemPrompt)
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        }
        yield {
          type: 'terminal',
          status: 'completed',
          exitCode: 0,
        }
      },
    })
    input.write('first prompt\n')
    input.write('second prompt\n')
    input.write('/exit\n')
    await shell

    expect(prompts).toEqual(['first prompt', 'second prompt'])
    expect(sessionIds).toEqual(['session_tui', 'session_tui'])
    expect(additionalDirectories).toEqual([['../shared'], ['../shared']])
    expect(userContexts).toEqual(['resumed context', 'resumed context'])
    expect(systemPrompts).toEqual(['system', 'system'])
    expect(appendSystemPrompts).toEqual(['append', 'append'])
  })
})
